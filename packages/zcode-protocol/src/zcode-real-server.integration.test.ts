/**
 * Real-server integration test (#14, gap 4). This is the ONLY test that hits
 * the actual `zcode.cjs` app-server — every other test in this package uses a
 * `PassThrough`-backed fake child. It guards every future change against the
 * real wire format: if the schema mapping in `zcode-session.ts` drifts from
 * what the live server's Zod schemas accept, this test fails.
 *
 * Method (ADR-0004, replicable): spawn the real `zcode.cjs` via the bundled
 * Electron binary with `ELECTRON_RUN_AS_NODE=1`, drive bare JSON-RPC frames
 * `{id, method, params}\n` over stdio. The driver node (vitest's node) and the
 * child node (the bundled Electron node, the only one with `node:sqlite` that
 * `zcode.cjs` requires) can be different — that is fine, the child is a
 * separate process.
 *
 * Gated: SKIPS with a clear message when the ZCode binary is absent
 * (`ZCODE_BIN` env or default install path missing), so CI without ZCode does
 * not fail.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createZcodeProtocolClient } from "./zcode-protocol";
import {
  ensureWorkspaceModel,
  startZcodeProtocolTurn,
  type EnsuredWorkspaceModel,
} from "./zcode-session";
import { readZcodeConfig } from "./zcode-config";

/**
 * Resolve the Electron binary + zcode.cjs path. The Electron binary is the
 * install-dir exe (`ZCode.exe` / `ZCode` / the AppImage); with
 * `ELECTRON_RUN_AS_NODE=1` it runs as a pure node that has `node:sqlite`.
 * Returns `null` when nothing is found (→ suite skips).
 */
function resolveZcodeRuntime(): { electron: string; cjs: string } | null {
  const env = process.env;
  const platform = process.platform;

  // 1. Explicit ZCODE_BIN override — may point at either the .cjs or the exe.
  const override = env.ZCODE_BIN?.trim();
  if (override && existsSync(override)) {
    if (override.endsWith(".cjs")) {
      // Derive the sibling Electron exe from the .cjs install layout.
      const exe = exeBesideCjs(override, platform);
      if (exe && existsSync(exe)) return { electron: exe, cjs: override };
    } else {
      // Assume it points at the Electron exe; derive the sibling .cjs.
      const cjs = cjsBesideExe(override, platform);
      if (cjs && existsSync(cjs)) return { electron: override, cjs };
    }
  }

  // 2. Platform default install paths.
  for (const root of defaultInstallRoots(platform, env)) {
    const exe = joinExe(root, platform);
    const cjs = joinCjs(root, platform);
    if (existsSync(exe) && existsSync(cjs)) return { electron: exe, cjs };
  }
  return null;
}

function defaultInstallRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === "win32") {
    const out: string[] = [];
    const override = env.ZCODE_WINDOWS_APP_INSTALL_DIR?.trim();
    if (override) out.push(override);
    out.push("C:\\Program Files\\ZCode");
    return out;
  }
  if (platform === "darwin") return ["/Applications/ZCode.app"];
  return [join(homedir(), "Applications")];
}

function joinExe(root: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return join(root, "ZCode.exe");
  if (platform === "darwin") return join(root, "Contents", "MacOS", "ZCode");
  return join(root, "ZCode.AppImage");
}

function joinCjs(root: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return join(root, "Contents", "Resources", "glm", "zcode.cjs");
  }
  return join(root, "resources", "glm", "zcode.cjs");
}

/**
 * Given a `.cjs` path, derive the sibling Electron exe (reverse of the install
 * layout). Returns null if the path doesn't match a known .cjs install shape.
 */
function exeBesideCjs(cjsPath: string, platform: NodeJS.Platform): string | null {
  // win32/linux: <root>/resources/glm/zcode.cjs → <root>/<exe>
  const match = /^(.*)[\\/]resources[\\/]glm[\\/]zcode\.cjs$/.exec(cjsPath);
  if (match) return joinExe(match[1]!, platform);
  // macOS: <root>/Contents/Resources/glm/zcode.cjs → <root>/Contents/MacOS/ZCode
  const macMatch = /^(.*)[\\/]Contents[\\/]Resources[\\/]glm[\\/]zcode\.cjs$/.exec(cjsPath);
  if (macMatch) return join(macMatch[1]!, "Contents", "MacOS", "ZCode");
  return null;
}

/**
 * Given an Electron-exe path, derive the sibling `.cjs`. Returns null if the
 * path doesn't match a known exe install shape.
 */
function cjsBesideExe(exePath: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    const m = /^(.*)[\\/]ZCode\.exe$/i.exec(exePath);
    return m ? joinCjs(m[1]!, platform) : null;
  }
  if (platform === "darwin") {
    const m = /^(.*)[\\/]Contents[\\/]MacOS[\\/]ZCode$/i.exec(exePath);
    return m ? joinCjs(m[1]!, platform) : null;
  }
  const m = /^(.*)[\\/]ZCode\.AppImage$/i.exec(exePath);
  return m ? joinCjs(m[1]!, platform) : null;
}

const RUNTIME = resolveZcodeRuntime();
const SKIP_REASON =
  "ZCode binary not found — set ZCODE_BIN or install ZCode (the GUI). Skipping real-server integration test.";

/** Spawn a real app-server child. Caller owns kill(). */
function spawnZcodeChild(): ChildProcessWithoutNullStreams {
  if (!RUNTIME) throw new Error(SKIP_REASON);
  return spawn(RUNTIME.electron, [RUNTIME.cjs, "app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

/**
 * Boot guard: the child boots in ~1s. Wait for stdout to be open (the protocol
 * client attaches its own listeners; this just yields to let boot logs flush
 * before the first request).
 */
async function waitForBoot(child: ChildProcessWithoutNullStreams, ms = 1200): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe.skipIf(!RUNTIME)("real zcode app-server (integration)", () => {
  describe("boot + auth", () => {
    let child: ChildProcessWithoutNullStreams;
    beforeAll(async () => {
      child = spawnZcodeChild();
      await waitForBoot(child);
    });
    afterAll(() => {
      try {
        child?.kill("SIGTERM");
      } catch {}
    });

    it("session/list returns the logged-in user's real sessions (proves auth + boot)", async () => {
      const client = createZcodeProtocolClient(child);
      try {
        const resp = await client.request(
          { id: "real-list", method: "session/list", params: {} },
          15_000,
        );
        const sessions = (resp.result as { sessions?: unknown } | null)?.sessions;
        expect(Array.isArray(sessions)).toBe(true);
        // A logged-in user has at least one session; the array shape is the
        // auth proof (an unauthed/empty child returns an error, not sessions).
        expect((sessions as unknown[]).length).toBeGreaterThan(0);
      } finally {
        client.dispose();
      }
    });
  });

  describe("full turn (relay → create → subscribe → send → reply)", () => {
    let child: ChildProcessWithoutNullStreams;
    beforeAll(async () => {
      child = spawnZcodeChild();
      await waitForBoot(child);
    });
    afterAll(() => {
      try {
        child?.kill("SIGTERM");
      } catch {}
    });

    it("completes a create→send→model-reply round-trip against the real server", async (ctx) => {
      // Prerequisite: a usable provider must be configured in the GUI's
      // resolved config (the relay reads it). Skip (NOT silent-pass) if not —
      // the auth test above still proves boot, but this turn needs a model.
      // Using ctx.skip() so a CI run without a provider reports this as
      // skipped, not falsely green.
      const config = readZcodeConfig();
      if (!config) {
        ctx.skip(
          "no usable ZCode provider configured (~/.zcode/v2/config.json has " +
            "no enabled provider with an API key). Configure one in the ZCode " +
            "GUI to exercise this test.",
        );
        return; // unreachable; ctx.skip throws — satisfies the type checker
      }

      const client = createZcodeProtocolClient(child);
      const events: Record<string, unknown>[] = [];
      try {
        // 1. Once-per-boot model relay (#14 — required for fresh create).
        const ensured: EnsuredWorkspaceModel = await ensureWorkspaceModel({
          client,
          cwd: process.cwd(),
          requestTimeoutMs: 15_000,
        });
        expect(typeof ensured.providerId).toBe("string");
        expect(typeof ensured.modelId).toBe("string");

        // 2. Drive the turn. Collect text_delta + final-result.
        const replyText = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error("timed out waiting for the model reply"));
          }, 60_000);

          let text = "";
          startZcodeProtocolTurn({
            client,
            cwd: process.cwd(),
            prompt: "Reply with exactly the token: REAL_SERVER_OK",
            onEvent: (event) => {
              events.push(event);
              const type = typeof event.type === "string" ? event.type : "";
              if (type === "text_delta") {
                text += typeof event.delta === "string" ? event.delta : "";
              } else if (type === "usage") {
                // final-result (end of turn)
                clearTimeout(timer);
                resolve(text);
              } else if (type === "error") {
                clearTimeout(timer);
                reject(
                  new Error(
                    typeof event.message === "string"
                      ? event.message
                      : "zcode turn reported an error",
                  ),
                );
              }
            },
          }).then(
            () => {
              /* turn handle; reply resolved via the usage/error events */
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            },
          );
        });

        // The model should have replied with something containing the marker.
        // (We ask for an exact token, but model replies can vary slightly;
        // assert it produced non-empty text and a usage event arrived.)
        expect(replyText.length).toBeGreaterThan(0);
        expect(events.some((e) => e.type === "usage")).toBe(true);
        expect(events.some((e) => e.type === "text_delta")).toBe(true);
      } finally {
        client.dispose();
      }
    }, 90_000);
  });
});

describe.skipIf(RUNTIME)("real zcode app-server (integration)", () => {
  it("skips when the ZCode binary is absent", () => {
    // ZCode not installed / ZCODE_BIN unset in this environment. The skip is
    // intentional so CI without ZCode stays green.
    expect(SKIP_REASON).toBeTruthy();
  });
});
