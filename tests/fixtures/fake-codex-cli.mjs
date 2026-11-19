// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Deterministic CLI used only by smoke/tests through Codex's real adapter and process layer.
//
// FATG_SMOKE_CODEX_ACCOUNTS  optional (M14b, C54): a JSON file of the accounts, by home. Its keys are
//   the values CODEX_HOME may have; the fake uses that value as a key only and opens nothing in the
//   folder. An entry:
//     { "state": "subscription" | "logged-out", "email", "plan",
//       "usage": { "primary", "secondary" } (used percents),
//       "models": [ids of the captured models it lists],
//       "efforts": { "<model id>": [captured levels it lists] },
//       "sandbox": "ready" | "none" (M22: the account's own sandbox state; `none` unless given) }
//   A home with no entry reads as not signed in. With the variable unset the entry is the one under
//   "default", and without one the fake answers as it does with no such file: one fixed account.
//   The control file's counters (a crash, a hung request) are taken only by a process started with
//   no home: two accounts' processes run at once, and a counter must reach the one a test means.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReplay } from './codex/replay.mjs';

// The `model/list` reply of M10's discovery capture, checked again (M13).
const MODEL_LIST = JSON.parse(readFileSync(path.join(import.meta.dirname, 'codex', 'model-list.json'), 'utf8'));
const command = process.argv[2];
if (command === '--version') {
  process.stdout.write('codex-cli 0.155.1\n');
  process.exit(0);
}
if (command !== 'app-server') process.exit(2);

const pidFile = process.env.FATG_SMOKE_PIDS;
// Identity is the PID plus this process's start time (PIDs are recycled); a normal exit is
// recorded beside the ledger, so only processes fat-g had to kill need proving gone.
const started = Date.now();
if (pidFile) {
  appendFileSync(pidFile, `${process.pid} ${started}\n`);
  process.on('exit', () => appendFileSync(`${pidFile}.exited`, `${process.pid} ${started}\n`));
}
const accountStateFile = process.env.FATG_SMOKE_CODEX_ACCOUNT_STATE;
const controlFile = process.env.FATG_SMOKE_CODEX_CONTROL;
// Deliberately cached at process start: smoke proves ordinary reads cannot be assumed to reload
// externally changed authentication, while provider redetection starts a fresh process that does.
const accountState = readText(accountStateFile, 'subscription');
// The home this process was started with, as a value only.
const home = (() => {
  const name = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === 'CODEX_HOME');
  const value = name === undefined ? undefined : process.env[name];
  return value === undefined || value === '' ? undefined : value;
})();
/** One folder under two spellings is one key: a trailing separator, and on Windows letter case and `/`. */
const folderKey = (folder) => {
  const trimmed = folder.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? trimmed.replaceAll('/', '\\').toLowerCase() : trimmed;
};
// { kind: 'as-before' } | { kind: 'signed-out' } | { kind: 'entry', entry }, chosen once, like the account state.
const account = chooseAccount();
const signedOut = account.kind === 'signed-out' || (account.kind === 'entry' && (account.entry.state ?? 'subscription') !== 'subscription');
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
/**
 * The process ends as the first bytes of whatever is written to it next arrive (M21, C51), before
 * any line of it is read: a line longer than a pipe holds is then cut off as it is written. A short
 * one — a decision (M22) — is written whole, and the process ends before it says anything of it.
 */
const endAtInput = () => { process.stdin.prependOnceListener('data', () => process.exit(3)); };
// The session methods (M15, C70), and the sandbox's (M22): answered by replaying the captures.
const replay = createReplay({ output: (text) => process.stdout.write(text), takeControl: consumeControl, readControl, endAtInput, sandbox: account.entry?.sandbox });
const reader = createInterface({ input: process.stdin });
let initialized = false;
let pushed = false;

reader.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) {
    if (message.method === 'initialized') initialized = true;
    return;
  }
  if (message.method === 'initialize') {
    if (replay.hangsHandshake(message)) return;
    // The experimental API refused (M22b, C80): the process stays, and a plain handshake is answered.
    const refusal = replay.refusesHandshake(message);
    if (refusal !== null) { output({ id: message.id, error: refusal }); return; }
    replay.handshake(message);
    output({ id: message.id, result: { platformFamily: 'fixture' } });
    return;
  }
  if (!initialized) {
    output({ id: message.id, error: { code: -32002, message: 'Not initialized' } });
    return;
  }
  if (message.method === 'account/read') {
    if (consumeControl('hangAccount')) return;
    const entry = account.entry ?? {};
    output({ id: message.id, result: (account.kind === 'as-before' ? accountState === 'logged-out' : signedOut)
      ? { account: null, requiresOpenaiAuth: true }
      : { account: { type: 'chatgpt', email: entry.email ?? 'smoke@example.test', planType: entry.plan ?? 'pro' }, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === 'model/list') {
    output({ id: message.id, result: modelsFor(account.entry) });
    return;
  }
  if (message.method === 'account/rateLimits/read') {
    if (consumeControl('crashUsage')) process.exit(3);
    // What a signed-out home answered M14b's spike, word for word.
    if (account.kind !== 'as-before' && signedOut) {
      output({ id: message.id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } });
      return;
    }
    const percent = { primary: 41, secondary: 19, ...account.entry?.usage };
    output({
      id: message.id,
      result: {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: percent.primary, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
            secondary: { usedPercent: percent.secondary, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
          },
        },
      },
    });
    if (!pushed) {
      pushed = true;
      setTimeout(() => output({ method: 'account/rateLimits/updated', params: {
        rateLimits: { limitId: 'codex', primary: { usedPercent: percent.primary + 1, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: null },
      } }), 100);
    }
    return;
  }
  if (replay.handle(message)) return;
  output({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
reader.on('close', () => { replay.inputClosed(); process.exit(0); });

function chooseAccount() {
  const text = readText(process.env.FATG_SMOKE_CODEX_ACCOUNTS, '');
  if (text === '') return { kind: 'as-before' };
  let accounts;
  try { accounts = JSON.parse(text); } catch { accounts = null; }
  // A test's own mistake: say so loudly, never guess an account.
  if (accounts === null || typeof accounts !== 'object' || Array.isArray(accounts)) process.exit(65);
  if (home === undefined) return accounts.default ? { kind: 'entry', entry: accounts.default } : { kind: 'as-before' };
  const found = Object.entries(accounts).find(([key]) => key !== 'default' && folderKey(key) === folderKey(home));
  return found ? { kind: 'entry', entry: found[1] } : { kind: 'signed-out' };
}

/** The captured `model/list` reply, with the rows and levels an account does not list left out by name. */
function modelsFor(entry) {
  if (!entry || (entry.models === undefined && entry.efforts === undefined)) return MODEL_LIST;
  const data = MODEL_LIST.data
    .filter((model) => entry.models === undefined || entry.models.includes(model.id))
    .map((model) => {
      const levels = entry.efforts?.[model.id];
      return levels === undefined ? model : { ...model, supportedReasoningEfforts: model.supportedReasoningEfforts.filter((effort) => levels.includes(effort.reasoningEffort)) };
    });
  return { ...MODEL_LIST, data };
}

function readText(file, fallback) {
  if (!file) return fallback;
  try { return readFileSync(file, 'utf8').trim() || fallback; } catch { return fallback; }
}

/** The control file as it stands: the words that stay until it is rewritten. */
function readControl() {
  if (!controlFile || home !== undefined) return {};
  try { const controls = JSON.parse(readFileSync(controlFile, 'utf8')); return controls !== null && typeof controls === 'object' ? controls : {}; } catch { return {}; }
}

function consumeControl(key) {
  if (!controlFile || home !== undefined) return false;
  try {
    const controls = JSON.parse(readFileSync(controlFile, 'utf8'));
    const remaining = Number(controls[key] ?? 0);
    if (!Number.isInteger(remaining) || remaining <= 0) return false;
    controls[key] = remaining - 1;
    writeFileSync(controlFile, JSON.stringify(controls));
    return true;
  } catch {
    return false;
  }
}
