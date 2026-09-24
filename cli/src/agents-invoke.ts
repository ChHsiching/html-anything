import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOnPath, resolveZcodeBin, resolveZcodeNodeBin, ZCODE_CJS_SENTINEL, AGENTS } from "./agents-detect.js";
import {
  prepareZcodeModelBinding,
  zcodeBindingEnv,
  zcodeProviderEnvPairSet,
} from "@html-anything/zcode-protocol/zcode-model-binding";

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

/**
 * #37 silence watchdog (zcode only): a healthy stream-json turn produces
 * parsed events continuously (deltas, thinking fragments, tool status), so
 * 180s with ZERO parsed events means the model or CLI hung and the turn
 * would hang forever with no teardown. Any stdout line that parses to at
 * least one event resets the clock; when it fires the turn errors out, the
 * child is killed, and the stream closes. Sibling agents keep their
 * historical behavior.
 */
const ZCODE_SILENCE_TIMEOUT_MS = 180_000;

/**
 * Cap on the stderr tail kept for the non-zero-exit error message (#37).
 * The FULL stderr keeps streaming to the log as `stderr` events; this buffer
 * only feeds the one-line exit error with its most recent essence.
 */
const STDERR_TAIL_CAP = 2_000;
/** How much of that tail the exit-error message actually quotes. */
const STDERR_HINT_MAX = 500;

// ─── argv builder ────────────────────────────────────────────────────

type AgentArgvOpts = {
  model?: string;
  openclawAgentId?: string;
};

/**
 * Quote a single argv element for cmd.exe when `spawn(..., { shell: true })` is
 * used on Windows. cmd.exe splits the argv array on whitespace, so an element
 * containing a space — notably ZCode's resolved `C:\Program
 * Files\ZCode\ZCode.exe` (the T12 Electron-exe fallback) and the resolved
 * `C:\Program Files\ZCode\resources\glm\zcode.cjs` — must be double-quoted.
 * Already-quoted elements are left alone; empty elements become `""`. Mirrors
 * next/src/lib/agents/invoke.ts's helper.
 */
function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && arg.startsWith('"') && arg.endsWith('"')) return arg;
  return `"${arg}"`;
}

/**
 * The fixed short guide ZCode's `-p` flag carries. The attachment holds the
 * real task, so this only points the model at it and pins the deliverable
 * shape (final HTML as the reply body — ZCode is agentic and would otherwise
 * reach for file-write tools). Keep it short: `-p` takes an argv value.
 */
const ZCODE_PROMPT_GUIDE =
  "附件是完整的任务说明。请严格按其中的要求执行，并将最终结果（完整 HTML）直接作为你的回复正文输出。";

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
    case "zcode":
      // Headless one-shot. `-p` carries ONLY this fixed short guide — the
      // full prompt (shared directives + template + user content, 20-30KB+)
      // travels in the `--attach` temp file invokeAgent writes; argv length
      // limits would truncate it. `--mode yolo` is `-p`'s default anyway;
      // passing it is self-documentation. There is no `--model` flag: the
      // model default comes from ZCode's own provider config (opts.model is
      // deliberately ignored).
      return [
        "-p",
        ZCODE_PROMPT_GUIDE,
        "--output-format",
        "stream-json",
        "--mode",
        "yolo",
      ];
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
  // ZCode's zcode.cjs is an Electron-hosted bundle; without
  // ELECTRON_RUN_AS_NODE=1 it boots the full Electron app instead of the CLI
  // and the prompt is never executed (live-proven). Merged INTO the env (not
  // a replacement) so PATH, ZCODE_*, and the provider-config escape-hatch
  // vars survive. Scoped to zcode — other agents must not inherit it.
  if (agent === "zcode") base.ELECTRON_RUN_AS_NODE = "1";
  return base;
}

// ─── stdout parser ────────────────────────────────────────────────────

type AgentParse =
  | { kind: "delta"; text: string }
  | { kind: "meta"; key: string; value: unknown }
  | { kind: "html"; text: string }
  /**
   * Turn-level failure surfaced by the stream itself (e.g. ZCode's
   * `turn.failed` event). Carries the human-readable message only; the invoke
   * layer forwards it as `{type:"error"}` so the consumer-side failure gate
   * (red error state) can fire on it.
   */
  | { kind: "error"; message: string }
  | { kind: "noise" };

type ParseState = {
  sawStreamEventText?: boolean;
  /**
   * ZCode: toolCallId → toolName, filled when the `model.streaming`
   * tool_call event names the tool. `tool.updated` result events carry only a
   * toolCallId, so the "工具 X 完成" status line resolves the name through
   * this map — a result whose id maps to nothing emits no line at all
   * (a nameless status line is noise).
   */
  zcodeToolNamesById?: Map<string, string>;
};

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

/**
 * ZCode CLI one-shot (`-p --output-format stream-json`) stdout, one NDJSON
 * event envelope per line:
 *
 *   {"eventId":…,"payload":{…},"seq":…,"sessionId":…,"timestamp":…,"type":"model.streaming"}
 *
 * Event surface (types observed live + pinned in the ZCode open-source
 * contracts, apps/zcode-cli/packages/contracts/src/events/session.events.ts):
 *
 *  - `model.streaming` — the model's own stream, dispatched on `payload.kind`:
 *      text_delta → streamed text (delta channel)
 *      reasoning_delta → thinking meta, forwarded fragment by fragment under
 *        the same `thinking` key the Claude path emits
 *      tool_call → the fully-assembled tool invocation ({toolCallId,
 *        toolName, input}). A file-write tool's input may hold the generated
 *        HTML — run the shared rescue; otherwise surface a natural-language
 *        status line so the stream keeps flowing during the tool window.
 *        Records toolCallId→toolName for the result event, which is nameless.
 *      (start/text_start/text_end/reasoning_start/reasoning_end/
 *       tool_input_start/tool_input_delta/tool_input_end/finish → no output)
 *  - `tool.updated` — tool execution lifecycle, dispatched on an injected
 *      `payload.kind` (scheduled/started/progress/result/error/batch). Only
 *      `result` matters here: emit "工具 X 完成" with the name resolved via
 *      the tool_call map. A nameless result emits nothing — a bare ✓ with no
 *      context is worse than no line at all.
 *  - `turn.completed` — end of turn: usage (remapped to the snake_case keys
 *      the consumer reads), duration, and resultType ("success",
 *      "cancelled", …). This is the ONLY place usage is emitted.
 *  - `turn.failed` — turn-level failure (payload.error.message) → error part.
 *  - `result` — the bare terminator line (top-level fields, no payload
 *      envelope). Carries the sessionId (→ session meta). Its usage is the
 *      SAME cumulative numbers turn.completed already reported — never emit
 *      it again.
 *  - everything else — session.titleUpdated / session.resumed /
 *      session.updated (20+ plugin hook descriptors per turn), turn.started,
 *      message.upserted, the permission / checkpoint families, … — noise,
 *      dropped. So are non-JSON lines: ZCode plugins can print arbitrary
 *      stdout.
 */
function parseZcodeLine(line: string, state: ParseState): AgentParse[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const payload = obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : null;

  if (obj.type === "model.streaming" && payload) {
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    if (kind === "text_delta" || kind === "reasoning_delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (delta.length === 0) return [];
      return [
        kind === "text_delta"
          ? { kind: "delta", text: delta }
          : { kind: "meta", key: "thinking", value: delta },
      ];
    }
    if (kind === "tool_call") {
      const id = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      const name = typeof payload.toolName === "string" ? payload.toolName : "";
      if (id && name) {
        (state.zcodeToolNamesById ??= new Map()).set(id, name);
      }
      // A file-write tool call may carry the generated HTML; reuse the same
      // rescue logic the other adapters apply to Claude-style tool_use
      // blocks (ZCode's Write tool is {file_path, content} — same shape).
      const html = rescueHtmlFromToolUse([{ type: "tool_use", name, input: payload.input }]);
      if (html) return [{ kind: "html", text: html }];
      if (name) return [{ kind: "meta", key: "status", value: `调用工具 ${name}` }];
    }
    return [];
  }

  if (obj.type === "tool.updated" && payload) {
    if (payload.kind === "result") {
      const id = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      const name = (id && state.zcodeToolNamesById?.get(id)) || "";
      if (name) return [{ kind: "meta", key: "status", value: `工具 ${name} 完成` }];
    }
    return [];
  }

  if (obj.type === "turn.completed" && payload) {
    const out: AgentParse[] = [];
    const usage = mapZcodeUsage(payload.usage);
    if (usage) out.push({ kind: "meta", key: "usage", value: usage });
    if (typeof payload.duration === "number") {
      out.push({ kind: "meta", key: "duration_ms", value: payload.duration });
    }
    if (typeof payload.resultType === "string") {
      out.push({ kind: "meta", key: "result", value: payload.resultType });
    }
    return out;
  }

  if (obj.type === "turn.failed") {
    const err = payload && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : null;
    const message =
      err && typeof err.message === "string" && err.message.length > 0 ? err.message : "zcode turn failed";
    return [{ kind: "error", message }];
  }

  if (obj.type === "result") {
    if (typeof obj.sessionId === "string" && obj.sessionId.length > 0) {
      return [{ kind: "meta", key: "session", value: obj.sessionId }];
    }
    return [];
  }

  return [];
}

/** ZCode usage (camelCase) → the snake_case keys the consumer layer reads
 * (same key set Claude's `result.usage` carries: input_tokens /
 * output_tokens / cache_read_input_tokens / cache_creation_input_tokens). */
function mapZcodeUsage(usage: unknown): Record<string, number> | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const out: Record<string, number> = {};
  if (typeof u.inputTokens === "number") out.input_tokens = u.inputTokens;
  if (typeof u.outputTokens === "number") out.output_tokens = u.outputTokens;
  if (typeof u.cacheReadTokens === "number") out.cache_read_input_tokens = u.cacheReadTokens;
  if (typeof u.cacheWriteTokens === "number") out.cache_creation_input_tokens = u.cacheWriteTokens;
  return Object.keys(out).length > 0 ? out : null;
}

function parseLineWithState(agent: string, line: string, state: ParseState): AgentParse[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (agent === "aider" || agent === "codewhale" || agent === "deepseek-tui") {
    return [{ kind: "delta", text: trimmed.endsWith("\n") ? trimmed : trimmed + "\n" }];
  }

  // ZCode (argv-attach) — NDJSON event envelope, one JSON object per line:
  //   {"type":"model.streaming","payload":{"kind":"text_delta","delta":"…"},…}
  // plus a bare {"type":"result",…} terminator line. See parseZcodeLine for
  // the full event surface. Handled before the shared JSON.parse so a
  // non-JSON line returns [] here instead of a `noise` part (the invoke
  // layer forwards noise as `raw`, which would flood the log panel).
  if (agent === "zcode") {
    return parseZcodeLine(trimmed, state);
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

  // T12 (#12), re-keyed to the CLI one-shot form: argv-attach agents (ZCode)
  // spawn `node <zcode.cjs> -p …`, and html-anything is an EXTERNAL process —
  // on a clean Windows host `where node` finds nothing. The generic
  // resolveBinForAgent() path treats `def.bin = "node"` as a PATH lookup and
  // treats ZCODE_BIN (def.envOverride) as the bin override, but ZCODE_BIN is
  // the .cjs override, NOT a node bin. So argv-attach agents get their OWN bin
  // resolution: binOverride (explicit node path) wins; otherwise
  // resolveZcodeNodeBin() discovers node-or-Electron-exe (see its doc comment
  // for the live-proven strategy). Execution then continues down the GENERIC
  // trunk below — ZCode has no dedicated protocol branch anymore.
  //
  // T15 (#18 / ADR-0005 decision 3): resolveZcodeNodeBin() returns `string`
  // (not `string | null`) — the Electron-exe fallback is terminal and
  // guaranteed-present whenever detect passed (zcode.cjs found ⟺ ZCode
  // installed ⟺ exe exists). Only the binOverride-missing error remains (a
  // user-supplied path that does not resolve is a real, reachable typo the
  // user deserves to see).
  let bin: string;
  if (def.protocol === "argv-attach") {
    if (opts.binOverride && opts.binOverride.trim()) {
      const tried = opts.binOverride.trim();
      if (/^([a-zA-Z]:[\\/]|[\\/])/.test(tried)) {
        bin = existsSync(tried) ? tried : "";
      } else if (tried.includes("/") || tried.includes("\\") || tried.startsWith(".")) {
        const abs = path.resolve(tried);
        bin = existsSync(abs) ? abs : "";
      } else {
        bin = resolveOnPath(tried) ?? "";
      }
      if (!bin) {
        return errorStream(
          `${def.label}: custom node path \`${tried}\` does not exist. Set it to a node binary (or ZCode's ZCode.exe), or clear it to auto-discover.`,
        );
      }
    } else {
      bin = resolveZcodeNodeBin();
    }
  } else {
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
    bin = resolved.bin;
  }

  const env = envFor(opts.agent);

  const promptViaArgv = def.protocol === "argv";
  const promptViaMessageFlag = def.protocol === "argv-message";
  const promptViaAttach = def.protocol === "argv-attach";

  // Lifted above the ReadableStream so `cancel` — a sibling callback of
  // `start` that cannot reach its locals — can tear the argv-attach turn's
  // resources down without waiting on `start`:
  //   - mountChild: on Linux the AppImage mount child stays alive holding the
  //     FUSE mount for the duration of the turn (null on Windows/macOS).
  //   - attachTmpDir: the mkdtemp dir holding zcode's prompt.md attachment.
  let mountChild: ChildProcessWithoutNullStreams | null = null;
  let attachTmpDir: string | null = null;
  // #37: the zcode silence-watchdog handle, lifted for the same reason as
  // cleanupArgvAttach — `cancel`, a sibling of `start`, must be able to clear
  // it without waiting for `start` to run.
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };
  const cleanupArgvAttach = () => {
    // ADR-0007: the mount child holds the FUSE mount alive; kill it so the
    // mount unmounts at teardown (per-turn mount+unmount). No-op off-Linux.
    try {
      mountChild?.kill("SIGTERM");
    } catch {}
    if (attachTmpDir) {
      try {
        rmSync(attachTmpDir, { recursive: true, force: true });
      } catch {}
      attachTmpDir = null;
    }
  };

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

      // argv-attach (ZCode): resolve the .cjs argv[1] BEFORE the final argv is
      // assembled — on Linux that path is only known after the AppImage
      // self-mounts (ADR-0007 decision 2). Reuses resolveZcodeBin() and the
      // mount helper unchanged; a ZCODE_BIN pointing at a `.cjs` is used
      // directly with no mount (ADR-0010 decision 1).
      let cjsPath: string | undefined;
      if (promptViaAttach) {
        if (process.platform === "linux") {
          const resolvedZcode = resolveZcodeBin();
          if (!resolvedZcode) {
            safeEnqueue({
              type: "error",
              message:
                "ZCode AppImage not found. Open the ZCode GUI once (to write its .desktop entry) or set ZCODE_BIN to the AppImage (or the zcode.cjs bundle).",
            });
            safeClose();
            return;
          }
          if (resolvedZcode.endsWith(".cjs")) {
            cjsPath = resolvedZcode;
          } else {
            try {
              const mounted = await mountZcodeAppImage(resolvedZcode, {
                cwd: opts.cwd,
                signal: opts.signal,
              });
              mountChild = mounted.mountChild;
              cjsPath = path.posix.join(
                mounted.mountPoint,
                "resources",
                "glm",
                "zcode.cjs",
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              cleanupArgvAttach();
              safeEnqueue({ type: "error", message });
              safeClose();
              return;
            }
          }
        } else {
          cjsPath = resolveZcodeBin() ?? ZCODE_CJS_SENTINEL;
        }
      }

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
      // `protocol: "argv-attach"` (zcode): the full prompt (shared directives
      // + template + user content, 20-30KB+) is far past command-line length
      // limits, so it travels as a temp-file attachment — the `.md` enters the
      // model context whole (live-proven). `-p` (buildArgv) already carries
      // the fixed short guide. The mkdtemp dir is removed on every exit path
      // via cleanupArgvAttach (close / error / abort / cancel) — it also holds
      // the per-turn provider-config clone below, so the binding is cleaned up
      // with the prompt.
      let boundModelMeta: string | null = null;
      if (promptViaAttach) {
        try {
          attachTmpDir = mkdtempSync(path.join(tmpdir(), "html-anything-zcode-"));
          writeFileSync(path.join(attachTmpDir, "prompt.md"), opts.prompt, "utf8");
        } catch (err) {
          safeEnqueue({
            type: "error",
            message: `failed to write the ZCode prompt attachment: ${err instanceof Error ? err.message : String(err)}`,
          });
          cleanupArgvAttach();
          safeClose();
          return;
        }
        argv = [...argv, "--attach", path.join(attachTmpDir, "prompt.md")];

        // #41 — deterministic per-turn model binding. ZCode's CLI has no
        // --model flag and SILENTLY falls back to the first visible registry
        // provider (+ max reasoning) when a config default is absent/invalid,
        // which can route the turn to a provider the user never chose. Every
        // turn therefore writes its model selection into a TEMP CLONE of the
        // user's provider config (real file never touched) and hands the
        // child the PAIRED ZCODE_*_PROVIDER_CONFIG_FILE vars (hard-required
        // by the CLI; "读哪份传哪份" — the builtin var points at the very
        // catalog file the selection was validated against). The prepare call
        // also ensures the ONE identity credential the headless registry
        // needs exists in the real store (atomic add-only append; see
        // zcode-model-binding.ts — live-proven 2026-09-24). A user
        // who pre-set the pair keeps it untouched (zero-code reroute); any
        // broken link in the resolution chain refuses the spawn with an
        // actionable error — never a silent reroute. See
        // zcode-model-binding.ts for the live-proven mechanism.
        if (!zcodeProviderEnvPairSet(process.env)) {
          const binding = prepareZcodeModelBinding({
            cjsPath: cjsPath!,
            model: opts.model,
            attachDir: attachTmpDir,
          });
          if (!binding.ok) {
            safeEnqueue({ type: "error", message: binding.message });
            cleanupArgvAttach();
            safeClose();
            return;
          }
          Object.assign(env, zcodeBindingEnv(binding));
          boundModelMeta = `${binding.selection.modelId}/${binding.selection.reasoningLevel}`;
        }
      }

      // node-script CLIs (ZCode's zcode.cjs) run as `node <cjs> -p …`;
      // binArgs carries the leading argv the bin needs, with the
      // `<resolved-zcode-cjs>` sentinel filled from the path resolved above
      // (the mounted path on Linux). Absent for every existing adapter, so
      // their spawn is unchanged. See ADR-0002 decision 3.
      const leadingArgv = (def.binArgs ?? []).map((arg) =>
        arg === ZCODE_CJS_SENTINEL && cjsPath ? cjsPath : arg,
      );
      const fullArgv = leadingArgv.length ? [...leadingArgv, ...argv] : argv;

      try {
        // On Windows, `spawn` cannot launch a `.cmd` / `.bat` shim without
        // going through the shell. EXCEPTION — an ABSOLUTE `.exe` (ZCode's
        // `ZCode.exe` node driver, or a real node.exe) spawns DIRECTLY: no
        // cmd.exe round-trip, so spaced install paths
        // (`C:\Program Files\ZCode\ZCode.exe`) work untouched and every argv
        // element passes verbatim — no quoting games. The shell path keeps
        // this side's verbatim baseline for every other agent; zcode's
        // `.cmd`-shim corner quotes the bin and each argv element (the spaced
        // zcode.cjs path must survive cmd.exe's whitespace split). (The next
        // mirror quotes the bin for ALL shell-path agents — its own
        // long-standing baseline; the two files are adapted copies, not
        // verbatim mirrors.)
        const binIsAbsoluteExe =
          process.platform === "win32" &&
          /^([a-zA-Z]:[\\/]|[\\/])/.test(bin) &&
          /\.exe$/i.test(bin);
        const useShell = process.platform === "win32" && !binIsAbsoluteExe;
        child = spawn(
          useShell && promptViaAttach ? `"${bin}"` : bin,
          useShell && promptViaAttach ? fullArgv.map(quoteWindowsArg) : fullArgv,
          {
            cwd: opts.cwd ?? process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
            shell: useShell,
          },
        );
      } catch (err) {
        safeEnqueue({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        cleanupArgvAttach();
        safeClose();
        return;
      }

      safeEnqueue({
        type: "start",
        bin,
        argv: fullArgv,
        promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
      });
      // The bound model as resolved by the #41 binding (ZCode's stream emits
      // no model/session start meta of its own). Surfaced so the log shows
      // which model×level the turn was pinned to.
      if (boundModelMeta) {
        safeEnqueue({ type: "meta", key: "model", value: boundModelMeta });
      }

      // #37: arm the silence watchdog only HERE — after the spawn succeeded —
      // so the argv-assembly / Linux-mount / binding window before it can
      // never trip the timer (that window has its own bounded failures).
      const fireSilence = () => {
        silenceTimer = null;
        safeEnqueue({
          type: "error",
          message: `ZCode produced no stream events for ${ZCODE_SILENCE_TIMEOUT_MS / 1000}s — the turn was terminated (hung model or CLI?).`,
        });
        try {
          child?.kill("SIGTERM");
        } catch {}
        cleanupArgvAttach();
        safeClose();
      };
      const resetSilenceTimer = () => {
        // No-op once the turn ended (close/abort cleared the handle) or for
        // agents that never armed one.
        if (silenceTimer === null) return;
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(fireSilence, ZCODE_SILENCE_TIMEOUT_MS);
      };
      if (opts.agent === "zcode") {
        silenceTimer = setTimeout(fireSilence, ZCODE_SILENCE_TIMEOUT_MS);
      }

      child.stdin.on("error", () => {});
      try {
        // stdin-protocol agents read the prompt from stdin; argv / argv-message
        // agents already have it on the command line; argv-attach agents carry
        // it in the temp-file attachment — stdin stays empty for all three.
        if (!promptViaArgv && !promptViaMessageFlag && !promptViaAttach) child.stdin.write(opts.prompt);
        child.stdin.end();
      } catch {}

      const parse = makeParser(opts.agent);

      let stdoutBuf = "";
      // #37: rolling stderr tail feeding the non-zero-exit error message.
      let stderrTail = "";
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
          const parts = parse(line);
          // #37: any line that parsed to at least one event proves the turn
          // is alive — reset the zcode silence watchdog (no-op for the
          // agents that never armed one). Dropped noise lines do NOT reset:
          // they are exactly the "silence" the watchdog exists to catch.
          if (parts.length > 0) resetSilenceTimer();
          for (const part of parts) {
            if (part.kind === "delta") safeEnqueue({ type: "delta", text: part.text });
            else if (part.kind === "html") safeEnqueue({ type: "html", text: part.text });
            else if (part.kind === "meta") safeEnqueue({ type: "meta", key: part.key, value: part.value });
            else if (part.kind === "error") safeEnqueue({ type: "error", message: part.message });
            else safeEnqueue({ type: "raw", text: line.slice(0, 240) });
          }
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
        safeEnqueue({ type: "stderr", text: chunk });
      });

      child.on("error", (err) => {
        clearSilenceTimer();
        safeEnqueue({ type: "error", message: err.message });
        cleanupArgvAttach();
        safeClose();
      });

      child.on("close", (code) => {
        clearSilenceTimer();
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
              else if (part.kind === "error") safeEnqueue({ type: "error", message: part.message });
            }
          }
        }
        // argv-attach teardown: kill the Linux mount holder and remove the
        // prompt temp dir (no-op for every other agent).
        cleanupArgvAttach();
        // #37: a non-zero exit is a failed turn — emit the error BEFORE done
        // so the consumer's failure gate renders the red error state (an
        // exit-0/unknown-code close keeps the historical done-only shape).
        // Carries the stderr essence for diagnosability; the full stderr has
        // already streamed as `stderr` log events.
        if (opts.agent === "zcode" && code != null && code !== 0) {
          const hint = stderrTail.trim();
          safeEnqueue({
            type: "error",
            message: `ZCode exited with code ${code}.${hint ? ` stderr: ${hint.slice(-STDERR_HINT_MAX)}` : ""}`,
          });
        }
        safeEnqueue({ type: "done", code });
        safeClose();
      });

      const onAbort = () => {
        clearSilenceTimer();
        try {
          child?.kill("SIGTERM");
        } catch {}
        cleanupArgvAttach();
        safeClose();
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      // Stream consumer cancelled. Release the argv-attach turn's resources
      // (mount holder + prompt temp file + silence watchdog); the child
      // itself is governed by the abort signal — unchanged generic behavior.
      clearSilenceTimer();
      cleanupArgvAttach();
    },
  });
}

// ─── ZCode AppImage self-mount (Linux; ADR-0007) ──────────────────────
//
// Shared helper for the argv-attach (CLI one-shot) trunk: on Linux the
// zcode.cjs bundle lives inside the AppImage squashfs, so the turn
// self-mounts the AppImage first and spawns node against the mounted
// <mountPoint>/resources/glm/zcode.cjs. The generic trunk owns the process
// lifecycle (spawn + kill).

/**
 * Self-mount the ZCode AppImage (ADR-0007 decision 2). Spawns
 * `AppImage --appimage-mount`, which prints the FUSE mount point to stdout
 * (first line) and stays alive holding the mount for as long as it runs.
 * Returns the mount child (killed on teardown) and the resolved mount point.
 *
 * Bounded to ~5s so a missing FUSE / corrupt AppImage / permission error
 * surfaces a clear error event instead of hanging the turn (spec AC). The
 * caller wires `signal` into the surrounding teardown.
 */
async function mountZcodeAppImage(
  appImage: string,
  opts: { cwd?: string; signal?: AbortSignal },
): Promise<{ mountChild: ChildProcessWithoutNullStreams; mountPoint: string }> {
  const mountChild = spawn(appImage, ["--appimage-mount"], {
    cwd: opts.cwd ?? process.cwd(),
    // All-pipe stdio keeps the type ChildProcessWithoutNullStreams (matching
    // the CLI child). The mount child never reads stdin; an idle pipe
    // is harmless and gets torn down with the child on teardown.
    stdio: ["pipe", "pipe", "pipe"],
  });
  const mountPoint = await new Promise<string>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const settle = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      mountChild.stdout.removeAllListeners();
      mountChild.removeListener("error", onError);
      mountChild.removeListener("close", onClose);
      if (opts.signal && onSignalAbort) {
        opts.signal.removeEventListener("abort", onSignalAbort);
      }
      if (err) {
        try { mountChild.kill("SIGTERM"); } catch {}
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const timer = setTimeout(() => {
      settle(new Error("ZCode AppImage mount timed out (no mount point after 5s) — is FUSE available and the AppImage executable?"));
    }, 5_000);
    const onError = (err: Error) => settle(err);
    // The mount child should stay alive holding the FUSE mount; ANY exit before
    // a mount point is printed is a failure (FUSE missing, corrupt AppImage,
    // permission denied, or killed). After success the idempotent guard no-ops.
    const onClose = () =>
      settle(new Error("ZCode AppImage mount exited before producing a mount point (FUSE missing, AppImage corrupt, or permission denied?)"));
    // Honor an abort during the mount window (up to 5s). The outer onAbort is
    // only registered AFTER this await resolves, so without this wiring a
    // cancel during mount would hold the FUSE mount until the timeout fires.
    const onSignalAbort = () => settle(new Error("ZCode AppImage mount aborted"));
    mountChild.stdout.setEncoding("utf8");
    mountChild.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const mp = buf.slice(0, nl).trim();
        if (mp) settle(null, mp);
        else settle(new Error("ZCode AppImage mount produced an empty mount point"));
      }
    });
    mountChild.on("error", onError);
    mountChild.on("close", onClose);
    if (opts.signal?.aborted) {
      settle(new Error("ZCode AppImage mount aborted"));
    } else if (opts.signal) {
      opts.signal.addEventListener("abort", onSignalAbort, { once: true });
    }
  });
  return { mountChild, mountPoint };
}


function errorStream(message: string): ReadableStream<InvokeEvent> {
  return new ReadableStream<InvokeEvent>({
    start(controller) {
      controller.enqueue({ type: "error", message });
      controller.close();
    },
  });
}