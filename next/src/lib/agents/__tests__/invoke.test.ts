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
  mockReadZcodeConfig: vi.fn((): unknown => ({
    provider: "builtin:bigmodel-coding-plan",
    model: "GLM-5.2",
    models: ["GLM-5.2"],
    providerRecord: {
      providerId: "builtin:bigmodel-coding-plan",
      kind: "anthropic",
      apiKey: { source: "inline", value: "test-key" },
      models: [{ modelId: "GLM-5.2" }],
      baseURL: "https://open.bigmodel.cn/api/anthropic",
    },
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

// #14: ensureWorkspaceModel reads the saved provider config. Mock it so the
// invoke-layer tests don't touch disk; the config reader itself is tested in
// the protocol package.
vi.mock("@html-anything/zcode-protocol/zcode-config", () => ({
  readZcodeConfig: mockReadZcodeConfig,
}));

import { invokeAgent, type InvokeEvent } from "../invoke";

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
 * method on stdin with a canned result on stdout. Records every request method
 * seen on the wire so the relay-absence test (#13) can assert no
 * provider/workspace relay method is sent. Returns the child so the caller can
 * emit notifications / close afterwards.
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

  // Every request method seen on the wire, in order.
  const sentMethods: string[] = [];

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
        sentMethods.push(frame.method);
        const result = responses[frame.method];
        if (result) {
          stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        }
      }
    }
    return true;
  }) as typeof stdin.write;

  return { child, stdout, stderr, stdin, sentMethods };
}

// On win32 next quotes the bin and runs through a shell; on *nix it passes
// the bin verbatim. Tests must accept whichever the host platform produces.
const USE_SHELL = process.platform === "win32";
const BIN_OVERRIDE = "/bin/sh";

describe("invokeAgent — app-server protocol branch (ZCode)", () => {
  beforeEach(() => {
    // Make resolveZcodeBin() return the test .cjs path so the binArgs
    // sentinel resolves to it (T7 invoke-time substitution). ZCode is now
    // registered in AGENTS (T7); no temporary def push is needed.
    vi.stubEnv("ZCODE_BIN", "/resolved/zcode.cjs");
    // The app-server bin is an absolute path ("/resolved/node"); let the
    // mocked existsSync accept it so resolveBinForAgent succeeds. Also
    // accept the ZCODE_BIN path so resolveZcodeBin's first probe hits.
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/resolved/node" ||
      p === "/resolved/zcode.cjs" ||
      p === "/bin/sh",
    );
    mockSpawn.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
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
    // On win32 next runs the child through a shell, so every argv element is
    // quoted (quoteWindowsArg) — matching cli's app-server branch. argv never
    // carries the prompt; binArgs carries [ZCODE_CJS_SENTINEL, "app-server"].
    expect(mockSpawn).toHaveBeenCalledWith(
      USE_SHELL ? `"/resolved/node"` : "/resolved/node",
      USE_SHELL
        ? [`"/resolved/zcode.cjs"`, `"app-server"`]
        : ["/resolved/zcode.cjs", "app-server"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );

    const start = events.find((e) => e.type === "start");
    expect(start).toMatchObject({
      type: "start",
      bin: "/resolved/node",
      argv: ["/resolved/zcode.cjs", "app-server"],
    });
  });

  // ADR-0004 / T9: without ELECTRON_RUN_AS_NODE=1 the zcode.cjs child hangs
  // at Electron-component init. The env must be merged INTO envFor(...) (so
  // the rest of the process env survives), not replace it. spawn is mocked,
  // so this pins the fact without a real server. Mirrors the cli test seam.
  it("spawns with ELECTRON_RUN_AS_NODE=1 merged into the env", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // End the turn so the stream closes.
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 1 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    await eventsPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      USE_SHELL ? `"/resolved/node"` : "/resolved/node",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );
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

  // ADR-0004 + #14 (live-probe-corrected): the app-server child self-auths
  // the LOGIN, but a fresh session/create needs the workspace model configured
  // first (#13 wrongly deleted this relay; #14 live probes disproved the
  // assumption). So the adapter runs the once-per-boot model relay
  // (upsertModelProvider → setDefaultModel) BEFORE the turn. Mirrors the cli
  // test seam; pins the full wire sequence including the relay.
  it("relays the once-per-boot model config (upsert→setDefault) before the turn", async () => {
    const { child, stdout, sentMethods } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // End the turn so the wire capture is complete.
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 1 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    await eventsPromise;

    // The relay runs first, then the turn. Assert the exact full sequence.
    expect(sentMethods).toEqual([
      "workspace/upsertModelProvider",
      "workspace/setDefaultModel",
      "session/create",
      "session/subscribe",
      "session/send",
    ]);
  });

  it("emits {type:'error'} and does not create when no usable provider is configured", async () => {
    mockReadZcodeConfig.mockReturnValueOnce(null);
    const { child } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const events = await collectStream(stream);

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect((error as { message?: string }).message).toMatch(/no usable ZCode provider/i);
  });

  // T12 (#12): external-process node resolution. On a clean host `where node`
  // finds nothing — only the ZCode Electron executable exists. When no
  // binOverride is passed and no system `node` is on PATH, the app-server
  // branch must resolve the bin via resolveZcodeNodeBin() (which discovers the
  // Electron exe), NOT fail with "not installed". ZCODE_BIN stays scoped to the
  // .cjs (not overloaded as the node bin).
  it("falls back to the ZCode Electron exe when node is not on PATH (T12)", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/resolved/zcode.cjs" ||
      p === "C:\\Program Files\\ZCode\\ZCode.exe" ||
      p === "/bin/sh",
    );
    vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "C:\\Program Files\\ZCode");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const stream = invokeAgent({ agent: "zcode", prompt: "build it" });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 1 } } },
      })}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await eventsPromise;

    // The decisive assertion: spawn was called with the Electron exe as bin
    // (quoted on win32 because the path contains a space).
    expect(mockSpawn).toHaveBeenCalledWith(
      USE_SHELL ? `"C:\\Program Files\\ZCode\\ZCode.exe"` : "C:\\Program Files\\ZCode\\ZCode.exe",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );
  });

  // T12 (#12): graceful degradation. When NEITHER a node NOR the Electron exe
  // can be found, the adapter must emit a clear, actionable error — not a
  // silent hang or an opaque "node not installed".
  it("emits a clear error when no node AND no Electron exe can be found (T12)", async () => {
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/resolved/zcode.cjs" || p === "/bin/sh",
    );
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const stream = invokeAgent({ agent: "zcode", prompt: "p" });
    const events = await collectStream(stream);

    expect(mockSpawn).not.toHaveBeenCalled();
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    const msg = (error as { message?: string }).message ?? "";
    expect(msg).toMatch(/node/i);
    expect(msg).toMatch(/ZCODE_NODE_BIN|ZCode/i);
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
