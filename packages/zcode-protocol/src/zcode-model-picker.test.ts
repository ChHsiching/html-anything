import { describe, it, expect } from "vitest";
import {
  parseZcodePickerModels,
  resolveZcodeDefaultSelection,
} from "./zcode-model-picker.js";

// A config shape mirroring the live GUI's resolved config (redacted): two
// enabled providers (one with 2 models, one with 1) + one disabled provider
// carrying a systemDisabledReason. The disabled provider's models must NOT
// surface in the picker. See ADR-0005 decision 4 / #19.
const CONFIG = {
  provider: {
    "builtin:bigmodel-coding-plan": {
      name: "GLM Coding Plan (BigModel)",
      kind: "anthropic",
      options: { apiKey: "<redacted>", baseURL: "https://open.bigmodel.cn/api/anthropic" },
      enabled: true,
      source: "builtin",
      models: {
        "GLM-5.2": { limit: { context: 1048576, output: 16384 } },
        "GLM-5-Turbo": {
          reasoning: { enabled: true },
          limit: { context: 204800, output: 16384 },
        },
      },
    },
    "builtin:openrouter": {
      name: "OpenRouter",
      kind: "openai-compatible",
      options: { apiKey: "<redacted>", baseURL: "https://openrouter.ai/api/v1" },
      enabled: true,
      source: "builtin",
      models: {
        "anthropic/claude-sonnet-4.5": { limit: { context: 200000, output: 8192 } },
      },
    },
    "builtin:bigmodel-start-plan": {
      name: "GLM Start Plan (BigModel)",
      kind: "anthropic",
      options: { apiKey: "<redacted>", baseURL: "https://open.bigmodel.cn/api/anthropic" },
      enabled: false,
      systemDisabledReason: "coding_plan_not_entitled",
      source: "builtin",
      models: {
        "GLM-5.2": { limit: { context: 131072, output: 4096 } },
        "GLM-5-Turbo": { limit: { context: 131072, output: 4096 } },
      },
    },
    "builtin:zai": {
      name: "Z.AI",
      kind: "openai",
      options: { apiKey: "", baseURL: "https://api.z.ai/api/paas/v4" },
      enabled: true,
      systemDisabledReason: "oauth_provider_inactive",
      source: "builtin",
      models: {
        "GLM-5.2": { limit: { context: 1048576, output: 16384 } },
      },
    },
  },
};

describe("parseZcodePickerModels", () => {
  it("lists every enabled provider's models, excluding disabled + systemDisabled providers", () => {
    const models = parseZcodePickerModels(CONFIG);

    // Two enabled providers with no systemDisabledReason contribute:
    //   bigmodel-coding-plan → GLM-5.2, GLM-5-Turbo
    //   openrouter           → anthropic/claude-sonnet-4.5
    // Excluded:
    //   bigmodel-start-plan  → enabled:false (+ systemDisabledReason)
    //   zai                  → enabled:true but systemDisabledReason set
    expect(models).toEqual([
      { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel-coding-plan" },
      { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel-coding-plan" },
      {
        id: "anthropic/claude-sonnet-4.5",
        label: "anthropic/claude-sonnet-4.5",
        providerId: "builtin:openrouter",
      },
    ]);
  });

  it("each entry carries its providerId (so invoke can recover {providerId, modelId})", () => {
    const models = parseZcodePickerModels(CONFIG);
    for (const m of models) {
      expect(typeof m.providerId).toBe("string");
      expect(m.providerId.length).toBeGreaterThan(0);
      expect(m.id).toBe(m.label);
    }
  });

  it("returns [] for missing/empty/malformed config (never throws)", () => {
    expect(parseZcodePickerModels(null)).toEqual([]);
    expect(parseZcodePickerModels({})).toEqual([]);
    expect(parseZcodePickerModels({ provider: {} })).toEqual([]);
    expect(parseZcodePickerModels({ provider: { x: "not-an-object" } })).toEqual([]);
    expect(parseZcodePickerModels({ provider: { x: { enabled: true } } })).toEqual([]);
    // enabled but no models map → contributes nothing
    expect(
      parseZcodePickerModels({ provider: { x: { enabled: true, models: {} } } }),
    ).toEqual([]);
  });

  it("excludes a provider whose only disqualifier is systemDisabledReason (enabled:true)", () => {
    const models = parseZcodePickerModels({
      provider: {
        "builtin:ok": {
          enabled: true,
          models: { "good-model": {} },
        },
        "builtin:lapsed": {
          enabled: true,
          systemDisabledReason: "oauth_provider_inactive",
          models: { "lapsed-model": {} },
        },
      },
    });
    expect(models.map((m) => m.id)).toEqual(["good-model"]);
  });

  it("preserves insertion order (GUI display order) within and across providers", () => {
    const models = parseZcodePickerModels({
      provider: {
        "p-a": { enabled: true, models: { "a-2": {}, "a-1": {} } },
        "p-b": { enabled: true, models: { "b-1": {} } },
      },
    });
    expect(models.map((m) => m.id)).toEqual(["a-2", "a-1", "b-1"]);
  });
});

describe("resolveZcodeDefaultSelection", () => {
  it("maps the selected key's providerId to that provider's id + first model id", () => {
    // setting.json shape: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" }
    const sel = resolveZcodeDefaultSelection(
      { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      CONFIG,
    );
    // bigmodel-coding-plan's first model is GLM-5.2.
    expect(sel).toEqual({ providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.2" });
  });

  it("returns null when the selected provider is disabled / not in config", () => {
    expect(
      resolveZcodeDefaultSelection(
        { bigmodel: "start-plan:builtin:bigmodel-start-plan" },
        CONFIG,
      ),
    ).toBe(null);
    expect(resolveZcodeDefaultSelection({ zai: "builtin:nonexistent" }, CONFIG)).toBe(null);
  });

  it("returns null for missing/empty selected keys or config", () => {
    expect(resolveZcodeDefaultSelection(null, CONFIG)).toBe(null);
    expect(resolveZcodeDefaultSelection({}, CONFIG)).toBe(null);
    expect(
      resolveZcodeDefaultSelection(
        { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
        null,
      ),
    ).toBe(null);
  });

  it("maps a non-default family selection (openrouter) to its provider + first model", () => {
    // Selected value shape is `<mode>:<providerId>`; the resolver tries the
    // whole value, then after-the-first-colon, then after-the-last-colon
    // against the real config keys, so the `builtin:` prefix inside the
    // providerId is handled correctly.
    expect(
      resolveZcodeDefaultSelection({ openrouter: "builtin:builtin:openrouter" }, CONFIG),
    ).toEqual({ providerId: "builtin:openrouter", modelId: "anthropic/claude-sonnet-4.5" });
  });

  it("accepts a bare real providerId (with a builtin: colon, no mode prefix)", () => {
    // The selected value is the whole providerId (`builtin:openrouter`), which
    // itself contains a colon. The resolver matches it directly against the
    // config keys (the first candidate) — a naive colon-split would wrongly
    // yield `openrouter` and miss. This pins the bare-real-id case.
    expect(
      resolveZcodeDefaultSelection({ openrouter: "builtin:openrouter" }, CONFIG),
    ).toEqual({ providerId: "builtin:openrouter", modelId: "anthropic/claude-sonnet-4.5" });
  });

  it("accepts a bare providerId with no colon at all", () => {
    // A value with no colon is matched whole against the config keys.
    expect(
      resolveZcodeDefaultSelection({ custom: "custom-no-prefix" }, {
        provider: { "custom-no-prefix": { enabled: true, models: { "m-1": {} } } },
      }),
    ).toEqual({ providerId: "custom-no-prefix", modelId: "m-1" });
  });
});
