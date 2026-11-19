// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V47 (docs/planning/_archive/M15.md, Design 11; C49, C114) and V19 (M16.md, Design 9; C47): fat-g killed
// with no cleanup. A parent (./forced-exit-parent.ts) with the real process layer opens two Codex
// sessions and one Claude session on their replay fakes, each in a turn with a descendant; the test
// kills the parent alone — SIGKILL, or `taskkill /F` without `/T` — and watches its trees.
//
// The first case: the fakes end when their input closes, and their descendants when theirs does, so
// every recorded process is gone. The second pins a limit: a descendant that ignores its closed
// input, started detached as the real CLIs' are, outlives the kill. Neither M15 nor M16 adds a
// mechanism to end it (M15, Design 11; M16, C47), and the case is here so that a later one has to
// change it.
//
// In the process-trees project of vitest.config.ts: it launches process trees, as tests/codex does.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promptOf as claudePromptOf } from '../claude/chat/harness';
import { promptOf } from '../codex/harness';
import { removeFolder } from './remove-folder';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FAKE = path.resolve('tests/fixtures/fake-codex-cli.mjs');
const CLAUDE_FAKE = path.resolve('tests/fixtures/fake-claude-cli.mjs');
/** Two Codex sessions and one Claude session, each with one descendant. */
const SESSIONS = 3;
let bundleDir: string;
let parentScript: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'fatg-forced-bundle-'));
  parentScript = path.join(bundleDir, 'parent.mjs');
  await build({
    entryPoints: [path.resolve('tests/process/forced-exit-parent.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: parentScript, logLevel: 'silent',
    tsconfig: path.resolve('tsconfig.base.json'),
    define: { __FATG_SMOKE_HOOKS__: 'true' },
    // cross-spawn is CommonJS, and asks for Node's own modules by require.
    banner: { js: "import { createRequire as __fatgRequire } from 'node:module'; const require = __fatgRequire(import.meta.url);" },
    // A provider module's logo (M100, C69), imported with `?inline`: a `data:` address of the png, as Vite gives it.
    plugins: [{
      name: 'inline-png',
      setup(builder) {
        builder.onResolve({ filter: /\.png\?inline$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')), namespace: 'inline-png' }));
        builder.onLoad({ filter: /.*/, namespace: 'inline-png' }, (args) => ({ contents: readFileSync(args.path), loader: 'dataurl' }));
      },
    }],
  });
});
afterAll(() => { rmSync(bundleDir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = (file: string): number[] => { try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0])); } catch { return []; } };

interface Run {
  readonly dir: string;
  readonly data: string;
  readonly parent: ChildProcess;
  /** Every process the fakes and their descendants recorded. */
  recorded(): number[];
  /** Those that recorded their own end. */
  exited(): number[];
  /** The fakes a session ran on, as Codex's thread file and Claude's session file have them. */
  sessions(): number[];
}
let current: Run | undefined;
afterEach(async () => {
  // Whatever the outcome, nothing of a run is left behind: each recorded process that is still
  // there is ended by its recorded pid. A pid is recorded with its start time, and the run lasts
  // seconds, so one reused in between is not a risk this test takes on.
  const run = current;
  current = undefined;
  if (run === undefined) return;
  const left = run.recorded().filter((pid) => !run.exited().includes(pid) && alive(pid));
  // SIGKILL: a descendant that ignores its input ignores SIGTERM too.
  for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  if (run.parent.exitCode === null) run.parent.kill();
  await waitFor(() => left.every((pid) => !alive(pid)), 'the processes left ending', 10_000).catch(() => undefined);
  // On Windows a process that was just ended can hold its working folder a little longer than it
  // reads as gone, and more so on a loaded machine: the folder is removed once it lets go.
  await removeFolder(run.dir);
});

async function launch(descendant: '1' | 'ignore'): Promise<Run> {
  const dir = mkdtempSync(path.join(tmpdir(), 'fatg-forced-'));
  const data = path.join(dir, 'data');
  const project = path.join(dir, 'project');
  // Claude's fake keeps its ledger in a fixture folder of its own, and its sessions in a file beside it.
  const fixture = path.join(dir, 'claude-fixture');
  for (const folder of [data, project, fixture]) mkdirSync(folder);
  const files = { threads: path.join(dir, 'threads.json'), control: path.join(dir, 'control.json'), pids: path.join(dir, 'pids'), chats: path.join(dir, 'chat-sessions.json') };
  writeFileSync(files.control, '{}');
  writeFileSync(path.join(fixture, 'control.json'), '{}');
  const env = {
    ...process.env,
    FATG_SMOKE_CODEX_THREADS: files.threads, FATG_SMOKE_CODEX_CONTROL: files.control, FATG_SMOKE_PIDS: files.pids, FATG_SMOKE_CODEX_GAP_MS: '1', FATG_SMOKE_CODEX_DESCENDANT: descendant,
    FATG_SMOKE_CLAUDE_SESSIONS: files.chats, FATG_SMOKE_CLAUDE_GAP_MS: '1', FATG_SMOKE_CLAUDE_DESCENDANT: descendant,
  };
  // T4 waits for its interrupt, in each provider's capture: each session stays in its turn until the parent is killed.
  const parent = spawn(process.execPath, [parentScript, data, project, FAKE, promptOf('t4-interrupt'), CLAUDE_FAKE, fixture, claudePromptOf('m16-t4-interrupt', project)], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const sessionsOf = <T>(file: string, key: string): T[] => { try { return Object.values((JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, T>>)[key] ?? {}); } catch { return []; } };
  const run: Run = {
    dir, data, parent,
    recorded: () => [...lines(files.pids), ...lines(path.join(fixture, 'pids'))],
    exited: () => [...lines(`${files.pids}.exited`), ...lines(path.join(fixture, 'exited'))],
    sessions: () => [...sessionsOf<{ launches: { pid: number }[] }>(files.threads, 'threads'), ...sessionsOf<{ launches: { pid: number }[] }>(files.chats, 'sessions')].flatMap((entry) => entry.launches.map((launched) => launched.pid)),
  };
  current = run;
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the parent did not get ready: ${output}`)), 30_000);
    parent.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"ready":true')) { clearTimeout(timer); resolve(); }
      if (output.includes('"error"')) { clearTimeout(timer); reject(new Error(output)); }
    });
    parent.on('exit', () => { clearTimeout(timer); reject(new Error(`the parent ended: ${output}`)); });
  });
  // Every session's fake, and each one's descendant, has recorded itself.
  await waitFor(() => run.sessions().length === SESSIONS && run.recorded().filter((pid) => !run.exited().includes(pid)).length >= SESSIONS * 2, 'every process recording itself');
  return run;
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in time`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The parent alone, with no cleanup of any kind. */
async function killParent(run: Run): Promise<void> {
  const pid = run.parent.pid as number;
  const exited = new Promise<void>((resolve) => { if (run.parent.exitCode !== null || run.parent.signalCode !== null) resolve(); else run.parent.once('exit', () => resolve()); });
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true });
    expect(result.status).toBe(0);
  } else {
    process.kill(pid, 'SIGKILL');
  }
  await exited;
}

/** What fat-g's process layer left in its data folder: it keeps no record of processes (C50). */
function recordsOfProcesses(data: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  if (existsSync(data)) walk(data, '');
  return found;
}

describe('fat-g killed without cleanup (M15, V47; M16, V19)', () => {
  it('leaves each child with a closed input: every process of every tree is gone, Codex’s and Claude’s', async () => {
    const run = await launch('1');
    const before = run.recorded().filter((pid) => !run.exited().includes(pid));
    expect(before.every(alive)).toBe(true);
    expect(before.length).toBeGreaterThanOrEqual(SESSIONS * 2);
    await killParent(run);
    await waitFor(() => run.recorded().every((pid) => !alive(pid)), 'every recorded process ending');
    expect(recordsOfProcesses(run.data)).toEqual([]);
  });

  it('leaves a descendant that ignores its closed input running, under either provider: the limit M15 states and M16 does not fix', async () => {
    const run = await launch('ignore');
    const fakes = run.sessions();
    const descendants = run.recorded().filter((pid) => !run.exited().includes(pid) && !fakes.includes(pid) && alive(pid));
    expect(fakes).toHaveLength(SESSIONS);
    expect(descendants).toHaveLength(SESSIONS);
    await killParent(run);
    // The fakes end with their input; their descendants do not.
    await waitFor(() => fakes.every((pid) => !alive(pid)), 'the sessions’ fakes ending');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(descendants.filter(alive)).toEqual(descendants);
    expect(recordsOfProcesses(run.data)).toEqual([]);
    // afterEach ends them, by their recorded pids.
  });
});
