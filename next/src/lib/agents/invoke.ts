import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveOnPath, resolveOpenclawAgentId, resolveZcodeBin, resolveZcodeNodeBin, ZCODE_CJS_SENTINEL, AGENTS, type AgentDef } from "./detect";
import { buildArgv, envFor, makeParser, UnsupportedAgentProtocolError, rescueHtmlFromToolUse } from "./argv";
import { createZcodeProtocolClient } from "@html-anything/zcode-protocol/zcode-protocol";
import { ensureWorkspaceModel, startZcodeProtocolTurn, type ZcodeTurnModel } from "@html-anything/zcode-protocol/zcode-session";
import { readZcodeModelPicker } from "@html-anything/zcode-protocol/zcode-model-picker";

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

  // T12 (#12): app-server agents (ZCode) spawn `node <zcode.cjs> app-server`,
  // and html-anything is an EXTERNAL process — on a clean Windows host `where
  // node` finds nothing. The generic resolveBinForAgent() path treats
  // `def.bin = "node"` as a PATH lookup and treats ZCODE_BIN (def.envOverride)
  // as the bin override, but ZCODE_BIN is the .cjs override, NOT a node bin.
  // So app-server gets its OWN bin resolution: binOverride (explicit node path)
  // wins; otherwise resolveZcodeNodeBin() discovers node-or-Electron-exe (see
  // its doc comment for the live-proven strategy). Reconciles with
  // resolveZcodeBin() — they own disjoint concerns (.cjs vs node driver).
  //
  // T15 (#18 / ADR-0005 decision 3): resolveZcodeNodeBin() now returns `string`
  // (not `string | null`) — the Electron-exe fallback is terminal and
  // guaranteed-present whenever detect passed (zcode.cjs found ⟺ ZCode
  // installed ⟺ exe exists), so there is no "node binary not found" branch
  // here. Only the binOverride-missing error remains (a user-supplied path that
  // does not resolve is a real, reachable typo the user deserves to see).
  if (def.protocol === "app-server") {
    let bin: string;
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
          `${def.label}: custom node path \`${tried}\` does not exist. Update or clear it in Settings → Custom path.`,
        );
      }
    } else {
      bin = resolveZcodeNodeBin();
    }
    return invokeAppServerAgent({ def, bin, opts });
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
        // so this does not introduce a shell-injection vector.
        //
        // Only the BIN is quoted (for the shim); argv elements are passed
        // VERBATIM — the `main` baseline. Per-element quoting
        // (quoteWindowsArg) lives in the app-server (ZCode) branch below,
        // where spaced Windows paths (`C:\Program Files\ZCode\…`) need it.
        const useShell = process.platform === "win32";
        child = spawn(
          useShell ? `"${bin}"` : bin!,
          fullArgv,
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

/**
 * Resolve the user's per-agent ZCode model pick into the `{providerId, modelId}`
 * pair `session/create` binds to the session (#19 / ADR-0005 decision 4).
 *
 * The UI stores only the model id string per agent (`agentModels[id]`), so the
 * `providerId` must be recovered. The picker models (built at detect time from
 * `~/.zcode/v2/config.json`) each carry their `providerId`; we read the same
 * resolved config here and find the entry whose id matches the pick. When the
 * same model id exists under multiple enabled providers (e.g. GLM-5.2 is on
 * both `builtin:bigmodel` and `builtin:bigmodel-coding-plan`), prefer the entry
 * whose provider is the GUI's selected one — `readZcodeModelPicker` derives
 * `defaultProviderId` from `setting.json`'s `modelProviderFamilySelectedKeys`.
 *
 * Returns `undefined` when the pick is absent, `"default"`, or not found in the
 * dynamic list — in all those cases `session/create` carries no `model` field
 * and the workspace default (provisioned by `ensureWorkspaceModel`) applies,
 * which is the unchanged pre-#19 path.
 */
function resolveZcodeTurnModel(modelPick: string | undefined): ZcodeTurnModel | undefined {
  const trimmed = modelPick?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  const { models, defaultProviderId } = readZcodeModelPicker();
  const matches = models.filter((m) => m.id === trimmed);
  if (matches.length === 0) return undefined;
  // Prefer the GUI's selected provider when the picked model id is ambiguous
  // across providers; otherwise take the first match (insertion order = the
  // GUI's display order).
  const chosen =
    defaultProviderId !== null
      ? matches.find((m) => m.providerId === defaultProviderId) ?? matches[0]!
      : matches[0]!;
  return { providerId: chosen.providerId, modelId: chosen.id };
}

/**
 * Self-mount the ZCode AppImage (ADR-0007 decision 2). Spawns
 * `AppImage --appimage-mount`, which prints the FUSE mount point to stdout
 * (first line) and stays alive holding the mount for as long as it runs.
 * Returns the mount child (killed on teardown) and the resolved mount point.
 *
 * Bounded to ~5s so a missing FUSE / corrupt AppImage / permission error
 * surfaces a clear error event instead of hanging the turn (spec AC). The
 * mount child is detached from the abort signal here only to the extent of
 * the timeout; the caller wires `signal` into the surrounding teardown.
 */
async function mountZcodeAppImage(
  appImage: string,
  opts: { cwd?: string; signal?: AbortSignal },
): Promise<{ mountChild: ChildProcessWithoutNullStreams; mountPoint: string }> {
  const mountChild = spawn(appImage, ["--appimage-mount"], {
    cwd: opts.cwd ?? process.cwd(),
    // All-pipe stdio keeps the type ChildProcessWithoutNullStreams (matching
    // the app-server child). The mount child never reads stdin; an idle pipe
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
  // AgentDef is filled INSIDE start() (T7) from the resolved cjs path — on
  // Linux that path is only known after the AppImage is self-mounted, so the
  // argv cannot be built here (ADR-0007 decision 2).

  // Lifted above the ReadableStream so `cancel` (a sibling callback) can tear
  // the turn + children down without waiting on `start`.
  let child: ChildProcessWithoutNullStreams | null = null;
  // ADR-0007: on Linux the AppImage mount child stays alive holding the FUSE
  // mount for the duration of the turn; it is killed alongside `child` on
  // teardown/cancel. Null on Windows/macOS (no mount).
  let mountChild: ChildProcessWithoutNullStreams | null = null;
  let turnUnsubscribe: (() => void) | null = null;
  let client: ReturnType<typeof createZcodeProtocolClient> | null = null;
  // #22 / spec #20 N2: the silence-timer handle is lifted here (sibling to
  // `child`) so `cancel` — a ReadableStream sibling, NOT inside `start` — can
  // clear it on teardown. `clearSilenceTimer` has no closure deps beyond this
  // handle, so it lifts cleanly. `resetSilenceTimer` stays inside `start`
  // because its fire callback closes over `safeEnqueue` + `finish`.
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

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
        // ADR-0007: the mount child holds the FUSE mount alive; kill it so the
        // mount unmounts at teardown (per-turn mount+unmount). No-op on
        // Windows/macOS (mountChild is null there).
        try {
          mountChild?.kill("SIGTERM");
        } catch {}
      };

      // #22 / spec #20 N2: turn-silence timer. The post-session/send window is
      // the only unbounded await in the turn — if the model's turn never
      // completes (stuck tool, runaway reasoning, dropped terminal event) the
      // stream would hang forever emitting nothing. This is a SILENCE timeout,
      // not a hard turn cap: it arms once the turn driver has resolved (after
      // session/send returns) and resets on EVERY onEvent call (including
      // thinking_delta, the model's "I'm still alive" signal during deep
      // reasoning) so legitimately long agentic turns keep running as long as
      // events keep arriving. Only 180s of ZERO events fires. Do NOT arm
      // earlier — the once-per-boot model relay (ensureWorkspaceModel) can
      // legitimately take seconds and must not be on the silence clock. The
      // handle + clearSilenceTimer are lifted above start() so cancel() can
      // clear them too; resetSilenceTimer stays here (closes over finish +
      // safeEnqueue).
      const resetSilenceTimer = () => {
        clearSilenceTimer();
        silenceTimer = setTimeout(() => {
          silenceTimer = null;
          safeEnqueue({
            type: "error",
            message: "zcode turn went silent for 180s (no events from the model)",
          });
          finish(1);
        }, 180_000);
      };

      const teardown = () => {
        clearSilenceTimer();
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

      // ADR-0007: on Linux the `.cjs` lives inside the AppImage mount. Self-
      // mount at turn start to expose it, then spawn
      // `node <mountPoint>/resources/glm/zcode.cjs app-server`. The mount child
      // is killed on teardown/cancel (per-turn mount+unmount, NOT a process-
      // level cache — keeps the model stateless, matching Win/macOS). On
      // Windows/macOS the `.cjs` is a permanent on-disk file; skip mounting.
      let cjsPath: string;
      if (process.platform === "linux") {
        const appImage = resolveZcodeBin();
        if (!appImage) {
          safeEnqueue({
            type: "error",
            message:
              "ZCode AppImage not found. Open the ZCode GUI once (to write its .desktop entry), set ZCODE_BIN, or put `zcode` on PATH.",
          });
          safeClose();
          return;
        }
        try {
          const mounted = await mountZcodeAppImage(appImage, {
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
          try { mountChild?.kill("SIGTERM"); } catch {}
          safeEnqueue({ type: "error", message });
          safeClose();
          return;
        }
      } else {
        cjsPath = resolveZcodeBin() ?? ZCODE_CJS_SENTINEL;
      }

      // The sentinel on the AgentDef is filled here from the resolved cjs
      // path so the spawn runs `node <real-cjs-path> app-server` (T7). On
      // Linux the cjs path is the mounted path above (ADR-0007).
      const argv = (def.binArgs ?? []).map((arg) =>
        arg === ZCODE_CJS_SENTINEL ? cjsPath : arg,
      );

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
        clearSilenceTimer();
        safeEnqueue({ type: "done", code });
        teardown();
      };

      // #21 / spec #20 N1: the protocol stream maps tool_call→{type:"tool_use",
      // id, name} and result→{type:"tool_result", toolUseId, name} — neither
      // carries user-visible text, so without this bridge the SSE stream emits
      // zero bytes during the model's tool window (e.g. a multi-second
      // WebSearch), freezing the UI. Forward both as {type:"meta", key:"status"}
      // so the bytes keep flowing (byte-level keepalive) and a future frontend
      // can surface progress without further adapter work. `meta` is already in
      // the InvokeEvent union (openclaw emits it for model/session/result), so
      // this adds no new event type.
      //
      // Name resolution: the `tool_result` event from the protocol stream now
      // carries the tool name directly (read from the frame's own `toolName`
      // field). We still keep a `toolNamesById` Map as a fallback for any
      // result event that arrives without a name (defensive — the protocol
      // layer adds it whenever the frame carries one).
      const toolNamesById = new Map<string, string>();

      const onEvent = (event: Record<string, unknown>) => {
        // #22 / spec #20 N2: reset the silence clock as the FIRST statement,
        // before any early-return guard — ANY event (including thinking_delta,
        // the weakest liveness signal) refreshes it. This is what distinguishes
        // "model working slowly" from "turn genuinely dead".
        resetSilenceTimer();
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
          const id = typeof event.id === "string" ? event.id : "";
          const name = typeof event.name === "string" ? event.name : "";
          const input = (event.input ?? null) as unknown;
          if (id && name) toolNamesById.set(id, name);
          const html = rescueHtmlFromToolUse([{ type: "tool_use", name, input }]);
          if (html) {
            safeEnqueue({ type: "html", text: html });
          } else if (name) {
            // Non-HTML tool_use (e.g. WebSearch) → forward as a meta status so
            // the stream keeps flowing during the tool window (#21). Wording
            // follows the log panel's natural-description convention (no emoji).
            safeEnqueue({ type: "meta", key: "status", value: `调用工具 ${name}` });
          }
          return;
        }
        if (type === "tool_result") {
          // Prefer the name carried on the event itself (protocol stream reads
          // it from the frame's `toolName` field); fall back to the Map only
          // if the event arrives nameless. If neither yields a name, emit
          // nothing — a nameless status line is noise (the log panel shows a
          // bare ✓ with no context, worse than no line at all).
          const toolUseId = typeof event.toolUseId === "string" ? event.toolUseId : "";
          const carriedName = typeof event.name === "string" ? event.name : "";
          const name = carriedName || (toolUseId && toolNamesById.get(toolUseId)) || "";
          if (name) {
            safeEnqueue({ type: "meta", key: "status", value: `工具 ${name} 完成` });
          }
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
        // #25 (supersedes ADR-0006 Decision 1): forward the model's reasoning
        // stream as {type:"meta", key:"thinking"} — the EXACT event shape the
        // Claude Code argv path emits (argv.ts: thinking_delta content block →
        // {kind:"meta", key:"thinking", value}) and the shared frontend
        // `formatMeta` renders as `thinking …`. A live comparison (hsiarch,
        // 2026-08-12) showed Claude Code streams the same per-fragment thinking
        // lines and that continuous flow is good UX; ZCode's reasoning was a
        // black box ONLY because this layer dropped it, not because of any
        // model/protocol limit (a probe captured 70+ reasoning_delta frames
        // from ZCode + GLM-5.2). thinking_start carries no payload and is
        // ignored (early-return) so it produces no empty/garbage log line. HTML
        // output is unaffected: it travels the separate text_delta → delta
        // channel and never mixes with thinking.
        if (type === "thinking_start") return;
        if (type === "thinking_delta") {
          const delta = typeof event.delta === "string" ? event.delta : "";
          if (delta) safeEnqueue({ type: "meta", key: "thinking", value: delta });
          return;
        }
        // ZCode generates a conversation title (source:"generated"); the
        // protocol layer surfaces it as a conversation_title event. Forward it
        // as a meta so it isn't silently dropped — uses the existing `meta`
        // InvokeEvent (no union change); formatMeta's generic fallback renders
        // `conversation_title: <title>`.
        if (type === "conversation_title") {
          const title = typeof event.title === "string" ? event.title : "";
          if (title) safeEnqueue({ type: "meta", key: "conversation_title", value: title });
          return;
        }
        // Any other/unmapped kind the protocol layer may emit in future is
        // dropped here (today nothing reaches this point).
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
        // #19 / ADR-0005 decision 4: resolve the user's per-agent model pick
        // into {providerId, modelId}. When set (non-default), session/create
        // carries it and binds it to the session (live-proven). When unset
        // (default/absent/not-found), session/create carries no model field and
        // the workspace default (provisioned by the relay above) applies.
        const model = resolveZcodeTurnModel(opts.model);
        const turn = await startZcodeProtocolTurn({
          client,
          cwd: opts.cwd ?? process.cwd(),
          prompt: opts.prompt,
          onEvent,
          signal: opts.signal,
          ...(model ? { model } : {}),
        });
        turnUnsubscribe = turn.unsubscribe;
        // #22 / spec #20 N2: the turn driver has resolved — session/send has
        // returned and the turn is genuinely running. Arm the silence timer
        // HERE (not earlier): the once-per-boot model relay above can
        // legitimately take seconds and must not be on the silence clock. Any
        // onEvent call from here on resets it; finish()/teardown()/cancel()
        // disarm it.
        resetSilenceTimer();
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
      clearSilenceTimer();
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
      // ADR-0007: kill the mount child on cancel too — it is a sibling of
      // `child`, not reached by killChild() (which lives inside start()).
      try {
        mountChild?.kill("SIGTERM");
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
