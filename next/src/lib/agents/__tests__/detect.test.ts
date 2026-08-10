// @vitest-environment node
//
// Runtime detection tests stub process.env (ZCODE_BIN) and process.platform —
// the happy-dom default env provides a synthetic process that does not reflect
// stubs into the real process.env that resolveZcodeBin()/resolveOnPath() read.
// The node environment is correct for a discovery/PATH unit test and matches
// how cli runs the same seam (see invoke.test.ts).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn((_path?: string) => false),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock };
});

import {
  AGENTS,
  DEFAULT_MODEL,
  detectAgents,
  resolveZcodeBin,
  resolveZcodeNodeBin,
  type AgentDef,
  type AgentProtocol,
} from "../detect";

function findAgent(agents: ReturnType<typeof detectAgents>, id: string) {
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

describe("AgentProtocol type surface (T2)", () => {
  it("accepts \"app-server\" as a union member", () => {
    // Compile-time proof: if "app-server" is missing from the union this
    // assignment fails typecheck. The runtime echo keeps the test meaningful.
    const p: AgentProtocol = "app-server";
    expect(p).toBe("app-server");
  });

  it("AgentDef accepts optional binArgs?: string[]", () => {
    const withBinArgs: AgentDef = {
      id: "type-probe",
      label: "Type Probe",
      bin: "type-probe",
      vendor: "probe",
      protocol: "app-server",
      binArgs: ["<resolved-cjs-path>", "app-server"],
      fallbackModels: [DEFAULT_MODEL],
    };
    expect(withBinArgs.binArgs).toEqual(["<resolved-cjs-path>", "app-server"]);
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
    expect(AGENTS.find((a) => a.id === "zcode")?.binArgs).toEqual([
      "<resolved-zcode-cjs>",
      "app-server",
    ]);
  });

  it("detectAgents still surfaces the existing protocol set", () => {
    // Regression guard: the new "app-server" union member must not flip the
    // unsupported flag for any of the protocols already in use.
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
    // the dedicated resolveZcodeNodeBin cases below.
    expect(typeof zcode.resolvedBin).toBe("string");
    expect((zcode.resolvedBin ?? "").length).toBeGreaterThan(0);
    expect(zcode.protocol).toBe("app-server");
    // app-server IS implemented (T6) — must not be flagged unsupported
    // (unlike the acp/pi-rpc family).
    expect(zcode.unsupported).toBeUndefined();
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

  // T12 (#12): detection reports the ACTUAL node driver when one resolves, not
  // just the literal "node". On a clean host where only the ZCode Electron exe
  // exists, resolvedBin must point at it — reconciling the detection layer
  // with the invoke layer's resolveZcodeNodeBin() (no conflicting assumption
  // that detect says "node" while invoke spawns ZCode.exe).
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

  // ADR-0004 / #13 Q1: fallbackModels for the ZCode picker come from the
  // AgentDef.fallbackModels static floor ([DEFAULT_MODEL]), NOT from a read
  // of ~/.zcode/v2/model-providers.json. The child self-authenticates and
  // resolves its own model, so the picker only needs "Default (CLI config)".
  // zcodeModels() is deleted; the app-server branch uses a.fallbackModels
  // verbatim, like every other agent.
  it("picker models are the static [DEFAULT_MODEL] floor (no config read)", () => {
    vi.stubEnv("ZCODE_BIN", "/opt/zcode/zcode.cjs");
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === "/opt/zcode/zcode.cjs");

    const agents = detectAgents();
    const zcode = findAgent(agents, "zcode");

    expect(zcode.available).toBe(true);
    expect(zcode.models).toEqual([DEFAULT_MODEL]);
  });

  it("resolveZcodeBin() honours ZCODE_BIN override", () => {
    // Sanity-check the discovery function the detect branch depends on, so a
    // regression in resolveZcodeBin surfaces here rather than as a confusing
    // available=false in the test above.
    vi.stubEnv("ZCODE_BIN", "/custom/zcode.cjs");
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === "/custom/zcode.cjs");

    expect(resolveZcodeBin()).toBe("/custom/zcode.cjs");
  });
});

// T12: resolve the node binary that drives `node <zcode.cjs> app-server` for
// an EXTERNAL caller. html-anything is an external process; on a clean Windows
// host `where node` finds nothing (only ZCode.exe exists). resolveZcodeBin()
// locates the .cjs bundle; this layer locates the NODE the .cjs runs under.
// Strategy (live-proven, not guessed): prefer real node on PATH; fall back to
// the ZCode Electron executable (ZCode.exe / ZCode / AppImage) driven under
// ELECTRON_RUN_AS_NODE=1 by the spawn branch (#11). A live spawn of
// `ZCode.exe <zcode.cjs> app-server` with ELECTRON_RUN_AS_NODE=1 booted and
// answered JSON-RPC on this host — no separate node.exe ships in the tree.
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
    const dir = "/opt/realnode";
    const expected = join(dir, "node");
    vi.stubEnv("PATH", dir);
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === expected || p === "/opt/zcode/ZCode");

    expect(resolveZcodeNodeBin()).toBe(expected);
  });

  it("Windows: falls back to ZCode.exe next to the resolved .cjs install", () => {
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
    stubPlatform("linux");
    const expected = `${homedir()}/Applications/ZCode.AppImage`;
    existsSyncMock.mockImplementation((p) => p === expected);

    expect(resolveZcodeNodeBin()).toBe(expected);
  });

  // T15 (#18 / ADR-0005 decision 3): the Electron-exe fallback is the TERMINAL
  // step of the probe chain. detectAgents() reports zcode available only when
  // zcode.cjs was found ⟺ ZCode is installed ⟺ the sibling Electron exe
  // exists, so any caller reaching this code sees a hit here. The return type
  // is therefore `string` (not `string | null`); this case pins that the
  // fallback yields a non-empty path, and the type itself is the compile-time
  // proof the old null outcome is gone.
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
