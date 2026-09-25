// Unit tests for the registry-mirror model binding (v3): enumeration of
// the headless CLI's provider registry (account individual plans paired by
// credential keys ⊕ keyed personal providers), ordering, the modelRules
// level table, the enabled overlays, the default chain, the six-link
// refusal chain, the add-only identity bridge with the zero-write contract
// on the user's real files, and the verified binding discriminator.
//
// Fixture families (scrubbed from two real machines; structure verbatim):
// - F3 catalog: next to this file, __fixtures__/zcode-builtin.fixture.json —
//   the install's rule tables (all-vendor modelRules verbatim, the three
//   templates the personal fixtures instantiate, their templateModelRules,
//   all account providerRules, builtinProviderModelRules). Keys, account
//   ids, and gateway hosts in the personal fixtures are placeholders.
// - F1 dual-form machine: 4 keyed personal providers (two templates with
//   empty personalModelIds, one custom local gateway, one custom uuid
//   gateway) + credentials holding the paired individual keys, the GUI's
//   team shell api-key key, and the oauth keys.
// - F2 pure API-key machine: a single keyed bigmodel-api template instance
//   with empty personalModelIds/modelOrder and NO credentials.json — the
//   shape the v2 "plan parsing" rejected wholesale (regression anchor).
//
// No setting.json is ever written in these tests: v3 reads none, and the
// one explicit test below proves a stale one cannot influence anything.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeZcodeModelChoice,
  encodeZcodeModelChoice,
  enumerateZcodeRegistry,
  migrateLegacyZcodeProviderId,
  prepareZcodeModelBinding,
  readZcodePickerState,
  resolveZcodeCatalogFile,
  resolveZcodeDefaultSelection,
  zcodeBundledCatalogPathForCjs,
  zcodeCachePlatform,
  zcodeProviderEnvPairSet,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "../zcode-model-binding.js";

const here = dirname(fileURLToPath(import.meta.url));

// ─── F3: the install catalog fixture (structure verbatim) ───────────────

function catalogFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(here, "__fixtures__", "zcode-builtin.fixture.json"), "utf8"),
  ) as Record<string, unknown>;
}

/** Deep-clone + mutate helper for the catalog variants below. */
function catalogVariant(mutate: (catalog: Record<string, unknown>) => void): Record<string, unknown> {
  const catalog = JSON.parse(JSON.stringify(catalogFixture())) as Record<string, unknown>;
  mutate(catalog);
  return catalog;
}

// ─── F1: the dual-form machine (personal config + credentials) ──────────

const WECHAT_PROVIDER_ID = "00000000-1111-4222-8333-444444444444";
const ACCOUNT_ID = "10000000000000001";
const ACCOUNT_PROVIDER_ID = "account:bigmodel-individual-coding-plan";

function dualFormPersonalConfig(extraConfig: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["deepseek", "bigmodel-standard-api", "new-provider", WECHAT_PROVIDER_ID],
      providerConfigRules: {
        providerRules: [
          {
            providerId: WECHAT_PROVIDER_ID,
            providerName: "WeChat CodingPlan Token",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-wechat-token" },
              api: { type: "openai-chat-completions", baseUrl: "https://gateway.example.com/openai/v1" },
              personalModelIds: ["GLM-5.2", "Deepseek-v4-flash"],
              modelOrder: ["GLM-5.2", "Deepseek-v4-flash"],
            },
          },
          {
            providerId: "bigmodel-standard-api",
            templateId: "bigmodel-standard-api",
            providerName: "BigModel API",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-bigmodel-key" },
              api: { type: "openai-chat-completions" },
              personalModelIds: [],
              modelOrder: [
                "GLM-5.3", "GLM-5.3-Flash", "GLM-5V-Turbo", "GLM-5.1", "GLM-5.1-Highspeed",
                "GLM-5", "GLM-5-Turbo", "GLM-4.7", "GLM-4.7-FlashX", "GLM-4.7-Flash",
                "GLM-4.6", "GLM-4.5-Air", "GLM-4.5", "GLM-4.6V", "GLM-4.6V-Flash",
                "GLM-4.6V-FlashX", "GLM-4.1V-Thinking-FlashX", "GLM-4.1V-Thinking-Flash",
                "GLM-4-FlashX-250414", "GLM-4-Flash-250414", "GLM-4V-Flash", "codegeex-4",
                "charglm-4", "emohaa",
              ],
            },
          },
          {
            providerId: "deepseek",
            templateId: "deepseek",
            providerName: "DeepSeek",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-deepseek-key" },
              api: { type: "openai-responses", baseUrl: "https://api.deepseek.com" },
              personalModelIds: [],
              modelOrder: ["deepseek-flash", "deepseek-v4-pro"],
            },
          },
          {
            providerId: "new-provider",
            providerName: "llama.cpp",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "sk-local" },
              api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:8027/v1" },
              personalModelIds: ["Qwen3.6-35B-A3B", "Qwen3.8-27B"],
              modelOrder: ["Qwen3.6-35B-A3B", "Qwen3.8-27B"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            modelId: "GLM-5.2",
            config: { properties: { contextWindow: 200000 } },
            providerId: WECHAT_PROVIDER_ID,
          },
          {
            modelId: "Deepseek-v4-flash",
            config: { properties: { contextWindow: 1000000 } },
            providerId: WECHAT_PROVIDER_ID,
          },
          {
            modelId: "Qwen3.6-35B-A3B",
            config: {
              enabled: true,
              properties: { contextWindow: 262144, inputFormat: { supportsImage: true } },
              supportsJsonSchemaOutput: true,
              supportsMidConversationSystem: true,
            },
            optionSpecs: { maxOutputTokens: { max: 16384 } },
            providerId: "new-provider",
          },
          {
            modelId: "Qwen3.8-27B",
            config: {
              enabled: false,
              properties: { contextWindow: 16384, inputFormat: { supportsImage: true } },
              supportsJsonSchemaOutput: true,
              supportsMidConversationSystem: true,
            },
            optionSpecs: { maxOutputTokens: { max: 8192 } },
            providerId: "new-provider",
          },
        ],
        manualProviderModelRules: [],
      },
      ...extraConfig,
    },
  };
}

/** F1 credential key names (values are opaque fakes; only names and the
 * plaintext identity value matter to the adapter). The team api-key key is
 * the GUI's auto-laid shell: no identity key exists for it. */
function dualFormCredentials(): Record<string, string> {
  return {
    "oauth:bigmodel:access_token": "enc:v1:fixture",
    "oauth:bigmodel:user_info": "enc:v1:fixture",
    zcodejwttoken: "enc:v1:fixture",
    "oauth:active_provider": "enc:v1:fixture",
    [`account-provider:coding-plan:${ACCOUNT_PROVIDER_ID}:account:${ACCOUNT_ID}:api-key`]:
      "enc:v1:fixture",
    [`account-provider:coding-plan:account:bigmodel-team-coding-plan:account:${ACCOUNT_ID}:api-key`]:
      "enc:v1:fixture",
    [`account-provider:${ACCOUNT_PROVIDER_ID}:identity`]: ACCOUNT_ID,
  };
}

// ─── F2: the pure API-key machine ────────────────────────────────────────

function pureApiKeyPersonalConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["bigmodel-api"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "bigmodel-api",
            templateId: "bigmodel-api",
            providerName: "BigModel Coding Plan",
            config: {
              group: "standard-personal",
              access: { type: "zhipu-coding-plan-api-key", apiKey: "fixture-coding-plan-key" },
              personalModelIds: [],
              modelOrder: [],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

// ─── Fixture tree (install + personal + credentials on temp disk) ────────

interface FixtureTree {
  cjs: string;
  catalogPath: string;
  personalPath: string;
  credentialsPath: string;
  attachDir: string;
  dir: string;
}

function writeFixtureTree(
  dir: string,
  opts: {
    catalog?: unknown;
    personal?: Record<string, unknown>;
    credentials?: Record<string, string> | null;
  } = {},
): FixtureTree {
  const catalog = opts.catalog ?? catalogFixture();
  const install = join(dir, "install");
  mkdirSync(join(install, "resources", "glm"), { recursive: true });
  mkdirSync(join(install, "resources", "config", "provider"), { recursive: true });
  const cjs = join(install, "resources", "glm", "zcode.cjs");
  writeFileSync(cjs, "");
  const catalogPath = join(install, "resources", "config", "provider", "zcode-builtin.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const personalPath = join(dir, "provider_config.json");
  writeFileSync(personalPath, JSON.stringify(opts.personal ?? dualFormPersonalConfig()));
  const credentialsPath = join(dir, "credentials.json");
  const credentials = opts.credentials === undefined ? dualFormCredentials() : opts.credentials;
  if (credentials !== null) writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  const attachDir = join(dir, "attach");
  mkdirSync(attachDir, { recursive: true });
  return { cjs, catalogPath, personalPath, credentialsPath, attachDir, dir };
}

// ─── Registry enumeration ─────────────────────────────────────────────────

describe("enumerateZcodeRegistry (the registry mirror)", () => {
  it("F1 dual-form: account individual first (catalog order), then personal by providerOrder; team shell keys produce no entry", () => {
    const providers = enumerateZcodeRegistry(
      catalogFixture(),
      dualFormPersonalConfig(),
      dualFormCredentials(),
    );
    expect(providers.map((p) => [p.providerId, p.providerName, p.kind])).toEqual([
      [ACCOUNT_PROVIDER_ID, "BigModel Individual Coding Plan", "account"],
      ["deepseek", "DeepSeek", "personal"],
      ["bigmodel-standard-api", "BigModel API", "personal"],
      ["new-provider", "llama.cpp", "personal"],
      [WECHAT_PROVIDER_ID, "WeChat CodingPlan Token", "personal"],
    ]);
    // The GUI's team shell api-key key names a team provider (no identity
    // key, and team mode is never expanded): no team entry anywhere.
    expect(providers.some((p) => p.providerId.includes("team"))).toBe(false);
    expect(providers.some((p) => p.providerId.includes("start"))).toBe(false);
    expect(providers.some((p) => p.providerId.includes("offpeak"))).toBe(false);
    // The paired identity rides along for the account entry.
    expect(providers[0]!.accountIdentity).toBe(ACCOUNT_ID);
    expect(providers.slice(1).every((p) => p.accountIdentity === undefined)).toBe(true);
  });

  it("F1 model tables: template builtin lists ∪ personalModelIds under the enabled overlays, with modelRules levels", () => {
    const providers = enumerateZcodeRegistry(
      catalogFixture(),
      dualFormPersonalConfig(),
      dualFormCredentials(),
    );
    const modelsOf = (p: (typeof providers)[number]) => p.models.map((m) => [m.modelId, m.levels]);
    // Account plan: catalog builtinModelIds, levels from the glm-5.3 rule.
    expect(modelsOf(providers[0]!)).toEqual([
      ["GLM-5.3", ["low", "high", "max"]],
      ["GLM-5.3-Flash", ["low", "high", "max"]],
    ]);
    // deepseek template: personalModelIds empty → template builtinModelIds
    // in modelOrder, templateModelRules entries enabled.
    expect(modelsOf(providers[1]!)).toEqual([
      ["deepseek-flash", ["disabled", "low", "high", "max"]],
      ["deepseek-v4-pro", ["disabled", "low", "high", "max"]],
    ]);
    // bigmodel-standard-api: 24 template ids, but templateModelRules
    // disables all but GLM-5.3 / GLM-5.3-Flash.
    expect(modelsOf(providers[2]!)).toEqual([
      ["GLM-5.3", ["low", "high", "max"]],
      ["GLM-5.3-Flash", ["low", "high", "max"]],
    ]);
    // llama.cpp custom provider: Qwen3.8-27B dropped by the personal
    // providerModelRules enabled:false entry; Qwen3.6-35B-A3B hits no
    // specific rule → the base .* table only.
    expect(modelsOf(providers[3]!)).toEqual([["Qwen3.6-35B-A3B", ["disabled", "enabled"]]]);
    // WeChat custom gateway: personalModelIds as-is.
    expect(modelsOf(providers[4]!)).toEqual([
      ["GLM-5.2", ["disabled", "high", "max"]],
      ["Deepseek-v4-flash", ["disabled", "low", "high", "max"]],
    ]);
  });

  it("F1 without the credential pair: account drops out, personal providers remain", () => {
    const providers = enumerateZcodeRegistry(
      catalogFixture(),
      dualFormPersonalConfig(),
      // identity key present but naming a DIFFERENT account: the CLI's own
      // entitlement check pairs identity value → api-key key name, so this
      // does not materialize either.
      {
        ...dualFormCredentials(),
        [`account-provider:${ACCOUNT_PROVIDER_ID}:identity`]: "10000000000000002",
      },
    );
    expect(providers.map((p) => p.providerId)).toEqual([
      "deepseek",
      "bigmodel-standard-api",
      "new-provider",
      WECHAT_PROVIDER_ID,
    ]);
  });

  it("F2 pure API-key machine: single template instance enumerates the template builtinModelIds with levels; no credentials.json at all", () => {
    // Regression anchor: the v2 plan-parsing rejected this shape wholesale
    // ("not logged in"); the registry mirror enumerates it.
    const providers = enumerateZcodeRegistry(catalogFixture(), pureApiKeyPersonalConfig(), null);
    expect(providers.map((p) => [p.providerId, p.kind])).toEqual([["bigmodel-api", "personal"]]);
    expect(providers[0]!.models).toEqual([
      { modelId: "GLM-5.3", levels: ["low", "high", "max"] },
      { modelId: "GLM-5.3-Flash", levels: ["low", "high", "max"] },
    ]);
  });

  it("a keyed provider missing from providerOrder follows after the ordered ones (declaration order)", () => {
    const personal = dualFormPersonalConfig();
    const config = personal.config as { providerOrder: string[] };
    config.providerOrder = ["bigmodel-standard-api", "new-provider", WECHAT_PROVIDER_ID];
    const providers = enumerateZcodeRegistry(catalogFixture(), personal, dualFormCredentials());
    expect(providers.map((p) => p.providerId)).toEqual([
      ACCOUNT_PROVIDER_ID,
      "bigmodel-standard-api",
      "new-provider",
      WECHAT_PROVIDER_ID,
      "deepseek",
    ]);
  });

  it("keyless / hidden / disabled personal entries are not enumerated (an explicit pick of them refuses later)", () => {
    const personal = dualFormPersonalConfig();
    const rules = (personal.config as {
      providerConfigRules: { providerRules: Array<Record<string, unknown>> };
    }).providerConfigRules.providerRules;
    // Strip deepseek's key, hide llama.cpp, disable the WeChat entry.
    const deepseek = rules.find((r) => r.providerId === "deepseek") as {
      config: { access: { apiKey?: string } };
    };
    delete deepseek.config.access.apiKey;
    const llama = rules.find((r) => r.providerId === "new-provider") as {
      config: Record<string, unknown>;
    };
    llama.config.visibility = "hidden";
    const wechat = rules.find((r) => r.providerId === WECHAT_PROVIDER_ID) as {
      config: Record<string, unknown>;
    };
    wechat.config.enabled = false;
    const providers = enumerateZcodeRegistry(catalogFixture(), personal, dualFormCredentials());
    expect(providers.map((p) => p.providerId)).toEqual([
      ACCOUNT_PROVIDER_ID,
      "bigmodel-standard-api",
    ]);
  });

  it("a catalog whose modelRules match nothing leaves models level-less (still enumerable)", () => {
    const catalog = catalogVariant((c) => {
      (c.config as { modelConfigRules: { modelRules: unknown[] } }).modelConfigRules.modelRules = [];
    });
    const providers = enumerateZcodeRegistry(catalog, dualFormPersonalConfig(), dualFormCredentials());
    expect(providers[0]!.models).toEqual([
      { modelId: "GLM-5.3", levels: [] },
      { modelId: "GLM-5.3-Flash", levels: [] },
    ]);
  });

  it("a personal enabled:true re-enables a template-disabled model (last-write-wins overlay)", () => {
    // The catalog's templateModelRules disables GLM-5V-Turbo on
    // bigmodel-standard-api; a personal providerModelRules entry with
    // enabled:true re-enables it, mirroring composeEffective's
    // [...builtin, ...personal] overlay order.
    const personal = dualFormPersonalConfig();
    (personal.config as { modelConfigRules: { providerModelRules: unknown[] } }).modelConfigRules
      .providerModelRules.push({
        modelId: "GLM-5V-Turbo",
        config: { enabled: true },
        providerId: "bigmodel-standard-api",
      });
    const providers = enumerateZcodeRegistry(catalogFixture(), personal, dualFormCredentials());
    const standard = providers.find((p) => p.providerId === "bigmodel-standard-api")!;
    expect(standard.models.map((m) => m.modelId)).toEqual([
      "GLM-5.3",
      "GLM-5.3-Flash",
      "GLM-5V-Turbo",
    ]);
    expect(standard.models[2]!.levels).toEqual(["disabled", "enabled"]);
  });

  it("malformed inputs degrade to an empty registry (never throws)", () => {
    expect(enumerateZcodeRegistry(null, null, null)).toEqual([]);
    expect(enumerateZcodeRegistry({}, {}, {})).toEqual([]);
    expect(
      enumerateZcodeRegistry({ schemaVersion: 1, config: {} }, { config: {} }, {}),
    ).toEqual([]);
  });
});

// ─── Catalog resolution (unchanged mechanics) ─────────────────────────────

describe("zcodeBundledCatalogPathForCjs", () => {
  it("derives <install>/resources/config/provider/zcode-builtin.json from the cjs", () => {
    const win = zcodeBundledCatalogPathForCjs("C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs");
    expect(win).toBe(
      join("C:\\Program Files\\ZCode", "resources", "config", "provider", "zcode-builtin.json"),
    );
    const linux = zcodeBundledCatalogPathForCjs("/opt/ZCode/resources/glm/zcode.cjs");
    expect(linux.endsWith(join("config", "provider", "zcode-builtin.json"))).toBe(true);
    expect(dirname(dirname(dirname(linux))).replace(/\\/g, "/")).toBe("/opt/ZCode/resources");
  });
});

describe("resolveZcodeCatalogFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-catalog-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Minimal schema-valid body (the shape gate only needs schemaVersion+config). */
  const minimalCatalog = { schemaVersion: 1, config: {} };

  function writeInstall(dirName: string, body: unknown): { cjs: string } {
    const install = join(dir, dirName);
    mkdirSync(join(install, "resources", "glm"), { recursive: true });
    mkdirSync(join(install, "resources", "config", "provider"), { recursive: true });
    const cjs = join(install, "resources", "glm", "zcode.cjs");
    writeFileSync(cjs, "");
    writeFileSync(join(install, "resources", "config", "provider", "zcode-builtin.json"), JSON.stringify(body));
    return { cjs };
  }

  function writeCache(version: string, endpoint: string, body: unknown): void {
    const p = join(dir, "cache", zcodeCachePlatform(), version, endpoint);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "zcode-builtin.json"), JSON.stringify(body));
  }

  it("prefers the install-bundled file (version-consistent with the cjs)", () => {
    writeCache("3.14.3", "endpoint-a", minimalCatalog);
    const { cjs } = writeInstall("install", minimalCatalog);
    const catalog = resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") });
    expect(catalog!.source).toBe("install");
    expect(catalog!.path).toBe(join(dirname(dirname(cjs)), "config", "provider", "zcode-builtin.json"));
  });

  it("falls back to the NEWEST cache version by freshness (3.14.10 > 3.14.9 > 3.9.2)", () => {
    const { cjs } = writeInstall("install-empty", {});
    writeCache("3.9.2", "endpoint-a", minimalCatalog);
    writeCache("3.14.9", "endpoint-a", minimalCatalog);
    writeCache("3.14.10", "endpoint-b", minimalCatalog);
    const catalog = resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") });
    expect(catalog!.source).toBe("cache");
    expect(catalog!.path).toContain("3.14.10");
  });

  it("a schemaVersion other than 1 is rejected (schema gate)", () => {
    const { cjs } = writeInstall("install", { ...minimalCatalog, schemaVersion: 2 });
    expect(resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") })).toBeNull();
  });

  it("nothing readable → null (catalog-unreadable refusal link)", () => {
    const { cjs } = writeInstall("install", { schemaVersion: 1 });
    // config object missing → invalid shape
    expect(resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") })).toBeNull();
  });
});

// ─── Picker id codec ──────────────────────────────────────────────────────

describe("picker id codec", () => {
  it("encodes provider-namespaced ids with and without a level", () => {
    expect(encodeZcodeModelChoice("deepseek", "deepseek-flash", "max")).toBe(
      "deepseek/deepseek-flash/max",
    );
    expect(encodeZcodeModelChoice("new-provider", "Qwen3.6-35B-A3B")).toBe(
      "new-provider/Qwen3.6-35B-A3B",
    );
    expect(encodeZcodeModelChoice("p", "m", null)).toBe("p/m");
  });

  it("decode is structural: the first segment is the providerId; empty segments fail", () => {
    expect(decodeZcodeModelChoice("deepseek/deepseek-flash/max")).toEqual({ providerId: "deepseek" });
    // Model ids containing "/" (openrouter-style) still decode to the provider.
    expect(decodeZcodeModelChoice("my-router/anthropic/claude-fable-5.1")).toEqual({
      providerId: "my-router",
    });
    expect(decodeZcodeModelChoice("deepseek")).toBeNull();
    expect(decodeZcodeModelChoice("deepseek/")).toBeNull();
    expect(decodeZcodeModelChoice("/deepseek-flash")).toBeNull();
    expect(decodeZcodeModelChoice("a//b")).toBeNull();
  });

  it("migrateLegacyZcodeProviderId maps the legacy coding-plan ids one-way", () => {
    expect(migrateLegacyZcodeProviderId("builtin:bigmodel-coding-plan")).toBe(ACCOUNT_PROVIDER_ID);
    expect(migrateLegacyZcodeProviderId("builtin:zai-coding-plan")).toBe(
      "account:zai-individual-coding-plan",
    );
    expect(migrateLegacyZcodeProviderId("deepseek")).toBe("deepseek");
  });
});

// ─── Default chain ────────────────────────────────────────────────────────

describe("resolveZcodeDefaultSelection", () => {
  const registry = () =>
    enumerateZcodeRegistry(catalogFixture(), dualFormPersonalConfig(), dualFormCredentials());

  it("no configured default → first registry provider, first model, highest level (the CLI's fallback)", () => {
    expect(resolveZcodeDefaultSelection(registry(), dualFormPersonalConfig())).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      providerName: "BigModel Individual Coding Plan",
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    });
  });

  it("a valid configured default wins, with the legacy providerId migrated", () => {
    const personal = dualFormPersonalConfig({
      defaultModelSelection: {
        providerId: "builtin:bigmodel-coding-plan",
        modelId: "GLM-5.3-Flash",
        options: { reasoningLevel: "low" },
      },
    });
    expect(resolveZcodeDefaultSelection(registry(), personal)).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      providerName: "BigModel Individual Coding Plan",
      modelId: "GLM-5.3-Flash",
      reasoningLevel: "low",
    });
  });

  it("a configured default on another registry provider is honoured (it still selects)", () => {
    const personal = dualFormPersonalConfig({
      defaultModelSelection: { providerId: "deepseek", modelId: "deepseek-flash" },
    });
    expect(resolveZcodeDefaultSelection(registry(), personal)).toEqual({
      providerId: "deepseek",
      providerName: "DeepSeek",
      modelId: "deepseek-flash",
      // CLI-login-written defaults carry no level; the chain completes the
      // model's highest level.
      reasoningLevel: "max",
    });
  });

  it("a configured default whose provider or level is invalid falls back (never half-applies)", () => {
    const foreign = dualFormPersonalConfig({
      defaultModelSelection: { providerId: "gone", modelId: "GLM-5.3", options: { reasoningLevel: "low" } },
    });
    expect(resolveZcodeDefaultSelection(registry(), foreign)!.modelId).toBe("GLM-5.3");
    const badLevel = dualFormPersonalConfig({
      defaultModelSelection: {
        providerId: ACCOUNT_PROVIDER_ID,
        modelId: "GLM-5.3",
        options: { reasoningLevel: "xhigh" },
      },
    });
    expect(resolveZcodeDefaultSelection(registry(), badLevel)!.reasoningLevel).toBe("max");
  });

  it("a level-less first model defaults without a reasoningLevel; an empty registry yields null", () => {
    const catalog = catalogVariant((c) => {
      (c.config as { modelConfigRules: { modelRules: unknown[] } }).modelConfigRules.modelRules = [];
    });
    const providers = enumerateZcodeRegistry(catalog, dualFormPersonalConfig(), dualFormCredentials());
    expect(resolveZcodeDefaultSelection(providers, dualFormPersonalConfig())).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      providerName: "BigModel Individual Coding Plan",
      modelId: "GLM-5.3",
      reasoningLevel: null,
    });
    expect(resolveZcodeDefaultSelection([], dualFormPersonalConfig())).toBeNull();
  });
});

// ─── Picker state composition ─────────────────────────────────────────────

describe("readZcodePickerState", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-picker-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("F1: ready, provider-namespaced chips with service-name labels, and the resolved Default", () => {
    const f = writeFixtureTree(dir);
    const state = readZcodePickerState({
      cjsPath: f.cjs,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(state.ready).toBe(true);
    expect(state.reason).toBeNull();
    expect(state.defaultChoice).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      providerName: "BigModel Individual Coding Plan",
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    });
    // Same-name model across providers: distinct ids, service name in label.
    const glm53Chips = state.options.filter((o) =>
      o.id.endsWith("/GLM-5.3/low"),
    );
    expect(glm53Chips.map((o) => [o.id, o.label])).toEqual([
      [`${ACCOUNT_PROVIDER_ID}/GLM-5.3/low`, "GLM-5.3 (BigModel Individual Coding Plan, low)"],
      ["bigmodel-standard-api/GLM-5.3/low", "GLM-5.3 (BigModel API, low)"],
    ]);
    // Level-less chips carry no suffix (llama.cpp's Qwen model here has only
    // the base .* table, so it does have levels; assert its chip shape via
    // the disabled level instead).
    expect(state.options).toContainEqual({
      id: "new-provider/Qwen3.6-35B-A3B/disabled",
      label: "Qwen3.6-35B-A3B (llama.cpp, disabled)",
      providerId: "new-provider",
    });
    // Team / start / off-peak never appear in any chip id.
    expect(state.options.every((o) => !/team|start-plan|offpeak/.test(o.id))).toBe(true);
  });

  it("level-less models produce chips without a level suffix", () => {
    const f = writeFixtureTree(dir, {
      catalog: catalogVariant((c) => {
        (c.config as { modelConfigRules: { modelRules: unknown[] } }).modelConfigRules.modelRules =
          [];
      }),
    });
    const state = readZcodePickerState({
      cjsPath: f.cjs,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(state.ready).toBe(true);
    expect(state.options[0]).toEqual({
      id: `${ACCOUNT_PROVIDER_ID}/GLM-5.3`,
      label: "GLM-5.3 (BigModel Individual Coding Plan)",
      providerId: ACCOUNT_PROVIDER_ID,
    });
  });

  it("F2 pure API-key machine: ready with the template's models (regression anchor: v2 rejected this shape)", () => {
    const f = writeFixtureTree(dir, { personal: pureApiKeyPersonalConfig(), credentials: null });
    const state = readZcodePickerState({
      cjsPath: f.cjs,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(state).toMatchObject({ ready: true, reason: null });
    expect(state.options.map((o) => o.id)).toEqual([
      "bigmodel-api/GLM-5.3/low",
      "bigmodel-api/GLM-5.3/high",
      "bigmodel-api/GLM-5.3/max",
      "bigmodel-api/GLM-5.3-Flash/low",
      "bigmodel-api/GLM-5.3-Flash/high",
      "bigmodel-api/GLM-5.3-Flash/max",
    ]);
    expect(state.defaultChoice).toEqual({
      providerId: "bigmodel-api",
      providerName: "BigModel Coding Plan",
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    });
  });

  it("no usable provider anywhere → the single not-ready state with an empty picker", () => {
    // Keyless personal entries + no credentials: nothing keyed remains.
    const personal = pureApiKeyPersonalConfig();
    const rules = (personal.config as {
      providerConfigRules: { providerRules: Array<Record<string, unknown>> };
    }).providerConfigRules.providerRules;
    delete (rules[0]!.config as { access: { apiKey?: string } }).access.apiKey;
    const f = writeFixtureTree(dir, { personal, credentials: null });
    expect(
      readZcodePickerState({
        cjsPath: f.cjs,
        personalConfigPath: f.personalPath,
        credentialsPath: f.credentialsPath,
        cacheRoot: join(dir, "no-cache"),
      }),
    ).toEqual({ ready: false, reason: "no-usable-provider", options: [], defaultChoice: null });
  });

  it("an unreadable catalog → the same single not-ready state (the CLI cannot boot without it)", () => {
    const f = writeFixtureTree(dir);
    rmSync(f.catalogPath, { force: true });
    expect(
      readZcodePickerState({
        cjsPath: f.cjs,
        personalConfigPath: f.personalPath,
        credentialsPath: f.credentialsPath,
        cacheRoot: join(dir, "no-cache"),
      }),
    ).toEqual({ ready: false, reason: "no-usable-provider", options: [], defaultChoice: null });
  });
});

// ─── prepareZcodeModelBinding: the per-turn contract ──────────────────────

describe("prepareZcodeModelBinding", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-prepare-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const baseOverrides = (f: FixtureTree) => ({
    personalConfigPath: f.personalPath,
    credentialsPath: f.credentialsPath,
    cacheRoot: join(dir, "no-cache"),
  });

  it("explicit account pick: exact selection into a temp clone; both real files byte-identical (zero-write)", () => {
    const f = writeFixtureTree(dir);
    const personalBefore = readFileSync(f.personalPath, "utf8");
    const credentialsBefore = readFileSync(f.credentialsPath, "utf8");
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-5.3/high`,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      modelId: "GLM-5.3",
      reasoningLevel: "high",
    });
    expect(result.builtinCatalogPath).toBe(f.catalogPath);
    const clone = JSON.parse(readFileSync(result.clonePath, "utf8")) as {
      config: { defaultModelSelection: unknown; providerOrder: string[] };
    };
    expect(clone.config.defaultModelSelection).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    });
    // The clone keeps the rest of the personal config (provider rules ride along).
    expect(clone.config.providerOrder).toEqual([
      "deepseek",
      "bigmodel-standard-api",
      "new-provider",
      WECHAT_PROVIDER_ID,
    ]);
    // Zero-write contract: the user's real files are untouched (the paired
    // identity key already exists, so the bridge writes nothing).
    expect(readFileSync(f.personalPath, "utf8")).toBe(personalBefore);
    expect(readFileSync(f.credentialsPath, "utf8")).toBe(credentialsBefore);
  });

  it("default pick → the registry default (first provider, first model, highest level)", () => {
    const f = writeFixtureTree(dir);
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    });
  });

  it("default pick honours a valid CLI-written configured default (legacy id migrated)", () => {
    const f = writeFixtureTree(dir, {
      personal: dualFormPersonalConfig({
        defaultModelSelection: {
          providerId: "builtin:bigmodel-coding-plan",
          modelId: "GLM-5.3-Flash",
          options: { reasoningLevel: "low" },
        },
      }),
    });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: ACCOUNT_PROVIDER_ID,
      modelId: "GLM-5.3-Flash",
      reasoningLevel: "low",
    });
  });

  it("a level-less model binds without a reasoningLevel; the clone omits the option", () => {
    const f = writeFixtureTree(dir, {
      catalog: catalogVariant((c) => {
        (c.config as { modelConfigRules: { modelRules: unknown[] } }).modelConfigRules.modelRules =
          [];
      }),
    });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "new-provider/Qwen3.6-35B-A3B",
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: "new-provider",
      modelId: "Qwen3.6-35B-A3B",
      reasoningLevel: null,
    });
    const clone = JSON.parse(readFileSync(result.clonePath, "utf8")) as {
      config: { defaultModelSelection: unknown };
    };
    expect(clone.config.defaultModelSelection).toEqual({
      providerId: "new-provider",
      modelId: "Qwen3.6-35B-A3B",
    });
  });

  it("a model id containing '/' splits by validation (openrouter-style custom provider)", () => {
    const personal = dualFormPersonalConfig();
    (personal.config as { providerConfigRules: { providerRules: unknown[] } }).providerConfigRules
      .providerRules.push({
        providerId: "my-router",
        providerName: "My OpenRouter",
        config: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "fixture-router-key" },
          personalModelIds: ["anthropic/claude-fable-5.1", "deepseek/deepseek-v4-pro"],
        },
      });
    const f = writeFixtureTree(dir, { personal });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "my-router/anthropic/claude-fable-5.1/high",
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: "my-router",
      modelId: "anthropic/claude-fable-5.1",
      reasoningLevel: "high",
    });
    // Level-less variant of the same slash id.
    const levelless = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "my-router/anthropic/claude-fable-5.1",
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(levelless.ok && levelless.selection.reasoningLevel).toBeNull();
  });

  it("identity bridge (add-only): an explicit account pick with the api-key key but no identity key gains exactly that key", () => {
    const credentials = dualFormCredentials();
    delete credentials[`account-provider:${ACCOUNT_PROVIDER_ID}:identity`];
    const f = writeFixtureTree(dir, { credentials });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-5.3/high`,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    const after = JSON.parse(readFileSync(f.credentialsPath, "utf8")) as Record<string, string>;
    expect(after).toEqual({
      ...credentials,
      // The identity value is the account id embedded in the GUI's own
      // api-key key name; nothing else changed.
      [`account-provider:${ACCOUNT_PROVIDER_ID}:identity`]: ACCOUNT_ID,
    });
    // Idempotent: a second preparation finds the key and writes nothing.
    const second = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-5.3/high`,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(second.ok).toBe(true);
    expect(readFileSync(f.credentialsPath, "utf8")).toBe(JSON.stringify(after, null, 2));
  });

  it("personal targets never touch the credential store (snapshot compare)", () => {
    const f = writeFixtureTree(dir);
    const before = readFileSync(f.credentialsPath, "utf8");
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "deepseek/deepseek-v4-pro/max",
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(f.credentialsPath, "utf8")).toBe(before);
  });

  it("a stale identity value (names no api-key key) refuses with provider-no-access and writes nothing", () => {
    const credentials = dualFormCredentials();
    credentials[`account-provider:${ACCOUNT_PROVIDER_ID}:identity`] = "10000000000000009";
    const f = writeFixtureTree(dir, { credentials });
    const before = readFileSync(f.credentialsPath, "utf8");
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-5.3/high`,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result).toMatchObject({ ok: false, code: "provider-no-access" });
    expect(readFileSync(f.credentialsPath, "utf8")).toBe(before);
  });

  it("each refusal link fires with an actionable message", () => {
    const f = writeFixtureTree(dir);
    const base = {
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    };
    // 1. Catalog unreadable (install file removed, no cache).
    rmSync(f.catalogPath, { force: true });
    const noCatalog = prepareZcodeModelBinding({ ...base });
    expect(noCatalog).toMatchObject({ ok: false, code: "catalog-unreadable" });
    writeFileSync(f.catalogPath, JSON.stringify(catalogFixture()));
    // 2. Provider config unreadable.
    const noPersonal = prepareZcodeModelBinding({
      ...base,
      personalConfigPath: join(dir, "no-personal.json"),
    });
    expect(noPersonal).toMatchObject({ ok: false, code: "provider-config-unreadable" });
    // 3. No usable provider at all (keyless F2 + no credentials).
    const keyless = pureApiKeyPersonalConfig();
    delete (
      (keyless.config as { providerConfigRules: { providerRules: Array<Record<string, unknown>> } })
        .providerConfigRules.providerRules[0]!.config as { access: { apiKey?: string } }
    ).access.apiKey;
    const keylessPath = join(dir, "keyless-personal.json");
    writeFileSync(keylessPath, JSON.stringify(keyless));
    const none = prepareZcodeModelBinding({
      ...base,
      personalConfigPath: keylessPath,
      credentialsPath: join(dir, "no-credentials.json"),
    });
    expect(none).toMatchObject({ ok: false, code: "no-usable-provider" });
    // 4. Account provider known, api-key credential missing.
    const noApiKey = dualFormCredentials();
    delete noApiKey[`account-provider:coding-plan:${ACCOUNT_PROVIDER_ID}:account:${ACCOUNT_ID}:api-key`];
    delete noApiKey[`account-provider:${ACCOUNT_PROVIDER_ID}:identity`];
    const noApiKeyPath = join(dir, "no-apikey.json");
    writeFileSync(noApiKeyPath, JSON.stringify(noApiKey));
    const unauthorized = prepareZcodeModelBinding({
      ...base,
      credentialsPath: noApiKeyPath,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-5.3/high`,
    });
    expect(unauthorized).toMatchObject({ ok: false, code: "provider-no-access" });
    // 5. Model not on the provider (and a bare v2-era stale id).
    const notOnProvider = prepareZcodeModelBinding({
      ...base,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-9/high`,
    });
    expect(notOnProvider).toMatchObject({ ok: false, code: "model-not-on-provider" });
    const staleBare = prepareZcodeModelBinding({ ...base, model: "GLM-5.3" });
    expect(staleBare).toMatchObject({ ok: false, code: "model-not-on-provider" });
    // 6. Level unsupported for the model.
    const badLevel = prepareZcodeModelBinding({
      ...base,
      model: `${ACCOUNT_PROVIDER_ID}/GLM-5.3/medium`,
    });
    expect(badLevel).toMatchObject({ ok: false, code: "level-unsupported" });
    // Every refusal message carries an action and the ZCode: prefix.
    for (const r of [noCatalog, noPersonal, none, unauthorized, notOnProvider, staleBare, badLevel]) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.message).toMatch(/[Rr]etry\.|[Rr]escan|[Pp]ick again|log in/);
      expect(r.message.startsWith("ZCode:")).toBe(true);
    }
  });

  it("a personal provider that exists but is not usable refuses with provider-no-access (not a stale pick)", () => {
    const personal = dualFormPersonalConfig();
    const deepseek = (personal.config as {
      providerConfigRules: { providerRules: Array<Record<string, unknown>> };
    }).providerConfigRules.providerRules.find((r) => r.providerId === "deepseek") as {
      config: { access: { apiKey?: string } };
    };
    delete deepseek.config.access.apiKey;
    const f = writeFixtureTree(dir, { personal });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "deepseek/deepseek-flash/max",
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result).toMatchObject({ ok: false, code: "provider-no-access" });
  });

  it("setting.json is not part of the contract: a stale plan-era file changes nothing", () => {
    const f = writeFixtureTree(dir);
    // v2-era keys; v3 never reads this file.
    writeFileSync(
      join(dir, "setting.json"),
      JSON.stringify({
        providerFamilyDomain: "zai",
        modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
      }),
    );
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      ...baseOverrides(f),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The zai keys in setting.json cannot steer anything: the registry
    // default is still the paired bigmodel plan.
    expect(result.selection.providerId).toBe(ACCOUNT_PROVIDER_ID);
  });
});

// ─── The binding discriminator ────────────────────────────────────────────
//
// A mis-bound fresh turn silently reroutes to the first personal provider
// and fails at its gateway (ProviderBusinessError 400, exit 1); a correctly
// bound turn completes (resultType success, exit 0). Both arms are pinned
// below with fixtures captured from real CLI runs.

describe("binding discriminator (verified)", () => {
  const wrongBindingStderr = readFileSync(
    join(here, "__fixtures__", "zcode-wrong-binding.stderr.txt"),
    "utf8",
  );
  // The exit-0 arm's captured evidence: the turn.completed + result lines of
  // a run that completed under the paired redirect.
  const rightBindingStdout = readFileSync(
    join(here, "__fixtures__", "zcode-right-binding.stdout.jsonl"),
    "utf8",
  );

  it("the wrong-binding evidence: gateway 400 on a reasoning level routed to a non-plan provider", () => {
    expect(wrongBindingStderr).toContain("providerCode: 400");
    expect(wrongBindingStderr).toContain("'input': 'max'");
    expect(wrongBindingStderr).toContain(`providerId: '${WECHAT_PROVIDER_ID}'`);
  });

  it("the right-binding evidence: a bound turn completes (resultType success, exit 0)", () => {
    const completed = rightBindingStdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { type?: string; payload?: { resultType?: string; response?: string }; response?: string });
    const turn = completed.find((l) => l.type === "turn.completed");
    expect(turn?.payload?.resultType).toBe("success");
    const result = completed.find((l) => l.type === "result");
    expect(result?.response).toBe("PROBE_OK");
  });

  it("the binding we write is the verified-good shape: registry provider + explicit level, never the fallback provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-discriminator-"));
    try {
      const f = writeFixtureTree(dir);
      const result = prepareZcodeModelBinding({
        cjsPath: f.cjs,
        model: encodeZcodeModelChoice(ACCOUNT_PROVIDER_ID, "GLM-5.3", "high"),
        attachDir: f.attachDir,
        personalConfigPath: f.personalPath,
        credentialsPath: f.credentialsPath,
        cacheRoot: join(dir, "no-cache"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The registry triple (provider, model, explicit level)…
      expect(result.selection.providerId).toBe(ACCOUNT_PROVIDER_ID);
      expect(result.selection.modelId).toBe("GLM-5.3");
      expect(result.selection.reasoningLevel).toBe("high");
      // …and never the 400-ing fallback provider from the stderr fixture.
      expect(result.selection.providerId).not.toBe(WECHAT_PROVIDER_ID);
      expect(wrongBindingStderr).not.toContain(result.selection.providerId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zcodeProviderEnvPairSet", () => {
  it("true only when both provider-config vars are set (user's zero-code reroute)", () => {
    expect(
      zcodeProviderEnvPairSet({
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/tmp/a.json",
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/tmp/b.json",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      zcodeProviderEnvPairSet({
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/tmp/a.json",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(zcodeProviderEnvPairSet({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
