import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ZcodeProtocolClientLike } from "./zcode-session.js";
import { startZcodeProtocolTurn, ensureWorkspaceModel } from "./zcode-session.js";

// Mock the config reader so tests don't touch disk. The relay's job is to
// send the right frames; the config reader is tested separately.
vi.mock("./zcode-config.js", () => ({
  readZcodeConfig: () => ({
    provider: "builtin:bigmodel-coding-plan",
    model: "GLM-5.2",
    models: ["GLM-5.2", "GLM-5-Turbo"],
    providerRecord: {
      providerId: "builtin:bigmodel-coding-plan",
      kind: "anthropic",
      apiKey: { source: "inline", value: "test-key" },
      models: [{ modelId: "GLM-5.2" }, { modelId: "GLM-5-Turbo" }],
      baseURL: "https://open.bigmodel.cn/api/anthropic",
    },
  }),
}));

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
  return Object.defineProperties(base, {
    notificationListener: {
      get: () => box.listener,
      enumerable: true,
    },
  }) as FakeClient;
}

// ---------------------------------------------------------------------------
// ensureWorkspaceModel — the once-per-boot model relay (#14, restored).
// ---------------------------------------------------------------------------

describe("ensureWorkspaceModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends upsert → setDefault with the live-confirmed workspace + provider + model shapes", async () => {
    const client = makeFakeClient({
      "workspace/upsertModelProvider": { ok: true },
      "workspace/setDefaultModel": { ok: true },
    });

    const result = await ensureWorkspaceModel({
      client,
      cwd: "C:\\proj\\alpha",
    });

    expect(result).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.2",
    });
    expect(client.requests.map((r) => r.method)).toEqual([
      "workspace/upsertModelProvider",
      "workspace/setDefaultModel",
    ]);

    // upsert: { workspace: {workspaceKey, workspacePath}, provider: {...live shape} }
    const upsert = client.requests[0]!;
    expect(upsert.params).toEqual({
      workspace: {
        // workspaceKey is the FULL cwd (the GUI/server use the full path,
        // not od-<basename>) — live-confirmed by #14 probe-1 (real sessions
        // carry workspaceKey === the full path).
        workspaceKey: "C:\\proj\\alpha",
        workspacePath: "C:\\proj\\alpha",
      },
      provider: {
        providerId: "builtin:bigmodel-coding-plan",
        kind: "anthropic",
        apiKey: { source: "inline", value: "test-key" },
        models: [{ modelId: "GLM-5.2" }, { modelId: "GLM-5-Turbo" }],
        baseURL: "https://open.bigmodel.cn/api/anthropic",
      },
    });

    // setDefault: { workspace: {...}, model: { providerId, modelId } }
    const setDefault = client.requests[1]!;
    expect(setDefault.params).toEqual({
      workspace: {
        workspaceKey: "C:\\proj\\alpha",
        workspacePath: "C:\\proj\\alpha",
      },
      model: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.2" },
    });
  });

  it("honours an explicit workspaceKey override", async () => {
    const client = makeFakeClient({
      "workspace/upsertModelProvider": { ok: true },
      "workspace/setDefaultModel": { ok: true },
    });
    await ensureWorkspaceModel({
      client,
      cwd: "/proj/alpha",
      workspaceKey: "custom-key",
    });
    expect((client.requests[0]!.params.workspace as Record<string, unknown>).workspaceKey).toBe(
      "custom-key",
    );
  });

  it("throws a clear, actionable error when no usable provider is configured", async () => {
    // Re-mock readZcodeConfig to return null for this case.
    const zcodeConfig = await import("./zcode-config.js");
    vi.spyOn(zcodeConfig, "readZcodeConfig").mockReturnValue(null);
    const client = makeFakeClient({});
    await expect(
      ensureWorkspaceModel({ client, cwd: "/p" }),
    ).rejects.toThrow(/no usable ZCode provider.*config\.json.*GUI/i);
    // And it must NOT have sent any frames.
    expect(client.requests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// startZcodeProtocolTurn — schema-remapped against the live Zod schemas (#14).
// ---------------------------------------------------------------------------

describe("startZcodeProtocolTurn — method sequence", () => {
  // #14: the app-server child self-authenticates the LOGIN (session/list works
  // with no relay), but a fresh session/create needs the workspace model
  // configured first (the relay is the caller's once-per-boot responsibility —
  // see ensureWorkspaceModel). The turn driver itself is create/resume →
  // (setMode) → subscribe → send.
  it("sends session/create → setMode → subscribe → send in order", async () => {
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
    expect(result.sessionId).toBe("s-42");
    expect(typeof result.unsubscribe).toBe("function");
  });

  it("session/create carries the workspace with workspaceKey = full cwd (live-confirmed)", async () => {
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
    // workspaceKey is the FULL cwd (not od-<basename>) — live-confirmed.
    expect(create.params).toEqual({
      workspace: { workspacePath: "/proj/foo", workspaceKey: "/proj/foo" },
    });
  });

  it("session/send carries { sessionId, content } — the live-confirmed schema (Q3 resolved)", async () => {
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
    // session/send requires ONLY { sessionId, content } — #14 Q3 resolved.
    expect(send.params).toEqual({ sessionId: "s-7", content: "do the thing" });
  });
});

describe("startZcodeProtocolTurn — session/resume", () => {
  it("calls session/resume with { sessionId } only (workspace ignored by the server)", async () => {
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
    // #14: resume schema is { sessionId } only — the server ignores workspace.
    const resume = client.requests[0]!;
    expect(resume.params).toEqual({ sessionId: "old-1" });
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

describe("startZcodeProtocolTurn — runtime-preferences handshake & streaming", () => {
  it("auto-responds to session/requestRuntimePreferences with { nativeSearchEnhancementsEnabled: false } (proven issued during create/send)", async () => {
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

    // Server issues this mid-create (live-confirmed #14 probes 3, 8, 12).
    client.notificationListener!({
      id: "srv-prefs",
      method: "session/requestRuntimePreferences",
      params: { sessionId: "s", scope: "runtime-materialization" },
    });

    expect(client.responds).toEqual([
      { id: "srv-prefs", result: { nativeSearchEnhancementsEnabled: false } },
    ]);
    result.unsubscribe();
  });

  it("does NOT auto-respond to interaction/requestProviderRuntimeHeaders (vestigial — not issued)", async () => {
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

    // #14 probes 3 + 12: the server NEVER issued this across two full turns.
    // The dead handler is removed; emitting the frame must produce NO respond.
    client.notificationListener!({
      id: "srv-headers",
      method: "interaction/requestProviderRuntimeHeaders",
      params: {},
    });

    expect(client.responds).toEqual([]);
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

    expect(client.notificationListener).not.toBeNull();
    result.unsubscribe();
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
