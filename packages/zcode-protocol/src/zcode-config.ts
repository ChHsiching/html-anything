/**
 * Reader for ZCode's saved model-provider selection.
 *
 * ZCode's GUI writes its provider store to `~/.zcode/v2/model-providers.json`
 * as an array of providers, each with an `id`, `name`, `apiKey`, and `models[]`.
 * The adapter can only drive a provider that has a non-empty `apiKey` (an
 * empty key marks an un-configured entry). This module exports the saved
 * API-key provider selection plus its model list, which the app-server
 * protocol work (T4) feeds to `workspace/upsertModelProvider` /
 * `workspace/setDefaultModel`, and agent registration (T7) uses as
 * `fallbackModels`.
 *
 * The module is deliberately tolerant: a missing file or malformed JSON yields
 * `null`, never a throw, so callers can treat "no saved config" as an ordinary
 * (non-fatal) branch.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./internal.js";

/**
 * The API-key credential object the app-server's `workspace/upsertModelProvider`
 * expects on the `provider.apiKey` field. The real server rejects a bare string
 * here — it is a discriminated union on `source`, and the `source: "inline"`
 * branch is the one that accepts the key as a string `value` (the `source:
 * "env"` branch wants an env-var *name*, which we cannot populate). We always
 * send `{ source: "inline", value }`.
 */
export interface ZcodeApiKey {
  source: "inline";
  value: string;
}

/**
 * The full provider object the app-server's `workspace/upsertModelProvider`
 * requires. Mapped from the saved GUI entry — the server validates this with a
 * Zod schema and rejects a bare provider-id string with
 * "expected object, received string".
 */
export interface ZcodeProviderRecord {
  /** Provider id, e.g. `builtin:zai` (the GUI entry's `id`). */
  providerId: string;
  /** Wire format: `anthropic` | `openai` | `openai-compatible`. */
  kind: "anthropic" | "openai" | "openai-compatible";
  apiKey: ZcodeApiKey;
  /** Models as `{ modelId }` records — the server rejects bare strings. */
  models: { modelId: string }[];
  /**
   * Base URL the `openai-compatible` kind routes model requests to. Required
   * when `kind === "openai-compatible"` (the server rejects the provider with
   * "missing baseURL" otherwise). Omitted for the literal `anthropic`/`openai`
   * kinds, which hard-code `api.anthropic.com` / `api.openai.com`.
   */
  baseURL?: string;
}

/** The canonical provider selection the adapter hands to the protocol layer. */
export interface ZcodeConfig {
  /** Provider id, e.g. `builtin:zai` (from the provider entry's `id`). */
  provider: string;
  /**
   * The provider's default/current model. ZCode stores no explicit "selected
   * model" on the provider entry, so this is the first entry in `models`
   * (the GUI's display order), which is what `setDefaultModel` receives when
   * no per-session model has been picked.
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

/** Shape of a single entry in `model-providers.json` (fields we read). */
interface RawProvider {
  id?: unknown;
  name?: unknown;
  apiKey?: unknown;
  models?: unknown;
  endpoints?: unknown;
}

/**
 * Default location of the provider store, resolved per-platform at call time
 * via `os.homedir()` — works on Windows (`C:\Users\<u>\.zcode`) and
 * Linux/macOS (`~/.zcode`).
 */
export function defaultZcodeConfigPath(): string {
  return join(homedir(), ".zcode", "v2", "model-providers.json");
}

/**
 * Parse an already-decoded provider store into the canonical selection.
 *
 * Returns the first provider whose `apiKey` is a non-empty string and that
 * has at least one model. Returns `null` for non-array input, an empty
 * array, no qualifying provider, or any malformed entry encountered
 * (malformed entries are skipped, never thrown on).
 */
export function parseZcodeConfig(data: unknown): ZcodeConfig | null {
  if (!Array.isArray(data)) return null;

  for (const entry of data) {
    const config = parseProvider(entry);
    if (config) return config;
  }
  return null;
}

/**
 * Pick the wire `kind` + baseURL for `workspace/upsertModelProvider`.
 *
 * The app-server's three kinds route model requests differently:
 *   - `anthropic`         → hard-codes `api.anthropic.com`
 *   - `openai`            → hard-codes `api.openai.com`
 *   - `openai-compatible` → uses the provider's `baseURL` (REQUIRED)
 *
 * The official kinds ignore the provider's saved endpoint URL. So a non-first-
 * party provider whose `endpoints.anthropic`/`endpoints.openai` points at a
 * vendor gateway (e.g. Z.AI's `api.z.ai/api/anthropic`) MUST use
 * `openai-compatible` with that gateway as `baseURL`, otherwise the server
 * dials the literal official host and the vendor key is rejected as invalid.
 *
 * Rule: only pick `anthropic`/`openai` when the saved endpoint actually IS the
 * official host; otherwise fall through to `openai-compatible` carrying the
 * vendor's openai-style endpoint as `baseURL`.
 */
function resolveProviderKind(
  raw: RawProvider,
): { kind: "anthropic" | "openai" | "openai-compatible"; baseURL?: string } {
  const endpoints = isRecord(raw.endpoints) ? raw.endpoints : null;
  const anthropicUrl =
    typeof endpoints?.anthropic === "string" ? endpoints.anthropic : "";
  const openaiUrl =
    typeof endpoints?.openai === "string" ? endpoints.openai : "";

  // Official-host short-circuits (the literal kinds route there anyway).
  if (/^https?:\/\/api\.anthropic\.com/i.test(anthropicUrl)) {
    return { kind: "anthropic" };
  }
  if (/^https?:\/\/api\.openai\.com/i.test(openaiUrl)) {
    return { kind: "openai" };
  }

  // Anything else (vendor gateways, self-hosted) needs openai-compatible with
  // a baseURL. Prefer the openai-style endpoint (matches the OpenAI-shaped
  // request the server builds); fall back to the anthropic-style URL.
  const baseURL = openaiUrl || anthropicUrl;
  return { kind: "openai-compatible", ...(baseURL ? { baseURL } : {}) };
}

/** Validate one raw provider entry; return null if it is unusable. */
function parseProvider(entry: unknown): ZcodeConfig | null {
  if (entry === null || typeof entry !== "object") return null;
  const raw = entry as RawProvider;

  const id = raw.id;
  const apiKey = raw.apiKey;
  const models = raw.models;

  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  if (!Array.isArray(models)) return null;

  const modelList = models.filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
  if (modelList.length === 0) return null;

  const firstModel = modelList[0]!;
  const { kind, baseURL } = resolveProviderKind(raw);
  return {
    provider: id,
    model: firstModel,
    models: modelList,
    providerRecord: {
      providerId: id,
      kind,
      apiKey: { source: "inline", value: apiKey },
      models: modelList.map((modelId) => ({ modelId })),
      ...(baseURL ? { baseURL } : {}),
    },
  };
}

/**
 * Read the provider store from disk and return the canonical selection.
 *
 * @param filePath Override the config location (defaults to
 *   {@link defaultZcodeConfigPath}). Useful for tests.
 * @returns The selection, or `null` if the file is missing, unreadable, holds
 *   malformed JSON, or contains no provider with a non-empty API key. Never
 *   throws.
 */
export function readZcodeConfig(filePath: string = defaultZcodeConfigPath()): ZcodeConfig | null {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  return parseZcodeConfig(data);
}
