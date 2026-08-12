import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createZcodeProtocolClient } from "./zcode-protocol";
import { startZcodeProtocolTurn } from "./zcode-session";

/**
 * Module-composition seam: drive `startZcodeProtocolTurn` through a REAL
 * `createZcodeProtocolClient` whose child is a `PassThrough`-backed fake.
 *
 * This is NOT a real-server integration test (the real one lives in
 * `zcode-real-server.integration.test.ts`, gated on the ZCode binary existing).
 * It proves the three modules compose over real JSON-RPC framing: every request
 * the turn driver issues is an actual newline-delimited JSON object on
 * child.stdin, and every forged response + notification we emit on child.stdout
 * is parsed by the real client and routed back. The frames scripted here are
 * pinned against the real server's Zod schemas (live-confirmed by #14 probes),
 * not invented shapes — so this seam catches drift between the client framing
 * and the turn driver's expected wire format.
 *
 * #14 (live-corrected): the app-server child self-authenticates the LOGIN but a
 * fresh `session/create` needs the workspace model configured first (the
 * caller's once-per-boot relay — see ensureWorkspaceModel, tested separately).
 * This composition seam exercises the turn driver in isolation, so no relay
 * runs here; the scripted create response stands in for a pre-configured
 * workspace.
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

describe("startZcodeProtocolTurn — module composition over a real protocol client", () => {
  it("drives the turn and delivers a text_delta to onEvent", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    // Capture every outbound frame (real JSON-RPC on the wire) and auto-respond
    // to each request by method, so the turn driver's awaits resolve in order.
    const outbound: { id: string; method: string }[] = [];
    const responses: Record<string, Record<string, unknown>> = {
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
      onEvent: (e) => events.push(e),
    });

    // The turn sequence was sent, in order, as real JSON-RPC frames.
    expect(outbound.map((f) => f.method)).toEqual([
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

  it("auto-responds to session/requestRuntimePreferences over the real wire (proven issued)", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const responses: Record<string, Record<string, unknown>> = {
      "session/create": { session: { sessionId: "e2e-3" } },
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
      cwd: "/proj/gamma",
      prompt: "p",
      onEvent: () => {},
    });

    child.stdout.write(
      `${JSON.stringify({
        id: "srv-prefs",
        method: "session/requestRuntimePreferences",
        params: { sessionId: "e2e-3", scope: "runtime-materialization" },
      })}\n`,
    );

    // The server validates the result with a Zod schema requiring
    // nativeSearchEnhancementsEnabled (boolean) — #14 probe-13 confirmed the
    // exact spelling. Replying {} is rejected with code -32603.
    const respondFrame = inboundServerFrames.find((f) => f.id === "srv-prefs" && f.result);
    expect(respondFrame).toEqual({
      id: "srv-prefs",
      result: { nativeSearchEnhancementsEnabled: false },
    });

    turn.unsubscribe();
    client.dispose();
  });

  it("does NOT write a respond frame for interaction/requestProviderRuntimeHeaders (vestigial, removed)", async () => {
    const child = makeChild();
    const client = createZcodeProtocolClient(child);

    const responses: Record<string, Record<string, unknown>> = {
      "session/create": { session: { sessionId: "e2e-4" } },
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
      cwd: "/proj/delta",
      prompt: "p",
      onEvent: () => {},
    });

    // #14 probes 3 + 12: the server NEVER issued this across two full turns.
    // The auto-reply handler is removed; even if a stray frame arrives, no
    // respond frame is written back to stdin.
    child.stdout.write(
      `${JSON.stringify({
        id: "srv-hdrs",
        method: "interaction/requestProviderRuntimeHeaders",
        params: {},
      })}\n`,
    );

    const respondFrame = inboundServerFrames.find((f) => f.id === "srv-hdrs" && f.result);
    expect(respondFrame).toBeUndefined();

    turn.unsubscribe();
    client.dispose();
  });
});
