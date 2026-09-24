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
} from "@html-anything/zcode-protocol/zcode-model-binding";

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
 *
 * Only used on zcode's shell fallback path (a `.cmd`/`.bat` node shim): the
 * normal zcode resolution yields an absolute `.exe`, which spawns directly
 * with no shell and verbatim argv.
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

  // Lifted above the ReadableStream so `cancel` — a sibling callback of
  // `start` that cannot reach its locals — can tear the argv-attach turn's
  // resources down without waiting on `start`:
  //   - mountChild: on Linux the AppImage mount child stays alive holding the
  //     FUSE mount for the duration of the turn (null on Windows/macOS).
  //   - attachTmpDir: the mkdtemp dir holding zcode's prompt.md attachment.
  let mountChild: ChildProcessWithoutNullStreams | null = null;
  let attachTmpDir: string | null = null;
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
      // line length limits, so it travels as a temp-file attachment — the
      // `.md` enters the model context whole (live-proven). `-p` (buildArgv)
      // already carries the fixed short guide. The mkdtemp dir is removed on
      // every exit path via cleanupArgvAttach (close / error / abort /
      // cancel) — it also holds the per-turn provider-config clone below, so
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

        // #41 — deterministic per-turn model binding. ZCode's CLI has no
        // --model flag and SILENTLY falls back to the first visible registry
        // provider (+ max reasoning) when a config default is absent/invalid,
        // which can route the turn to a provider the user never chose. Every
        // turn therefore writes its model selection into a TEMP CLONE of the
        // user's provider config (real file never touched) and hands the
        // child the PAIRED ZCODE_*_PROVIDER_CONFIG_FILE vars (the CLI
        // hard-requires the pair; "读哪份传哪份" — the builtin var points at
        // the very catalog file the selection was validated against). A user
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
        // On Windows, `spawn` cannot launch a `.cmd` / `.bat` shim (which is
        // what npm installs for most CLI agents) without going through the
        // shell. Without this, every agent invocation fails with
        // EINVAL / "spawn 无效的参数". macOS/Linux use direct exec.
        // Safety: prompt content is delivered via stdin, `--message <text>`
        // (argv-message), or a temp-file `--attach` path (argv-attach) —
        // never interpolated into a shell command, so this does not introduce
        // a shell-injection vector.
        //
        // EXCEPTION — an ABSOLUTE `.exe` (ZCode's `ZCode.exe` node driver, or
        // a real node.exe) spawns DIRECTLY: no cmd.exe round-trip, so spaced
        // install paths (`C:\Program Files\ZCode\ZCode.exe`) work untouched
        // and every argv element passes verbatim — no quoting games. Only
        // the BIN is quoted on the shell path (the `main` baseline);
        // per-element quoting (quoteWindowsArg) applies solely to zcode's
        // `.cmd`-shim corner, where the spaced `zcode.cjs` path must survive
        // cmd.exe's whitespace split. (The cli mirror deliberately differs
        // here: it never quoted the bin on its generic shell path, so it
        // gates ALL quoting — bin included — on the zcode attach case.)
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
      // The bound model as resolved by the #41 binding (ZCode's stream emits
      // no model/session start meta of its own). Surfaced so the log panel
      // shows which model×level the turn was pinned to.
      if (boundModelMeta) {
        safeEnqueue({ type: "meta", key: "model", value: boundModelMeta });
      }

      child.stdin.on("error", () => {});
      try {
        // stdin-protocol agents read the prompt from stdin; argv / argv-message
        // agents already have it on the command line; argv-attach agents carry
        // it in the temp-file attachment — stdin stays empty for all three.
        if (!promptViaArgv && !promptViaMessageFlag && !promptViaAttach) child.stdin.write(opts.prompt);
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
        cleanupArgvAttach();
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
        // argv-attach teardown: kill the Linux mount holder and remove the
        // prompt temp dir (no-op for every other agent).
        cleanupArgvAttach();
        safeEnqueue({ type: "done", code });
        safeClose();
      });

      const onAbort = () => {
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
      // (mount holder + prompt temp file); the child itself is governed by
      // the abort signal — unchanged generic behavior.
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
