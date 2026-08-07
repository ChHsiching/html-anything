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
      },
    ];

    expect(parseZcodeConfig(data)).toEqual({
      provider: "builtin:zai",
      model: "glm-5.1",
      models: ["glm-5.1", "glm-5-turbo", "glm-4.7"],
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
    });
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
