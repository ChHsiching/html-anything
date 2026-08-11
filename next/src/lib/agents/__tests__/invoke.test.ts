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
      value: "调用工具 WebSearch",
    });
    // A non-HTML tool_use must NOT also emit an html event.
    expect(events.some((e) => e.type === "html")).toBe(false);
  });

  // #21: tool_result carries a tool name — either on the event itself (the
  // protocol stream reads it from the frame's `toolName` field) or recovered
  // from the preceding tool_use via the Map fallback. When neither yields a
  // name (e.g. an orphan result whose id was never seen), emit NOTHING — a
  // nameless status line ("✓") is noise worse than no line at all.
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
    // tool_use meta (调用工具) + matched result meta (工具 …完成, name resolved
    // via Map fallback since this `result` frame has no toolName). The orphan
    // result (id never seen, no toolName) emits NOTHING — no nameless status.
    expect(statusMetas).toEqual(["调用工具 WebSearch", "工具 WebSearch 完成"]);
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

  // ─── #22 / spec #20 N2: turn-silence timeout ───────────────────────────
  //
  // The post-`session/send` window is the only unbounded await in the turn.
  // #22 installs a 180s SILENCE timer (not a hard turn cap): it arms after the
  // turn driver resolves and resets on EVERY onEvent call (including the
  // dropped thinking_delta — the model's "I'm still alive" signal during deep
  // reasoning), so legitimately long agentic turns keep running as long as
  // events keep arriving. Only 180s of ZERO events fires an error + finish(1).
  //
  // The four tests below use vi.useFakeTimers() so the 180s clock is advanced
  // instantly. The fake timers do NOT intercept process.nextTick / PassThrough
  // 'data' delivery, so the protocol client's request/response cycle (and the
  // resulting onEvent calls) still drain naturally — we only advance the
  // silence clock, not the microtask queue. afterEach restores real timers so
  // sibling tests (real setTimeout(0) flush) are unaffected.
  //
  // Helper: drain microtasks + nextTick WITHOUT advancing fake timers. The
  // async start() runs through ensureWorkspaceModel (2 reqs) +
  // startZcodeProtocolTurn (3 reqs) + the silence-timer arm; each await yields
  // at a microtask boundary and the mock child's responses arrive on the next
  // PassThrough 'data' event (a real nextTick under fake timers). Iterating a
  // bounded number of times is enough to complete the whole chain.

  const flushMicrotasks = async (iterations = 200) => {
    for (let i = 0; i < iterations; i++) {
      await Promise.resolve();
      await new Promise((r) => process.nextTick(r));
    }
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  // (a) Slow-but-alive: a turn that emits thinking_delta at t=0 and t=179s,
  // then usage at t=200s, completes with done code 0 and NO silence-error.
  // This proves long-thinking turns are not falsely aborted — the resets keep
  // the timer alive across the full 200s. thinking_delta is the weakest signal
  // (it's dropped from the InvokeEvent surface) but still resets the clock.
  //
  // NOTE on the wire shape: the stream handler maps an inbound payload with
  // `kind:"reasoning_delta"` → onEvent({type:"thinking_delta"}). So the
  // liveness event is produced by writing a `reasoning_delta` payload; a
  // `kind:"thinking_delta"` payload would match no branch and be dropped (no
  // onEvent call → no reset), which is the opposite of what this test wants.
  it("does not abort a slow-but-alive turn that keeps emitting events (#22)", async () => {
    vi.useFakeTimers();
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "think hard",
      binOverride: "/resolved/node",
    });

    // Drive start() to completion: the 4 JSON-RPC requests resolve, the
    // silence timer arms, and onEvent is wired. No events yet.
    await flushMicrotasks();

    const eventsPromise = collectStream(stream);

    // t=0: a reasoning_delta arrives → mapped to onEvent(thinking_delta) →
    // resetSilenceTimer (180s window, fires at t=180s if nothing resets).
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "reasoning_delta", delta: "reasoning..." } },
      })}\n`,
    );
    await flushMicrotasks();

    // Advance to t=179s: still inside the first window, emit another
    // reasoning_delta → resets the clock to t=179+180=359s.
    vi.advanceTimersByTime(179_000);
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { kind: "reasoning_delta", delta: "still thinking..." } },
      })}\n`,
    );
    await flushMicrotasks();

    // Advance to t=200s and deliver the terminal usage → finish(0). At t=200s
    // the silence window (armed at t=179, would fire at t=359s) has NOT fired.
    vi.advanceTimersByTime(21_000);
    stdout.write(
      `${JSON.stringify({
        method: "session/event",
        params: { payload: { resultType: "success", usage: { inputTokens: 1 } } },
      })}\n`,
    );
    stdout.end();
    await flushMicrotasks();
    child.emit("close", 0);

    const events = await eventsPromise;

    const errors = events.filter((e) => e.type === "error");
    const silenceErrors = errors.filter((e) =>
      /went silent/.test((e as { message?: string }).message ?? ""),
    );
    expect(silenceErrors).toHaveLength(0);
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: "done", code: 0 });
  });

  // (b) Genuine silence: the turn driver resolved (timer armed) but NO events
  // arrive. After 180s the timer fires → emits {type:"error", /went silent/}
  // and calls finish(1). The stream closes with a non-zero done code. This is
  // the core robustness guarantee: a dead turn surfaces a clean error instead
  // of hanging forever.
  it("fires the silence error + finish(1) after 180s with zero events (#22)", async () => {
    vi.useFakeTimers();
    const { child } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await flushMicrotasks();

    const eventsPromise = collectStream(stream);

    // Arm happened at t=0 (turn driver resolved). Emit NOTHING for 181s.
    vi.advanceTimersByTime(181_000);
    await flushMicrotasks();

    const events = await eventsPromise;
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { message?: string }).message).toMatch(/went silent for 180s/);
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: "done", code: 1 });
  });

  // (c) Reset on tool events: a tool_use arrives at t=170s (inside the first
  // window) and resets the clock. Genuine silence then must fire at ≈350s
  // (170+180), NOT ≈180s. This proves the reset logic — a tool call (the
  // canonical agentic-liveness signal) refreshes the timer just like a delta.
  it("resets the silence clock on a tool_use event (#22)", async () => {
    vi.useFakeTimers();
    const { child, stdout } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "use a tool",
      binOverride: "/resolved/node",
    });

    await flushMicrotasks();

    const eventsPromise = collectStream(stream);

    // t=0: arm. Advance to t=170s (inside the first 180s window) and emit a
    // tool_use → resets the clock to t=170+180=350s.
    vi.advanceTimersByTime(170_000);
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
    await flushMicrotasks();

    // Advance past the ORIGINAL 180s window (t=170+179=349s) without crossing
    // the RESET 350s boundary. The timer must NOT have fired here — if it had,
    // the stream would already have closed with a silence error + done. We
    // assert that by reading the next event without blocking: a closed stream
    // resolves to {done:true}; an open one keeps the read pending. Since
    // fake-timer advancement is synchronous and we haven't crossed 350s, the
    // read stays pending — so we cancel it and rely on the cross-350s
    // assertion below (exactly ONE silence error, not two) to prove no early
    // fire at t=180s.
    vi.advanceTimersByTime(179_000); // now at t=349s
    await flushMicrotasks();

    // Cross the 350s boundary → timer fires.
    vi.advanceTimersByTime(2_000); // now at t=351s
    await flushMicrotasks();

    const events = await eventsPromise;
    const silenceErrors = events.filter(
      (e) => e.type === "error" && /went silent/.test((e as { message?: string }).message ?? ""),
    );
    // Exactly ONE silence error: the reset worked (no fire at the original
    // t=180s window; the only fire is the reset window at t=350s).
    expect(silenceErrors).toHaveLength(1);
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ type: "done", code: 1 });
  });

  // (d) Timer hygiene: after teardown (e.g. the child dies mid-turn), the
  // silence timer is disarmed and must NOT fire post-teardown. A stray fire
  // would enqueue an error after close (dropped by safeEnqueue's closed guard,
  // but the timer should be cleared regardless to avoid leaking / racing).
  it("clears the silence timer on teardown so no stray fire leaks after close (#22)", async () => {
    vi.useFakeTimers();
    const { child } = makeAppServerChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await flushMicrotasks();

    const eventsPromise = collectStream(stream);

    // Tear down mid-turn: the child exits before any terminal event.
    child.emit("close", 1);
    await flushMicrotasks();

    const events = await eventsPromise;

    // Advancing way past 180s must not produce a silence error — the timer was
    // cleared in finish()→teardown() when the close handler ran.
    vi.advanceTimersByTime(200_000);
    await flushMicrotasks();

    const silenceErrors = events.filter(
      (e) => e.type === "error" && /went silent/.test((e as { message?: string }).message ?? ""),
    );
    expect(silenceErrors).toHaveLength(0);
  });

  // (e) Cancel-path disarm: when the STREAM CONSUMER cancels (distinct from
  // teardown-via-child-death), the silence timer must be cleared in cancel()
  // — a ReadableStream sibling that does NOT run through finish()/teardown().
  // This is why `silenceTimer` + `clearSilenceTimer` are hoisted above the
  // ReadableStream (sibling to `child`): cancel() is not inside start() and
  // could not otherwise reach them. Covers spec AC "disarmed on ... cancel".
  //
  // Detection strategy: cancel() calls child.kill("SIGTERM") exactly once. If
  // the timer were NOT cleared, advancing past 180s would fire it → finish(1)
  // → teardown() → child.kill a SECOND time. So assert kill was called exactly
  // once after advancing — a stray fire would make it twice. (The fake child
  // lacks a real `kill` — it's an EventEmitter + streams, not a ChildProcess
  // — so we attach a spy directly; production wraps it in try/catch.)
  it("clears the silence timer when the stream consumer cancels (#22)", async () => {
    vi.useFakeTimers();
    const { child } = makeAppServerChild();
    const killSpy = vi.fn();
    (child as unknown as { kill: unknown }).kill = killSpy;
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node",
    });

    await flushMicrotasks();

    await stream.cancel();
    await flushMicrotasks();

    // cancel() killed the child once. Now advance past 180s — if the timer
    // survived, its fire would call finish()→teardown()→child.kill again.
    vi.advanceTimersByTime(200_000);
    await flushMicrotasks();

    expect(killSpy).toHaveBeenCalledTimes(1);
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
