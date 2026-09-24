export type AgentArgvOpts = {
  model?: string;
  cwd?: string;
  /** When the adapter takes the prompt as a positional argv (deepseek-tui). */
  prompt?: string;
  /**
   * For openclaw only — pre-resolved agent id (e.g. "main" or "ops") that
   * gets injected into the argv as `--agent <id>`. invoke.ts is responsible
   * for resolving this via `resolveOpenclawAgentId` before calling buildArgv.
   */
  openclawAgentId?: string;
};

export class UnsupportedAgentProtocolError extends Error {
  constructor(public readonly agent: string, public readonly protocol: string) {
    super(
      `${agent} uses the ${protocol} protocol, which is not yet wired up in this build. ` +
        `Pick one of: claude / codex / cursor-agent / gemini / copilot / opencode / qwen / qoder / codewhale / deepseek-tui / aider.`,
    );
  }
}

/**
 * The fixed short guide ZCode's `-p` flag carries. The attachment holds the
 * real task, so this only points the model at it and pins the deliverable
 * shape (final HTML as the reply body — ZCode is agentic and would otherwise
 * reach for file-write tools). Keep it short: `-p` takes an argv value.
 */
const ZCODE_PROMPT_GUIDE =
  "附件是完整的任务说明。请严格按其中的要求执行，并将最终结果（完整 HTML）直接作为你的回复正文输出。";

export function buildArgv(agent: string, _opts: AgentArgvOpts = {}): string[] {
  const { model } = _opts;
  switch (agent) {
    case "claude":
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
        ...(model ? ["--model", model] : []),
      ];
    case "openclaw":
      // OpenClaw is a multi-channel agent gateway — invocation is
      //   openclaw agent --local --json --agent <id> [--model <id>]
      // and the prompt is appended later via `--message <text>` by invoke.ts
      // (see protocol === "argv-message"). The agent id is resolved at
      // invocation time by `resolveOpenclawAgentId`.
      return [
        "agent",
        "--local",
        "--json",
        "--agent",
        _opts.openclawAgentId ?? "main",
        ...(model ? ["--model", model] : []),
      ];
    case "codex":
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-c",
        "sandbox_workspace_write.network_access=true",
        ...(model ? ["--model", model] : []),
      ];
    case "cursor-agent":
      return [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--force",
        "--trust",
        ...(model ? ["--model", model] : []),
      ];
    case "gemini":
      return [
        "--output-format",
        "stream-json",
        "--yolo",
        ...(model ? ["--model", model] : []),
      ];
    case "copilot":
      return [
        "--allow-all-tools",
        "--output-format",
        "json",
        ...(model ? ["--model", model] : []),
      ];
    case "bob":
      // Bob's `-p`/`--prompt` flag expects an argument; we stream the prompt via
      // stdin, so omit `-p` and just request stream-json output.
      // --hide-intermediary-output suppresses thinking/reasoning, leaving only
      // the final completion in stdout.
      return ["--output-format", "stream-json", "--hide-intermediary-output"];
    case "opencode":
      return [
        "run",
        "--format",
        "json",
        "--dangerously-skip-permissions",
        ...(model ? ["--model", model] : []),
        "-",
      ];
    case "qwen":
      return ["--yolo", ...(model ? ["--model", model] : []), "-"];
    case "aider":
      return [
        "--no-pretty",
        "--no-stream",
        "--yes-always",
        "--message-file",
        "-",
        ...(model ? ["--model", model] : []),
      ];
    case "qoder":
      // Qoder CLI mirrors `claude -p`'s shape: print mode + stream-json + yolo
      // for non-interactive approval. Prompt arrives via stdin (handled in
      // invoke.ts). See open-design's apps/daemon/src/agents.ts.
      return [
        "-p",
        "--output-format",
        "stream-json",
        "--yolo",
        ...(model ? ["--model", model] : []),
      ];
    case "codewhale":
    case "deepseek-tui":
      // DeepSeek's `exec --auto` requires the prompt as a positional arg;
      // there's no `-` stdin sentinel. invoke.ts appends opts.prompt at
      // spawn time, so we leave the trailing slot empty here.
      return ["exec", "--auto", ...(model ? ["--model", model] : [])];
    case "zcode":
      // Headless one-shot. `-p` carries ONLY this fixed short guide — the
      // full prompt (shared directives + template + user content, 20-30KB+)
      // travels in the `--attach` temp file invoke.ts writes; argv length
      // limits would truncate it. `--mode yolo` is `-p`'s default anyway;
      // passing it is self-documentation. There is no `--model` flag: the
      // model default comes from ZCode's own provider config (opts.model is
      // deliberately ignored).
      return [
        "-p",
        ZCODE_PROMPT_GUIDE,
        "--output-format",
        "stream-json",
        "--mode",
        "yolo",
      ];
    case "hermes":
    case "kimi":
    case "devin":
    case "kiro":
    case "kilo":
    case "vibe":
      throw new UnsupportedAgentProtocolError(agent, "ACP JSON-RPC");
    case "pi":
      throw new UnsupportedAgentProtocolError(agent, "pi-rpc");
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
}

export function envFor(agent: string): NodeJS.ProcessEnv {
  const base = { ...process.env };
  if (agent === "gemini") base.GEMINI_CLI_TRUST_WORKSPACE = "true";
  // ZCode's zcode.cjs is an Electron-hosted bundle; without
  // ELECTRON_RUN_AS_NODE=1 it boots the full Electron app instead of the CLI
  // and the prompt is never executed (live-proven). Merged INTO the env (not
  // a replacement) so PATH, ZCODE_*, and the provider-config escape-hatch
  // vars survive. Scoped to zcode — other agents must not inherit it.
  if (agent === "zcode") base.ELECTRON_RUN_AS_NODE = "1";
  return base;
}

export type AgentParse =
  | { kind: "delta"; text: string }
  | { kind: "meta"; key: string; value: unknown }
  /**
   * Canonical HTML rescued from a file-write tool call (e.g. Claude's `Write`
   * tool). Replaces any previously streamed text — the preamble like
   * "I'll save it as output.html\n已输出至 …" is junk; the tool's input is the
   * real HTML. Downstream calls `setHtmlFor`, not `appendHtmlFor`.
   */
  | { kind: "html"; text: string }
  | { kind: "noise" };

/**
 * Cross-line state that the parser carries between calls. Currently used to
 * dedupe text deltas: when an agent emits both fine-grained `stream_event`
 * `text_delta` blocks AND a final `assistant` message containing the same
 * text concatenated, we keep the streamed tokens and skip the assistant
 * message body. Without this dedupe, every Claude/Cursor/Gemini/Qoder run
 * with `--include-partial-messages` (or the equivalent) writes its output
 * twice.
 */
export type ParseState = {
  sawStreamEventText?: boolean;
  /** #41 leak fix: server-tool card filter state (zcode only). */
  zcodeToolCardBuf?: string;
  zcodeToolCardSwallowing?: boolean;
  opencodeAccumulatedInputTokens?: number;
  opencodeAccumulatedOutputTokens?: number;
  opencodeAccumulatedCacheReadTokens?: number;
  opencodeAccumulatedCacheWriteTokens?: number;
  opencodeAccumulatedCost?: number;
};

/**
 * Streaming filter for Z.ai server-tool display cards (#41 leak fix).
 *
 * ZCode's server-executed builtin tools (webReader / webSearch …) stream
 * their display cards ("\uD83C\uDF10 Z.ai Built-in Tool: webReader …
 * Input … Executing on server … Output …") as ASSISTANT TEXT — the tool
 * names appear nowhere in the CLI bundle, so these frames can only be told
 * apart from the deliverable by their fixed marker. The tools themselves
 * stay enabled (the model may fetch links from the user content); only the
 * card text must not reach the final HTML.
 *
 * State machine over the delta stream: normal mode holds back a suffix that
 * could be a partial marker; the marker starts swallow mode; swallow ends
 * where the deliverable resumes — the next HTML tag ("<"+letter/!) or the
 * next card marker. Held-back tails flush on the next delta; whatever is
 * still held when the turn ends is dropped (the stream ends with </html>).
 */
const ZCODE_SERVER_TOOL_CARD_MARK = "**\uD83C\uDF10 Z.ai Built-in Tool:";

function zcodeFilterServerToolCards(
  state: { zcodeToolCardBuf?: string; zcodeToolCardSwallowing?: boolean },
  delta: string,
): string {
  let rest = (state.zcodeToolCardBuf ?? "") + delta;
  let out = "";
  for (;;) {
    if (state.zcodeToolCardSwallowing) {
      const html = rest.search(/<(?=[a-zA-Z!])/);
      const nextCard = rest.indexOf(ZCODE_SERVER_TOOL_CARD_MARK);
      let cut = -1;
      if (html !== -1 && (nextCard === -1 || html < nextCard)) cut = html;
      else if (nextCard !== -1) cut = nextCard;
      if (cut === -1) {
        // Keep the last char — a "<" may be split from its follower across deltas.
        state.zcodeToolCardBuf = rest.length > 1 ? rest.slice(-1) : rest;
        return out;
      }
      state.zcodeToolCardSwallowing = false;
      rest = rest.slice(cut);
      continue;
    }
    const mark = rest.indexOf(ZCODE_SERVER_TOOL_CARD_MARK);
    if (mark !== -1) {
      out += rest.slice(0, mark);
      state.zcodeToolCardBuf = "";
      state.zcodeToolCardSwallowing = true;
      return out;
    }
    let hold = 0;
    const maxHold = Math.min(rest.length, ZCODE_SERVER_TOOL_CARD_MARK.length - 1);
    for (let n = maxHold; n > 0; n--) {
      if (ZCODE_SERVER_TOOL_CARD_MARK.startsWith(rest.slice(-n))) {
        hold = n;
        break;
      }
    }
    out += rest.slice(0, rest.length - hold);
    state.zcodeToolCardBuf = rest.slice(rest.length - hold);
    return out;
  }
}

/**
 * Build a stateful per-invocation parser. Feed every stdout line through the
 * returned function — it carries the cross-line state needed for dedupe.
 */
export function makeParser(agent: string): (line: string) => AgentParse[] {
  const state: ParseState = {};
  return (line: string) => parseLineWithState(agent, line, state);
}

/**
 * Parse a single line of agent stdout. Stateless wrapper kept for callers
 * that only need one-shot parsing (e.g. `extractTextFromLine`). Streaming
 * callers should use `makeParser` so dedupe state survives across lines.
 */
export function parseLine(agent: string, line: string): AgentParse[] {
  return parseLineWithState(agent, line, {});
}

/**
 * Some agents (Claude + bypassPermissions, qoder, …) ignore the "stream HTML
 * inline" prompt and decide to dump the document into a file via the `Write`
 * tool, leaving the assistant text as just a confirmation ("已输出至 …").
 * Rescue the HTML from the tool_use input so the preview still gets the real
 * content. Returns an empty string if no Write/create_file tool_use was found
 * or its input has no usable content field.
 *
 * Module-internal: shared by the agent parse cases below. (The cli mirror
 * keeps its own internal copy — the two files are adapted copies by repo
 * convention, not verbatim mirrors.)
 */
function rescueHtmlFromToolUse(
  content: Array<{ type?: string; name?: string; input?: unknown }> | undefined,
): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    const name = (block.name ?? "").toLowerCase();
    // Match the common file-write tool names across agents.
    if (
      name !== "write" &&
      name !== "create_file" &&
      name !== "createfile" &&
      name !== "writefile" &&
      name !== "write_file" &&
      name !== "filewrite"
    )
      continue;
    const input = block.input as Record<string, unknown> | undefined;
    if (!input || typeof input !== "object") continue;
    const path = String(input.file_path ?? input.path ?? input.filename ?? "").toLowerCase();
    // Only rescue HTML-ish targets — never grab content for a .md / .txt
    // sidecar the agent might also be writing.
    if (path && !/\.(html?|htm)$/.test(path)) continue;
    const text =
      typeof input.content === "string"
        ? input.content
        : typeof input.text === "string"
          ? input.text
          : typeof input.file_content === "string"
            ? input.file_content
            : "";
    if (text) parts.push(text);
  }
  return parts.join("");
}

function parseLineWithState(agent: string, line: string, state: ParseState): AgentParse[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Aider / DeepSeek — plain text streaming on stdout (DeepSeek tool calls
  // go to stderr, which is forwarded as `stderr` events, not parsed here).
  if (agent === "aider" || agent === "codewhale" || agent === "deepseek-tui") {
    return [{ kind: "delta", text: trimmed.endsWith("\n") ? trimmed : trimmed + "\n" }];
  }

  // ZCode (argv-attach) — NDJSON event envelope, one JSON object per line:
  //   {"type":"model.streaming","payload":{"kind":"text_delta","delta":"…"},…}
  // plus a bare {"type":"result",…} terminator line. Only model.streaming
  // text_delta carries streamed text; every other line — hook-noise
  // session.updated frames (plugin SessionStart/UserPromptSubmit descriptors
  // etc., 20+ per turn), turn lifecycle events, the result terminator, and
  // non-JSON lines — is safely DROPPED. Handled before the shared JSON.parse
  // so a non-JSON line returns [] here instead of a `noise` part (the invoke
  // layer forwards noise as `raw`, which would flood the log panel).
  if (agent === "zcode") {
    let zcodeParsed: unknown;
    try {
      zcodeParsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!zcodeParsed || typeof zcodeParsed !== "object") return [];
    const zcodeObj = zcodeParsed as Record<string, unknown>;
    if (zcodeObj.type === "model.streaming" && zcodeObj.payload && typeof zcodeObj.payload === "object") {
      const payload = zcodeObj.payload as { kind?: string; delta?: string };
      if (
        payload.kind === "text_delta" &&
        typeof payload.delta === "string" &&
        payload.delta.length > 0
      ) {
        const text = zcodeFilterServerToolCards(state, payload.delta);
        return text.length > 0 ? [{ kind: "delta", text }] : [];
      }
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: "noise" }];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const out: AgentParse[] = [];

  if (agent === "claude") {
    // Init / system metadata
    if (obj.type === "system" && obj.subtype === "init") {
      out.push({ kind: "meta", key: "model", value: obj.model });
      out.push({ kind: "meta", key: "session", value: obj.session_id });
      if (obj.cwd) out.push({ kind: "meta", key: "cwd", value: obj.cwd });
    }
    // Stream events (--include-partial-messages → fine-grained text_delta)
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta") {
        out.push({ kind: "meta", key: "thinking", value: ev.delta.thinking });
      }
    }
    // Full assistant messages — fallback only when stream_event text deltas
    // were absent (e.g. older claude without --include-partial-messages).
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as {
        content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
        usage?: Record<string, number>;
        model?: string;
      };
      const toolHtml = rescueHtmlFromToolUse(msg.content);
      if (toolHtml) {
        out.push({ kind: "html", text: toolHtml });
        // suppress the chatty assistant text fallback below; the Write input
        // is authoritative for this turn.
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
      if (msg.usage) out.push({ kind: "meta", key: "usage_partial", value: msg.usage });
    }
    if (obj.type === "result") {
      if (obj.usage) out.push({ kind: "meta", key: "usage", value: obj.usage });
      if (typeof obj.duration_ms === "number") out.push({ kind: "meta", key: "duration_ms", value: obj.duration_ms });
      if (typeof obj.total_cost_usd === "number") out.push({ kind: "meta", key: "cost_usd", value: obj.total_cost_usd });
      if (typeof obj.subtype === "string") out.push({ kind: "meta", key: "result", value: obj.subtype });
    }
    if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
      out.push({ kind: "meta", key: "rate_limit", value: obj.rate_limit_info });
    }
  }

  if (agent === "codex") {
    if (obj.type === "item.completed" && obj.item && typeof obj.item === "object") {
      const item = obj.item as { item_type?: string; type?: string; text?: string };
      const itemType = item.item_type ?? item.type;
      if (
        (itemType === "assistant_message" || itemType === "agent_message") &&
        typeof item.text === "string"
      ) {
        out.push({ kind: "delta", text: item.text });
      }
    }
    if (obj.type === "item.delta" && typeof obj.text === "string") {
      out.push({ kind: "delta", text: obj.text });
    }
    if (obj.msg && typeof obj.msg === "object") {
      const msg = obj.msg as { type?: string; message?: string };
      if (msg.type === "agent_message" && typeof msg.message === "string") {
        out.push({ kind: "delta", text: msg.message });
      }
    }
    if (obj.type === "task_complete" && obj.usage) {
      out.push({ kind: "meta", key: "usage", value: obj.usage });
    }
    if (obj.type === "turn.completed" && obj.usage) {
      out.push({ kind: "meta", key: "usage", value: obj.usage });
    }
  }

  if (agent === "cursor-agent" || agent === "gemini") {
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      const toolHtml = rescueHtmlFromToolUse(msg.content);
      if (toolHtml) {
        out.push({ kind: "html", text: toolHtml });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
    }
    // Bare `text` field — only honor it when we haven't already emitted a
    // streamed delta or an assistant body, otherwise it duplicates the same
    // payload (cursor-agent / gemini both ship this redundancy on some
    // versions).
    if (typeof obj.text === "string" && !state.sawStreamEventText && obj.type !== "assistant") {
      out.push({ kind: "delta", text: obj.text as string });
    }
  }

  if (agent === "copilot") {
    if (typeof obj.response === "string") out.push({ kind: "delta", text: obj.response });
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
  }

  if (agent === "opencode") {
    const part =
      obj.part && typeof obj.part === "object"
        ? (obj.part as Record<string, unknown>)
        : null;
    const text = [part?.text, part?.content, part?.message, obj.text, obj.content, obj.message].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (text) out.push({ kind: "delta", text });
    if (obj.type === "step_start" && typeof obj.sessionID === "string") {
      out.push({ kind: "meta", key: "session", value: obj.sessionID });
    }
    if (part?.tokens && typeof part.tokens === "object") {
      const tokens = part.tokens as {
        input?: number;
        output?: number;
        cache?: { read?: number; write?: number };
      };
      state.opencodeAccumulatedInputTokens = (state.opencodeAccumulatedInputTokens ?? 0) + (tokens.input ?? 0);
      state.opencodeAccumulatedOutputTokens = (state.opencodeAccumulatedOutputTokens ?? 0) + (tokens.output ?? 0);
      state.opencodeAccumulatedCacheReadTokens = (state.opencodeAccumulatedCacheReadTokens ?? 0) + (tokens.cache?.read ?? 0);
      state.opencodeAccumulatedCacheWriteTokens = (state.opencodeAccumulatedCacheWriteTokens ?? 0) + (tokens.cache?.write ?? 0);

      out.push({
        kind: "meta",
        key: "usage",
        value: {
          input_tokens: state.opencodeAccumulatedInputTokens,
          output_tokens: state.opencodeAccumulatedOutputTokens,
          cache_read_input_tokens: state.opencodeAccumulatedCacheReadTokens,
          cache_creation_input_tokens: state.opencodeAccumulatedCacheWriteTokens,
        },
      });
    }
    if (typeof part?.cost === "number") {
      state.opencodeAccumulatedCost = (state.opencodeAccumulatedCost ?? 0) + part.cost;
      out.push({ kind: "meta", key: "cost_usd", value: state.opencodeAccumulatedCost });
    }
  }

  if (agent === "qwen") {
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
    if (typeof obj.content === "string") out.push({ kind: "delta", text: obj.content });
    if (typeof obj.message === "string") out.push({ kind: "delta", text: obj.message });
  }

  if (agent === "bob") {
    if (typeof obj.text === "string") out.push({ kind: "delta", text: obj.text });
    if (typeof obj.content === "string") out.push({ kind: "delta", text: obj.content });
    if (typeof obj.message === "string") out.push({ kind: "delta", text: obj.message });
  }

  if (agent === "qoder") {
    // Qoder's stream-json output mirrors claude's envelope shape (init/system,
    // stream_event with content_block_delta/text_delta, assistant message,
    // result with usage). Parse generously across both fine-grained deltas and
    // full assistant turns. Falls back to a bare `text` field for
    // forward-compatibility with future Qoder JSON variants.
    if (obj.type === "system" && obj.subtype === "init") {
      if (obj.model) out.push({ kind: "meta", key: "model", value: obj.model });
      if (obj.session_id) out.push({ kind: "meta", key: "session", value: obj.session_id });
    }
    if (obj.type === "stream_event" && obj.event && typeof obj.event === "object") {
      const ev = obj.event as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
        state.sawStreamEventText = true;
        out.push({ kind: "delta", text: ev.delta.text });
      }
    }
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
      const toolHtml = rescueHtmlFromToolUse(msg.content);
      if (toolHtml) {
        out.push({ kind: "html", text: toolHtml });
        state.sawStreamEventText = true;
      }
      if (!state.sawStreamEventText) {
        const text = (msg.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("");
        if (text) out.push({ kind: "delta", text });
      }
    }
    if (obj.type === "result") {
      if (obj.usage) out.push({ kind: "meta", key: "usage", value: obj.usage });
      if (typeof obj.duration_ms === "number") out.push({ kind: "meta", key: "duration_ms", value: obj.duration_ms });
    }
    if (typeof obj.text === "string" && !state.sawStreamEventText && obj.type !== "assistant") {
      out.push({ kind: "delta", text: obj.text });
    }
  }

  return out;
}

/** Back-compat shim for callers that just want plain text. */
export function extractTextFromLine(agent: string, line: string): string {
  return parseLine(agent, line)
    .filter((p): p is Extract<AgentParse, { kind: "delta" }> => p.kind === "delta")
    .map((p) => p.text)
    .join("");
}
