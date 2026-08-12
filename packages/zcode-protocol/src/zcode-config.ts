/**
 * Reader for ZCode's saved model-provider selection — the GUI's **resolved**
 * config, not the provider template.
 *
 * ZCode's GUI materializes the user's configured providers into
 * `~/.zcode/v2/config.json` under a `provider` map, keyed by provider id
 * (`builtin:bigmodel`, `builtin:bigmodel-coding-plan`, `builtin:zai`, …).
 * Each entry carries a `kind` (`anthropic` | `openai` | `openai-compatible`),
 * an `options.apiKey` + `options.baseURL`, an `enabled` flag, and a `models`
 * map keyed by model id. For Coding Plan / entitlement providers this is the
 * file that holds the **resolved** api key (the GUI's OAuth→key exchange
 * writes the plaintext key here); the sibling `v2/model-providers.json` is
 * only a *template* whose coding-plan entries have `apiKey: ""`.
 *
 * #14 (2026-08-10) restored the provider relay that #13 deleted. Live probes
 * of the real app-server proved a fresh `session/create` fails with
 * `ModelProtocolError: Model config is missing` unless the client first runs
 * `workspace/upsertModelProvider` + `workspace/setDefaultModel` for the
 * workspace (once per booted child — see {@link ensureWorkspaceModel}). The
 * relay is model *selection*, not credential grafting: it reads ZCode's own
 * config file and feeds the selection back to ZCode's own child
 * (left-pocket → right-pocket). The login still self-authenticates
 * (`session/list` works with no relay); only the model selection must be
 * provisioned.
 *
 * The module is deliberately tolerant: a missing file or malformed JSON yields
 * `null`, never a throw, so the caller can surface "no saved provider" as an
 * ordinary (actionable) error.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./internal";

/**
 * The API-key credential object the app-server's `workspace/upsertModelProvider`
 * expects on the `provider.apiKey` field. The real server rejects a bare string
 * here — it is a discriminated union on `source`, and the `source: "inline"`
 * branch accepts the key as a string `value`. (Live-confirmed by #14 probe-9:
 * `provider.apiKey: expected object, received string`.)
 */
export interface ZcodeApiKey {
  source: "inline";
  value: string;
}

/** Wire format the upsert schema accepts on `provider.kind`. */
export type ZcodeProviderKind = "anthropic" | "openai" | "openai-compatible";

/**
 * The full provider object the app-server's `workspace/upsertModelProvider`
 * requires, mapped from the saved GUI entry. The server validates this with a
 * Zod schema and rejects a bare provider-id string
 * (`provider: expected object, received string`). Field shapes are
 * live-confirmed (#14 probes 5–12):
 *   - `providerId` — the GUI entry's key (e.g. `builtin:bigmodel-coding-plan`)
 *   - `kind` — one of the three wire kinds
 *   - `apiKey` — the `{source:"inline", value}` credential object (NOT a string)
 *   - `models` — `[{ modelId }]` records (the server rejects bare strings)
 *   - `baseURL` — optional; accepted when present (probe-11 confirmed
 *     `baseURL` with a capital URL is accepted; the lowercase `baseUrl` is
 *     rejected as an unrecognized key)
 */
export interface ZcodeProviderRecord {
  providerId: string;
  kind: ZcodeProviderKind;
  apiKey: ZcodeApiKey;
  models: { modelId: string }[];
  baseURL?: string;
}

/** The canonical provider selection the adapter hands to the protocol layer. */
export interface ZcodeConfig {
  /** Provider id, e.g. `builtin:bigmodel-coding-plan` (the map key). */
  provider: string;
  /**
   * The provider's default model (the workspace default handed to
   * `setDefaultModel`). ZCode stores no explicit "selected model" on the
   * provider entry, so this is the first key in the `models` map (the GUI's
   * display order).
   */
  model: string;
  /** The provider's full model list, for the picker / `fallbackModels`. */
  models: string[];
  /**
   * The full provider record handed to `workspace/upsertModelProvider`. The
   * app-server requires an object here (provider id + wire kind + inline
   * api-key + model records), not a bare provider-id string.
   */
  providerRecord: ZcodeProviderRecord;
}

/** One entry under `config.json`'s `provider` map (fields we read). */
interface RawProviderEntry {
  kind?: unknown;
  enabled?: unknown;
  /**
   * The GUI sets this on expired/inactive entitlements (e.g. a Coding Plan the
   * user is no longer entitled to, or an OAuth provider whose session lapsed).
   * A non-empty value disqualifies the entry — see {@link isUsableZcodeProvider}.
   */
  systemDisabledReason?: unknown;
  options?: unknown;
  models?: unknown;
}

/** The `options` object inside a provider entry. */
interface RawProviderOptions {
  apiKey?: unknown;
  baseURL?: unknown;
}

/**
 * Default location of the GUI's resolved config, resolved per-platform at call
 * time via `os.homedir()` — works on Windows (`C:\Users\<u>\.zcode`) and
 * Linux/macOS (`~/.zcode`).
 */
export function defaultZcodeConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "config.json");
}

/** Narrow the raw `kind` to one of the three wire kinds the upsert accepts. */
function coerceKind(kind: unknown): ZcodeProviderKind | null {
  if (kind === "anthropic" || kind === "openai" || kind === "openai-compatible") {
    return kind;
  }
  return null;
}

/**
 * The ONE shared definition of "usable provider" (ADR-0010 Decision 2): an
 * entry is usable when it is `enabled`, carries NO non-empty
 * `systemDisabledReason`, has a recognized `kind`, AND a non-empty
 * `options.apiKey`.
 *
 * Called by BOTH the relay reader ({@link parseProviderEntry}) and the picker
 * (zcode-model-picker.ts), so the two cannot drift again. They had drifted:
 * the picker checked `systemDisabledReason` while the relay did not, so the
 * relay could bind an entitlement-expired provider (`enabled` + leftover
 * `apiKey` + `systemDisabledReason`) whose models the picker hid — i.e. a
 * provider `session/create` then could not actually serve. The relay's extra
 * "≥1 model" requirement (needed to build the upsert record) is NOT part of
 * this predicate; it stays in {@link parseProviderEntry} because the picker has
 * no such need.
 */
export function isUsableZcodeProvider(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const entry = raw as RawProviderEntry;
  if (entry.enabled !== true) return false;
  if (
    typeof entry.systemDisabledReason === "string" &&
    entry.systemDisabledReason.length > 0
  ) {
    return false;
  }
  if (!coerceKind(entry.kind)) return false;
  const options = isRecord(entry.options) ? (entry.options as RawProviderOptions) : null;
  const apiKey = options && typeof options.apiKey === "string" ? options.apiKey : "";
  return apiKey.length > 0;
}

/**
 * Validate one raw provider entry; return the canonical selection or `null`.
 *
 * Gates on the shared {@link isUsableZcodeProvider} predicate (enabled, no
 * `systemDisabledReason`, recognized kind, non-empty apiKey — ADR-0010), then
 * applies the relay's additional "≥1 model" requirement to build the upsert
 * record. Coding Plan and first-party BigModel entries both qualify (the GUI
 * writes the resolved key into `options.apiKey` for both).
 */
function parseProviderEntry(
  providerId: string,
  raw: RawProviderEntry,
): ZcodeConfig | null {
  if (!isUsableZcodeProvider(raw)) return null;

  const kind = coerceKind(raw.kind);
  // Guaranteed non-null by isUsableZcodeProvider; guard keeps the type narrow.
  if (!kind) return null;

  const options = isRecord(raw.options) ? (raw.options as RawProviderOptions) : null;
  const apiKey =
    options && typeof options.apiKey === "string" ? options.apiKey : "";

  // `models` is a MAP keyed by model id in config.json (unlike the array shape
  // in the template model-providers.json). Pull the keys as model ids.
  const modelsMap = isRecord(raw.models) ? raw.models : null;
  if (!modelsMap) return null;
  const modelIds = Object.keys(modelsMap).filter((id) => typeof id === "string" && id.length > 0);
  if (modelIds.length === 0) return null;

  const firstModel = modelIds[0]!;
  const baseURL =
    options && typeof options.baseURL === "string" && options.baseURL.length > 0
      ? options.baseURL
      : undefined;

  const providerRecord: ZcodeProviderRecord = {
    providerId,
    kind,
    apiKey: { source: "inline", value: apiKey },
    models: modelIds.map((modelId) => ({ modelId })),
    ...(baseURL ? { baseURL } : {}),
  };

  return {
    provider: providerId,
    model: firstModel,
    models: modelIds,
    providerRecord,
  };
}

/**
 * Parse an already-decoded `config.json` into the canonical selection.
 *
 * Iterates the `provider` map in insertion order and returns the first
 * usable entry. Returns `null` for non-object input, an empty/missing
 * `provider` map, no qualifying entry, or any malformed entry (malformed
 * entries are skipped, never thrown on). Prefer coding-plan/bigmodel entries
 * by leaving them earlier in the file (the GUI does).
 */
export function parseZcodeConfig(data: unknown): ZcodeConfig | null {
  if (!isRecord(data)) return null;
  const providers = isRecord(data.provider) ? data.provider : null;
  if (!providers) return null;

  for (const [id, entry] of Object.entries(providers)) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (!isRecord(entry)) continue;
    const config = parseProviderEntry(id, entry as RawProviderEntry);
    if (config) return config;
  }
  return null;
}

/**
 * Parse an already-decoded `config.json` and return the canonical selection
 * for a SPECIFIC provider id — the GUI-selected default
 * (`~/.zcode/v2/setting.json`'s `modelProviderFamilySelectedKeys`, which the
 * picker resolves as `defaultProviderId`).
 *
 * Returns `null` when the id is absent, the entry is not a usable provider
 * (fails {@link isUsableZcodeProvider}), or has no models — so the caller
 * ({@link ensureWorkspaceModel}) can fall back to the first usable entry
 * ({@link parseZcodeConfig}) when the GUI default is unusable/absent. Unlike
 * {@link parseZcodeConfig}, this NEVER falls through to another provider: it
 * targets exactly the requested id, or nothing. Tolerant: never throws.
 */
export function parseZcodeConfigForProvider(
  data: unknown,
  providerId: string,
): ZcodeConfig | null {
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  if (!isRecord(data)) return null;
  const providers = isRecord(data.provider) ? data.provider : null;
  if (!providers) return null;
  const entry = (providers as Record<string, unknown>)[providerId];
  if (!isRecord(entry)) return null;
  return parseProviderEntry(providerId, entry as RawProviderEntry);
}

/**
 * Read + JSON.parse the config file; `null` on missing/unreadable/malformed.
 * Shared by the first-usable and targeted readers so the disk/posture logic
 * stays in one place.
 */
function readConfigData(filePath: string): unknown {
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
 * Read the provider store from disk and return the canonical selection.
 *
 * @param filePath Override the config location (defaults to
 *   {@link defaultZcodeConfigPath}). Useful for tests.
 * @returns The selection, or `null` if the file is missing, unreadable, holds
 *   malformed JSON, or contains no enabled provider with a non-empty API key.
 *   Never throws.
 */
export function readZcodeConfig(filePath: string = defaultZcodeConfigPath()): ZcodeConfig | null {
  return parseZcodeConfig(readConfigData(filePath));
}

/**
 * Read the provider store from disk and return the canonical selection for a
 * SPECIFIC provider id (the GUI-selected default). Used by
 * {@link ensureWorkspaceModel} to honour the GUI default.
 *
 * @param providerId The provider to target (the picker-resolved
 *   `defaultProviderId`). NEVER falls through to another provider.
 * @param filePath Override the config location (defaults to
 *   {@link defaultZcodeConfigPath}). Useful for tests.
 * @returns The selection, or `null` if the file is missing/unreadable/malformed,
 *   the id is absent, or the entry is not a usable provider. Never throws.
 */
export function readZcodeConfigForProvider(
  providerId: string,
  filePath: string = defaultZcodeConfigPath(),
): ZcodeConfig | null {
  return parseZcodeConfigForProvider(readConfigData(filePath), providerId);
}
