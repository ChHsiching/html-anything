import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUsableZcodeProvider,
  parseZcodeConfig,
  parseZcodeConfigForProvider,
  readZcodeConfig,
  readZcodeConfigForProvider,
  defaultZcodeConfigPath,
} from "./zcode-config";

/**
 * #14: the config reader reads the GUI's RESOLVED `~/.zcode/v2/config.json`
 * (provider map keyed by id, each entry with kind/options.apiKey/options.baseURL
 * /enabled/models-map), and maps the first usable entry to the live
 * `workspace/upsertModelProvider` schema. All shapes below are pinned against
 * the real Zod schemas confirmed by live probe (#14 probes 5–12), not invented.
 */

describe("parseZcodeConfig", () => {
  it("maps the first enabled provider-with-key to the live upsert record shape", () => {
    const data = {
      provider: {
        "builtin:bigmodel": {
          name: "Bigmodel",
          kind: "anthropic",
          options: { apiKey: "", baseURL: "https://open.bigmodel.cn/api/anthropic" },
          enabled: true,
          source: "builtin",
          models: { "glm-4.6": {} },
        },
        "builtin:bigmodel-coding-plan": {
          name: "BigModel - Coding Plan",
          kind: "anthropic",
          options: {
            apiKey: "test-api-key-not-real",
            baseURL: "https://open.bigmodel.cn/api/anthropic",
          },
          enabled: true,
          source: "custom",
          models: {
            "GLM-5.2": { limit: { context: 1000000 } },
            "GLM-5-Turbo": {},
          },
        },
      },
    };

    const cfg = parseZcodeConfig(data);
    expect(cfg).not.toBeNull();
    // The empty-key bigmodel entry is skipped; the coding-plan entry wins.
    expect(cfg!.provider).toBe("builtin:bigmodel-coding-plan");
    expect(cfg!.model).toBe("GLM-5.2");
    expect(cfg!.models).toEqual(["GLM-5.2", "GLM-5-Turbo"]);
    // The providerRecord matches the live upsert schema exactly:
    expect(cfg!.providerRecord).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      kind: "anthropic",
      apiKey: {
        source: "inline",
        value: "test-api-key-not-real",
      },
      models: [{ modelId: "GLM-5.2" }, { modelId: "GLM-5-Turbo" }],
      baseURL: "https://open.bigmodel.cn/api/anthropic",
    });
  });

  it("includes baseURL only when the entry has a non-empty options.baseURL", () => {
    const cfg = parseZcodeConfig({
      provider: {
        "builtin:zai": {
          kind: "openai",
          enabled: true,
          options: { apiKey: "sk-zai" },
          models: { "glm-4.6": {} },
        },
      },
    });
    expect(cfg!.provider).toBe("builtin:zai");
    expect(cfg!.providerRecord.kind).toBe("openai");
    expect("baseURL" in cfg!.providerRecord).toBe(false);
  });

  it("skips disabled entries and entries with empty apiKeys", () => {
    const cfg = parseZcodeConfig({
      provider: {
        "disabled-one": {
          kind: "openai",
          enabled: false,
          options: { apiKey: "sk-x" },
          models: { "m-1": {} },
        },
        "empty-key": {
          kind: "openai",
          enabled: true,
          options: { apiKey: "" },
          models: { "m-1": {} },
        },
        "good": {
          kind: "openai",
          enabled: true,
          options: { apiKey: "sk-good" },
          models: { "m-good": {} },
        },
      },
    });
    expect(cfg!.provider).toBe("good");
  });

  it("skips an enabled+key+kind entry that carries a non-empty systemDisabledReason (ADR-0010)", () => {
    // The GUI sets systemDisabledReason on expired/inactive entitlements. The
    // relay used to provision such an entry (enabled + key + recognized kind)
    // while the picker hid it — the two readers had drifted. After ADR-0010
    // both share one usable-provider predicate, so this entry is skipped.
    const cfg = parseZcodeConfig({
      provider: {
        "lapsed": {
          kind: "anthropic",
          enabled: true,
          options: { apiKey: "sk" },
          systemDisabledReason: "oauth_provider_inactive",
          models: { "m-1": {} },
        },
        "good": {
          kind: "anthropic",
          enabled: true,
          options: { apiKey: "sk-good" },
          models: { "m-good": {} },
        },
      },
    });
    expect(cfg!.provider).toBe("good");
  });

  it("returns null when every enabled+key+kind entry carries a systemDisabledReason", () => {
    const cfg = parseZcodeConfig({
      provider: {
        "lapsed": {
          kind: "anthropic",
          enabled: true,
          options: { apiKey: "sk" },
          systemDisabledReason: "coding_plan_not_entitled",
          models: { "m-1": {} },
        },
      },
    });
    expect(cfg).toBeNull();
  });

  it("skips entries with an unrecognized kind (the upsert Zod enum rejects them)", () => {
    const cfg = parseZcodeConfig({
      provider: {
        "weird-kind": {
          kind: "something-else",
          enabled: true,
          options: { apiKey: "sk" },
          models: { "m-1": {} },
        },
        "good": {
          kind: "openai-compatible",
          enabled: true,
          options: { apiKey: "sk", baseURL: "https://gw.example.com/v1" },
          models: { "m-1": {} },
        },
      },
    });
    expect(cfg!.provider).toBe("good");
    expect(cfg!.providerRecord.kind).toBe("openai-compatible");
  });

  it("skips entries with no models map", () => {
    const cfg = parseZcodeConfig({
      provider: {
        "no-models": {
          kind: "openai",
          enabled: true,
          options: { apiKey: "sk" },
        },
      },
    });
    expect(cfg).toBeNull();
  });

  it("returns null for non-object / missing provider map / empty input", () => {
    expect(parseZcodeConfig(null)).toBeNull();
    expect(parseZcodeConfig("nope")).toBeNull();
    expect(parseZcodeConfig({})).toBeNull();
    expect(parseZcodeConfig({ provider: {} })).toBeNull();
    expect(parseZcodeConfig({ provider: { not: "an-object" } })).toBeNull();
  });
});

describe("readZcodeConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses a config file at the given path", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            kind: "anthropic",
            enabled: true,
            options: { apiKey: "sk-real", baseURL: "https://x.example/api" },
            models: { "GLM-5.2": {} },
          },
        },
      }),
    );
    const cfg = readZcodeConfig(path);
    expect(cfg!.provider).toBe("builtin:bigmodel-coding-plan");
    expect(cfg!.providerRecord.apiKey).toEqual({ source: "inline", value: "sk-real" });
  });

  it("returns null when the file is missing (never throws)", () => {
    expect(readZcodeConfig(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("returns null when the file holds malformed JSON (never throws)", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not valid json");
    expect(readZcodeConfig(path)).toBeNull();
  });

  it("readZcodeConfigForProvider targets a specific provider id from disk", () => {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        provider: {
          "builtin:bigmodel-coding-plan": {
            kind: "anthropic",
            enabled: true,
            options: { apiKey: "sk-cp" },
            models: { "GLM-5.2": {} },
          },
          "builtin:other": {
            kind: "openai",
            enabled: true,
            options: { apiKey: "sk-other" },
            models: { "m-other": {} },
          },
        },
      }),
    );
    const cfg = readZcodeConfigForProvider("builtin:other", path);
    expect(cfg!.provider).toBe("builtin:other");
    expect(cfg!.model).toBe("m-other");
    // A missing id resolves to null (never throws, never falls through to the
    // first usable entry — the relay must target exactly the GUI default).
    expect(readZcodeConfigForProvider("builtin:absent", path)).toBeNull();
  });

  it("readZcodeConfigForProvider returns null when the file is missing (never throws)", () => {
    expect(readZcodeConfigForProvider("any", join(dir, "nope.json"))).toBeNull();
  });
});

describe("isUsableZcodeProvider", () => {
  // The ONE shared definition of "usable provider" (ADR-0010 Decision 2):
  // enabled === true AND no non-empty systemDisabledReason AND a recognized
  // kind AND a non-empty options.apiKey. Both the relay reader
  // (parseProviderEntry) and the picker delegate to it, so they cannot drift.
  it("is true for enabled + recognized kind + non-empty apiKey + no systemDisabledReason", () => {
    expect(
      isUsableZcodeProvider({
        enabled: true,
        kind: "anthropic",
        options: { apiKey: "sk" },
      }),
    ).toBe(true);
    expect(
      isUsableZcodeProvider({
        enabled: true,
        kind: "openai-compatible",
        options: { apiKey: "sk" },
      }),
    ).toBe(true);
  });

  it("is false for an enabled+key+kind entry with a non-empty systemDisabledReason (the drift case)", () => {
    expect(
      isUsableZcodeProvider({
        enabled: true,
        kind: "anthropic",
        options: { apiKey: "sk" },
        systemDisabledReason: "coding_plan_not_entitled",
      }),
    ).toBe(false);
  });

  it("treats an empty-string systemDisabledReason as absent", () => {
    expect(
      isUsableZcodeProvider({
        enabled: true,
        kind: "anthropic",
        options: { apiKey: "sk" },
        systemDisabledReason: "",
      }),
    ).toBe(true);
  });

  it("is false when disabled, kind is unrecognized, or apiKey is empty/missing", () => {
    expect(
      isUsableZcodeProvider({ enabled: false, kind: "anthropic", options: { apiKey: "sk" } }),
    ).toBe(false);
    expect(
      isUsableZcodeProvider({ enabled: true, kind: "something-else", options: { apiKey: "sk" } }),
    ).toBe(false);
    expect(
      isUsableZcodeProvider({ enabled: true, kind: "anthropic", options: { apiKey: "" } }),
    ).toBe(false);
    expect(isUsableZcodeProvider({ enabled: true, kind: "anthropic" })).toBe(false);
  });

  it("is false for non-object input (never throws)", () => {
    expect(isUsableZcodeProvider(null)).toBe(false);
    expect(isUsableZcodeProvider("x")).toBe(false);
    expect(isUsableZcodeProvider(undefined)).toBe(false);
  });
});

describe("parseZcodeConfigForProvider", () => {
  const DATA = {
    provider: {
      "builtin:bigmodel-coding-plan": {
        kind: "anthropic",
        enabled: true,
        options: { apiKey: "sk-cp", baseURL: "https://x.example/api" },
        models: { "GLM-5.2": {}, "GLM-5-Turbo": {} },
      },
      "builtin:lapsed": {
        kind: "anthropic",
        enabled: true,
        options: { apiKey: "sk-l" },
        systemDisabledReason: "coding_plan_not_entitled",
        models: { "m-1": {} },
      },
    },
  };

  it("returns the targeted provider when it is usable", () => {
    const cfg = parseZcodeConfigForProvider(DATA, "builtin:bigmodel-coding-plan");
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("builtin:bigmodel-coding-plan");
    expect(cfg!.model).toBe("GLM-5.2");
    expect(cfg!.models).toEqual(["GLM-5.2", "GLM-5-Turbo"]);
    expect(cfg!.providerRecord.apiKey).toEqual({ source: "inline", value: "sk-cp" });
  });

  it("returns null when the targeted provider is disabled (systemDisabledReason)", () => {
    expect(parseZcodeConfigForProvider(DATA, "builtin:lapsed")).toBeNull();
  });

  it("returns null when the targeted provider id is absent from the map", () => {
    expect(parseZcodeConfigForProvider(DATA, "builtin:nonexistent")).toBeNull();
  });

  it("returns null when the targeted provider is usable but has no models map", () => {
    expect(
      parseZcodeConfigForProvider(
        { provider: { p: { kind: "anthropic", enabled: true, options: { apiKey: "sk" } } } },
        "p",
      ),
    ).toBeNull();
  });

  it("returns null for non-object / missing provider map / empty input", () => {
    expect(parseZcodeConfigForProvider(null, "x")).toBeNull();
    expect(parseZcodeConfigForProvider({}, "x")).toBeNull();
    expect(parseZcodeConfigForProvider({ provider: {} }, "x")).toBeNull();
    expect(parseZcodeConfigForProvider({ provider: { x: "not-an-object" } }, "x")).toBeNull();
  });
});

describe("defaultZcodeConfigPath", () => {
  it("points at ~/.zcode/v2/config.json (the GUI's resolved config, not the template)", () => {
    const p = defaultZcodeConfigPath();
    expect(p.replace(/\\/g, "/")).toMatch(/\.zcode\/v2\/config\.json$/);
  });
});
