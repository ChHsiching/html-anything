import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOnPath, resolveOpenclawAgentId, resolveZcodeBin, resolveZcodeNodeBin, ZCODE_CJS_SENTINEL, AGENTS } from "./detect";
import { buildArgv, envFor, makeParser, UnsupportedAgentProtocolError } from "./argv";
import {
  prepareZcodeModelBinding,
  zcodeBindingEnv,
  zcodeProviderEnvPairSet,
} from "./zcode-model-binding";

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
 * (do not silently fall through): the user picked an explicit path and
 * deserves to see the typo / wrong path rather than mysteriously running a
 * different binary.
 */
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

/**
 * Quote a single argv element for cmd.exe when `spawn(..., { shell: true })` is
 * used on Windows. cmd.exe splits the argv array on whitespace, so an element
 * containing a space (notably ZCode's resolved `C:\Program
 * Files\ZCode\resources\glm\zcode.cjs`) must be double-quoted. Already-quoted
 * elements are left alone; empty elements become `""`.
 *
 * Only used on zcode's shell fallback path (a `.cmd`/`.bat` node shim): the
 * normal zcode resolution yields an absolute `.exe`, which spawns directly
 * with no shell and verbatim argv.
 */
function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && arg.startsWith('"') && arg.endsWith('"')) return arg;
  return `"${arg}"`;
}

export type InvokeEvent =
  | { type: "start"; bin: string; argv: string[]; promptBytes: number }
  | { type: "delta"; text: string }
  /**
   * Canonical HTML rescued from a file-write tool call. The client REPLACES
   * the task's accumulated html with this payload (not appends); see
   * [[rescueHtmlFromToolUse]] in argv.ts for why this exists.
   */
  | { type: "html"; text: string }
  | { type: "meta"; key: string; value: unknown }
  | { type: "stderr"; text: string }
  | { type: "raw"; text: string }
  | { type: "done"; code: number | null }
  | { type: "error"; message: string };

/**
 * Silence watchdog (zcode only): a healthy stream-json turn produces
 * parsed events continuously (deltas, thinking fragments, tool status), so
 * 180s with zero parsed events means the model or CLI hung and the turn
 * would hang forever with no teardown. Any stdout line that parses to at
 * least one event resets the clock; when it fires the turn errors out, the
 * child is killed, and the stream closes. Sibling agents keep their
 * historical behavior.
 */
const ZCODE_SILENCE_TIMEOUT_MS = 180_000;

/**
 * Cap on the stderr tail kept for the non-zero-exit error message.
 * The full stderr keeps streaming to the log as `stderr` events; this buffer
 * only feeds the one-line exit error with its most recent content.
 */
const STDERR_TAIL_CAP = 2_000;
/** How much of that tail the exit-error message actually quotes. */
const STDERR_HINT_MAX = 500;

export function invokeAgent(opts: InvokeOpts): ReadableStream<InvokeEvent> {
  const def = AGENTS.find((a) => a.id === opts.agent);
  if (!def) {
    return errorStream(`unknown agent: ${opts.agent}`);
  }

  // argv-attach agents (ZCode) spawn `node <zcode.cjs> -p …`, and
  // html-anything is an external process: on a clean Windows host
  // `where node` finds nothing. ZCODE_BIN (def.envOverride) is the `.cjs`
  // override, not a node bin, so these agents resolve their bin separately:
  // binOverride (explicit node path) wins, else resolveZcodeNodeBin() (never
  // null because its Electron-exe fallback is present whenever detect
  // passed). Only the binOverride-missing error remains. Execution then
  // continues down the generic trunk below; ZCode has no dedicated protocol
  // branch.
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
          `${def.label}: custom node path \`${tried}\` does not exist. Update or clear it in Settings → Custom path.`,
        );
      }
    } else {
      bin = resolveZcodeNodeBin();
    }
  } else {
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
    bin = resolved.bin;
  }

  // For openclaw we need an async detection step (resolveOpenclawAgentId)
  // before buildArgv. Do all of the argv assembly inside the stream's async
  // start so we can `await` and surface failures as `error` events.
  const env = envFor(opts.agent);
  const promptViaArgv = def.protocol === "argv";
  const promptViaMessageFlag = def.protocol === "argv-message";
  const promptViaAttach = def.protocol === "argv-attach";

  // Lifted above the ReadableStream so `cancel` (a sibling callback of
  // `start` that cannot reach its locals) can tear the argv-attach turn's
  // resources down without waiting on `start`:
  //   - mountChild: on Linux the AppImage mount child stays alive holding the
  //     FUSE mount for the duration of the turn (null on Windows/macOS).
  //   - attachTmpDir: the mkdtemp dir holding zcode's prompt.md attachment.
  let mountChild: ChildProcessWithoutNullStreams | null = null;
  let attachTmpDir: string | null = null;
  // The zcode silence-watchdog handle, lifted for the same reason as
  // cleanupArgvAttach: `cancel`, a sibling of `start`, must be able to clear
  // it without waiting for `start` to run.
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearSilenceTimer = () => {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };
  const cleanupArgvAttach = () => {
    // The mount child holds the FUSE mount alive; kill it so the
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

      // argv-attach (ZCode): resolve the .cjs argv[1] before the final argv is
      // assembled; on Linux that path is only known after the AppImage
      // self-mounts. Reuses resolveZcodeBin() and the
      // mount helper unchanged; a ZCODE_BIN pointing at a `.cjs` is used
      // directly with no mount.
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
      // `protocol: "argv-attach"` (zcode today): the full prompt (shared
      // directives + template + user content, 20-30KB+) is far past command-
      // line length limits, so it travels as a temp-file attachment. The
      // `.md` enters the model context whole (verified). `-p` (buildArgv)
      // already holds the fixed short guide. The mkdtemp dir is removed on
      // every exit path via cleanupArgvAttach (close / error / abort /
      // cancel); it also holds the per-turn provider-config clone below, so
      // the binding is cleaned up with the prompt.
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

        // Per-turn model binding (ZCode has no --model flag): clone + paired
        // env vars + the identity-bridge credential; any broken link refuses
        // the spawn. See zcode-model-binding.ts. A user who pre-set the env
        // pair keeps it untouched (zero-code reroute).
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
      // binArgs holds the leading argv the bin needs, with the
      // `<resolved-zcode-cjs>` sentinel filled from the path resolved above
      // (the mounted path on Linux). Absent for every existing adapter, so
      // their spawn is unchanged.
      const leadingArgv = (def.binArgs ?? []).map((arg) =>
        arg === ZCODE_CJS_SENTINEL && cjsPath ? cjsPath : arg,
      );
      const fullArgv = leadingArgv.length ? [...leadingArgv, ...argv] : argv;

      try {
        // On Windows, `spawn` cannot launch a `.cmd` / `.bat` shim (which is
        // what npm installs for most CLI agents) without going through the
        // shell. Without this, every agent invocation fails with
        // EINVAL / "spawn 无效的参数". macOS/Linux use direct exec.
        // Safety: prompt content is delivered via stdin, `--message <text>`
        // (argv-message), or a temp-file `--attach` path (argv-attach), and
        // never interpolated into a shell command, so this does not introduce
        // a shell-injection vector.
        //
        // Exception: an absolute `.exe` (ZCode's `ZCode.exe` node driver, or
        // a real node.exe) spawns directly with no cmd.exe round-trip, so
        // spaced install paths (`C:\Program Files\ZCode\ZCode.exe`) work
        // untouched and every argv element passes verbatim, with no quoting
        // games. Only the bin is quoted on the shell path (the `main`
        // baseline); per-element quoting (quoteWindowsArg) applies solely to
        // zcode's `.cmd`-shim corner, where the spaced `zcode.cjs` path must
        // survive cmd.exe's whitespace split. (The cli mirror deliberately
        // differs here: it never quoted the bin on its generic shell path, so
        // it gates all quoting, bin included, on the zcode attach case.)
        const binIsAbsoluteExe =
          process.platform === "win32" &&
          /^([a-zA-Z]:[\\/]|[\\/])/.test(bin) &&
          /\.exe$/i.test(bin);
        const useShell = process.platform === "win32" && !binIsAbsoluteExe;
        child = spawn(
          useShell ? `"${bin}"` : bin,
          useShell && promptViaAttach ? fullArgv.map(quoteWindowsArg) : fullArgv,
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
        cleanupArgvAttach();
        safeClose();
        return;
      }

      safeEnqueue({
        type: "start",
        bin: bin!,
        argv: fullArgv,
        promptBytes: Buffer.byteLength(opts.prompt, "utf8"),
      });
      // The bound model as resolved by the per-turn binding (ZCode's stream emits
      // no model/session start meta of its own). Emitted so the log panel
      // shows which model and level the turn was pinned to.
      if (boundModelMeta) {
        safeEnqueue({ type: "meta", key: "model", value: boundModelMeta });
      }

      // Arm the silence watchdog only here, after the spawn succeeded, so
      // the argv-assembly / Linux-mount / binding window before it can
      // never trip the timer (that window has its own bounded failures).
      const fireSilence = () => {
        silenceTimer = null;
        safeEnqueue({
          type: "error",
          message: `ZCode produced no stream events for ${ZCODE_SILENCE_TIMEOUT_MS / 1000}s. The turn was terminated (hung model or CLI?).`,
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
        // it in the temp-file attachment, so stdin stays empty for all three.
        if (!promptViaArgv && !promptViaMessageFlag && !promptViaAttach) child.stdin.write(opts.prompt);
        child.stdin.end();
      } catch {}

      // One parser per spawn so cross-line dedupe state (sawStreamEventText)
      // is scoped to this single invocation and doesn't leak across runs.
      const parse = makeParser(opts.agent);

      let stdoutBuf = "";
      // Rolling stderr tail feeding the non-zero-exit error message.
      let stderrTail = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (closed) return;
        stdoutBuf += chunk;
        // OpenClaw emits one big multi-line JSON document; accumulate and
        // parse it once on close rather than trying to parse each line.
        if (opts.agent === "openclaw") return;
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          const parts = parse(line);
          // Any line that parsed to at least one event proves the turn
          // is alive, so it resets the zcode silence watchdog (no-op for the
          // agents that never armed one). Dropped noise lines do not reset:
          // they are exactly the "silence" the watchdog exists to catch.
          if (parts.length > 0) resetSilenceTimer();
          for (const part of parts) {
            // Some agents (bob) may echo the entire prompt back as the first
            // streamed delta. Suppress that to avoid polluting the user-facing
            // output with the system prompt.
            if (opts.agent === "bob" && part.kind === "delta") {
              if (part.text.trim() === opts.prompt.trim()) continue;
            }
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
              else if (part.kind === "error") safeEnqueue({ type: "error", message: part.message });
            }
          }
        }
        // argv-attach teardown: kill the Linux mount holder and remove the
        // prompt temp dir (no-op for every other agent).
        cleanupArgvAttach();
        // A non-zero exit is a failed turn: emit the error before done
        // so the consumer's failure gate renders the red error state (an
        // exit-0/unknown-code close keeps the historical done-only shape).
        // The message quotes the stderr tail for diagnosability; the full
        // stderr has already streamed as `stderr` log events.
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
      // itself is governed by the abort signal, unchanged generic behavior.
      clearSilenceTimer();
      cleanupArgvAttach();
    },
  });
}

// ─── ZCode AppImage self-mount (Linux) ────────────────────────────────
//
// Shared helper for the argv-attach (CLI one-shot) trunk: on Linux the
// zcode.cjs bundle lives inside the AppImage squashfs, so the turn
// self-mounts the AppImage first and spawns node against the mounted
// <mountPoint>/resources/glm/zcode.cjs. The generic trunk owns the process
// lifecycle (spawn + kill).

/**
 * Self-mount the ZCode AppImage. Spawns
 * `AppImage --appimage-mount`, which prints the FUSE mount point to stdout
 * (first line) and stays alive holding the mount for as long as it runs.
 * Returns the mount child (killed on teardown) and the resolved mount point.
 *
 * Bounded to ~5s so a missing FUSE / corrupt AppImage / permission error
 * surfaces a clear error event rather than hanging the turn. The
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
      settle(new Error("ZCode AppImage mount timed out (no mount point after 5s). Is FUSE available and is the AppImage executable?"));
    }, 5_000);
    const onError = (err: Error) => settle(err);
    // The mount child should stay alive holding the FUSE mount; ANY exit before
    // a mount point is printed is a failure (FUSE missing, corrupt AppImage,
    // permission denied, or killed). After success the idempotent guard no-ops.
    const onClose = () =>
      settle(new Error("ZCode AppImage mount exited before producing a mount point (FUSE missing, AppImage corrupt, or permission denied?)"));
    // Honor an abort during the mount window (up to 5s). The outer onAbort is
    // only registered after this await resolves, so without this wiring a
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
