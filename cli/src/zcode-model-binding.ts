/**
 * Per-turn model binding for the ZCode CLI one-shot adapter. The model
 * binding follows the plan selected in the ZCode GUI.
 *
 * ZCode's CLI has no `--model` flag. A fresh `-p` session resolves its model
 * from the personal provider config's `config.defaultModelSelection`. When
 * that selection is absent or invalid, the CLI silently falls back to the
 * first visible registry provider with the last reasoning variant, so a
 * mis-bound turn reroutes to a provider the user never chose and fails at
 * its gateway. To prevent that, every turn binds the model explicitly, and
 * any broken link in the resolution chain refuses the spawn with an error
 * that says what to fix.
 *
 * Binding mechanism (verified against the installed CLI): clone the user's
 * `~/.zcode/v2/provider_config.json` to a temp file, write the exact
 * `config.defaultModelSelection` into the clone, and hand the child the
 * paired env vars `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (the clone) and
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (the bundled catalog file validated
 * here, so the CLI reads the same catalog this module validated against).
 * The pair is required by the CLI: passing only one of the two vars is
 * rejected by its pair check (packages/provider-node/src/runtime-paths.ts).
 * The user's real config file is never written. The clone is a per-turn
 * temp file owned by the invoke layer's cleanup.
 *
 * The one real write is the identity bridge. The headless CLI materializes
 * an account Coding-Plan provider only when the real credential store holds
 * its `account-provider:<providerId>:identity` key, which the GUI never
 * writes (only `zcode login` does). Without the key the CLI silently
 * discards the selection and reroutes the turn. The bridge appends that key
 * atomically: idempotent when the stored identity already matches, and a
 * differing stale identity is overwritten. The account id comes from the
 * account id embedded in the GUI's own api-key key name (plaintext;
 * decrypt() passes non-`enc:v1:` values through). A user who ran
 * `zcode login` already has the key and no write happens. Redirecting
 * ZCODE_DATA_BASE_DIR to a temp clone was considered and rejected: it would
 * keep zero user writes but lose GUI session visibility, cold-boot the
 * plugin stack about 10x slower, and require every user to run
 * `zcode login`.
 *
 * Files read (all private ZCode formats): `~/.zcode/v2/setting.json`
 * (plan selection keys, legacy keys as read-boundary fallback), the bundled
 * catalog next to the install (`<install>/resources/config/provider/
 * zcode-builtin.json`, runtime cache as a freshness-ordered second choice;
 * schemaVersion must be 1), and `~/.zcode/v2/credentials.json`. Only key
 * names are read from credentials; the values are encrypted at rest
 * (enc:v1 AES-256-GCM, key from ZCODE_CREDENTIAL_SECRET or a machine-local
 * fallback) and are never read.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
/** Narrow `unknown` to a plain JSON object: not null, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


/** Env var carrying the personal provider config (name from ZCode's runtime-paths.ts). */
export const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
/** Env var carrying the builtin provider catalog (name from ZCode's runtime-paths.ts). */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

/** The two account families (ZCode's ModelProviderFamilyId). */
export type ZcodeFamily = "zai" | "bigmodel";
/** The GUI's per-family connection choices (provider-family-connection-selection.ts). */
export type ZcodePlanKind = "start-plan" | "individual-coding-plan" | "team-coding-plan";
/** GUI family order (MODEL_PROVIDER_FAMILY_SPECS), used as the tie-break. */
const FAMILY_ORDER: readonly ZcodeFamily[] = ["zai", "bigmodel"];

/** Why a detected install is not ready to run turns. */
export type ZcodeNotReadyReason = "gui-not-initialized" | "not-logged-in";

/** The resolved GUI plan: which family, which plan kind, which catalog provider. */
export interface ZcodePlanSelection {
  family: ZcodeFamily;
  kind: ZcodePlanKind;
  /** Catalog provider id (`account:<family>-<kind-slug>`). */
  providerId: string;
}

/** One plan model with its reasoning-level chips (from modelRules). */
export interface ZcodePlanModel {
  modelId: string;
  /** `optionSpecs.reasoningLevel.values` of the last matching rule. May be
   * empty when no rule specifies levels for the model; invoke then refuses
   * because a reasoning model without a level fails CLI validation and
   * silently falls back. */
  levels: string[];
}

/** The bundled catalog file we validated against, and where it came from. */
export interface ZcodeCatalogFile {
  path: string;
  source: "install" | "cache";
  data: unknown;
}

/** The exact binding written into the temp clone (CLI's ModelSelection shape). */
export interface ZcodeModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
}

/** ─── Default paths (self-contained) ─── */

export function defaultZcodeSettingPath(): string {
  return join(homedir(), ".zcode", "v2", "setting.json");
}
export function defaultZcodePersonalConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "provider_config.json");
}
export function defaultZcodeCredentialsPath(): string {
  return join(homedir(), ".zcode", "v2", "credentials.json");
}
export function defaultZcodeRuntimeProviderDir(): string {
  return join(homedir(), ".zcode", "v2", "runtime", "provider");
}

/** ─── Plan selection: current keys first, legacy keys as read-boundary fallback ─── */

function normalizeFamily(value: unknown): ZcodeFamily | null {
  return value === "zai" || value === "bigmodel" ? value : null;
}

function normalizePlanKind(value: unknown): ZcodePlanKind | null {
  return value === "start-plan" || value === "individual-coding-plan" ||
    value === "team-coding-plan"
    ? value
    : null;
}

/** `account:<family>-<provider-slug>` per BUILTIN_MODEL_PROVIDER_IDS. */
export function zcodePlanProviderId(family: ZcodeFamily, kind: ZcodePlanKind): string {
  const slug =
    kind === "start-plan" ? "start-plan"
      : kind === "individual-coding-plan" ? "individual-coding-plan"
        : "team-coding-plan";
  return `account:${family}-${slug}`;
}

/**
 * Collect the per-family connection selections from a decoded setting.json.
 * Current keys win wholesale: when `providerFamilyConnectionSelections` is an
 * object it is the only source (the GUI's own rule, "运行时代码不能再解释旧
 * 导航 key"). Otherwise the legacy `modelProviderFamilySelectedKeys` pair is
 * migrated, mirroring migrateLegacyAccountConnectionSettings (families whose
 * legacy mode is `apiKey` are not an account plan and are skipped). Returns an
 * empty map when no family resolves; callers treat that as the
 * gui-keys-missing / not-logged-in link of the refusal chain. Pure; tolerant.
 */
export function collectZcodeFamilySelections(setting: unknown): Map<ZcodeFamily, ZcodePlanKind> {
  const out = new Map<ZcodeFamily, ZcodePlanKind>();
  if (!isRecord(setting)) return out;
  const modern = setting.providerFamilyConnectionSelections;
  if (isRecord(modern)) {
    for (const family of FAMILY_ORDER) {
      const entry = modern[family];
      if (!isRecord(entry)) continue;
      const kind = normalizePlanKind(entry.kind);
      if (!kind) continue;
      // team selections additionally need the three identity ids; a team entry
      // without them is unusable for binding, so skip it (tolerant, like the
      // GUI schema which rejects rather than defaults them).
      if (
        kind === "team-coding-plan" &&
        (!nonEmptyString(entry.productId) || !nonEmptyString(entry.organizationId) ||
          !nonEmptyString(entry.projectId))
      ) continue;
      out.set(family, kind);
    }
    return out;
  }
  // Legacy fallback.
  const modes = isRecord(setting.modelProviderFamilyModes) ? setting.modelProviderFamilyModes : null;
  const keys = isRecord(setting.modelProviderFamilySelectedKeys)
    ? setting.modelProviderFamilySelectedKeys
    : null;
  if (!keys) return out;
  for (const family of FAMILY_ORDER) {
    if (modes && modes[family] === "apiKey") continue;
    const key = nonEmptyString(keys[family])?.trim();
    if (!key) continue;
    if (key === `coding-plan:builtin:${family}-start-plan`) {
      out.set(family, "start-plan");
    } else if (key === `coding-plan:builtin:${family}-coding-plan`) {
      out.set(family, "individual-coding-plan");
    } else {
      const prefix = `team-plan:builtin:${family}-coding-plan:`;
      if (!key.startsWith(prefix)) continue;
      try {
        const parts = key.slice(prefix.length).split(":").map((p) => decodeURIComponent(p.trim()));
        if (parts.length !== 3 || parts.some((p) => !p)) continue;
        out.set(family, "team-coding-plan");
      } catch {
        // Damaged encoding affects only this family.
      }
    }
  }
  return out;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Resolve the one plan the adapter binds to.
 *
 * Family choice, mirroring the GUI's effective-domain semantics
 * (`providerFamilyDomain ?? derived-from-active-OAuth`):
 *   1. the persisted `providerFamilyDomain` when valid;
 *   2. else, among families with a selection, the single logged-in one
 *      (credentials key names are the headless stand-in for "active OAuth");
 *   3. else the single selected family (covers logged-out detect: the plan is
 *      known, only the login is missing);
 *   4. else (domain absent, multiple selections, none/multiple logged in) the
 *      first family in the GUI's own family order. That corner (two logins,
 *      no persisted domain) has no better headless signal.
 * Returns `null` when no family has a usable selection at all.
 */
export function parseZcodePlanSelection(
  setting: unknown,
  loggedInFamilies: ReadonlySet<ZcodeFamily> = new Set(),
): ZcodePlanSelection | null {
  if (!isRecord(setting)) return null;
  const selections = collectZcodeFamilySelections(setting);
  if (selections.size === 0) return null;
  let family = normalizeFamily(setting.providerFamilyDomain);
  if (family && !selections.has(family)) return null;
  if (!family) {
    const loggedIn = FAMILY_ORDER.filter((f) => selections.has(f) && loggedInFamilies.has(f));
    if (loggedIn.length === 1) family = loggedIn[0];
    else if (selections.size === 1) family = [...selections.keys()][0]!;
    else family = FAMILY_ORDER.find((f) => selections.has(f)) ?? null;
  }
  if (!family) return null;
  const kind = selections.get(family);
  if (!kind) return null;
  return { family, kind, providerId: zcodePlanProviderId(family, kind) };
}

/**
 * Read the login signal from a decoded credentials.json: which families have
 * an `oauth:<family>:access_token` entry. Only key names are inspected. The
 * values are encrypted at rest (enc:v1 AES-256-GCM, key from
 * ZCODE_CREDENTIAL_SECRET or a machine-local fallback) and unreadable
 * headlessly.
 */
export function readZcodeLoggedInFamilies(credentials: unknown): Set<ZcodeFamily> {
  const out = new Set<ZcodeFamily>();
  if (!isRecord(credentials)) return out;
  for (const key of Object.keys(credentials)) {
    const m = /^oauth:(zai|bigmodel):access_token$/.exec(key);
    if (m) out.add(m[1] as ZcodeFamily);
  }
  return out;
}

/** detect-side ready state: install found + plan resolvable + family logged in. */
export interface ZcodeReadyState {
  ready: boolean;
  reason: ZcodeNotReadyReason | null;
  /** Resolved plan (present whenever the selection keys resolve, even when not
   * logged in, so the refusal can name the plan). */
  plan: ZcodePlanSelection | null;
}

/**
 * Read setting.json + credentials.json and compute the detect layer's ready
 * state. Never throws: missing/unreadable files degrade to the matching
 * not-ready reason. "未开过 GUI" (gui-not-initialized) = setting.json itself
 * absent; "未登录" (not-logged-in) = file present but no plan selection
 * resolves, or the resolved family has no OAuth token.
 */
export function readZcodeReadyState(opts: {
  settingPath?: string;
  credentialsPath?: string;
} = {}): ZcodeReadyState {
  const setting = readJsonFile(opts.settingPath ?? defaultZcodeSettingPath());
  if (setting === null) {
    return { ready: false, reason: "gui-not-initialized", plan: null };
  }
  const credentials = readJsonFile(opts.credentialsPath ?? defaultZcodeCredentialsPath());
  const loggedIn = readZcodeLoggedInFamilies(credentials);
  const plan = parseZcodePlanSelection(setting, loggedIn);
  if (!plan) return { ready: false, reason: "not-logged-in", plan: null };
  if (!loggedIn.has(plan.family)) return { ready: false, reason: "not-logged-in", plan };
  return { ready: true, reason: null, plan };
}

/** Shared tolerant JSON reader: null on missing/unreadable/malformed. */
function readJsonFile(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** ─── Bundled catalog resolution: install file first, cache by freshness ─── */

/**
 * The bundled catalog written by the same install as the cjs we spawn:
 * `<install>/resources/config/provider/zcode-builtin.json` where the cjs is
 * `<install>/resources/glm/zcode.cjs`. Holds for Windows, macOS, .deb, and
 * the Linux AppImage mount alike; the GUI host passes exactly this path
 * (per desktopProviderConfig.ts).
 */
export function zcodeBundledCatalogPathForCjs(cjsPath: string): string {
  return join(dirname(dirname(cjsPath)), "config", "provider", "zcode-builtin.json");
}

/**
 * Cache platform segment (resolveZCodeBuiltinClientPlatform): windows|linux|
 * darwin + x86_64|aarch64. Exported only so tests can build the cache tree the
 * resolver scans; callers should use `resolveZcodeCatalogFile()`.
 */
export function zcodeCachePlatform(): string {
  const target = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${target}-${arch}`;
}

/** Numeric-aware version-dir compare ("3.14.10" > "3.14.9" > "3.9.2"). */
function compareVersionDirs(a: string, b: string): number {
  const sa = a.split(/[.-]/);
  const sb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const na = Number(sa[i]);
    const nb = Number(sb[i]);
    const va = Number.isFinite(na) ? na : null;
    const vb = Number.isFinite(nb) ? nb : null;
    if (va === null && vb === null) {
      const c = sa[i]!.localeCompare(sb[i]!);
      if (c !== 0) return c;
    } else if (va === null) return -1;
    else if (vb === null) return 1;
    else if (va !== vb) return va - vb;
  }
  return 0;
}

function isCatalogShape(data: unknown): boolean {
  if (!isRecord(data)) return false;
  // schemaVersion gate (v1 unchanged to date).
  if (data.schemaVersion !== 1) return false;
  return isRecord(data.config);
}

/**
 * Locate + read the builtin catalog. Order: the install-bundled file
 * first (version-consistent with the spawned cjs by construction), then the
 * runtime cache by freshness (highest version dir, newest file within it).
 * Returns null when neither yields a schema-valid file; that is the
 * catalog-unreadable refusal link.
 */
export function resolveZcodeCatalogFile(opts: {
  cjsPath: string;
  cacheRoot?: string;
}): ZcodeCatalogFile | null {
  const installPath = zcodeBundledCatalogPathForCjs(opts.cjsPath);
  const installData = readJsonFile(installPath);
  if (isCatalogShape(installData)) {
    return { path: installPath, source: "install", data: installData };
  }
  const cacheRoot = opts.cacheRoot ?? defaultZcodeRuntimeProviderDir();
  const platformDir = join(cacheRoot, zcodeCachePlatform());
  let versions: string[] = [];
  try {
    versions = readdirSync(platformDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(compareVersionDirs)
      .reverse();
  } catch {
    return null;
  }
  for (const version of versions) {
    let candidates: string[] = [];
    try {
      candidates = readdirSync(join(platformDir, version), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("endpoint-"))
        .map((e) => join(platformDir, version, e.name, "zcode-builtin.json"));
    } catch {
      continue;
    }
    // Freshest file mtime wins within a version dir.
    let best: { path: string; mtime: number } | null = null;
    for (const candidate of candidates) {
      try {
        const mtime = statSync(candidate).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: candidate, mtime };
      } catch {
        // unreadable candidate; skip
      }
    }
    if (best) {
      const data = readJsonFile(best.path);
      if (isCatalogShape(data)) return { path: best.path, source: "cache", data };
    }
  }
  return null;
}

/** ─── Plan model and level table from the catalog's rules ─── */

interface RawProviderRule {
  providerId?: unknown;
  config?: unknown;
}
interface RawModelRule {
  modelMatch?: unknown;
  config?: unknown;
}

/**
 * The enabled plan models with their reasoning-level chips.
 *
 * - model list: the providerRules entry's `config.builtinModelIds` (catalog
 *   display order = GUI order);
 * - enabled filter: `builtinProviderModelRules` entries. An explicit
 *   `config.enabled === false` disables; a missing entry leaves the model on
 *   because the rules table is an override table;
 * - levels per model: last modelRules rule (in array order, per the engine's
 *   overlay semantics) whose `^(?:modelMatch)$` case-insensitively
 *   full-matches the model id and specifies
 *   `config.optionSpecs.reasoningLevel.values` as a non-empty string array.
 *   Invalid regexes are skipped (tolerant).
 * Pure; returns an empty models array for an unknown/empty provider.
 */
export function parseZcodeCatalogPlan(
  catalog: unknown,
  providerId: string,
): { providerId: string; models: ZcodePlanModel[] } {
  const empty = { providerId, models: [] as ZcodePlanModel[] };
  if (!isRecord(catalog) || !isRecord(catalog.config)) return empty;
  const providerConfigRules = isRecord(catalog.config.providerConfigRules)
    ? catalog.config.providerConfigRules
    : null;
  const providerRules = providerConfigRules && Array.isArray(providerConfigRules.providerRules)
    ? providerConfigRules.providerRules
    : null;
  if (!providerRules) return empty;
  const entry = providerRules.find(
    (r) => isRecord(r) && (r as RawProviderRule).providerId === providerId,
  );
  if (!isRecord(entry)) return empty;
  const entryConfig = isRecord(entry.config) ? entry.config : null;
  const builtinModelIds =
    entryConfig && Array.isArray(entryConfig.builtinModelIds)
      ? entryConfig.builtinModelIds.filter((m): m is string => typeof m === "string" && m.length > 0)
      : [];
  if (builtinModelIds.length === 0) return empty;

  const modelConfigRules = isRecord(catalog.config.modelConfigRules)
    ? catalog.config.modelConfigRules
    : null;
  const enabled = new Set<string>(builtinModelIds);
  const builtinProviderModelRules =
    modelConfigRules && Array.isArray(modelConfigRules.builtinProviderModelRules)
      ? modelConfigRules.builtinProviderModelRules
      : null;
  if (builtinProviderModelRules) {
    for (const rule of builtinProviderModelRules) {
      if (!isRecord(rule)) continue;
      const r = rule as { providerId?: unknown; modelId?: unknown; config?: unknown };
      if (r.providerId !== providerId || typeof r.modelId !== "string") continue;
      if (isRecord(r.config) && r.config.enabled === false) enabled.delete(r.modelId);
    }
  }

  const modelRules =
    modelConfigRules && Array.isArray(modelConfigRules.modelRules)
      ? modelConfigRules.modelRules
      : null;

  const models: ZcodePlanModel[] = [];
  for (const modelId of builtinModelIds) {
    if (!enabled.has(modelId)) continue;
    models.push({ modelId, levels: modelRules ? resolveLevels(modelRules, modelId) : [] });
  }
  return { providerId, models };
}

function resolveLevels(modelRules: unknown[], modelId: string): string[] {
  let levels: string[] = [];
  for (const rule of modelRules) {
    if (!isRecord(rule)) continue;
    const r = rule as RawModelRule;
    if (typeof r.modelMatch !== "string" || r.modelMatch.length === 0) continue;
    let matches: boolean;
    try {
      matches = new RegExp(`^(?:${r.modelMatch})$`, "i").test(modelId);
    } catch {
      continue;
    }
    if (!matches) continue;
    const values = extractLevelValues(r.config);
    if (values) levels = values;
  }
  return levels;
}

function extractLevelValues(config: unknown): string[] | null {
  if (!isRecord(config) || !isRecord(config.optionSpecs)) return null;
  const spec = isRecord(config.optionSpecs.reasoningLevel)
    ? config.optionSpecs.reasoningLevel
    : null;
  if (!spec || !Array.isArray(spec.values)) return null;
  const values = spec.values.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return values.length > 0 ? values : null;
}

/** ─── Picker id codec ─── */

/**
 * Encode a (modelId, reasoningLevel) picker choice into the single string the
 * UI store persists and the invoke layer receives as `model`:
 * `"<modelId>/<level>"`, the same slash-separated compound-id convention the
 * openclaw (`openrouter/anthropic/…`) and opencode (`anthropic/…`) pickers
 * use. Model ids in the catalog are `[-A-Za-z0-9.]`-shaped and contain no
 * `/`; a hostile id simply fails decode/validation at invoke time.
 */
export function encodeZcodeModelChoice(modelId: string, reasoningLevel: string): string {
  return `${modelId}/${reasoningLevel}`;
}

/** Inverse of {@link encodeZcodeModelChoice}; null for ids without a level suffix. */
export function decodeZcodeModelChoice(id: string): { modelId: string; reasoningLevel: string } | null {
  const at = id.lastIndexOf("/");
  if (at <= 0 || at === id.length - 1) return null;
  return { modelId: id.slice(0, at), reasoningLevel: id.slice(at + 1) };
}

/** One picker chip as the detect layers render it (ModelOption-shaped). */
export interface ZcodePlanModelOption {
  id: string;
  label: string;
  providerId: string;
}

/**
 * Resolve the catalog for a resolved cjs + plan and expand the plan's models
 * into picker chips: one per model and level, ids encoded as
 * `"<modelId>/<level>"`, labels `"<modelId> (<level>)"`, every chip carrying
 * the plan providerId. Returns an empty list when the catalog is unreadable;
 * the caller keeps the static floor (ZCODE_DEFAULT_MODEL) and the invoke-time
 * refusal reports the error. Shared by the next + cli detect mirrors so the
 * mapping cannot drift.
 */
export function readZcodePlanModelOptions(opts: {
  cjsPath: string;
  plan: ZcodePlanSelection;
  cacheRoot?: string;
}): ZcodePlanModelOption[] {
  const catalog = resolveZcodeCatalogFile({ cjsPath: opts.cjsPath, cacheRoot: opts.cacheRoot });
  if (!catalog) return [];
  const plan = parseZcodeCatalogPlan(catalog.data, opts.plan.providerId);
  return plan.models.flatMap((m) =>
    m.levels.map((level) => ({
      id: encodeZcodeModelChoice(m.modelId, level),
      label: `${m.modelId} (${level})`,
      providerId: plan.providerId,
    })),
  );
}

/**
 * What the "Default" chip currently resolves to for this plan. Uses the same
 * precedence {@link prepareZcodeModelBinding} applies to a default pick: the
 * GUI's own `defaultModelSelection` when it validly targets the plan (legacy
 * provider ids migrated), else the plan's first enabled model with its last
 * reasoning level. Read-only (never touches the credential store); shared by
 * the next + cli detect mirrors so the Default chip label cannot drift from
 * what the invoke layer actually binds.
 */
export interface ZcodePlanDefaultChoice {
  modelId: string;
  reasoningLevel: string;
}

/**
 * Resolve {@link ZcodePlanDefaultChoice} for a resolved cjs + plan. Returns
 * `null` when the catalog is unreadable or the plan table holds no model with
 * a usable level; detect then keeps the static floor and the invoke-time
 * refusal reports the error.
 */
export function readZcodePlanDefaultChoice(opts: {
  cjsPath: string;
  plan: ZcodePlanSelection;
  personalConfigPath?: string;
  cacheRoot?: string;
}): ZcodePlanDefaultChoice | null {
  const catalog = resolveZcodeCatalogFile({ cjsPath: opts.cjsPath, cacheRoot: opts.cacheRoot });
  if (!catalog) return null;
  const planModels = parseZcodeCatalogPlan(catalog.data, opts.plan.providerId).models;
  const personal = readJsonFile(opts.personalConfigPath ?? defaultZcodePersonalConfigPath());
  return resolveDefaultSelection(opts.plan, planModels, isRecord(personal) ? personal : {});
}

/** ─── Legacy provider-id migration (one-way, read boundary only) ─── */

const LEGACY_PROVIDER_IDS: Record<string, string> = {
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
};

/**
 * Migrate legacy Coding-Plan provider ids to the current `account:*` ids
 * (migrateLegacyModelProviderId semantics: known legacy ids map one-way;
 * anything else passes through). Needed because a GUI-written
 * `defaultModelSelection` may still carry the legacy id.
 */
export function migrateLegacyZcodeProviderId(providerId: string): string {
  return LEGACY_PROVIDER_IDS[providerId] ?? providerId;
}

/** ─── Per-turn binding preparation (the invoke layer's one call) ─── */

/** The refusal links, in resolution order. */
export type ZcodeBindingRefusal =
  | "gui-keys-missing"
  | "catalog-unreadable"
  | "personal-config-unreadable"
  | "credentials-missing"
  | "model-not-in-plan"
  | "level-unavailable";

export type ZcodeBindingResult =
  | {
    ok: true;
    /** The exact selection written into the clone (and returned for logging/tests). */
    selection: ZcodeModelSelection;
    /** Path of the temp clone; its directory is the caller's to clean up. */
    clonePath: string;
    /** The catalog file validated against, also the paired builtin env value. */
    builtinCatalogPath: string;
  }
  | {
    ok: false;
    code: ZcodeBindingRefusal;
    /** Failure message (English, matching sibling invoke errors). */
    message: string;
  };

/**
 * `account-provider:coding-plan:${providerId}:account:${identity}:api-key`
 * (encodeURIComponent on the identity); the GUI writes these.
 */
const CODING_PLAN_APIKEY_PREFIX = "account-provider:coding-plan:";

function findCodingPlanApiKeyEntry(
  credentials: Record<string, unknown>,
  providerId: string,
): { key: string; identity: string } | null {
  const prefix = `${CODING_PLAN_APIKEY_PREFIX}${providerId}:account:`;
  for (const key of Object.keys(credentials)) {
    if (!key.startsWith(prefix) || !key.endsWith(":api-key")) continue;
    const raw = key.slice(prefix.length, -":api-key".length);
    try {
      return { key, identity: decodeURIComponent(raw) };
    } catch {
      return { key, identity: raw };
    }
  }
  return null;
}

/**
 * Resolve + write the per-turn binding: the refusal chain, then one temp
 * artifact, a clone of the user's personal provider config with the exact
 * `config.defaultModelSelection`. The only write to real user files is the
 * identity key appended to the real credential store (see header).
 *
 * The identity bridge is required (verified against the installed CLI).
 * The headless CLI materializes an account Coding-Plan provider only when
 * the credential store holds its `identity` key, a key the GUI never writes
 * (only `zcode login` does). A provider without it is absent from the
 * registry, which makes our defaultModelSelection unselectable and silently
 * reroutes the turn to the first personal provider. The bridge ensures the
 * key exists in the real credential store (atomic append of the one key,
 * re-checked every turn; users who ran `zcode login` already have it and
 * nothing is written). Everything else in the store is untouched, so the
 * turn keeps using the real data dir and sessions stay visible in the
 * ZCode GUI.
 *
 * `model` semantics: undefined / "default" binds the plan default, the GUI's
 * own `defaultModelSelection` when it targets the plan provider validly,
 * else the plan's first enabled model with its last level (the CLI's
 * `completeNewModelSelection` convention, `values.at(-1)`). Any other string
 * is an explicit pick: it must decode to `"<modelId>/<level>"` and validate
 * inside the plan, else the matching refusal fires. A bare or stale model id
 * (e.g. persisted by an older UI) never silently reroutes. Every turn is
 * bound explicitly; no path leaves the CLI to its silent registry fallback.
 */
export function prepareZcodeModelBinding(opts: {
  cjsPath: string;
  /** Picker id: undefined | "default" | "<modelId>/<level>". */
  model?: string;
  /** Directory for the temp artifacts, the invoke layer's attach temp dir.
   * Its existing cleanup removes everything with the prompt file. */
  attachDir: string;
  settingPath?: string;
  personalConfigPath?: string;
  credentialsPath?: string;
  cacheRoot?: string;
}): ZcodeBindingResult {
  const setting = readJsonFile(opts.settingPath ?? defaultZcodeSettingPath());
  // The login signal participates in family resolution (domain-absent case) so
  // the invoke layer resolves the same plan detect did, but it is not a
  // refusal link here: an unlogged family fails at spawn (red error state),
  // while detect owns the amber not-ready state.
  const credentials = readJsonFile(opts.credentialsPath ?? defaultZcodeCredentialsPath());
  const plan = parseZcodePlanSelection(setting, readZcodeLoggedInFamilies(credentials));
  if (!plan) {
    return {
      ok: false,
      code: "gui-keys-missing",
      message:
        "ZCode: no model plan found in the GUI settings. Open ZCode, log in and select a model (e.g. your Coding Plan), then retry.",
    };
  }
  const catalog = resolveZcodeCatalogFile({ cjsPath: opts.cjsPath, cacheRoot: opts.cacheRoot });
  if (!catalog) {
    return {
      ok: false,
      code: "catalog-unreadable",
      message:
        "ZCode: the bundled provider catalog could not be read (neither next to the install nor in the runtime cache). Reinstall ZCode or point ZCODE_BIN at a full install, then retry.",
    };
  }
  const planModels = parseZcodeCatalogPlan(catalog.data, plan.providerId).models;

  const personalPath = opts.personalConfigPath ?? defaultZcodePersonalConfigPath();
  const personal = readJsonFile(personalPath);
  if (!isRecord(personal) || !isRecord(personal.config)) {
    return {
      ok: false,
      code: "personal-config-unreadable",
      message:
        "ZCode: the provider config (~/.zcode/v2/provider_config.json) is missing or malformed. Open the ZCode GUI once so it can initialize the config, then retry.",
    };
  }

  // Raw material for the identity bridge: the GUI-written coding-plan api-key
  // key for the resolved plan provider. When absent, the headless registry
  // cannot materialize the plan provider at all; refuse here.
  const credentialsRecord = isRecord(credentials) ? credentials : {};
  const apiKeyEntry = findCodingPlanApiKeyEntry(credentialsRecord, plan.providerId);
  if (!apiKeyEntry) {
    return {
      ok: false,
      code: "credentials-missing",
      message:
        `ZCode: no saved Coding Plan credential for ${plan.providerId}. Open the ZCode GUI, log in to your Coding Plan, then retry.`,
    };
  }

  const selection = resolveSelection(opts.model, plan, planModels, personal);
  if (!selection.ok) return selection;

  // Identity bridge on the real credential store: the headless registry needs
  // `account-provider:<providerId>:identity`; the GUI never writes it. Ensure
  // it exists via an atomic append (tmp file + rename): idempotent when the
  // stored identity already matches; a differing stale identity is
  // overwritten.
  const identityKey = `account-provider:${plan.providerId}:identity`;
  if (credentialsRecord[identityKey] !== apiKeyEntry.identity) {
    const credentialsPath = opts.credentialsPath ?? defaultZcodeCredentialsPath();
    try {
      const bridged = { ...credentialsRecord, [identityKey]: apiKeyEntry.identity };
      const tmpPath = `${credentialsPath}.html-anything-tmp`;
      writeFileSync(tmpPath, JSON.stringify(bridged, null, 2), "utf8");
      renameSync(tmpPath, credentialsPath);
    } catch (err) {
      return {
        ok: false,
        code: "credentials-missing",
        message: `ZCode: failed to add the Coding Plan identity credential to ${credentialsPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  // Deep-clone via JSON round-trip: the source is freshly-parsed JSON anyway.
  const clone = JSON.parse(JSON.stringify(personal)) as { config?: Record<string, unknown> };
  clone.config = {
    ...clone.config,
    defaultModelSelection: {
      providerId: selection.selection.providerId,
      modelId: selection.selection.modelId,
      options: { reasoningLevel: selection.selection.reasoningLevel },
    },
  };
  mkdirSync(opts.attachDir, { recursive: true });
  const clonePath = join(opts.attachDir, "provider-config.clone.json");
  try {
    writeFileSync(clonePath, JSON.stringify(clone, null, 2), "utf8");
  } catch (err) {
    return {
      ok: false,
      code: "personal-config-unreadable",
      message: `ZCode: failed to write the temp provider-config clone: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {
    ok: true,
    selection: selection.selection,
    clonePath,
    builtinCatalogPath: catalog.path,
  };
}

function resolveSelection(
  model: string | undefined,
  plan: ZcodePlanSelection,
  planModels: ZcodePlanModel[],
  personal: { config?: Record<string, unknown> },
): { ok: true; selection: ZcodeModelSelection } | { ok: false; code: ZcodeBindingRefusal; message: string } {
  if (model !== undefined && model !== "default") {
    // An explicit pick must decode to "<modelId>/<level>" and validate inside
    // the plan. Anything else (a bare model id persisted by an older UI, a
    // stale chip id after a plan change) refuses rather than silently binding
    // the plan default; that closes the silent-reroute class this refusal
    // exists for.
    const pick = decodeZcodeModelChoice(model);
    if (!pick) {
      return {
        ok: false,
        code: "model-not-in-plan",
        message: `ZCode: the saved model choice "${model}" is stale or malformed (expected "<model>/<level>"). Re-scan agents in Settings and pick a model again, then retry.`,
      };
    }
    const entry = planModels.find((m) => m.modelId === pick.modelId);
    if (!entry) {
      return {
        ok: false,
        code: "model-not-in-plan",
        message: `ZCode: model "${pick.modelId}" is not available on your current ZCode plan (${plan.providerId}). Pick another model in Settings, or open ZCode and switch the plan, then retry.`,
      };
    }
    if (!entry.levels.includes(pick.reasoningLevel)) {
      return {
        ok: false,
        code: "level-unavailable",
        message: `ZCode: reasoning level "${pick.reasoningLevel}" is not supported for ${entry.modelId} on your current plan (supported: ${entry.levels.join(", ")}). Re-scan agents in Settings and pick again.`,
      };
    }
    return { ok: true, selection: { providerId: plan.providerId, modelId: entry.modelId, reasoningLevel: pick.reasoningLevel } };
  }
  // Default: the shared precedence. The GUI's own defaultModelSelection when
  // it validly targets this plan, else the plan default.
  const def = resolveDefaultSelection(plan, planModels, personal);
  if (!def) {
    return {
      ok: false,
      code: "level-unavailable",
      message:
        `ZCode: no model with a usable reasoning level was found for your current plan (${plan.providerId}). Open ZCode, select a model on the plan, then retry.`,
    };
  }
  return {
    ok: true,
    selection: { providerId: plan.providerId, modelId: def.modelId, reasoningLevel: def.reasoningLevel },
  };
}

/**
 * The default-selection precedence shared by {@link prepareZcodeModelBinding}
 * and the detect layer's Default-chip label ({@link readZcodePlanDefaultChoice}):
 * the GUI's own `defaultModelSelection` when it validly targets the plan
 * (legacy provider ids migrated), else the plan's first enabled model with
 * its last reasoning level (the CLI's `completeNewModelSelection` convention
 * for new drafts). Returns null when even the plan default is unusable (no
 * enabled model with a level).
 */
function resolveDefaultSelection(
  plan: ZcodePlanSelection,
  planModels: ZcodePlanModel[],
  personal: { config?: Record<string, unknown> },
): ZcodePlanDefaultChoice | null {
  const configured = isRecord(personal.config?.defaultModelSelection)
    ? personal.config.defaultModelSelection
    : null;
  if (configured) {
    const providerId =
      typeof configured.providerId === "string"
        ? migrateLegacyZcodeProviderId(configured.providerId)
        : null;
    const modelId = typeof configured.modelId === "string" ? configured.modelId : null;
    const level = isRecord(configured.options) && typeof configured.options.reasoningLevel === "string"
      ? configured.options.reasoningLevel
      : null;
    const entry = modelId ? planModels.find((m) => m.modelId === modelId) : undefined;
    if (providerId === plan.providerId && entry && level && entry.levels.includes(level)) {
      return { modelId: entry.modelId, reasoningLevel: level };
    }
  }
  const first = planModels[0];
  if (!first || first.levels.length === 0) return null;
  return { modelId: first.modelId, reasoningLevel: first.levels[first.levels.length - 1]! };
}

/** True when the environment already carries both provider-config vars; that
 * is the user's zero-code reroute. The invoke layer then passes them through
 * untouched and skips its own binding. */
export function zcodeProviderEnvPairSet(env: Readonly<NodeJS.ProcessEnv>): boolean {
  const personal = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const builtin = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  return Boolean(personal && builtin);
}

/** Convenience: the paired env values for a prepared binding. */
export function zcodeBindingEnv(
  result: Extract<ZcodeBindingResult, { ok: true }>,
): Record<string, string> {
  return {
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: result.clonePath,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: result.builtinCatalogPath,
  };
}
