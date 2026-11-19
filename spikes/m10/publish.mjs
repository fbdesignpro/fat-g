// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B7: redact the captures, run the leak check, and copy them to tests/fixtures/ (C7–C9, C54).
// Only runs that happened are published (V9). A capture holding a frame type the tables do not know
// is refused until the table is reviewed (V26). The leak check must pass before anything is written.
//
//   node spikes/m10/publish.mjs [--only <fixture name>[,<name>…]] [--include <run id>] [--dry-run]
//   node spikes/m10/publish.mjs --check        (leak check and format check of every fixture)
//
// M15 adds three things (M15, Design 1). Its raw captures, under spikes/output/m15/raw/, are read
// too. `--include <run id>` publishes one run that did not happen, for what it did show (C5): the
// capture keeps its outcome, and its note says so. And captures that name the same `family` are
// redacted by one redactor, oldest first, so one id has one alias across them: a saved thread's
// live turns and the history read of it can then be compared in a fixture.
//
// M16 adds its raw captures, under spikes/output/m16/raw/, and the scratch configuration folder its
// sessions ran in: that folder is redacted as a scratch folder, and the account signed in there is
// asked for its values too, since it need not be the one of the maintainer's own configuration.
//
// M19 adds its raw captures, under spikes/output/m19/raw/. They keep the deltas of a message's
// text, which the earlier captures count and drop: a capture says so itself (`deltas.requested`).
//
// M19b adds its raw captures, under spikes/output/m19b/raw/: answers that name files of the scratch
// folder, which stays `<scratch>` in them whatever form an answer wrote it in.
//
// M20a adds its raw captures, under spikes/output/m20a/raw/: a turn's checklist notifications and
// its reasoning items, with a history read of the turn.
// M21 adds its raw captures, under spikes/output/m21/raw/: questions asked and answered on both
// CLIs, a Stop with one pending, and a history read that keeps an async question.
// M22 adds its raw captures, under spikes/output/m22/raw/: permission modes set and read back,
// requests for commands and file changes allowed and denied, and what acts with no request.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { CLAUDE_TABLE } from './claude/frames.mjs';
import { CODEX_TABLE } from './codex/frames.mjs';
import { CodexDriver } from './codex/driver.mjs';
import { EXIT, settlesWithin } from './lib/deadlines.mjs';
import { cleanEnvironment } from './lib/env.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { leakCheck } from './lib/leak-check.mjs';
import { runOnce } from './lib/oneshot.mjs';
import { FIXTURES_DIR, SPIKES_DIR, isMain, outputPath } from './lib/paths.mjs';
import { createRedactor } from './lib/redactor.mjs';
import { SCRATCH_NAMES, buildScratch, scratchPath } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';

const TABLES = { claude: CLAUDE_TABLE, codex: CODEX_TABLE };
/** M16's scratch configuration folder (M14b's login folder), where its sessions ran. Named here, not imported: nothing in spikes/m10 imports from outside it. */
const M16_CONFIG_DIR = path.join(tmpdir(), 'fat-g-spike-m14b', 'claude-login');
/** M22's scratch Codex configuration folder (spikes/m22/k1.mjs), outside the temp folder: redacted as a scratch folder, its account asked for its values. */
const M22_CODEX_HOME = path.join(homedir(), '.fat-g-spike-m22', 'codex-home');
/** Where that folder was for K1's first runs, which their raw captures name: still redacted as a scratch folder. */
const M22_CODEX_HOME_FIRST = process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'fat-g-spike-m22', 'codex-home')] : [];
/** The two folders K1 makes beside it, for what a sandbox holds back: outside the working folder and outside the temp folder. */
const M22_BEYOND = ['outside', 'second', 'm23-images'].map((name) => path.join(path.dirname(M22_CODEX_HOME), name));
const SCRATCH_DIRS = [...Object.keys(SCRATCH_NAMES).map(scratchPath), path.join(tmpdir(), 'fat-g-spike-trust-markers'), M16_CONFIG_DIR, M22_CODEX_HOME, ...M22_BEYOND, ...M22_CODEX_HOME_FIRST];

/** Raw file name → fixture name: "<name>.<run id>.json" → "<name>.json". */
export function fixtureName(rawFile) {
  const base = path.basename(rawFile, '.json');
  const match = /^(.*)\.(claude|codex)-[a-z]\w*(?:-[\w-]+)?-\d+$/.exec(base);
  return match ? match[1] : base;
}

/** The session's own id(s), pre-registered as "session" so workers get aliases of their own. */
export function sessionIdsOf(cli, capture) {
  const frames = capture.frames ?? [];
  if (cli === 'claude') return [...new Set(frames.map((f) => (f.frame?.type === 'system' && f.frame.subtype === 'init' ? f.frame.session_id : null)).filter(Boolean))];
  const index = capture.sessionStart?.replyIndex;
  const reply = Number.isInteger(index) ? frames.find((f) => f.index === index)?.frame : null;
  // A capture that starts no thread of its own (M15's history read) names its session's id itself.
  return [...new Set([reply?.result?.thread?.id, ...(Array.isArray(capture.sessionIds) ? capture.sessionIds : [])].filter(Boolean))];
}

/** Account values the CLIs report right now, gathered by asking them (never from their files). */
async function accountSecrets(launcher, waits, signal, overrides) {
  const secrets = [];
  const add = (kind, value) => { if (typeof value === 'string' && value.length >= 4) secrets.push({ kind, value }); };
  // An explicit --path must exist (V6); automatic lookup failing only narrows the sources.
  for (const [cli, file] of Object.entries(overrides)) resolveExecutable(cli, file);
  const { dir } = buildScratch('probe');
  try {
    const claude = resolveExecutable('claude', overrides.claude);
    const status = await runOnce(launcher, 'claude', claude, ['auth', 'status'], { cwd: dir, waits });
    const parsed = JSON.parse(status.stdout);
    add('email', parsed.email); add('account id', parsed.accountUuid ?? parsed.accountId); add('organization id', parsed.orgId ?? parsed.organizationUuid); add('organization name', parsed.orgName);
  } catch { warn('claude account values unavailable at check time; other sources still apply'); }
  // The account of M16's scratch configuration folder, asked the same way with the variable set.
  if (existsSync(M16_CONFIG_DIR)) {
    try {
      const claude = resolveExecutable('claude', overrides.claude);
      const tree = await launcher.launch({ executable: claude, args: ['auth', 'status'], cwd: dir, env: { ...cleanEnvironment('claude').env, CLAUDE_CONFIG_DIR: M16_CONFIG_DIR } });
      let stdout = '';
      if (tree.child) { tree.stdout.setEncoding('utf8'); tree.stdout.on('data', (chunk) => { if (stdout.length < 100_000) stdout += chunk; }); tree.stdin.end(); }
      await settlesWithin(tree.closed, waits.request);
      await tree.teardown();
      const parsed = JSON.parse(stdout);
      add('email', parsed.email); add('account id', parsed.accountUuid ?? parsed.accountId); add('organization id', parsed.orgId ?? parsed.organizationUuid); add('organization name', parsed.orgName);
    } catch { warn("the scratch configuration folder's account values are unavailable at check time; other sources still apply"); }
  }
  try {
    const codex = resolveExecutable('codex', overrides.codex);
    const driver = new CodexDriver({ launcher, executable: codex, cwd: dir, env: cleanEnvironment('codex').env, waits, signal });
    try {
      await driver.open();
      const reply = await driver.request('account/read', { refreshToken: false });
      add('email', reply.value?.account?.email);
    } finally { await driver.close(); }
  } catch { warn('codex account values unavailable at check time; other sources still apply'); }
  // The account of M22's scratch Codex configuration folder, asked the same way with the variable set.
  if (existsSync(M22_CODEX_HOME)) {
    try {
      const codex = resolveExecutable('codex', overrides.codex);
      const driver = new CodexDriver({ launcher, executable: codex, cwd: dir, env: { ...cleanEnvironment('codex').env, CODEX_HOME: M22_CODEX_HOME }, waits, signal });
      try {
        await driver.open();
        const reply = await driver.request('account/read', { refreshToken: false });
        add('email', reply.value?.account?.email);
      } finally { await driver.close(); }
    } catch { warn("the scratch Codex configuration folder's account values are unavailable at check time; other sources still apply"); }
  }
  return secrets;
}

/** M15's, M16's, M19's, M19b's and M20a's raw captures (spikes/m15, spikes/m16, spikes/m19, spikes/m19b, spikes/m20a), beside M10's. */
const M15_RAW = path.join(SPIKES_DIR, 'output', 'm15', 'raw');
const M16_RAW = path.join(SPIKES_DIR, 'output', 'm16', 'raw');
const M19_RAW = path.join(SPIKES_DIR, 'output', 'm19', 'raw');
const M19B_RAW = path.join(SPIKES_DIR, 'output', 'm19b', 'raw');
const M20A_RAW = path.join(SPIKES_DIR, 'output', 'm20a', 'raw');
/** M20b's (spikes/m20b): side questions and the CLI's commands on Claude, forks and their children on Codex. */
const M20B_RAW = path.join(SPIKES_DIR, 'output', 'm20b', 'raw');
/** M21's (spikes/m21): questions answered on Claude, a plan turn's question and an async one on Codex. */
const M21_RAW = path.join(SPIKES_DIR, 'output', 'm21', 'raw');
/** M22's (spikes/m22): permission modes, approvals of commands and file changes, and rules that act with no request. */
const M22_RAW = path.join(SPIKES_DIR, 'output', 'm22', 'raw');
/** M26's (spikes/m26): the secretary's one-shot title request, on each CLI. */
const M26_RAW = path.join(SPIKES_DIR, 'output', 'm26', 'raw');
/** M100b's (spikes/m100b): a question declined by a `deny` from the user, on Claude. */
const M100B_RAW = path.join(SPIKES_DIR, 'output', 'm100b', 'raw');
/** M22b's (spikes/m22b): plan turns on Claude under each mode, and on Codex with their deltas, feedback, Execute and a skipped question. */
const M22B_RAW = path.join(SPIKES_DIR, 'output', 'm22b', 'raw');
/** M23's (spikes/m23): images sent with a prompt, a message steered into a running turn, a Stop that drops a held message, the commands and skills each CLI lists. */
const M23_RAW = path.join(SPIKES_DIR, 'output', 'm23', 'raw');
/** M22e's (spikes/m22e): a plan review under each provider's reading mode, its findings closing the answer in one fenced json block. */
const M22E_RAW = path.join(SPIKES_DIR, 'output', 'm22e', 'raw');
/** M106's (spikes/m106): a sub-agent asked for on another model than its session's, and what names that model on each CLI's wire. */
const M106_RAW = path.join(SPIKES_DIR, 'output', 'm106', 'raw');
/** The Codex MCP spike's (spikes/codex-mcp): Codex's leave to run an MCP tool, asked as an elicitation and answered once, for the session, declined and left to a Stop. */
const CODEX_MCP_RAW = path.join(SPIKES_DIR, 'output', 'codex-mcp', 'raw');

function rawCaptures() {
  const out = [];
  for (const cli of ['claude', 'codex']) {
    for (const dir of [outputPath('raw', cli), path.join(M15_RAW, cli), path.join(M16_RAW, cli), path.join(M19_RAW, cli), path.join(M19B_RAW, cli), path.join(M20A_RAW, cli), path.join(M20B_RAW, cli), path.join(M21_RAW, cli), path.join(M22_RAW, cli), path.join(M26_RAW, cli), path.join(M100B_RAW, cli), path.join(M22B_RAW, cli), path.join(M23_RAW, cli), path.join(M22E_RAW, cli), path.join(M106_RAW, cli), path.join(CODEX_MCP_RAW, cli)]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) out.push({ cli, file: path.join(dir, file) });
    }
  }
  return out;
}

/** V5: the fields every capture must carry. Returns the missing ones. */
export function formatProblems(capture) {
  const problems = [];
  if (!capture.cli?.name || !capture.cli?.version) problems.push('cli name and version');
  if (!capture.date) problems.push('date');
  if (!capture.scenario?.id || !capture.scenario?.successCondition) problems.push('scenario and success condition');
  if (!capture.run?.outcome) problems.push('run outcome');
  if (!Array.isArray(capture.launch?.args)) problems.push('launch arguments');
  if (!('sessionStart' in capture)) problems.push('session start');
  if (!capture.toolPermissions) problems.push('tool permissions');
  if (!Array.isArray(capture.environment?.removed) || capture.environment.removed.some((r) => typeof r?.name !== 'string' || 'value' in r || typeof r.appWouldHaveKept !== 'boolean')) problems.push('removed variable names');
  if (!capture.deadlines) problems.push('deadlines');
  // A capture says whether it asked for deltas: M19's did, for a message's text, and keeps them.
  if (typeof capture.deltas?.dropped !== 'number' || typeof capture.deltas.requested !== 'boolean') problems.push('deltas');
  if (!Array.isArray(capture.frames) || capture.frames.some((f) => !['send', 'recv'].includes(f.dir) || typeof f.ms !== 'number')) problems.push('frames with direction and time');
  return problems;
}

function untabled(cli, capture) {
  const table = TABLES[cli];
  return [...new Set((capture.frames ?? []).filter((f) => f.frame?._reduced || !table.types.has(table.typeKey(f.frame))).map((f) => table.typeKey(f.frame)))];
}

async function publish({ args, launcher, signal, waits }) {
  const overrides = typeof args.path === 'string' && ['claude', 'codex'].includes(args.cli) ? { [args.cli]: args.path } : {};
  const secrets = await accountSecrets(launcher, waits, signal, overrides);
  if (args.check) return check(secrets);
  const chosen = new Map();
  for (const { cli, file } of rawCaptures()) {
    const capture = JSON.parse(readFileSync(file, 'utf8'));
    // Only runs that happened, and the one run `--include` names (C5).
    if (capture.run?.outcome !== 'happened' && !(typeof args.include === 'string' && capture.run?.id === args.include)) continue;
    const name = `${cli}/${fixtureName(file)}`;
    if (typeof args.cli === 'string' && !args.path && cli !== args.cli) continue;
    // One name, or several with commas between them: a family is published in one go.
    if (typeof args.only === 'string' && !args.only.split(',').includes(fixtureName(file))) continue;
    const previous = chosen.get(name);
    if (!previous || previous.capture.date < capture.date) chosen.set(name, { cli, file, capture });
  }
  let failed = 0;
  // One redactor per family, made at its oldest capture and given every member's session ids.
  const families = new Map();
  const ordered = [...chosen].sort(([, a], [, b]) => String(a.capture.date).localeCompare(String(b.capture.date)));
  const redactorFor = (cli, capture) => {
    const make = (sessionIds) => createRedactor({ cli, table: TABLES[cli], scratchDirs: SCRATCH_DIRS, sessionIds, extraSecrets: secrets.map((s) => s.value) });
    if (typeof capture.family !== 'string') return make(sessionIdsOf(cli, capture));
    const key = `${cli}/${capture.family}`;
    if (!families.has(key)) families.set(key, make([...new Set(ordered.filter(([, c]) => c.cli === cli && c.capture.family === capture.family).flatMap(([, c]) => sessionIdsOf(cli, c.capture)))]));
    return families.get(key);
  };
  for (const [name, { cli, file, capture }] of ordered) {
    const redactor = redactorFor(cli, capture);
    const { capture: redacted, report } = redactor.redactCapture(capture);
    const unknown = Object.keys(report.untabledTypes);
    if (unknown.length) { warn(`${name}: frame types missing from the ${cli} table: ${unknown.join(', ')}. Review them, add them to ${cli}/frames.mjs, then publish again.`); failed++; continue; }
    redacted._fixture = {
      source: capture._fixture?.source ?? 'M10 spike',
      ...(capture.run?.outcome === 'happened' ? {} : { outcome: `this run's scenario ${capture.run?.outcome === 'did-not-happen' ? 'did not happen' : `ended as ${capture.run?.outcome}`}: published for what its frames do show (M15, C5)` }),
      redacted: ['ids replaced by aliases, stable per id', 'account objects', 'signatures and encrypted reasoning', 'the scratch folder (<scratch>)', 'every other absolute path (<path>)', 'emails, the user name, unregistered UUIDs', 'configured-item names not shipped with the CLI', 'usage readings (rate-limit frames keep key names only)'].concat(cli === 'claude' ? ['get_settings documents (key names only)'] : ['config/read replies (two levels of key names, C53)']),
      omitted: capture._fixture?.omitted ?? [],
      note: `Redacted by spikes/m10/publish.mjs and leak-checked on ${new Date().toISOString().slice(0, 10)}. Aliases: ${JSON.stringify(report.aliasCounts)}.${typeof capture.family === 'string' ? ` Aliases are shared with the other captures of the family "${capture.family}".` : ''}${capture.variableSet ? ` Captured with ${capture.variableSet.join(', ')} set (C65).` : ''}`,
    };
    const text = `${JSON.stringify(redacted, null, 2)}\n`;
    const leak = leakCheck(text, { cli, raw: capture, secrets, scratchDirs: SCRATCH_DIRS });
    if (!leak.ok) { warn(`${name}: leak check FAILED: ${leak.failures.map((f) => `${f.kind} ${f.sample}`).join('; ')}`); failed++; continue; }
    const target = path.join(FIXTURES_DIR, cli, 'captures', `${fixtureName(file)}.json`);
    if (args['dry-run']) { log(`${name}: would write ${path.relative(process.cwd(), target)} (${text.length} bytes)`); continue; }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    log(`${name}: written ${path.relative(process.cwd(), target)}; leak check passed; ${report.reducedFrames} reduced frame(s)`);
  }
  return failed ? EXIT.error : EXIT.happened;
}

function check(secrets) {
  let failed = 0;
  let count = 0;
  const raws = new Map(rawCaptures().map(({ cli, file }) => [`${cli}/${fixtureName(file)}`, { cli, file }]));
  for (const cli of ['claude', 'codex']) {
    const dir = path.join(FIXTURES_DIR, cli, 'captures');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      count++;
      const text = readFileSync(path.join(dir, file), 'utf8');
      const capture = JSON.parse(text);
      const rawEntry = raws.get(`${cli}/${path.basename(file, '.json')}`);
      const raw = rawEntry ? JSON.parse(readFileSync(rawEntry.file, 'utf8')) : null;
      const leak = leakCheck(text, { cli, raw, secrets, scratchDirs: SCRATCH_DIRS });
      const format = formatProblems(capture);
      const types = untabled(cli, capture);
      const ok = leak.ok && format.length === 0 && types.length === 0;
      if (!ok) failed++;
      log(`${ok ? 'PASS' : 'FAIL'} ${cli}/${file}${leak.ok ? '' : ` leak: ${leak.failures.map((f) => f.kind).join(', ')}`}${format.length ? ` missing: ${format.join(', ')}` : ''}${types.length ? ` untabled: ${types.join(', ')}` : ''}${raw ? '' : ' (no raw file here; raw ids not checked)'}`);
    }
  }
  log(`${count} fixture(s) checked, ${failed} failed`);
  return failed ? EXIT.error : EXIT.happened;
}

if (isMain(import.meta.url)) await runSpike('publish', publish);
