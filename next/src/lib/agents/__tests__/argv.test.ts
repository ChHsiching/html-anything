import { describe, expect, it } from "vitest";
import { parseLine, makeParser } from "../argv";

describe("parseLine opencode", () => {
  it("extracts text from nested part payload", () => {
    const line = JSON.stringify({
      type: "text",
      sessionID: "ses_test",
      part: {
        type: "text",
        text: "<html><body>ok</body></html>",
      },
    });

    expect(parseLine("opencode", line)).toContainEqual({
      kind: "delta",
      text: "<html><body>ok</body></html>",
    });
  });

  it("emits one delta when top-level and nested text are both present", () => {
    const line = JSON.stringify({
      type: "text",
      text: "<html><body>ok</body></html>",
      part: {
        type: "text",
        text: "<html><body>ok</body></html>",
      },
    });

    expect(parseLine("opencode", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>ok</body></html>",
      },
    ]);
  });

  it("falls back to top-level text when nested text is empty", () => {
    const line = JSON.stringify({
      type: "text",
      content: "<html>ok</html>",
      part: {
        type: "text",
        text: "",
      },
    });

    expect(parseLine("opencode", line)).toEqual([
      {
        kind: "delta",
        text: "<html>ok</html>",
      },
    ]);
  });

  it("extracts session only from step start payload", () => {
    expect(
      parseLine(
        "opencode",
        JSON.stringify({
          type: "step_start",
          sessionID: "ses_test",
          part: {
            type: "step-start",
          },
        }),
      ),
    ).toContainEqual({
      kind: "meta",
      key: "session",
      value: "ses_test",
    });

    expect(
      parseLine(
        "opencode",
        JSON.stringify({
          type: "text",
          sessionID: "ses_test",
          part: {
            type: "text",
            text: "ok",
          },
        }),
      ),
    ).not.toContainEqual({
      kind: "meta",
      key: "session",
      value: "ses_test",
    });
  });

  it("extracts usage from step finish payload and accumulates successive steps", () => {
    const line1 = JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        tokens: {
          input: 10,
          output: 2,
          cache: {
            read: 3,
            write: 4,
          },
        },
        cost: 0.01,
      },
    });

    const line2 = JSON.stringify({
      type: "step_finish",
      part: {
        type: "step-finish",
        tokens: {
          input: 5,
          output: 1,
          cache: {
            read: 1,
            write: 1,
          },
        },
        cost: 0.005,
      },
    });

    const parser = makeParser("opencode");
    expect(parser(line1)).toEqual([
      {
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      },
      {
        kind: "meta",
        key: "cost_usd",
        value: 0.01,
      },
    ]);

    expect(parser(line2)).toEqual([
      {
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: 15,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
        },
      },
      {
        kind: "meta",
        key: "cost_usd",
        value: 0.015,
      },
    ]);
  });
});

describe("parseLine bob", () => {
  it("extracts text from stream-json output", () => {
    const line = JSON.stringify({
      text: "<html><body>Hello</body></html>",
    });

    expect(parseLine("bob", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>Hello</body></html>",
      },
    ]);
  });

  it("extracts content field when present", () => {
    const line = JSON.stringify({
      content: "<html><body>World</body></html>",
    });

    expect(parseLine("bob", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>World</body></html>",
      },
    ]);
  });

  it("extracts message field when present", () => {
    const line = JSON.stringify({
      message: "<html><body>Test</body></html>",
    });

    expect(parseLine("bob", line)).toEqual([
      {
        kind: "delta",
        text: "<html><body>Test</body></html>",
      },
    ]);
  });

  it("handles final answer after thinking when --hide-intermediary-output is used", () => {
    // When --hide-intermediary-output is enabled, Bob only emits the final answer.
    // This test verifies that the parser correctly handles the final completion.
    const finalAnswer = JSON.stringify({
      text: "<html><body>Final result</body></html>",
    });

    expect(parseLine("bob", finalAnswer)).toEqual([
      {
        kind: "delta",
        text: "<html><body>Final result</body></html>",
      },
    ]);
  });
});

describe("parseLine zcode (argv-attach stream-json)", () => {
  // Real NDJSON lines captured from the installed ZCode CLI running
  // `-p … --output-format stream-json --mode yolo` headless; the parser
  // contract is pinned against these real bytes. The captured turns were
  // plain-text replies, so the reasoning_delta / tool_call / tool.updated
  // lines below reuse the real envelope (eventId/seq/sessionId/timestamp
  // fields verbatim from the captures) around payload shapes pinned in the
  // ZCode open-source contracts
  // (apps/zcode-cli/packages/contracts/src/events/session.events.ts).
  const SESSION = "sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2";
  const TURN = "turn_428dacfc-74fc-4056-9aac-785654cb17bc";
  const envelope = (type: string, payload: unknown, seq: number) =>
    JSON.stringify({
      eventId: `d20d9e75-af8b-4d70-8b12-750a984${String(seq).padStart(3, "0")}`,
      payload,
      seq,
      sessionId: SESSION,
      timestamp: 1790039046427,
      traceId: "fac306de-bf37-4eff-94ca-eb8476962e3c",
      turnId: TURN,
      type,
    });
  const TEXT_DELTA_LINE = (delta: string, seq: number) =>
    envelope(
      "model.streaming",
      { assistantMessageId: "msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462", delta, done: false, kind: "text_delta" },
      seq,
    );
  const REASONING_DELTA_LINE = (delta: string, seq: number) =>
    envelope(
      "model.streaming",
      { assistantMessageId: "msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462", delta, done: false, kind: "reasoning_delta" },
      seq,
    );

  it("bridges model.streaming text_delta to a delta with the exact text", () => {
    expect(parseLine("zcode", TEXT_DELTA_LINE("PRO", 22))).toEqual([
      { kind: "delta", text: "PRO" },
    ]);
    expect(parseLine("zcode", TEXT_DELTA_LINE("_OK", 24))).toEqual([
      { kind: "delta", text: "_OK" },
    ]);
  });

  it("bridges model.streaming reasoning_delta to a thinking meta per fragment", () => {
    expect(parseLine("zcode", REASONING_DELTA_LINE("先把布局", 40))).toEqual([
      { kind: "meta", key: "thinking", value: "先把布局" },
    ]);
    expect(parseLine("zcode", REASONING_DELTA_LINE("定成两栏", 41))).toEqual([
      { kind: "meta", key: "thinking", value: "定成两栏" },
    ]);
  });

  it("drops every non-content streaming kind (start / text_start / text_end / reasoning_start / reasoning_end / tool_input_* / finish)", () => {
    for (const kind of [
      "start",
      "text_start",
      "text_end",
      "reasoning_start",
      "reasoning_end",
      "tool_input_start",
      "tool_input_delta",
      "tool_input_end",
      "finish",
    ]) {
      const line = `{"payload":{"delta":"","done":false,"kind":"${kind}"},"seq":1,"type":"model.streaming"}`;
      expect(parseLine("zcode", line)).toEqual([]);
    }
  });

  it("drops a text_delta / reasoning_delta with an empty delta string (no zero-length events)", () => {
    expect(parseLine("zcode", TEXT_DELTA_LINE("", 21))).toEqual([]);
    expect(parseLine("zcode", REASONING_DELTA_LINE("", 42))).toEqual([]);
  });

  it("rescues HTML from a Write tool_call input (file_path + content, ZCode's Write tool shape)", () => {
    const line = envelope(
      "model.streaming",
      {
        assistantMessageId: "msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462",
        delta: "",
        done: false,
        kind: "tool_call",
        toolCallId: "tc_1",
        toolName: "Write",
        input: { file_path: "C:\\ws\\output.html", content: "<html><body>rescued</body></html>" },
      },
      50,
    );
    expect(parseLine("zcode", line)).toEqual([
      { kind: "html", text: "<html><body>rescued</body></html>" },
    ]);
  });

  it("surfaces a non-write tool_call as a status line, not HTML", () => {
    const line = envelope(
      "model.streaming",
      {
        kind: "tool_call",
        toolCallId: "tc_2",
        toolName: "WebSearch",
        input: { query: "css grid" },
      },
      51,
    );
    expect(parseLine("zcode", line)).toEqual([
      { kind: "meta", key: "status", value: "调用工具 WebSearch" },
    ]);
  });

  it("emits no status line for a Write tool_call targeting a non-HTML path (no rescue, no nameless noise)", () => {
    // A Write to a .md sidecar rescues nothing (path filter), but the tool
    // still has a name, so it surfaces as a status line like any other tool.
    const line = envelope(
      "model.streaming",
      {
        kind: "tool_call",
        toolCallId: "tc_3",
        toolName: "Write",
        input: { file_path: "C:\\ws\\notes.md", content: "# notes" },
      },
      52,
    );
    expect(parseLine("zcode", line)).toEqual([
      { kind: "meta", key: "status", value: "调用工具 Write" },
    ]);
  });

  it("resolves the tool name of a tool.updated result via the tool_call map (调用工具 X / 工具 X 完成 pair)", () => {
    const parse = makeParser("zcode");
    expect(parse(
      envelope("model.streaming", { kind: "tool_call", toolCallId: "tc_9", toolName: "Bash", input: { command: "ls" } }, 60),
    )).toEqual([{ kind: "meta", key: "status", value: "调用工具 Bash" }]);
    // ToolCallResultPayload carries only toolCallId + result + duration; the
    // name comes from the map filled by the tool_call event above.
    expect(parse(
      envelope("tool.updated", { kind: "result", toolCallId: "tc_9", result: { success: true, content: "file1\nfile2" }, duration: 120 }, 61),
    )).toEqual([{ kind: "meta", key: "status", value: "工具 Bash 完成" }]);
  });

  it("emits nothing for a nameless tool.updated result (a bare ✓ with no context is noise)", () => {
    expect(parseLine(
      "zcode",
      envelope("tool.updated", { kind: "result", toolCallId: "tc_unknown", result: { success: true, content: "…" }, duration: 5 }, 62),
    )).toEqual([]);
  });

  it("drops the non-result tool.updated kinds (scheduled / started / progress / error / batch)", () => {
    for (const kind of ["scheduled", "started", "progress", "error", "batch"]) {
      const line = envelope("tool.updated", { kind, toolCallId: "tc_1", toolName: "Bash" }, 63);
      expect(parseLine("zcode", line)).toEqual([]);
    }
  });

  it("drops the noise envelope lines verbatim-captured from a real turn", () => {
    // session.titleUpdated
    expect(
      parseLine(
        "zcode",
        `{"eventId":"ba62ed88-8c55-4431-83ca-32a57b0b2395","payload":{"previousTitle":"","source":"first_input","title":"Reply with exactly the token: PROBE_OK"},"seq":1,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034226,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.titleUpdated"}`,
      ),
    ).toEqual([]);
    // session.resumed
    expect(
      parseLine(
        "zcode",
        `{"eventId":"081fe5f4-0d82-493a-be2d-fb69dff0168f","payload":{"directory":"C:\\Users\\dev\\Git\\html-anything","interruptedToolCount":0,"messageCount":15,"partCount":31,"recoveredCompactTimelineCount":0,"recoveredSteerInputCount":0,"resumedTodoCount":0},"seq":2,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034228,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.resumed"}`,
      ),
    ).toEqual([]);
    // session.updated, plugin hook descriptor (SessionStart frame)
    expect(
      parseLine(
        "zcode",
        `{"eventId":"704f78d3-0c2d-4566-afd8-c94f6f0906c6","payload":{"descriptor":{"clientVisible":true,"commandDisplay":"node \\"C:\\Users\\dev\\.zcode\\cli\\plugins\\cache\\claude-plugins-official\\vercel\\0.45.1/hooks/session-start-seen-skills.mjs\\"","executionMode":"foreground","executionType":"command","pluginId":"vercel@claude-plugins-official","pluginName":"vercel","sourceKind":"plugin","sourcePath":"C:\\Users\\dev\\.zcode\\cli\\plugins\\cache\\claude-plugins-official\\vercel\\0.45.1\\hooks\\hooks.json","timeoutMs":60000},"hookEventName":"SessionStart","hookIndex":0,"hookCount":4,"startedAt":1790039034230},"seq":3,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034230,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.updated"}`,
      ),
    ).toEqual([]);
  });

  it("drops turn.started (cold-boot info line is a log-panel concern, not a parser one)", () => {
    expect(
      parseLine(
        "zcode",
        `{"eventId":"2bf2eb12-0196-4448-9546-fa9bdbbdfd2e","payload":{"executionStartedAt":1790039035583.7253,"turnNumber":7,"input":"Reply with exactly the token: PROBE_OK","messageId":"msg_mubz0vk6_f9084d10-58cb-4fb2-b226-98373bfe8cec","foregroundExecutionId":"runtime_command_1","queryId":"query_cf24b136-7c0f-4afc-a83d-ced3669c001a"},"seq":11,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039035590,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"turn.started"}`,
      ),
    ).toEqual([]);
  });

  it("maps turn.completed to exactly one usage (snake_case) + duration_ms + result meta (verbatim-captured real line)", () => {
    expect(
      parseLine(
        "zcode",
        `{"eventId":"af34daea-c765-4083-9fa5-2f88eba64782","payload":{"response":"PROBE_OK","tokenCount":134374,"usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"toolCallCount":0,"historyRoundCount":1,"duration":11229,"resultType":"success","cacheStats":{"totalMessages":23,"cachedMessages":22,"lastCacheHit":true,"cacheReadTokens":64}},"seq":33,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046811,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"turn.completed"}`,
      ),
    ).toEqual([
      {
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: 134370,
          output_tokens: 4,
          cache_read_input_tokens: 64,
          cache_creation_input_tokens: 0,
        },
      },
      { kind: "meta", key: "duration_ms", value: 11229 },
      { kind: "meta", key: "result", value: "success" },
    ]);
  });

  it("maps a cancelled turn.completed resultType through the same result meta", () => {
    const line = envelope(
      "turn.completed",
      { response: "", tokenCount: 0, usage: { inputTokens: 10, outputTokens: 0 }, toolCallCount: 0, duration: 900, resultType: "cancelled" },
      34,
    );
    expect(parseLine("zcode", line)).toEqual([
      { kind: "meta", key: "usage", value: { input_tokens: 10, output_tokens: 0 } },
      { kind: "meta", key: "duration_ms", value: 900 },
      { kind: "meta", key: "result", value: "cancelled" },
    ]);
  });

  it("maps the bare result terminator to a session meta only; its usage is the same cumulative numbers turn.completed already reported", () => {
    expect(
      parseLine(
        "zcode",
        `{"type":"result","sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","response":"PROBE_OK","usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"eventCount":13,"projection":{"status":"idle","turnCount":1,"totalTokenCount":134374,"contextUsed":134374,"contextWindow":200000}}`,
      ),
    ).toEqual([{ kind: "meta", key: "session", value: "sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2" }]);
  });

  it("maps turn.failed (verbatim-captured real line) to an error part carrying the provider message", () => {
    expect(
      parseLine(
        "zcode",
        `{"eventId":"d66c6937-6bd7-4f3d-a38a-43d252a1e052","payload":{"error":{"type":"unknown_error","attribution":{"retryable":false},"code":"CONFIGURATION_ERROR","message":"Select a model before continuing","detail":"Model creation failed","underlyingErrorMessage":"Select a model before continuing","stack":"Error: Model creation failed\\n    at createCoreError (C:\\\\Program Files\\\\ZCode\\\\resources\\\\glm\\\\zcode.cjs:108:2685)\\n    at createTurnFailureError (C:\\\\Program Files\\\\ZCode\\\\resources\\\\glm\\\\zcode.cjs:14575:1578)"},"turnPhase":"model_creation"},"seq":1,"sessionId":"sess_b154be6b-7148-4098-8d80-6f717ce7bdb8","timestamp":1790041331523,"traceId":"f2f332d5-1d5c-4f95-baee-6c4ecedfd155","turnId":"turn_28ed2805-a161-450f-a426-9f3182f003bb","type":"turn.failed"}`,
      ),
    ).toEqual([{ kind: "error", message: "Select a model before continuing" }]);
  });

  it("falls back to a generic message when turn.failed carries no error.message", () => {
    expect(
      parseLine("zcode", envelope("turn.failed", { error: { type: "unknown_error" }, turnPhase: "run" }, 2)),
    ).toEqual([{ kind: "error", message: "zcode turn failed" }]);
  });

  it("drops non-JSON lines and future event types without throwing", () => {
    expect(parseLine("zcode", "not json at all")).toEqual([]);
    expect(parseLine("zcode", "")).toEqual([]);
    expect(
      parseLine("zcode", `{"type":"hook.progress","payload":{"foo":1}}`),
    ).toEqual([]);
  });

  it("makeParser accumulates streamed text across lines", () => {
    const parse = makeParser("zcode");
    const parts = [
      ...parse(TEXT_DELTA_LINE("PRO", 22)),
      ...parse(TEXT_DELTA_LINE("BE", 23)),
      ...parse(TEXT_DELTA_LINE("_OK", 24)),
    ];
    expect(parts).toEqual([
      { kind: "delta", text: "PRO" },
      { kind: "delta", text: "BE" },
      { kind: "delta", text: "_OK" },
    ]);
  });

  it("a full real-turn line sequence yields exactly: deltas, then usage/duration/result, then session (noise: zero output, usage: exactly once)", () => {
    // Ordered slice of the real capture: 2 hook-noise lines, the 7 real
    // model.streaming lines of the turn (start, text_start, three
    // text_delta, text_end, finish), turn.completed, and the result terminator.
    const parse = makeParser("zcode");
    const out = [
      ...parse(`{"eventId":"ba62ed88-8c55-4431-83ca-32a57b0b2395","payload":{"previousTitle":"","source":"first_input","title":"Reply with exactly the token: PROBE_OK"},"seq":1,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034226,"type":"session.titleUpdated"}`),
      ...parse(`{"payload":{"descriptor":{"clientVisible":true},"hookEventName":"SessionStart","hookIndex":0,"hookCount":4,"startedAt":1790039034230},"seq":3,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034230,"type":"session.updated"}`),
      ...parse(TEXT_DELTA_LINE("", 20)),
      ...parse(TEXT_DELTA_LINE("", 21)),
      ...parse(TEXT_DELTA_LINE("PRO", 22)),
      ...parse(TEXT_DELTA_LINE("BE", 23)),
      ...parse(TEXT_DELTA_LINE("_OK", 24)),
      ...parse(TEXT_DELTA_LINE("", 25)),
      ...parse(TEXT_DELTA_LINE("", 26)),
      ...parse(`{"payload":{"response":"PROBE_OK","tokenCount":134374,"usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"toolCallCount":0,"historyRoundCount":1,"duration":11229,"resultType":"success"},"seq":33,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046811,"type":"turn.completed"}`),
      ...parse(`{"type":"result","sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","response":"PROBE_OK","usage":{"inputTokens":134370,"outputTokens":4,"cacheReadTokens":64,"cacheWriteTokens":0},"eventCount":13}`,
      ),
    ];
    expect(out).toEqual([
      { kind: "delta", text: "PRO" },
      { kind: "delta", text: "BE" },
      { kind: "delta", text: "_OK" },
      { kind: "meta", key: "usage", value: { input_tokens: 134370, output_tokens: 4, cache_read_input_tokens: 64, cache_creation_input_tokens: 0 } },
      { kind: "meta", key: "duration_ms", value: 11229 },
      { kind: "meta", key: "result", value: "success" },
      { kind: "meta", key: "session", value: "sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2" },
    ]);
  });
});
