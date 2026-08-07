// @vitest-environment node
//
// Runtime detection tests stub process.env (ZCODE_BIN) and process.platform —
// the happy-dom default env provides a synthetic process that does not reflect
// stubs into the real process.env that resolveZcodeBin()/resolveOnPath() read.
// The node environment is correct for a discovery/PATH unit test and matches
// how cli runs the same seam (see invoke.test.ts).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { existsSyncMock, readZcodeConfigMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn((_path?: string) => false),
  readZcodeConfigMock: vi.fn((): unknown => null),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock };
});

// ZCode's fallbackModels come from the saved provider config (T1). The detect
// module reads it via @html-anything/zcode-protocol/zcode-config; mock it here
// so tests can drive the "saved config present" vs "absent" branches without
// touching the real ~/.zcode/v2 store.
vi.mock("@html-anything/zcode-protocol/zcode-config", () => ({
  readZcodeConfig: readZcodeConfigMock,
}));

import {
  AGENTS,
  DEFAULT_MODEL,
  detectAgents,
  resolveZcodeBin,
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
  readZcodeConfigMock.mockReset();
  readZcodeConfigMock.mockReturnValue(null);
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
    // Spawned as `node <cjs> app-server`: resolvedBin is the node bin.
    expect(zcode.resolvedBin).toBe("node");
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

  it("fallbackModels start with DEFAULT_MODEL and append the saved provider's models", () => {
    // ZCode must be available for the saved provider's models to be read
    // (the config read is gated on availability). Stub the install.
    vi.stubEnv("ZCODE_BIN", "/opt/zcode/zcode.cjs");
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === "/opt/zcode/zcode.cjs");
    // Saved provider config present: models are surfaced in the picker.
    readZcodeConfigMock.mockReturnValue({
      provider: "builtin:zai",
      model: "glm-5-plus",
      models: ["glm-5-plus", "glm-5-air", "glm-5-flash"],
    });

    const agents = detectAgents();
    const zcode = findAgent(agents, "zcode");

    expect(zcode.models).toEqual([
      DEFAULT_MODEL,
      { id: "glm-5-plus", label: "glm-5-plus" },
      { id: "glm-5-air", label: "glm-5-air" },
      { id: "glm-5-flash", label: "glm-5-flash" },
    ]);
  });

  it("fallbackModels fall back to [DEFAULT_MODEL] when no saved provider", () => {
    // Available install but no ~/.zcode/v2 store — DEFAULT_MODEL (let the
    // CLI pick) is the only entry.
    vi.stubEnv("ZCODE_BIN", "/opt/zcode/zcode.cjs");
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === "/opt/zcode/zcode.cjs");
    readZcodeConfigMock.mockReturnValue(null);

    const agents = detectAgents();
    const zcode = findAgent(agents, "zcode");

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
