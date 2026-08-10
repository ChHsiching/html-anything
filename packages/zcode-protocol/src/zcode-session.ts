/**
 * Drives one full `app-server` turn over the JSON-RPC client: open (or resume)
 * a session, subscribe, and send the prompt. Also exposes
 * {@link ensureWorkspaceModel} — the once-per-boot model relay.
 *
 * ADR-0004 + #14 (live-probe-corrected): the app-server child
 * **self-authenticates the LOGIN** — a bare `session/list` returns the
 * logged-in user's real sessions with zero credential handling (proven by 12
 * live probes). BUT a fresh `session/create` needs the workspace model
 * configured first, or it fails with `ModelProtocolError: Model config is
 * missing`. The model SELECTION must be provisioned; the login does not have
 * to be. The relay that #13 deleted (on the unverified assumption the child
 * self-resolves the model too) is therefore restored here as
 * {@link ensureWorkspaceModel} — a **once-per-boot** step the caller runs
 * before the first create. It reads ZCode's own `~/.zcode/v2/config.json`
 * (the GUI's resolved config) and feeds the selection back to the zcode child
 * (left-pocket → right-pocket — model selection, not credential grafting).
 *
 * #13's "child self-resolves its model" was an unverified extrapolation:
 * ADR-0004's own open-follow-up flagged the create→send loop was never
 * closed. The #14 live probes closed that loop and proved the relay is
 * required for fresh create. `session/resume` of an existing session needs no
 * relay (the session carries its model).
 *
 * The turn sequence is:
 *   1. `session/create` (or `session/resume` when `resumeSessionId` is given)
 *      — open the session; the response carries the `sessionId`. During
 *      create AND send the server issues a `session/requestRuntimePreferences`
 *      server→client request and blocks on its reply; we answer it with
 *      `{ nativeSearchEnhancementsEnabled: false }` (live-confirmed by #14 probes
 *      3, 8, 12 — this is NOT vestigial).
 *   2. `session/setMode` — only when a non-empty `mode` is supplied.
 *   3. `session/subscribe` — register for the session's event stream
 *      (`deliveryKind` is the server-validated enum
 *      `"desktop-continuous" | "web-remote-replayable"`).
 *   4. `session/send` — deliver the prompt as `{ sessionId, content }`.
 *
 * While the turn runs, this driver subscribes to the client's notification
 * channel: it auto-answers `session/requestRuntimePreferences` (proven
 * issued), forwards every frame to the stream handler, which maps
 * deltas/status into `onEvent`. NOTE: the previous
 * `interaction/requestProviderRuntimeHeaders` auto-reply is REMOVED — #14
 * probes 3 + 12 never observed the server issue it across two full turns; it
 * was vestigial. The returned `unsubscribe` detaches that listener so a caller
 * can stop receiving events (e.g. on abort) without disposing the client.
 */

import { isRecord, type JsonRecord } from "./internal.js";
import type {
  ZcodeNotificationListener,
  ZcodeProtocolRequest,
  ZcodeProtocolResponse,
} from "./zcode-protocol.js";
import { readZcodeConfig } from "./zcode-config.js";
import { createZcodeStreamHandler } from "./zcode-stream.js";

/** A mapped stream event, opaque to this layer. */
type ZcodeEvent = JsonRecord;

/** The subset of {@link ZcodeProtocolClient} the turn driver depends on. */
export interface ZcodeProtocolClientLike {
  onNotification(listener: ZcodeNotificationListener): () => void;
  request(
    request: ZcodeProtocolRequest,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ZcodeProtocolResponse>;
  respond(id: string, result: JsonRecord): void;
}

/**
 * A create-time model selection handed to `session/create`. Live-proven
 * (#19 / ADR-0005 decision 4, probe-create-model.cjs): `session/create`
 * accepts this nested object and binds it to the session for every turn of
 * that session (contextWindow changed 1M→200K when switching
 * GLM-5.2→GLM-5-Turbo). `session/send` REJECTS model fields (strict Zod), so
 * model choice is a create-time concern — this object only ever travels on the
 * `session/create` frame, never `session/send`.
 */
export interface ZcodeTurnModel {
  /** Provider id, e.g. `builtin:bigmodel-coding-plan` (the config.json key). */
  providerId: string;
  /** Model id under that provider's `models`, e.g. `GLM-5-Turbo`. */
  modelId: string;
}

/** Options for {@link startZcodeProtocolTurn}. */
export interface StartZcodeProtocolTurnOptions {
  client: ZcodeProtocolClientLike;
  /** Working directory the session runs in; seeds `workspace.workspacePath`. */
  cwd: string;
  /**
   * `session/subscribe` delivery kind. Defaults to `"desktop-continuous"`
   * (continuous streaming as the GUI uses).
   */
  deliveryKind?: string;
  /** Optional session mode sent via `session/setMode`. Omit to skip that call. */
  mode?: string | null;
  /**
   * Per-turn model selection. When set, `session/create` carries
   * `model:{providerId, modelId}` (live-proven accepted + bound to the
   * session). When unset, `session/create` carries no `model` field and the
   * workspace default (provisioned by {@link ensureWorkspaceModel}) applies.
   * `model` never travels on `session/send` (rejected by the server's strict
   * Zod). See {@link ZcodeTurnModel}.
   */
  model?: ZcodeTurnModel;
  /** Sink for mapped stream events (text_delta, status, usage, …). */
  onEvent: (event: ZcodeEvent) => void;
  /** The user's prompt, sent via `session/send`. */
  prompt: string;
  /** Per-request timeout forwarded to the client. */
  requestTimeoutMs?: number;
  /**
   * If set, `session/resume` is used instead of `session/create`. Throws
   * {@link ZcodeResumeSessionMissingError} (recoverable by the caller) if the
   * session no longer exists.
   */
  resumeSessionId?: string | null;
  /** Optional AbortSignal forwarded to each `client.request`. */
  signal?: AbortSignal;
  /**
   * Stable workspace key. Defaults to the full `cwd` (live-confirmed: the real
   * GUI/server use the full path as `workspaceKey`, not a derived
   * `od-<basename>` token). Pass an explicit key only if you need to
   * decouple it from the working directory.
   */
  workspaceKey?: string;
}

/** The handle returned by {@link startZcodeProtocolTurn}. */
export interface StartedZcodeProtocolTurn {
  sessionId: string;
  /** Detaches the notification listener installed for this turn. */
  unsubscribe: () => void;
}

const DEFAULT_DELIVERY_KIND = "desktop-continuous";

/** Options for {@link ensureWorkspaceModel}. */
export interface EnsureWorkspaceModelOptions {
  client: ZcodeProtocolClientLike;
  /** Working directory the session runs in; seeds `workspace.workspacePath`. */
  cwd: string;
  /** Per-request timeout forwarded to the client. */
  requestTimeoutMs?: number;
  /** Optional AbortSignal forwarded to each `client.request`. */
  signal?: AbortSignal;
  /**
   * Stable workspace key. Defaults to the full `cwd` (live-confirmed: the GUI
   * uses the full path as the workspace key).
   */
  workspaceKey?: string;
}

/** The model the workspace was configured with, from {@link ensureWorkspaceModel}. */
export interface EnsuredWorkspaceModel {
  providerId: string;
  modelId: string;
}

/**
 * Configure the workspace's default model on a freshly booted app-server child.
 *
 * #14 (live-probe-corrected): a fresh `session/create` fails with
 * `ModelProtocolError: Model config is missing` unless the workspace has a
 * configured default model. This reads ZCode's own resolved config
 * (`~/.zcode/v2/config.json`, the file the GUI writes — NOT the template
 * `model-providers.json` whose coding-plan entries have `apiKey: ""`), picks
 * the first enabled provider with a non-empty API key, and runs
 * `workspace/upsertModelProvider` then `workspace/setDefaultModel` — exactly
 * once per booted child. After this, any number of `session/create` calls in
 * the same child lifetime succeed without re-relaying (probe-10 confirmed a
 * second create needs no relay).
 *
 * The relay is model SELECTION, not credential grafting: it reads ZCode's own
 * file and feeds the selection back to ZCode's own child. The login still
 * self-authenticates (`session/list` works with no relay).
 *
 * @throws {Error} when no usable provider is configured, with an actionable
 *   message pointing at the config file and the GUI — a fresh create would
 *   fail opaquely otherwise, so failing fast with the fix is preferable.
 */
export async function ensureWorkspaceModel({
  client,
  cwd,
  requestTimeoutMs,
  signal,
  workspaceKey,
}: EnsureWorkspaceModelOptions): Promise<EnsuredWorkspaceModel> {
  const config = readZcodeConfig();
  if (!config) {
    throw new Error(
      "No usable ZCode provider found in ~/.zcode/v2/config.json " +
        "(no enabled provider with a non-empty API key). Configure a model " +
        "provider in the ZCode GUI (it writes the resolved selection to that " +
        "file), then retry.",
    );
  }

  const workspace = workspaceFor(cwd, workspaceKey);
  const request = makeRequester(client, {
    idPrefix: "zcode-ensure",
    requestTimeoutMs,
    signal,
  });

  await request("workspace/upsertModelProvider", {
    workspace,
    provider: config.providerRecord,
  });
  await request("workspace/setDefaultModel", {
    workspace,
    model: { providerId: config.provider, modelId: config.model },
  });

  return { providerId: config.provider, modelId: config.model };
}

/**
 * Thrown when a `session/resume` target can no longer be found (expired /
 * rotated / never existed). Recoverable: the caller can fall back to a fresh
 * `session/create`. Carries the offending `sessionId` for that decision.
 */
export class ZcodeResumeSessionMissingError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`ZCode resume session is no longer available: ${sessionId}. ${message}`);
    this.name = "ZcodeResumeSessionMissingError";
    this.sessionId = sessionId;
    this.cause = cause;
  }
}

/** Prefer `.result`, but fall back to the whole frame (defensive). */
function resultRecord(response: ZcodeProtocolResponse): JsonRecord {
  return isRecord(response.result) ? response.result : response;
}

/** Extract `sessionId` from a create/resume response, wherever ZCode nests it. */
function sessionIdFromCreateResponse(response: ZcodeProtocolResponse): string {
  const result = resultRecord(response);
  const session = isRecord(result.session) ? result.session : undefined;
  const sessionId =
    typeof session?.sessionId === "string"
      ? session.sessionId
      : typeof result.sessionId === "string"
        ? result.sessionId
        : null;
  if (!sessionId) {
    throw new Error("zcode session/create did not return a sessionId");
  }
  return sessionId;
}

/** Heuristic: does this error mean the resume target is gone (vs a real fault)? */
function isZcodeResumeMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:session|conversation).*(?:not found|missing|expired|gone|unavailable|does not exist)|(?:not found|missing).*(?:session|conversation)/i.test(
    message,
  );
}

/**
 * Build the workspace record shared by every workspace/* + session/* call.
 * `workspaceKey` defaults to the full `cwd` — live-confirmed (#14 probe-1: real
 * sessions carry `workspaceKey === workspacePath === the full cwd`, not a
 * derived `od-<basename>` token).
 */
function workspaceFor(cwd: string, workspaceKey?: string): JsonRecord {
  const key = workspaceKey?.trim();
  return {
    workspacePath: cwd,
    workspaceKey: key && key.length > 0 ? key : cwd,
  };
}

/**
 * Build a per-turn/per-step `request(method, params)` helper that mints
 * sequential ids prefixed with `idPrefix`. Shared by {@link ensureWorkspaceModel}
 * (once-per-boot relay) and {@link startZcodeProtocolTurn} (the turn driver) so
 * the two don't drift on id shape.
 */
function makeRequester(
  client: ZcodeProtocolClientLike,
  opts: { idPrefix: string; requestTimeoutMs?: number; signal?: AbortSignal },
) {
  let seq = 0;
  return (method: string, params: JsonRecord) => {
    seq += 1;
    return client.request(
      { id: `${opts.idPrefix}-${seq}`, method, params },
      opts.requestTimeoutMs,
      opts.signal,
    );
  };
}

/**
 * Drive a single app-server turn. On success, returns the live `sessionId` and
 * an `unsubscribe` for the notification listener. On any failure, the listener
 * is detached before re-throwing.
 */
export async function startZcodeProtocolTurn({
  client,
  cwd,
  deliveryKind = DEFAULT_DELIVERY_KIND,
  mode,
  model,
  onEvent,
  prompt,
  requestTimeoutMs,
  resumeSessionId,
  signal,
  workspaceKey,
}: StartZcodeProtocolTurnOptions): Promise<StartedZcodeProtocolTurn> {
  const stream = createZcodeStreamHandler(onEvent);
  const unsubscribe = client.onNotification((frame) => {
    // Auto-answer the one server→client handshake request the app-server
    // issues during a turn (live-confirmed #14 probes 3, 8, 12):
    //   - session/requestRuntimePreferences — fires inside `session/create`
    //     AND `session/send`; the server blocks the response on this reply and
    //     validates the result with a Zod schema
    //     (`nativeSearchEnhancementsEnabled` is a required boolean — #14 probe-13
    //     is rejected with code -32603, so we send the boolean.
    //
    // NOTE: `interaction/requestProviderRuntimeHeaders` was previously
    // auto-answered here too, but #14 probes 3 + 12 never observed the server
    // issue it across two full turns — it was vestigial and is removed.
    if (
      frame.method === "session/requestRuntimePreferences" &&
      typeof frame.id === "string"
    ) {
      client.respond(frame.id, { nativeSearchEnhancementsEnabled: false });
    }
    stream.handleFrame(frame);
  });

  const request = makeRequester(client, {
    idPrefix: "zcode",
    requestTimeoutMs,
    signal,
  });

  try {
    const workspace = workspaceFor(cwd, workspaceKey);

    const trimmedResumeSessionId = resumeSessionId?.trim() || null;
    let sessionId: string;
    if (trimmedResumeSessionId) {
      // #14: resume schema is { sessionId } only — the server ignores any
      // workspace field (live-confirmed probe-6). An existing session already
      // carries its model, so this path needs NO ensureWorkspaceModel relay.
      try {
        sessionId = sessionIdFromCreateResponse(
          await request("session/resume", {
            sessionId: trimmedResumeSessionId,
          }),
        );
      } catch (error) {
        if (isZcodeResumeMissingError(error)) {
          throw new ZcodeResumeSessionMissingError(trimmedResumeSessionId, error);
        }
        throw error;
      }
    } else {
      // #19 / ADR-0005 decision 4: when the caller supplies a per-turn model,
      // carry it on session/create. Live-proven (probe-create-model.cjs): the
      // server accepts model:{providerId, modelId} and binds it to the session
      // (contextWindow changed 1M→200K on GLM-5.2→GLM-5-Turbo). When no model
      // is supplied, omit the field — the workspace default (provisioned by
      // ensureWorkspaceModel) applies, which is the unchanged pre-#19 path.
      sessionId = sessionIdFromCreateResponse(
        await request(
          "session/create",
          model ? { workspace, model } : { workspace },
        ),
      );
    }

    if (mode?.trim()) {
      // The server validates mode against the enum
      // "plan" | "build" | "edit" | "yolo" | "auto" (live-confirmed #14
      // probe-5). An unrecognized mode is rejected with -32602.
      await request("session/setMode", { sessionId, mode: mode.trim() });
    }
    await request("session/subscribe", { sessionId, deliveryKind });
    await request("session/send", { sessionId, content: prompt });

    return { sessionId, unsubscribe };
  } catch (error) {
    unsubscribe();
    throw error;
  }
}
