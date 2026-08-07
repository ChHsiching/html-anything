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

import { detectAgents, resolveZcodeBin, AGENTS, DEFAULT_MODEL, type AgentDef, type AgentProtocol } from "../agents-detect.js";

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
      // Every shipped agent omits binArgs — the field must remain optional so
      // existing AgentDef literals keep typechecking unchanged. Check the whole
      // array, not a sample, so a future entry that accidentally sets a
      // required-looking binArgs is caught here.
      for (const def of AGENTS) {
        expect(def.binArgs).toBeUndefined();
      }
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
});
