import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createZcodeProtocolClient } from "./zcode-protocol.js";

/**
 * A fake `app-server` child built from PassThrough streams. The protocol client
 * only needs stdin (it writes), stdout (it parses), stderr (it tails), plus the
 * EventEmitter `error`/`close` channels — exactly the surface a real
 * ChildProcess exposes. stdin is captured so a test can assert the outbound
 * JSON-RPC frames; stdout.emit lets a test inject forged responses.
 */
interface FakeChild extends ChildProcess {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

function makeChild(): FakeChild {
  // An EventEmitter with three PassThrough streams pinned on as stdin/stdout/
  // stderr mirrors the ChildProcess surface the client touches. ChildProcess
  // fields we do not exercise (pid, stdio array, kill, ...) are left absent —
  // the protocol client never reaches for them, by design (dispose() detaches
  // listeners but does not kill the child).
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  // Capture every byte written to stdin so a test can assert the outbound
  // JSON-RPC frames without fighting PassThrough's flow modes. The real child
  // would receive these bytes on its stdin.
  const stdinWrites: string[] = [];
  const originalWrite = stdin.write.bind(stdin);
  stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    stdinWrites.push(text);
    return (originalWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stdin.write;
  Object.assign(emitter, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    __stdinWrites: stdinWrites,
  });
  return emitter as unknown as FakeChild;
}

/** The captured outbound frames the client wrote to child.stdin so far. */
function outboundFrames(child: FakeChild): unknown[] {
  const writes = (child as unknown as { __stdinWrites: string[] }).__stdinWrites;
  const frames: unknown[] = [];
  for (const text of writes) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      frames.push(JSON.parse(trimmed));
    }
  }
  return frames;
}

describe("createZcodeProtocolClient — request/response", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a newline-terminated JSON-RPC request frame to child.stdin", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const pending = client.request({ id: "r1", method: "workspace/ping", params: {} });
    // No response yet; the frame must already be on the wire. The real
    // app-server rejects a `jsonrpc` envelope, so outbound frames are bare
    // `{ id, method, params }`.
    const outbound = outboundFrames(child);
    expect(outbound).toEqual([{ id: "r1", method: "workspace/ping", params: {} }]);

    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: "r1", result: { ok: true } })}\n`));
    await expect(pending).resolves.toEqual({ id: "r1", result: { ok: true } });
  });

  it("resolves with the full response object (id + result)", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const pending = client.request({ id: "r2", method: "session/create", params: { workspace: {} } });
    child.stdout.emit(
      "data",
      `${JSON.stringify({ id: "r2", result: { session: { sessionId: "s-1" } } })}\n`,
    );

    await expect(pending).resolves.toEqual({
      id: "r2",
      result: { session: { sessionId: "s-1" } },
    });
  });

  it("rejects when the server returns a JSON-RPC error frame", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const pending = client.request({ id: "r3", method: "workspace/ping", params: {} });
    child.stdout.emit(
      "data",
      `${JSON.stringify({ id: "r3", error: { code: -32_600, message: "bad params" } })}\n`,
    );

    await expect(pending).rejects.toThrow(/bad params/);
  });
});

describe("createZcodeProtocolClient — onNotification", () => {
  it("surfaces async notification frames (method, no pending id) to listeners", () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const listener = vi.fn();
    const unsubscribe = client.onNotification(listener);

    child.stdout.emit(
      "data",
      `${JSON.stringify({ method: "state.updated", params: { reason: "prompt_started" } })}\n`,
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      method: "state.updated",
      params: { reason: "prompt_started" },
    });

    unsubscribe();
    child.stdout.emit(
      "data",
      `${JSON.stringify({ method: "state.updated", params: { reason: "prompt_completed" } })}\n`,
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("surfaces a server→client request (method + non-pending id) to listeners", () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const listener = vi.fn();
    client.onNotification(listener);

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        id: "srv-1",
        method: "interaction/requestProviderRuntimeHeaders",
        params: {},
      })}\n`,
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ id: "srv-1", method: "interaction/requestProviderRuntimeHeaders" }),
    );
  });

  it("a listener throwing does not break parsing or other listeners", () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const survivor = vi.fn();
    client.onNotification(throwing);
    client.onNotification(survivor);

    // Should not throw out of emit.
    child.stdout.emit(
      "data",
      `${JSON.stringify({ method: "state.updated", params: { reason: "prompt_started" } })}\n`,
    );

    expect(throwing).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
  });
});

describe("createZcodeProtocolClient — respond", () => {
  it("writes a bare `{ id, result }` frame (no jsonrpc envelope) to child.stdin", () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    client.respond("srv-1", { headersApplied: true });

    expect(outboundFrames(child)).toEqual([
      { id: "srv-1", result: { headersApplied: true } },
    ]);
  });
});

describe("createZcodeProtocolClient — request timeout & abort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects after timeoutMs when no response ever arrives", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const pending = client.request({ id: "t1", method: "workspace/ping", params: {} }, 5_000);
    // Not yet rejected at 4999ms.
    const spy = vi.fn();
    pending.catch(spy);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(spy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).rejects.toThrow(/Timed out/);
  });

  it("rejects immediately when given an already-aborted signal", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));

    await expect(
      client.request({ id: "a1", method: "workspace/ping", params: {} }, 10_000, controller.signal),
    ).rejects.toThrow(/user cancelled/);

    // Nothing was sent.
    expect(outboundFrames(child)).toEqual([]);
  });

  it("rejects an in-flight request when the signal aborts later", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const controller = new AbortController();

    const pending = client.request(
      { id: "a2", method: "workspace/ping", params: {} },
      10_000,
      controller.signal,
    );
    // Sent before abort.
    expect(outboundFrames(child)).toHaveLength(1);

    controller.abort(new Error("cancelled mid-flight"));
    await expect(pending).rejects.toThrow(/cancelled mid-flight/);
  });

  it("a late abort after normal settle is a no-op (no double-settle, no leak)", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const controller = new AbortController();

    const pending = client.request(
      { id: "a3", method: "workspace/ping", params: {} },
      10_000,
      controller.signal,
    );
    // Resolve the request normally.
    child.stdout.emit("data", `${JSON.stringify({ id: "a3", result: { ok: true } })}\n`);
    const settled = await pending;
    expect(settled).toEqual({ id: "a3", result: { ok: true } });

    // A late abort must NOT reject the already-resolved promise (the abort
    // listener is removed on settle; registered with { once: true } as a
    // backstop). Aborting must not throw either.
    expect(() => controller.abort(new Error("too late"))).not.toThrow();
    // The promise retains its resolved value.
    await expect(pending).resolves.toEqual({ id: "a3", result: { ok: true } });
  });
});

describe("createZcodeProtocolClient — dispose & child lifecycle", () => {
  it("dispose() rejects pending requests and drops notification listeners", () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);
    const listener = vi.fn();
    client.onNotification(listener);

    const pending = client.request({ id: "d1", method: "workspace/ping", params: {} }, 60_000);
    client.dispose();

    return expect(pending).rejects.toThrow(/disposed/).then(() => {
      // Listeners dropped: a notification after dispose reaches nobody.
      child.stdout.emit(
        "data",
        `${JSON.stringify({ method: "state.updated", params: {} })}\n`,
      );
      expect(listener).not.toHaveBeenCalled();
    });
  });

  it("dispose() does NOT kill the child (no kill method is called)", () => {
    const child = makeChild();
    const kill = vi.fn();
    // Even if a kill method existed on the fake child, dispose must not call it.
    Object.assign(child, { kill });
    const client = createZcodeProtocolClient(child);
    client.dispose();
    expect(kill).not.toHaveBeenCalled();
  });

  it("rejects pending requests when the child emits close before responding", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const pending = client.request({ id: "c1", method: "workspace/ping", params: {} }, 60_000);
    child.stderr.emit("data", Buffer.from("boom: oauth failed\n"));
    child.emit("close");

    await expect(pending).rejects.toThrow(/exited before responding/);
    await expect(pending).rejects.toThrow(/oauth failed/);
  });
});
