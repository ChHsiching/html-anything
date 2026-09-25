/**
 * Per-turn model binding for the ZCode CLI one-shot adapter. The picker
 * mirrors ZCode's own headless provider registry — every provider the
 * spawned CLI would materialize, in the order it would list them — so the
 * chips a user picks from are exactly the routes the turn can take.
 *
 * The registry has two kinds of members (verified against the ZCode 3.14
 * source drop; receipts below):
 *
 * - **Account providers**: catalog `providerRules` entries whose
 *   `access.mode` is `individual-coding-plan`. The headless CLI expands an
 *   account provider only when the credential store holds its identity key
 *   AND the api-key key named by that identity — it reads
 *   `account-provider:<providerId>:identity`, then requires
 *   `account-provider:coding-plan:<providerId>:account:<identity>:api-key`
 *   (standalone-account-provider-runtime.ts). Only `zcode login` writes the
 *   identity key (OAuth → user id, API key → sha256 prefix); the GUI never
 *   does, and the team shell keys the GUI auto-lays at login have no
 *   identity key, so team/start/off-peak never satisfy the pairing. The
 *   enumeration mirrors that pairing exactly: it lists only what the CLI
 *   itself would materialize.
 * - **Personal providers**: `provider_config.json` `providerRules` entries
 *   whose `access` carries an `apiKey` (template instances get their key
 *   material from the personal entry; the template schema has no key of
 *   its own). Template instances list the template's `builtinModelIds`
 *   union the entry's `personalModelIds`; custom entries list
 *   `personalModelIds` alone.
 *
 * Ordering mirrors the resolver: the account family group first in catalog
 * declaration order, then personal providers in the user's `providerOrder`
 * (`resolveOwnedOrder`: unordered entries follow in declaration order).
 * Model order within a provider is `resolveOwnedOrder(builtinModelIds,
 * personalModelIds, modelOrder)`. Reasoning levels come from the catalog's
 * all-vendor `modelRules` regex table (last matching rule with values wins,
 * case-insensitive full match). A model no rule gives levels to is still
 * listed and bindable — the binding then carries no `reasoningLevel`.
 * Enabled is the overlay of catalog `builtinProviderModelRules` /
 * `templateModelRules` and personal `providerModelRules` (an explicit
 * `enabled: false` drops the entry; a missing entry keeps it on), and
 * `hidden` providers are filtered like the GUI's picker.
 *
 * The default chain mirrors the CLI's own (`model-selection-config.ts`):
 * the configured `config.defaultModelSelection` while it still selects
 * something in this registry (legacy `providerId`s migrated; only CLI
 * login / the TUI / import ever write that key — never the GUI), else the
 * first registry provider's first model at its highest level.
 *
 * Binding mechanism (unchanged from the verified flow): clone the user's
 * `~/.zcode/v2/provider_config.json` to a temp file, write the exact
 * `config.defaultModelSelection` into the clone, and hand the child the
 * paired env vars `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (the clone) and
 * `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (the bundled catalog file validated
 * here). The pair is required by the CLI's runtime-paths pair check. The
 * user's real config file is never written; the clone is a per-turn temp
 * file owned by the invoke layer's cleanup.
 *
 * The one real write is the identity bridge, and it only ever fires for an
 * account target: if an explicit pick names an account provider whose
 * api-key key exists but whose identity key is missing, the bridge appends
 * that one key atomically (tmp file + rename, add-only — an existing
 * identity value is never modified, and every spawn re-checks first).
 * Without the key the headless CLI drops the provider from its registry and
 * silently reroutes the turn. `setting.json` is not read at all: its family
 * keys are GUI navigation state with no headless consumer.
 *
 * Refusal chain (any broken link refuses the spawn with an actionable
 * message): catalog unreadable → provider config unreadable → no usable
 * provider (ready is the single "no keyed service" state) → explicit pick
 * resolution (provider without access / model not on the provider /
 * unsupported level). Nothing silently falls back.
 *
 * Files read (all private ZCode formats): the bundled catalog next to the
 * install (`<install>/resources/config/provider/zcode-builtin.json`,
 * runtime cache as a freshness-ordered second choice; schemaVersion must
 * be 1), `~/.zcode/v2/provider_config.json`, and
 * `~/.zcode/v2/credentials.json`. From credentials only key names are
 * read, plus the value of the identity keys (a plaintext account id by
 * ZCode's own convention — `zcode login` writes it unencrypted); the
 * api-key values are encrypted at rest and are never read.
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.length > 0)
    : [];
}

/** Env var carrying the personal provider config (name from ZCode's runtime-paths.ts). */
export const ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
/** Env var carrying the builtin provider catalog (name from ZCode's runtime-paths.ts). */
export const ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";

/**
 * Why a detected install is not ready to run turns. Single state (v3): the
 * registry mirror holds no usable provider, whatever the reason (nothing
 * logged in, nothing keyed, catalog gone). The settings card carries one
 * guidance line for it.
 */
export type ZcodeNotReadyReason = "no-usable-provider";

/** One enumerated model: its id plus the reasoning levels the catalog's
 * `modelRules` give it. Empty `levels` = no level table; the model stays
 * selectable and binds without a `reasoningLevel`. */
export interface ZcodeRegistryModel {
  modelId: string;
  levels: string[];
}

/** One usable provider in registry order, as the headless CLI would list it. */
export interface ZcodeRegistryProvider {
  providerId: string;
  /** Catalog `providerName` for account providers, the personal entry's name otherwise. */
  providerName: string;
  kind: "account" | "personal";
  /** Account providers only: the identity the credential pair was built from. */
  accountIdentity?: string;
  models: ZcodeRegistryModel[];
}

/** One picker chip as the detect layers render it (ModelOption-shaped). */
export interface ZcodeModelOption {
  /** `"<providerId>/<modelId>"` or `"<providerId>/<modelId>/<level>"`. */
  id: string;
  /** `"<modelId> (<providerName>[, <level>])"` — the service name
   * disambiguates the same model id across providers. */
  label: string;
  providerId: string;
}

/** What the "Default" chip currently resolves to (the same chain a default
 * pick binds): the provider, its display name, the model, and the level
 * (null when the model has no level table). */
export interface ZcodeDefaultChoice {
  providerId: string;
  providerName: string;
  modelId: string;
  reasoningLevel: string | null;
}

/** The exact binding written into the temp clone (CLI's ModelSelection
 * shape; `reasoningLevel` null = omit the option entirely). */
export interface ZcodeModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: string | null;
}

/** The bundled catalog file we validated against, and where it came from. */
export interface ZcodeCatalogFile {
  path: string;
  source: "install" | "cache";
  data: unknown;
}

/** ─── Default paths (self-contained) ─── */

export function defaultZcodePersonalConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "provider_config.json");
}
export function defaultZcodeCredentialsPath(): string {
  return join(homedir(), ".zcode", "v2", "credentials.json");
}
export function defaultZcodeRuntimeProviderDir(): string {
  return join(homedir(), ".zcode", "v2", "runtime", "provider");
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

/** ─── Registry mirror (pure): providers, models, levels, ordering ─── */

/**
 * `resolveOwnedOrder` from ZCode's owned-order.ts, mirrored: unordered
 * builtin ids stay ahead of the user's order, unordered personal ids
 * follow it, duplicates keep first occurrence. Keeps the adapter's model
 * and provider ordering byte-compatible with the GUI's reorder semantics.
 */
function resolveOwnedOrder(
  builtinIds: readonly string[],
  personalIds: readonly string[],
  requestedOrder: readonly string[],
): string[] {
  const uniqueInOrder = (values: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };
  const builtin = uniqueInOrder(builtinIds);
  const builtinSet = new Set(builtin);
  const personal = uniqueInOrder(personalIds).filter((id) => !builtinSet.has(id));
  const members = new Set([...builtin, ...personal]);
  const ordered = uniqueInOrder(requestedOrder).filter((id) => members.has(id));
  const orderedSet = new Set(ordered);
  return [
    ...builtin.filter((id) => !orderedSet.has(id)),
    ...ordered,
    ...personal.filter((id) => !orderedSet.has(id)),
  ];
}

interface RuleTables {
  modelRules: unknown[];
  builtinProviderModelRules: unknown[];
  templateModelRules: unknown[];
  personalProviderModelRules: unknown[];
}

function readRuleTables(catalog: unknown, personal: unknown): RuleTables {
  const catalogConfig = isRecord(catalog) && isRecord(catalog.config) ? catalog.config : {};
  const catalogModelRules = isRecord(catalogConfig.modelConfigRules)
    ? catalogConfig.modelConfigRules
    : {};
  const personalConfig = isRecord(personal) && isRecord(personal.config) ? personal.config : {};
  const personalModelRules = isRecord(personalConfig.modelConfigRules)
    ? personalConfig.modelConfigRules
    : {};
  return {
    modelRules: Array.isArray(catalogModelRules.modelRules) ? catalogModelRules.modelRules : [],
    builtinProviderModelRules: Array.isArray(catalogModelRules.builtinProviderModelRules)
      ? catalogModelRules.builtinProviderModelRules
      : [],
    templateModelRules: Array.isArray(catalogModelRules.templateModelRules)
      ? catalogModelRules.templateModelRules
      : [],
    personalProviderModelRules: Array.isArray(personalModelRules.providerModelRules)
      ? personalModelRules.providerModelRules
      : [],
  };
}

/**
 * The reasoning levels for a model id from the catalog's all-vendor
 * `modelRules` regex table: the LAST rule (array order, per the engine's
 * overlay semantics) whose `^(?:modelMatch)$` case-insensitively
 * full-matches the id and specifies non-empty
 * `config.optionSpecs.reasoningLevel.values`. Invalid regexes are skipped
 * (tolerant). A model no rule gives values to has no levels — still
 * selectable, bound without a reasoningLevel.
 */
function resolveLevels(modelRules: readonly unknown[], modelId: string): string[] {
  let levels: string[] = [];
  for (const rule of modelRules) {
    if (!isRecord(rule)) continue;
    const modelMatch = typeof rule.modelMatch === "string" ? rule.modelMatch : null;
    if (!modelMatch) continue;
    let matches: boolean;
    try {
      matches = new RegExp(`^(?:${modelMatch})$`, "i").test(modelId);
    } catch {
      continue;
    }
    if (!matches) continue;
    const values = extractLevelValues(rule.config);
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

/**
 * The enabled model table for one provider: the ordered id union with the
 * three enabled tables overlaid last-write-wins in catalog-first order
 * (builtinProviderModelRules → templateModelRules → personal
 * providerModelRules, mirroring composeEffective's [...builtin, ...personal]),
 * so an explicit `enabled: false` drops a model and a later explicit
 * `enabled: true` re-enables it; a missing entry keeps it on. Each listed
 * model carries its `modelRules` levels.
 */
function enabledModelsFor(
  tables: RuleTables,
  input: {
    providerId: string;
    templateId: string | null;
    builtinModelIds: readonly string[];
    personalModelIds: readonly string[];
    modelOrder: readonly string[];
  },
): ZcodeRegistryModel[] {
  const ids = resolveOwnedOrder(input.builtinModelIds, input.personalModelIds, input.modelOrder);
  const enabled = new Map<string, boolean>();
  const overlay = (
    rules: readonly unknown[],
    matches: (rule: Record<string, unknown>) => boolean,
  ) => {
    for (const rule of rules) {
      if (!isRecord(rule)) continue;
      if (!matches(rule) || typeof rule.modelId !== "string") continue;
      const config = isRecord(rule.config) ? rule.config : null;
      if (config && typeof config.enabled === "boolean") enabled.set(rule.modelId, config.enabled);
    }
  };
  overlay(tables.builtinProviderModelRules, (r) => r.providerId === input.providerId);
  if (input.templateId) {
    overlay(tables.templateModelRules, (r) => r.templateId === input.templateId);
  }
  overlay(tables.personalProviderModelRules, (r) => r.providerId === input.providerId);
  const models: ZcodeRegistryModel[] = [];
  for (const modelId of ids) {
    if (enabled.get(modelId) === false) continue;
    models.push({ modelId, levels: resolveLevels(tables.modelRules, modelId) });
  }
  return models;
}

/** A catalog account provider entry (already filtered to the headless
 * expansion mode), with its model table computed. */
interface AccountCandidate {
  providerId: string;
  providerName: string;
  models: ZcodeRegistryModel[];
}

function accountCandidates(catalog: unknown, tables: RuleTables): AccountCandidate[] {
  const out: AccountCandidate[] = [];
  const catalogConfig = isRecord(catalog) && isRecord(catalog.config) ? catalog.config : {};
  const providerConfigRules = isRecord(catalogConfig.providerConfigRules)
    ? catalogConfig.providerConfigRules
    : {};
  if (!Array.isArray(providerConfigRules.providerRules)) return out;
  for (const rule of providerConfigRules.providerRules) {
    if (!isRecord(rule)) continue;
    const providerId = nonEmptyString(rule.providerId);
    if (!providerId) continue;
    const config = isRecord(rule.config) ? rule.config : null;
    const access = config && isRecord(config.access) ? config.access : null;
    // The headless CLI only expands individual coding plans; team / start /
    // off-peak account providers never materialize standalone.
    if (!access || access.mode !== "individual-coding-plan") continue;
    const providerName = nonEmptyString(rule.providerName) ?? providerId;
    const models = enabledModelsFor(tables, {
      providerId,
      templateId: null,
      builtinModelIds: config ? stringArray(config.builtinModelIds) : [],
      personalModelIds: [],
      modelOrder: [],
    });
    out.push({ providerId, providerName, models });
  }
  return out;
}

/** A personal provider_config.json entry, parsed tolerantly. Entries with a
 * missing template or disabled/hidden/keyless config stay in this list (an
 * explicit pick of them must fail with the provider refusal, not a stale
 * one) but are filtered out of the registry. */
interface PersonalCandidate {
  providerId: string;
  templateId: string | null;
  providerName: string;
  apiKey: string | null;
  enabled: boolean;
  hidden: boolean;
  models: ZcodeRegistryModel[];
}

function personalCandidates(catalog: unknown, personal: unknown, tables: RuleTables): PersonalCandidate[] {
  const byId = new Map<string, PersonalCandidate>();
  const catalogConfig = isRecord(catalog) && isRecord(catalog.config) ? catalog.config : {};
  const providerConfigRules = isRecord(catalogConfig.providerConfigRules)
    ? catalogConfig.providerConfigRules
    : {};
  const templateRules = Array.isArray(providerConfigRules.templateRules)
    ? providerConfigRules.templateRules
    : [];
  const personalConfig = isRecord(personal) && isRecord(personal.config) ? personal.config : {};
  const personalProviderRules =
    isRecord(personalConfig.providerConfigRules) &&
      Array.isArray(personalConfig.providerConfigRules.providerRules)
      ? personalConfig.providerConfigRules.providerRules
      : [];
  for (const rule of personalProviderRules) {
    if (!isRecord(rule)) continue;
    const providerId = nonEmptyString(rule.providerId);
    if (!providerId || byId.has(providerId)) continue;
    const config = isRecord(rule.config) ? rule.config : null;
    const access = config && isRecord(config.access) ? config.access : null;
    const apiKey = access ? nonEmptyString(access.apiKey) : null;
    const templateId = nonEmptyString(rule.templateId);
    let templateBuiltinIds: string[] = [];
    if (templateId) {
      const template = templateRules.find(
        (t) => isRecord(t) && t.templateId === templateId && isRecord(t.config),
      );
      if (template && isRecord(template.config)) {
        templateBuiltinIds = stringArray(template.config.builtinModelIds);
      }
    }
    const models = enabledModelsFor(tables, {
      providerId,
      templateId,
      builtinModelIds: templateBuiltinIds,
      personalModelIds: config ? stringArray(config.personalModelIds) : [],
      modelOrder: config ? stringArray(config.modelOrder) : [],
    });
    byId.set(providerId, {
      providerId,
      templateId,
      providerName: nonEmptyString(rule.providerName) ?? providerId,
      apiKey,
      enabled: !(config?.enabled === false),
      hidden: config?.visibility === "hidden",
      models,
    });
  }
  return [...byId.values()];
}

/**
 * The account credential pair mirror: the identity key's value (a plaintext
 * account id by ZCode's own write convention) plus the existence of the
 * api-key key it names — exactly the entitlement check the headless CLI
 * performs (standalone-account-provider-runtime.ts reads the identity key,
 * then requires the api-key key built from it). Null when the provider is
 * not materialized standalone.
 */
function accountPair(
  credentials: Record<string, unknown>,
  providerId: string,
): { identity: string } | null {
  const raw = credentials[`account-provider:${providerId}:identity`];
  const identity = typeof raw === "string" ? raw.trim() : "";
  if (!identity) return null;
  const apiKeyKey =
    `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(identity)}:api-key`;
  return credentials[apiKeyKey] !== undefined ? { identity } : null;
}

/**
 * Find ANY coding-plan api-key key for the provider and recover the account
 * identity from its name — the identity bridge's raw material. The GUI
 * writes these keys with the identity embedded (encodeURIComponent) in the
 * name, so no credential value is read.
 */
function findCodingPlanApiKeyEntry(
  credentials: Record<string, unknown>,
  providerId: string,
): { key: string; identity: string } | null {
  const prefix = `account-provider:coding-plan:${providerId}:account:`;
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
 * Enumerate the registry the headless CLI would build: paired account
 * individual plans (catalog declaration order) first, then keyed personal
 * providers (user `providerOrder`, unordered entries in declaration
 * order). Providers whose model table empties out under the enabled
 * overlays are dropped, like the CLI's registry builder. Pure; tolerant of
 * every malformed input (worst case: an empty registry → the single
 * no-usable-provider refusal).
 */
export function enumerateZcodeRegistry(
  catalog: unknown,
  personal: unknown,
  credentials: unknown,
): ZcodeRegistryProvider[] {
  const tables = readRuleTables(catalog, personal);
  const credentialRecord = isRecord(credentials) ? credentials : {};
  const out: ZcodeRegistryProvider[] = [];
  for (const account of accountCandidates(catalog, tables)) {
    if (account.models.length === 0) continue;
    const pair = accountPair(credentialRecord, account.providerId);
    if (!pair) continue;
    out.push({
      providerId: account.providerId,
      providerName: account.providerName,
      kind: "account",
      accountIdentity: pair.identity,
      models: account.models,
    });
  }
  const personalConfig = isRecord(personal) && isRecord(personal.config) ? personal.config : {};
  const candidates = personalCandidates(catalog, personal, tables);
  const ordered = resolveOwnedOrder(
    [],
    candidates.map((c) => c.providerId),
    stringArray(personalConfig.providerOrder),
  );
  const byId = new Map(candidates.map((c) => [c.providerId, c]));
  for (const providerId of ordered) {
    const entry = byId.get(providerId);
    if (!entry) continue;
    if (entry.hidden || !entry.enabled || !entry.apiKey) continue;
    if (entry.models.length === 0) continue;
    out.push({
      providerId: entry.providerId,
      providerName: entry.providerName,
      kind: "personal",
      models: entry.models,
    });
  }
  return out;
}

/** ─── Default chain (pure) ─── */

/**
 * The default-selection chain shared by the Default-chip label and a
 * default pick: the configured `config.defaultModelSelection` while it
 * still selects a provider+model in this registry (legacy provider ids
 * migrated; the GUI never writes the key — only CLI login / TUI / import
 * do), else the first registry provider's first model at its highest
 * level (the CLI's own `registry-fallback`). A configured level the model
 * does not support invalidates the configured default, not the turn.
 */
export function resolveZcodeDefaultSelection(
  registry: readonly ZcodeRegistryProvider[],
  personal: unknown,
): ZcodeDefaultChoice | null {
  const first = registry[0]?.models[0];
  if (!first) return null;
  const fallback = (): ZcodeDefaultChoice => ({
    providerId: registry[0]!.providerId,
    providerName: registry[0]!.providerName,
    modelId: first.modelId,
    reasoningLevel: first.levels[first.levels.length - 1] ?? null,
  });
  const personalConfig = isRecord(personal) && isRecord(personal.config) ? personal.config : {};
  const configured = isRecord(personalConfig.defaultModelSelection)
    ? personalConfig.defaultModelSelection
    : null;
  if (!configured) return fallback();
  const providerId =
    typeof configured.providerId === "string"
      ? migrateLegacyZcodeProviderId(configured.providerId)
      : null;
  const provider = providerId ? registry.find((p) => p.providerId === providerId) : undefined;
  const model =
    provider && typeof configured.modelId === "string"
      ? provider.models.find((m) => m.modelId === configured.modelId)
      : undefined;
  if (!provider || !model) return fallback();
  const configuredLevel =
    isRecord(configured.options) && typeof configured.options.reasoningLevel === "string"
      ? configured.options.reasoningLevel
      : null;
  if (configuredLevel && !model.levels.includes(configuredLevel)) return fallback();
  return {
    providerId: provider.providerId,
    providerName: provider.providerName,
    modelId: model.modelId,
    reasoningLevel: configuredLevel ?? model.levels[model.levels.length - 1] ?? null,
  };
}

/** ─── Picker id codec ─── */

/**
 * Encode a (providerId, modelId, level?) picker choice into the single
 * string the UI store persists and the invoke layer receives as `model`:
 * `"<providerId>/<modelId>[/<level>]"` — the provider-namespace convention
 * the openclaw (`openrouter/anthropic/…`) and opencode (`anthropic/…`)
 * pickers use, so the same model id served by two providers never collides.
 * Level-less models (no `modelRules` entry) encode without the suffix.
 */
export function encodeZcodeModelChoice(
  providerId: string,
  modelId: string,
  reasoningLevel?: string | null,
): string {
  return reasoningLevel
    ? `${providerId}/${modelId}/${reasoningLevel}`
    : `${providerId}/${modelId}`;
}

/**
 * Structural decode: the first segment is always the providerId (ZCode
 * provider ids never contain `/`); the rest is the model id plus an
 * optional trailing level. Model ids CAN contain `/` (the catalog's
 * openrouter templates list vendor-prefixed ids like
 * `anthropic/claude-fable-5.1`), so the split point is not fixed here —
 * validation against the registry picks the reading. Returns null for ids
 * that cannot even be structurally split.
 */
export function decodeZcodeModelChoice(id: string): { providerId: string } | null {
  const segments = id.split("/");
  if (segments.length < 2 || segments.some((s) => s.length === 0)) return null;
  return { providerId: segments[0]! };
}

/** ─── Picker state (the detect layer's one call) ─── */

/** The detect layer's composed ZCode state. */
export interface ZcodePickerState {
  /** True when the registry mirror holds ≥1 usable provider. */
  ready: boolean;
  reason: ZcodeNotReadyReason | null;
  /** Chips in registry order; empty when not ready (caller keeps the
   * static floor and the invoke-time refusal reports the error). */
  options: ZcodeModelOption[];
  /** What "Default" resolves to right now; null when not ready. */
  defaultChoice: ZcodeDefaultChoice | null;
}

/**
 * Compose the picker state for a resolved cjs: enumerate the registry
 * (catalog + personal config + credential key names), expand it into
 * provider-namespaced chips, and resolve the Default label with the same
 * chain a default pick binds. Read-only; shared by the next + cli detect
 * mirrors so the two front ends cannot drift.
 */
export function readZcodePickerState(opts: {
  cjsPath: string;
  personalConfigPath?: string;
  credentialsPath?: string;
  cacheRoot?: string;
}): ZcodePickerState {
  const notReady: ZcodePickerState = {
    ready: false,
    reason: "no-usable-provider",
    options: [],
    defaultChoice: null,
  };
  const catalog = resolveZcodeCatalogFile({ cjsPath: opts.cjsPath, cacheRoot: opts.cacheRoot });
  if (!catalog) return notReady;
  const personal = readJsonFile(opts.personalConfigPath ?? defaultZcodePersonalConfigPath());
  if (!isRecord(personal)) return notReady;
  const credentials = readJsonFile(opts.credentialsPath ?? defaultZcodeCredentialsPath());
  const registry = enumerateZcodeRegistry(catalog.data, personal, credentials);
  if (registry.length === 0) return notReady;
  const options: ZcodeModelOption[] = [];
  for (const provider of registry) {
    for (const model of provider.models) {
      const levelChips = model.levels.length ? model.levels : [null];
      for (const level of levelChips) {
        options.push({
          id: encodeZcodeModelChoice(provider.providerId, model.modelId, level),
          label: level
            ? `${model.modelId} (${provider.providerName}, ${level})`
            : `${model.modelId} (${provider.providerName})`,
          providerId: provider.providerId,
        });
      }
    }
  }
  return {
    ready: true,
    reason: null,
    options,
    defaultChoice: resolveZcodeDefaultSelection(registry, personal),
  };
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
 * anything else passes through). Needed because a CLI-login-written
 * `defaultModelSelection` on an upgraded install may still carry the
 * legacy id.
 */
export function migrateLegacyZcodeProviderId(providerId: string): string {
  return LEGACY_PROVIDER_IDS[providerId] ?? providerId;
}

/** ─── Per-turn binding preparation (the invoke layer's one call) ─── */

/** The refusal links, in resolution order. */
export type ZcodeBindingRefusal =
  | "catalog-unreadable"
  | "provider-config-unreadable"
  | "no-usable-provider"
  | "provider-no-access"
  | "model-not-on-provider"
  | "level-unsupported";

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

/** Everything an explicit pick resolved to, plus the bridge material when
 * the target is an account provider that still needs its identity key. */
interface ResolvedSelection {
  selection: ZcodeModelSelection;
  /** Account target: the identity to ensure before spawning. */
  bridgeIdentity?: string;
}

/** Resolve the pick's tail against one provider's model table: the first
 * reading (shortest model id, then level-less) that validates becomes the
 * selection (optionally carrying bridge material); a validated model with
 * an unsupported level is the level refusal; no reading fits is the
 * model-not-on-provider refusal. */
function pickFromModels(
  raw: string,
  providerId: string,
  models: readonly ZcodeRegistryModel[],
  bridgeIdentity?: string,
): { ok: true; value: ResolvedSelection } | { ok: false; code: ZcodeBindingRefusal; message: string } {
  const outcome = matchModelReadings(raw, models);
  if (outcome.match) {
    return {
      ok: true,
      value: {
        selection: {
          providerId,
          modelId: outcome.match.modelId,
          reasoningLevel: outcome.match.reasoningLevel,
        },
        ...(bridgeIdentity ? { bridgeIdentity } : {}),
      },
    };
  }
  if (outcome.levelIssue) return { ok: false, code: "level-unsupported", message: outcome.levelIssue };
  return {
    ok: false,
    code: "model-not-on-provider",
    message: modelNotOnProviderMessage(providerId),
  };
}

/**
 * Resolve an explicit picker id against the candidate tables. Model ids may
 * contain `/` (openrouter-style ids), so the split between model id and
 * trailing level is settled by validation: the shortest model reading whose
 * provider+model exist wins, with a valid level preferred over an invalid
 * one at the same reading. Personal providers that exist but are not
 * usable (key removed / disabled / hidden / no enabled models) and account
 * providers without their credential pair surface as `provider-no-access`
 * rather than a stale-pick error, so the message can name the fix.
 */
function resolveExplicitPick(
  raw: string,
  input: {
    registry: readonly ZcodeRegistryProvider[];
    accounts: readonly AccountCandidate[];
    personals: readonly PersonalCandidate[];
    credentials: Record<string, unknown>;
  },
): { ok: true; value: ResolvedSelection } | { ok: false; code: ZcodeBindingRefusal; message: string } {
  const decoded = decodeZcodeModelChoice(raw);
  if (!decoded) {
    return {
      ok: false,
      code: "model-not-on-provider",
      message:
        `ZCode: the saved model choice "${raw}" is stale or malformed (expected "<provider>/<model>[/<level>]"). Re-scan agents in Settings and pick a model again, then retry.`,
    };
  }
  const providerId = decoded.providerId;

  // Prefer the usable registry: its models already passed the enabled
  // overlays and its account entries proved their credential pair.
  const registryEntry = input.registry.find((p) => p.providerId === providerId);
  if (registryEntry) {
    return pickFromModels(raw, providerId, registryEntry.models);
  }

  // Known account provider, not in the registry: its credential pair did
  // not hold. An api-key key alone is still bindable — the identity bridge
  // below completes the pair — but no key at all (or a stale identity
  // value) is the provider-no-access refusal.
  const account = input.accounts.find((a) => a.providerId === providerId);
  if (account) {
    const apiKeyEntry = findCodingPlanApiKeyEntry(input.credentials, providerId);
    if (!apiKeyEntry) {
      return {
        ok: false,
        code: "provider-no-access",
        message:
          `ZCode: no saved Coding Plan credential for ${providerId}. Open ZCode, log in to your Coding Plan, then retry.`,
      };
    }
    const pair = accountPair(input.credentials, providerId);
    if (pair) {
      // Paired but not in the registry: every model was disabled. Nothing
      // bindable remains on the provider.
      return {
        ok: false,
        code: "model-not-on-provider",
        message: modelNotOnProviderMessage(providerId),
      };
    }
    const identityRaw = input.credentials[`account-provider:${providerId}:identity`];
    if (typeof identityRaw === "string" && identityRaw.trim()) {
      // An identity value exists but names no api-key key: add-only means
      // the bridge must not overwrite it, and binding anyway would let the
      // CLI drop the provider and silently reroute. Refuse instead.
      return {
        ok: false,
        code: "provider-no-access",
        message:
          `ZCode: the saved identity for ${providerId} is stale (its api-key credential is missing). Log in again in ZCode (zcode login), then retry.`,
      };
    }
    return pickFromModels(raw, providerId, account.models, apiKeyEntry.identity);
  }

  // Known personal provider, not usable right now (key removed / disabled /
  // hidden / no enabled models left).
  const personal = input.personals.find((p) => p.providerId === providerId);
  if (personal) {
    return {
      ok: false,
      code: "provider-no-access",
      message:
        `ZCode: provider ${personal.providerName} (${providerId}) has no usable model right now (missing API key, disabled, or every model disabled). Open ZCode, restore its key or enable a model, then rescan and retry.`,
    };
  }

  return {
    ok: false,
    code: "model-not-on-provider",
    message:
      `ZCode: the saved model choice "${raw}" does not match any provider in your ZCode config. Re-scan agents in Settings and pick a model again, then retry.`,
  };
}

function modelNotOnProviderMessage(providerId: string): string {
  return `ZCode: that model is not available on ${providerId}. Re-scan agents in Settings and pick another model, then retry.`;
}

/**
 * Try every reading of the id's tail as (modelId, level?): shortest model
 * first, level-less reading last. A reading whose model exists but whose
 * level is unsupported is remembered so the refusal can list the supported
 * levels; a fully valid reading wins immediately.
 */
function matchModelReadings(
  raw: string,
  models: readonly ZcodeRegistryModel[],
): {
  match: { modelId: string; reasoningLevel: string | null } | null;
  levelIssue: string | null;
} {
  const segments = raw.split("/");
  let levelIssue: string | null = null;
  // Level readings: level = segments[k], model = segments[1..k); then the
  // level-less reading model = segments[1..n).
  for (let k = 1; k <= segments.length - 1; k++) {
    const modelId = segments.slice(1, k).join("/");
    const level = segments[k]!;
    const entry = models.find((m) => m.modelId === modelId);
    if (!entry) continue;
    if (entry.levels.includes(level)) {
      return { match: { modelId: entry.modelId, reasoningLevel: level }, levelIssue: null };
    }
    levelIssue =
      `ZCode: reasoning level "${level}" is not supported for ${entry.modelId} on this provider (supported: ${
        entry.levels.join(", ") || "none"
      }). Re-scan agents in Settings and pick again.`;
  }
  const levelless = segments.slice(1).join("/");
  const entry = models.find((m) => m.modelId === levelless);
  if (entry) return { match: { modelId: entry.modelId, reasoningLevel: null }, levelIssue: null };
  return { match: null, levelIssue };
}

/**
 * Resolve + write the per-turn binding: the refusal chain, then one temp
 * artifact — a clone of the user's personal provider config with the exact
 * `config.defaultModelSelection` — plus, for an account target, the one
 * sanctioned credential write (the identity bridge; see module header).
 *
 * `model` semantics: undefined / "default" binds the registry default —
 * the CLI-login/TUI-written `defaultModelSelection` while it still selects
 * something in the registry (legacy provider ids migrated), else the first
 * registry provider's first model at its highest level. Any other string
 * is an explicit pick and must validate against the registry, else the
 * matching refusal fires; a bare or stale id never silently reroutes.
 */
export function prepareZcodeModelBinding(opts: {
  cjsPath: string;
  /** Picker id: undefined | "default" | "<providerId>/<modelId>[/<level>]". */
  model?: string;
  /** Directory for the temp artifacts, the invoke layer's attach temp dir.
   * Its existing cleanup removes everything with the prompt file. */
  attachDir: string;
  personalConfigPath?: string;
  credentialsPath?: string;
  cacheRoot?: string;
}): ZcodeBindingResult {
  const catalog = resolveZcodeCatalogFile({ cjsPath: opts.cjsPath, cacheRoot: opts.cacheRoot });
  if (!catalog) {
    return {
      ok: false,
      code: "catalog-unreadable",
      message:
        "ZCode: the bundled provider catalog could not be read (neither next to the install nor in the runtime cache). Reinstall ZCode or point ZCODE_BIN at a full install, then retry.",
    };
  }
  const personal = readJsonFile(opts.personalConfigPath ?? defaultZcodePersonalConfigPath());
  if (!isRecord(personal) || !isRecord(personal.config)) {
    return {
      ok: false,
      code: "provider-config-unreadable",
      message:
        "ZCode: the provider config (~/.zcode/v2/provider_config.json) is missing or malformed. Open the ZCode GUI once so it can initialize the config, then retry.",
    };
  }
  const credentials = readJsonFile(opts.credentialsPath ?? defaultZcodeCredentialsPath());
  const credentialRecord = isRecord(credentials) ? credentials : {};
  const tables = readRuleTables(catalog.data, personal);
  const accounts = accountCandidates(catalog.data, tables);
  const personals = personalCandidates(catalog.data, personal, tables);
  const registry = enumerateZcodeRegistry(catalog.data, personal, credentialRecord);

  let resolved: ResolvedSelection;
  if (opts.model === undefined || opts.model === "default") {
    const noUsableProvider = (): ZcodeBindingResult => ({
      ok: false,
      code: "no-usable-provider",
      message:
        "ZCode: no usable model provider. Open ZCode, log in or add a model provider, then retry.",
    });
    if (registry.length === 0) return noUsableProvider();
    const def = resolveZcodeDefaultSelection(registry, personal);
    // registry[0].models[0] exists by construction, so def is never null here.
    if (!def) return noUsableProvider();
    const account = registry.find((p) => p.providerId === def.providerId && p.kind === "account");
    resolved = {
      selection: {
        providerId: def.providerId,
        modelId: def.modelId,
        reasoningLevel: def.reasoningLevel,
      },
      ...(account?.accountIdentity ? { bridgeIdentity: account.accountIdentity } : {}),
    };
  } else {
    const outcome = resolveExplicitPick(opts.model, {
      registry,
      accounts,
      personals,
      credentials: credentialRecord,
    });
    if (!outcome.ok) return outcome;
    resolved = outcome.value;
  }

  // Identity bridge on the real credential store: account targets only,
  // add-only (an existing identity value is never modified), re-checked
  // every turn. A default/registry account target already proved its pair,
  // so this writes nothing; an explicit account pick whose identity key
  // vanished between scans gets it back — without the key the headless
  // registry drops the provider and silently reroutes the turn.
  const bridgeIdentity = resolved.bridgeIdentity;
  if (bridgeIdentity) {
    const identityKey = `account-provider:${resolved.selection.providerId}:identity`;
    const existing = credentialRecord[identityKey];
    if (typeof existing !== "string" || !existing.trim()) {
      const credentialsPath = opts.credentialsPath ?? defaultZcodeCredentialsPath();
      try {
        const bridged = { ...credentialRecord, [identityKey]: bridgeIdentity };
        const tmpPath = `${credentialsPath}.html-anything-tmp`;
        writeFileSync(tmpPath, JSON.stringify(bridged, null, 2), "utf8");
        renameSync(tmpPath, credentialsPath);
      } catch (err) {
        return {
          ok: false,
          code: "provider-no-access",
          message: `ZCode: failed to add the Coding Plan identity credential to ${credentialsPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
  }

  // Deep-clone via JSON round-trip: the source is freshly-parsed JSON anyway.
  const clone = JSON.parse(JSON.stringify(personal)) as { config?: Record<string, unknown> };
  clone.config = {
    ...clone.config,
    defaultModelSelection: resolved.selection.reasoningLevel
      ? {
        providerId: resolved.selection.providerId,
        modelId: resolved.selection.modelId,
        options: { reasoningLevel: resolved.selection.reasoningLevel },
      }
      : {
        providerId: resolved.selection.providerId,
        modelId: resolved.selection.modelId,
      },
  };
  mkdirSync(opts.attachDir, { recursive: true });
  const clonePath = join(opts.attachDir, "provider-config.clone.json");
  try {
    writeFileSync(clonePath, JSON.stringify(clone, null, 2), "utf8");
  } catch (err) {
    return {
      ok: false,
      code: "provider-config-unreadable",
      message: `ZCode: failed to write the temp provider-config clone: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  return {
    ok: true,
    selection: resolved.selection,
    clonePath,
    builtinCatalogPath: catalog.path,
  };
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
