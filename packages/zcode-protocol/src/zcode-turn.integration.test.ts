import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createZcodeProtocolClient } from "./zcode-protocol.js";
import { startZcodeProtocolTurn } from "./zcode-session.js";
import type { ZcodeConfig } from "./zcode-config.js";

/**
 * End-to-end integration seam (issue #5, criterion 5): drive
 * `startZcodeProtocolTurn` through a REAL `createZcodeProtocolClient` whose
 * child is a `PassThrough`-backed fake. Unlike the per-module unit tests
 * (which mock the client or feed frames directly), this one proves the three
 * modules compose over real JSON-RPC framing: every request the turn driver
 * issues is an actual newline-delimited JSON object on child.stdin, and every
 * forged response + notification we emit on child.stdout is parsed by the real
 * client and routed back.
 *
 * To make this deterministic without racing the async sequence, we tap
 * child.stdin: each time the client writes a request frame, a scripted responder
 * immediately emits the matching response on child.stdout.
 */
interface FakeChild extends ChildProcess {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

function makeChild(): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(emitter, { stdin, stdout, stderr: new PassThrough() });
  return emitter as unknown as FakeChild;
}

const PROVIDER: ZcodeConfig = {
  provider: "builtin:zai",
  model: "glm-5.1",
  models: ["glm-5.1"],
};

describe("startZcodeProtocolTurn — end-to-end over a real protocol client", () => {
  it("drives the full 6-method turn and delivers a text_delta to onEvent", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    // Capture every outbound frame (real JSON-RPC on the wire) and auto-respond
    // to each request by method, so the turn driver's awaits resolve in order.
    const outbound: { id: string; method: string }[] = [];
    const responses: Record<string, Record<string, unknown>> = {
      "workspace/upsertModelProvider": { ok: true },
      "workspace/setDefaultModel": { ok: true },
      "session/create": { session: { sessionId: "e2e-1" } },
      "session/setMode": { ok: true },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    };
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const frame = JSON.parse(trimmed) as { id: string; method?: string; result?: unknown };
        // Only request frames carry a method; responses to server→client requests
        // carry result instead. Respond to requests; just record the rest.
        if (typeof frame.method === "string") {
          outbound.push({ id: frame.id, method: frame.method });
          const result = responses[frame.method];
          if (result) {
            child.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
          }
        }
      }
    });

    const events: Record<string, unknown>[] = [];
    const turn = await startZcodeProtocolTurn({
      client,
      cwd: "/proj/alpha",
      mode: "agent",
      prompt: "write the thing",
      providerSelection: PROVIDER,
      onEvent: (e) => events.push(e),
    });

    // The 6-method sequence was sent, in order, as real JSON-RPC frames.
    expect(outbound.map((f) => f.method)).toEqual([
      "workspace/upsertModelProvider",
      "workspace/setDefaultModel",
      "session/create",
      "session/setMode",
      "session/subscribe",
      "session/send",
    ]);
    expect(turn.sessionId).toBe("e2e-1");

    // Now inject an asynchronous content notification on the real stdout path.
    // It must reach onEvent as a text_delta — proving the full
    // client→stream-handler→onEvent plumbing works over the wire.
    child.stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "text_delta", delta: "streamed over stdio" } },
      })}\n`,
    );

    expect(events).toContainEqual({ type: "text_delta", delta: "streamed over stdio" });

    turn.unsubscribe();
    client.dispose();
  });

  it("auto-responds to requestProviderRuntimeHeaders over the real wire", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const responses: Record<string, Record<string, unknown>> = {
      "workspace/upsertModelProvider": { ok: true },
      "workspace/setDefaultModel": { ok: true },
      "session/create": { session: { sessionId: "e2e-2" } },
      "session/subscribe": { ok: true },
      "session/send": { ok: true },
    };
    const inboundServerFrames: Record<string, unknown>[] = [];
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString("utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const frame = JSON.parse(trimmed) as { id: string; method?: string };
        inboundServerFrames.push(frame);
        if (typeof frame.method === "string" && responses[frame.method]) {
          child.stdout.write(
            `${JSON.stringify({ id: frame.id, result: responses[frame.method] })}\n`,
          );
        }
      }
    });

    const turn = await startZcodeProtocolTurn({
      client,
      cwd: "/proj/beta",
      prompt: "p",
      providerSelection: PROVIDER,
      onEvent: () => {},
    });

    // Server initiates the headers handshake on stdout (real wire path).
    child.stdout.write(
      `${JSON.stringify({
        id: "srv-hdrs",
        method: "interaction/requestProviderRuntimeHeaders",
        params: {},
      })}\n`,
    );

    // The turn driver's listener must have caused the client to write a real
    // respond() frame back to stdin with { headersApplied: true }.
    const respondFrame = inboundServerFrames.find((f) => f.id === "srv-hdrs" && f.result);
    expect(respondFrame).toEqual({
      jsonrpc: "2.0",
      id: "srv-hdrs",
      result: { headersApplied: true },
    });

    turn.unsubscribe();
    client.dispose();
  });
});
