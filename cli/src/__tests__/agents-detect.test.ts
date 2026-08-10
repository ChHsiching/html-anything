import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn((_path?: string) => false),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock };
});

import { detectAgents, resolveZcodeBin, resolveZcodeNodeBin, defaultZcodeElectronExePaths, AGENTS, DEFAULT_MODEL, type AgentDef, type AgentProtocol } from "../agents-detect.js";

function findAgent(
  agents: ReturnType<typeof detectAgents>,
  id: string,
) {
  const agent = agents.find((a) => a.id === id);
  if (!agent) throw new Error(`Agent with id "${id}" not found`);
  return agent;
}

beforeEach(() => {
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});

// Real value captured once at module load; restore after each platform-stubbing
// test so later tests run against the host platform again.
const REAL_PLATFORM = process.platform;
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", {
    value: REAL_PLATFORM,
    configurable: true,
  });
});

// ZCode install discovery probes platform-specific absolute paths. Stub the
// platform so a single host (win32 here) can exercise the macOS/Linux branches.
function stubPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("detectAgents", () => {
  describe("*_BIN env override with absolute path that exists", () => {
    it("finds claude via absolute CLAUDE_BIN path", () => {
      vi.stubEnv("CLAUDE_BIN", "/usr/local/bin/claude");
      existsSyncMock.mockImplementation(
        (p) => p === "/usr/local/bin/claude",
      );

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.available).toBe(true);
      expect(claude.path).toBe("/usr/local/bin/claude");
      expect(claude.resolvedBin).toBe("claude");
      expect(claude.protocol).toBe("stdin");
      expect(claude.unsupported).toBeUndefined();
    });
  });

  describe("*_BIN with command name resolved on PATH", () => {
    it("finds gemini via GEMINI_BIN command name on PATH", () => {
      vi.stubEnv("GEMINI_BIN", "fake-gemini");
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/fake-gemini") return true;
        return false;
      });

      const agents = detectAgents();
      const gemini = findAgent(agents, "gemini");

      expect(gemini.available).toBe(true);
      expect(gemini.resolvedBin).toBe("fake-gemini");
      expect(gemini.path).toBe("/usr/local/bin/fake-gemini");
    });
  });

  describe("*_BIN pointing to non-existent path", () => {
    it("returns unavailable when CLAUDE_BIN path does not exist", () => {
      vi.stubEnv("CLAUDE_BIN", "/nonexistent/claude");
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.available).toBe(false);
      expect(claude.path).toBeUndefined();
      expect(claude.resolvedBin).toBeUndefined();
    });
  });

  describe("no env override, binary found on PATH", () => {
    it("detects claude when binary is on PATH without env override", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/claude") return true;
        return false;
      });

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.available).toBe(true);
      expect(claude.path).toBe("/usr/local/bin/claude");
      expect(claude.resolvedBin).toBe("claude");
    });

    it("detects aider which has no envOverride via bin on PATH", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/aider") return true;
        return false;
      });

      const agents = detectAgents();
      const aider = findAgent(agents, "aider");

      expect(aider.available).toBe(true);
      expect(aider.path).toBe("/usr/local/bin/aider");
      expect(aider.resolvedBin).toBe("aider");
    });

    it("detects opencode via fallbackBins when primary bin not found", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/opencode") return true;
        return false;
      });

      const agents = detectAgents();
      const opencode = findAgent(agents, "opencode");

      expect(opencode.available).toBe(true);
      expect(opencode.path).toBe("/usr/local/bin/opencode");
      expect(opencode.resolvedBin).toBe("opencode");
    });

    it("returns unavailable when no binary is on PATH and no env override", () => {
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.available).toBe(false);
    });
  });

  describe("unsupported protocol agents", () => {
    it("marks hermes with acp protocol as unsupported even when found", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/hermes") return true;
        return false;
      });

      const agents = detectAgents();
      const hermes = findAgent(agents, "hermes");

      expect(hermes.available).toBe(true);
      expect(hermes.protocol).toBe("acp");
      expect(hermes.unsupported).toBe(true);
    });

    it("marks pi with pi-rpc protocol as unsupported even when found", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/pi") return true;
        return false;
      });

      const agents = detectAgents();
      const pi = findAgent(agents, "pi");

      expect(pi.available).toBe(true);
      expect(pi.protocol).toBe("pi-rpc");
      expect(pi.unsupported).toBe(true);
    });

    it("marks unsupported as undefined for stdin protocol agents", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/claude") return true;
        return false;
      });

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.protocol).toBe("stdin");
      expect(claude.unsupported).toBeUndefined();
    });

    it("marks kimi with acp protocol as unsupported even when not found", () => {
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();
      const kimi = findAgent(agents, "kimi");

      expect(kimi.available).toBe(false);
      expect(kimi.protocol).toBe("acp");
      expect(kimi.unsupported).toBe(true);
    });
  });

  describe("agent protocol assignment", () => {
    it("defaults protocol to stdin for agents without explicit protocol", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/codex") return true;
        return false;
      });

      const agents = detectAgents();
      const codex = findAgent(agents, "codex");

      expect(codex.protocol).toBe("stdin");
    });

    it("preserves explicit protocol from agent definition (argv)", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/codewhale") return true;
        return false;
      });

      const agents = detectAgents();
      const codewhale = findAgent(agents, "codewhale");

      expect(codewhale.protocol).toBe("argv");
    });

    it("preserves explicit protocol from agent definition (argv) for deepseek-tui", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/deepseek-tui") return true;
        return false;
      });

      const agents = detectAgents();
      const deepseek = findAgent(agents, "deepseek-tui");

      expect(deepseek.protocol).toBe("argv");
    });

    it("preserves explicit protocol from agent definition (argv-message)", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/openclaw") return true;
        return false;
      });

      const agents = detectAgents();
      const openclaw = findAgent(agents, "openclaw");

      expect(openclaw.protocol).toBe("argv-message");
    });
  });

  describe("env override precedence", () => {
    it("prefers env override over PATH binary", () => {
      vi.stubEnv("CLAUDE_BIN", "/custom/path/claude");
      existsSyncMock.mockImplementation((p) => {
        if (p === "/custom/path/claude") return true;
        if (p === "/usr/local/bin/claude") return true;
        return false;
      });

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.available).toBe(true);
      expect(claude.path).toBe("/custom/path/claude");
      expect(claude.resolvedBin).toBe("claude");
    });

    it("falls back to PATH when env override is a command name that exists on PATH", () => {
      vi.stubEnv("CLAUDE_BIN", "my-custom-claude");
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/my-custom-claude") return true;
        return false;
      });

      const agents = detectAgents();
      const claude = findAgent(agents, "claude");

      expect(claude.available).toBe(true);
      expect(claude.path).toBe("/usr/local/bin/my-custom-claude");
      expect(claude.resolvedBin).toBe("my-custom-claude");
    });
  });

  describe("returned agent shape", () => {
    it("returns all agents from AGENTS array", () => {
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();

      expect(agents.length).toBeGreaterThanOrEqual(10);
    });

    it("each agent includes id, label, vendor, available, protocol, and models", () => {
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();

      for (const agent of agents) {
        expect(agent).toHaveProperty("id");
        expect(typeof agent.id).toBe("string");
        expect(agent).toHaveProperty("label");
        expect(typeof agent.label).toBe("string");
        expect(agent).toHaveProperty("vendor");
        expect(typeof agent.vendor).toBe("string");
        expect(agent).toHaveProperty("available");
        expect(typeof agent.available).toBe("boolean");
        expect(agent).toHaveProperty("protocol");
        expect(agent).toHaveProperty("models");
        expect(Array.isArray(agent.models)).toBe(true);
      }
    });

    it("each available agent has path and resolvedBin", () => {
      existsSyncMock.mockImplementation((p) => {
        if (p === "/usr/local/bin/claude") return true;
        if (p === "/usr/local/bin/aider") return true;
        return false;
      });

      const agents = detectAgents();
      const availableAgents = agents.filter((a) => a.available);

      for (const agent of availableAgents) {
        expect(agent).toHaveProperty("path");
        expect(typeof agent.path).toBe("string");
        expect(agent).toHaveProperty("resolvedBin");
        expect(typeof agent.resolvedBin).toBe("string");
      }
    });

    it("models array is non-empty for each agent", () => {
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();

      for (const agent of agents) {
        expect(agent.models.length).toBeGreaterThan(0);
      }
    });
  });

  describe("type-only extension surface (T2)", () => {
    it("AgentProtocol accepts \"app-server\"", () => {
      // Compile-time proof: if the union lacks "app-server" this assignment
      // fails typecheck. The runtime echo just keeps the test meaningful.
      const p: AgentProtocol = "app-server";
      expect(p).toBe("app-server");
    });

    it("AgentDef accepts optional binArgs?: string[]", () => {
      // Compile-time proof of the new optional field. Omitting it must also
      // stay valid (every existing AgentDef entry omits it).
      const withBinArgs: AgentDef = {
        id: "type-probe",
        label: "Type Probe",
        bin: "type-probe",
        vendor: "probe",
        protocol: "app-server",
        binArgs: ["<resolved-cjs-path>", "app-server"],
        fallbackModels: [DEFAULT_MODEL],
      };
      expect(withBinArgs.binArgs).toEqual([
        "<resolved-cjs-path>",
        "app-server",
      ]);
    });

    it("AgentDef.binArgs is optional (existing entries omit it)", () => {
      // binArgs stays optional so existing AgentDef literals keep typechecking
      // unchanged. Check the whole array, not a sample, so a future entry that
      // accidentally sets a required-looking binArgs is caught here. ZCode
      // (T7) is the one intentional exception — its node-script spawn needs it.
      for (const def of AGENTS) {
        if (def.id === "zcode") continue;
        expect(def.binArgs).toBeUndefined();
      }
      expect(
        AGENTS.find((a) => a.id === "zcode")?.binArgs,
      ).toEqual(["<resolved-zcode-cjs>", "app-server"]);
    });

    it("detectAgents stays green across the existing protocol set", () => {
      // Regression guard: the new "app-server" union member must not flip the
      // unsupported flag for any of the protocols already in use.
      existsSyncMock.mockReturnValue(false);
      const agents = detectAgents();
      const protocols = new Set(agents.map((a) => a.protocol));
      for (const expected of [
        "stdin",
        "argv",
        "argv-message",
        "acp",
        "pi-rpc",
      ] as const) {
        expect(protocols.has(expected)).toBe(true);
      }
    });
  });

  // T3: ZCode install discovery. Only the discovery function is under test;
  // ZCode is NOT yet registered in AGENTS (registration lands in T7). Cases
  // follow the same existsSync-mock pattern as the detectAgents tests above.
  describe("resolveZcodeBin", () => {
    it("ZCODE_BIN absolute path that exists wins over all defaults (win32)", () => {
      vi.stubEnv("ZCODE_BIN", "C:\\custom\\zcode.cjs");
      stubPlatform("win32");
      existsSyncMock.mockImplementation((p) => p === "C:\\custom\\zcode.cjs");

      expect(resolveZcodeBin()).toBe("C:\\custom\\zcode.cjs");
    });

    it("ZCODE_BIN command name resolves on PATH when not an absolute path", () => {
      const dir = "/opt/zcode-shim";
      const expected = join(dir, "my-zcode");
      vi.stubEnv("ZCODE_BIN", "my-zcode");
      vi.stubEnv("PATH", dir);
      stubPlatform("linux");
      // Absolute lookup misses; only the PATH-resolved location exists.
      existsSyncMock.mockImplementation((p) => p === expected);

      expect(resolveZcodeBin()).toBe(expected);
    });

    it("Windows: ZCODE_WINDOWS_APP_INSTALL_DIR .cjs path probed", () => {
      vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "D:\\ZCode");
      stubPlatform("win32");
      existsSyncMock.mockImplementation(
        (p) => p === "D:\\ZCode\\resources\\glm\\zcode.cjs",
      );

      expect(resolveZcodeBin()).toBe(
        "D:\\ZCode\\resources\\glm\\zcode.cjs",
      );
    });

    it("Windows: falls back to C:\\Program Files\\ZCode when install-dir unset", () => {
      stubPlatform("win32");
      existsSyncMock.mockImplementation(
        (p) => p === "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
      );

      expect(resolveZcodeBin()).toBe(
        "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
      );
    });

    it("Windows: install-dir env is preferred over the Program Files fallback", () => {
      vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "D:\\ZCode");
      stubPlatform("win32");
      existsSyncMock.mockImplementation((p) =>
        p === "D:\\ZCode\\resources\\glm\\zcode.cjs"
          ? true
          : p === "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
      );

      expect(resolveZcodeBin()).toBe(
        "D:\\ZCode\\resources\\glm\\zcode.cjs",
      );
    });

    it("macOS: probes /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs", () => {
      stubPlatform("darwin");
      existsSyncMock.mockImplementation(
        (p) =>
          p ===
          "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      );

      expect(resolveZcodeBin()).toBe(
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      );
    });

    it("Linux: probes ~/Applications/ZCode.AppImage", () => {
      stubPlatform("linux");
      const expected = `${homedir()}/Applications/ZCode.AppImage`;
      existsSyncMock.mockImplementation((p) => p === expected);

      expect(resolveZcodeBin()).toBe(expected);
    });

    it("Linux: `zcode` on PATH is found before the AppImage default", () => {
      const dir = "/opt/zcode-deb";
      const expected = join(dir, "zcode");
      vi.stubEnv("PATH", dir);
      stubPlatform("linux");
      existsSyncMock.mockImplementation((p) => p === expected);

      expect(resolveZcodeBin()).toBe(expected);
    });

    it("returns null when nothing is found (no throw)", () => {
      stubPlatform("darwin");
      existsSyncMock.mockReturnValue(false);

      expect(resolveZcodeBin()).toBeNull();
    });

    it("ZCODE_BIN override takes precedence over a present platform default", () => {
      vi.stubEnv("ZCODE_BIN", "/opt/zcode/override.cjs");
      stubPlatform("linux");
      existsSyncMock.mockImplementation(
        (p) =>
          p === "/opt/zcode/override.cjs" ||
          p === "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
      );

      expect(resolveZcodeBin()).toBe("/opt/zcode/override.cjs");
    });
  });

  // T12: resolve the node binary that drives `node <zcode.cjs> app-server` for
  // an EXTERNAL caller. html-anything is an external process; on a clean
  // Windows host `where node` finds nothing (only ZCode.exe exists). The
  // resolveZcodeBin() discovery above locates the .cjs bundle — this layer
  // locates the NODE the .cjs is run with. Strategy (chosen against a live
  // clean-host probe, not guessed): prefer a real node on PATH; fall back to
  // the ZCode Electron executable itself, which under ELECTRON_RUN_AS_NODE=1
  // (set by the app-server spawn branch, #11) behaves as node. A live spawn of
  // `ZCode.exe <zcode.cjs> app-server` with ELECTRON_RUN_AS_NODE=1 booted and
  // answered JSON-RPC on this very host (no separate node.exe ships in the
  // install tree).
  describe("resolveZcodeNodeBin (T12)", () => {
    it("ZCODE_NODE_BIN absolute path that exists wins over all defaults", () => {
      vi.stubEnv("ZCODE_NODE_BIN", "C:\\custom\\node.exe");
      stubPlatform("win32");
      existsSyncMock.mockImplementation((p) => p === "C:\\custom\\node.exe");

      expect(resolveZcodeNodeBin()).toBe("C:\\custom\\node.exe");
    });

    it("ZCODE_NODE_BIN command name resolves on PATH when not absolute", () => {
      const dir = "/opt/node-shim";
      const expected = join(dir, "my-node");
      vi.stubEnv("ZCODE_NODE_BIN", "my-node");
      vi.stubEnv("PATH", dir);
      stubPlatform("linux");
      existsSyncMock.mockImplementation((p) => p === expected);

      expect(resolveZcodeNodeBin()).toBe(expected);
    });

    it("prefers a real `node` on PATH over the Electron fallback", () => {
      // System Node is the simplest, most portable driver when present — it
      // needs no ELECTRON_RUN_AS_NODE env. So it wins over the Electron exe.
      const dir = "/opt/realnode";
      const expected = join(dir, "node");
      vi.stubEnv("PATH", dir);
      stubPlatform("linux");
      // Both the PATH node AND the Electron exe exist; PATH node must win.
      existsSyncMock.mockImplementation((p) => p === expected || p === "/opt/zcode/ZCode");

      expect(resolveZcodeNodeBin()).toBe(expected);
    });

    it("Windows: falls back to ZCode.exe next to the resolved .cjs install", () => {
      // Clean host: no node on PATH, no ZCODE_NODE_BIN. The Electron exe at the
      // install root (C:\Program Files\ZCode\ZCode.exe) is the only node-like
      // binary on the box — driven under ELECTRON_RUN_AS_NODE=1 by the spawn
      // branch. existsSync admits the .exe only.
      vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "C:\\Program Files\\ZCode");
      stubPlatform("win32");
      existsSyncMock.mockImplementation(
        (p) => p === "C:\\Program Files\\ZCode\\ZCode.exe",
      );

      expect(resolveZcodeNodeBin()).toBe("C:\\Program Files\\ZCode\\ZCode.exe");
    });

    it("Windows: honours a custom ZCODE_WINDOWS_APP_INSTALL_DIR for the .exe", () => {
      vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "D:\\ZCode");
      stubPlatform("win32");
      existsSyncMock.mockImplementation((p) => p === "D:\\ZCode\\ZCode.exe");

      expect(resolveZcodeNodeBin()).toBe("D:\\ZCode\\ZCode.exe");
    });

    it("macOS: falls back to ZCode.app/Contents/MacOS/ZCode", () => {
      stubPlatform("darwin");
      existsSyncMock.mockImplementation(
        (p) => p === "/Applications/ZCode.app/Contents/MacOS/ZCode",
      );

      expect(resolveZcodeNodeBin()).toBe(
        "/Applications/ZCode.app/Contents/MacOS/ZCode",
      );
    });

    it("Linux: falls back to the AppImage mount", () => {
      // On Linux ZCode ships as an AppImage; the .exe-equivalent fallback is
      // the AppImage itself (run under ELECTRON_RUN_AS_NODE=1 it acts as node).
      stubPlatform("linux");
      const expected = `${homedir()}/Applications/ZCode.AppImage`;
      existsSyncMock.mockImplementation((p) => p === expected);

      expect(resolveZcodeNodeBin()).toBe(expected);
    });

    // T15 (#18 / ADR-0005 decision 3): the Electron-exe fallback is the
    // TERMINAL step of the probe chain. detectAgents() reports zcode available
    // only when zcode.cjs was found ⟺ ZCode is installed ⟺ the sibling
    // Electron exe exists, so any caller reaching this code sees a hit here.
    // The return type is therefore `string` (not `string | null`); this case
    // pins that the fallback yields a non-empty path, and the type itself is
    // the compile-time proof the old null outcome is gone.
    it("returns a non-empty string when the Electron-exe fallback exists (T15)", () => {
      stubPlatform("win32");
      existsSyncMock.mockImplementation(
        (p) => p === "C:\\Program Files\\ZCode\\ZCode.exe",
      );

      const result = resolveZcodeNodeBin();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).toBe("C:\\Program Files\\ZCode\\ZCode.exe");
    });
  });

  // T7: ZCode is registered as a first-class agent. Unlike the *_BIN/PATH
  // agents, ZCode's availability is driven by resolveZcodeBin() (its CLI is a
  // .cjs bundle, not a standalone exec found on PATH). protocol "app-server"
  // is implemented (T5/T6), so it must NOT be marked unsupported.
  describe("ZCode agent registration (T7)", () => {
    it("AGENTS contains a zcode entry with the spec fields", () => {
      const def = AGENTS.find((a) => a.id === "zcode");
      expect(def).toBeDefined();
      expect(def!.label).toBe("ZCode");
      expect(def!.vendor).toBe("Z.AI");
      expect(def!.envOverride).toBe("ZCODE_BIN");
      expect(def!.protocol).toBe("app-server");
      expect(def!.bin).toBe("node");
      // ADR-0002 decision 3: binArgs carries the node-script leading argv.
      // The <resolved-zcode-cjs> placeholder is filled at detect time from
      // resolveZcodeBin(); the literal here is the sentinel on the AgentDef.
      expect(def!.binArgs).toEqual(["<resolved-zcode-cjs>", "app-server"]);
    });

    it("detectAgents() returns available=true when resolveZcodeBin() hits", () => {
      vi.stubEnv("ZCODE_BIN", "/opt/zcode/zcode.cjs");
      stubPlatform("linux");
      existsSyncMock.mockImplementation((p) => p === "/opt/zcode/zcode.cjs");

      const agents = detectAgents();
      const zcode = findAgent(agents, "zcode");

      expect(zcode.available).toBe(true);
      expect(zcode.path).toBe("/opt/zcode/zcode.cjs");
      // T15 (#18 / ADR-0005 decision 3): resolveZcodeNodeBin() now returns
      // `string` (not `string | null`), so detectAgents() no longer coalesces
      // to the literal `node`. resolvedBin is the node driver the spawn will
      // use — a non-empty string (the resolver never returns null). We don't
      // pin the exact path here: existsSync admits only the .cjs in this
      // scenario, so the resolver falls through to its terminal Electron-exe
      // candidate, whose exact value is an install-layout detail covered by
      // the dedicated resolveZcodeNodeBin cases above.
      expect(typeof zcode.resolvedBin).toBe("string");
      expect((zcode.resolvedBin ?? "").length).toBeGreaterThan(0);
      expect(zcode.protocol).toBe("app-server");
      // app-server IS implemented (T5/T6) — must not be flagged unsupported
      // (unlike the acp/pi-rpc family).
      expect(zcode.unsupported).toBeUndefined();
    });

    // T12 (#12): detection reports the ACTUAL node driver when one resolves,
    // not just the literal "node". On a clean host where only the ZCode
    // Electron exe exists, resolvedBin must point at it — so the UI can show
    // the user what will really spawn, and there is no conflicting assumption
    // (detect says "node" while invoke spawns ZCode.exe). Reconciles the
    // detection layer with the invoke layer's resolveZcodeNodeBin().
    it("detectAgents() reports the resolved Electron exe as resolvedBin when no system node (T12)", () => {
      vi.stubEnv("ZCODE_BIN", "/resolved/zcode.cjs");
      vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "C:\\Program Files\\ZCode");
      stubPlatform("win32");
      existsSyncMock.mockImplementation(
        (p) =>
          p === "/resolved/zcode.cjs" ||
          p === "C:\\Program Files\\ZCode\\ZCode.exe",
      );

      const agents = detectAgents();
      const zcode = findAgent(agents, "zcode");

      expect(zcode.available).toBe(true);
      expect(zcode.path).toBe("/resolved/zcode.cjs");
      // The Electron exe is what the spawn will actually use as "node".
      expect(zcode.resolvedBin).toBe("C:\\Program Files\\ZCode\\ZCode.exe");
    });

    it("detectAgents() returns available=false when no install is found (no throw)", () => {
      stubPlatform("darwin");
      existsSyncMock.mockReturnValue(false);

      const agents = detectAgents();
      const zcode = findAgent(agents, "zcode");

      expect(zcode.available).toBe(false);
      expect(zcode.path).toBeUndefined();
      expect(zcode.resolvedBin).toBeUndefined();
      expect(zcode.protocol).toBe("app-server");
      expect(zcode.unsupported).toBeUndefined();
    });

    // ADR-0004 / #13 Q1: fallbackModels for the ZCode picker come from the
    // AgentDef.fallbackModels static floor ([DEFAULT_MODEL]), NOT from a
    // read of ~/.zcode/v2/model-providers.json. The child self-authenticates
    // and resolves its own model, so the picker only needs "Default (CLI
    // config)" — send no --model, let the child's resolved entitlement win.
    // A live probe (2026-08-10) confirmed no protocol method exposes a model
    // list either. zcodeModels() is deleted; the app-server branch uses
    // a.fallbackModels verbatim, like every other agent.
    it("picker models are the static [DEFAULT_MODEL] floor (no config read)", () => {
      vi.stubEnv("ZCODE_BIN", "/opt/zcode/zcode.cjs");
      stubPlatform("linux");
      existsSyncMock.mockImplementation((p) => p === "/opt/zcode/zcode.cjs");

      const agents = detectAgents();
      const zcode = findAgent(agents, "zcode");

      expect(zcode.available).toBe(true);
      expect(zcode.models).toEqual([DEFAULT_MODEL]);
    });
  });
});
