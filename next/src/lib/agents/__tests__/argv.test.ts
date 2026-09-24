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


// Real NDJSON lines captured from the installed ZCode CLI (3.14.1 desktop
// bundle, zcode 0.16.9) running `-p … --output-format stream-json --mode
// yolo` headless. The parser contract is pinned against these real bytes.
// Source probe artifact:
// .scratch/zcode-opensource/probe-cli-oneshot/streamcheck-stdout.jsonl
// (captured 2026-09-22). Noise vocabulary on a single turn:
// session.titleUpdated / session.resumed / session.updated (plugin hook
// descriptors), turn.started, the model.streaming kinds, turn.completed, and
// the bare result terminator line.
describe("parseLine zcode (argv-attach stream-json)", () => {
  const TEXT_DELTA_LINE = (delta: string, seq: number) =>
    `{"eventId":"d20d9e75-af8b-4d70-8b12-750a9841623${seq}","payload":{"assistantMessageId":"msg_mubz0ze1_3fd06d2d-4911-4f90-8aa7-db4660374462","delta":${JSON.stringify(delta)},"done":false,"kind":"text_delta"},"seq":${seq},"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046427,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"model.streaming"}`;

  it("bridges model.streaming text_delta to a delta with the exact text", () => {
    expect(parseLine("zcode", TEXT_DELTA_LINE("PRO", 22))).toEqual([
      { kind: "delta", text: "PRO" },
    ]);
    expect(parseLine("zcode", TEXT_DELTA_LINE("_OK", 24))).toEqual([
      { kind: "delta", text: "_OK" },
    ]);
  });

  it("drops every non-text_delta streaming kind (start / text_start / text_end / finish)", () => {
    for (const kind of ["start", "text_start", "text_end", "finish"]) {
      const line = `{"payload":{"delta":"","done":false,"kind":"${kind}"},"seq":1,"type":"model.streaming"}`;
      expect(parseLine("zcode", line)).toEqual([]);
    }
  });

  it("drops a text_delta with an empty delta string (no zero-length events)", () => {
    expect(parseLine("zcode", TEXT_DELTA_LINE("", 21))).toEqual([]);
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
        `{"eventId":"081fe5f4-0d82-493a-be2d-fb69dff0168f","payload":{"directory":"C:\\Users\\Administrator\\Git\\html-anything","interruptedToolCount":0,"messageCount":15,"partCount":31,"recoveredCompactTimelineCount":0,"recoveredSteerInputCount":0,"resumedTodoCount":0},"seq":2,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034228,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.resumed"}`,
      ),
    ).toEqual([]);
    // session.updated — plugin hook descriptor (SessionStart frame)
    expect(
      parseLine(
        "zcode",
        `{"eventId":"704f78d3-0c2d-4566-afd8-c94f6f0906c6","payload":{"descriptor":{"clientVisible":true,"commandDisplay":"node \\"C:\\Users\\Administrator\\.zcode\\cli\\plugins\\cache\\claude-plugins-official\\vercel\\0.45.1/hooks/session-start-seen-skills.mjs\\"","executionMode":"foreground","executionType":"command","pluginId":"vercel@claude-plugins-official","pluginName":"vercel","sourceKind":"plugin","sourcePath":"C:\\Users\\Administrator\\.zcode\\cli\\plugins\\cache\\claude-plugins-official\\vercel\\0.45.1\\hooks\\hooks.json","timeoutMs":60000},"hookEventName":"SessionStart","hookIndex":0,"hookCount":4,"startedAt":1790039034230},"seq":3,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039034230,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","type":"session.updated"}`,
      ),
    ).toEqual([]);
  });

  it("drops turn.started, turn.completed, and the bare result terminator", () => {
    expect(
      parseLine(
        "zcode",
        `{"eventId":"2bf2eb12-0196-4448-9546-fa9bdbbdfd2e","payload":{"executionStartedAt":1790039035583.7253,"turnNumber":7,"input":"Reply with exactly the token: PROBE_OK","messageId":"msg_mubz0vk6_f9084d10-58cb-4fb2-b226-98373bfe8cec","foregroundExecutionId":"runtime_command_1","queryId":"query_cf24b136-0c0f-4afc-a83d-ced3669c001a"},"seq":11,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039035590,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"turn.started"}`,
      ),
    ).toEqual([]);
    expect(
      parseLine(
        "zcode",
        `{"eventId":"af34daea-c765-4083-9fa5-2f88eba64782","payload":{"response":"PROBE_OK","tokenCount":134374,"usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"toolCallCount":0,"historyRoundCount":1,"duration":11229,"resultType":"success","cacheStats":{"totalMessages":23,"cachedMessages":22,"lastCacheHit":true,"cacheReadTokens":64}},"seq":33,"sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","timestamp":1790039046811,"traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","type":"turn.completed"}`,
      ),
    ).toEqual([]);
    expect(
      parseLine(
        "zcode",
        `{"type":"result","sessionId":"sess_87b8cfd7-66c0-43d1-8133-23a659bae7b2","traceId":"fac306de-bf37-4eff-94ca-eb8476962e3c","turnId":"turn_428dacfc-74fc-4056-9aac-785654cb17bc","response":"PROBE_OK","usage":{"source":"provider","modelRequestCount":1,"inputTokens":134370,"outputTokens":4,"totalTokens":134374,"cacheReadTokens":64,"cacheWriteTokens":0,"reasoningTokens":1,"webFetchRequests":0,"webSearchRequests":0},"eventCount":13,"projection":{"status":"idle","turnCount":1,"totalTokenCount":134374,"contextUsed":134374,"contextWindow":200000}}`,
      ),
    ).toEqual([]);
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
});
