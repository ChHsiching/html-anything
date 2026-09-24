/**
 * Persisted model-choice resolution.
 *
 * `agentModels` in the store persists the LAST picked model id per agent.
 * Pick lists are dynamic: ZCode's plan chips change with the GUI plan, and
 * curated lists change between releases, so a persisted id can outlive the
 * list it came from. Every read path (send paths + pickers) resolves the
 * persisted choice through here so a stale id falls back to Default
 * consistently and is never sent to the agent (where ZCode would refuse
 * the whole turn with a "stale choice" error rather than silently reroute).
 */
export type PickableModel = { id: string };

/**
 * The model id to actually use: the persisted pick when it is still offered,
 * else "default". An unknown/empty model list (agents not loaded yet) passes
 * the pick through unchanged; a not-yet-loaded list must not silently drop
 * a valid pick.
 */
export function resolveAgentModel(
  models: readonly PickableModel[] | undefined,
  picked: string | undefined,
): string {
  const id = picked?.trim();
  if (!id || id === "default") return "default";
  if (!models || models.length === 0) return id;
  return models.some((m) => m.id === id) ? id : "default";
}

/**
 * True when the persisted pick exists but is no longer offered by the loaded
 * list; the pickers render the "reverted to Default" notice from this.
 */
export function isStaleModelChoice(
  models: readonly PickableModel[] | undefined,
  picked: string | undefined,
): boolean {
  const id = picked?.trim();
  if (!id || id === "default") return false;
  if (!models || models.length === 0) return false;
  return !models.some((m) => m.id === id);
}
