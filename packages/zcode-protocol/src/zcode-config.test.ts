import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseZcodeConfig, readZcodeConfig } from "./zcode-config.js";

describe("parseZcodeConfig", () => {
  it("returns the first api-key provider, its first model, and full model list", () => {
    // Real fixture shape: array of providers, only one has a non-empty apiKey.
    const data = [
      {
        id: "builtin:bigmodel",
        name: "Bigmodel",
        apiKey: "",
        models: ["glm-5", "glm-4.7"],
      },
      {
        id: "builtin:zai",
        name: "Z.AI",
        apiKey: "52d6b0ae.oLRk06",
        models: ["glm-5.1", "glm-5-turbo", "glm-4.7"],
        endpoints: { anthropic: "https://api.z.ai/api/anthropic", openai: "https://api.z.ai/api/coding/paas/v4", gemini: "" },
      },
    ];

    // Vendor gateway (not api.anthropic.com / api.openai.com) → openai-compatible
    // carrying the vendor's openai-style endpoint as baseURL. The literal
    // anthropic/openai kinds would dial the official hosts and reject the key.
    expect(parseZcodeConfig(data)).toEqual({
      provider: "builtin:zai",
      model: "glm-5.1",
      models: ["glm-5.1", "glm-5-turbo", "glm-4.7"],
      providerRecord: {
        providerId: "builtin:zai",
        kind: "openai-compatible",
        baseURL: "https://api.z.ai/api/coding/paas/v4",
        apiKey: { source: "inline", value: "52d6b0ae.oLRk06" },
        models: [{ modelId: "glm-5.1" }, { modelId: "glm-5-turbo" }, { modelId: "glm-4.7" }],
      },
    });
  });

  it("picks the first provider with a non-empty apiKey when several qualify", () => {
    const data = [
      { id: "a", name: "A", apiKey: "key-a", models: ["m1"] },
      { id: "b", name: "B", apiKey: "key-b", models: ["m2"] },
    ];
    expect(parseZcodeConfig(data)).toEqual({
      provider: "a",
      model: "m1",
      models: ["m1"],
      providerRecord: {
        providerId: "a",
        // No endpoints -> openai-compatible, no baseURL.
        kind: "openai-compatible",
        apiKey: { source: "inline", value: "key-a" },
        models: [{ modelId: "m1" }],
      },
    });
  });

  it("uses kind 'anthropic' when the endpoint is the official api.anthropic.com", () => {
    const data = [
      { id: "ant", name: "Anthropic", apiKey: "k", models: ["m1"], endpoints: { anthropic: "https://api.anthropic.com" } },
    ];
    const cfg = parseZcodeConfig(data);
    expect(cfg?.providerRecord.kind).toBe("anthropic");
    expect(cfg?.providerRecord.baseURL).toBeUndefined();
  });

  it("uses kind 'openai' when the endpoint is the official api.openai.com", () => {
    const data = [
      { id: "oai", name: "OpenAI", apiKey: "k", models: ["m1"], endpoints: { openai: "https://api.openai.com/v1" } },
    ];
    const cfg = parseZcodeConfig(data);
    expect(cfg?.providerRecord.kind).toBe("openai");
    expect(cfg?.providerRecord.baseURL).toBeUndefined();
  });

  it("falls back to openai-compatible + anthropic baseURL when only the anthropic endpoint is set", () => {
    const data = [
      { id: "v", name: "Vendor", apiKey: "k", models: ["m1"], endpoints: { anthropic: "https://vendor/api", openai: "" } },
    ];
    const cfg = parseZcodeConfig(data);
    expect(cfg?.providerRecord.kind).toBe("openai-compatible");
    expect(cfg?.providerRecord.baseURL).toBe("https://vendor/api");
  });

  it("returns null when no provider has a non-empty apiKey", () => {
    const data = [
      { id: "a", name: "A", apiKey: "", models: ["m1"] },
      { id: "b", name: "B", models: ["m2"] },
    ];
    expect(parseZcodeConfig(data)).toBeNull();
  });

  it("returns null when the api-key provider has an empty model list", () => {
    const data = [{ id: "a", name: "A", apiKey: "k", models: [] }];
    expect(parseZcodeConfig(data)).toBeNull();
  });

  it("returns null for non-array input", () => {
    expect(parseZcodeConfig({ foo: "bar" })).toBeNull();
    expect(parseZcodeConfig("not an array")).toBeNull();
    expect(parseZcodeConfig(null)).toBeNull();
    expect(parseZcodeConfig(undefined)).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(parseZcodeConfig([])).toBeNull();
  });

  it("skips malformed provider entries instead of throwing", () => {
    const data = [
      null,
      "garbage",
      { id: "no-models", name: "X", apiKey: "k" }, // missing models
      { id: "ok", name: "Y", apiKey: "k", models: ["m1"] },
    ];
    expect(parseZcodeConfig(data)).toEqual({
      provider: "ok",
      model: "m1",
      models: ["m1"],
      providerRecord: {
        providerId: "ok",
        kind: "openai-compatible",
        apiKey: { source: "inline", value: "k" },
        models: [{ modelId: "m1" }],
      },
    });
  });
});

describe("readZcodeConfig", () => {
  let dir: string;

  function fixtureFile(contents: string): string {
    const filePath = join(dir, "model-providers.json");
    writeFileSync(filePath, contents, "utf8");
    return filePath;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and parses a valid file", () => {
    const filePath = fixtureFile(
      JSON.stringify([
        { id: "p", name: "P", apiKey: "k", models: ["m1", "m2"] },
      ]),
    );
    expect(readZcodeConfig(filePath)).toEqual({
      provider: "p",
      model: "m1",
      models: ["m1", "m2"],
      providerRecord: {
        providerId: "p",
        kind: "openai-compatible",
        apiKey: { source: "inline", value: "k" },
        models: [{ modelId: "m1" }, { modelId: "m2" }],
      },
    });
  });

  it("returns null when the file does not exist (no throw)", () => {
    const missing = join(dir, "does-not-exist.json");
    expect(readZcodeConfig(missing)).toBeNull();
  });

  it("returns null for malformed JSON (no throw)", () => {
    const filePath = fixtureFile("{ this is not : valid json ]");
    expect(readZcodeConfig(filePath)).toBeNull();
  });

  it("returns null for empty file (no throw)", () => {
    const filePath = fixtureFile("");
    expect(readZcodeConfig(filePath)).toBeNull();
  });

  it("resolves the default path via os.homedir() when no path given", () => {
    // The default path is computed at call time from os.homedir(), so pointing
    // a non-existent path there exercises the missing-file branch without
    // depending on the host's real ~/.zcode state.
    const fakeHome = mkdtempSync(join(tmpdir(), "zcode-home-"));
    const original = process.env.HOME;
    const originalUserprofile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      // No file under fakeHome/.zcode/v2/model-providers.json -> null, no throw.
      expect(readZcodeConfig()).toBeNull();
    } finally {
      process.env.HOME = original;
      process.env.USERPROFILE = originalUserprofile;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
