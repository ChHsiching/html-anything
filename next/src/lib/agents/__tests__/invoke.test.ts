// @vitest-environment node
//
// This test mocks node:child_process and node:fs and drives real spawn-style
// child plumbing (EventEmitter + PassThrough). The default happy-dom env
// interferes with vi.mock on node: builtins; the node environment is correct
// for a spawn/stdio unit test and matches how cli runs the same seam.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const { mockSpawn, existsSyncDelegate, mockReadZcodeConfig, mockReadZcodeModelPicker } = vi.hoisted(() => ({
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
  // #19: the dynamic ZCode picker models returned by readZcodeModelPicker.
  // Two enabled providers' models; the resolver picks the entry whose id
  // matches opts.model. defaultProviderId is the selected provider, so the
  // disambiguation test (model under two providers) resolves correctly.
  mockReadZcodeModelPicker: vi.fn((): unknown => ({
    models: [
      { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel-coding-plan" },
      { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel-coding-plan" },
      { id: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", providerId: "builtin:openrouter" },
    ],
    defaultProviderId: "builtin:bigmodel-coding-plan",
    defaultModelId: "GLM-5.2",
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

// #19: resolveZcodeTurnModel reads the dynamic picker models. Mock it so the
// invoke-layer tests don't touch disk; the reader itself is tested in the
// protocol package.
vi.mock("@html-anything/zcode-protocol/zcode-model-picker", () => ({
  readZcodeModelPicker: mockReadZcodeModelPicker,
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
  // Every parsed request frame seen on the wire, in order: { id, method, params }.
  // Captures the full params so the #19 model-threading tests can assert what
  // session/create carries (model present vs absent).
  const sentFrames: { id?: string; method?: string; params?: Record<string, unknown> }[] = [];

  // Tap stdin to auto-respond. The protocol client writes one JSON object
  // per line; we parse and reply on stdout.
  stdin.write = ((chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let frame: { id?: string; method?: string; params?: Record<string, unknown> };
      try {
        frame = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof frame.method === "string" && typeof frame.id === "string") {
        sentMethods.push(frame.method);
        sentFrames.push(frame);
        const result = responses[frame.method];
        if (result) {
          stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
        }
      }
    }
    return true;
  }) as typeof stdin.write;

  return { child, stdout, stderr, stdin, sentMethods, sentFrames };
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

  // #21 / spec #20 N1: a non-HTML tool_use (e.g. WebSearch) is forwarded as a
  // {type:"meta", key:"status"} event so the SSE stream emits bytes during the
  // model's tool window instead of freezing the UI. The HTML-rescue branch
  // (above) is unchanged — only the previously-dropped fallthrough now emits a
  // meta. The meta key is adapter-internal naming; the frontend ignores meta
  // today, so this is a no-op for the UI until a future spec surfaces it.
  it("forwards a non-HTML tool_use as a meta status event (#21)", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "search the web",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // A tool_call whose name is not a write tool → no HTML rescue → meta.
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: {
          payload: {
            kind: "tool_call",
            toolCallId: "ws1",
            toolName: "WebSearch",
            input: { query: "Matt Pocock Skills" },
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
    const statusMetas = events.filter(
      (e) => e.type === "meta" && (e as { key?: string }).key === "status",
    );
    expect(statusMetas).toHaveLength(1);
    expect(statusMetas[0]).toMatchObject({
      type: "meta",
      key: "status",
      value: "🔍 WebSearch",
    });
    // A non-HTML tool_use must NOT also emit an html event.
    expect(events.some((e) => e.type === "html")).toBe(false);
  });

  // #21: tool_result carries only toolUseId (no name); the adapter recovers the
  // name from the preceding tool_use and emits "✓ <name>". When the result's
  // toolUseId was never seen, it falls back to a bare "✓".
  it("forwards a tool_result as a meta status event with the carried tool name (#21)", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "search the web",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // tool_use first (registers the name under its id), then the matching
    // result, then an orphan result with an untracked id, then end the turn.
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: {
          payload: {
            kind: "tool_call",
            toolCallId: "ws1",
            toolName: "WebSearch",
            input: { query: "x" },
          },
        },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: {
          payload: {
            kind: "result",
            toolCallId: "ws1",
            result: { content: [{ type: "text", text: "hits" }], success: true },
          },
        },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: {
          payload: {
            kind: "result",
            toolCallId: "orphan",
            result: { content: [], success: true },
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
    const statusMetas = events
      .filter((e) => e.type === "meta" && (e as { key?: string }).key === "status")
      .map((e) => (e as { value?: unknown }).value);
    // tool_use meta (🔍) + matched result meta (✓ name) + orphan result meta (✓).
    expect(statusMetas).toEqual(["🔍 WebSearch", "✓ WebSearch", "✓"]);
  });

  // #21: thinking_delta is the model's high-frequency reasoning signal. The
  // spec #20 grilling rejected forwarding it (would flood the stream), so it
  // must produce NO meta status event. (N2, a separate ticket, will reset a
  // silence timer on it — but N1 deliberately drops it.)
  it("does not emit a meta for thinking_delta (still dropped, #21)", async () => {
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "think hard",
      binOverride: "/resolved/node",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "thinking_delta", delta: "reasoning..." } },
      })}\n`,
    );
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "thinking_delta", delta: "more..." } },
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
    const statusMetas = events.filter(
      (e) => e.type === "meta" && (e as { key?: string }).key === "status",
    );
    expect(statusMetas).toHaveLength(0);
    // The only meta on the stream should be the terminal usage one.
    const metas = events.filter((e) => e.type === "meta");
    expect(metas.map((m) => (m as { key?: string }).key)).toEqual(["usage"]);
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

  // T15 (#18 / ADR-0005 decision 3): the "no node AND no Electron exe" error
  // path was REMOVED — it was unreachable. detectAgents() reports zcode
  // available only when zcode.cjs was found ⟺ ZCode is installed ⟺ the
  // sibling Electron exe exists, so resolveZcodeNodeBin() always hits its
  // terminal fallback for any caller that reached this code. There is no
  // error branch left to test; the absence is a static assertion (grep for
  // the message string is gone). The T12 fallback case above remains the
  // pin for the real spawn path.

  // #19 / ADR-0005 decision 4: a non-default model pick is plumbed through to
  // session/create as model:{providerId, modelId}. Live-proven the server
  // accepts this nested object and binds it to the session for every turn.
  it("carries model:{providerId, modelId} on session/create for a non-default model pick", async () => {
    const { child, stdout, sentFrames } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
      model: "GLM-5-Turbo",
    });

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

    const create = sentFrames.find((f) => f.method === "session/create");
    expect(create).toBeDefined();
    // model is the picked modelId + the providerId the resolver recovered from
    // the dynamic picker list (bigmodel-coding-plan owns defaultModelId
    // GLM-5.2, so GLM-5-Turbo resolves under that provider).
    expect(create!.params).toMatchObject({
      workspace: expect.any(Object),
      model: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5-Turbo" },
    });
  });

  // #19: the default model pick (or absent) carries NO model field — the
  // workspace default (provisioned by the once-per-boot relay) applies. This
  // is the unchanged pre-#19 behaviour, asserted explicitly so a regression
  // that always sends model is caught.
  it("omits model from session/create for the default model pick", async () => {
    const { child, stdout, sentFrames } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
      // model omitted (undefined) → "default" path
    });

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

    const create = sentFrames.find((f) => f.method === "session/create");
    expect(create).toBeDefined();
    expect(create!.params).not.toHaveProperty("model");
  });

  // #19: when the same model id exists under MULTIPLE enabled providers, the
  // resolver prefers the GUI's selected provider (defaultProviderId). GLM-5.2
  // appears under both builtin:bigmodel and builtin:bigmodel-coding-plan here;
  // defaultProviderId is the coding-plan, so the create frame must bind to it
  // — NOT the first-listed bigmodel. This falsifies the disambiguation branch.
  it("prefers the selected provider when the picked model id is ambiguous across providers", async () => {
    mockReadZcodeModelPicker.mockReturnValueOnce({
      models: [
        { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel" },
        { id: "GLM-5-Turbo", label: "GLM-5-Turbo", providerId: "builtin:bigmodel" },
        { id: "GLM-5.2", label: "GLM-5.2", providerId: "builtin:bigmodel-coding-plan" },
      ],
      defaultProviderId: "builtin:bigmodel-coding-plan",
      defaultModelId: "GLM-5.2",
    });
    const { child, stdout, sentFrames } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
      model: "GLM-5.2", // ambiguous: under bigmodel AND bigmodel-coding-plan
    });

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

    const create = sentFrames.find((f) => f.method === "session/create");
    expect(create).toBeDefined();
    // The selected provider (owns defaultModelId GLM-5.2) is coding-plan, NOT
    // the first-listed bigmodel — the resolver's disambiguation must pick it.
    expect(create!.params).toMatchObject({
      model: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5.2" },
    });
  });
});

// Regression guards for the argv branch — keep parity with the pre-T6 behavior
// so the new app-server routing doesn't disturb existing adapters.
describe("invokeAgent — argv branch (regression)", () => {
  // Isolate from the app-server describe above: that block legitimately calls
  // spawn and its beforeEach reset is scoped to its own tests. Reset the mock
  // here too so the call-count assertion below counts only this block's spawn.
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // #17: quoteWindowsArg is gated to the app-server (ZCode) branch only. The
  // shared argv spawn (every argv / argv-message agent — deepseek-tui,
  // openclaw) must pass argv verbatim, matching the `main` baseline. This pins
  // that guarantee on a win32-mocked host: no argv element gains quotes.
  it("argv-protocol agent (deepseek-tui) spawns with bare argv elements on win32 — no per-element quoting (#17)", async () => {
    // Force win32 so the shared branch takes the useShell path. Restore in
    // finally so a mid-assertion throw can't poison sibling tests.
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const { child, stdout } = makeFakeChild();
      mockSpawn.mockReturnValue(child);
      existsSyncDelegate.mockImplementation((p: string) => p === BIN_OVERRIDE);

      const stream = invokeAgent({
        agent: "deepseek-tui",
        prompt: "make a page",
        binOverride: BIN_OVERRIDE,
      });

      await new Promise((r) => setTimeout(r, 0));
      const eventsPromise = collectStream(stream);
      stdout.end();
      await new Promise((r) => setImmediate(r));
      child.emit("close", 0);
      await eventsPromise;

      // spawn called once; argv (2nd arg) is bare — no element wrapped in
      // quotes. The bin is still quoted on win32 (for .cmd/.bat shims) and
      // shell:true is still set, but that's the unchanged bin-quoting path.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const call = mockSpawn.mock.calls[0];
      const spawnedArgv = call[1] as string[];
      for (const el of spawnedArgv) {
        expect(el.startsWith('"')).toBe(false);
        expect(el.endsWith('"')).toBe(false);
      }
      // Shape is the documented deepseek-tui argv + the prompt positional.
      expect(spawnedArgv).toEqual(
        expect.arrayContaining(["exec", "--auto", "make a page"]),
      );
      expect(call[2]).toMatchObject({ shell: true });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

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
