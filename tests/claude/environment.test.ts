// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a Claude child inherits (decision 0006; docs/planning/_archive/M16.md, V26, V37; C11, C66, C81): the
// policy as a function of the inherited environment. That each kept name reaches a real usage
// session's and a real chat session's process is tests/claude/provider.integration.test.ts's and
// tests/claude/chat/start.integration.test.ts's, against the fake CLI.
import { describe, expect, it } from 'vitest';
import { constrainEnvironment } from '../../src/main/process/env';
import { CLAUDE_CHILD_ENVIRONMENT, CLAUDE_KEPT_VARIABLES, DEBUG_LOGGING_VARIABLES } from '../../src/main/providers/claude/environment';

/**
 * Names observed in a shell launched from inside a Claude desktop session (values synthetic): for
 * M7b, and again for M16's review. Two of them, `CLAUDE_CODE_DISABLE_CRON`
 * and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, are settings the CLI's documentation lists as the
 * user's: a host sets them for the sessions it embeds, so they say nothing of the user's own wish.
 */
const PARENT_SESSION = [
  'CLAUDECODE', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_DESKTOP_APP_VERSION', 'CLAUDE_CODE_DISABLE_CRON',
  'CLAUDE_CODE_EAGER_FLUSH', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
  'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES', 'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ORGANIZATION_UUID', 'CLAUDE_CODE_REPORT_FINDINGS', 'CLAUDE_CODE_TERMINAL_MCP_TOOLS', 'CLAUDE_EFFORT',
];
const PERSISTENT = {
  CLAUDE_CONFIG_DIR: 'C:\\claude-config', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
  CLAUDE_CODE_OAUTH_TOKEN: 'user-token', ANTHROPIC_BASE_URL: 'https://gateway.example', HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost', PATH: 'C:\\bin',
};

/** The list the review recorded (src/main/providers/claude/environment.ts): 76 names. */
const REVIEWED = [
  // Where the configuration is, and how the CLI signs in.
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH', 'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH', 'CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS',
  'CLAUDE_CODE_SKIP_AWS_CRED_CACHE', 'CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK',
  // Backends.
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  // The network path.
  'CLAUDE_CODE_CERT_STORE', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS', 'CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION',
  'CLAUDE_CODE_MAX_RETRIES', 'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK', 'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS', 'CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS',
  'CLAUDE_ENABLE_STREAM_WATCHDOG', 'CLAUDE_ENABLE_BYTE_WATCHDOG', 'CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK', 'CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_DEFAULT', 'CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS', 'CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING',
  'CLAUDE_CODE_GATEWAY_HINT_HEADERS', 'CLAUDE_CODE_PROPAGATE_TRACEPARENT', 'CLAUDE_CODE_ATTRIBUTION_HEADER',
  // What leaves the machine, and what the CLI's own children inherit and may run.
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_MCP_ALLOWLIST_ENV', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CODE_SCRIPT_CAPS',
  'CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY', 'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
  // Where the rest of the configuration is, and how it is read and run.
  'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CODE_PLUGIN_SEED_DIR', 'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION', 'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH',
  'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_SHELL_PREFIX',
  // Instructions and memory.
  'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
  'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS', 'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  // How a conversation is run.
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_PROMPT_CACHE_TTL', 'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
  'CLAUDE_CODE_GLOB_HIDDEN', 'CLAUDE_CODE_GLOB_NO_IGNORE', 'CLAUDE_CODE_GLOB_TIMEOUT_SECONDS',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
  'CLAUDE_CODE_MCP_STARTUP_WAIT_MS', 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', 'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH',
  'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP',
];

/**
 * What C81 rules out, from the CLI's documented variables: each decides, or would hold in place,
 * something a chat session's launch fixes. The review keeps none of them, whatever its other
 * merits. The identity variables are no setting at all: they would misname fat-g to the CLI.
 */
const RULED_OUT: Readonly<Record<string, readonly string[]>> = {
  'the model': [
    'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP',
    'CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK', 'CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK', 'CLAUDE_CODE_SKIP_MODEL_ACCESS_MEMORY',
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'CLAUDE_CODE_EXTRA_BODY', 'CLAUDE_CODE_DISABLE_FAST_MODE',
    'CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS', 'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK',
  ],
  'the effort': ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', 'CLAUDE_CODE_DISABLE_THINKING'],
  'the tools': [
    'CLAUDE_CODE_USE_POWERSHELL_TOOL', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_RESTRICTED', 'CLAUDE_CODE_DISABLE_WEB_FETCH',
    'CLAUDE_CODE_DISABLE_ARTIFACT', 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_ENABLE_TODO_TOOLS',
    'CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS', 'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS', 'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
    'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS', 'CLAUDE_CODE_DISABLE_POLICY_SKILLS', 'CLAUDE_CODE_DISABLE_WORKFLOWS', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
    'CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_DISABLE_CRON',
  ],
  'the permission mode': [
    'CLAUDE_CODE_AUTO_MODE_SERVER', 'CLAUDE_CODE_ENABLE_AUTO_MODE', 'CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT', 'CLAUDE_CODE_DISABLE_INLINE_SHELL_RM_PROMPT',
    'CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT', 'CLAUDE_CODE_DISABLE_POWERSHELL_CMD_RM_DENY', 'CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS',
    'CLAUDE_CODE_PERFORCE_MODE', 'CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS',
  ],
  'background tasks': [
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'CLAUDE_AUTO_BACKGROUND_TASKS', 'CLAUDE_CODE_BG_TASKS_REPORT_RUNNING', 'CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF',
    'CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP', 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS', 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS',
    'CLAUDE_CODE_WORKER_CHECKIN_SCHEDULE', 'CLAUDE_DISABLE_ADOPT', 'CLAUDE_CODE_DISABLE_AGENT_VIEW', 'CLAUDE_CODE_GOAL_CHECKIN_MINUTES',
    'CLAUDE_CODE_EXIT_AFTER_STOP_DELAY',
  ],
  'session persistence': [
    'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
    'CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS', 'CLAUDE_CODE_RESUME_PROMPT', 'CLAUDE_CODE_TRANSCRIPT_LOCAL_GC', 'CLAUDE_CODE_PROJECT_DIR_NAME',
  ],
  // Not C81's, and ruled out all the same: what changes the frames a session sends, and what can export its content.
  'the frames a session sends, and its content': [
    'CLAUDE_CODE_STARTUP_FAILURE_RESULTS', 'CLAUDE_CODE_FORWARD_SUBAGENT_TEXT', 'CLAUDE_CODE_MAX_TURNS', 'CLAUDE_CODE_RETRY_WATCHDOG',
    'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_OTEL_DIAG_STDERR', 'CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE', 'CLAUDE_ENV_FILE',
  ],
};
const IDENTITY = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION'];

const kept = (inherited: Record<string, string>, platform: 'win32' | 'linux'): string[] => Object.keys(constrainEnvironment(inherited, CLAUDE_CHILD_ENVIRONMENT, platform)).sort();

describe('Claude child environment', () => {
  it('drops parent-session metadata and logging switches but keeps persistent settings and proxies', () => {
    const inherited = {
      ...Object.fromEntries(PARENT_SESSION.map((name) => [name, `inherited-${name}`])),
      ...Object.fromEntries(DEBUG_LOGGING_VARIABLES.map((name) => [name, '1'])),
      ...PERSISTENT,
    };
    for (const platform of ['win32', 'linux'] as const) {
      expect(constrainEnvironment(inherited, CLAUDE_CHILD_ENVIRONMENT, platform)).toEqual(PERSISTENT);
    }
  });

  it('catches Windows case variants of session markers and debug switches', () => {
    const inherited = { claudecode: '1', Claude_Code_Messaging_Token: 'secret', debug: '1', Debug_Claude_Agent_Sdk: '1', claude_config_dir: 'C:\\cfg' };
    expect(constrainEnvironment(inherited, CLAUDE_CHILD_ENVIRONMENT, 'win32')).toEqual({ CLAUDE_CONFIG_DIR: 'C:\\cfg' });
  });

  it('never lets a child identify fat-g as the Agent SDK, however the marker is spelled (decision 0006)', () => {
    const markers = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', claude_agent_sdk_version: '0.3.278', Claude_Code_Entrypoint: 'sdk-ts' };
    expect(constrainEnvironment({ ...markers, PATH: 'C:\\bin' }, CLAUDE_CHILD_ENVIRONMENT, 'win32')).toEqual({ PATH: 'C:\\bin' });
    expect(constrainEnvironment({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.278' }, CLAUDE_CHILD_ENVIRONMENT, 'linux')).toEqual({});
  });
});

describe('the keep list’s review for a chat session (M16, V26, V37; C66, C81)', () => {
  it('keeps exactly the names the review recorded, each once, and by name alone', () => {
    const names = Object.values(CLAUDE_KEPT_VARIABLES).flat();
    expect([...names].sort()).toEqual([...REVIEWED].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(76);
    expect([...(CLAUDE_CHILD_ENVIRONMENT.keepNames ?? [])].sort()).toEqual([...REVIEWED].sort());
    // No prefix keeps a name the review has not read: a prefix once kept a tool's switch with the backends.
    expect(CLAUDE_CHILD_ENVIRONMENT.keepPrefixes).toBeUndefined();
    expect(CLAUDE_CHILD_ENVIRONMENT.removePrefixes).toEqual(['CLAUDE_']);
    for (const name of names) expect(name).toMatch(/^CLAUDE_[A-Z0-9_]+$/);
  });

  it('lets each kept name through to a child, on both kinds of platform, with the sheet’s own example among them', () => {
    const inherited = Object.fromEntries(REVIEWED.map((name) => [name, `set-${name}`]));
    for (const platform of ['win32', 'linux'] as const) expect(kept(inherited, platform)).toEqual([...REVIEWED].sort());
    expect(REVIEWED).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
    // Spelled another way on Windows, it is the same name.
    expect(kept({ claude_code_disable_nonessential_traffic: '1' }, 'win32')).toEqual(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']);
  });

  it('keeps no variable that decides what the launch fixes (C81), and none that names fat-g, a parent session or a debug log', () => {
    const ruledOut = Object.values(RULED_OUT).flat();
    expect(new Set(ruledOut).size).toBe(ruledOut.length);
    for (const [what, names] of Object.entries(RULED_OUT)) {
      expect(names.filter((name) => REVIEWED.includes(name)), what).toEqual([]);
      // Exported, each is dropped before any child is started.
      expect(kept(Object.fromEntries(names.map((name) => [name, '1'])), 'linux'), what).toEqual([]);
      expect(kept(Object.fromEntries(names.map((name) => [name.toLowerCase(), '1'])), 'win32'), what).toEqual([]);
    }
    for (const name of [...IDENTITY, ...PARENT_SESSION, ...DEBUG_LOGGING_VARIABLES]) expect(REVIEWED, name).not.toContain(name);
    // The launch's own variable is set by the launch, never inherited: a user's `0` does not reach a session.
    expect(REVIEWED).not.toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
  });

  it('drops a `CLAUDE_` name nobody has reviewed, a backend-looking one among them', () => {
    expect(kept({ CLAUDE_CODE_USE_SOMETHING_NEW: '1', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', CLAUDE_CODE_BRAND_NEW_SETTING: '1', CLAUDE_UNHEARD_OF: '1', CLAUDE_CODE_USE_BEDROCK: '1' }, 'linux')).toEqual(['CLAUDE_CODE_USE_BEDROCK']);
  });
});
