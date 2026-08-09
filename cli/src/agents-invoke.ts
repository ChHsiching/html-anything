import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOnPath, resolveZcodeBin, ZCODE_CJS_SENTINEL, AGENTS, type AgentDef, type AgentProtocol } from "./agents-detect.js";
import { createZcodeProtocolClient } from "@html-anything/zcode-protocol/zcode-protocol";
import { ensureWorkspaceModel, startZcodeProtocolTurn } from "@html-anything/zcode-protocol/zcode-session";

export type InvokeOpts = {
  agent: string;
  prompt: string;
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
  binOverride?: string;
};

type BinResolution =
  | { kind: "ok"; bin: string }
  | { kind: "override-missing"; tried: string }
  | { kind: "not-found" };

function resolveBinForAgent(
  def: (typeof AGENTS)[number],
  binOverride: string | undefined,
): BinResolution {
  const tryPath = (p: string | undefined): string | null => {
    if (!p) return null;
    const trimmed = p.trim();
    if (!trimmed) return null;
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) {
      return existsSync(trimmed) ? trimmed : null;
    }
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.startsWith(".")) {
      const resolved = path.resolve(trimmed);
      return existsSync(resolved) ? resolved : null;
    }
    return resolveOnPath(trimmed);
  };
  if (binOverride && binOverride.trim()) {
    const fromOverride = tryPath(binOverride);
    if (fromOverride) return { kind: "ok", bin: fromOverride };
    return { kind: "override-missing", tried: binOverride.trim() };
  }
  if (def.envOverride) {
    const fromEnv = tryPath(process.env[def.envOverride]);
    if (fromEnv) return { kind: "ok", bin: fromEnv };
  }
  for (const c of [def.bin, ...(def.fallbackBins ?? [])]) {
    const found = resolveOnPath(c);
    if (found) return { kind: "ok", bin: found };
  }
  return { kind: "not-found" };
}

export type InvokeEvent =
  | { type: "start"; bin: string; argv: string[]; promptBytes: number }
  | { type: "delta"; text: string }
  | { type: "html"; text: string }
  | { type: "meta"; key: string; value: unknown }
  | { type: "stderr"; text: string }
  | { type: "raw"; text: string }
  | { type: "done"; code: number | null }
  | { type: "error"; message: string };

// ─── argv builder ────────────────────────────────────────────────────

type AgentArgvOpts = {
  model?: string;
  openclawAgentId?: string;
};

class UnsupportedAgentProtocolError extends Error {
  constructor(public readonly agent: string, public readonly protocol: string) {
    super(
      `${agent} uses the ${protocol} protocol, which is not yet wired up in this build. ` +
        `Pick one of: claude / codex / cursor-agent / gemini / copilot / opencode / qwen / qoder / codewhale / deepseek-tui / aider.`,
    );
  }
}

function buildArgv(agent: string, opts: AgentArgvOpts = {}): string[] {
  const { model } = opts;
  switch (agent) {
    case "claude":
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
        ...(model ? ["--model", model] : []),
      ];
    case "openclaw":
      return [
        "agent",
        "--local",
        "--json",
        "--agent",
        opts.openclawAgentId ?? "main",
        ...(model ? ["--model", model] : []),
      ];
    case "codex":
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...(model ? ["--model", model] : []),
      ];
    case "cursor-agent":
      return [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--trust",
        ...(model ? ["--model", model] : []),
      ];
    case "gemini":
      return [
        "--output-format",
        "stream-json",
        "--yolo",
        ...(model ? ["--model", model] : []),
      ];
    case "copilot":
      return [
        "--allow-all-tools",
        "--output-format",
        "json",
        ...(model ? ["--model", model] : []),
      ];
    case "opencode":
      return [
        "run",
        "--format",
        "json",
        "--dangerously-skip-permissions",
        ...(model ? ["--model", model] : []),
        "-",
      ];
    case "qwen":
      return ["--yolo", ...(model ? ["--model", model] : []), "-"];
    case "aider":
      return [
        "--no-pretty",
        "--no-stream",
        "--yes-always",
        "--message-file",
        "-",
        ...(model ? ["--model", model] : []),
      ];
    case "qoder":
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--yolo",
        ...(model ? ["--model", model] : []),
      ];
    case "codewhale":
    case "deepseek-tui":
      return ["exec", "--auto", ...(model ? ["--model", model] : [])];
    case "hermes":
    case "kimi":
    case "devin":
    case "kiro":
    case "kilo":
    case "vibe":
      throw new UnsupportedAgentProtocolError(agent, "ACP JSON-RPC");
    case "pi":
      throw new UnsupportedAgentProtocolError(agent, "pi-rpc");
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
}

function envFor(agent: string): NodeJS.ProcessEnv {
  const base = { ...process.env };
  if (agent === "gemini") base.GEMINI_CLI_TRUST_WORKSPACE = "true";
  return base;
}

// ─── stdout parser ────────────────────────────────────────────────────

type AgentParse =
  | { kind: "delta"; text: string }
  | { kind: "meta"; key: string; value: unknown }
  | { kind: "html"; text: string }
  | { kind: "noise" };

type ParseState = { sawStreamEventText?: boolean };

function rescueHtmlFromToolUse(
  content: Array<{ type?: string; name?: string; input?: unknown }> | undefined,
): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    const name = (block.name ?? "").toLowerCase();
    if (
      name !== "write" &&
      name !== "create_file" &&
      name !== "createfile" &&
      name !== "writefile" &&
      name !== "write_file" &&
      name !== "filewrite"
    )
      continue;
    const input = block.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") continue;
    const path = String(input.file_path ?? input.path ?? input.filename ?? "").toLowerCase();
    if (path && !/\.(html?|htm)$/.test(path)) continue;
    const text =
      typeof input.content === "string"
        ? input.content
        : typeof input.text === "string"
          ? input.text
          : typeof input.file_content === "string"
            ? input.file_content
            : "";
    if (text) parts.push(text);
  }
  return parts.join("");
}

function parseLineWithState(agent: string, line: string, state: ParseState): AgentParse[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (agent === "aider" || agent === "codewhale" || agent === "deepseek-tui") {
    return [{ kind: "delta", text: trimmed.endsWith("\n") ? trimmed : trimmed + "\n" }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: "noise" }];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const out: AgentParse[] = [];

  if (agent === "claude") {
    if (obj.type === "system" && obj.subtype === "init") {
      out.push({ kind: "meta", key: "model", value: obj.model });
      out.push({ kind: "meta", key: "session", value: obj.session_id });
      if (obj.cwd) out.push({ kind: "meta", key: "cwd", value: obj.cwd });
    }
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
        out.push({ kind: "meta", key: "thinking", value: ev.delta.thinking });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as {
        content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
        usage?: Record<string, number>;
        model?: string;
      };
      const toolHtml = rescueHtmlFromToolUse(msg.content);
      if (toolHtml) {
        out.push({ kind: "html", text: toolHtml });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
      if (msg.usage) out.push({ kind: "meta", key: "usage_partial", value: msg.usage });
    }
    if (obj.type === "result") {
      if (obj.usage) out.push({ kind: "meta", key: "usage", value: obj.usage });
      if (typeof obj.duration_ms === "number") out.push({ kind: "meta", key: "duration_ms", value: obj.duration_ms });
      if (typeof obj.total_cost_usd === "number") out.push({ kind: "meta", key: "cost_usd", value: obj.total_cost_usd });
      if (typeof obj.subtype === "string") out.push({ kind: "meta", key: "result", value: obj.subtype });
    }
  }

  if (agent === "codex") {
    if (obj.type === "item.completed" && obj.item && typeof obj.item === "object") {
      const item = obj.item as { item_type?: string; type?: string; text?: string };
      const itemType = item.item_type ?? item.type;
      if (
        (itemType === "assistant_message" || itemType === "agent_message") &&
        typeof item.text === "string"
      ) {
        out.push({ kind: "delta", text: item.text });
      }
    }
    if (obj.type === "item.delta" && typeof obj.text === "string") {
      out.push({ kind: "delta", text: obj.text });
    }
    if (obj.msg && typeof obj.msg === "object") {
      const msg = obj.msg as { type?: string; message?: string };
      if (msg.type === "agent_message" && typeof msg.message === "string") {
        out.push({ kind: "delta", text: msg.message });
      }
    }
    if (obj.type === "task_complete" && obj.usage) {
      out.push({ kind: "meta", key: "usage", value: obj.usage });
    }
    if (obj.type === "turn.completed" && obj.usage) {
      out.push({ kind: "meta", key: "usage", value: obj.usage });
    }
  }

  if (agent === "cursor-agent" || agent === "gemini") {
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      const toolHtml = rescueHtmlFromToolUse(msg.content);
      if (toolHtml) {
        out.push({ kind: "html", text: toolHtml });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
    }
    if (typeof obj.text === "string" && !state.sawStreamEventText && obj.type !== "assistant") {
      out.push({ kind: "delta", text: obj.text as string });
    }
  }

  if (agent === "copilot") {
    if (typeof obj.response === "string") out.push({ kind: "delta", text: obj.response });
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
  }

  if (agent === "opencode" || agent === "qwen") {
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
    if (typeof obj.content === "string") out.push({ kind: "delta", text: obj.content });
    if (typeof obj.message === "string") out.push({ kind: "delta", text: obj.message });
  }

  if (agent === "qoder") {
    if (obj.type === "system" && obj.subtype === "init") {
      if (obj.model) out.push({ kind: "meta", key: "model", value: obj.model });
      if (obj.session_id) out.push({ kind: "meta", key: "session", value: obj.session_id });
    }
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      const toolHtml = rescueHtmlFromToolUse(msg.content);
      if (toolHtml) {
        out.push({ kind: "html", text: toolHtml });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
    }
    if (obj.type === "result") {
      if (obj.usage) out.push({ kind: "meta", key: "usage", value: obj.usage });
      if (typeof obj.duration_ms === "number") out.push({ kind: "meta", key: "duration_ms", value: obj.duration_ms });
    }
    if (typeof obj.text === "string" && !state.sawStreamEventText && obj.type !== "assistant") {
      out.push({ kind: "delta", text: obj.text });
    }
  }

  return out;
}

function makeParser(agent: string): (line: string) => AgentParse[] {
  const state: ParseState = {};
  return (line: string) => parseLineWithState(agent, line, state);
}

// ─── resolve OpenClaw agent id ────────────────────────────────────────

let openclawAgentIdCache: { value: string; expiresAt: number } | null = null;

async function resolveOpenclawAgentId(bin: string): Promise<string> {
  const now = Date.now();
  if (openclawAgentIdCache && openclawAgentIdCache.expiresAt > now) {
    return openclawAgentIdCache.value;
  }
  let resolved = "main";
  try {
    const { spawn: spawnAsync } = await import("node:child_process");
    const out = await new Promise<string>((res, rej) => {
      const child = spawnAsync(bin, ["agents", "list"], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (buf += c));
      child.on("close", () => res(buf));
      child.on("error", rej);
      setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        rej(new Error("openclaw agents list timed out"));
      }, 5_000);
    });
    const m = out.match(/^- (\S+)/m);
    if (m && m[1]) resolved = m[1];
  } catch {}
  openclawAgentIdCache = { value: resolved, expiresAt: now + 5 * 60_000 };
  return resolved;
}

// ─── main invoke function ─────────────────────────────────────────────

export function invokeAgent(opts: InvokeOpts): ReadableStream<InvokeEvent> {
  const def = AGENTS.find((a) => a.id === opts.agent);
  if (!def) {
    return errorStream(`unknown agent: ${opts.agent}`);
  }
  const resolved = resolveBinForAgent(def, opts.binOverride);
  if (resolved.kind === "override-missing") {
    return errorStream(
      `${def.label}: custom path \`${resolved.tried}\` does not exist.`,
    );
  }
  if (resolved.kind === "not-found") {
    return errorStream(
      `${def.label} (\`${def.bin}\`) is not installed or not on PATH.`,
    );
  }
  const bin: string = resolved.bin;

  const env = envFor(opts.agent);

  if (def.protocol === "app-server") {
    return invokeAppServerAgent({ def, bin, opts });
  }

  const promptViaArgv = def.protocol === "argv";
  const promptViaMessageFlag = def.protocol === "argv-message";

  return new ReadableStream<InvokeEvent>({
    async start(controller) {
      let closed = false;
      let child: ChildProcessWithoutNullStreams | null = null;

      const safeEnqueue = (ev: InvokeEvent) => {
        if (closed) return;
        try {
          controller.enqueue(ev);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };

      let argv: string[];
      try {
        const argvOpts: AgentArgvOpts = {
          model: opts.model,
        };
        if (opts.agent === "openclaw") {
          argvOpts.openclawAgentId = await resolveOpenclawAgentId(bin);
        }
        argv = buildArgv(opts.agent, argvOpts);
      } catch (err) {
        safeEnqueue({
          type: "error",
          message:
            err instanceof UnsupportedAgentProtocolError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err),
        });
        safeClose();
        return;
      }
      if (promptViaArgv) argv = [...argv, opts.prompt];
      if (promptViaMessageFlag) argv = [...argv, "--message", opts.prompt];

      // node-script CLIs (ZCode's zcode.cjs) run as `node <cjs> app-server`;
      // binArgs carries the leading argv the bin needs. Absent for every
      // existing adapter, so their spawn is unchanged. See ADR-0002 decision 3.
      const fullArgv = def.binArgs?.length ? [...def.binArgs, ...argv] : argv;

      try {
        child = spawn(bin, fullArgv, {
          cwd: opts.cwd ?? process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        });
      } catch (err) {
        safeEnqueue({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        safeClose();
        return;
      }

      safeEnqueue({
        type: "start",
        bin,
        argv: fullArgv,
        promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
      });

      child.stdin.on("error", () => {});
      try {
        if (!promptViaArgv && !promptViaMessageFlag) child.stdin.write(opts.prompt);
        child.stdin.end();
      } catch {}

      const parse = makeParser(opts.agent);

      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (closed) return;
        stdoutBuf += chunk;
        if (opts.agent === "openclaw") return;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          for (const part of parse(line)) {
            if (part.kind === "delta") safeEnqueue({ type: "delta", text: part.text });
            else if (part.kind === "html") safeEnqueue({ type: "html", text: part.text });
            else if (part.kind === "meta") safeEnqueue({ type: "meta", key: part.key, value: part.value });
            else safeEnqueue({ type: "raw", text: line.slice(0, 240) });
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        safeEnqueue({ type: "stderr", text: chunk });
      });

      child.on("error", (err) => {
        safeEnqueue({ type: "error", message: err.message });
        safeClose();
      });

      child.on("close", (code) => {
        if (opts.agent === "openclaw") {
          if (stdoutBuf.trim()) {
            try {
              const obj = JSON.parse(stdoutBuf) as {
                payloads?: Array<{ text?: string }>;
                meta?: {
                  finalAssistantVisibleText?: string;
                  finalAssistantRawText?: string;
                  executionTrace?: { winnerProvider?: string; winnerModel?: string };
                  completion?: { stopReason?: string };
                  agentMeta?: { sessionId?: string };
                };
              };
              const text = obj?.meta?.finalAssistantVisibleText
                ?? obj?.meta?.finalAssistantRawText
                ?? obj?.payloads?.[0]?.text
                ?? "";
              if (text) safeEnqueue({ type: "delta", text });
            } catch (err) {
              safeEnqueue({
                type: "error",
                message: `OpenClaw JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
        } else if (stdoutBuf) {
          if (opts.agent === "aider" || opts.agent === "codewhale" || opts.agent === "deepseek-tui") {
            safeEnqueue({ type: "delta", text: stdoutBuf });
          } else {
            for (const part of parse(stdoutBuf)) {
              if (part.kind === "delta") safeEnqueue({ type: "delta", text: part.text });
              else if (part.kind === "html") safeEnqueue({ type: "html", text: part.text });
              else if (part.kind === "meta") safeEnqueue({ type: "meta", key: part.key, value: part.value });
            }
          }
        }
        safeEnqueue({ type: "done", code });
        safeClose();
      });

      const onAbort = () => {
        try {
          child?.kill("SIGTERM");
        } catch {}
        safeClose();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {},
  });
}

// ─── app-server protocol branch (ZCode) ───────────────────────────────
//
// Drives a single JSON-RPC turn over a spawned `zcode app-server` child and
// bridges the protocol layer's events into the shared `InvokeEvent` stream.
// Distinct from the "acp" branch above: ZCode's app-server wire format
// (workspace/* + session/*) is not the ACP JSON-RPC the hermes/kimi family
// speaks — do not assume a shared parser (ADR-0002 decision 2).
//
// The protocol client wraps the child but never kills it; owning the process
// lifecycle (spawn + kill) is this layer's job (ADR-0001 "Protocol client vs
// child process").

type AppServerInvokeArgs = {
  def: AgentDef;
  bin: string;
  opts: InvokeOpts;
};

function invokeAppServerAgent({ def, bin, opts }: AppServerInvokeArgs): ReadableStream<InvokeEvent> {
  // ADR-0004 + #14 (live-probe-corrected): the app-server child self-authentic
  // ates the LOGIN from the user's logged-in state (a bare session/list returns
  // the real sessions with no credential handling). BUT a fresh session/create
  // needs the workspace model configured first, or it fails with
  // "Model config is missing". The adapter therefore runs the once-per-boot
  // model relay (ensureWorkspaceModel — upsert+setDefault, reading ZCode's own
  // ~/.zcode/v2/config.json) before the turn. This is model SELECTION relay
  // (left-pocket → right-pocket), not credential grafting: the key never
  // leaves ZCode's ecosystem. #13 deleted this relay on the unverified
  // assumption the child self-resolves the model too; #14 live probes
  // disproved that and restored it.

  // binArgs carries the leading argv a node-script CLI needs (e.g.
  // [ZCODE_CJS_SENTINEL, "app-server"]). The prompt is NOT piped to stdin — it
  // travels inside the JSON-RPC session/send request. The sentinel on the
  // AgentDef is filled here from resolveZcodeBin() so the spawn runs
  // `node <real-cjs-path> app-server` (T7 — makes ZCode invocable end to end
  // through the T5 invoke branch).
  const argv = (def.binArgs ?? []).map((arg) =>
    arg === ZCODE_CJS_SENTINEL ? (resolveZcodeBin() ?? arg) : arg,
  );

  // Lifted above the ReadableStream so `cancel` (a sibling callback) can tear
  // the turn + child down without waiting on `start`.
  let child: ChildProcessWithoutNullStreams | null = null;
  let turnUnsubscribe: (() => void) | null = null;
  let client: ReturnType<typeof createZcodeProtocolClient> | null = null;

  return new ReadableStream<InvokeEvent>({
    async start(controller) {
      let closed = false;

      const safeEnqueue = (ev: InvokeEvent) => {
        if (closed) return;
        try {
          controller.enqueue(ev);
        } catch {
          closed = true;
        }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      const killChild = () => {
        try {
          child?.kill("SIGTERM");
        } catch {}
      };
      const teardown = () => {
        try {
          turnUnsubscribe?.();
        } catch {}
        turnUnsubscribe = null;
        try {
          client?.dispose();
        } catch {}
        client = null;
        killChild();
        safeClose();
      };

      // ZCode's zcode.cjs is an Electron-hosted bundle; without
      // ELECTRON_RUN_AS_NODE=1 it initializes Electron components and hangs at
      // boot, answering no JSON-RPC frame. This is ZCode's own standard way to
      // run a Node child outside a BrowserWindow (zcode.cjs itself spawns its
      // children with this env at four call sites). The var is merged INTO the
      // envFor(...) env so the rest of the process env (PATH, ZCODE_*, …)
      // survives — not a replacement. Scoped to the app-server branch: other
      // agents must not inherit it. (ADR-0004 / T9.)
      const env = { ...envFor(opts.agent), ELECTRON_RUN_AS_NODE: "1" };

      try {
        child = spawn(bin, argv, {
          cwd: opts.cwd ?? process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        });
      } catch (err) {
        safeEnqueue({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        safeClose();
        return;
      }

      safeEnqueue({
        type: "start",
        bin,
        argv,
        promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
      });

      client = createZcodeProtocolClient(child);

      // Bridge the protocol stream's mapped events into InvokeEvent. Each kind
      // the consumer cares about becomes one of the shared event types; turn
      // end (status:completed) signals {type:"done"}; an `error` event or the
      // turn driver rejecting signals {type:"error"}.
      let turnEnded = false;
      const finish = (code: number | null) => {
        if (turnEnded) return;
        turnEnded = true;
        safeEnqueue({ type: "done", code });
        teardown();
      };

      const onEvent = (event: Record<string, unknown>) => {
        if (closed || turnEnded) return;
        const type = typeof event.type === "string" ? event.type : "";
        if (type === "text_delta") {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) safeEnqueue({ type: "delta", text: delta });
          return;
        }
        if (type === "tool_use") {
          // A file-write tool call may carry the generated HTML; reuse the
          // same rescue logic the other adapters apply to Claude-style
          // tool_use blocks.
          const name = typeof event.name === "string" ? event.name : "";
          const input = (event.input ?? null) as unknown;
          const html = rescueHtmlFromToolUse([{ type: "tool_use", name, input }]);
          if (html) safeEnqueue({ type: "html", text: html });
          return;
        }
        if (type === "usage") {
          // final-result: turn end. `usage` (and optional `durationMs`) arrive
          // here as the cumulative end-of-turn summary.
          safeEnqueue({ type: "meta", key: "usage", value: event.usage ?? null });
          if (event.durationMs != null) {
            safeEnqueue({ type: "meta", key: "duration_ms", value: event.durationMs });
          }
          finish(0);
          return;
        }
        if (type === "status") {
          const label = typeof event.label === "string" ? event.label : "";
          if (label === "completed") {
            finish(0);
          } else if (label === "failed") {
            safeEnqueue({
              type: "error",
              message: "zcode turn failed (status: failed)",
            });
            finish(1);
          }
          return;
        }
        if (type === "error") {
          const message =
            typeof event.message === "string" && event.message.length > 0
              ? event.message
              : "zcode turn failed";
          safeEnqueue({ type: "error", message });
          finish(1);
          return;
        }
        // thinking_*, conversation_title, tool_result, etc. are not part of the
        // InvokeEvent surface today; intentionally dropped.
      };

      // The child dying before the turn resolves is an error (the protocol
      // client already rejects the pending request, but this surfaces a clean
      // InvokeEvent and runs teardown).
      child.on("close", (code) => {
        if (!turnEnded) {
          safeEnqueue({
            type: "error",
            message: `zcode app-server exited before turn completed (code ${code}).`,
          });
        }
        finish(code);
      });
      child.on("error", (err) => {
        safeEnqueue({ type: "error", message: err.message });
        finish(1);
      });

      try {
        // #14: once-per-boot model relay. Required for a fresh session/create
        // (the child self-auths the login but not the model selection). Runs
        // exactly once per spawned child; the turn driver then creates the
        // session against the now-configured workspace.
        await ensureWorkspaceModel({
          client,
          cwd: opts.cwd ?? process.cwd(),
          signal: opts.signal,
        });
        const turn = await startZcodeProtocolTurn({
          client,
          cwd: opts.cwd ?? process.cwd(),
          prompt: opts.prompt,
          onEvent,
          signal: opts.signal,
        });
        turnUnsubscribe = turn.unsubscribe;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        safeEnqueue({ type: "error", message });
        finish(1);
      }

      const onAbort = () => {
        if (!turnEnded) {
          safeEnqueue({ type: "error", message: "aborted" });
        }
        finish(null);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      // Stream consumer cancelled: detach the turn listener, dispose the
      // client, and kill the child. We do NOT enqueue here — the
      // ReadableStream guarantees no further enqueue after cancel.
      try {
        turnUnsubscribe?.();
      } catch {}
      turnUnsubscribe = null;
      try {
        client?.dispose();
      } catch {}
      client = null;
      try {
        child?.kill("SIGTERM");
      } catch {}
    },
  });
}

function errorStream(message: string): ReadableStream<InvokeEvent> {
  return new ReadableStream<InvokeEvent>({
    start(controller) {
      controller.enqueue({ type: "error", message });
      controller.close();
    },
  });
}