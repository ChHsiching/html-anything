/**
 * Bidirectional JSON-RPC 2.0 client over a spawned `zcode app-server` child's
 * stdio.
 *
 * The client wraps an *already-spawned* {@link ChildProcess}: it does not
 * spawn, and {@link ZcodeProtocolClient.dispose} does **not** kill the child.
 * Spawning and killing the `app-server` process is the calling layer's job
 * (in this repo, that is `invokeAgent`). See ADR-0001 ("Protocol client vs
 * child process").
 *
 * Wire format: one JSON object per line on both stdin (requests we send) and
 * stdout (responses, async notifications, and server→client requests we
 * receive). NOTE: the real `zcode app-server` uses a JSON-RPC-shaped line
 * protocol but **rejects the `jsonrpc: "2.0"` envelope** — frames are bare
 * `{id, method, params}` / `{id, result}` / `{id, error}`. Adding the
 * `jsonrpc` field makes the server return `{"error":{"code":-32600,...}}`
 * ("Unrecognized key: jsonrpc"), so every outbound frame omits it.
 *
 * Three frame kinds flow back from the server:
 *   - a **response** to one of our requests — matched by string `id`, routed
 *     back to the awaiting `request()` promise;
 *   - an **async notification** (e.g. `session/event`, `state.updated`) — has a
 *     `method` but no pending `id`, surfaced to `onNotification` listeners;
 *   - a **server→client request** (e.g.
 *     `interaction/requestProviderRuntimeHeaders`) — has a `method` and a
 *     non-pending `id`; also surfaced to `onNotification`, and answered via
 *     `respond()`.
 */

import type { ChildProcess } from "node:child_process";
import { isRecord, type JsonRecord } from "./internal";

/** A request we send to the app-server. The caller chooses the `id`. */
export interface ZcodeProtocolRequest {
  id: string;
  method: string;
  params: JsonRecord;
}

/**
 * Any frame received from the server. Could be a response, a notification, or a
 * server→client request; the consumer interprets the presence of `id` /
 * `method` / `result` / `error`.
 */
export type ZcodeProtocolResponse = JsonRecord;

/**
 * Receives every stdout frame that is NOT a response to one of our own
 * requests: async notifications (`session/event`, `state.updated`) and
 * server→client requests (a `method` plus a non-pending `id`, e.g.
 * `interaction/requestProviderRuntimeHeaders`). The consumer decides how to map
 * or answer each frame; the transport stays agnostic.
 */
export type ZcodeNotificationListener = (frame: ZcodeProtocolResponse) => void;

/** One outstanding `request()` awaiting its matching response. */
interface PendingRequest {
  resolve: (response: ZcodeProtocolResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Removes the AbortSignal listener (if any) once the request settles. */
  cleanup: () => void;
}

/** The transport-level handle returned by {@link createZcodeProtocolClient}. */
export interface ZcodeProtocolClient {
  /**
   * Send a request and await its response. Rejects on timeout, abort, a
   * JSON-RPC error frame, child close, or `dispose()`.
   *
   * @param timeoutMs Per-request timeout (default 10s). A request that never
   *   gets a response rejects after this elapses.
   * @param signal Optional AbortSignal; an already-aborted signal rejects
   *   before anything is sent, and a later abort rejects the in-flight promise.
   */
  request(
    request: ZcodeProtocolRequest,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ZcodeProtocolResponse>;
  /**
   * Subscribe to async notification and server→client request frames. Returns
   * an unsubscribe function. All listeners are dropped on `dispose()`.
   */
  onNotification(listener: ZcodeNotificationListener): () => void;
  /**
   * Answer a server→client request (surfaced via `onNotification`) by writing
   * an `{ id, result }` frame back. For these requests the "failure" case is
   * encoded inside `result` (e.g. `{ headersApplied: false, errorMessage }`),
   * not as a JSON-RPC error frame — hence `respond` takes `result`, not an
   * error.
   */
  respond(id: string, result: JsonRecord): void;
  /**
   * Detach all listeners from the child and reject every pending request.
   * Does **not** kill the child — the caller owns the process lifecycle.
   */
  dispose(): void;
}

function errorMessageFromPayload(error: JsonRecord): string {
  return typeof error.message === "string" ? error.message : JSON.stringify(error);
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("zcode app-server request aborted");
}

/**
 * Build a JSON-RPC client over an already-spawned `app-server` child. Attaches
 * listeners to the child's stdout/stderr/stdin/error/close; the caller must
 * keep the child alive for the client's lifetime and dispose/kill it
 * afterwards.
 */
export function createZcodeProtocolClient(child: ChildProcess): ZcodeProtocolClient {
  const pending = new Map<string, PendingRequest>();
  const notificationListeners = new Set<ZcodeNotificationListener>();
  let disposed = false;
  let stdoutBuffer = "";
  let stderrTail = "";

  const dispatchNotification = (frame: ZcodeProtocolResponse) => {
    for (const listener of notificationListeners) {
      try {
        listener(frame);
      } catch {
        // A listener throwing must not break stdout parsing for the others.
      }
    }
  };

  const writeFrame = (frame: JsonRecord): void => {
    const stdin = child.stdin;
    if (!stdin) {
      throw new Error("zcode app-server stdin is not available");
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  const rejectPending = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.cleanup();
      pending.delete(id);
      entry.reject(error);
    }
  };

  const onStdout = (chunk: string | Buffer) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;

      // A response to one of our own requests carries a string `id` that
      // matches a pending entry. Route it back to the awaiting request.
      const id = parsed.id;
      if (typeof id === "string") {
        const match = pending.get(id);
        if (match) {
          clearTimeout(match.timer);
          match.cleanup();
          pending.delete(id);
          if (isRecord(parsed.error)) {
            match.reject(
              new Error(
                `zcode app-server returned error: ${errorMessageFromPayload(parsed.error)}`,
              ),
            );
          } else {
            match.resolve(parsed);
          }
          continue;
        }
      }

      // Everything else with a `method` is an async notification or a
      // server→client request. Surface it to notification listeners; stray
      // frames without a method are dropped.
      if (typeof parsed.method === "string") {
        dispatchNotification(parsed);
      }
    }
  };

  const onStderr = (chunk: string | Buffer) => {
    stderrTail = (stderrTail + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(
      -400,
    );
  };

  const onError = (error: Error) => {
    rejectPending(error);
  };

  const onStdinError = (error: Error) => {
    rejectPending(new Error(`zcode app-server stdin failed: ${error.message}`));
  };

  const onClose = () => {
    rejectPending(
      new Error(`zcode app-server exited before responding. stderr: ${stderrTail}`),
    );
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.stdin?.on("error", onStdinError);
  child.on("error", onError);
  child.on("close", onClose);

  return {
    request(
      request: ZcodeProtocolRequest,
      timeoutMs = 10_000,
      signal?: AbortSignal,
    ): Promise<ZcodeProtocolResponse> {
      if (disposed) {
        return Promise.reject(new Error("zcode protocol client already disposed"));
      }
      const stdin = child.stdin;
      if (!stdin) {
        return Promise.reject(new Error("zcode app-server stdin is not available"));
      }
      // An already-aborted signal short-circuits before anything is sent.
      if (signal?.aborted) {
        return Promise.reject(abortReason(signal));
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request.id);
          reject(
            new Error(`Timed out waiting for zcode app-server response. stderr: ${stderrTail}`),
          );
        }, timeoutMs);

        // Removes the abort listener; runs on response/timeout/close so an
        // abort after the request has settled is a no-op and does not leak.
        const cleanup = () => {
          if (onAbort) signal?.removeEventListener("abort", onAbort);
        };

        let onAbort: (() => void) | undefined;
        if (signal) {
          onAbort = () => {
            clearTimeout(timer);
            cleanup();
            pending.delete(request.id);
            reject(abortReason(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }

        pending.set(request.id, { resolve, reject, timer, cleanup });

        try {
          stdin.write(`${JSON.stringify(request)}\n`);
        } catch (error) {
          clearTimeout(timer);
          cleanup();
          pending.delete(request.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    onNotification(listener: ZcodeNotificationListener): () => void {
      notificationListeners.add(listener);
      return () => {
        notificationListeners.delete(listener);
      };
    },

    respond(id: string, result: JsonRecord): void {
      if (disposed) {
        throw new Error("zcode protocol client already disposed");
      }
      writeFrame({ id, result });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdin?.off("error", onStdinError);
      child.off("error", onError);
      child.off("close", onClose);
      notificationListeners.clear();
      rejectPending(new Error("zcode protocol client disposed"));
    },
  };
}
