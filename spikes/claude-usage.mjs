// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// S1 spike — Claude usage allocations via the Agent SDK control channel.
// Setup:  npm install --prefix spikes
// Usage:  node spikes/claude-usage.mjs [--path <claude executable>] [--probes 3] [--try-slash-usage]
//
// Decides docs/decisions/0001-claude-usage-tier.md. Questions:
//   1. Does the experimental usage control request work on an IDLE query (no prompt ever sent)?
//   2. Does it spend tokens? (no assistant/result messages; utilization stable across probes)
//   3. Latency, clean exit, and: is a session transcript written for the neutral cwd?
//   4. accountInfo() shape; behaviour when logged out / on an API key.
//   5. utilization scale (0-100 vs 0-1) and resets_at format.
//   6. (opt-in, --try-slash-usage) is `/usage` as a prompt handled locally? MAY SPEND TOKENS if it is not.
//
// Per docs/decisions/0004: the user's own unmodified `claude` binary makes every authenticated call.
// This script never reads credential files; the only thing it looks at under the Claude config dir
// is the *names* of project folders, to detect whether our own probe left a transcript behind.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { knownDirsFor, parseArgs, redact, resolveExecutable, run, saveRaw, sleep, withTimeout } from './lib.mjs';

// The one place this unstable name appears (mirrors src/main/providers/claude/usage-experimental.ts later).
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

const args = parseArgs();
const probes = Number(args.probes ?? 3);
const report = { startedAt: new Date().toISOString(), platform: process.platform, findings: {} };

const exe = resolveExecutable('claude', { override: args.path, knownDirs: knownDirsFor('claude') });
if (!exe) {
  console.error('claude not found (PATH + known dirs). Install it or pass --path <file>.');
  process.exit(2);
}
report.executable = exe;
report.version = (await run(exe, ['--version'])).stdout;
const auth = await run(exe, ['auth', 'status']);
report.authStatus = { exitCode: auth.code, json: safeJson(auth.stdout), text: auth.stdout ? undefined : auth.stderr };
console.log('executable :', redact(exe));
console.log('version    :', report.version);
console.log('auth status:', JSON.stringify(redact(report.authStatus)));
if (auth.code !== 0) console.log('NOTE: not logged in — continuing to record logged-out behaviour. Run `claude auth login` yourself, then re-run.');

let query;
try {
  ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
} catch {
  console.error('\nAgent SDK not installed. Run:  npm install --prefix spikes');
  process.exit(2);
}

// Neutral cwd: never probe from inside a user project.
const probeCwd = path.join(tmpdir(), 'fat-g-spike-probe-cwd');
mkdirSync(probeCwd, { recursive: true });
const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'projects');
const transcriptDirs = () =>
  existsSync(projectsDir) ? readdirSync(projectsDir).filter((name) => name.toLowerCase().includes('fat-g-spike-probe-cwd')) : [];
const transcriptsBefore = transcriptDirs();

// Streaming input that never yields a user message → the session stays idle until we release it.
let release;
const released = new Promise((resolve) => (release = resolve));
async function* idleInput() {
  await released;
}

const seen = [];
const tOpen = Date.now();
const q = query({
  prompt: idleInput(),
  options: {
    pathToClaudeCodeExecutable: exe.path,
    cwd: probeCwd,
    settingSources: [],
    // `settingSources: []` alone does NOT keep MCP servers out (first run saw 4). Compare with --no-strict-mcp.
    ...(args['no-strict-mcp'] ? {} : { strictMcpConfig: true, mcpServers: {} }),
  },
});
report.findings.strictMcpConfig = !args['no-strict-mcp'];
const drained = (async () => {
  try {
    for await (const message of q) seen.push({ type: message.type, subtype: message.subtype, atMs: Date.now() - tOpen });
  } catch (error) {
    seen.push({ type: 'stream-error', message: String(error?.message ?? error) });
  }
})();

report.findings.queryMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(q) ?? {})
  .concat(Object.keys(q))
  .filter((name) => typeof q[name] === 'function' && name !== 'constructor');
report.findings.usageMethodPresent = typeof q[USAGE_METHOD] === 'function';

try {
  const tAcct = Date.now();
  report.accountInfo = await withTimeout(q.accountInfo(), 15_000, 'accountInfo()');
  report.findings.accountInfoMs = Date.now() - tAcct;
} catch (error) {
  report.findings.accountInfoError = String(error.message ?? error);
}

// Did `settingSources: []` keep the user's own MCP servers / hooks out of the probe session?
// Counts only — server and hook names are the user's business.
for (const [finding, method] of [['mcpServerCount', 'mcpServerStatus'], ['hooksListing', 'getHooksListing']]) {
  if (typeof q[method] !== 'function') continue;
  try {
    const result = await withTimeout(q[method](), 10_000, `${method}()`);
    report.findings[finding] = Array.isArray(result) ? result.length : countLeaves(result);
    if (method === 'mcpServerStatus' && Array.isArray(result)) {
      report.findings.mcpServerKinds = result.map((s) => `${s.scope ?? s.config?.type ?? 'unknown-scope'}:${s.status ?? 'unknown-status'}`);
    }
  } catch (error) {
    report.findings[finding] = `error: ${String(error.message ?? error)}`;
  }
}

report.usageProbes = [];
if (report.findings.usageMethodPresent) {
  for (let i = 0; i < probes; i++) {
    const t = Date.now();
    try {
      const usage = await withTimeout(q[USAGE_METHOD]({ skipBehaviors: true }), 15_000, 'usage()');
      report.usageProbes.push({ ms: Date.now() - t, usage });
    } catch (error) {
      report.usageProbes.push({ ms: Date.now() - t, error: String(error.message ?? error) });
      break;
    }
    if (i < probes - 1) await sleep(1500);
  }
  const fiveHour = report.usageProbes.map((p) => p.usage?.rate_limits?.five_hour?.utilization).filter((v) => v != null);
  report.findings.fiveHourUtilizationAcrossProbes = fiveHour;
  report.findings.utilizationStable = fiveHour.length > 1 ? new Set(fiveHour).size === 1 : null;
  report.findings.rateLimitsAvailable = report.usageProbes[0]?.usage?.rate_limits_available ?? null;
  report.findings.windowKeys = Object.keys(report.usageProbes[0]?.usage?.rate_limits ?? {});
}
report.findings.messagesWhileIdle = seen.map((m) => `${m.type}${m.subtype ? ':' + m.subtype : ''}`);
report.findings.modelTurnObservedWhileIdle = seen.some((m) => m.type === 'assistant' || m.type === 'result');

// --- shutdown ------------------------------------------------------------------------
const tClose = Date.now();
release();
try {
  if (typeof q.close === 'function') await q.close();
  else await q.return?.();
} catch (error) {
  report.findings.closeError = String(error.message ?? error);
}
const closedCleanly = await Promise.race([drained.then(() => true), sleep(10_000).then(() => false)]);
report.findings.closedCleanly = closedCleanly;
report.findings.closeMs = Date.now() - tClose;
report.findings.transcriptDirsCreated = transcriptDirs().filter((name) => !transcriptsBefore.includes(name));

// --- optional Tier 2 check -------------------------------------------------------------
if (args['try-slash-usage']) {
  console.log('\n--try-slash-usage: sending "/usage" as a prompt (may spend tokens if not handled locally)…');
  const tier2 = { messages: [] };
  try {
    const q2 = query({ prompt: '/usage', options: { pathToClaudeCodeExecutable: exe.path, cwd: probeCwd, settingSources: [], maxTurns: 1 } });
    await withTimeout(
      (async () => {
        for await (const message of q2) {
          tier2.messages.push({
            type: message.type,
            subtype: message.subtype,
            hasUsageReport: Boolean(message.usage_report),
            usage_report: message.usage_report,
            total_cost_usd: message.total_cost_usd,
            usage: message.type === 'result' ? message.usage : undefined,
          });
        }
      })(),
      60_000,
      '/usage prompt',
    );
  } catch (error) {
    tier2.error = String(error.message ?? error);
  }
  report.tier2 = tier2;
  report.findings.tier2HasUsageReport = tier2.messages.some((m) => m.hasUsageReport);
  report.findings.tier2CostUsd = tier2.messages.find((m) => m.type === 'result')?.total_cost_usd ?? null;
}

report.seen = seen;
const file = saveRaw('claude', report);
console.log('\n=== findings ===');
console.log(JSON.stringify(redact(report.findings), null, 2));
console.log('\n=== accountInfo (redacted) ===');
console.log(JSON.stringify(redact(report.accountInfo ?? null), null, 2));
console.log('\n=== first usage probe (redacted; `session`/`behaviors` omitted) ===');
const firstUsage = report.usageProbes[0]?.usage;
console.log(JSON.stringify(redact(firstUsage ? { ...firstUsage, session: undefined, behaviors: undefined } : report.usageProbes[0] ?? null), null, 2));
console.log(`\nRaw UNREDACTED output (gitignored): ${file}`);
process.exit(0);

function countLeaves(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + Math.max(1, countLeaves(item)), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + countLeaves(item), 0);
  return 0;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
