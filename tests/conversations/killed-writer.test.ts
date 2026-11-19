// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7, V18, V23, V24 (docs/planning/_archive/M18.md; C15, C16, C36–C40, C54, C63): fat-g killed in the middle of
// a write. A writer process (./killed-writer.ts) — the app's own session side on a data folder —
// plays a turn and a removal, and says when it has reached the point it was told to stop at; the
// test ends it with no cleanup — SIGKILL, or `taskkill /F` — and starts the app again on what it
// left. Each restart shows what was committed, sends nothing, and invents no end.
//
// In the process-trees project of vitest.config.ts: it launches processes, as tests/process/ does.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { CHAT_LINES } from '@shared/contracts/chat';
import { itemCut, itemText } from '@shared/contracts/conversation';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import { CONVERSATIONS_VERSION, STORE_FILE, storeFiles } from '../../src/main/conversations/format';
import { openStore } from '../../src/main/conversations/open';
import { type FakeFacet, fakeFacet } from '../../src/main/sessions/runtime-test-support';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession, until } from '../sessions/app';
import { EXAMPLE_DESCRIPTOR } from '../support/example-provider';
import { removeFolder } from '../process/remove-folder';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PROMPT = 'killed-writer: what is the cat’s name?';
const DESCRIPTOR: ProviderDescriptor = { ...EXAMPLE_DESCRIPTOR, capabilities: { ...EXAMPLE_DESCRIPTOR.capabilities, sessions: true, history: false } };

let bundleDir: string;
let writerScript: string;
beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(tmpdir(), 'fatg-killed-writer-bundle-'));
  writerScript = path.join(bundleDir, 'killed-writer.mjs');
  await build({
    entryPoints: [path.resolve('tests/conversations/killed-writer.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: writerScript, logLevel: 'silent',
    tsconfig: path.resolve('tsconfig.base.json'),
    define: { __FATG_SMOKE_HOOKS__: 'true' },
    banner: { js: "import { createRequire as __fatgRequire } from 'node:module'; const require = __fatgRequire(import.meta.url);" },
  });
});
afterAll(() => { rmSync(bundleDir, { recursive: true, force: true }); });

let root: string | undefined;
let writer: ChildProcess | undefined;
let app: App | undefined;
afterEach(async () => {
  app?.drop();
  app = undefined;
  if (writer !== undefined && writer.exitCode === null && writer.signalCode === null) kill(writer);
  writer = undefined;
  // A process that was just ended can hold its files a little longer on Windows.
  if (root !== undefined) await removeFolder(root);
  root = undefined;
});

/** With no cleanup: nothing of the process runs again. */
function kill(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { windowsHide: true });
  else child.kill('SIGKILL');
}

interface Left { readonly dir: string; readonly folder: string }

/** Runs the writer to `point`, and kills it there. Answers the data folder it left. */
async function killedAt(point: string, version?: number): Promise<Left> {
  root = mkdtempSync(path.join(tmpdir(), 'fatg-killed-writer-'));
  const dir = path.join(root, 'data');
  const folder = path.join(root, 'project');
  mkdirSync(folder);
  placeRecords(dir, folder, DESCRIPTOR.id, [sessionEntry(1, DESCRIPTOR.id)]);
  const child = spawn(process.execPath, [writerScript, dir, folder, point, ...(version === undefined ? [] : [String(version)])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  writer = child;
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8'); });
  const exited = new Promise<void>((resolve) => { child.on('exit', () => resolve()); });
  await until(() => {
    if (output.includes(`AT ${point}\n`)) return true;
    if (child.exitCode !== null) throw new Error(`the writer ended before ${point}: ${errors.slice(0, 500)}`);
    return false;
  }, `the writer reaching ${point}`, 30_000);
  kill(child);
  await exited;
  return { dir, folder };
}

/** The next launch, on what the writer left, with a provider that records what it is asked. */
function restart(left: Left): { readonly app: App; readonly fake: FakeFacet } {
  const fake = fakeFacet({ history: false });
  const launched = launchApp({ dir: left.dir, descriptor: DESCRIPTOR, facet: () => fake.facet });
  app = launched;
  return { app: launched, fake };
}
const hashes = (dir: string): Record<string, string> => Object.fromEntries(storeFiles().filter((name) => existsSync(path.join(dir, name))).map((name) => [name, createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex')]));

describe('killed during a turn (V7; C15, C16)', () => {
  it.each(['before-dispatch', 'after-dispatch'])('%s: the prompt is there, unacknowledged, and nothing sends it again', async (point) => {
    const left = await killedAt(point);
    const { app: next, fake } = restart(left);
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`]);
    // Killed before the dispatch and killed after it read alike: fat-g cannot tell them apart, and
    // the turn claims no more than that the provider never confirmed it.
    const [turn] = next.read(1).turns;
    expect(turn).toMatchObject({ state: 'unacknowledged', outcome: null, gap: false });
    expect(turn?.time).toMatchObject({ providerEndedAt: null, endReceivedAt: null });
    expect(CHAT_LINES.unacknowledged('Example')).not.toMatch(/not (sent|delivered)/);
    // The session reads STOPPED: its last turn has no end, in either store.
    expect(next.summary(1)?.attention).toMatchObject({ kind: 'stopped' });
    await next.service.settled();
    expect(storedSession(left.dir, 1)?.['lastTurn']).toMatchObject({ turnId: turn?.id, endedAt: null, outcome: null });
    // No path sent the prompt again: no session was asked for.
    expect(fake.made).toEqual([]);
    await next.select(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.made).toEqual([]);
  });

  it('between two items: what was committed is shown, the turn is unfinished, and no end is invented', async () => {
    const left = await killedAt('between-items');
    const { app: next, fake } = restart(left);
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Looking for the cat.']);
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
    expect(next.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'stopped' } });
    expect(fake.made).toEqual([]);
    // The echo had named the prompt, and the reference was stored with its turn (C28).
    expect(next.read(1).items[0]?.providerItemId).toBe('provider-item-1');
    expect(next.conversations.conversation(S(1))).toMatchObject({ reference: 'provider-session-1', folder: left.folder });
  });

  it('inside the terminal commit: the answer is there, the end is not, and the turn reads unfinished', async () => {
    const left = await killedAt('terminal-commit');
    const { app: next, fake } = restart(left);
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Looking for the cat.', 'assistant: Miso.']);
    // The commit never happened: nothing of the provider's end is stored, and none is made up.
    expect(next.conversations.lastLocalTurn(S(1))).toMatchObject({ providerOutcome: null, endReceivedAt: null, sessionOutcome: null, providerTook: true });
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
    expect(next.summary(1)?.attention).toMatchObject({ kind: 'stopped' });
    expect(fake.made).toEqual([]);
  });
});

// M19 (V6, V7, V26; C14–C19, C64): killed while a message is being written. The store holds what its
// last write held — at most two seconds less than had arrived — as a message that never finished.
describe('killed while a message is written (M19: V6, V7, V26)', () => {
  it('after a progress write: the next launch holds what that write held, partial, under a turn that reads unfinished', async () => {
    const left = await killedAt('stream-progress');
    const { app: next, fake } = restart(left);
    // The last piece arrived after the write, and was in memory alone.
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: The cat is called ']);
    const [, answer] = next.read(1).items;
    // Never `streaming` here: no turn of this process is writing it.
    expect(answer).toMatchObject({ state: 'partial', phase: 'final', providerItemId: 'provider-item-2', origin: 'local' });
    expect(answer === undefined ? null : itemCut(answer)).toBe(false);
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
    expect(next.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'stopped' } });
    // Nothing asks the provider for the rest, and nothing sends the prompt again.
    expect(fake.made).toEqual([]);
    await next.select(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.made).toEqual([]);
    expect(next.read(1).items[1]).toMatchObject({ state: 'partial' });
  });

  it('inside the transaction that completes it: the last progress write stands, and the message is still partial', async () => {
    const left = await killedAt('stream-complete-commit');
    const { app: next } = restart(left);
    // Text, state and phase are replaced together or not at all: none of the whole message is there.
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: The cat is called ']);
    expect(next.read(1).items[1]).toMatchObject({ state: 'partial', phase: 'final' });
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
  });

  it('after it: the message is whole and complete, in the place it was opened at, and its turn has no end', async () => {
    const left = await killedAt('stream-completed');
    const { app: next } = restart(left);
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: The cat is called Miso.']);
    expect(next.read(1).items[1]).toMatchObject({ state: 'complete', phase: 'final', providerItemId: 'provider-item-2' });
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
  });

  it('past the bound: the progress write stored the text cut and its flag, and the next launch shows the message partial and cut', async () => {
    const left = await killedAt('stream-cut');
    const { app: next } = restart(left);
    const [, answer] = next.read(1).items;
    expect(answer).toMatchObject({ state: 'partial', phase: 'final' });
    const text = answer === undefined ? '' : itemText(answer);
    expect(text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(text.startsWith('The cat is xxx')).toBe(true);
    expect(text).not.toContain('never shown');
    expect(answer === undefined ? null : itemCut(answer)).toBe(true);
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
  });
});

describe('killed as a turn’s answer is settled (M16, V29; C74)', () => {
  const phases = (next: App) => next.read(1).items.filter((item) => item.role === 'assistant').map((item) => [item.providerItemId, item.phase]);

  it('inside the transaction that stores the end and the answer’s phase: neither is there', async () => {
    const left = await killedAt('answer-commit');
    const { app: next, fake } = restart(left);
    // Never an answer that reads as commentary under a turn that reads completed, nor the reverse.
    expect(phases(next)).toEqual([['provider-item-2', 'commentary'], ['provider-item-3', 'commentary']]);
    expect(next.conversations.lastLocalTurn(S(1))).toMatchObject({ providerOutcome: null, endReceivedAt: null });
    expect(next.read(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: null });
    expect(fake.made).toEqual([]);
  });

  it('after it: both are there, and the answer still reads as the answer in the next run', async () => {
    const left = await killedAt('answer-committed');
    const { app: next } = restart(left);
    expect(phases(next)).toEqual([['provider-item-2', 'commentary'], ['provider-item-3', 'final']]);
    expect(next.conversations.lastLocalTurn(S(1))).toMatchObject({ providerOutcome: 'completed' });
    expect(next.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Looking for the cat.', 'assistant: Miso.']);
  });
});

describe('killed after the provider’s end, its worker still running (V23; C29, C54)', () => {
  it('reads STOPPED, with no end in the record, the provider’s outcome kept and the content whole', async () => {
    const left = await killedAt('worker-after-end');
    const { app: next } = restart(left);
    await next.service.settled();
    expect(storedSession(left.dir, 1)?.['lastTurn']).toMatchObject({ endedAt: null, outcome: null });
    expect(next.summary(1)?.attention).toMatchObject({ kind: 'stopped' });
    expect(next.texts(1)).toEqual([`user: ${PROMPT}`, 'assistant: Looking for the cat.', 'assistant: Miso.']);
    // The turn itself ended, by the provider's word; the session never did.
    expect(next.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(next.conversations.lastLocalTurn(S(1))).toMatchObject({ providerOutcome: 'completed', sessionOutcome: null });
  });
});

describe('a killed writer’s store (V18; C36–C40)', () => {
  it('is opened as after a crash: committed work in the log is read, and the open transaction’s is not', async () => {
    const left = await killedAt('terminal-commit');
    // While open, the store is its three files: the log holds what was committed.
    expect(Object.keys(hashes(left.dir)).sort()).toEqual(storeFiles().slice().sort());
    const { app: next } = restart(left);
    expect(next.conversations.status()).toEqual({ kind: 'ok' });
    expect(next.read(1).items).toHaveLength(3);
  });

  it('keeps its main file and its log byte for byte when this build refuses it', async () => {
    // A writer of a later format, killed with a transaction open and committed work still in its log.
    const left = await killedAt('terminal-commit', CONVERSATIONS_VERSION + 1);
    const before = hashes(left.dir);
    expect(before[`${STORE_FILE}-wal`]).toBeDefined();
    const size = readFileSync(path.join(left.dir, STORE_FILE)).length;
    expect(openStore(path.join(left.dir, STORE_FILE), size)).toEqual({ kind: 'refused', cause: 'newer' });
    const after = hashes(left.dir);
    expect(after[STORE_FILE]).toBe(before[STORE_FILE]);
    expect(after[`${STORE_FILE}-wal`]).toBe(before[`${STORE_FILE}-wal`]);
    // And again: a second check changes nothing more.
    expect(openStore(path.join(left.dir, STORE_FILE), size)).toEqual({ kind: 'refused', cause: 'newer' });
    expect(hashes(left.dir)).toEqual(after);
    // The app says so, and leaves the records as they are.
    const { app: next } = restart(left);
    expect(next.conversations.status()).toEqual({ kind: 'refused', cause: 'newer' });
    expect(next.service.snapshot().sessions[0]?.block).toBe('conversations-refused');
  });
});

describe('a removal killed in the middle (V24; C21, C63)', () => {
  it('after its mark: the next open finishes it — the record goes, then the rows — and the provider is asked nothing', async () => {
    const left = await killedAt('removal-marked');
    const { app: next, fake } = restart(left);
    await until(() => next.conversations.conversation(S(1)) === null, 'the removal finishing');
    expect(next.service.snapshot().sessions).toEqual([]);
    expect(storedSession(left.dir, 1)).toBeUndefined();
    expect(next.follower.detached()).toEqual([]);
    expect(fake.made).toEqual([]);
    expect(fake.reads).toEqual([]);
  });

  it('inside the deletion: the record is gone, the rows are not, and the next open deletes them', async () => {
    const left = await killedAt('removal-delete');
    expect(storedSession(left.dir, 1)).toBeUndefined();
    const { app: next } = restart(left);
    // Finished at the open: never shown, never counted as a chat without a session.
    expect(next.conversations.conversation(S(1))).toBeNull();
    expect(next.follower.detached()).toEqual([]);
    expect(next.conversations.conversations()).toEqual([]);
  });
});
