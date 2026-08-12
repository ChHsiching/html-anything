import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path, { delimiter, join, posix, win32 } from "node:path";
import { readZcodeModelPicker } from "@html-anything/zcode-protocol/zcode-model-picker";

/**
 * Agent detection — adapted from next/src/lib/agents/detect.ts
 */

/**
 * Per-agent invocation protocol. Determines how `invokeAgent` delivers the
 * prompt and parses output:
 *   - "stdin"        : pipe prompt → child stdin, parse stdout via parseLine
 *   - "argv"         : pass prompt as positional argv (deepseek-tui/codewhale)
 *   - "argv-message" : prompt goes via `--message <text>` (openclaw)
 *   - "acp"          : ACP JSON-RPC over stdio (hermes/kimi/devin/kiro/kilo/vibe)
 *   - "pi-rpc"       : pi's custom JSON-RPC mode
 *   - "app-server"   : ZCode's `app-server` JSON-RPC-over-stdio protocol
 *                      (workspace/* + session/* methods). Distinct from "acp":
 *                      do not assume a shared parser. Surfaced in detection so
 *                      ZCode shows up in the picker; the invoke branch lands in
 *                      a later ticket (see ADR-0002 decision 2).
 */
export type AgentProtocol = "stdin" | "argv" | "argv-message" | "acp" | "pi-rpc" | "app-server";

/**
 * A model picker entry. `id`/`label` are the universal surface every agent's
 * picker reads. `providerId` is OPTIONAL and ZCode-only (#19 / ADR-0005
 * decision 4): ZCode's dynamic picker lists models across multiple providers
 * (GLM, OpenRouter, …), and `session/create` needs `{ providerId, modelId }`
 * to bind the choice. The invoke layer recovers the `providerId` for a picked
 * `id` from this field. Absent for every other agent (their picker ids map to
 * a single provider implicitly, or go to `--model <id>`).
 */
export type ModelOption = { id: string; label: string; providerId?: string };

export const DEFAULT_MODEL: ModelOption = { id: "default", label: "Default (CLI config)" };

/**
 * Sentinel placed in ZCode's `AgentDef.binArgs` where the resolved path to
 * the `zcode.cjs` bundle belongs. Filled at detect time (availability) and
 * invoke time (the actual spawn) by {@link resolveZcodeBin}. Exported so the
 * invoke layer substitutes the same token, not a brittle string literal copy
 * (a typo there would silently spawn the literal). See ADR-0002 decision 3.
 */
export const ZCODE_CJS_SENTINEL = "<resolved-zcode-cjs>";

export type AgentDef = {
  id: string;
  label: string;
  bin: string;
  fallbackBins?: string[];
  envOverride?: string;
  vendor: string;
  protocol?: AgentProtocol;
  /**
   * Extra leading argv spliced between the bin and the protocol argv. Needed
   * for node-script CLIs (e.g. ZCode's `zcode.cjs`) that must be spawned as
   * `node <resolvedCjsPath> app-server` rather than as a standalone exec.
   * Optional and defaults to absent, so existing adapters are unaffected.
   * See ADR-0002 decision 3.
   */
  binArgs?: string[];
  fallbackModels: ModelOption[];
};

export const AGENTS: AgentDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    fallbackBins: ["openclaude"],
    envOverride: "CLAUDE_BIN",
    vendor: "Anthropic",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "sonnet", label: "Sonnet (alias)" },
      { id: "opus", label: "Opus (alias)" },
      { id: "haiku", label: "Haiku (alias)" },
      { id: "claude-opus-4-7", label: "claude-opus-4-7" },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    bin: "openclaw",
    envOverride: "OPENCLAW_BIN",
    vendor: "OpenClaw multi-channel agent gateway",
    protocol: "argv-message",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "openrouter/anthropic/claude-opus-4.7", label: "Opus 4.7 (OpenRouter)" },
      { id: "openrouter/anthropic/claude-sonnet-4.6", label: "Sonnet 4.6 (OpenRouter)" },
      { id: "openrouter/anthropic/claude-haiku-4.5", label: "Haiku 4.5 (OpenRouter)" },
    ],
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    bin: "codex",
    envOverride: "CODEX_BIN",
    vendor: "OpenAI",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.4", label: "gpt-5.4" },
      { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
      { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
      { id: "gpt-5-codex", label: "gpt-5-codex" },
      { id: "gpt-5", label: "gpt-5" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
  },
  {
    id: "cursor-agent",
    label: "Cursor Agent",
    bin: "cursor-agent",
    envOverride: "CURSOR_AGENT_BIN",
    vendor: "Cursor",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "auto", label: "auto" },
      { id: "sonnet-4", label: "sonnet-4" },
      { id: "sonnet-4-thinking", label: "sonnet-4-thinking" },
      { id: "gpt-5", label: "gpt-5" },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    envOverride: "GEMINI_BIN",
    vendor: "Google",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    bin: "copilot",
    envOverride: "COPILOT_BIN",
    vendor: "GitHub",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
      { id: "gpt-5.2", label: "GPT-5.2" },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode-cli",
    fallbackBins: ["opencode"],
    envOverride: "OPENCODE_BIN",
    vendor: "Open",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
      { id: "openai/gpt-5", label: "openai/gpt-5" },
      { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
    ],
  },
  {
    id: "qwen",
    label: "Qwen Coder",
    bin: "qwen",
    envOverride: "QWEN_BIN",
    vendor: "Alibaba",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "qwen3-coder-plus", label: "qwen3-coder-plus" },
      { id: "qwen3-coder-flash", label: "qwen3-coder-flash" },
    ],
  },
  {
    id: "qoder",
    label: "Qoder CLI",
    bin: "qodercli",
    envOverride: "QODER_BIN",
    vendor: "Qoder",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "lite", label: "Lite" },
      { id: "efficient", label: "Efficient" },
      { id: "auto", label: "Auto" },
      { id: "performance", label: "Performance" },
      { id: "ultimate", label: "Ultimate" },
    ],
  },
  {
    id: "codewhale",
    label: "CodeWhale",
    bin: "codewhale",
    fallbackBins: ["deepseek-tui"],
    envOverride: "CODEWHALE_BIN",
    vendor: "CodeWhale",
    protocol: "argv",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
    ],
  },
  {
    id: "deepseek-tui",
    label: "DeepSeek TUI",
    bin: "deepseek-tui",
    fallbackBins: ["codewhale"],
    envOverride: "DEEPSEEK_TUI_BIN",
    vendor: "DeepSeek",
    protocol: "argv",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "deepseek-v4-pro", label: "deepseek-v4-pro" },
      { id: "deepseek-v4-flash", label: "deepseek-v4-flash" },
    ],
  },
  {
    id: "aider",
    label: "Aider",
    bin: "aider",
    vendor: "Aider",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
      { id: "gpt-5", label: "gpt-5" },
      { id: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat" },
    ],
  },
  {
    id: "hermes",
    label: "Hermes",
    bin: "hermes",
    envOverride: "HERMES_BIN",
    vendor: "Mature",
    protocol: "acp",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "openai-codex:gpt-5.5", label: "gpt-5.5 (openai-codex)" },
      { id: "openai-codex:gpt-5.4", label: "gpt-5.4 (openai-codex)" },
    ],
  },
  {
    id: "kimi",
    label: "Kimi CLI",
    bin: "kimi",
    envOverride: "KIMI_BIN",
    vendor: "Moonshot",
    protocol: "acp",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "kimi-k2-turbo-preview", label: "kimi-k2-turbo-preview" },
      { id: "moonshot-v1-8k", label: "moonshot-v1-8k" },
      { id: "moonshot-v1-32k", label: "moonshot-v1-32k" },
    ],
  },
  {
    id: "devin",
    label: "Devin for Terminal",
    bin: "devin",
    envOverride: "DEVIN_BIN",
    vendor: "Cognition",
    protocol: "acp",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "adaptive", label: "adaptive" },
      { id: "swe", label: "swe" },
      { id: "opus", label: "opus" },
      { id: "sonnet", label: "sonnet" },
      { id: "codex", label: "codex" },
      { id: "gpt", label: "gpt" },
      { id: "gemini", label: "gemini" },
    ],
  },
  {
    id: "kiro",
    label: "Kiro CLI",
    bin: "kiro-cli",
    envOverride: "KIRO_BIN",
    vendor: "AWS",
    protocol: "acp",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "kilo",
    label: "Kilo",
    bin: "kilo",
    envOverride: "KILO_BIN",
    vendor: "Kilo",
    protocol: "acp",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "vibe",
    label: "Mistral Vibe CLI",
    bin: "vibe-acp",
    envOverride: "VIBE_BIN",
    vendor: "Mistral",
    protocol: "acp",
    fallbackModels: [DEFAULT_MODEL],
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    envOverride: "PI_BIN",
    vendor: "Inflection",
    protocol: "pi-rpc",
    fallbackModels: [
      DEFAULT_MODEL,
      { id: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "anthropic/claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "openai/gpt-5", label: "GPT-5" },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    ],
  },
  // ZCode (Z.AI) — first app-server protocol agent. Unlike the agents above,
  // its CLI is a node bundle (zcode.cjs) spawned as `node <cjs> app-server`,
  // so bin: "node" and binArgs carries the node-script leading argv. The
  // `<resolved-zcode-cjs>` sentinel is filled by resolveZcodeBin() at detect
  // time (availability) and invoke time (the actual spawn). protocol
  // "app-server" IS implemented (T5/T6), so this entry is never marked
  // unsupported — distinct from the acp/pi-rpc detection-only family above.
  // fallbackModels is the static [DEFAULT_MODEL] floor: a live probe
  // (ADR-0004 / #13) proved the child self-authenticates and resolves its own
  // model, AND that no protocol method exposes a model list, so the picker
  // only needs "Default (CLI config)" — send no --model, let the child's
  // resolved entitlement win. See ADR-0002 decision 2.
  {
    id: "zcode",
    label: "ZCode",
    bin: "node",
    envOverride: "ZCODE_BIN",
    vendor: "Z.AI",
    protocol: "app-server",
    binArgs: [ZCODE_CJS_SENTINEL, "app-server"],
    fallbackModels: [DEFAULT_MODEL],
  },
];

function userToolchainDirs(): string[] {
  const home = homedir();
  const env = process.env;
  const dirs: string[] = [];
  const vp = env.VP_HOME?.trim();
  if (vp) dirs.push(join(vp, "bin"));
  const npmPrefix = env.NPM_CONFIG_PREFIX?.trim();
  if (npmPrefix) {
    dirs.push(join(npmPrefix, "bin"), npmPrefix);
  }
  dirs.push(
    join(home, ".local/bin"),
    join(home, ".vite-plus/bin"),
    join(home, ".opencode/bin"),
    join(home, ".bun/bin"),
    join(home, ".volta/bin"),
    join(home, ".asdf/shims"),
    join(home, "Library/pnpm"),
    join(home, ".cargo/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".npm-packages/bin"),
    join(home, ".claude/local"),
  );
  if (process.platform === "win32") {
    const scoopRoot = env.SCOOP?.trim() || join(home, "scoop");
    const globalScoopRoot = env.SCOOP_GLOBAL?.trim() || "C:\\ProgramData\\scoop";
    const appData = env.APPDATA?.trim();
    dirs.push(
      join(scoopRoot, "shims"),
      join(scoopRoot, "apps", "nodejs", "current"),
      join(scoopRoot, "apps", "nodejs-lts", "current"),
      join(globalScoopRoot, "shims"),
      join(globalScoopRoot, "apps", "nodejs", "current"),
    );
    if (appData) dirs.push(join(appData, "npm"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  return dirs;
}

export function resolveOnPath(bin: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const seen = new Set<string>();
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    ...userToolchainDirs(),
  ].filter((d) => d && !seen.has(d) && (seen.add(d), true));
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d, bin + e);
      try {
        if (existsSync(full)) return full;
      } catch {}
    }
  }
  return null;
}

// ─── Linux install discovery (.deb + AppImage; ADR-0007 / ADR-0010) ────
//
// ZCode's official Linux distributions are the `.deb` package AND the AppImage
// (ADR-0007's "AppImage-only" premise was wrong — corrected by T5 / ADR-0010).
// The two are told apart by a loose `zcode.cjs`:
//   - `.deb` installs to /opt/ZCode/ with a loose resources/glm/zcode.cjs next
//     to the Electron binary (/opt/ZCode/zcode) — the same layout as the
//     Windows/macOS installs, so it is probed the same way (on-disk .cjs).
//   - AppImage is a single compressed squashfs with the .cjs packed inside,
//     reachable only while mounted. There is no loose `.cjs` and no fixed
//     filename (`ZCode-<version>-linux-<arch>.AppImage`), so the AppImage path
//     is read from the XDG `.desktop` entry ZCode writes on first GUI launch
//     (`~/.local/share/applications/zcode.desktop`); its `Exec=` line carries
//     the real path whatever the user named/placed the file. The same bar as
//     login — a user must have run ZCode once — and a freedesktop.org standard
//     honoured by every Linux desktop. See ADR-0007 decision 1 + ADR-0010.

/** Path to the XDG `.desktop` entry ZCode generates on first GUI launch. */
const ZCODE_DESKTOP_PATH = posix.join(
  homedir(),
  ".local",
  "share",
  "applications",
  "zcode.desktop",
);

/**
 * Parse the ZCode AppImage path out of a `.desktop` entry's `Exec=` line.
 * Pure (no I/O) so it can be unit-tested with string fixtures. Returns the
 * AppImage path, or `null` when the line is absent or malformed.
 *
 * ZCode writes an entry like:
 *
 *     [Desktop Entry]
 *     Name=ZCode
 *     Exec=/home/user/Applications/ZCode-3.7.5-linux-x64.AppImage --no-sandbox %U
 *     Icon=zcode
 *     ...
 *
 * The first token after `Exec=` is the AppImage path (whatever the user
 * named/placed the file); trailing flags (`--no-sandbox`, `%U`, …) and the
 * freedesktop field codes are stripped. See ADR-0007 decision 1.
 */
export function parseZcodeDesktopExec(content: string): string | null {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("Exec=")) continue;
    const rest = line.slice("Exec=".length).trim();
    if (!rest) return null;
    // The path is the first token. Per the freedesktop Desktop Entry Spec a
    // path containing a reserved character (space) MUST be quoted, so tokenize
    // with quote-awareness — splitting on whitespace first would truncate
    // `"/home/u/My Apps/ZCode.AppImage"` at the interior space. A quoted token
    // (double or single) yields its inner content; otherwise the leading
    // non-whitespace run is the path. Trailing flags (--no-sandbox, %U, …) and
    // field codes are dropped. Reject a bare field-code token (malformed entry).
    const m = rest.match(/^"([^"]*)"|^'([^']*)'|^(\S+)/);
    const token = m?.[1] ?? m?.[2] ?? m?.[3] ?? "";
    if (!token || token.startsWith("%")) return null;
    return token;
  }
  return null;
}

/**
 * Discover the ZCode AppImage on Linux via the XDG `.desktop` entry ZCode
 * generates on first GUI launch. The `Exec=` line carries the real path
 * whatever the user named/placed the file, so no filename guessing or glob is
 * needed. Returns `null` (never throws) when the entry is missing or malformed
 * — the caller treats that as "ZCode not found". See ADR-0007 decision 1.
 */
export function discoverZcodeAppImage(): string | null {
  try {
    if (!existsSync(ZCODE_DESKTOP_PATH)) return null;
    return parseZcodeDesktopExec(readFileSync(ZCODE_DESKTOP_PATH, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Locate the ZCode CLI binary. Probe order, first match wins (see ADR-0007):
 *   1. `ZCODE_BIN` env var — user override (absolute path, else PATH lookup)
 *   2. `zcode` on PATH — a defensive probe only. ZCode's official Linux
 *      distributions are the `.deb` and the AppImage (ADR-0007 / ADR-0010), so
 *      this rarely hits; it is NOT a supported install shape (no PATH shim is
 *      known to ship with either).
 *   3. Platform default:
 *        Windows : `%ZCODE_WINDOWS_APP_INSTALL_DIR%\resources\glm\zcode.cjs`
 *                  → `C:\Program Files\ZCode\resources\glm\zcode.cjs`
 *        macOS   : `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`
 *        Linux   : on-disk `zcode.cjs` at
 *                  `/opt/ZCode/resources/glm/zcode.cjs` (the `.deb` install —
 *                  same loose-file layout as Windows/macOS); else the AppImage
 *                  path from the `.desktop` `Exec=` line (the `.cjs` lives
 *                  inside the mount, so the AppImage binary doubles as the
 *                  availability signal AND the Electron driver, ADR-0007).
 *
 * On Windows/macOS (and a Linux `.deb`) the returned path IS the `.cjs` bundle.
 * On a Linux AppImage install the platform default is the AppImage binary (the
 * `.cjs` path is computed post-mount in the invoke layer); a `ZCODE_BIN` or
 * on-disk `.cjs` is returned as-is — the invoke layer then uses it directly,
 * no mount (ADR-0010 decision 1).
 *
 * Discovery only — registering ZCode in the `AGENTS` array is T7. Returns
 * `null` (never throws) when nothing is found.
 */
export function resolveZcodeBin(): string | null {
  const env = process.env;
  // 1. Explicit user override.
  const override = env.ZCODE_BIN?.trim();
  if (override) {
    if (existsSync(override)) return override;
    const onPath = resolveOnPath(override);
    if (onPath) return onPath;
  }
  // 2. `zcode` on PATH — defensive probe only; not a supported Linux install
  // (ZCode ships as a `.deb` or AppImage per ADR-0007 / ADR-0010), kept so a
  // hand-placed link still resolves. The override (1) and platform default (3)
  // are the real paths.
  const pathHit = resolveOnPath("zcode");
  if (pathHit) return pathHit;
  // 3. Platform default.
  if (process.platform === "linux") {
    // T5 / ADR-0010: probe the on-disk `.cjs` BEFORE the AppImage mount. A
    // loose resources/glm/zcode.cjs at the install root cleanly distinguishes
    // a `.deb` (or unpacked) install from an AppImage (the `.cjs` is packed in
    // the squashfs, so no loose file sits next to it). The invoke layer's
    // `.cjs`-direct branch (T4) then runs it without mounting.
    for (const candidate of defaultZcodeCjsPaths()) {
      if (existsSync(candidate)) return candidate;
    }
    // AppImage: the `.cjs` lives inside the mount — discover the binary via
    // the `.desktop` entry (availability + Electron driver + mount source).
    const appImage = discoverZcodeAppImage();
    if (appImage && existsSync(appImage)) return appImage;
    return null;
  }
  for (const candidate of defaultZcodeCjsPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Per-platform candidate default paths for ZCode's `zcode.cjs`. Exported only
 * so tests can assert the exact paths probed; callers should use
 * `resolveZcodeBin()`.
 *
 * macOS/Linux paths are built with `posix` separators so they stay
 * forward-slash regardless of the *host* running the probe — these are
 * spec-fixed install locations (see CONTEXT.md → "ZCode install discovery")
 * and must not be rewritten when the host is, say, Windows running a
 * cross-platform unit test. Windows paths keep backslash separators.
 */
export function defaultZcodeCjsPaths(): string[] {
  const platform = process.platform;
  const env = process.env;
  if (platform === "win32") {
    const installDir = env.ZCODE_WINDOWS_APP_INSTALL_DIR?.trim();
    const out: string[] = [];
    if (installDir) {
      out.push(win32.join(installDir, "resources", "glm", "zcode.cjs"));
    }
    out.push(
      win32.join("C:\\Program Files\\ZCode", "resources", "glm", "zcode.cjs"),
    );
    return out;
  }
  if (platform === "darwin") {
    return [posix.join("/Applications/ZCode.app", "Contents", "Resources", "glm", "zcode.cjs")];
  }
  // T5 / ADR-0010: the official `.deb` install lays a loose
  // resources/glm/zcode.cjs at /opt/ZCode/ (same layout as Windows/macOS), so
  // it is probed the same way. An AppImage packs the `.cjs` inside its
  // squashfs (no loose file), so when only the AppImage is installed this
  // candidate misses and resolveZcodeBin() falls back to `.desktop` discovery.
  // See ADR-0007 decision 1 + ADR-0010.
  return [posix.join("/opt/ZCode", "resources", "glm", "zcode.cjs")];
}

/**
 * Resolve the NODE binary that drives `node <zcode.cjs> app-server` for an
 * EXTERNAL caller (#12 / T12). `resolveZcodeBin()` above locates the `.cjs`
 * bundle; this locates the node the `.cjs` is run with — a distinct concern,
 * because html-anything is an external process and on a clean Windows host
 * `where node` finds nothing (only `ZCode.exe` exists).
 *
 * Strategy (proven against a live clean-host probe on 2026-08-10, not guessed):
 *   1. `ZCODE_NODE_BIN` env — explicit user override (absolute path, else PATH).
 *   2. `node` on PATH — system Node. Preferred when present: it needs no
 *      ELECTRON_RUN_AS_NODE env, and is the simplest portable driver.
 *   3. The ZCode Electron executable itself. On a clean host this is the ONLY
 *      node-like binary on the box; under `ELECTRON_RUN_AS_NODE=1` (merged into
 *      the spawn env by the app-server branch, #11) it behaves as node. A live
 *      `ZCode.exe <zcode.cjs> app-server` spawn with that env booted in ~1s and
 *      answered JSON-RPC frames on the probe host. No separate `node.exe`
 *      ships in the install tree (verified by walking it). See
 *      {@link defaultZcodeElectronExePaths} for the per-platform exe locations.
 *
 * Returns a non-empty path (never `null`, never throws). Step 3 — the bundled
 * Electron exe — is the TERMINAL fallback: `detectAgents()` reports
 * `zcode: available:true` only when `resolveZcodeBin()` found `zcode.cjs`, and
 * `zcode.cjs` existing ⟺ ZCode is installed ⟺ the same install directory holds
 * the bundled Electron exe. So for any UI-driven caller the probe hits one of
 * the three steps and the `null` outcome is unreachable; its return type was
 * tightened from `string | null` to `string` (T15 / #18 / ADR-0005 decision 3).
 * The one caller that can still miss all three probes is a hand-crafted
 * `ZCODE_BIN` at an orphaned `.cjs` (no sibling exe, no system node, no
 * `ZCODE_NODE_BIN`) — for that path the resolver returns the canonical install
 * location and lets the spawn's own ENOENT surface the real problem, rather
 * than a misleading "install Node.js" message. If ZCode's install layout ever
 * changes so the exe is no longer co-located with the `.cjs`, the fix is a new
 * probe target here — not a user-facing error.
 */
export function resolveZcodeNodeBin(): string {
  const env = process.env;
  const override = env.ZCODE_NODE_BIN?.trim();
  if (override) {
    if (existsSync(override)) return override;
    const onPath = resolveOnPath(override);
    if (onPath) return onPath;
  }
  const pathNode = resolveOnPath("node");
  if (pathNode) return pathNode;
  // Step 3: the bundled Electron exe is the terminal fallback. The last
  // candidate in defaultZcodeElectronExePaths() is the canonical install
  // location, present whenever the caller reached this code via detectAgents()
  // (zcode.cjs found ⟺ ZCode installed ⟺ exe exists). Return it on the miss
  // path too — see the doc comment above for the orphaned-.cjs rationale.
  if (process.platform === "linux") {
    // T5 / ADR-0010: probe the `.deb` Electron driver (/opt/ZCode/zcode) BEFORE
    // the AppImage. Same role as ZCode.exe on Windows — under
    // ELECTRON_RUN_AS_NODE=1 it acts as node — and a `.deb`-only host has no
    // AppImage to mount, so without this probe it could not drive the `.cjs`.
    // defaultZcodeElectronExePaths() lists the `.deb` driver first; the
    // AppImage is discovered via its `.desktop` entry (the real user-named
    // path, not the canonical guess), and the last candidate is the terminal
    // fallback so the contract (`string`, never null) holds even for a
    // hand-crafted caller that bypassed detect — the spawn's own ENOENT then
    // surfaces the real problem.
    const electronPaths = defaultZcodeElectronExePaths();
    if (existsSync(electronPaths[0])) return electronPaths[0];
    const appImage = discoverZcodeAppImage();
    if (appImage && existsSync(appImage)) return appImage;
    return electronPaths[electronPaths.length - 1];
  }
  const electronPaths = defaultZcodeElectronExePaths();
  for (const candidate of electronPaths) {
    if (existsSync(candidate)) return candidate;
  }
  return electronPaths[electronPaths.length - 1];
}

/**
 * Per-platform candidate default paths for the ZCode Electron executable — the
 * node-driver fallback when no system `node` is on PATH. Exported only so tests
 * can assert the exact paths probed; callers should use `resolveZcodeNodeBin()`.
 *
 * Mirrors {@link defaultZcodeCjsPaths}'s separator discipline: macOS/Linux
 * paths use `posix` separators so they stay forward-slash regardless of the
 * host running a cross-platform unit test; Windows paths keep backslashes.
 * The exe sits at the install root (not under `resources/glm/` like the `.cjs`):
 *   Windows : `<installDir>\ZCode.exe` → `C:\Program Files\ZCode\ZCode.exe`
 *   macOS   : `/Applications/ZCode.app/Contents/MacOS/ZCode`
 *   Linux   : `/opt/ZCode/zcode` (the `.deb` Electron binary) and
 *             `~/Applications/ZCode.AppImage` (the AppImage IS the executable)
 */
export function defaultZcodeElectronExePaths(): string[] {
  const platform = process.platform;
  const env = process.env;
  if (platform === "win32") {
    const installDir = env.ZCODE_WINDOWS_APP_INSTALL_DIR?.trim();
    const out: string[] = [];
    if (installDir) {
      out.push(win32.join(installDir, "ZCode.exe"));
    }
    out.push(win32.join("C:\\Program Files\\ZCode", "ZCode.exe"));
    return out;
  }
  if (platform === "darwin") {
    return [posix.join("/Applications/ZCode.app", "Contents", "MacOS", "ZCode")];
  }
  // T5 / ADR-0010: the `.deb` install ships /opt/ZCode/zcode (the Electron
  // binary, driven under ELECTRON_RUN_AS_NODE=1 as node); the AppImage is itself
  // the executable. The `.deb` driver is listed first so resolveZcodeNodeBin()
  // probes it before AppImage discovery.
  return [
    posix.join("/opt/ZCode", "zcode"),
    posix.join(homedir(), "Applications", "ZCode.AppImage"),
  ];
}

export type DetectedAgent = {
  id: string;
  label: string;
  vendor: string;
  available: boolean;
  path?: string;
  resolvedBin?: string;
  protocol: AgentProtocol;
  models: ModelOption[];
  unsupported?: boolean;
};

export function detectAgents(): DetectedAgent[] {
  return AGENTS.map((a): DetectedAgent => {
    const protocol = a.protocol ?? "stdin";
    // "app-server" (ZCode) is implemented in T5/T6 — NOT unsupported, unlike
    // the acp/pi-rpc family which is detection-only.
    const unsupported = protocol === "acp" || protocol === "pi-rpc";
    const base = {
      id: a.id,
      label: a.label,
      vendor: a.vendor,
      protocol,
      models: a.fallbackModels,
      unsupported: unsupported || undefined,
    };

    // ZCode's CLI is a .cjs bundle, not a standalone exec on PATH — its
    // availability is driven by resolveZcodeBin() (which already honours
    // ZCODE_BIN, PATH, and platform defaults). The generic PATH branch below
    // would wrongly report `node` (bin) as the install, so ZCode gets its own
    // detection: available iff the .cjs resolves. resolvedBin is the node
    // driver the spawn path will use (node <cjs> app-server): resolveZcodeNodeBin()
    // (the real node or Electron-exe fallback). T15 (#18 / ADR-0005 decision 3)
    // tightened that resolver's return to `string` — the Electron-exe fallback
    // is terminal and present whenever detect passed (zcode.cjs found ⟺ ZCode
    // installed ⟺ exe exists), so there is no null to coalesce here.
    //
    // #19 / ADR-0005 decision 4: the picker is populated DYNAMICALLY from
    // ~/.zcode/v2/config.json when ZCode is available. The read is gated on
    // the same availability (an unavailable install keeps the static
    // [DEFAULT_MODEL] floor, so the picker never crashes on a missing config).
    // readZcodeModelPicker() filters to enabled providers with no
    // systemDisabledReason (the GUI's resolved, usable set) and returns each
    // model with its providerId; DEFAULT_MODEL is prepended (= no `model` field
    // → workspace default wins). model-providers.json is deliberately NOT
    // read (static catalog with empty apiKeys → would offer unusable models).
    if (protocol === "app-server") {
      const cjs = resolveZcodeBin();
      if (cjs) {
        const { models: pickerModels } = readZcodeModelPicker();
        return {
          ...base,
          available: true,
          path: cjs,
          resolvedBin: resolveZcodeNodeBin(),
          // [DEFAULT_MODEL] floor + each enabled provider's models (carrying
          // providerId for the invoke-layer {providerId, modelId} resolution).
          models: [DEFAULT_MODEL, ...pickerModels],
        };
      }
      return { ...base, available: false };
    }

    const override = a.envOverride ? process.env[a.envOverride] : undefined;
    if (override) {
      if (existsSync(override)) {
        return { ...base, available: true, path: override, resolvedBin: a.bin };
      }
      const p = resolveOnPath(override);
      if (p) {
        return { ...base, available: true, path: p, resolvedBin: override };
      }
    }
    const candidates = [a.bin, ...(a.fallbackBins ?? [])];
    for (const c of candidates) {
      const p = resolveOnPath(c);
      if (p) {
        return { ...base, available: true, path: p, resolvedBin: c };
      }
    }
    return { ...base, available: false };
  });
}