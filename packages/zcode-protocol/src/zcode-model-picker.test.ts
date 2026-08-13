import { describe, it, expect } from "vitest";
import {
  parseZcodePickerModels,
  resolveZcodeDefaultSelection,
} from "./zcode-model-picker";

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
    // Mirrors the live `builtin:bigmodel` entry: enabled, no
    // systemDisabledReason, but apiKey is EMPTY. The GUI prompts for a key when
    // the user selects this provider; a headless adapter cannot, so its models
    // must NOT surface in the picker. The filter is the shared
    // isUsableZcodeProvider predicate (ADR-0010): enabled + no
    // systemDisabledReason + recognized kind + non-empty apiKey — the SAME
    // gate the workspace-default relay applies, so the two cannot drift.
    "builtin:bigmodel": {
      name: "Bigmodel",
      kind: "anthropic",
      options: { apiKey: "", baseURL: "https://open.bigmodel.cn/api/paas/v4" },
      enabled: true,
      source: "builtin",
      models: {
        "GLM-5.2": { limit: { context: 131072, output: 4096 } },
        "GLM-5-Turbo": { limit: { context: 131072, output: 4096 } },
        "glm-5v-turbo": { limit: { context: 131072, output: 4096 } },
      },
    },
  },
};

describe("parseZcodePickerModels", () => {
  it("lists every enabled provider's models, excluding disabled + systemDisabled providers", () => {
    const models = parseZcodePickerModels(CONFIG);

    // Two enabled providers with a non-empty apiKey contribute:
    //   bigmodel-coding-plan → GLM-5.2, GLM-5-Turbo
    //   openrouter           → anthropic/claude-sonnet-4.5
    // Excluded:
    //   bigmodel-start-plan  → enabled:false (+ systemDisabledReason)
    //   zai                  → enabled:true but systemDisabledReason set
    //   bigmodel             → enabled:true, no disabledReason, but apiKey:""
    //                          (matches the live `builtin:bigmodel` placeholder;
    //                          headless adapter can't use it → must be hidden)
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

  it("excludes an enabled provider with no systemDisabledReason but an EMPTY apiKey", () => {
    // Mirrors the live `builtin:bigmodel` entry (enabled, no disabledReason,
    // apiKey:""). The filter is the shared isUsableZcodeProvider predicate
    // (ADR-0010): enabled + no systemDisabledReason + recognized kind +
    // non-empty apiKey — the SAME gate the workspace-default relay applies.
    // Otherwise the picker lists models the user cannot actually run, and (when
    // the same modelId also exists on a usable provider) creates duplicate
    // picker ids that break ModelPicker's key/active uniqueness contract.
    const models = parseZcodePickerModels({
      provider: {
        "builtin:bigmodel": {
          kind: "anthropic",
          options: { apiKey: "" },
          enabled: true,
          models: { "GLM-5.2": {}, "glm-5v-turbo": {} },
        },
        "builtin:bigmodel-coding-plan": {
          kind: "anthropic",
          options: { apiKey: "real-key" },
          enabled: true,
          models: { "GLM-5.2": {}, "GLM-5-Turbo": {} },
        },
      },
    });
    // Only the coding-plan provider's models surface; the empty-key provider's
    // glm-5v-turbo does NOT (and GLM-5.2 appears once, not twice).
    expect(models.map((m) => m.id)).toEqual(["GLM-5.2", "GLM-5-Turbo"]);
    expect(models.every((m) => m.providerId === "builtin:bigmodel-coding-plan")).toBe(true);
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
          kind: "anthropic",
          options: { apiKey: "key" },
          enabled: true,
          models: { "good-model": {} },
        },
        "builtin:lapsed": {
          kind: "anthropic",
          options: { apiKey: "key" },
          enabled: true,
          systemDisabledReason: "oauth_provider_inactive",
          models: { "lapsed-model": {} },
        },
      },
    });
    expect(models.map((m) => m.id)).toEqual(["good-model"]);
  });

  it("dedups by modelId: first-in-config-order wins with no preference; preferredProviderId wins with one", () => {
    // Two USABLE providers sharing a modelId (GLM-5.2) — the case the apiKey
    // filter cannot catch (both have real keys). Dedup guarantees one entry per
    // modelId (T7 / ADR-0010 Decision 3), keeping the bare modelId as the id so
    // the resolver / modals / cli are unchanged.
    const DUP_CONFIG = {
      provider: {
        "builtin:bigmodel-coding-plan": {
          kind: "anthropic",
          options: { apiKey: "coding-plan-key" },
          enabled: true,
          models: { "GLM-5.2": {}, "GLM-5-Turbo": {} },
        },
        "builtin:openai-direct": {
          kind: "anthropic",
          options: { apiKey: "direct-key" },
          enabled: true,
          models: { "GLM-5.2": {}, "gpt-oss": {} },
        },
      },
    };

    // (1) No preferredProviderId → the FIRST usable provider's (coding-plan)
    // entry wins the GLM-5.2 collision; GLM-5.2 appears once. gpt-oss is unique
    // to openai-direct so it survives. Order = first-occurrence (display order).
    const noPref = parseZcodePickerModels(DUP_CONFIG);
    expect(noPref).toEqual([
      { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel-coding-plan" },
      { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel-coding-plan" },
      { id: "gpt-oss", label: "gpt-oss", providerId: "builtin:openai-direct" },
    ]);

    // (2) preferredProviderId = openai-direct → the GLM-5.2 collision resolves to
    // the preferred provider's entry (providerId flips to openai-direct), still at
    // the first-occurrence position; the rest is unchanged.
    const withPref = parseZcodePickerModels(DUP_CONFIG, "builtin:openai-direct");
    expect(withPref).toEqual([
      { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:openai-direct" },
      { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel-coding-plan" },
      { id: "gpt-oss", label: "gpt-oss", providerId: "builtin:openai-direct" },
    ]);
  });

  it("dedup preferredProviderId is a no-op when the preferred provider is not among the colliding entries", () => {
    // Same collision as above, but preferredProviderId points at a provider that
    // does NOT carry the duplicate modelId → falls back to first-in-config-order.
    const models = parseZcodePickerModels(
      {
        provider: {
          "p-a": { kind: "anthropic", options: { apiKey: "k" }, enabled: true, models: { "shared": {} } },
          "p-b": { kind: "anthropic", options: { apiKey: "k" }, enabled: true, models: { "shared": {} } },
        },
      },
      "builtin:not-present",
    );
    expect(models).toEqual([{ id: "shared", label: "shared", providerId: "p-a" }]);
  });

  it("preserves insertion order (GUI display order) within and across providers", () => {
    const models = parseZcodePickerModels({
      provider: {
        "p-a": { kind: "anthropic", options: { apiKey: "k" }, enabled: true, models: { "a-2": {}, "a-1": {} } },
        "p-b": { kind: "anthropic", options: { apiKey: "k" }, enabled: true, models: { "b-1": {} } },
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
        provider: { "custom-no-prefix": { kind: "anthropic", options: { apiKey: "k" }, enabled: true, models: { "m-1": {} } } },
      }),
    ).toEqual({ providerId: "custom-no-prefix", modelId: "m-1" });
  });
});
