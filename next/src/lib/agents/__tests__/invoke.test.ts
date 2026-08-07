// @vitest-environment node
//
// This test mocks node:child_process and node:fs and drives real spawn-style
// child plumbing (EventEmitter + PassThrough). The default happy-dom env
// interferes with vi.mock on node: builtins; the node environment is correct
// for a spawn/stdio unit test and matches how cli runs the same seam.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const { mockSpawn, existsSyncDelegate, mockReadZcodeConfig } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  existsSyncDelegate: vi.fn((p: string) => p === "/bin/sh"),
  // Default: a valid saved provider so the app-server branch proceeds to spawn.
  // Untyped vi.fn() so tests can also return null ("no provider configured").
  mockReadZcodeConfig: vi.fn(() => ({
    provider: "builtin:zai",
    model: "glm-5.1",
    models: ["glm-5.1"],
  })),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: mockSpawn };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncDelegate };
});

vi.mock("@html-anything/zcode-protocol/zcode-config", () => ({
  readZcodeConfig: mockReadZcodeConfig,
}));

import { invokeAgent, type InvokeEvent } from "../invoke";
import { AGENTS } from "../detect";

function makeFakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });

  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 99999,
  });

  return { child, stdout, stderr, stdin };
}

async function collectStream(
  stream: ReadableStream<InvokeEvent>,
): Promise<InvokeEvent[]> {
  const events: InvokeEvent[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) events.push(value);
  }
  return events;
}

/**
 * Script the fake app-server child: auto-respond to each JSON-RPC request
 * method on stdin with a canned result on stdout. Returns the child so the
 * caller can emit notifications / close afterwards.
 *
 * Mirrors the cli T5 test seam — see cli/src/__tests__/agents-invoke.test.ts.
 * The next app's app-server branch must behave identically.
 */
function makeAppServerChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk: unknown, _enc: unknown, cb: () => void) {
      cb();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4242,
  });

  const responses: Record<string, Record<string, unknown>> = {
    "workspace/upsertModelProvider": { ok: true },
    "workspace/setDefaultModel": { ok: true },
    "session/create": { session: { sessionId: "sess-1" } },
    "session/setMode": { ok: true },
    "session/subscribe": { ok: true },
    "session/send": { ok: true },
  };

  // Tap stdin to auto-respond. The protocol client writes one JSON object
  // per line; we parse and reply on stdout.
  stdin.write = ((chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let frame: { id?: string; method?: string };
      try {
        frame = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof frame.method === "string" && typeof frame.id === "string") {
        const result = responses[frame.method];
        if (result) {
          stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        }
      }
    }
    return true;
  }) as typeof stdin.write;

  return { child, stdout, stderr, stdin };
}

// On win32 next quotes the bin and runs through a shell; on *nix it passes
// the bin verbatim. Tests must accept whichever the host platform produces.
const USE_SHELL = process.platform === "win32";
const BIN_OVERRIDE = "/bin/sh";

describe("invokeAgent — app-server protocol branch (ZCode)", () => {
  const ZCODE_DEF = {
    id: "zcode",
    label: "ZCode",
    bin: "node",
    vendor: "Z.AI",
    protocol: "app-server" as const,
    binArgs: ["/resolved/zcode.cjs", "app-server"],
    fallbackModels: [{ id: "default", label: "Default" }],
  };

  let pushed: unknown | null = null;
  beforeEach(() => {
    // ZCode isn't registered until T7; push a temporary AgentDef so the
    // app-server branch is reachable. Removed in afterEach.
    pushed = ZCODE_DEF;
    (AGENTS as unknown[]).push(ZCODE_DEF);
    // The app-server bin is an absolute path ("/resolved/node"); let the
    // mocked existsSync accept it so resolveBinForAgent succeeds.
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/resolved/node" || p === "/bin/sh",
    );
    mockSpawn.mockReset();
    (
      mockReadZcodeConfig as unknown as {
        mockReturnValue(v: unknown): unknown;
      }
    ).mockReturnValue({
      provider: "builtin:zai",
      model: "glm-5.1",
      models: ["glm-5.1"],
    });
  });
  afterEach(() => {
    if (pushed) {
      const idx = (AGENTS as unknown[]).lastIndexOf(pushed);
      if (idx >= 0) (AGENTS as unknown[]).splice(idx, 1);
    }
    pushed = null;
    existsSyncDelegate.mockImplementation((p: string) => p === "/bin/sh");
  });

  it("spawns via binArgs as `node <cjs> app-server` and reports start.argv", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // Emit a final-result usage so the turn ends → {type:"done"}.
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 1 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;

    // spawn called with bin (quoted on win32) + binArgs (no prompt on argv).
    expect(mockSpawn).toHaveBeenCalledWith(
      USE_SHELL ? `"/resolved/node"` : "/resolved/node",
      ["/resolved/zcode.cjs", "app-server"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );

    const start = events.find((e) => e.type === "start");
    expect(start).toMatchObject({
      type: "start",
      bin: "/resolved/node",
      argv: ["/resolved/zcode.cjs", "app-server"],
    });
  });

  it("bridges a text_delta notification to {type:'delta'}", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "hi",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // Stream a text_delta, then end the turn with a final-result usage.
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "text_delta", delta: "hello " } },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "text_delta", delta: "world" } },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 5 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe("hello world");
  });

  it("rescues HTML from a write tool_use → {type:'html'}", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "make a page",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    const html = "<html><body>from tool</body></html>";
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: {
          payload: {
            kind: "tool_call",
            toolCallId: "t1",
            toolName: "write",
            input: { file_path: "out.html", content: html },
          },
        },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 1 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;
    const htmls = events.filter((e) => e.type === "html");
    expect(htmls).toHaveLength(1);
    expect((htmls[0] as { text: string }).text).toBe(html);
  });

  it("final-result usage → {type:'done', code:0}", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 2 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: "done", code: 0 });
  });

  it("turn driver rejection (session/create error) → {type:'error'}", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    // Override the stdin tap to make session/create return a JSON-RPC error,
    // which the protocol client surfaces as a rejected request → the turn
    // driver rejects → invokeAgent emits {type:"error"}.
    child.stdin.write = ((chunk: unknown) => {
      const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let frame: { id?: string; method?: string };
        try {
          frame = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (typeof frame.method === "string" && typeof frame.id === "string") {
          if (frame.method === "session/create") {
            stdout.write(
              `${JSON.stringify({ id: frame.id, error: { code: -32603, message: "no session" } })}\n`,
            );
          } else {
            stdout.write(`${JSON.stringify({ id: frame.id, result: { ok: true } })}\n`);
          }
        }
      }
      return true;
    }) as typeof child.stdin.write;

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 1);

    const events = await eventsPromise;
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { message: string }).message).toContain("no session");
  });

  it("errors when no saved model provider is configured", async () => {
    (
      mockReadZcodeConfig as unknown as { mockReturnValueOnce(v: unknown): unknown }
    ).mockReturnValueOnce(null);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    const events = await collectStream(stream);
    // No spawn attempted — the branch short-circuits to an error stream.
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("no saved model provider"),
    });
  });
});

// Regression guards for the argv branch — keep parity with the pre-T6 behavior
// so the new app-server routing doesn't disturb existing adapters.
describe("invokeAgent — argv branch (regression)", () => {
  it("unknown agent returns a single error event", async () => {
    const stream = invokeAgent({
      agent: "nonexistent",
      prompt: "test",
      binOverride: BIN_OVERRIDE,
    });

    const events = await collectStream(stream);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("unknown agent"),
    });
  });

  it("missing binOverride returns a single error event", async () => {
    const stream = invokeAgent({
      agent: "claude",
      prompt: "test",
      binOverride: "/nonexistent/path/to/bin",
    });

    const events = await collectStream(stream);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("does not exist"),
    });
  });
});
