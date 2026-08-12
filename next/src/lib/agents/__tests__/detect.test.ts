// @vitest-environment node
//
// Runtime detection tests stub process.env (ZCODE_BIN) and process.platform —
// the happy-dom default env provides a synthetic process that does not reflect
// stubs into the real process.env that resolveZcodeBin()/resolveOnPath() read.
// The node environment is correct for a discovery/PATH unit test and matches
// how cli runs the same seam (see invoke.test.ts).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join, posix } from "node:path";

const { existsSyncMock, readFileSyncMock, pickerModels, pickerDefault } = vi.hoisted(() => ({
  existsSyncMock: vi.fn((_path?: string) => false),
  // ADR-0007: discoverZcodeAppImage reads the XDG .desktop entry. Mocked so
  // the discover tests don't touch disk; the pure parser (parseZcodeDesktopExec)
  // is exercised separately with string fixtures.
  readFileSyncMock: vi.fn((_path?: string, _enc?: string) => ""),
  // #19: the dynamic ZCode picker models returned by readZcodeModelPicker.
  // Mirrors a live config with TWO enabled providers (one with 2 models, one
  // with 1) + disabled providers filtered out upstream by the reader.
  pickerModels: [
    { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel-coding-plan" },
    { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel-coding-plan" },
    { id: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", providerId: "builtin:openrouter" },
  ],
  pickerDefault: "GLM-5.2" as string | null,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock };
});

// #19 / ADR-0005 decision 4: detect reads the ZCode picker models from
// ~/.zcode/v2/config.json via the protocol package's reader. Mock it so the
// detect-layer tests don't touch disk; the reader itself (incl. the disabled
// provider filtering) is tested in the protocol package.
vi.mock("@html-anything/zcode-protocol/zcode-model-picker", () => ({
  readZcodeModelPicker: () => ({ models: pickerModels, defaultProviderId: "builtin:bigmodel-coding-plan", defaultModelId: pickerDefault }),
}));

import {
  AGENTS,
  DEFAULT_MODEL,
  defaultZcodeCjsPaths,
  defaultZcodeElectronExePaths,
  detectAgents,
  discoverZcodeAppImage,
  parseZcodeDesktopExec,
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
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue("");
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

  // #19 / ADR-0005 decision 4: the ZCode picker is populated DYNAMICALLY from
  // ~/.zcode/v2/config.json (the GUI's resolved config), NOT the static
  // [DEFAULT_MODEL] floor. Every `enabled` provider with no
  // systemDisabledReason contributes its models; DEFAULT_MODEL is prepended
  // (= no `model` field → workspace default). The mocked reader returns the
  // filtered set for a config with TWO enabled providers (one 2-model, one
  // 1-model) + disabled providers already excluded — so the picker must show
  // DEFAULT_MODEL + the 3 enabled models, with each non-default entry
  // carrying its providerId for the invoke-layer model resolution.
  it("picker models are dynamic from config.json: DEFAULT_MODEL + enabled providers' models", () => {
    vi.stubEnv("ZCODE_BIN", "/opt/zcode/zcode.cjs");
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === "/opt/zcode/zcode.cjs");

    const agents = detectAgents();
    const zcode = findAgent(agents, "zcode");

    expect(zcode.available).toBe(true);
    expect(zcode.models).toEqual([
      DEFAULT_MODEL,
      { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel-coding-plan" },
      { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel-coding-plan" },
      {
        id: "anthropic/claude-sonnet-4.5",
        label: "anthropic/claude-sonnet-4.5",
        providerId: "builtin:openrouter",
      },
    ]);
  });

  // When ZCode is NOT available (no install found), the picker still surfaces
  // the static [DEFAULT_MODEL] floor — the config read is gated on the same
  // availability as the rest of ZCode's detection, so an unavailable install
  // doesn't crash the picker with a spurious config read.
  it("picker falls back to [DEFAULT_MODEL] when ZCode is unavailable (config read gated)", () => {
    stubPlatform("darwin");
    existsSyncMock.mockReturnValue(false);

    const agents = detectAgents();
    const zcode = findAgent(agents, "zcode");

    expect(zcode.available).toBe(false);
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

// ADR-0007: on Linux ZCode ships as an AppImage — a single compressed file
// with zcode.cjs packed inside, unreachable without mounting. The adapter
// discovers the AppImage via the XDG .desktop entry ZCode writes on first GUI
// launch, NOT by guessing a version-less filename. The pure parser
// (parseZcodeDesktopExec) carries the parsing+validation logic; the discover
// function is a thin I/O glue over it. resolveZcodeBin / resolveZcodeNodeBin
// wire the discovery into the existing probe chain (step 3 on Linux).
describe("parseZcodeDesktopExec — .desktop Exec= parsing + validation (ADR-0007)", () => {
  it("extracts the AppImage path from a well-formed Exec= line", () => {
    const desktop = [
      "[Desktop Entry]",
      "Name=ZCode",
      "Exec=/home/user/Applications/ZCode-3.7.5-linux-x64.AppImage --no-sandbox %U",
      "Icon=zcode",
      "Type=Application",
    ].join("\n");
    expect(parseZcodeDesktopExec(desktop)).toBe(
      "/home/user/Applications/ZCode-3.7.5-linux-x64.AppImage",
    );
  });

  it("strips surrounding quotes a launcher might write", () => {
    const desktop = `[Desktop Entry]\nExec="/opt/ZCode.AppImage" %U\n`;
    expect(parseZcodeDesktopExec(desktop)).toBe("/opt/ZCode.AppImage");
  });

  it("preserves a quoted path that contains spaces (no truncation)", () => {
    // A path with an interior space MUST be quoted per the freedesktop spec;
    // splitting on whitespace first would truncate it at the space. This is
    // the regression guard for the quote-aware tokenizer.
    const desktop = `[Desktop Entry]\nExec="/home/user/My Apps/ZCode-3.7.5.AppImage" --no-sandbox %U\n`;
    expect(parseZcodeDesktopExec(desktop)).toBe(
      "/home/user/My Apps/ZCode-3.7.5.AppImage",
    );
  });

  it("returns null when no Exec= line is present", () => {
    const desktop = `[Desktop Entry]\nName=ZCode\nIcon=zcode\n`;
    expect(parseZcodeDesktopExec(desktop)).toBeNull();
  });

  it("does not match TryExec= (a different field)", () => {
    const desktop = `[Desktop Entry]\nTryExec=/opt/ZCode.AppImage\nExec=/real/ZCode.AppImage\n`;
    expect(parseZcodeDesktopExec(desktop)).toBe("/real/ZCode.AppImage");
  });

  it("returns null for a malformed Exec= that is just a field code", () => {
    const desktop = `[Desktop Entry]\nExec=%U\n`;
    expect(parseZcodeDesktopExec(desktop)).toBeNull();
  });

  it("returns null for an empty Exec= value", () => {
    const desktop = `[Desktop Entry]\nExec=\n`;
    expect(parseZcodeDesktopExec(desktop)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(parseZcodeDesktopExec("")).toBeNull();
  });
});

describe("discoverZcodeAppImage — .desktop I/O glue (ADR-0007)", () => {
  const desktopPath = posix.join(
    homedir(),
    ".local",
    "share",
    "applications",
    "zcode.desktop",
  );

  it("reads the .desktop entry and returns the parsed AppImage path", () => {
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === desktopPath);
    readFileSyncMock.mockReturnValue(
      "[Desktop Entry]\nExec=/opt/ZCode-3.7.5.AppImage --no-sandbox\n",
    );

    expect(discoverZcodeAppImage()).toBe("/opt/ZCode-3.7.5.AppImage");
    expect(readFileSyncMock).toHaveBeenCalledWith(desktopPath, "utf8");
  });

  it("returns null when the .desktop file is missing", () => {
    stubPlatform("linux");
    existsSyncMock.mockReturnValue(false);

    expect(discoverZcodeAppImage()).toBeNull();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when readFileSync throws (e.g. EACCES)", () => {
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === desktopPath);
    readFileSyncMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(discoverZcodeAppImage()).toBeNull();
  });

  it("returns null when the Exec= line is malformed", () => {
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === desktopPath);
    readFileSyncMock.mockReturnValue("[Desktop Entry]\nName=ZCode\n");

    expect(discoverZcodeAppImage()).toBeNull();
  });
});

// ADR-0007 decision 1: on Linux, resolveZcodeBin() step 3 discovers the
// AppImage via the .desktop entry (priority ZCODE_BIN → `zcode` on PATH →
// .desktop Exec=). The returned path is the AppImage binary, NOT a .cjs — the
// .cjs lives inside the mount and is resolved post-mount in the invoke layer.
describe("resolveZcodeBin / resolveZcodeNodeBin on Linux (ADR-0007)", () => {
  const desktopPath = posix.join(
    homedir(),
    ".local",
    "share",
    "applications",
    "zcode.desktop",
  );

  it("resolveZcodeBin() step 3 returns the .desktop AppImage when no env/PATH hit", () => {
    stubPlatform("linux");
    existsSyncMock.mockImplementation(
      (p) => p === desktopPath || p === "/opt/ZCode.AppImage",
    );
    readFileSyncMock.mockReturnValue(
      "[Desktop Entry]\nExec=/opt/ZCode.AppImage\n",
    );

    expect(resolveZcodeBin()).toBe("/opt/ZCode.AppImage");
  });

  it("resolveZcodeBin() returns null on Linux when the .desktop is missing (no silent guess)", () => {
    stubPlatform("linux");
    existsSyncMock.mockReturnValue(false);

    expect(resolveZcodeBin()).toBeNull();
  });

  it("resolveZcodeNodeBin() step 3 returns the discovered AppImage (Electron driver)", () => {
    stubPlatform("linux");
    existsSyncMock.mockImplementation(
      (p) => p === desktopPath || p === "/opt/ZCode.AppImage",
    );
    readFileSyncMock.mockReturnValue(
      "[Desktop Entry]\nExec=/opt/ZCode.AppImage\n",
    );

    expect(resolveZcodeNodeBin()).toBe("/opt/ZCode.AppImage");
  });

  it("resolveZcodeNodeBin() terminal fallback is the canonical guess when discovery misses", () => {
    stubPlatform("linux");
    existsSyncMock.mockReturnValue(false);

    // The contract is `string` (never null). When discovery misses (no .desktop,
    // no env, no PATH) the canonical ~/Applications/ZCode.AppImage is returned
    // so a hand-crafted caller's spawn surfaces a real ENOENT instead of a null.
    expect(resolveZcodeNodeBin()).toBe(
      posix.join(homedir(), "Applications", "ZCode.AppImage"),
    );
  });

  it("defaultZcodeCjsPaths() returns the .deb .cjs candidate on Linux (T5)", () => {
    stubPlatform("linux");
    expect(defaultZcodeCjsPaths()).toEqual([
      "/opt/ZCode/resources/glm/zcode.cjs",
    ]);
  });

  it("defaultZcodeElectronExePaths() lists the .deb driver before the AppImage on Linux (T5)", () => {
    stubPlatform("linux");
    expect(defaultZcodeElectronExePaths()).toEqual([
      "/opt/ZCode/zcode",
      posix.join(homedir(), "Applications", "ZCode.AppImage"),
    ]);
  });

  it("defaultZcodeCjsPaths() Windows/macOS branches are unchanged", () => {
    stubPlatform("win32");
    // A custom install dir yields BOTH it and the hardcoded default; a value
    // equal to the default would dedupe, so use a distinct dir here.
    vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "D:\\ZCode");
    expect(defaultZcodeCjsPaths()).toEqual([
      "D:\\ZCode\\resources\\glm\\zcode.cjs",
      "C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs",
    ]);
    stubPlatform("darwin");
    expect(defaultZcodeCjsPaths()).toEqual([
      "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    ]);
  });
});

// T5 (#31 / ADR-0010): the official .deb install lays a loose zcode.cjs at
// /opt/ZCode/resources/glm/zcode.cjs next to the Electron driver /opt/ZCode/zcode
// (verified against the unpacked ZCode-3.7.6-linux-x64.deb, 2026-08-13). This is
// the same loose-file layout as Windows/macOS, so the .deb is probed the same
// way: resolveZcodeBin() checks the on-disk .cjs BEFORE the AppImage (a loose
// .cjs cleanly distinguishes a .deb from an AppImage, whose .cjs is packed in
// the squashfs), and resolveZcodeNodeBin() probes /opt/ZCode/zcode so a .deb-
// only host without a system node can still drive the .cjs — no mount needed.
describe("resolveZcodeBin / resolveZcodeNodeBin Linux .deb install (T5 / ADR-0010)", () => {
  const desktopPath = posix.join(
    homedir(),
    ".local",
    "share",
    "applications",
    "zcode.desktop",
  );

  it("resolveZcodeBin() returns the on-disk .deb .cjs before AppImage discovery", () => {
    stubPlatform("linux");
    // The .deb .cjs exists. An AppImage is ALSO discoverable here — the on-disk
    // .cjs probe must win so a .deb install never needlessly mounts.
    existsSyncMock.mockImplementation(
      (p) =>
        p === "/opt/ZCode/resources/glm/zcode.cjs" ||
        p === "/opt/ZCode.AppImage" ||
        p === desktopPath,
    );
    readFileSyncMock.mockReturnValue(
      "[Desktop Entry]\nExec=/opt/ZCode.AppImage\n",
    );

    expect(resolveZcodeBin()).toBe("/opt/ZCode/resources/glm/zcode.cjs");
  });

  it("resolveZcodeNodeBin() returns /opt/ZCode/zcode when no system node (.deb-only)", () => {
    stubPlatform("linux");
    existsSyncMock.mockImplementation((p) => p === "/opt/ZCode/zcode");

    expect(resolveZcodeNodeBin()).toBe("/opt/ZCode/zcode");
  });
});
