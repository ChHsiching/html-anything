// Persisted model-choice resolution: a stale pick falls back to
// "default" everywhere it is read (send paths + pickers), while a
// not-yet-loaded agent list passes picks through untouched.
import { describe, expect, it } from "vitest";
import { isStaleModelChoice, resolveAgentModel } from "../agent-models";

const MODELS = [
  { id: "default", label: "Default (ZCode GUI plan)" },
  { id: "GLM-5.2/max", label: "GLM-5.2 (max)" },
  { id: "GLM-5.3/high", label: "GLM-5.3 (high)" },
];

describe("resolveAgentModel", () => {
  it("a pick still offered by the list is used verbatim", () => {
    expect(resolveAgentModel(MODELS, "GLM-5.3/high")).toBe("GLM-5.3/high");
  });

  it("a stale pick (list loaded, id gone) falls back to default", () => {
    expect(resolveAgentModel(MODELS, "GLM-5.2/high")).toBe("default");
    // e.g. a bare id persisted by an older UI
    expect(resolveAgentModel(MODELS, "GLM-5.2")).toBe("default");
  });

  it("undefined / empty / 'default' picks resolve to default", () => {
    expect(resolveAgentModel(MODELS, undefined)).toBe("default");
    expect(resolveAgentModel(MODELS, "")).toBe("default");
    expect(resolveAgentModel(MODELS, "default")).toBe("default");
  });

  it("an unloaded list (undefined/empty models) passes the pick through — never silently drops it", () => {
    expect(resolveAgentModel(undefined, "sonnet")).toBe("sonnet");
    expect(resolveAgentModel([], "sonnet")).toBe("sonnet");
  });
});

describe("isStaleModelChoice", () => {
  it("true only for a non-default pick missing from a loaded list", () => {
    expect(isStaleModelChoice(MODELS, "GLM-5.2/high")).toBe(true);
    expect(isStaleModelChoice(MODELS, "GLM-5.2/max")).toBe(false);
    expect(isStaleModelChoice(MODELS, "default")).toBe(false);
    expect(isStaleModelChoice(MODELS, undefined)).toBe(false);
  });

  it("an unloaded list is never stale (the pick cannot be judged yet)", () => {
    expect(isStaleModelChoice(undefined, "sonnet")).toBe(false);
    expect(isStaleModelChoice([], "sonnet")).toBe(false);
  });
});
