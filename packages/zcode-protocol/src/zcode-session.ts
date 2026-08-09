/**
 * Drives one full `app-server` turn over the JSON-RPC client: open (or resume)
 * a session, subscribe, and send the prompt.
 *
 * ADR-0004 / #13: the app-server child **self-authenticates** from the user's
 * logged-in state — it resolves the BigModel Coding Plan entitlement on its
 * own at boot, with no client-side provider/key relay. A live probe
 * (2026-08-10) confirmed a bare `session/list` returns the logged-in user's
 * real sessions with zero credential handling. The previous
 * `workspace/upsertModelProvider` + `workspace/setDefaultModel` relay is
 * deleted: it was dead weight (the child was always authed) and worse, it was
 * the root of the "Coding Plan can't be served" failure (the old
 * `parseProvider` rejected `apiKey:""` entries, which is exactly what Coding
 * Plan entries legitimately have, so it picked the wrong provider entirely).
 *
 * The post-#13 sequence is:
 *   1. `session/create` (or `session/resume` when `resumeSessionId` is given)
 *      — open the session against the child's already-resolved auth; the
 *      response carries the `sessionId`. The server may issue a
 *      `session/requestRuntimePreferences` server→client request mid-create
 *      and block the create response on its reply; we answer it with
 *      `{ nativeSearchEnhancementsEnabled: false }`.
 *   2. `session/setMode` — only when a non-empty `mode` is supplied.
 *   3. `session/subscribe` — register this client for the session's event
 *      stream (delivery kind selects how events arrive).
 *   4. `session/send` — deliver the prompt. After this, model output arrives
 *      asynchronously as notifications.
 *
 * While the turn runs, this driver subscribes to the client's notification
 * channel: it auto-answers the two server→client handshake requests
 * (`interaction/requestProviderRuntimeHeaders` and
 * `session/requestRuntimePreferences`), and forwards every frame to the stream
 * handler, which maps deltas/status into `onEvent`. The returned `unsubscribe`
 * detaches that notification listener so a caller can stop receiving events
 * (e.g. on abort) without disposing the client.
 */

import path from "node:path";

import { isRecord, type JsonRecord } from "./internal.js";
import type {
  ZcodeNotificationListener,
  ZcodeProtocolRequest,
  ZcodeProtocolResponse,
} from "./zcode-protocol.js";
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
   * Stable workspace key. Defaults to `od-<basename(cwd)>` (derived, so two
   * dirs with the same basename collide — callers that need isolation pass an
   * explicit key).
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

/** Build the workspace record shared by every workspace/* + session/* call. */
function workspaceFor(cwd: string, workspaceKey?: string): JsonRecord {
  return {
    workspacePath: cwd,
    workspaceKey: workspaceKey?.trim() || `od-${path.basename(cwd) || "workspace"}`,
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
  onEvent,
  prompt,
  requestTimeoutMs,
  resumeSessionId,
  signal,
  workspaceKey,
}: StartZcodeProtocolTurnOptions): Promise<StartedZcodeProtocolTurn> {
  const stream = createZcodeStreamHandler(onEvent);
  const unsubscribe = client.onNotification((frame) => {
    // Auto-answer the two server→client handshake requests the app-server
    // issues during a turn, so model output can actually start:
    //   - interaction/requestProviderRuntimeHeaders — provider auth headers
    //     for the upcoming model request. Failure is encoded inside `result`,
    //     not a JSON-RPC error, so we reply `{ headersApplied: true }`.
    //   - session/requestRuntimePreferences — fires inside `session/create`;
    //     the server blocks the create response on this reply and validates
    //     the result with a Zod schema (`nativeSearchEnhancementsEnabled` is a
    //     required boolean). Replying `{}` is rejected with code -32603.
    if (
      frame.method === "interaction/requestProviderRuntimeHeaders" &&
      typeof frame.id === "string"
    ) {
      client.respond(frame.id, { headersApplied: true });
    } else if (
      frame.method === "session/requestRuntimePreferences" &&
      typeof frame.id === "string"
    ) {
      client.respond(frame.id, { nativeSearchEnhancementsEnabled: false });
    }
    stream.handleFrame(frame);
  });

  let requestSeq = 0;
  const request = (method: string, params: JsonRecord) => {
    requestSeq += 1;
    return client.request(
      { id: `zcode-${requestSeq}`, method, params },
      requestTimeoutMs,
      signal,
    );
  };

  try {
    const workspace = workspaceFor(cwd, workspaceKey);

    const trimmedResumeSessionId = resumeSessionId?.trim() || null;
    let sessionId: string;
    if (trimmedResumeSessionId) {
      try {
        sessionId = sessionIdFromCreateResponse(
          await request("session/resume", {
            sessionId: trimmedResumeSessionId,
            workspace,
          }),
        );
      } catch (error) {
        if (isZcodeResumeMissingError(error)) {
          throw new ZcodeResumeSessionMissingError(trimmedResumeSessionId, error);
        }
        throw error;
      }
    } else {
      sessionId = sessionIdFromCreateResponse(await request("session/create", { workspace }));
    }

    if (mode?.trim()) {
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
