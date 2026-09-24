// #41 — the zcode failure-surface gate, extracted from use-convert.ts so the
// consumer-layer contract (error event / non-zero exit → red error state,
// zcode-only) is unit-testable without driving the full fetch/SSE loop.
import { describe, expect, it } from "vitest";
import { zcodeTurnFailed } from "../use-convert";

describe("zcodeTurnFailed (#41 zcode gate)", () => {
  it("zcode: an error event fails the turn (refused binding / spawn failure)", () => {
    expect(zcodeTurnFailed("zcode", "error", { message: "ZCode: no model plan found…" })).toBe(true);
  });

  it("zcode: a non-zero exit fails the turn (e.g. gateway 400 → exit 1)", () => {
    expect(zcodeTurnFailed("zcode", "done", { code: 1 })).toBe(true);
  });

  it("zcode: exit 0 / delta / meta / stderr events do NOT fail the turn", () => {
    expect(zcodeTurnFailed("zcode", "done", { code: 0 })).toBe(false);
    expect(zcodeTurnFailed("zcode", "done", {})).toBe(false); // code unknown
    expect(zcodeTurnFailed("zcode", "delta", { text: "<html>" })).toBe(false);
    expect(zcodeTurnFailed("zcode", "meta", { key: "model" })).toBe(false);
    expect(zcodeTurnFailed("zcode", "stderr", { text: "warning" })).toBe(false);
  });

  it("other agents keep the historical behavior — no event fails their turns", () => {
    expect(zcodeTurnFailed("claude", "error", { message: "boom" })).toBe(false);
    expect(zcodeTurnFailed("claude", "done", { code: 1 })).toBe(false);
    expect(zcodeTurnFailed("codex", "done", { code: 2 })).toBe(false);
  });
});
