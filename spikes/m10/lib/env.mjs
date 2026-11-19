// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The environment a spike hands a CLI (C4), and the record of what it removed (C9).
//
// Stricter than the app: spikes run inside an agent session that injects ANTHROPIC_BASE_URL and
// some twenty CLAUDE* variables, and the app's policy passes ANTHROPIC_* through. Only names are
// ever recorded, never values.

const REMOVE = /^(CLAUDE|ANTHROPIC|DEBUG|ELECTRON_)|^NODE_OPTIONS$/i;

/** The SDK's identity variables. Never set by a spike; also removed by REMOVE if inherited. */
export const SDK_IDENTITY_VARIABLES = Object.freeze(['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION']);

/** The one variable a single labelled T6 run may set itself (C65). No other run sets a CLAUDE* name. */
export const QUESTION_TOOL_VARIABLE = 'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL';

/**
 * The app's policy for Claude children, copied from src/main/providers/claude/environment.ts. The
 * self-test reads that file as text and fails if these lists drift from it.
 */
export const APP_CLAUDE_POLICY = Object.freeze({
  removePrefixes: ['CLAUDE_'],
  keepNames: [
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
    'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
    'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  ],
  keepPrefixes: ['CLAUDE_CODE_USE_'],
  removeNames: [
    'CLAUDECODE',
    'DEBUG_CLAUDE_AGENT_SDK', 'DEBUG', 'DEBUG_SDK', 'CLAUDE_CODE_DEBUG_LOGS_DIR', 'CLAUDE_CODE_DEBUG_LOG_LEVEL',
    'CLAUDE_CODE_DIAGNOSTICS_FILE', 'ANTHROPIC_LOG',
  ],
});

/** Codex children lose only what `sanitizeEnv` in src/main/process/env.ts drops. */
const APP_BASE_REMOVE = /^(ELECTRON_.*|NODE_OPTIONS)$/i;

/** Would the app's own policy for `cli` have passed `name` to the child? */
export function appWouldKeep(cli, name) {
  if (APP_BASE_REMOVE.test(name)) return false;
  if (cli !== 'claude') return true;
  const upper = name.toUpperCase();
  const p = APP_CLAUDE_POLICY;
  if (p.removeNames.includes(upper)) return false;
  const starts = (prefixes) => prefixes.some((prefix) => upper.startsWith(prefix));
  if (starts(p.removePrefixes) && !p.keepNames.includes(upper) && !starts(p.keepPrefixes)) return false;
  return true;
}

/**
 * The clean environment for one launch. `extra` may only name QUESTION_TOOL_VARIABLE; anything
 * else is a defect in the spike and throws.
 */
export function cleanEnvironment(cli, { source = process.env, extra = {} } = {}) {
  const env = {};
  const removed = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (REMOVE.test(name)) {
      removed.push({ name, appWouldHaveKept: appWouldKeep(cli, name) });
      continue;
    }
    env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (name !== QUESTION_TOOL_VARIABLE) throw new Error(`a spike may not set ${name}`);
    env[name] = String(value);
  }
  for (const name of SDK_IDENTITY_VARIABLES) {
    if (Object.keys(env).some((key) => key.toUpperCase() === name)) throw new Error(`identity variable ${name} survived`);
  }
  removed.sort((a, b) => a.name.localeCompare(b.name));
  return { env, removed, set: Object.keys(extra) };
}
