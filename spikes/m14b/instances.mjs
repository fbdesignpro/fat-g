// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b spike (C1–C3, Design 1): does each CLI keep one login per configuration folder, so that the
// same CLI started with another folder is another account, at the same time as the first?
//
// It sends only what fat-g already sends, on two processes at once: one in the user's own
// configuration, one with the documented variable naming a scratch folder. No prompt, no turn, no
// login: a login is the maintainer's, in their own terminal, between the two parts.
//
//   node spikes/m14b/instances.mjs --part 1 [--cli claude|codex] [--path <executable>]
//   node spikes/m14b/instances.mjs --part 2 [--cli claude|codex] [--keep-login]
//
// Part 1: an empty folder and a folder that does not exist, each beside the own configuration.
// Part 2: after the maintainer's logins, the login folder beside the own configuration. Accounts and
// readings are compared in memory; the report holds booleans, kinds and entry names only.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeDriver, CONTROL_ARGS } from '../m10/claude/driver.mjs';
import { CodexDriver } from '../m10/codex/driver.mjs';
import { DeadlineExpired, EXIT, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { LaunchRecord, RecordedProcessRunning, checkLaunchRecord, describe } from '../m10/lib/launch-record.mjs';
import { Launcher } from '../m10/lib/launcher.mjs';
import { leakCheck } from '../m10/lib/leak-check.mjs';
import { SPIKES_DIR, isMain, writeJson } from '../m10/lib/paths.mjs';
import { buildScratch, compareManifest } from '../m10/lib/scratch.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { CliExited } from '../m10/lib/wire.mjs';
import { parseVersion } from '../m10/preflight.mjs';
import { claudeWindows, codexWindows } from '../m10/usage.mjs';
import { ensureParent, entriesOf, folderLabel, folderPath, makeAbsent, makeEmpty, parentPath, removeFolder, removeParentIfBare } from './lib/folders.mjs';
import { VARIABLES, instanceEnvironment, ownEnvironment } from './lib/instance-env.mjs';

const OUTPUT_DIR = path.join(SPIKES_DIR, 'output', 'm14b');
const SECOND_RECORD = path.join(OUTPUT_DIR, 'launched-second.json');
const LOGIN_COMMANDS = Object.freeze({ claude: 'claude auth login', codex: 'codex login' });

const CLAUDE_TURN_TYPES = new Set(['assistant', 'result', 'user', 'system/init', 'stream_event']);
const CODEX_TURN_METHODS = /^(turn\/|item\/)/;

// ---- what may be written down -------------------------------------------------------------------

/** A short word the CLI uses for a kind (an auth method, an account type); anything else is dropped. */
const kindOf = (value) => (typeof value === 'string' && /^[A-Za-z0-9._ -]{1,40}$/.test(value) ? value : null);
const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

/** The scratch side's own error text, with every folder it could name replaced. Never used for the own side. */
function scrub(value) {
  let out = String(value ?? '').slice(-600);
  const folders = [[parentPath(), '<scratch>'], [tmpdir(), '<temp>'], [homedir(), '<home>']];
  for (const [folder, label] of folders) {
    for (const form of [folder, folder.replace(/\\/g, '/'), folder.replace(/\\/g, '\\\\')]) {
      out = out.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), label);
    }
  }
  return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '<email>').trim();
}

const overlap = (a, b) => a.startedAt < b.endedAt && b.startedAt < a.endedAt;

/** C68's rule, in memory: both report an email, the two match ignoring case, and the organizations match or neither has one. */
function compareAccounts(a, b) {
  if (!a?.email || !b?.email) return { bothReported: false, sameAccount: null, differentAccounts: null };
  const sameEmail = a.email.toLowerCase() === b.email.toLowerCase();
  const sameOrganization = (a.organization ?? null) === (b.organization ?? null);
  return { bothReported: true, sameAccount: sameEmail && sameOrganization, differentAccounts: !sameEmail };
}

function compareReadings(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return { bothRead: false, differ: null };
  const key = (windows) => JSON.stringify([...windows].sort((x, y) => x.window.localeCompare(y.window)));
  return { bothRead: true, differ: key(a) !== key(b) };
}

// ---- launching ----------------------------------------------------------------------------------

/** A one-shot command on one side, bounded by the request wait and torn down like a session. */
async function once(side, ctx, args) {
  const tree = await side.launcher.launch({ executable: ctx.executable, args, cwd: ctx.cwd, env: side.env });
  const startedAt = Date.now();
  let stdout = '';
  if (tree.child) {
    tree.stdout.setEncoding('utf8');
    tree.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
    tree.stdin.end();
  }
  const finished = await settlesWithin(tree.closed, ctx.waits.request);
  const endedAt = Date.now();
  const code = tree.exitInfo?.code ?? null;
  const cleanup = await tree.teardown();
  return { code, stdout, stderr: tree.stderrTail ?? '', timedOut: !finished, spawnError: tree.spawnError, cleanup, startedAt, endedAt };
}

function startFailure(error, driver, side) {
  if (error instanceof CliExited) {
    return { kind: 'exited', exitCode: error.info?.code ?? null, spawnError: error.info?.spawnError ?? null, stderrBytes: driver.tree?.stderrBytes ?? 0, ...(side.name === 'folder' ? { stderr: scrub(driver.tree?.stderrTail) } : {}) };
  }
  if (error instanceof DeadlineExpired) return { kind: 'timed-out', wait: error.wait };
  throw error;
}

const failureKind = (error) => (error instanceof CliExited ? 'exited' : error instanceof DeadlineExpired ? `timed-out (${error.wait})` : 'error');

function closing(driver, report, turnFrames) {
  return async () => {
    const cleanup = await driver.close();
    report.cleanup = { confirmed: cleanup.confirmed, graceful: cleanup.graceful ?? null, forced: cleanup.forced ?? null, ms: cleanup.ms ?? null };
    report.turnFrames = turnFrames();
    return cleanup;
  };
}

// ---- Claude -------------------------------------------------------------------------------------

/** `claude auth status` prints JSON. The report keeps booleans, kinds and key names; the identity stays in memory. */
function claudeAuth(result, side) {
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { /* not JSON */ }
  const json = Boolean(parsed) && typeof parsed === 'object';
  const loggedIn = json && parsed.loggedIn === true;
  return {
    report: {
      answered: json, exitCode: result.code, timedOut: result.timedOut, loggedIn,
      authMethod: json ? kindOf(parsed.authMethod) : null, apiProvider: json ? kindOf(parsed.apiProvider) : null,
      keys: json ? Object.keys(parsed).sort() : null, cleanupConfirmed: result.cleanup.confirmed,
      ...(side.name === 'folder' && !json ? { stderr: scrub(result.stderr) } : {}),
    },
    identity: loggedIn ? { email: text(parsed.email), organization: text(parsed.orgName) } : null,
  };
}

/** A control session that sends `initialize` and, for part 2 only, one `get_usage`. */
function claudeSession(ctx, side, { usage }) {
  const driver = new ClaudeDriver({ launcher: side.launcher, executable: ctx.executable, args: [...CONTROL_ARGS], cwd: ctx.cwd, env: side.env, waits: ctx.waits, signal: ctx.signal });
  const report = { started: false };
  const memory = { identity: null, windows: null };
  const turnFrames = () => driver.session.frames.filter((f) => f.dir === 'recv' && CLAUDE_TURN_TYPES.has(driver.table.typeKey(f.frame))).length;
  const isOpen = () => report.started && !driver.tree?.rootExited;
  return {
    report, memory, isOpen,
    async open() {
      try {
        const init = await driver.open();
        report.started = init.ok;
        if (!init.ok) { report.initialize = { ok: false, ...(side.name === 'folder' ? { error: scrub(init.error) } : {}) }; return; }
        const value = init.value ?? {};
        const account = value.account && typeof value.account === 'object' ? value.account : null;
        const hasEmail = typeof account?.email === 'string' && account.email.length > 0;
        report.initialize = { ok: true, keys: Object.keys(value).sort(), models: Array.isArray(value.models) ? value.models.length : null, accountKeys: account ? Object.keys(account).sort() : null, accountHasEmail: hasEmail };
        if (hasEmail) memory.identity = { email: account.email, organization: text(account.organization) };
      } catch (error) { report.startFailure = startFailure(error, driver, side); }
    },
    async read() {
      if (!usage || !isOpen()) return;
      try {
        const reply = await driver.request('get_usage', { skip_behaviors: true });
        const windows = reply.ok ? claudeWindows(reply.value) : [];
        report.usage = { ok: reply.ok, windows: windows.length };
        if (reply.ok) memory.windows = windows;
      } catch (error) { report.usage = { ok: false, failure: failureKind(error) }; }
    },
    close: closing(driver, report, turnFrames),
  };
}

// ---- Codex --------------------------------------------------------------------------------------

const rpcError = (error, side) => ({ code: Number.isInteger(error?.code) ? error.code : null, ...(side.name === 'folder' ? { message: scrub(error?.message) } : {}) });

/** An app-server that sends `initialize`, `account/read` and `account/rateLimits/read`. */
function codexSession(ctx, side) {
  const driver = new CodexDriver({ launcher: side.launcher, executable: ctx.executable, cwd: ctx.cwd, env: side.env, waits: ctx.waits, signal: ctx.signal });
  const report = { started: false };
  const memory = { identity: null, windows: null };
  const turnFrames = () => driver.session.frames.filter((f) => f.dir === 'recv' && CODEX_TURN_METHODS.test(f.frame?.method ?? '')).length;
  const isOpen = () => report.started && !driver.tree?.rootExited;
  return {
    report, memory, isOpen,
    async open() {
      try {
        const init = await driver.open();
        report.started = init.ok;
        report.initialize = init.ok ? { ok: true, keys: Object.keys(init.value ?? {}).sort() } : { ok: false, error: rpcError(init.error, side) };
      } catch (error) { report.startFailure = startFailure(error, driver, side); }
    },
    async read() {
      if (!isOpen()) return;
      try {
        const account = await driver.request('account/read', { refreshToken: false });
        if (account.ok) {
          const value = account.value?.account ?? null;
          report.account = { ok: true, signedIn: value !== null, type: kindOf(value?.type), requiresOpenaiAuth: account.value?.requiresOpenaiAuth === true, keys: value ? Object.keys(value).sort() : null };
          if (value && typeof value.email === 'string') memory.identity = { email: value.email, organization: null };
        } else report.account = { ok: false, error: rpcError(account.error, side) };
        let limits = await driver.request('account/rateLimits/read');
        // The first read after a start can answer before the windows are filled (M10's usage spike).
        if (limits.ok && codexWindows(limits.value).length === 0) { await sleep(750); limits = await driver.request('account/rateLimits/read'); }
        const windows = limits.ok ? codexWindows(limits.value) : [];
        report.rateLimits = limits.ok ? { ok: true, windows: windows.length } : { ok: false, error: rpcError(limits.error, side) };
        if (limits.ok) memory.windows = windows;
      } catch (error) { report.readFailure = failureKind(error); }
    },
    close: closing(driver, report, turnFrames),
  };
}

// ---- one case: the own configuration and one folder, both at once -------------------------------

async function runCase(ctx, kind, { usage = false } = {}) {
  const { cli } = ctx;
  const folder = kind === 'empty' ? makeEmpty(cli) : kind === 'absent' ? makeAbsent(cli) : folderPath(cli, 'login');
  const sides = [
    { name: 'own', launcher: ctx.launcher, env: ownEnvironment(cli).env },
    { name: 'folder', launcher: ctx.second, env: instanceEnvironment(cli, folder).env },
  ];
  const row = { case: kind, folder: folderLabel(cli, kind), existedBefore: existsSync(folder) };
  const identities = { own: null, folder: null };
  let confirmed = true;

  if (cli === 'claude') {
    const results = await Promise.all(sides.map((side) => once(side, ctx, ['auth', 'status'])));
    const [own, other] = results.map((result, i) => claudeAuth(result, sides[i]));
    row.authStatus = { own: own.report, folder: other.report, atOnce: overlap(results[0], results[1]) };
    identities.own = own.identity;
    identities.folder = other.identity;
    confirmed &&= results.every((result) => result.cleanup.confirmed);
  }

  const sessions = sides.map((side) => (cli === 'claude' ? claudeSession(ctx, side, { usage }) : codexSession(ctx, side)));
  let bothOpen = false;
  try {
    await Promise.all(sessions.map((session) => session.open()));
    bothOpen = sessions.every((session) => session.isOpen());
    await Promise.all(sessions.map((session) => session.read()));
    bothOpen &&= sessions.every((session) => session.isOpen());
  } finally {
    const cleanups = await Promise.all(sessions.map((session) => session.close()));
    confirmed &&= cleanups.every((cleanup) => cleanup.confirmed);
  }
  row.sessions = { own: sessions[0].report, folder: sessions[1].report, bothOpenAtOnce: bothOpen };
  if (cli === 'codex') {
    identities.own = sessions[0].memory.identity;
    identities.folder = sessions[1].memory.identity;
  }
  row.cleanupConfirmed = confirmed;
  // One listing of names, and only once every process of the case is confirmed gone.
  row.folderAfter = confirmed ? { exists: existsSync(folder), entries: entriesOf(folder) } : { exists: existsSync(folder), entries: 'not listed: cleanup was not confirmed' };
  row.turnFrames = sessions.reduce((n, session) => n + (session.report.turnFrames ?? 0), 0);
  return { row, identities, windows: { own: sessions[0].memory.windows, folder: sessions[1].memory.windows } };
}

/** Whether a side answered the account question, and what it said. */
function accountAnswer(cli, row, side) {
  if (cli === 'claude') {
    const status = row.authStatus?.[side];
    return { answered: status?.answered === true, signedIn: status?.loggedIn === true };
  }
  const account = row.sessions[side].account;
  return { answered: account?.ok === true, signedIn: account?.signedIn === true };
}

const askedAtOnce = (cli, row) => (cli === 'claude' ? row.authStatus?.atOnce === true : row.sessions.bothOpenAtOnce === true);

// ---- the two parts ------------------------------------------------------------------------------

async function partOne(ctx) {
  const { cli } = ctx;
  const cases = {};
  for (const kind of ['empty', 'absent']) cases[kind] = (await runCase(ctx, kind)).row;
  const own = accountAnswer(cli, cases.empty, 'own');
  const empty = accountAnswer(cli, cases.empty, 'folder');
  const absent = accountAnswer(cli, cases.absent, 'folder');
  const gate = {
    ownReadsItsAccount: own.answered && own.signedIn,
    emptyFolderReadsSignedOut: empty.answered && !empty.signedIn,
    bothAtOnce: askedAtOnce(cli, cases.empty),
  };
  gate.shown = gate.ownReadsItsAccount && gate.emptyFolderReadsSignedOut && gate.bothAtOnce;
  const findings = {
    startsInEmptyFolder: cases.empty.sessions.folder.started,
    startsWithMissingFolder: cases.absent.sessions.folder.started,
    missingFolderReadsSignedOut: absent.answered ? !absent.signedIn : null,
    cliMadeTheMissingFolder: cases.absent.folderAfter.exists,
    entriesMadeInEmptyFolder: Array.isArray(cases.empty.folderAfter.entries) ? cases.empty.folderAfter.entries.map((e) => e.name) : null,
  };
  const scratchDeleted = removeFolder(cli, 'empty') && removeFolder(cli, 'absent');
  return { cases, gate, findings, scratchDeleted };
}

async function partTwo(ctx, { keepLogin }) {
  const { cli } = ctx;
  if (!existsSync(folderPath(cli, 'login'))) return { notRun: 'the login folder is not there: run part 1, then make the login it prints' };
  const { row, identities, windows } = await runCase(ctx, 'login', { usage: true });
  const own = accountAnswer(cli, row, 'own');
  const login = accountAnswer(cli, row, 'folder');
  const result = {
    cases: { login: row },
    bothReportAnAccount: own.signedIn && login.signedIn,
    bothAtOnce: askedAtOnce(cli, row),
    accounts: compareAccounts(identities.own, identities.folder),
    readings: compareReadings(windows.own, windows.folder),
  };
  result.scratchDeleted = keepLogin ? 'kept (--keep-login)' : removeFolder(cli, 'login');
  return result;
}

/** The CLI's own login command with the variable set, in the platform's shell form (C36). */
function loginCommand(cli, folder) {
  const variable = VARIABLES[cli];
  if (process.platform === 'win32') return `$env:${variable} = '${folder.replace(/'/g, "''")}'; ${LOGIN_COMMANDS[cli]}`;
  return `${variable}='${folder.replace(/'/g, "'\\''")}' ${LOGIN_COMMANDS[cli]}`;
}

/** Drops the scratch side's error texts when the report would otherwise name a folder or an account. */
function withoutTexts(value) {
  if (Array.isArray(value)) return value.map(withoutTexts);
  if (!value || typeof value !== 'object') return value;
  const isText = ([key, v]) => key === 'stderr' || key === 'message' || (key === 'error' && typeof v === 'string');
  return Object.fromEntries(Object.entries(value).filter((entry) => !isText(entry)).map(([key, v]) => [key, withoutTexts(v)]));
}

async function instances({ args, launcher, signal, waits }) {
  const part = String(args.part ?? '');
  const which = args.cli ? [String(args.cli)] : ['claude', 'codex'];
  if ((part !== '1' && part !== '2') || which.some((cli) => !(cli in VARIABLES))) {
    warn('usage: node spikes/m14b/instances.mjs --part 1|2 [--cli claude|codex] [--path <executable>] [--keep-login]');
    return EXIT.error;
  }
  // The second side has a launcher and a launch record of its own: two trees run at once, and each
  // launcher still refuses a launch until its own earlier tree is confirmed gone.
  await checkLaunchRecord({ file: SECOND_RECORD });
  const second = new Launcher({ spike: 'm14b-instances', record: new LaunchRecord('m14b-instances', SECOND_RECORD), waits });
  const secondUnconfirmed = () => Boolean(second.previous) && !second.previous.cleanup?.confirmed;

  ensureParent();
  const probe = buildScratch('probe');
  const report = { format: 'fat-g.m14b-spike/1', part: Number(part), date: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, turnsSpent: 0, clis: {} };
  const logins = [];
  try {
    for (const cli of which) {
      const executable = resolveExecutable(cli, which.length === 1 ? args.path : undefined);
      const ctx = { cli, executable, cwd: probe.dir, launcher, second, waits, signal };
      const own = ownEnvironment(cli);
      const version = await once({ name: 'own', launcher, env: own.env }, ctx, ['--version']);
      log(`${cli}: part ${part}…`);
      const result = part === '1' ? await partOne(ctx) : await partTwo(ctx, { keepLogin: args['keep-login'] === true });
      report.clis[cli] = { version: parseVersion(version.stdout), launchKind: executable.kind, environment: own.report, ...result };
      if (part === '1') {
        // The product's case is a folder the user picked, so one that exists: the login folder is
        // made here, empty, unless an earlier run left one (which may already hold a login).
        const folder = folderPath(cli, 'login');
        const already = existsSync(folder);
        if (!already) mkdirSync(folder);
        report.clis[cli].loginFolder = { folder: folderLabel(cli, 'login'), alreadyThere: already };
        logins.push({ cli, command: loginCommand(cli, folder) });
      }
    }
  } catch (error) {
    if (secondUnconfirmed() && !(error instanceof RecordedProcessRunning)) error.exitCode = EXIT.cleanupUnconfirmed;
    throw error;
  }

  const rows = Object.values(report.clis).flatMap((entry) => Object.values(entry.cases ?? {}));
  report.turnFrames = rows.reduce((n, row) => n + (row.turnFrames ?? 0), 0);
  report.everyTreeConfirmedGone = rows.every((row) => row.cleanupConfirmed) && !secondUnconfirmed();
  report.workingFolderUnchanged = compareManifest(probe.dir, probe.manifest).unchanged;
  if (part === '2') report.scratchParentDeleted = removeParentIfBare();

  // M10's leak check on the report as written: no email, id, absolute path, user or host name.
  let written = report;
  let leak = leakCheck(JSON.stringify(written, null, 2), { scratchDirs: [parentPath()] });
  if (!leak.ok) {
    written = { ...withoutTexts(report), errorTextsDropped: leak.failures.map((failure) => failure.kind) };
    leak = leakCheck(JSON.stringify(written, null, 2), { scratchDirs: [parentPath()] });
  }
  written.leakCheck = leak.ok ? 'passed' : { failed: leak.failures.map((failure) => failure.kind) };
  if (leak.ok) {
    writeJson(path.join(OUTPUT_DIR, `part-${part}.json`), written);
    log(JSON.stringify(written, null, 2));
  } else {
    warn(`the report did not pass the leak check (${leak.failures.map((failure) => failure.kind).join(', ')}); nothing was written`);
  }

  if (part === '1' && logins.length > 0) {
    log('\nThe maintainer\'s part, before part 2 (agents never perform logins). In your own terminal, a new window per command,');
    log('since the variable stays set for the window it was set in:');
    for (const { cli, command } of logins) log(`  ${cli}:  ${command}`);
    log('Then: node spikes/m14b/instances.mjs --part 2');
  }

  if (secondUnconfirmed()) {
    warn(`instances: cleanup NOT confirmed on the second side. Still recorded: ${(second.previous.cleanup?.remaining ?? []).map(describe).join(', ') || 'unknown'}. Its launch record is kept.`);
    return EXIT.cleanupUnconfirmed;
  }
  if (!leak.ok || report.turnFrames > 0) return EXIT.error;
  const entries = Object.values(report.clis);
  if (entries.some((entry) => entry.notRun)) return EXIT.notRun;
  const shown = part === '1' ? entries.every((entry) => entry.gate.shown) : entries.every((entry) => entry.bothReportAnAccount && entry.bothAtOnce);
  return shown ? EXIT.happened : EXIT.didNotHappen;
}

if (isMain(import.meta.url)) await runSpike('m14b-instances', instances);
