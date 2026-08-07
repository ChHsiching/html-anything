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
}

/** Shape of a single entry in `model-providers.json` (fields we read). */
interface RawProvider {
  id?: unknown;
  name?: unknown;
  apiKey?: unknown;
  models?: unknown;
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

  return { provider: id, model: modelList[0]!, models: modelList };
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
