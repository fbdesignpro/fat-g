// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a Claude child may inherit. fat-g runs no Anthropic library in its own process (decision
// 0006), so this is purely the children's policy: every `--version`, `auth status`, control session
// and chat session gets it through the provider scope.
import type { EnvironmentConstraints } from '@shared/provider-kit/process';

/**
 * Debug-logging switches a debugging shell may export (first audited for Agent SDK 0.3.278 in M7).
 * A child that inherited them could write raw protocol traffic — account and usage data — to disk
 * or stderr, so no Claude child ever receives them.
 */
export const DEBUG_LOGGING_VARIABLES = [
  'DEBUG_CLAUDE_AGENT_SDK', 'DEBUG', 'DEBUG_SDK', 'CLAUDE_CODE_DEBUG_LOGS_DIR', 'CLAUDE_CODE_DEBUG_LOG_LEVEL',
  'CLAUDE_CODE_DIAGNOSTICS_FILE', 'ANTHROPIC_LOG',
] as const;

/**
 * The inherited `CLAUDE_*` variables every Claude child keeps, by what they are about.
 *
 * Reviewed for a chat session (docs/planning/_archive/M16.md, Design 3; C66, C81), against the
 * 239 `CLAUDE*` variables the CLI's public documentation lists
 * (https://code.claude.com/docs/en/env-vars) and against the installed CLI, 2.1.268. Until then
 * the list had been reviewed for an idle session that runs no turn, and a chat session would have
 * ignored what the user exported for the CLI. A name is kept when all three hold:
 *
 *   1. it is a standing setting of the user's, for something a session fat-g starts has: a sign-in,
 *      a network path, a conversation without a terminal;
 *   2. it carries nothing of a parent session: the CLI and its hosts export session ids, a
 *      messaging socket and token, an entrypoint, and settings of their own for the sessions they
 *      embed, under names the documentation lists as the user's too;
 *   3. it leaves alone what the launch fixes (C81): the model, the effort, the tools, the
 *      permission mode, background tasks, session persistence.
 *
 * Not kept, by group: what the CLI or a host sets by itself (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
 * `CLAUDE_EFFORT`, `CLAUDE_PID`, …), and two documented settings a parent session was seen to
 * export, `CLAUDE_CODE_DISABLE_CRON` and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`; whatever decides a
 * thing the launch fixes, a variable that would hold the launch's own choice in place among them;
 * the terminal, IDE, Remote Control, plugin-marketplace and scheduling settings, which have no
 * subject here; telemetry, which can export a session's content and raw requests as the debug
 * switches do; and whatever changes the frames a session sends or ends its process by itself.
 * Backends are kept by name, where a `CLAUDE_CODE_USE_` prefix kept them: the prefix also kept a
 * switch for a tool. Six kept names are of later versions than the one installed, and do nothing
 * until the CLI updates itself.
 *
 * tests/claude/environment.test.ts pins this list, and holds it clear of what C81 rules out.
 */
export const CLAUDE_KEPT_VARIABLES = {
  /** Where the configuration is, and how the CLI signs in (kept since M7). */
  signIn: [
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
    'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    'CLAUDE_CODE_SKIP_MANTLE_AUTH', 'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS',
    'CLAUDE_CODE_SKIP_AWS_CRED_CACHE', 'CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK',
  ],
  /** Backend selection: kept so authentication status stays truthful. */
  backends: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS'],
  /** The network path: certificates, retries, the stream watchdogs, and what a gateway needs. */
  network: [
    'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION',
    'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', 'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
    'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS',
    'CLAUDE_ENABLE_STREAM_WATCHDOG', 'CLAUDE_ENABLE_BYTE_WATCHDOG', 'CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK', 'CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS',
    'CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_DEFAULT', 'CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD',
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS', 'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING',
    'CLAUDE_CODE_GATEWAY_HINT_HEADERS', 'CLAUDE_CODE_PROPAGATE_TRACEPARENT', 'CLAUDE_CODE_ATTRIBUTION_HEADER',
  ],
  /** What leaves the machine, and what the CLI's own children — hooks, MCP servers — inherit and may run. */
  restraint: [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_MCP_ALLOWLIST_ENV', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CODE_SCRIPT_CAPS',
    'CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
  ],
  /** Where the rest of the user's configuration is, and how the CLI reads and runs it. */
  configuration: [
    'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PLUGIN_SEED_DIR', 'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION', 'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH',
    'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SHELL_PREFIX',
  ],
  /** Which instructions and memory a session loads. */
  instructions: [
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
    'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS', 'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  ],
  /** How a conversation is run — its limits, its compaction, its cache — in what the launch does not fix. */
  conversation: [
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT',
    'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
    'CLAUDE_CODE_GLOB_HIDDEN', 'CLAUDE_CODE_GLOB_NO_IGNORE', 'CLAUDE_CODE_GLOB_TIMEOUT_SECONDS',
    'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
    'CLAUDE_CODE_MCP_STARTUP_WAIT_MS', 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH',
    'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP',
  ],
} as const;

/**
 * Every Claude child. Inherited `CLAUDE_*` keys are parent-session metadata unless reviewed above as
 * persistent user settings: a parent Claude session exports its session ids, entrypoint and a
 * private messaging socket and token — and an entrypoint or SDK version would also misidentify fat-g
 * to the CLI. Proxies and `ANTHROPIC_*` settings pass through; the CLI, not fat-g, decides what they
 * mean.
 */
export const CLAUDE_CHILD_ENVIRONMENT: EnvironmentConstraints = {
  removePrefixes: ['CLAUDE_'],
  keepNames: Object.values(CLAUDE_KEPT_VARIABLES).flat(),
  // `CLAUDECODE` marks a parent session and has no underscore, so the prefix rule would miss it.
  removeNames: ['CLAUDECODE', ...DEBUG_LOGGING_VARIABLES],
};
