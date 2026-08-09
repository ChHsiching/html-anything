import { describe, it, expect, vi } from "vitest";
import type { ZcodeProtocolClientLike } from "./zcode-session.js";
import { startZcodeProtocolTurn } from "./zcode-session.js";

/**
 * A fake protocol client. It records every `request`/`respond` call in order
 * so a test can assert the method sequence and its parameters, and it returns
 * scripted responses (by method) to drive the turn forward. The
 * `onNotification` subscription is captured so a test can later invoke the
 * registered listener with forged frames.
 */
interface FakeClient extends ZcodeProtocolClientLike {
  /** All requests sent, in order: { id, method, params }. */
  requests: { id: string; method: string; params: Record<string, unknown> }[];
  /** All respond() calls, in order: { id, result }. */
  responds: { id: string; result: Record<string, unknown> }[];
  /** The single onNotification listener registered by the turn driver. */
  notificationListener: ((frame: Record<string, unknown>) => void) | null;
}

function makeFakeClient(
  responsesByMethod: Record<string, Record<string, unknown>>,
): FakeClient {
  const requests: FakeClient["requests"] = [];
  const responds: FakeClient["responds"] = [];
  // Held in a mutable box so the `notificationListener` getter (below) stays
  // live even after the turn driver's unsubscribe nulls it.
  const box = { listener: null as FakeClient["notificationListener"] };

  const base = {
    requests,
    responds,
    onNotification(listener: NonNullable<FakeClient["notificationListener"]>) {
      box.listener = listener;
      return () => {
        if (box.listener === listener) box.listener = null;
      };
    },
    async request(req: { id: string; method: string; params: Record<string, unknown> }) {
      requests.push(req);
      const scripted = responsesByMethod[req.method];
      if (!scripted) {
        throw new Error(`fake client: no scripted response for ${req.method}`);
      }
      return { id: req.id, result: structuredClone(scripted) };
    },
    respond(id: string, result: Record<string, unknown>) {
      responds.push({ id, result: structuredClone(result) });
    },
  };
  // `notificationListener` is read live so a test can invoke the currently
  // registered listener (and observe when unsubscribe clears it).
  return Object.defineProperties(base, {
    notificationListener: {
      get: () => box.listener,
      enumerable: true,
    },
  }) as FakeClient;
}

describe("startZcodeProtocolTurn — method sequence", () => {
  // ADR-0004 / #13: the app-server child self-authenticates from the user's
  // logged-in state, so the turn driver must NOT relay any provider/key. The
  // sequence is create/resume → (setMode) → subscribe → send — no
  // workspace/upsertModelProvider, no workspace/setDefaultModel.
  it("sends session/create → setMode → subscribe → send in order (no provider relay)", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s-42" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    const result = await startZcodeProtocolTurn({
      client,
      cwd: "/proj/foo",
      mode: "agent",
      prompt: "hello world",
      onEvent: () => {},
    });

    // Sequential ids prove the methods were awaited in order.
    expect(client.requests.map((r) => r.id)).toEqual([
      "zcode-1",
      "zcode-2",
      "zcode-3",
      "zcode-4",
    ]);
    expect(client.requests.map((r) => r.method)).toEqual([
      "session/create",
      "session/setMode",
      "session/subscribe",
      "session/send",
    ]);
    // Pin the structural absence of the deleted relay methods.
    expect(client.requests.map((r) => r.method)).not.toContain(
      "workspace/upsertModelProvider",
    );
    expect(client.requests.map((r) => r.method)).not.toContain(
      "workspace/setDefaultModel",
    );
    expect(result.sessionId).toBe("s-42");
    expect(typeof result.unsubscribe).toBe("function");
  });

  it("passes the cwd-derived workspace to session/create", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    await startZcodeProtocolTurn({
      client,
      cwd: "/proj/foo",
      mode: "agent",
      prompt: "p",
      onEvent: () => {},
    });

    const create = client.requests[0]!;
    expect(create.method).toBe("session/create");
    expect(create.params).toEqual({
      workspace: { workspacePath: "/proj/foo", workspaceKey: "od-foo" },
    });
  });

  it("session/send carries the prompt and sessionId", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s-7" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "agent",
      prompt: "do the thing",
      onEvent: () => {},
    });

    const send = client.requests[client.requests.length - 1]!;
    expect(send.params).toEqual({ sessionId: "s-7", content: "do the thing" });
  });
});

describe("startZcodeProtocolTurn — session/resume", () => {
  it("calls session/resume (not create) when resumeSessionId is given", async () => {
    const client = makeFakeClient({
      "session/resume": { session: { sessionId: "old-1" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    const result = await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "agent",
      prompt: "more",
      resumeSessionId: "old-1",
      onEvent: () => {},
    });

    expect(client.requests.map((r) => r.method)).toContain("session/resume");
    expect(client.requests.map((r) => r.method)).not.toContain("session/create");
    expect(result.sessionId).toBe("old-1");
  });

  it("treats a whitespace-only resumeSessionId as absent (creates instead)", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "fresh" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "agent",
      prompt: "x",
      resumeSessionId: "   ",
      onEvent: () => {},
    });

    expect(client.requests.map((r) => r.method)).toContain("session/create");
  });

  it("throws ZcodeResumeSessionMissingError when resume target is gone", async () => {
    const client = makeFakeClient({});
    client.request = async (req) => {
      client.requests.push(req);
      if (req.method === "session/resume") {
        throw new Error("session not found");
      }
      return { id: req.id, result: { ok: true } };
    };

    await expect(
      startZcodeProtocolTurn({
        client,
        cwd: "/p",
        mode: "agent",
        prompt: "x",
        resumeSessionId: "stale-9",
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({
      name: "ZcodeResumeSessionMissingError",
      sessionId: "stale-9",
    });
  });
});

describe("startZcodeProtocolTurn — setMode optional", () => {
  it("skips session/setMode when no mode is supplied", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s" } },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      prompt: "x",
      onEvent: () => {},
    });

    expect(client.requests.map((r) => r.method)).not.toContain("session/setMode");
  });

  it("skips session/setMode when mode is whitespace-only", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s" } },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });

    await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "   ",
      prompt: "x",
      onEvent: () => {},
    });

    expect(client.requests.map((r) => r.method)).not.toContain("session/setMode");
  });
});

describe("startZcodeProtocolTurn — provider headers & streaming", () => {
  it("auto-responds to requestProviderRuntimeHeaders with { headersApplied: true }", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });
    const result = await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "agent",
      prompt: "x",
      onEvent: () => {},
    });

    // Server initiates the headers handshake mid-turn.
    client.notificationListener!({
      id: "srv-headers",
      method: "interaction/requestProviderRuntimeHeaders",
      params: {},
    });

    expect(client.responds).toEqual([{ id: "srv-headers", result: { headersApplied: true } }]);
    result.unsubscribe();
  });

  it("forwards text_delta notifications to onEvent", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });
    const onEvent = vi.fn();
    const result = await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "agent",
      prompt: "x",
      onEvent,
    });

    client.notificationListener!({
      method: "session/event",
      params: { payload: { kind: "text_delta", delta: "streamed text" } },
    });

    expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "streamed text" });
    result.unsubscribe();
  });

  it("unsubscribe detaches the notification listener (no further delivery)", async () => {
    const client = makeFakeClient({
      "session/create": { session: { sessionId: "s" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    });
    const onEvent = vi.fn();
    const result = await startZcodeProtocolTurn({
      client,
      cwd: "/p",
      mode: "agent",
      prompt: "x",
      onEvent,
    });

    // Before unsubscribe, the listener is registered and delivers events.
    expect(client.notificationListener).not.toBeNull();
    result.unsubscribe();
    // After unsubscribe, the listener has been detached — a subsequent
    // notification has no listener to reach, so onEvent cannot fire.
    expect(client.notificationListener).toBeNull();
  });
});

describe("startZcodeProtocolTurn — failure cleanup", () => {
  it("unsubscribes and rethrows when a mid-sequence request fails", async () => {
    const unsubscribed = vi.fn();
    const client = makeFakeClient({});
    client.request = async (req) => {
      client.requests.push(req);
      if (req.method === "session/create") {
        throw new Error("workspace locked");
      }
      return { id: req.id, result: { ok: true } };
    };
    client.onNotification = (listener) => {
      return () => {
        unsubscribed();
        if (client.notificationListener === listener) client.notificationListener = null;
      };
    };

    await expect(
      startZcodeProtocolTurn({
        client,
        cwd: "/p",
        prompt: "x",
        onEvent: () => {},
      }),
    ).rejects.toThrow(/workspace locked/);

    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });
});
