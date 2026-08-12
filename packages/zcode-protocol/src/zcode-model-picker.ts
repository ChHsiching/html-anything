/**
 * Dynamic model-picker source for the ZCode agent (#19 / ADR-0005 decision 4).
 *
 * After #13/#14 deleted the client-side provider relay, the ZCode picker fell
 * back to a single `[DEFAULT_MODEL]` entry. A live probe of the app-server's
 * RPC surface (47 candidate enumeration methods, all `-32601 Method not
 * found`; the complete method table extracted from `app.asar`) proved there is
 * **no enumeration RPC**. The authoritative source of the models a user can
 * actually use is the config file the ZCode GUI itself writes:
 * `~/.zcode/v2/config.json`'s top-level `provider` object.
 *
 * This reader populates the picker the same way the relay reads the same file:
 * a credential-free read. Only model ids + the enabled flag are consumed — no
 * `apiKey` leaves the local machine (the same posture as {@link readZcodeConfig}
 * in zcode-config.ts, which this complements). The static template
 * `model-providers.json` is deliberately NOT read: its coding-plan entries
 * carry `apiKey: ""`, so it would offer models the user cannot actually use.
 *
 * Filter: a provider's models appear in the picker iff the provider is
 * `enabled: true` AND carries no `systemDisabledReason` (the GUI sets the
 * latter on expired/inactive entitlements — e.g. a Coding Plan the user is no
 * longer entitled to, or an OAuth provider whose session lapsed). This hides
 * models the user cannot reach, which the bare `enabled` flag alone would not.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./internal";

/**
 * A picker entry. Mirrors the app's `ModelOption` shape (`{ id, label }`) and
 * additionally carries the `providerId` the model belongs to, so the invoke
 * layer can recover the `{ providerId, modelId }` pair `session/create` needs
 * from a bare model id (the UI stores only the id string per agent).
 */
export interface ZcodePickerModel {
  /** Model id — also the picker value (e.g. `GLM-5-Turbo`). */
  id: string;
  /** Human label. Today identical to the id (the GUI stores no display name on
   * every model; some carry one, but the id is unambiguous and stable). */
  label: string;
  /** The provider id this model belongs to (e.g. `builtin:bigmodel-coding-plan`). */
  providerId: string;
}

/** The dynamic picker result handed to the detect layer. */
export interface ZcodePickerOptions {
  /**
   * Model entries for every `enabled` provider (no `systemDisabledReason`),
   * each model id becoming one entry. Caller prepends `DEFAULT_MODEL`.
   * Insertion order follows `config.json` (the GUI's display order). Empty
   * when no usable provider is configured — caller falls back to
   * `[DEFAULT_MODEL]`.
   */
  models: ZcodePickerModel[];
  /**
   * The provider id the GUI currently has selected for the default family
   * (derived from `~/.zcode/v2/setting.json`'s
   * `modelProviderFamilySelectedKeys`), or `null` when unresolvable. The
   * invoke layer uses this to disambiguate a picked model id that exists
   * under MULTIPLE enabled providers (e.g. GLM-5.2 is on both `builtin:bigmodel`
   * and `builtin:bigmodel-coding-plan`) — the selected provider's entry wins.
   */
  defaultProviderId: string | null;
  /**
   * The model id the GUI currently has selected for the default family (the
   * selected provider's first model id), or `null` when unresolvable. The
   * caller may use this to highlight the active model; the UI store still
   * defaults to `DEFAULT_MODEL` when no per-agent pick is persisted.
   */
  defaultModelId: string | null;
}

/** One entry under `config.json`'s `provider` map (fields we read). */
interface RawProviderEntry {
  enabled?: unknown;
  systemDisabledReason?: unknown;
  kind?: unknown;
  options?: unknown;
  models?: unknown;
}

/** The `options` object inside a provider entry. */
interface RawProviderOptions {
  apiKey?: unknown;
}

/**
 * Narrow the raw `kind` to one of the three wire kinds. Mirrors the relay
 * reader's `coerceKind` (zcode-config.ts) so both readers agree on what counts
 * as a usable provider — drift here would mean the picker offers a provider the
 * relay refuses to provision (or vice versa).
 */
function isKnownKind(kind: unknown): boolean {
  return kind === "anthropic" || kind === "openai" || kind === "openai-compatible";
}

/**
 * Is this raw provider entry usable — i.e. would the workspace-default relay
 * actually provision it? Mirrors {@link parseProviderEntry} in zcode-config.ts:
 * enabled, no systemDisabledReason, recognized kind, non-empty apiKey. Both the
 * picker list and the default-selection highlight must agree on this, or the
 * picker would offer / highlight a provider the relay refuses to run.
 */
function isUsableProvider(raw: RawProviderEntry): boolean {
  if (raw.enabled !== true) return false;
  if (typeof raw.systemDisabledReason === "string" && raw.systemDisabledReason.length > 0) {
    return false;
  }
  if (!isKnownKind(raw.kind)) return false;
  const options = isRecord(raw.options) ? (raw.options as RawProviderOptions) : null;
  const apiKey = options && typeof options.apiKey === "string" ? options.apiKey : "";
  return apiKey.length > 0;
}

/** `~/.zcode/v2/setting.json`'s `modelProviderFamilySelectedKeys` (fields we read). */
type RawSelectedKeys = Record<string, unknown>;

/**
 * Default location of the GUI's resolved config. Resolved per-platform at call
 * time via `os.homedir()` — mirrors {@link defaultZcodeConfigPath} in
 * zcode-config.ts (same file, same posture).
 */
export function defaultZcodeConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "config.json");
}

/** Default location of the GUI's settings file (holds the selected provider). */
export function defaultZcodeSettingPath(): string {
  return join(homedir(), ".zcode", "v2", "setting.json");
}

/**
 * Parse an already-decoded `config.json` `provider` map into picker entries,
 * filtered to providers that are actually usable.
 *
 * A provider is usable when it is `enabled`, has no `systemDisabledReason`,
 * has a recognized `kind`, AND has a non-empty `options.apiKey`. This is the
 * SAME filter the workspace-default relay reader applies
 * (zcode-config.ts `parseProviderEntry`) — the picker must not offer a
 * provider the relay refuses to provision. The `apiKey` non-empty check is
 * load-bearing: the live GUI keeps first-party placeholders like
 * `builtin:bigmodel` with `enabled:true` but `apiKey:""` (the GUI prompts for
 * a key when the user selects it); a headless adapter cannot prompt, so those
 * models would be offered-but-broken. Dropping them here also keeps model ids
 * unique across the picker (the same modelId often exists under both the
 * placeholder and the usable Coding Plan provider), preserving ModelPicker's
 * `key={id}` / `active = id === modelId` uniqueness contract.
 *
 * Exported for direct unit testing. Iterates providers in insertion order
 * (config.json's object key order = the GUI's display order); within a
 * provider, models iterate in their map key order. Tolerant: malformed entries
 * are skipped, never thrown on.
 */
export function parseZcodePickerModels(data: unknown): ZcodePickerModel[] {
  if (!isRecord(data)) return [];
  const providers = isRecord(data.provider) ? data.provider : null;
  if (!providers) return [];

  const models: ZcodePickerModel[] = [];
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!providerId || !isRecord(entry)) continue;
    const raw = entry as RawProviderEntry;
    // Only usable providers (enabled, no disabledReason, recognized kind,
    // non-empty apiKey) expose their models — see isUsableProvider for why
    // the apiKey check is load-bearing (placeholder providers would otherwise
    // offer models the headless adapter cannot run, and duplicate ids that
    // break ModelPicker's key/active uniqueness contract).
    if (!isUsableProvider(raw)) continue;
    const modelsMap = isRecord(raw.models) ? raw.models : null;
    if (!modelsMap) continue;
    for (const modelId of Object.keys(modelsMap)) {
      if (!modelId) continue;
      models.push({ id: modelId, label: modelId, providerId });
    }
  }
  return models;
}

/**
 * Map the GUI's selected-provider record to the selected `{providerId, modelId}`.
 *
 * `setting.json`'s `modelProviderFamilySelectedKeys` is keyed by family
 * (`bigmodel`, `zai`, …) with values like `"coding-plan:builtin:bigmodel-coding-plan"`
 * — the provider id is the segment after the first colon (the providerId itself
 * contains a colon, `builtin:...`). We resolve that provider and return BOTH
 * its id (for invoke-layer disambiguation) and its first model id (the GUI's
 * display-order default). Returns `null` when the selection is absent or points
 * at a provider/models we cannot resolve.
 */
export function resolveZcodeDefaultSelection(
  selectedKeys: unknown,
  config: unknown,
): { providerId: string; modelId: string } | null {
  if (!isRecord(selectedKeys)) return null;
  const keys = selectedKeys as RawSelectedKeys;
  if (!isRecord(config)) return null;
  const providers = isRecord(config.provider) ? (config.provider as Record<string, unknown>) : null;
  if (!providers) return null;

  for (const value of Object.values(keys)) {
    if (typeof value !== "string" || value.length === 0) continue;
    // Resolve the selected value to a providerId that exists in config.provider.
    // The live GUI emits `<mode>:<providerId>` (e.g.
    // `coding-plan:builtin:bigmodel-coding-plan`), where the providerId itself
    // contains a colon (`builtin:...`). Because the providerId has its own
    // colon, a naive "after the last colon" or "after the first colon" split is
    // wrong for at least one shape — so instead try candidates against the real
    // config keys: the whole value, then the value after the FIRST colon's
    // prefix (the live shape), then the value after the LAST colon's prefix
    // (a `<x>:<slug>` shape with a colon-less slug). First candidate that is a
    // real provider key wins; this is robust to all observed shapes.
    const candidates = [value];
    if (value.includes(":")) {
      candidates.push(value.slice(value.indexOf(":") + 1));
      candidates.push(value.slice(value.lastIndexOf(":") + 1));
    }
    const providerId = candidates.find((c) => isRecord(providers[c]));
    if (!providerId) continue;
    const entry = providers[providerId];
    if (!isRecord(entry)) continue;
    const raw = entry as unknown as RawProviderEntry;
    // The selected provider must itself be usable (same filter as the picker
    // list) for its default model to be a sensible highlight — otherwise we'd
    // highlight a placeholder provider the relay cannot provision.
    if (!isUsableProvider(raw)) continue;
    const modelsMap = isRecord(raw.models) ? raw.models : null;
    if (!modelsMap) continue;
    const firstModelId = Object.keys(modelsMap)[0];
    if (firstModelId) return { providerId, modelId: firstModelId };
  }
  return null;
}

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

/**
 * Read the GUI's resolved config + settings and return the dynamic picker list.
 *
 * @param configPath Override the config location (defaults to
 *   {@link defaultZcodeConfigPath}). Useful for tests.
 * @param settingPath Override the settings location (defaults to
 *   {@link defaultZcodeSettingPath}). Useful for tests.
 * @returns The picker models + derived default selection. Never throws: a
 *   missing/unreadable file or malformed JSON yields `{ models: [], defaultProviderId: null, defaultModelId: null }`,
 *   and the caller falls back to `[DEFAULT_MODEL]`.
 */
export function readZcodeModelPicker(
  configPath: string = defaultZcodeConfigPath(),
  settingPath: string = defaultZcodeSettingPath(),
): ZcodePickerOptions {
  const config = readJsonFile(configPath);
  const models = parseZcodePickerModels(config);
  const setting = readJsonFile(settingPath);
  const selection = resolveZcodeDefaultSelection(
    isRecord(setting) ? setting.modelProviderFamilySelectedKeys : null,
    config,
  );
  return {
    models,
    defaultProviderId: selection ? selection.providerId : null,
    defaultModelId: selection ? selection.modelId : null,
  };
}
