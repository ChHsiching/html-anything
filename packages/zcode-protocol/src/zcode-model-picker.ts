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
// The usable-provider predicate is the ONE shared definition (ADR-0010 Decision
// 2): the picker and the workspace-default relay both call it, so they cannot
// drift on what counts as a usable provider. Defined in zcode-config.ts beside
// the relay reader that also consumes it.
import { isUsableZcodeProvider } from "./zcode-config";

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
   * Model entries for every usable provider (the shared
   * {@link isUsableZcodeProvider} predicate), deduped by modelId (T7 /
   * ADR-0010 Decision 3): at most one entry per modelId, so when two usable
   * providers share a modelId only the GUI-default provider's entry survives
   * ({@link defaultProviderId} is passed as the dedup preference). Caller
   * prepends `DEFAULT_MODEL`. Insertion order follows `config.json` (the GUI's
   * display order; a deduped entry keeps its first-occurrence position). Empty
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

/**
 * One entry under `config.json`'s `provider` map. This module reads `models`
 * directly; the usable-provider fields (`enabled`, `systemDisabledReason`,
 * `kind`, `options.apiKey`) are inspected by the shared
 * {@link isUsableZcodeProvider} predicate, which both this reader and the
 * workspace-default relay call (ADR-0010).
 */
interface RawProviderEntry {
  enabled?: unknown;
  systemDisabledReason?: unknown;
  kind?: unknown;
  options?: unknown;
  models?: unknown;
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
 * "Usable" is the shared {@link isUsableZcodeProvider} predicate (ADR-0010
 * Decision 2): `enabled`, no non-empty `systemDisabledReason`, recognized
 * `kind`, non-empty `options.apiKey`. The workspace-default relay reader gates
 * on the SAME predicate, so the picker can never offer a provider the relay
 * refuses to provision (or hide one the relay binds). The `apiKey` non-empty
 * check is load-bearing: the live GUI keeps first-party placeholders like
 * `builtin:bigmodel` with `enabled:true` but `apiKey:""` (the GUI prompts for
 * a key when the user selects it); a headless adapter cannot prompt, so those
 * models would be offered-but-broken.
 *
 * ## Uniqueness: dedup by modelId (T7 / ADR-0010 Decision 3)
 *
 * The apiKey filter alone does NOT keep model ids unique when **two usable
 * providers** carry the same modelId (e.g. a Coding Plan and a separately-keyed
 * provider both exposing `GLM-5.2`). That yields duplicate `id`s, which break
 * ModelPicker's `key={id}` / `active = id === modelId` uniqueness contract. So
 * after the usable filter, entries are **deduped by modelId**: at most one entry
 * per modelId. When a modelId collides across providers, the entry whose
 * `providerId === preferredProviderId` wins (the GUI-default provider — even if
 * a different provider appeared first in config order); with no preference, or
 * the preferred provider not among the colliding ones, the first-in-config-order
 * entry wins (the GUI's display order). The kept entry keeps the bare modelId
 * as its `id` (shape unchanged) and sits at the modelId's first-occurrence
 * position, so GUI display order is preserved; only the `providerId` may change.
 *
 * @param data The decoded `config.json` (its `provider` map is read).
 * @param preferredProviderId Optional: the GUI-default provider id. When a
 *   modelId appears under multiple usable providers, the entry for this provider
 *   is the one kept. `null`/`undefined`/unknown → first-in-config-order wins.
 *   Wired from {@link readZcodeModelPicker} via `resolveZcodeDefaultSelection`.
 *
 * Exported for direct unit testing. Iterates providers in insertion order
 * (config.json's object key order = the GUI's display order); within a
 * provider, models iterate in their map key order. Tolerant: malformed entries
 * are skipped, never thrown on.
 */
export function parseZcodePickerModels(
  data: unknown,
  preferredProviderId?: string | null,
): ZcodePickerModel[] {
  if (!isRecord(data)) return [];
  const providers = isRecord(data.provider) ? data.provider : null;
  if (!providers) return [];

  // Pass 1: collect one candidate per usable-provider model, in config (GUI
  // display) order. Only usable providers (the shared predicate) expose their
  // models — see isUsableZcodeProvider for why the apiKey check is load-bearing
  // (placeholder providers would otherwise offer models the headless adapter
  // cannot run).
  const candidates: ZcodePickerModel[] = [];
  for (const [providerId, entry] of Object.entries(providers)) {
    if (!providerId || !isRecord(entry)) continue;
    const raw = entry as RawProviderEntry;
    if (!isUsableZcodeProvider(raw)) continue;
    const modelsMap = isRecord(raw.models) ? raw.models : null;
    if (!modelsMap) continue;
    for (const modelId of Object.keys(modelsMap)) {
      if (!modelId) continue;
      candidates.push({ id: modelId, label: modelId, providerId });
    }
  }

  // Pass 2: dedup by modelId (T7 / ADR-0010 Decision 3). A Map keyed by modelId
  // keeps the first-occurrence position for each id (re-setting an existing key
  // updates the value, not the iteration order). On a collision, the preferred
  // provider's entry (if present among the colliding ones) wins; otherwise the
  // first-in-config-order entry stays. The id stays the bare modelId — only the
  // providerId may flip to the preferred provider's.
  const deduped = new Map<string, ZcodePickerModel>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.id);
    if (!existing) {
      deduped.set(candidate.id, candidate);
      continue;
    }
    // Collision: replace with the preferred provider's entry if this candidate
    // is it (the GUI-default provider wins even when it appears later in config
    // order). With no preference, or the preferred provider not among the
    // colliding entries, the first-seen entry stays untouched.
    if (preferredProviderId && candidate.providerId === preferredProviderId) {
      deduped.set(candidate.id, candidate);
    }
  }
  return [...deduped.values()];
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
    // The selected provider must itself be usable (the shared
    // isUsableZcodeProvider predicate, same gate as the picker list) for its
    // default model to be a sensible highlight — otherwise we'd highlight a
    // placeholder provider the relay cannot provision.
    if (!isUsableZcodeProvider(raw)) continue;
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
  const setting = readJsonFile(settingPath);
  // Resolve the GUI selection BEFORE parsing the picker so the dedup can prefer
  // the GUI-default provider on a usable-vs-usable modelId collision (T7 /
  // ADR-0010 Decision 3) — the deduped entry then matches the provider the user
  // sees selected, consistent with the relay's GUI-default behaviour (Decision 2).
  const selection = resolveZcodeDefaultSelection(
    isRecord(setting) ? setting.modelProviderFamilySelectedKeys : null,
    config,
  );
  const defaultProviderId = selection ? selection.providerId : null;
  const models = parseZcodePickerModels(config, defaultProviderId);
  return {
    models,
    defaultProviderId,
    defaultModelId: selection ? selection.modelId : null,
  };
}
