// @vitest-environment node
//
// This test mocks node:child_process and node:fs and drives real spawn-style
// child plumbing (EventEmitter + PassThrough). The default happy-dom env
// interferes with vi.mock on node: builtins; the node environment is correct
// for a spawn/stdio unit test and matches how cli runs the same seam.
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

const { mockSpawn, existsSyncDelegate, mockMkdtempSync, mockWriteFileSync, mockRmSync, mockPrepareBinding, bindingOkResult } = vi.hoisted(() => {
  return {
    mockSpawn: vi.fn(),
    existsSyncDelegate: vi.fn((p: string) => p === "/bin/sh"),
    // argv-attach (zcode) prompt-delivery seam: the invoke layer mkdtemps a temp dir, writes prompt.md into it, and rmSyncs the dir on every exit
    // path. Mocked so the tests assert the write/cleanup contract without
    // touching the real temp filesystem.
    mockMkdtempSync: vi.fn((prefix: string) => `${prefix}TEST`),
    mockWriteFileSync: vi.fn(),
    mockRmSync: vi.fn(),
    // The per-turn model binding seam. invoke calls ONE function from
    // the protocol package; everything else in that module stays real (the
    // unmocked-export lesson). The ok-result is the shape a real
    // prepared binding returns; refusal tests swap `mockPrepareBinding.mockReturnValue`.
    mockPrepareBinding: vi.fn(),
    bindingOkResult: {
      ok: true as const,
      selection: {
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM-5.2",
        reasoningLevel: "high",
      },
      clonePath: "/tmp/attach/provider-config.clone.json",
      builtinCatalogPath: "/install/resources/config/provider/zcode-builtin.json",
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: mockSpawn };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncDelegate,
    mkdtempSync: mockMkdtempSync,
    writeFileSync: mockWriteFileSync,
    rmSync: mockRmSync,
  };
});

vi.mock("../zcode-model-binding", async () => {
  const actual = await vi.importActual<
    typeof import("../zcode-model-binding")
  >("../zcode-model-binding");
  return { ...actual, prepareZcodeModelBinding: mockPrepareBinding };
});

import { invokeAgent, type InvokeEvent } from "../invoke";

function makeFakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Capture stdin writes so the argv-attach tests can prove the prompt is
  // NOT piped to stdin (it travels in the --attach temp file).
  const stdinWrites: string[] = [];
  const stdin = new Writable({
    write(chunk: unknown, _enc: unknown, cb: () => void) {
      stdinWrites.push(typeof chunk === "string" ? chunk : String(chunk));
      cb();
    },
  });

  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 99999,
  });

  return { child, stdout, stderr, stdin, stdinWrites };
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
 * Script the fake AppImage mount child for the Linux self-mount tests.
 * The real `AppImage --appimage-mount` prints the FUSE mount point to stdout
 * (first line) and stays alive holding the mount. Here the mount point is
 * written on a setTimeout(0) so the helper's stdout listener is attached
 * before the data arrives (matching real async I/O). Pass `write: false` to
 * simulate a mount that never produces a point (timeout / early-exit paths).
 */
function makeMountChild(mountPoint: string, write = true) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 7777,
  });
  if (write) {
    setTimeout(() => { stdout.write(`${mountPoint}\n`); }, 0);
  }
  return { child, stdout, stderr };
}

const BIN_OVERRIDE = "/bin/sh";

// Real NDJSON lines captured from the installed ZCode CLI (3.14.1 desktop
// bundle, zcode 0.16.9) running `-p … --output-format stream-json --mode
// yolo` headless. The adapter's parser and invoke plumbing are pinned against
// these real bytes, not a hand-written sketch — captured from a live probe
// run. Includes the full noise vocabulary observed on a
// single turn: session.titleUpdated / session.resumed / session.updated
// (plugin hook descriptors), turn.started, the model.streaming kinds, the
// turn.completed envelope, and the bare result terminator line.
const ZCODE_STREAM_JSON = String.raw`{"eventId":"ba62ed88-8c55-4431-83ca-32a57b0b2395","payload":{"previousTitle":"","source":"first_input","title":"Reply with exactly the token: PROBE_OK"},"seq":1,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034226,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.titleUpdated"}
{"eventId":"081fe5f4-0d82-493a-be2d-fb69dff0168f","payload":{"directory":"C:\\Users\\Administrator\\Git\\html-anything","interruptedToolCount":0,"messageCount":15,"partCount":31,"recoveredCompactTimelineCount":0,"recoveredSteerInputCount":0,"resumedTodoCount":0},"seq":2,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034228,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.resumed"}
{"eventId":"704f78d3-0c2d-4566-afd8-c94f6f0906c6","payload":{"descriptor":{"clientVisible":true,"commandDisplay":"node \"C:\\Users\\Administrator\\.zcode\\cli\\plugins\\cache\\claude-plugins-official\\vercel\\0.45.1/hooks/session-start-seen-skills.mjs\"","executionMode":"foreground","executionType":"command","pluginId":"vercel@claude-plugins-official","pluginName":"vercel","sourceKind":"plugin","sourcePath":"C:\\Users\\Administrator\\.zcode\\cli\\plugins\\cache\\claude-plugins-official\\vercel\\0.45.1\\hooks\\hooks.json","timeoutMs":60000},"hookEventName":"SessionStart","hookIndex":0,"hookCount":4,"hookInvocationId":"b5547636-0e41-4c9b-b95d-32941f50b6aa","hookRunId":"4699df10-ce5a-42c2-bfde-f7213e1a95a6","hookSource":"plugin.vercel@claude-plugins-official.SessionStart.1.0","matcher":"startup|resume|clear|compact","startedAt":1790039034230},"seq":3,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034230,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.updated"}
{"eventId":"2bf2eb12-0196-4448-9546-fa9bdbbdfd2e","payload":{"executionStartedAt":1790039035583.7253,"turnNumber":7,"input":"Reply with exactly the token: PROBE_OK","messageId":"msg_mubz0vk6_f9084d10-58cb-4fb2-b226-98373bfe8cec","foregroundExecutionId":"runtime_command_1","queryId":"query_cf24b136-0c0f-4afc-a83d-ced3669c001a"},"seq":11,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039035590,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"turn.started"}
{"eventId":"dbd9ae00-db4f-4710-ae4b-c4b66ee1600f","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"","done":false,"kind":"start"},"seq":20,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046426,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"2dee4cce-ca91-4521-95e3-b4b68ceaf5d39","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"","done":false,"kind":"text_start"},"seq":21,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046426,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"d20d9e75-af8b-4d70-8b12-750a98416233","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"PRO","done":false,"kind":"text_delta"},"seq":22,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046427,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"70e217a9-3d1a-49d0-9049-8411f226dff5","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"BE","done":false,"kind":"text_delta"},"seq":23,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046428,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"43884742-953d-4b45-8496-7e5773bc9996","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"_OK","done":false,"kind":"text_delta"},"seq":24,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046428,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"005c69cb-1785-447f-8f42-6ab57ac111a8","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"","done":false,"kind":"text_end"},"seq":25,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046429,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"84413ce1-a3ef-49af-864b-4a81605d8e2f","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":"","done":true,"kind":"finish"},"seq":26,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046429,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}
{"eventId":"af34daea-c765-4083-9fa5-2f88eba64782","payload":{"response":"PROBE_OK","tokenCount":134374,"usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"toolCallCount":0,"historyRoundCount":1,"duration":11229,"resultType":"success","cacheStats":{"totalMessages":23,"cachedMessages":22,"lastCacheHit":true,"cacheReadTokens":64}},"seq":33,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046811,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"turn.completed"}
{"type":"result","sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","response":"PROBE_OK","usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"eventCount":13,"projection":{"status":"idle","turnCount":1,"totalTokenCount":134374,"contextUsed":134374,"contextWindow":200000}}`;

function zcodeLines(): string[] {
  return ZCODE_STREAM_JSON.split("\n").filter((l) => l.trim());
}

describe("invokeAgent — zcode CLI one-shot (argv-attach)", () => {
  beforeEach(() => {
    // resolveZcodeBin() must return the test .cjs so the binArgs sentinel
    // resolves to it (invoke-time substitution). The resolved node driver is
    // an absolute `.exe`-style path, so the spawn takes the DIRECT (no-shell)
    // Windows path — argv passes verbatim on every host platform.
    vi.stubEnv("ZCODE_BIN", "/resolved/zcode.cjs");
    // The host may carry the GUI-inherited provider-config PAIR (running the
    // tests inside a ZCode-spawned terminal exports ZCODE_PERSONAL/_BUILTIN_
    // PROVIDER_CONFIG_FILE to children — the same host pollution the
    // probes hit). Force it ABSENT so the binding-active tests are
    // deterministic on every host; the passthrough test stubs the pair back on.
    delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
    delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/resolved/node.exe" ||
      p === "/resolved/zcode.cjs" ||
      p === "/bin/sh",
    );
    mockSpawn.mockReset();
    mockMkdtempSync.mockClear();
    mockWriteFileSync.mockClear();
    mockRmSync.mockClear();
    // Default happy-path binding (refusal tests override the return).
    mockPrepareBinding.mockReset();
    mockPrepareBinding.mockReturnValue(bindingOkResult);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    existsSyncDelegate.mockImplementation((p: string) => p === "/bin/sh");
  });

  const attachDir = () => mockMkdtempSync.mock.results[0]?.value as string;
  const attachFile = () => path.join(attachDir(), "prompt.md");
  // Fake-timer tests drive start() to completion through microtasks only
  // (process.nextTick is NOT faked) — the same helper the mount describe
  // uses for its 5s-timeout test.
  const flushMicrotasks = async (iterations = 200) => {
    for (let i = 0; i < iterations; i++) {
      await Promise.resolve();
      await new Promise((r) => process.nextTick(r));
    }
  };

  it("spawns `node <cjs> -p <guide> --attach <tmp> --output-format stream-json --mode yolo` and reports start.argv", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stdout.write(`${zcodeLines().join("\n")}\n`);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [spawnBin, spawnArgv, spawnOpts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    // Absolute `.exe` bin → DIRECT spawn on win32 (no cmd.exe), plain spawn
    // elsewhere: argv elements verbatim on every host — spaced install paths
    // survive with no quoting games.
    expect(spawnBin).toBe("/resolved/node.exe");
    expect(spawnOpts.shell ?? false).toBeFalsy();
    // argv[0] is the resolved .cjs (argv[1] of the real process; a bare
    // executable would be rejected by Node as an arg) — never `app-server`.
    expect(spawnArgv[0]).toBe("/resolved/zcode.cjs");
    expect(spawnArgv).not.toContain("app-server");
    const pIdx = spawnArgv.indexOf("-p");
    expect(pIdx).toBe(1);
    // `-p` carries the fixed short guide, NOT the prompt.
    expect(spawnArgv[pIdx + 1]).not.toBe("build it");
    expect(spawnArgv[pIdx + 1]!.length).toBeLessThan(200);
    // The prompt travels as the --attach temp file.
    const aIdx = spawnArgv.indexOf("--attach");
    expect(aIdx).toBeGreaterThan(-1);
    expect(spawnArgv[aIdx + 1]).toBe(attachFile());
    expect(spawnArgv).toEqual(
      expect.arrayContaining(["--output-format", "stream-json", "--mode", "yolo"]),
    );

    const start = events.find((e) => e.type === "start");
    expect(start).toMatchObject({
      type: "start",
      bin: "/resolved/node.exe",
      argv: spawnArgv,
    });
  });

  it("spawns with ELECTRON_RUN_AS_NODE=1 merged into the env", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await eventsPromise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "/resolved/node.exe",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }),
      }),
    );
  });

  // The per-turn model binding: the PAIRED provider-config env vars ride
  // the spawn env (personal → the temp clone, builtin → the catalog file the
  // selection was validated against), and the bound model surfaces as a meta
  // event so the log shows what the turn was pinned to.
  it("delivers the paired ZCODE_*_PROVIDER_CONFIG_FILE env vars + a bound-model meta event", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      model: "GLM-5.2/high",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    const events = await eventsPromise;

    // The binding got the picker id and the attach temp dir (clone lives there).
    expect(mockPrepareBinding).toHaveBeenCalledWith(
      expect.objectContaining({ cjsPath: "/resolved/zcode.cjs", model: "GLM-5.2/high", attachDir: attachDir() }),
    );
    const [, , spawnOpts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(spawnOpts.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(
      bindingOkResult.clonePath,
    );
    expect(spawnOpts.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe(
      bindingOkResult.builtinCatalogPath,
    );
    expect(spawnOpts.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // Bound model meta right after start (ZCode's own stream has no model meta).
    const meta = events.find((e) => e.type === "meta" && e.key === "model");
    expect(meta).toMatchObject({ type: "meta", key: "model", value: "GLM-5.2/high" });
  });

  // Fail-refuse: a broken link in the resolution chain refuses the spawn
  // with the actionable error instead of silently falling back to whatever the
  // CLI would pick on its own.
  it("refuses to spawn when the binding resolution fails (error event, no spawn, temp cleaned)", async () => {
    mockPrepareBinding.mockReturnValue({
      ok: false,
      code: "gui-keys-missing",
      message: "ZCode: no model plan found in the GUI settings. Open ZCode, log in and select a model (e.g. your Coding Plan), then retry.",
    });

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node.exe",
    });

    const events = await collectStream(stream);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("Open ZCode"),
    });
    // The attach temp dir (holding the would-be clone) is cleaned on refusal.
    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), expect.anything());
  });

  // Escape hatch: a user who pre-set BOTH provider-config vars keeps
  // them verbatim (zero-code reroute); the adapter neither overrides them nor
  // prepares its own binding.
  it("passes a user-set env PAIR through untouched and skips its own binding", async () => {
    vi.stubEnv("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "/user/personal.json");
    vi.stubEnv("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "/user/builtin.json");
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await eventsPromise;

    expect(mockPrepareBinding).not.toHaveBeenCalled();
    const [, , spawnOpts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(spawnOpts.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe("/user/personal.json");
    expect(spawnOpts.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe("/user/builtin.json");
  });

  it("bridges the full stream-json surface: deltas, usage/duration/result, session — noise lines produce nothing, usage exactly once", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "hi",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stdout.write(`${ZCODE_STREAM_JSON}\n`);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.map((d) => (d as { text: string }).text)).toEqual(["PRO", "BE", "_OK"]);
    // Noise envelope lines (session.updated hook frames …) and turn.started
    // produce NOTHING — dropped, not forwarded as raw / error events. The
    // meta events are exactly: the bound-model line after start, then
    // turn.completed's usage (snake_case) + duration_ms + resultType, then
    // the result terminator's sessionId. usage appears EXACTLY once — the
    // terminator's duplicate cumulative numbers are never re-emitted.
    expect(events.filter((e) => e.type === "raw")).toEqual([]);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(
      events.filter((e) => e.type === "meta" && e.key !== "model"),
    ).toEqual([
      {
        type: "meta",
        key: "usage",
        value: {
          input_tokens: 134370,
          output_tokens: 4,
          cache_read_input_tokens: 64,
          cache_creation_input_tokens: 0,
        },
      },
      { type: "meta", key: "duration_ms", value: 11229 },
      { type: "meta", key: "result", value: "success" },
      { type: "meta", key: "session", value: "sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2" },
    ]);
    expect(events.filter((e) => e.type === "meta" && e.key === "usage")).toHaveLength(1);
    expect(events[events.length - 1]).toMatchObject({ type: "done", code: 0 });
  });

  it("bridges reasoning_delta to thinking meta and tool phases to status lines + HTML rescue", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "hi",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // Envelope fields (sessionId/turnId/eventId/…) verbatim from the real
    // capture above; the reasoning_delta / tool_call / tool.updated payload
    // shapes are pinned in the ZCode open-source contracts
    // (session.events.ts ModelStreamingPayload / ToolCallResultPayload).
    stdout.write(
      [
        JSON.stringify({ seq: 1, sessionId: "s", type: "model.streaming", payload: { kind: "reasoning_delta", delta: "先想清楚布局" } }),
        JSON.stringify({ seq: 2, sessionId: "s", type: "model.streaming", payload: { kind: "tool_call", toolCallId: "tc_1", toolName: "WebSearch", input: { query: "css" } } }),
        JSON.stringify({ seq: 3, sessionId: "s", type: "tool.updated", payload: { kind: "result", toolCallId: "tc_1", result: { success: true, content: "…" }, duration: 42 } }),
        JSON.stringify({ seq: 4, sessionId: "s", type: "model.streaming", payload: { kind: "tool_call", toolCallId: "tc_2", toolName: "Write", input: { file_path: "C:\\ws\\out.html", content: "<html><body>r</body></html>" } } }),
        JSON.stringify({ seq: 5, sessionId: "s", type: "tool.updated", payload: { kind: "result", toolCallId: "tc_9_unknown", result: { success: true, content: "…" }, duration: 1 } }),
      ].join("\n") + "\n",
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;
    expect(
      events.filter((e) => e.type === "meta" && e.key !== "model"),
    ).toEqual([
      { type: "meta", key: "thinking", value: "先想清楚布局" },
      { type: "meta", key: "status", value: "调用工具 WebSearch" },
      { type: "meta", key: "status", value: "工具 WebSearch 完成" },
    ]);
    // The Write tool's input IS the deliverable — forwarded as a canonical
    // html event (replaces streamed text), not a status line.
    expect(events.filter((e) => e.type === "html")).toEqual([
      { type: "html", text: "<html><body>r</body></html>" },
    ]);
    // The nameless result (no preceding tool_call for tc_9_unknown) emits
    // no status line at all — a bare ✓ with no context is noise.
  });

  it("maps turn.failed to an error event (consumer-side red-error gate fires on it)", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "hi",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    // Verbatim-captured real failure line (diag-fresh-stdout.jsonl):
    // fresh-config turn whose model binding never resolved.
    stdout.write(
      `{"eventId":"d66c6937-6bd7-4f3d-a38a-43d252a1e052","payload":{"error":{"type":"unknown_error","attribution":{"retryable":false},"code":"CONFIGURATION_ERROR","message":"Select a model before continuing","detail":"Model creation failed"},"turnPhase":"model_creation"},"seq":1,"sessionId":"sess_b154be6b-7148-4098-8d80-6f717ce7bdb8","timestamp":1790041331523,"turnId":"turn_28ed2805-a161-450f-a426-9f3182f003bb","type":"turn.failed"}\n`,
    );
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 1);

    const events = await eventsPromise;
    const errors = events.filter((e) => e.type === "error");
    // The stream's own turn.failed error comes first; the exit handling then maps the
    // non-zero exit to a second error right before done.
    expect(errors[0]).toEqual({ type: "error", message: "Select a model before continuing" });
    expect(errors[1]).toMatchObject({
      type: "error",
      message: expect.stringMatching(/exited with code 1/),
    });
  });

  it("writes the full prompt to the attach temp file — not on argv, not on stdin", async () => {
    const { child, stdout, stdinWrites } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "FULL PROMPT BODY",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await eventsPromise;

    expect(mockMkdtempSync).toHaveBeenCalledTimes(1);
    expect(mockWriteFileSync).toHaveBeenCalledWith(attachFile(), "FULL PROMPT BODY", "utf8");
    expect(stdinWrites.join("")).not.toContain("FULL PROMPT BODY");
  });

  it("removes the attach temp dir on normal close", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);
    await eventsPromise;

    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), { recursive: true, force: true });
  });

  it("removes the attach temp dir when the child errors", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    child.emit("error", new Error("spawn ENOENT"));
    await collectStream(stream);

    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), { recursive: true, force: true });
  });

  it("removes the attach temp dir on abort", async () => {
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    const controller = new AbortController();

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
      signal: controller.signal,
    });

    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));

    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), { recursive: true, force: true });
  });

  it("removes the attach temp dir when the consumer cancels the stream", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    await stream.cancel();
    await new Promise((r) => setTimeout(r, 0));

    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), { recursive: true, force: true });
  });

  // ─── Failure & teardown hardening ────────────────────────────────────

  it("errors and tears the turn down after 180s of zero parsed events", async () => {
    vi.useFakeTimers();
    const { child, stdout } = makeFakeChild();
    const killSpy = vi.fn();
    (child as unknown as { kill: unknown }).kill = killSpy;
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await flushMicrotasks();
    // A NOISE line (session.* — parses to zero events) arrives mid-window.
    // It must NOT reset the clock: the watchdog counts PARSED events only.
    vi.advanceTimersByTime(90_000);
    stdout.write(`${zcodeLines()[0]}\n`);
    await flushMicrotasks();
    vi.advanceTimersByTime(90_000); // 180s since the spawn, 90s since the noise
    await flushMicrotasks();

    const events = await collectStream(stream);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message?: string }).message).toMatch(/no stream events for 180s/);
    // Child killed, attach temp dir removed, stream closed — and NO done
    // event: the turn failed, it did not complete.
    expect(killSpy).toHaveBeenCalled();
    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), { recursive: true, force: true });
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets the silence clock on every parsed event", async () => {
    vi.useFakeTimers();
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await flushMicrotasks();
    // t+100s: a PARSED text_delta arrives → the clock restarts from here.
    vi.advanceTimersByTime(100_000);
    stdout.write(
      `{"payload":{"delta":"BE","done":false,"kind":"text_delta"},"seq":1,"type":"model.streaming"}\n`,
    );
    await flushMicrotasks();
    // t+200s (100s since the delta): without the reset the spawn-time timer
    // would have fired at t=180s. The clock restarted → still armed.
    vi.advanceTimersByTime(100_000);
    await flushMicrotasks();
    expect(vi.getTimerCount()).toBe(1);

    // 180s of silence counted from the delta → fires.
    vi.advanceTimersByTime(80_500);
    await flushMicrotasks();

    const events = await collectStream(stream);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message?: string }).message).toMatch(/no stream events for 180s/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm the watchdog for non-zcode agents", async () => {
    vi.useFakeTimers();
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "claude",
      prompt: "p",
      binOverride: "/bin/sh",
    });

    await flushMicrotasks();
    // Never armed for a sibling agent…
    expect(vi.getTimerCount()).toBe(0);

    // …so a full silence window + close produces no watchdog error and the
    // close path still reaches done (historical behavior intact).
    vi.advanceTimersByTime(180_500);
    await flushMicrotasks();
    stdout.end();
    await flushMicrotasks();
    child.emit("close", 0);

    const events = await collectStream(stream);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("never arms the watchdog before the spawn (binding-refusal window)", async () => {
    vi.useFakeTimers();
    mockPrepareBinding.mockReturnValue({ ok: false, message: "no model plan found" });
    const { child } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await flushMicrotasks();

    const events = await collectStream(stream);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled(); // refused before the spawn
    // No orphaned timer survives the refusal.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps a non-zero exit to an error BEFORE done, carrying the stderr essence", async () => {
    const { child, stdout, stderr } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stderr.write("node:internal/modules/cjs/loader:1145\nError: Cannot find module 'zcode.cjs'\n");
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 3);

    const events = await eventsPromise;
    const idxErr = events.findIndex((e) => e.type === "error");
    const idxDone = events.findIndex((e) => e.type === "done");
    expect(idxErr).toBeGreaterThan(-1);
    expect(idxDone).toBeGreaterThan(idxErr);
    const message = (events[idxErr] as { message: string }).message;
    expect(message).toMatch(/exited with code 3/);
    expect(message).toContain("Cannot find module 'zcode.cjs'");
    expect((events[idxDone] as { code: number }).code).toBe(3);
  });

  it("caps the stderr essence carried by the exit error", async () => {
    const { child, stdout, stderr } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);

    stderr.write(`HEAD_MARKER${"x".repeat(3_000)}TAIL_MARKER`);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 1);

    const events = await eventsPromise;
    const errors = events.filter((e) => e.type === "error");
    const message = (errors[0] as { message?: string }).message ?? "";
    expect(message).toContain("TAIL_MARKER");
    expect(message).not.toContain("HEAD_MARKER");
  });

  it("keeps the exit-0 close shape — no exit error", async () => {
    const { child, stdout } = makeFakeChild();
    mockSpawn.mockReturnValue(child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 0));
    const eventsPromise = collectStream(stream);
    stdout.write(`${zcodeLines().join("\n")}\n`);
    stdout.end();
    await new Promise((r) => setImmediate(r));
    child.emit("close", 0);

    const events = await eventsPromise;
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("clears the watchdog on abort — nothing fires after the cancel", async () => {
    vi.useFakeTimers();
    const { child } = makeFakeChild();
    const killSpy = vi.fn();
    (child as unknown as { kill: unknown }).kill = killSpy;
    mockSpawn.mockReturnValue(child);
    const controller = new AbortController();

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
      signal: controller.signal,
    });

    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    // Advancing past the whole silence window must not fire anything: the
    // abort path already killed the child, cleaned the temp dir, and closed
    // the stream.
    vi.advanceTimersByTime(180_500);
    await flushMicrotasks();

    const events = await collectStream(stream);
    expect(events.filter((e) => e.type === "error")).toEqual([]);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(killSpy).toHaveBeenCalled();
    expect(mockRmSync).toHaveBeenCalledWith(attachDir(), { recursive: true, force: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("invokeAgent — Linux AppImage self-mount (CLI one-shot form)", () => {
  const mountCjs = (mp: string) => `${mp}/resources/glm/zcode.cjs`;
  const REAL_PLATFORM = process.platform;
  const flushMicrotasks = async (iterations = 200) => {
    for (let i = 0; i < iterations; i++) {
      await Promise.resolve();
      await new Promise((r) => process.nextTick(r));
    }
  };

  beforeEach(() => {
    mockSpawn.mockReset();
    mockMkdtempSync.mockClear();
    mockWriteFileSync.mockClear();
    mockRmSync.mockClear();
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/opt/ZCode.AppImage" ||
      p === "/resolved/node.exe" ||
      p === "/bin/sh",
    );
    vi.stubEnv("ZCODE_BIN", "/opt/ZCode.AppImage");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
    existsSyncDelegate.mockImplementation((p: string) => p === "/bin/sh");
  });

  const isMountSpawn = (argv: string[]) => argv.includes("--appimage-mount");

  // (1) The mount child is spawned BEFORE the CLI child, and the CLI argv
  // carries the mount-point cjs path (not the AppImage path).
  it("mounts the AppImage before spawning the CLI; cjs argv is the mount-point path", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mountPoint = "/tmp/.mount_ZCode-xxxx";
    const mount = makeMountChild(mountPoint);
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node.exe",
    });

    // Let the mount resolve (setTimeout(0) write + microtasks + CLI spawn).
    await new Promise((r) => setTimeout(r, 50));
    const eventsPromise = collectStream(stream);

    app.stdout.write(`${zcodeLines().join("\n")}\n`);
    app.stdout.end();
    await new Promise((r) => setImmediate(r));
    app.child.emit("close", 0);
    await eventsPromise;

    // Two spawns: mount first, CLI second.
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const [mountCall, appCall] = mockSpawn.mock.calls as unknown as [string, string[]][];
    expect(mountCall[0]).toBe("/opt/ZCode.AppImage");
    expect(mountCall[1]).toEqual(["--appimage-mount"]);
    expect(appCall[0]).toBe("/resolved/node.exe");
    // CLI argv: mount-point cjs in argv[0], the one-shot flags — and no
    // `app-server` subcommand anywhere.
    expect(appCall[1][0]).toBe(mountCjs(mountPoint));
    expect(appCall[1]).not.toContain("app-server");
    expect(appCall[1]).toEqual(
      expect.arrayContaining(["-p", "--attach", "--output-format", "stream-json", "--mode", "yolo"]),
    );
  });

  // (2) The start event reports the mount-point cjs argv (proves the cjs path
  // flows through to the caller, not just the spawn).
  it("reports the mount-point cjs path in the start event argv", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mountPoint = "/tmp/.mount_ZCode-yyyy";
    const mount = makeMountChild(mountPoint);
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 50));
    const eventsPromise = collectStream(stream);
    app.stdout.write(`${zcodeLines().join("\n")}\n`);
    app.stdout.end();
    await new Promise((r) => setImmediate(r));
    app.child.emit("close", 0);

    const events = await eventsPromise;
    const startEv = events.find((e) => e.type === "start");
    expect(startEv).toMatchObject({
      type: "start",
      bin: "/resolved/node.exe",
    });
    expect((startEv as { argv: string[] }).argv[0]).toBe(mountCjs(mountPoint));
  });

  // (3) When the CLI child dies mid-turn, teardown kills the mount child
  // too (per-turn mount+unmount — no leak across turns).
  it("kills the mount child when the CLI child dies mid-turn", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mount = makeMountChild("/tmp/.mount_ZCode-zzz");
    const mountKillSpy = vi.fn();
    (mount.child as unknown as { kill: unknown }).kill = mountKillSpy;
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 50));
    const eventsPromise = collectStream(stream);

    // CLI child dies → the close handler's cleanup kills the mount holder.
    app.child.emit("close", 1);
    await eventsPromise;

    expect(mountKillSpy).toHaveBeenCalled();
  });

  // (4) When the stream consumer cancels, cancel() — a ReadableStream sibling
  // of start() — kills the mount child (it can't reach start()'s locals).
  it("kills the mount child when the stream consumer cancels", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mount = makeMountChild("/tmp/.mount_ZCode-cancel");
    const mountKillSpy = vi.fn();
    (mount.child as unknown as { kill: unknown }).kill = mountKillSpy;
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 50));
    await stream.cancel();
    await new Promise((r) => setTimeout(r, 10));

    expect(mountKillSpy).toHaveBeenCalled();
  });

  // (5) A mount child that exits non-zero (FUSE missing / corrupt AppImage)
  // produces a clear error event and never spawns the CLI child.
  it("emits a clear error and never spawns the CLI when the mount child exits non-zero", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mount = makeMountChild("/never/printed", false);
    const mountKillSpy = vi.fn();
    (mount.child as unknown as { kill: unknown }).kill = mountKillSpy;
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 10));
    // Mount child exits with an error before printing a mount point.
    mount.child.emit("close", 1);
    await new Promise((r) => setTimeout(r, 10));

    const events = await collectStream(stream);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { message?: string }).message).toMatch(/mount/i);
    // Only the mount child was spawned — the CLI never reached.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    // Mount child was cleaned up on the failure path.
    expect(mountKillSpy).toHaveBeenCalled();
  });

  // (6) Mount setup has a bounded ~5s timeout . A mount that never
  // prints a point fires the timeout, emits a clear error, and cleans up.
  it("fires a clear error after the 5s mount timeout and cleans up the mount child", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mount = makeMountChild("/never/printed", false);
    const mountKillSpy = vi.fn();
    (mount.child as unknown as { kill: unknown }).kill = mountKillSpy;
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
    });

    // Drive start() to the mount await (spawn done, listeners attached, 5s
    // timer armed). No stdout → the await blocks until the timer fires.
    await flushMicrotasks();
    vi.advanceTimersByTime(5_500);
    await flushMicrotasks();

    const events = await collectStream(stream);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { message?: string }).message).toMatch(/mount timed out/i);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mountKillSpy).toHaveBeenCalled();
  });

  // (7) An abort during the mount window (before the outer onAbort is
  // registered) is honored by the signal wired into mountZcodeAppImage: the
  // mount child is killed and a clear error surfaces, without waiting for the
  // 5s timeout.
  it("honors an abort during the mount window (signal wired into the mount helper)", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const mount = makeMountChild("/never/printed", false);
    const mountKillSpy = vi.fn();
    (mount.child as unknown as { kill: unknown }).kill = mountKillSpy;
    const app = makeFakeChild();
    mockSpawn.mockImplementation((_bin: string, argv: string[]) =>
      isMountSpawn(argv) ? mount.child : app.child,
    );

    const controller = new AbortController();
    const stream = invokeAgent({
      agent: "zcode",
      prompt: "p",
      binOverride: "/resolved/node.exe",
      signal: controller.signal,
    });

    // Abort during the mount window (mount child never prints a point).
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));

    const events = await collectStream(stream);
    const errors = events.filter((e) => e.type === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mountKillSpy).toHaveBeenCalled();
  });

  // resolveZcodeBin() honours a ZCODE_BIN that
  // points directly at the zcode.cjs bundle (the detect tests set
  // ZCODE_BIN=<…>.cjs and assert available=true). For a `.cjs` the AppImage
  // self-mount would spawn `<.cjs> --appimage-mount` and fail — a JS bundle is
  // not an executable AppImage. So on Linux the `.cjs` is used directly:
  // exactly ONE spawn (the CLI child), argv carries the override in argv[0],
  // and no spawn argv contains `--appimage-mount`.
  it("uses a ZCODE_BIN .cjs override directly on Linux — no AppImage mount", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.stubEnv("ZCODE_BIN", "/opt/zcode/override.cjs");
    existsSyncDelegate.mockImplementation((p: string) =>
      p === "/opt/zcode/override.cjs" ||
      p === "/resolved/node.exe" ||
      p === "/bin/sh",
    );
    const app = makeFakeChild();
    mockSpawn.mockReturnValue(app.child);

    const stream = invokeAgent({
      agent: "zcode",
      prompt: "build it",
      binOverride: "/resolved/node.exe",
    });

    await new Promise((r) => setTimeout(r, 50));
    const eventsPromise = collectStream(stream);

    app.stdout.write(`${zcodeLines().join("\n")}\n`);
    app.stdout.end();
    await new Promise((r) => setImmediate(r));
    app.child.emit("close", 0);

    const events = await eventsPromise;

    // Exactly ONE spawn — the CLI child. No mount child is spawned.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const calls = mockSpawn.mock.calls as unknown as [string, string[]][];
    const [appCall] = calls;
    expect(appCall[0]).toBe("/resolved/node.exe");
    // argv uses the .cjs override verbatim — NOT a `<mount>/resources/glm/...` path.
    expect(appCall[1][0]).toBe("/opt/zcode/override.cjs");
    // No spawn argv contains `--appimage-mount` (the mount flow never ran).
    for (const [, argv] of calls) {
      expect(argv).not.toContain("--appimage-mount");
    }
    // The .cjs override propagates to the start event too.
    const startEv = events.find((e) => e.type === "start");
    expect((startEv as { argv: string[] }).argv[0]).toBe("/opt/zcode/override.cjs");
  });
});


// Regression guards for the argv branch — keep parity with the behavior from
// before the argv-attach routing landed, so it doesn't disturb existing
// adapters.
describe("invokeAgent — argv branch (regression)", () => {
  // Isolate from the zcode describes above: those blocks legitimately call
  // spawn and its beforeEach reset is scoped to its own tests. Reset the mock
  // here too so the call-count assertion below counts only this block's spawn.
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // Per-element quoting applies only to zcode's shell-fallback corner. The
  // shared argv spawn (every argv / argv-message agent — deepseek-tui,
  // openclaw) must pass argv verbatim, matching the `main` baseline. This pins
  // that guarantee on a win32-mocked host: no argv element gains quotes.
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
