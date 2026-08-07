import { describe, it, expect, vi } from "vitest";
import { createZcodeStreamHandler } from "./zcode-stream.js";

/**
 * The stream handler maps raw app-server notification frames into a small
 * `onEvent` event set. A frame is the same object the protocol client's
 * `onNotification` delivers: `{ method, params }`. The two methods that carry
 * stream content are `session/event` (its `params.payload` holds the semantic
 * kind) and `state.updated` (its `params.reason` is a status transition).
 */
function sessionEvent(payload: Record<string, unknown>) {
  return { method: "session/event", params: { payload } };
}

function stateUpdated(reason: string) {
  return { method: "state.updated", params: { reason } };
}

describe("createZcodeStreamHandler — text_delta", () => {
  it("maps a text_delta payload to a text_delta event with the delta string", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ kind: "text_delta", delta: "Hello" }));

    expect(onEvent).toHaveBeenCalledWith({ type: "text_delta", delta: "Hello" });
  });

  it("drops a text_delta with an empty delta string (no event)", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ kind: "text_delta", delta: "" }));

    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("createZcodeStreamHandler — status", () => {
  it("maps prompt_started → status running", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(stateUpdated("prompt_started"));

    expect(onEvent).toHaveBeenCalledWith({ type: "status", label: "running" });
  });

  it("maps prompt_completed → status completed", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(stateUpdated("prompt_completed"));

    expect(onEvent).toHaveBeenCalledWith({ type: "status", label: "completed" });
  });

  it("maps prompt_failed → status failed", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(stateUpdated("prompt_failed"));

    expect(onEvent).toHaveBeenCalledWith({ type: "status", label: "failed" });
  });

  it("drops config-noise reasons (model_provider_upserted etc.)", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(stateUpdated("model_provider_upserted"));

    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("createZcodeStreamHandler — thinking (reasoning_delta)", () => {
  it("emits thinking_start once per turn before the first reasoning delta", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ kind: "reasoning_delta", delta: "hmm" }));
    stream.handleFrame(sessionEvent({ kind: "reasoning_delta", delta: "more" }));

    const calls = onEvent.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { type: "thinking_start" },
      { type: "thinking_delta", delta: "hmm" },
      { type: "thinking_delta", delta: "more" },
    ]);
  });

  it("resets thinking_start at the start of a new turn", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    // Turn 1: first delta fires thinking_start.
    stream.handleFrame(sessionEvent({ kind: "reasoning_delta", delta: "a" }));
    // Turn boundary (turn start frame).
    stream.handleFrame(sessionEvent({ turnNumber: 1, queryId: "q1" }));
    // Turn 2: first delta fires thinking_start again.
    stream.handleFrame(sessionEvent({ kind: "reasoning_delta", delta: "b" }));

    const thinkingStarts = onEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "thinking_start");
    expect(thinkingStarts).toHaveLength(2);
  });

  it("also resets thinking_start on prompt_started status", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ kind: "reasoning_delta", delta: "a" }));
    stream.handleFrame(stateUpdated("prompt_started"));
    stream.handleFrame(sessionEvent({ kind: "reasoning_delta", delta: "b" }));

    const thinkingStarts = onEvent.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === "thinking_start");
    expect(thinkingStarts).toHaveLength(2);
  });
});

describe("createZcodeStreamHandler — tool_use / tool_result", () => {
  it("maps a tool_call payload to a tool_use event", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(
      sessionEvent({ kind: "tool_call", toolCallId: "tc1", toolName: "read_file", input: { path: "/a" } }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_use",
      id: "tc1",
      name: "read_file",
      input: { path: "/a" },
    });
  });

  it("drops a tool_call without an id or name", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ kind: "tool_call", toolName: "read_file" }));
    stream.handleFrame(sessionEvent({ kind: "tool_call", toolCallId: "tc1" }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("maps a tool result payload to a tool_result event (success)", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(
      sessionEvent({ kind: "result", toolCallId: "tc1", result: { content: "ok", success: true } }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_result",
      toolUseId: "tc1",
      content: "ok",
      isError: false,
    });
  });

  it("maps a tool result payload to a tool_result event (failure)", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(
      sessionEvent({ kind: "result", toolCallId: "tc1", result: { content: "boom", success: false } }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_result",
      toolUseId: "tc1",
      content: "boom",
      isError: true,
    });
  });
});

describe("createZcodeStreamHandler — usage & error & title", () => {
  it("maps a final-result payload (resultType + usage) to a usage event", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(
      sessionEvent({
        resultType: "success",
        usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
        duration: 1234,
      }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: "usage",
      usage: { input_tokens: 10, output_tokens: 20, thought_tokens: 5 },
      durationMs: 1234,
    });
  });

  it("maps a turn-level error payload to an error event", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ error: { message: "rate limited", detail: "429" } }));

    expect(onEvent).toHaveBeenCalledWith({ type: "error", message: "rate limited", raw: "429" });
  });

  it("maps a generated conversation title to a conversation_title event", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ title: "Refactor the parser", source: "generated" }));

    expect(onEvent).toHaveBeenCalledWith({ type: "conversation_title", title: "Refactor the parser" });
  });

  it("drops a first_input title (it just echoes the user prompt)", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ title: "user prompt text", source: "first_input" }));

    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("createZcodeStreamHandler — robustness", () => {
  it("ignores non-record frames", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(null);
    stream.handleFrame("not a frame");
    stream.handleFrame(undefined);
    stream.handleFrame({ method: "session/event" }); // no params.payload

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not forward unrecognised payloads (no raw passthrough)", () => {
    const onEvent = vi.fn();
    const stream = createZcodeStreamHandler(onEvent);

    stream.handleFrame(sessionEvent({ kind: "unknown_future_kind", secret: "x-api-key" }));

    expect(onEvent).not.toHaveBeenCalled();
  });
});
