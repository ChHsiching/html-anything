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

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

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

import { invokeAgent, type InvokeEvent } from "../agents-invoke.js";

// win32 spawn goes through cmd.exe (shell:true), so the bin and each argv
// element are double-quoted to survive cmd.exe's whitespace split — the same
// discipline as next/src/lib/agents/__tests__/invoke.test.ts. Tests that assert
// the exact spawn args use this to expect the quoted form on Windows.
const USE_SHELL = process.platform === "win32";

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

  // #17: quoteWindowsArg is gated to the app-server (ZCode) branch only. The
  // shared argv spawn must pass argv verbatim, matching the `main` baseline.
  // cli's shared branch was already bare (T8 only touched next's), so this
  // pins that correctness against future regressions. Mirrors next's #17 case.
  describe("argv branch — no per-element quoting (#17)", () => {
    it("argv-protocol agent (deepseek-tui) spawns with bare argv elements on win32 — no per-element quoting", async () => {
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
        // quotes (the `main` baseline).
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        const call = mockSpawn.mock.calls[0];
        const spawnedArgv = call[1] as string[];
        for (const el of spawnedArgv) {
          expect(el.startsWith('"')).toBe(false);
          expect(el.endsWith('"')).toBe(false);
        }
        expect(spawnedArgv).toEqual(
          expect.arrayContaining(["exec", "--auto", "make a page"]),
        );
        expect(call[2]).toMatchObject({ shell: true });
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      }
    });
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
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      existsSyncDelegate.mockImplementation((p: string) => p === "/bin/sh");
    });

    /**
     * Script the fake app-server child: auto-respond to each JSON-RPC request
     * method on stdin with a canned result on stdout. Records every request
     * method seen on the wire so the relay-absence test (#13) can assert that
     * no provider/workspace relay method is sent. Returns the child so the
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

      // Every request method seen on the wire, in order.
      const sentMethods: string[] = [];
      // Every parsed request frame seen on the wire, in order: { id, method, params }.
      // Captures the full params so the #19 model-threading tests can assert what
      // session/create carries (model present vs absent).
      const sentFrames: { id?: string; method?: string; params?: Record<string, unknown> }[] = [];

      // Tap stdin to auto-respond. The protocol client writes one JSON object
      // per line; we parse and reply on stdout.
      const origWrite = stdin.write.bind(stdin);
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

      return { child, stdout, stderr, stdin, origWrite, sentMethods, sentFrames };
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

      // spawn called with bin + binArgs (no prompt on argv). On win32 the bin
      // and argv elements are quoted for cmd.exe (the T12-resolved Electron-exe
      // path and the resolved zcode.cjs both contain spaces); on POSIX they're
      // passed raw.
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

    // ADR-0004 + #14 (live-probe-corrected): the app-server child self-auths
    // the LOGIN, but a fresh session/create needs the workspace model
    // configured first (#13 wrongly deleted this relay on the unverified
    // assumption the child self-resolves the model; #14 live probes disproved
    // that). So the adapter runs the once-per-boot model relay
    // (upsertModelProvider → setDefaultModel) BEFORE the turn. This pins the
    // full wire sequence including the relay, and the provider object shape.
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
      // No session frames sent — the relay failed fast before the turn.
    });

    // T12 (#12): external-process node resolution. On a clean host `where node`
    // finds nothing — only the ZCode Electron executable exists. When no
    // binOverride is passed and no system `node` is on PATH, the app-server
    // branch must resolve the bin via resolveZcodeNodeBin() (which discovers the
    // Electron exe), NOT fail with "not installed". ZCODE_BIN stays scoped to
    // the .cjs (it must NOT be overloaded as the node bin) — see the
    // reconciliation note in resolveZcodeNodeBin's doc comment.
    it("falls back to the ZCode Electron exe when node is not on PATH (T12)", async () => {
      const { child, stdout } = makeAppServerChild();
      mockSpawn.mockReturnValue(child);
      // No binOverride. existsSync admits the .cjs + the Electron exe only —
      // resolveZcodeNodeBin() must surface the exe as the spawn bin.
      existsSyncDelegate.mockImplementation((p: string) =>
        p === "/resolved/zcode.cjs" ||
        p === "C:\\Program Files\\ZCode\\ZCode.exe" ||
        p === "/bin/sh",
      );
      vi.stubEnv("ZCODE_WINDOWS_APP_INSTALL_DIR", "C:\\Program Files\\ZCode");
      // Force the platform to win32 so the Electron-exe fallback path is probed.
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
      // (quoted on win32 — the path contains a space). argv is quoted too but
      // we only assert the bin + env here.
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
      // model is the picked modelId + the providerId the resolver recovered
      // from the dynamic picker list.
      expect(create!.params).toMatchObject({
        workspace: expect.any(Object),
        model: { providerId: "builtin:bigmodel-coding-plan", modelId: "GLM-5-Turbo" },
      });
    });

    // #19: the default model pick (or absent) carries NO model field — the
    // workspace default (provisioned by the once-per-boot relay) applies.
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
    // defaultProviderId is the coding-plan, so the create frame must bind to it.
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
});
