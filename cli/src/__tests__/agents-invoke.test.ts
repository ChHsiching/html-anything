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

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncDelegate };
});

vi.mock("@html-anything/zcode-protocol/zcode-config", () => ({
  readZcodeConfig: mockReadZcodeConfig,
}));

import { invokeAgent, type InvokeEvent } from "../agents-invoke.js";

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

async function driveInvoke(
  opts: Parameters<typeof invokeAgent>[0],
  stdoutContent: string | null,
  exitCode: number | null = 0,
): Promise<InvokeEvent[]> {
  const { child, stdout } = makeFakeChild();
  mockSpawn.mockReturnValue(child);

  const stream = invokeAgent(opts);

  await new Promise((r) => setTimeout(r, 0));

  const eventsPromise = collectStream(stream);

  if (stdoutContent != null) {
    stdout.write(stdoutContent);
  }
  stdout.end();

  await new Promise((r) => setImmediate(r));
  child.emit("close", exitCode);

  return eventsPromise;
}

const BIN_OVERRIDE = "/bin/sh";

describe("invokeAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("error cases", () => {
    it("returns error stream for unknown agent", async () => {
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

    it("returns error stream when binOverride points to missing file", async () => {
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

    it("returns error stream for unsupported (acp) agent protocol", async () => {
      const stream = invokeAgent({
        agent: "hermes",
        prompt: "test",
        binOverride: BIN_OVERRIDE,
      });

      const events = await collectStream(stream);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "error",
        message: expect.stringContaining("not yet wired up"),
      });
    });
  });

  describe("relative binOverride resolution", () => {
    it("resolves ./mock-agent via path.resolve + existsSync", async () => {
      existsSyncDelegate.mockImplementation((p: string) => {
        if (p.endsWith("/mock-agent")) return true;
        return p === "/bin/sh";
      });

      const html = "<html><body>ok</body></html>";
      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "test", binOverride: "./mock-agent" },
        html,
        0,
      );

      const start = events.find((e) => e.type === "start");
      expect(start).toBeDefined();
      expect(start).toMatchObject({
        type: "start",
        bin: expect.stringContaining("/mock-agent"),
      });
    });

    it("resolves ../bin/claude wrapper relative path", async () => {
      existsSyncDelegate.mockImplementation((p: string) => {
        if (p.endsWith("/bin/claude")) return true;
        return p === "/bin/sh";
      });

      const html = "<html><body>ok</body></html>";
      const events = await driveInvoke(
        { agent: "claude", prompt: "test", binOverride: "../bin/claude" },
        html,
        0,
      );

      const start = events.find((e) => e.type === "start");
      expect(start).toBeDefined();
      expect(start).toMatchObject({
        type: "start",
        bin: expect.stringContaining("/bin/claude"),
      });
    });
  });

  describe("close-path: codewhale, deepseek-tui and aider agents", () => {
    it("deepseek-tui: enqueues remaining stdoutBuf as single delta on close (HTML, no trailing newline)", async () => {
      const html = "<html><body>hello</body></html>";

      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "make a page", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: html });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });

      const start = events.filter((e) => e.type === "start");
      expect(start).toHaveLength(1);
      expect(events).toHaveLength(3);
    });

    it("deepseek-tui: produces only ONE delta for partial line after complete lines", async () => {
      const content = "line1\nline2";

      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "make a page", binOverride: BIN_OVERRIDE },
        content,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toMatchObject({ type: "delta", text: "line1\n" });
      expect(deltas[1]).toMatchObject({ type: "delta", text: "line2" });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });
    });

    it("deepseek-tui: no residual on close when line ends with newline (no double-enqueue)", async () => {
      const content = "hello\n";

      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "make a page", binOverride: BIN_OVERRIDE },
        content,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: "hello\n" });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });
    });

    it("codewhale: enqueues remaining stdoutBuf as single delta on close (HTML, no trailing newline)", async () => {
      const html = "<html><body>hello from codewhale</body></html>";

      const events = await driveInvoke(
        { agent: "codewhale", prompt: "make a page", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: html });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });
    });

    it("aider: enqueues remaining stdoutBuf as single delta on close (HTML, no trailing newline)", async () => {
      const html = "<html><body>hello from aider</body></html>";

      const events = await driveInvoke(
        { agent: "aider", prompt: "make a page", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: html });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });

      expect(events).toHaveLength(3);
    });

    it("aider: does NOT double-enqueue partial line after complete lines", async () => {
      const content = "aider-line\npartial";

      const events = await driveInvoke(
        { agent: "aider", prompt: "test", binOverride: BIN_OVERRIDE },
        content,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");

      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toMatchObject({ type: "delta", text: "aider-line\n" });
      expect(deltas[1]).toMatchObject({ type: "delta", text: "partial" });
    });
  });

  describe("close-path: non-deepseek-tui/aider agents", () => {
    it("codex: parses remaining stdoutBuf on close (valid JSON delta)", async () => {
      const json = '{"type":"item.delta","text":"parsed on close"}';

      const events = await driveInvoke(
        { agent: "codex", prompt: "test", binOverride: BIN_OVERRIDE },
        json,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: "parsed on close" });
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });
    });

    it("codex: HTML content on close is not JSON-parsed (skipped)", async () => {
      const html = "<html><body>not json</body></html>";

      const events = await driveInvoke(
        { agent: "codex", prompt: "test", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      const done = events.filter((e) => e.type === "done");

      expect(deltas).toHaveLength(0);
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ type: "done", code: 0 });
    });

    it("claude: parses remaining stdoutBuf on close (result usage meta)", async () => {
      const json = '{"type":"result","usage":{"input_tokens":10,"output_tokens":20}}';

      const events = await driveInvoke(
        { agent: "claude", prompt: "test", binOverride: BIN_OVERRIDE },
        json,
        0,
      );

      const metas = events.filter((e) => e.type === "meta");
      const done = events.filter((e) => e.type === "done");

      const usageMeta = metas.find(
        (e) => e.type === "meta" && e.key === "usage",
      );
      expect(usageMeta).toBeDefined();
      expect(done).toHaveLength(1);
    });
  });

  describe("exit code propagation", () => {
    it("done event reflects exit code 0", async () => {
      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "test", binOverride: BIN_OVERRIDE },
        "ok",
        0,
      );

      const done = events.find((e) => e.type === "done");
      expect(done).toMatchObject({ type: "done", code: 0 });
    });

    it("done event reflects exit code 1", async () => {
      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "test", binOverride: BIN_OVERRIDE },
        "fail",
        1,
      );

      const done = events.find((e) => e.type === "done");
      expect(done).toMatchObject({ type: "done", code: 1 });
    });

    it("done event with null code (signal exit)", async () => {
      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "test", binOverride: BIN_OVERRIDE },
        "killed",
        null,
      );

      const done = events.find((e) => e.type === "done");
      expect(done).toMatchObject({ type: "done", code: null });
    });
  });

  describe("child process error", () => {
    it("produces error event when child emits error", async () => {
      const { child, stdout } = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const stream = invokeAgent({
        agent: "deepseek-tui",
        prompt: "test",
        binOverride: BIN_OVERRIDE,
      });

      await new Promise((r) => setTimeout(r, 0));

      const eventsPromise = collectStream(stream);

      stdout.end();
      await new Promise((r) => setImmediate(r));
      child.emit("error", new Error("spawn ENOENT"));

      const events = await eventsPromise;

      const errors = events.filter((e) => e.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        type: "error",
        message: "spawn ENOENT",
      });
    });
  });

  describe("stderr propagation", () => {
    it("produces stderr events for stderr output", async () => {
      const { child, stdout, stderr } = makeFakeChild();
      mockSpawn.mockReturnValue(child);

      const stream = invokeAgent({
        agent: "deepseek-tui",
        prompt: "test",
        binOverride: BIN_OVERRIDE,
      });

      await new Promise((r) => setTimeout(r, 0));

      const eventsPromise = collectStream(stream);

      stderr.write("warning: deprecated\n");
      stdout.end();
      await new Promise((r) => setImmediate(r));
      child.emit("close", 0);

      const events = await eventsPromise;

      const stderrEvents = events.filter((e) => e.type === "stderr");
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      expect(stderrEvents[0]).toMatchObject({
        type: "stderr",
        text: "warning: deprecated\n",
      });
    });
  });

  describe("start event", () => {
    it("includes bin, argv, and promptBytes", async () => {
      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "hello world", binOverride: BIN_OVERRIDE },
        null,
        0,
      );

      const start = events.find((e) => e.type === "start");
      expect(start).toBeDefined();
      if (start && start.type === "start") {
        expect(start.bin).toBe(BIN_OVERRIDE);
        expect(start.argv).toEqual(
          expect.arrayContaining(["exec", "--auto"]),
        );
        expect(start.promptBytes).toBe(
          Buffer.byteLength("hello world", "utf8"),
        );
      }
    });
  });

  describe("deepseek-tui vs non-deepseek-tui close-path distinction", () => {
    it("deepseek-tui close-path bypasses parse() entirely — HTML not double-parsed", async () => {
      const html = "<html><body>distinct</body></html>";

      const events = await driveInvoke(
        { agent: "deepseek-tui", prompt: "test", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: html });

      const raws = events.filter((e) => e.type === "raw");
      expect(raws).toHaveLength(0);

      const htmls = events.filter((e) => e.type === "html");
      expect(htmls).toHaveLength(0);
    });

    it("codewhale close-path bypasses parse() entirely — HTML not double-parsed", async () => {
      const html = "<html><body>codewhale-distinct</body></html>";

      const events = await driveInvoke(
        { agent: "codewhale", prompt: "test", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: html });

      const raws = events.filter((e) => e.type === "raw");
      expect(raws).toHaveLength(0);

      const htmls = events.filter((e) => e.type === "html");
      expect(htmls).toHaveLength(0);
    });

    it("aider close-path bypasses parse() entirely — HTML not double-parsed", async () => {
      const html = "<html><body>aider-distinct</body></html>";

      const events = await driveInvoke(
        { agent: "aider", prompt: "test", binOverride: BIN_OVERRIDE },
        html,
        0,
      );

      const deltas = events.filter((e) => e.type === "delta");
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ type: "delta", text: html });

      const raws = events.filter((e) => e.type === "raw");
      expect(raws).toHaveLength(0);

      const htmls = events.filter((e) => e.type === "html");
      expect(htmls).toHaveLength(0);
    });

  });

  // ─── app-server protocol branch (ZCode) ──────────────────────────────
  //
  // Drives `invokeAgent` end-to-end for the registered `protocol: "app-server"`
  // agent (T7). The AgentDef's binArgs carry the `<resolved-zcode-cjs>`
  // sentinel; invoke-time substitution (T7) fills it from resolveZcodeBin(),
  // which honours ZCODE_BIN — stubbed here to `/resolved/zcode.cjs` so the
  // spawn runs `node /resolved/zcode.cjs app-server` without depending on a
  // real install. spawn is mocked, the fake child's stdin is scripted to
  // auto-respond to the 6-method JSON-RPC turn, and notifications are emitted
  // on stdout. We collect the resulting InvokeEvent[] and assert delta/done/error.
  describe("app-server protocol branch (ZCode)", () => {
    beforeEach(() => {
      // Make resolveZcodeBin() return the test .cjs path so the binArgs
      // sentinel resolves to it (T7 invoke-time substitution).
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
      vi.unstubAllEnvs();
      existsSyncDelegate.mockImplementation((p: string) => p === "/bin/sh");
    });

    /**
     * Script the fake app-server child: auto-respond to each JSON-RPC request
     * method on stdin with a canned result on stdout. Returns the child so the
     * caller can emit notifications / close afterwards.
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
      const origWrite = stdin.write.bind(stdin);
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

      return { child, stdout, stderr, stdin, origWrite };
    }

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

      // spawn called with bin + binArgs (no prompt on argv).
      expect(mockSpawn).toHaveBeenCalledWith(
        "/resolved/node",
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

    // ADR-0004 / T9: without ELECTRON_RUN_AS_NODE=1 the zcode.cjs child hangs
    // at Electron-component init. The env must be merged INTO envFor(...) (so
    // the rest of the process env survives), not replace it. spawn is mocked,
    // so this pins the fact without a real server.
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
        "/resolved/node",
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
      const origWrite = child.stdin.write.bind(child.stdin);
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
      (mockReadZcodeConfig as unknown as { mockReturnValueOnce(v: unknown): unknown }).mockReturnValueOnce(
        null,
      );

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
});
