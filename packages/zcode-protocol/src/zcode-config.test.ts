import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseZcodeConfig,
  readZcodeConfig,
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
});

describe("defaultZcodeConfigPath", () => {
  it("points at ~/.zcode/v2/config.json (the GUI's resolved config, not the template)", () => {
    const p = defaultZcodeConfigPath();
    expect(p.replace(/\\/g, "/")).toMatch(/\.zcode\/v2\/config\.json$/);
  });
});
