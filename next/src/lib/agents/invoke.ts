import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveOnPath, resolveOpenclawAgentId, resolveZcodeBin, ZCODE_CJS_SENTINEL, AGENTS, type AgentDef } from "./detect";
import { buildArgv, envFor, makeParser, UnsupportedAgentProtocolError, rescueHtmlFromToolUse } from "./argv";
import { createZcodeProtocolClient } from "@html-anything/zcode-protocol/zcode-protocol";
import { startZcodeProtocolTurn } from "@html-anything/zcode-protocol/zcode-session";

export type InvokeOpts = {
  agent: string;
  prompt: string;
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
  /**
   * Absolute path to the agent binary. Wins over `process.env[envOverride]`
   * and the PATH scan when set. Surfaced from the Settings UI for users
   * whose CLI lives outside the heuristic toolchain dirs.
   */
  binOverride?: string;
};

type BinResolution =
  | { kind: "ok"; bin: string }
  | { kind: "override-missing"; tried: string }
  | { kind: "not-found" };

/**
 * Resolve the binary to spawn, in priority order:
 *   1. `opts.binOverride` (user-set absolute path from Settings UI)
 *   2. `process.env[def.envOverride]` (e.g. CLAUDE_BIN, OPENCLAW_BIN)
 *   3. PATH scan over `def.bin` then `def.fallbackBins`
 *
 * If a `binOverride` is set but doesn't resolve, return `override-missing`
 * (do not silently fall through) — the user picked an explicit path and
 * deserves to see the typo / wrong path instead of mysteriously running a
 * different binary.
 */
/**
 * Quote a single argv element for cmd.exe when `spawn(..., { shell: true })` is
 * used on Windows. cmd.exe splits the argv array on whitespace, so an element
 * containing a space — notably ZCode's resolved `C:\Program
 * Files\ZCode\resources\glm\zcode.cjs` — must be double-quoted. Already-quoted
 * elements are left alone; empty elements become `""`.
 */
function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && arg.startsWith('"') && arg.endsWith('"')) return arg;
  return `"${arg}"`;
}

function resolveBinForAgent(
  def: (typeof AGENTS)[number],
  binOverride: string | undefined,
): BinResolution {
  const tryPath = (p: string | undefined): string | null => {
    if (!p) return null;
    const trimmed = p.trim();
    if (!trimmed) return null;
    // Absolute path → must exist; relative names → fall back to PATH scan.
    if (/^([a-zA-Z]:[\\/]|[\\/])/.test(trimmed)) {
      return existsSync(trimmed) ? trimmed : null;
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
  /**
   * Canonical HTML rescued from a file-write tool call. The client REPLACES
   * the task's accumulated html with this payload (not appends) — see
   * [[rescueHtmlFromToolUse]] in argv.ts for why this exists.
   */
  | { type: "html"; text: string }
  | { type: "meta"; key: string; value: unknown }
  | { type: "stderr"; text: string }
  | { type: "raw"; text: string }
  | { type: "done"; code: number | null }
  | { type: "error"; message: string };

export function invokeAgent(opts: InvokeOpts): ReadableStream<InvokeEvent> {
  const def = AGENTS.find((a) => a.id === opts.agent);
  if (!def) {
    return errorStream(`unknown agent: ${opts.agent}`);
  }
  const resolved = resolveBinForAgent(def, opts.binOverride);
  if (resolved.kind === "override-missing") {
    return errorStream(
      `${def.label}: custom path \`${resolved.tried}\` does not exist. Update or clear it in Settings → Custom path.`,
    );
  }
  if (resolved.kind === "not-found") {
    return errorStream(
      `${def.label} (\`${def.bin}\`) is not installed or not on PATH.`,
    );
  }
  const bin: string = resolved.bin;

  // app-server protocol agents (ZCode) take a different path: a single
  // JSON-RPC turn over stdio driven by the shared zcode-protocol layer, not
  // the line-parsed stdout loop below. Mirror cli's T5 — see ADR-0002
  // decision 2 for why ZCode's wire format is not the ACP JSON-RPC the
  // hermes/kimi family speaks.
  if (def.protocol === "app-server") {
    return invokeAppServerAgent({ def, bin, opts });
  }

  // For openclaw we need an async detection step (resolveOpenclawAgentId)
  // before buildArgv. Do all of the argv assembly inside the stream's async
  // start so we can `await` and surface failures as `error` events.
  const env = envFor(opts.agent);
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

      // Resolve agent-specific argv. For openclaw we first probe `agents
      // list` to learn the actual agent id (commonly "main") so the CLI's
      // required `--agent <id>` is satisfied.
      let argv: string[];
      try {
        const argvOpts: Parameters<typeof buildArgv>[1] = {
          model: opts.model,
          prompt: opts.prompt,
        };
        if (opts.agent === "openclaw") {
          argvOpts.openclawAgentId = await resolveOpenclawAgentId(bin!);
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
      // `protocol: "argv"` adapters (deepseek-tui today) take the prompt as a
      // trailing positional arg rather than reading from stdin.
      if (promptViaArgv) argv = [...argv, opts.prompt];
      // `protocol: "argv-message"` (openclaw today) wants the prompt under
      // an explicit `--message <text>` flag.
      if (promptViaMessageFlag) argv = [...argv, "--message", opts.prompt];

      // node-script CLIs (ZCode's zcode.cjs) run as `node <cjs> app-server`;
      // binArgs carries the leading argv the bin needs. Absent for every
      // existing adapter, so their spawn is unchanged. See ADR-0002 decision 3.
      const fullArgv = def.binArgs?.length ? [...def.binArgs, ...argv] : argv;

      try {
        // On Windows, `spawn` cannot launch a `.cmd` / `.bat` shim (which is
        // what npm installs for most CLI agents) without going through the
        // shell. Without this, every agent invocation fails with
        // EINVAL / "spawn 无效的参数". macOS/Linux use direct exec.
        // Safety: prompt content is delivered via stdin or `--message
        // <text>` (argv-message), not interpolated into a shell command,
        // so this does not introduce a shell-injection vector. Each argv
        // element is quoted too, so paths with spaces (e.g. ZCode's
        // `C:\Program Files\ZCode\...\zcode.cjs`) survive the shell round-trip.
        const useShell = process.platform === "win32";
        child = spawn(
          useShell ? `"${bin}"` : bin!,
          useShell ? fullArgv.map(quoteWindowsArg) : fullArgv,
          {
            cwd: opts.cwd ?? process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
            shell: useShell,
            windowsVerbatimArguments: false,
          },
        );
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
        bin: bin!,
        argv: fullArgv,
        promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
      });

      child.stdin.on("error", () => {});
      try {
        // stdin-protocol agents read the prompt from stdin; argv / argv-message
        // agents already have it on the command line.
        if (!promptViaArgv && !promptViaMessageFlag) child.stdin.write(opts.prompt);
        child.stdin.end();
      } catch {}

      // One parser per spawn so cross-line dedupe state (sawStreamEventText)
      // is scoped to this single invocation and doesn't leak across runs.
      const parse = makeParser(opts.agent);

      let stdoutBuf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (closed) return;
        stdoutBuf += chunk;
        // OpenClaw emits one big multi-line JSON document — accumulate and
        // parse it once on close instead of trying to parse each line.
        if (opts.agent === "openclaw") return;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          for (const part of parse(line)) {
            // Some agents (bob) may echo the entire prompt back as the first
            // streamed delta. Suppress that to avoid polluting the user-facing
            // output with the system prompt.
            if (opts.agent === "bob" && part.kind === "delta") {
              if (part.text.trim() === opts.prompt.trim()) continue;
            }
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
          // OpenClaw's `agent --local --json` emits one pretty-printed JSON
          // document on stdout. The visible reply is at
          // `data.finalAssistantVisibleText`; usage / model show up in
          // `data.executionTrace`. Emit the visible text as a single delta.
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
              const trace = obj?.meta?.executionTrace;
              if (trace?.winnerModel) {
                safeEnqueue({
                  type: "meta",
                  key: "model",
                  value: trace.winnerProvider
                    ? `${trace.winnerProvider}/${trace.winnerModel}`
                    : trace.winnerModel,
                });
              }
              if (obj?.meta?.agentMeta?.sessionId) {
                safeEnqueue({ type: "meta", key: "session", value: obj.meta.agentMeta.sessionId });
              }
              if (obj?.meta?.completion?.stopReason) {
                safeEnqueue({ type: "meta", key: "result", value: obj.meta.completion.stopReason });
              }
              if (!text) {
                safeEnqueue({
                  type: "error",
                  message: "OpenClaw returned an empty assistant message",
                });
              }
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
// Distinct from the "acp" path: ZCode's app-server wire format
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
  // ADR-0004 / #13: the app-server child self-authenticates from the user's
  // logged-in state — it resolves the Coding Plan entitlement on its own. The
  // adapter spawns, drives, and parses; it provisions NO provider/key. The
  // previous readZcodeConfig() → "no saved provider" short-circuit is deleted:
  // there is no credential to gate on. The only precondition is the install
  // existing (checked above in invokeAgent before this branch).

  // binArgs carries the leading argv a node-script CLI needs (e.g.
  // [ZCODE_CJS_SENTINEL, "app-server"]). The prompt is NOT piped to stdin — it
  // travels inside the JSON-RPC session/send request. The sentinel on the
  // AgentDef is filled here from resolveZcodeBin() so the spawn runs
  // `node <real-cjs-path> app-server` (T7 — makes ZCode invocable end to end
  // through the T6 invoke branch).
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
        // Same Windows `.cmd`/`.bat` shim handling as the argv branch: quote
        // the bin and run through a shell on win32 so `node` resolves a
        // `.cmd` wrapper when one exists. argv elements are quoted too, so
        // the resolved `zcode.cjs` path (`C:\Program Files\ZCode\...`) is not
        // split on its space by cmd.exe.
        const useShell = process.platform === "win32";
        child = spawn(
          useShell ? `"${bin}"` : bin,
          useShell ? argv.map(quoteWindowsArg) : argv,
          {
            cwd: opts.cwd ?? process.cwd(),
            env,
            stdio: ["pipe", "pipe", "pipe"],
            shell: useShell,
            windowsVerbatimArguments: false,
          },
        );
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
