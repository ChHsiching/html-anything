/**
 * Internal helpers shared across the protocol, stream, and session modules.
 *
 * Kept in one place because {@link createZcodeProtocolClient},
 * {@link createZcodeStreamHandler}, and {@link startZcodeProtocolTurn} all
 * reason about the same loose-JSON shapes the app-server speaks; duplicating
 * these one-liners across the three modules was the textbook "Duplicated Code"
 * smell (ADR-0002 created this shared package precisely to avoid such drift).
 *
 * Not exported from the package surface — internal only.
 */

/** A loose JSON object: every app-server param/result/payload/error shape. */
export type JsonRecord = Record<string, unknown>;

/** Narrow `unknown` to a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
