// Unit tests for the per-turn model binding (#41 / spec #34 v2): plan
// selection from the GUI settings (current keys + legacy fallback), catalog
// resolution (install-bundled first, cache by freshness), the model×level
// table from modelRules, the four-link refusal chain, the temp-clone write
// with the zero-write contract on the user's real config, and the
// live-proven binding discriminator.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectZcodeFamilySelections,
  decodeZcodeModelChoice,
  encodeZcodeModelChoice,
  migrateLegacyZcodeProviderId,
  parseZcodeCatalogPlan,
  parseZcodePlanSelection,
  prepareZcodeModelBinding,
  readZcodeLoggedInFamilies,
  readZcodePlanModelOptions,
  readZcodeReadyState,
  resolveZcodeCatalogFile,
  zcodeBundledCatalogPathForCjs,
  zcodeCachePlatform,
  zcodePlanProviderId,
  zcodeProviderEnvPairSet,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "./zcode-model-binding";

const here = dirname(fileURLToPath(import.meta.url));

// ─── Shared fixture shapes (mirroring the live install's files) ─────────────

/** Live-captured legacy setting.json shape (2026-09-24, ZCode 3.14.3 that
 * migrated in-memory but retained the legacy fields on disk). */
const LEGACY_SETTING = {
  modelProviderFamilyModes: { zai: "oauth", bigmodel: "oauth" },
  modelProviderFamilySelectedKeys: {
    zai: "coding-plan:builtin:zai-coding-plan",
    bigmodel: "coding-plan:builtin:bigmodel-coding-plan",
  },
};

const MODERN_SETTING = {
  providerFamilyDomain: "bigmodel",
  providerFamilyConnectionSelections: {
    zai: { kind: "individual-coding-plan" },
    bigmodel: { kind: "individual-coding-plan" },
  },
};

/** Minimal catalog with the REAL rule shapes from the install's
 * zcode-builtin.json: `.*` base rule, a GLM-5.2-specific rule whose values
 * must override the base (array-order overlay), and one disabled model entry. */
function catalogFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    revision: "test",
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "account:bigmodel-individual-coding-plan",
            providerName: "BigModel Individual Coding Plan",
            config: {
              group: "bigmodel-family",
              builtinModelIds: ["GLM-5.2", "GLM-5.3", "GLM-5.3-Flash"],
              access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" },
            },
          },
        ],
      },
      modelConfigRules: {
        modelRules: [
          {
            modelMatch: ".*",
            config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } },
          },
          {
            modelMatch: ".*GLM-5\\.2(?:[.\\-:/\\[].*)?",
            config: { optionSpecs: { reasoningLevel: { values: ["disabled", "high", "max"] } } },
          },
          {
            modelMatch: ".*GLM-5\\.3-Flash.*",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "medium"] } } },
          },
        ],
        builtinProviderModelRules: [
          { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.2", config: { enabled: true } },
          { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3", config: { enabled: true } },
          { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash", config: { enabled: false } },
        ],
      },
    },
  };
}

function personalConfigFixture(extraConfig: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["new-provider", "deepseek", "42c7e100-ae54-4b64-8d9d-45ae140c57db"],
      providerRules: [
        { providerId: "42c7e100-ae54-4b64-8d9d-45ae140c57db", providerName: "custom gateway", config: { access: { type: "api-key", apiKey: "sk-x" } } },
      ],
      ...extraConfig,
    },
  };
}

// ─── Plan selection ─────────────────────────────────────────────────────────

describe("collectZcodeFamilySelections", () => {
  it("reads the modern providerFamilyConnectionSelections keys", () => {
    const selections = collectZcodeFamilySelections(MODERN_SETTING);
    expect(selections.get("zai")).toBe("individual-coding-plan");
    expect(selections.get("bigmodel")).toBe("individual-coding-plan");
  });

  it("modern keys win wholesale — legacy fields are ignored when present", () => {
    const setting = {
      ...LEGACY_SETTING,
      providerFamilyConnectionSelections: { bigmodel: { kind: "team-coding-plan", productId: "p", organizationId: "o", projectId: "j" } },
    };
    const selections = collectZcodeFamilySelections(setting);
    expect(selections.size).toBe(1);
    expect(selections.get("bigmodel")).toBe("team-coding-plan");
  });

  it("team selection requires the three identity ids", () => {
    const selections = collectZcodeFamilySelections({
      providerFamilyConnectionSelections: {
        bigmodel: { kind: "team-coding-plan", productId: "", organizationId: "o", projectId: "j" },
        zai: { kind: "start-plan" },
      },
    });
    expect(selections.has("bigmodel")).toBe(false);
    expect(selections.get("zai")).toBe("start-plan");
  });

  it("migrates the legacy keys (coding-plan + start-plan + team shapes)", () => {
    const selections = collectZcodeFamilySelections({
      modelProviderFamilySelectedKeys: {
        zai: "coding-plan:builtin:zai-start-plan",
        bigmodel: "team-plan:builtin:bigmodel-coding-plan:p%201:o:j",
      },
    });
    expect(selections.get("zai")).toBe("start-plan");
    expect(selections.get("bigmodel")).toBe("team-coding-plan");
  });

  it("skips a legacy team key without three non-empty parts, and apiKey-mode families", () => {
    const selections = collectZcodeFamilySelections({
      modelProviderFamilyModes: { zai: "apiKey", bigmodel: "oauth" },
      modelProviderFamilySelectedKeys: {
        zai: "coding-plan:builtin:zai-coding-plan",
        bigmodel: "team-plan:builtin:bigmodel-coding-plan:only-two",
      },
    });
    expect(selections.size).toBe(0);
  });

  it("returns an empty map for settings without any selection keys", () => {
    expect(collectZcodeFamilySelections({ locale: "zh-CN" }).size).toBe(0);
    expect(collectZcodeFamilySelections(null).size).toBe(0);
  });
});

describe("parseZcodePlanSelection", () => {
  it("providerFamilyDomain picks the family; providerId maps kind → account id", () => {
    const plan = parseZcodePlanSelection(MODERN_SETTING);
    expect(plan).toEqual({
      family: "bigmodel",
      kind: "individual-coding-plan",
      providerId: "account:bigmodel-individual-coding-plan",
    });
  });

  it("domain set but that family has no selection → null (refuse, never guess)", () => {
    expect(
      parseZcodePlanSelection({
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
      }),
    ).toBeNull();
  });

  it("domain absent + single selected family → that family (even logged out)", () => {
    const plan = parseZcodePlanSelection(LEGACY_SETTING, new Set());
    // zai AND bigmodel are both selected here — with no login signal the GUI's
    // family order decides; with exactly one login it wins instead.
    expect(plan!.family).toBe("zai");
    const loggedIn = parseZcodePlanSelection(LEGACY_SETTING, new Set(["bigmodel" as const]));
    expect(loggedIn!.family).toBe("bigmodel");
  });

  it("a single selected family resolves without login signal", () => {
    const plan = parseZcodePlanSelection({
      modelProviderFamilySelectedKeys: { bigmodel: "coding-plan:builtin:bigmodel-coding-plan" },
    });
    expect(plan!.providerId).toBe("account:bigmodel-individual-coding-plan");
  });

  it("no selections at all → null", () => {
    expect(parseZcodePlanSelection({})).toBeNull();
  });

  it("zcodePlanProviderId covers every kind", () => {
    expect(zcodePlanProviderId("zai", "start-plan")).toBe("account:zai-start-plan");
    expect(zcodePlanProviderId("bigmodel", "team-coding-plan")).toBe("account:bigmodel-team-coding-plan");
  });
});

describe("readZcodeLoggedInFamilies / readZcodeReadyState", () => {
  it("only oauth:<family>:access_token KEY NAMES count as the login signal", () => {
    const families = readZcodeLoggedInFamilies({
      "oauth:bigmodel:access_token": "enc:xxx",
      "oauth:bigmodel:user_info": "enc:xxx",
      "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:1:api-key": "enc:xxx",
      zcodejwttoken: "enc:xxx",
    });
    expect([...families]).toEqual(["bigmodel"]);
  });

  describe("with real temp files", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "zcode-binding-test-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("missing setting.json → gui-not-initialized (未开过 GUI)", () => {
      const state = readZcodeReadyState({ settingPath: join(dir, "nope-setting.json") });
      expect(state).toEqual({ ready: false, reason: "gui-not-initialized", plan: null });
    });

    it("setting without selection keys → not-logged-in", () => {
      const settingPath = join(dir, "setting.json");
      writeFileSync(settingPath, JSON.stringify({ locale: "zh-CN" }));
      const state = readZcodeReadyState({ settingPath });
      expect(state.ready).toBe(false);
      expect(state.reason).toBe("not-logged-in");
    });

    it("plan resolved but family has no oauth token → not-logged-in (plan still named)", () => {
      const settingPath = join(dir, "setting.json");
      writeFileSync(settingPath, JSON.stringify(MODERN_SETTING));
      const credentialsPath = join(dir, "credentials.json");
      writeFileSync(credentialsPath, JSON.stringify({ "oauth:zai:access_token": "enc:x" }));
      const state = readZcodeReadyState({ settingPath, credentialsPath });
      expect(state.ready).toBe(false);
      expect(state.reason).toBe("not-logged-in");
      expect(state.plan!.providerId).toBe("account:bigmodel-individual-coding-plan");
    });

    it("plan + oauth token → ready", () => {
      const settingPath = join(dir, "setting.json");
      writeFileSync(settingPath, JSON.stringify(LEGACY_SETTING));
      const credentialsPath = join(dir, "credentials.json");
      writeFileSync(credentialsPath, JSON.stringify({ "oauth:bigmodel:access_token": "enc:x" }));
      const state = readZcodeReadyState({ settingPath, credentialsPath });
      expect(state.ready).toBe(true);
      expect(state.reason).toBeNull();
      expect(state.plan!.family).toBe("bigmodel");
    });
  });
});

// ─── Catalog resolution ─────────────────────────────────────────────────────

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
    writeCache("3.14.3", "endpoint-a", catalogFixture());
    const { cjs } = writeInstall("install", catalogFixture());
    const catalog = resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") });
    expect(catalog!.source).toBe("install");
    expect(catalog!.path).toBe(join(dirname(dirname(cjs)), "config", "provider", "zcode-builtin.json"));
  });

  it("falls back to the NEWEST cache version by freshness (3.14.10 > 3.14.9 > 3.9.2)", () => {
    const { cjs } = writeInstall("install-empty", {});
    writeCache("3.9.2", "endpoint-a", catalogFixture());
    writeCache("3.14.9", "endpoint-a", catalogFixture());
    writeCache("3.14.10", "endpoint-b", catalogFixture());
    const catalog = resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") });
    expect(catalog!.source).toBe("cache");
    expect(catalog!.path).toContain("3.14.10");
  });

  it("a schemaVersion other than 1 is rejected (schema gate)", () => {
    const bad = { ...catalogFixture(), schemaVersion: 2 };
    const { cjs } = writeInstall("install", bad);
    expect(resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") })).toBeNull();
  });

  it("nothing readable → null (catalog-unreadable refusal link)", () => {
    const { cjs } = writeInstall("install", { schemaVersion: 1 });
    // config object missing → invalid shape
    expect(resolveZcodeCatalogFile({ cjsPath: cjs, cacheRoot: join(dir, "cache") })).toBeNull();
  });
});

// ─── Model × level table ────────────────────────────────────────────────────

describe("parseZcodeCatalogPlan", () => {
  it("last matching modelRules rule wins (array-order overlay, case-insensitive full match)", () => {
    const plan = parseZcodeCatalogPlan(catalogFixture(), "account:bigmodel-individual-coding-plan");
    expect(plan.models).toEqual([
      { modelId: "GLM-5.2", levels: ["disabled", "high", "max"] },
      { modelId: "GLM-5.3", levels: ["disabled", "enabled"] },
    ]);
  });

  it("an explicit enabled:false drops the model; a missing entry keeps it on", () => {
    const catalog = catalogFixture() as {
      config: { modelConfigRules: { builtinProviderModelRules: Array<Record<string, unknown>> } };
    };
    // GLM-5.3 has an explicit enabled:true entry; drop it entirely — the model
    // must stay listed (rules are an override table).
    catalog.config.modelConfigRules.builtinProviderModelRules =
      catalog.config.modelConfigRules.builtinProviderModelRules.filter(
        (r) => !(r.modelId === "GLM-5.3"),
      );
    const plan = parseZcodeCatalogPlan(catalog, "account:bigmodel-individual-coding-plan");
    expect(plan.models.map((m) => m.modelId)).toEqual(["GLM-5.2", "GLM-5.3"]);
  });

  it("unknown provider or malformed catalog → empty models", () => {
    expect(parseZcodeCatalogPlan(catalogFixture(), "account:unknown").models).toEqual([]);
    expect(parseZcodeCatalogPlan(null, "account:bigmodel-individual-coding-plan").models).toEqual([]);
  });
});

// ─── Picker id codec + legacy id migration ──────────────────────────────────

describe("picker id codec", () => {
  it("round-trips a (modelId, level) pair", () => {
    const id = encodeZcodeModelChoice("GLM-5.2", "high");
    expect(id).toBe("GLM-5.2/high");
    expect(decodeZcodeModelChoice(id)).toEqual({ modelId: "GLM-5.2", reasoningLevel: "high" });
  });

  it("rejects ids without a level suffix (plain model ids are NOT valid picks)", () => {
    expect(decodeZcodeModelChoice("GLM-5.2")).toBeNull();
    expect(decodeZcodeModelChoice("default")).toBeNull();
    expect(decodeZcodeModelChoice("/high")).toBeNull();
    expect(decodeZcodeModelChoice("GLM-5.2/")).toBeNull();
  });
});

describe("readZcodePlanModelOptions (detect-surface composition)", () => {
  it("expands the plan's models into model×level chips with encoded ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-plan-options-"));
    try {
      const install = join(dir, "install");
      mkdirSync(join(install, "resources", "glm"), { recursive: true });
      mkdirSync(join(install, "resources", "config", "provider"), { recursive: true });
      const cjs = join(install, "resources", "glm", "zcode.cjs");
      writeFileSync(cjs, "");
      writeFileSync(
        join(install, "resources", "config", "provider", "zcode-builtin.json"),
        JSON.stringify(catalogFixture()),
      );
      const plan = parseZcodePlanSelection(MODERN_SETTING);
      expect(plan).not.toBeNull();
      const options = readZcodePlanModelOptions({ cjsPath: cjs, plan: plan! });
      expect(options).toEqual([
        { id: "GLM-5.2/disabled", label: "GLM-5.2 (disabled)", providerId: "account:bigmodel-individual-coding-plan" },
        { id: "GLM-5.2/high", label: "GLM-5.2 (high)", providerId: "account:bigmodel-individual-coding-plan" },
        { id: "GLM-5.2/max", label: "GLM-5.2 (max)", providerId: "account:bigmodel-individual-coding-plan" },
        { id: "GLM-5.3/disabled", label: "GLM-5.3 (disabled)", providerId: "account:bigmodel-individual-coding-plan" },
        { id: "GLM-5.3/enabled", label: "GLM-5.3 (enabled)", providerId: "account:bigmodel-individual-coding-plan" },
      ]);
      // Unreadable catalog → empty chips (caller keeps the DEFAULT floor).
      rmSync(join(install, "resources", "config", "provider", "zcode-builtin.json"), { force: true });
      expect(readZcodePlanModelOptions({ cjsPath: cjs, plan: plan!, cacheRoot: join(dir, "no-cache") })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migrateLegacyZcodeProviderId", () => {
  it("maps the legacy coding-plan ids one-way; everything else passes through", () => {
    expect(migrateLegacyZcodeProviderId("builtin:bigmodel-coding-plan")).toBe(
      "account:bigmodel-individual-coding-plan",
    );
    expect(migrateLegacyZcodeProviderId("builtin:zai-coding-plan")).toBe("account:zai-individual-coding-plan");
    expect(migrateLegacyZcodeProviderId("deepseek")).toBe("deepseek");
  });
});

// ─── prepareZcodeModelBinding: the per-turn contract ────────────────────────

describe("prepareZcodeModelBinding", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zcode-prepare-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fixtureTree(extraPersonalConfig: Record<string, unknown> = {}): {
    cjs: string;
    settingPath: string;
    personalPath: string;
    credentialsPath: string;
    attachDir: string;
  } {
    const { cjs } = (function writeInstall() {
      const install = join(dir, "install");
      mkdirSync(join(install, "resources", "glm"), { recursive: true });
      mkdirSync(join(install, "resources", "config", "provider"), { recursive: true });
      const cjsPath = join(install, "resources", "glm", "zcode.cjs");
      writeFileSync(cjsPath, "");
      writeFileSync(
        join(install, "resources", "config", "provider", "zcode-builtin.json"),
        JSON.stringify(catalogFixture()),
      );
      return { cjs: cjsPath };
    })();
    const settingPath = join(dir, "setting.json");
    writeFileSync(settingPath, JSON.stringify(MODERN_SETTING));
    const personalPath = join(dir, "provider_config.json");
    writeFileSync(personalPath, JSON.stringify(personalConfigFixture(extraPersonalConfig)));
    // Mirrors the GUI-written credential keys: an oauth login token plus the
    // coding-plan api-key key the identity bridge derives from (values are
    // opaque — only KEY NAMES matter to the adapter).
    const credentialsPath = join(dir, "credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({
      "oauth:bigmodel:access_token": "enc:v1:fake",
      "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:41641738601171874:api-key": "enc:v1:fake",
      "account-provider:coding-plan:account:bigmodel-team-coding-plan:account:41641738601171874:api-key": "enc:v1:fake",
    }));
    const attachDir = join(dir, "attach");
    mkdirSync(attachDir, { recursive: true });
    return { cjs, settingPath, personalPath, credentialsPath, attachDir };
  }

  it("explicit pick: writes the exact selection into a temp clone; the real config file is UNTOUCHED (zero-write snapshot)", () => {
    const f = fixtureTree();
    const before = readFileSync(f.personalPath, "utf8");
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "GLM-5.2/high",
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.2",
      reasoningLevel: "high",
    });
    expect(result.builtinCatalogPath).toBe(
      join(dirname(dirname(f.cjs)), "config", "provider", "zcode-builtin.json"),
    );
    const clone = JSON.parse(readFileSync(result.clonePath, "utf8")) as {
      config: { defaultModelSelection: unknown; providerOrder: string[] };
    };
    expect(clone.config.defaultModelSelection).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: "high" },
    });
    // The clone keeps the rest of the personal config (provider rules ride along).
    expect(clone.config.providerOrder).toEqual(["new-provider", "deepseek", "42c7e100-ae54-4b64-8d9d-45ae140c57db"]);
    // ZERO-WRITE contract: the user's real file is byte-identical.
    expect(readFileSync(f.personalPath, "utf8")).toBe(before);

    // Identity bridge (#41 fix): a temp ZCODE_DATA_BASE_DIR credentials clone
    // carries a PLAINTEXT identity key derived from the GUI's api-key key name
    // (the headless registry materializes account providers only with it).
    const credsBefore = readFileSync(f.credentialsPath, "utf8");
    expect(result.dataBaseDir).toBe(join(f.attachDir, "zcode-data"));
    const bridged = JSON.parse(
      readFileSync(join(result.dataBaseDir, ".zcode", "v2", "credentials.json"), "utf8"),
    ) as Record<string, string>;
    expect(bridged["account-provider:account:bigmodel-individual-coding-plan:identity"]).toBe(
      "41641738601171874",
    );
    // The clone keeps the real encrypted values verbatim.
    expect(bridged["oauth:bigmodel:access_token"]).toBe("enc:v1:fake");
    // ZERO-WRITE on credentials too.
    expect(readFileSync(f.credentialsPath, "utf8")).toBe(credsBefore);
  });

  it("no coding-plan api-key credential → credentials-missing refusal (identity bridge has no raw material)", () => {
    const f = fixtureTree();
    writeFileSync(f.credentialsPath, JSON.stringify({ "oauth:bigmodel:access_token": "enc:v1:fake" }));
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result).toMatchObject({ ok: false, code: "credentials-missing" });
    if (result.ok) return;
    expect(result.message).toContain("log in to your Coding Plan");
  });

  it("default pick without a configured default → plan's first model + LAST level (completeNewModelSelection convention)", () => {
    const f = fixtureTree();
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.2",
      reasoningLevel: "max",
    });
  });

  it("default pick honours the GUI's own defaultModelSelection when it validly targets the plan (legacy id migrated)", () => {
    const f = fixtureTree({
      defaultModelSelection: {
        providerId: "builtin:bigmodel-coding-plan",
        modelId: "GLM-5.2",
        options: { reasoningLevel: "high" },
      },
    });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.2",
      reasoningLevel: "high",
    });
  });

  it("a configured default targeting ANOTHER provider falls back to the plan default", () => {
    const f = fixtureTree({
      defaultModelSelection: { providerId: "deepseek", modelId: "deepseek-chat", options: { reasoningLevel: "high" } },
    });
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection.providerId).toBe("account:bigmodel-individual-coding-plan");
  });

  it("each refusal link fires with an actionable message", () => {
    const f = fixtureTree();
    const base = {
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    };
    // 1. GUI keys missing.
    const noSetting = prepareZcodeModelBinding({ ...base, settingPath: join(dir, "no-setting.json") });
    expect(noSetting).toMatchObject({ ok: false, code: "gui-keys-missing" });
    // 2. Catalog unreadable (install file removed, no cache).
    rmSync(join(dirname(dirname(f.cjs)), "config", "provider", "zcode-builtin.json"), { force: true });
    const noCatalog = prepareZcodeModelBinding({ ...base, settingPath: f.settingPath });
    expect(noCatalog).toMatchObject({ ok: false, code: "catalog-unreadable" });
    // Restore for the remaining links.
    writeFileSync(
      join(dirname(dirname(f.cjs)), "config", "provider", "zcode-builtin.json"),
      JSON.stringify(catalogFixture()),
    );
    // 3. Model not in plan.
    const notInPlan = prepareZcodeModelBinding({ ...base, settingPath: f.settingPath, model: "GLM-9/high" });
    expect(notInPlan).toMatchObject({ ok: false, code: "model-not-in-plan" });
    // 4. Level required but unavailable.
    const badLevel = prepareZcodeModelBinding({ ...base, settingPath: f.settingPath, model: "GLM-5.2/medium" });
    expect(badLevel).toMatchObject({ ok: false, code: "level-unavailable" });
    // 5. Personal config unreadable.
    const noPersonal = prepareZcodeModelBinding({
      ...base,
      settingPath: f.settingPath,
      personalConfigPath: join(dir, "no-personal.json"),
    });
    expect(noPersonal).toMatchObject({ ok: false, code: "personal-config-unreadable" });
    // Every refusal message carries an action (retry / pick again guidance).
    for (const r of [noSetting, noCatalog, notInPlan, badLevel, noPersonal]) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.message).toMatch(/[Rr]etry\.|[Rr]escan|[Pp]ick again/);
      expect(r.message.startsWith("ZCode:")).toBe(true);
    }
  });

  it("refuses when the plan's only model has no level table (reasoning-level-missing would silently fall back)", () => {
    const f = fixtureTree();
    const catalog = catalogFixture() as { config: { modelConfigRules: { modelRules: unknown[] } } };
    catalog.config.modelConfigRules.modelRules = []; // no rules → no levels
    writeFileSync(
      join(dirname(dirname(f.cjs)), "config", "provider", "zcode-builtin.json"),
      JSON.stringify(catalog),
    );
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result).toMatchObject({ ok: false, code: "level-unavailable" });
  });

  it("a BARE model id (pre-#41 persisted pick, no level suffix) REFUSES — never silently binds the default", () => {
    const f = fixtureTree();
    const result = prepareZcodeModelBinding({
      cjsPath: f.cjs,
      model: "GLM-5.2",
      attachDir: f.attachDir,
      settingPath: f.settingPath,
      personalConfigPath: f.personalPath,
      credentialsPath: f.credentialsPath,
      cacheRoot: join(dir, "no-cache"),
    });
    expect(result).toMatchObject({ ok: false, code: "model-not-in-plan" });
    if (result.ok) return;
    expect(result.message).toContain("stale or malformed");
  });
});

// ─── The live-proven binding discriminator (#41 AC) ─────────────────────────
//
// On the probe host (installed ZCode 3.14.1, CLI bundle 0.16.9) the two arms
// of the discriminator were live-verified 2026-09-21/22:
//   WRONG binding (fresh session, no explicit defaultModelSelection): the
//   CLI's silent registry-fallback picked the FIRST visible provider — the
//   custom WeChat gateway 42c7e100-… — with reasoning 'max' (values.at(-1)),
//   whose gateway answers 400 → exit 1. Captured verbatim below.
//   RIGHT binding (temp clone + defaultModelSelection targeting the plan):
//   exit 0, PROBE_OK (probe provemodel.mjs + diag6.cjs; artifacts in
//   .scratch/zcode-opensource/probe-cli-oneshot/).
// The adapter's written selection must therefore ALWAYS be a plan-provider
// triple with an explicit level — the shape the success arm proved.

describe("binding discriminator (live-proven, 2026-09-21/22)", () => {
  const wrongBindingStderr = readFileSync(
    join(here, "__fixtures__", "zcode-wrong-binding.stderr.txt"),
    "utf8",
  );
  // The exit-0 arm's captured evidence: the turn.completed + result lines of
  // the diag6 run that completed under the paired redirect (probe artifact
  // .scratch/zcode-opensource/probe-cli-oneshot/diag6-stdout.jsonl).
  const rightBindingStdout = readFileSync(
    join(here, "__fixtures__", "zcode-right-binding.stdout.jsonl"),
    "utf8",
  );

  it("the wrong-binding evidence: gateway 400 on reasoning_effort='max' routed to a non-plan provider", () => {
    expect(wrongBindingStderr).toContain("providerCode: 400");
    expect(wrongBindingStderr).toContain("'input': 'max'");
    expect(wrongBindingStderr).toContain("providerId: '42c7e100-ae54-4b64-8d9d-45ae140c57db'");
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

  it("the binding we write is the proven-good shape: plan provider + explicit level, never the fallback provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-discriminator-"));
    try {
      const install = join(dir, "install");
      mkdirSync(join(install, "resources", "glm"), { recursive: true });
      mkdirSync(join(install, "resources", "config", "provider"), { recursive: true });
      const cjs = join(install, "resources", "glm", "zcode.cjs");
      writeFileSync(cjs, "");
      writeFileSync(
        join(install, "resources", "config", "provider", "zcode-builtin.json"),
        JSON.stringify(catalogFixture()),
      );
      const settingPath = join(dir, "setting.json");
      // The probe machine's actual state: legacy keys + bigmodel logged in
      // (credentials key names are the login signal that resolves the family).
      writeFileSync(settingPath, JSON.stringify(LEGACY_SETTING));
      const credentialsPath = join(dir, "credentials.json");
      // Probe machine truth: bigmodel login + the GUI-written coding-plan
      // api-key key (the identity bridge's raw material).
      writeFileSync(credentialsPath, JSON.stringify({
        "oauth:bigmodel:access_token": "enc:x",
        "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:41641738601171874:api-key": "enc:x",
      }));
      const personalPath = join(dir, "provider_config.json");
      writeFileSync(personalPath, JSON.stringify(personalConfigFixture()));
      const attachDir = join(dir, "attach");
      mkdirSync(attachDir, { recursive: true });

      const result = prepareZcodeModelBinding({
        cjsPath: cjs,
        // The exact picker choice the success arm proved: GLM-5.2 at 'high'.
        model: encodeZcodeModelChoice("GLM-5.2", "high"),
        attachDir,
        settingPath,
        personalConfigPath: personalPath,
        credentialsPath,
        cacheRoot: join(dir, "no-cache"),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The proven-good triple (probe temp-provider-config.json, exit 0)…
      expect(result.selection.providerId).toBe("account:bigmodel-individual-coding-plan");
      expect(result.selection.modelId).toBe("GLM-5.2");
      expect(result.selection.reasoningLevel).toBe("high");
      // …and never the 400-ing fallback provider from the stderr fixture.
      expect(result.selection.providerId).not.toBe("42c7e100-ae54-4b64-8d9d-45ae140c57db");
      expect(wrongBindingStderr).not.toContain(result.selection.providerId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zcodeProviderEnvPairSet", () => {
  it("true only when BOTH provider-config vars are set (user's zero-code reroute)", () => {
    expect(
      zcodeProviderEnvPairSet({
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/tmp/a.json",
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/tmp/b.json",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      zcodeProviderEnvPairSet({
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/tmp/a.json",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(zcodeProviderEnvPairSet({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
