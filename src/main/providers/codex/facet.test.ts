// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V24 (docs/planning/_archive/M16.md; C26, C61): Codex takes one folder. Its descriptor says so, main hands
// it no other, and a list handed to its facet all the same changes nothing of what it launches and
// sends: the frames are the ones it sent before a session start carried the field.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailure } from '@shared/provider-kit/process';
import { CODEX_DESCRIPTOR } from './descriptor';
import { createCodexFacet } from './facet';
import { scriptedContext, settle } from './session-test-support';

const executable = { path: 'C:\\bin\\codex.exe', kind: 'native' } as const;
const FOLDER = 'C:\\work\\project';
const OTHER = ['C:\\work\\shared', 'D:\\notes'];
const START_REPLY = { thread: { id: 'thread-1' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', model: 'gpt-x', reasoningEffort: 'low' };
const turn = { turnId: 'turn-1', prompt: 'Prompt 1', effort: 'low', speed: null, messageId: 'message-1' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Everything a session of the facet launches with and sends, up to its first prompt. */
async function sent(otherFolders: readonly string[], reference: string | null = null): Promise<{ args: readonly string[]; cwd: string | undefined; frames: { method: string; params: unknown }[] }> {
  const script = scriptedContext();
  const facet = createCodexFacet({ context: script.context, executable: () => executable, argsPrefix: [], applicationVersion: '1.0.0', readHistory: () => undefined });
  const start = { folder: FOLDER, model: 'gpt-x', effort: 'low', speed: null, otherFolders, mode: 'read-only', processKey: 'process-1' };
  const session = reference === null ? facet.start(start) : facet.resume({ ...start, reference });
  session.send(turn);
  await settle();
  const wire = script.latest();
  wire.pending('initialize').resolve({});
  await settle();
  wire.pending(reference === null ? 'thread/start' : 'thread/resume').resolve(START_REPLY);
  await settle();
  const frames = wire.requests.map((request) => ({ method: request.method, params: request.params }));
  const answer = { args: wire.options.args, cwd: wire.options.options?.cwd, frames };
  await facet.dispose();
  return answer;
}

describe('Codex’s facet and a project’s other folders (V24; C61)', () => {
  it('says in its descriptor that its sessions take none', () => {
    expect(CODEX_DESCRIPTOR.capabilities.otherFolders).toBe(false);
  });

  it('starts a thread in one folder, as it always has, and a list handed to it all the same changes no argument and no frame', async () => {
    const plain = await sent([]);
    expect(plain.args).toEqual(['app-server']);
    expect(plain.frames.map((frame) => frame.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(plain.frames[1]?.params).toEqual({ cwd: FOLDER, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-x', serviceTier: 'default' });

    const handed = await sent(OTHER);
    expect(handed).toEqual(plain);
    expect(JSON.stringify(handed)).not.toMatch(/shared|notes/);
  });

  it('resumes one the same way', async () => {
    const plain = await sent([], 'stored-thread');
    expect(plain.frames[1]).toEqual({ method: 'thread/resume', params: { threadId: 'stored-thread', cwd: FOLDER, sandbox: 'read-only', approvalPolicy: 'never', serviceTier: 'default', excludeTurns: true } });
    const handed = await sent(OTHER, 'stored-thread');
    expect(handed).toEqual(plain);
    expect(JSON.stringify(handed)).not.toMatch(/shared|notes/);
  });
});

// M21 (C30): the descriptor says Codex's sessions ask both ways, so each takes an answer.
describe('Codex’s facet and a question (M21; C30)', () => {
  it('declares `both`, and gives each session it starts or resumes its `answer`', async () => {
    expect(CODEX_DESCRIPTOR.capabilities.questions).toBe('both');
    const script = scriptedContext();
    const facet = createCodexFacet({ context: script.context, executable: () => executable, argsPrefix: [], applicationVersion: '1.0.0', readHistory: () => undefined });
    const start = { folder: FOLDER, model: 'gpt-x', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' };
    for (const session of [facet.start(start), facet.resume({ ...start, reference: 'stored-thread' })]) {
      expect(typeof session.answer).toBe('function');
      // One that holds nothing takes an answer for nothing: no process is started for it.
      session.answer?.('no-such-request', null);
    }
    expect(script.opened).toHaveLength(0);
    await facet.dispose();
  });
});

// M22 (V2, V18, V19, V25; C4, C39, C43, C55, C60, C62, C64, C65, C73): what an account's sessions may
// run under — the facet's `modes`, `transition`, `onModesChanged` and `sandbox`.
describe('Codex’s facet and the modes (M22; C39, C43, C60, C62, C64, C73)', () => {
  const READINESS = 'windowsSandbox/readiness';
  const WORKSPACE = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const make = (platform: NodeJS.Platform) => {
    const script = scriptedContext();
    const facet = createCodexFacet({ context: script.context, executable: () => executable, argsPrefix: [], applicationVersion: '1.0.0', readHistory: () => undefined, platform });
    let changes = 0;
    const stop = facet.onModesChanged(() => { changes += 1; });
    const byId = () => Object.fromEntries(facet.modes().map((mode) => [mode.id, mode]));
    /** One session's start under a mode, answered with a reply; resolves once the reply has been held to the mode. */
    const started = async (mode: string, reply: Record<string, unknown>) => {
      const before = script.opened.length;
      const session = facet.start({ folder: FOLDER, model: 'gpt-x', effort: 'low', speed: null, otherFolders: [], mode, processKey: 'process-1' });
      session.send(turn);
      await settle();
      const wire = script.opened[before];
      if (wire === undefined) throw new Error('the session opened no process');
      wire.pending('initialize').resolve({});
      await settle();
      wire.pending('thread/start').resolve({ thread: { id: 'thread-1' }, ...reply });
      await settle();
      return { session, wire };
    };
    /** The readiness read on the `nth` connection, answered. */
    const ready = async (nth: number, status: string) => {
      await settle();
      const wire = script.opened[nth];
      if (wire === undefined) throw new Error('no readiness read was started');
      wire.pending('initialize').resolve({});
      await settle();
      wire.pending(READINESS).resolve({ status });
      await settle();
      return wire;
    };
    return { script, facet, changes: () => changes, stop, byId, started, ready };
  };

  it('declares its modes in its descriptor, and has the three members the declaration promises', () => {
    expect(CODEX_DESCRIPTOR.capabilities.permissions?.modes.map((mode) => mode.id)).toEqual(['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk']);
    const { facet } = make('linux');
    expect(typeof facet.modes).toBe('function');
    expect(typeof facet.transition).toBe('function');
    expect(typeof facet.onModesChanged).toBe('function');
  });

  it('answers a restart for every change of mode: a thread’s policy changes by a checked resume in a fresh process alone (C64)', () => {
    const { facet } = make('win32');
    const ids = ['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk'];
    for (const from of ids) for (const to of ids) expect(facet.transition(from, to), `${from} → ${to}`).toBe('restart');
  });

  it('gives each session it starts or resumes its `decide`, and hands it the mode main resolved', async () => {
    const { facet, script, started } = make('linux');
    const { wire } = await started('sandbox-ok', { sandbox: WORKSPACE, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(wire.pending('thread/start').params).toEqual({ cwd: FOLDER, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', model: 'gpt-x', serviceTier: 'default' });
    const resumed = facet.resume({ folder: FOLDER, model: 'gpt-x', effort: 'low', speed: null, otherFolders: [], mode: 'berserk', processKey: 'process-2', reference: 'stored-thread' });
    expect(typeof resumed.decide).toBe('function');
    // One that holds nothing takes a decision for nothing: no process is started for it, and no write went.
    await expect(resumed.decide?.('n:0', 'approve')).resolves.toBe(false);
    expect(script.opened).toHaveLength(1);
    await facet.dispose();
  });

  it('has Codex’s own setup on Windows alone: elsewhere there is no control, and nothing is ever asked (C62, C73)', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const other = make(platform);
      expect(other.facet.sandbox).toBeUndefined();
      expect('sandbox' in other.facet).toBe(false);
      // Listing asks nothing: every mode stands available, and the start reply decides.
      expect(other.facet.modes().every((mode) => mode.available && !mode.setup)).toBe(true);
      other.facet.historyAvailable();
      await settle();
      expect(other.script.opened).toHaveLength(0);
    }
    const windows = make('win32');
    expect(windows.facet.sandbox?.state()).toEqual({ state: 'idle', error: null, readiness: null });
    expect(windows.script.opened).toHaveLength(0);
  });

  it('asks Codex of its sandbox when the modes are first listed, on Windows, and tells of the answer as a change (C73)', async () => {
    const h = make('win32');
    await settle();
    expect(h.script.opened).toHaveLength(0);
    // Before the answer: the two that need the sandbox stand unavailable, with no control yet, and
    // say they are still being checked, which a queued message waits on (M23, C89).
    expect(h.byId()['sandbox-ok']).toMatchObject({ available: false, reason: 'pending', setup: false });
    const wire = await h.ready(0, 'notConfigured');
    expect(wire.requests.map((request) => request.method)).toEqual(['initialize', READINESS]);
    expect(wire.closes).toBe(1);
    expect(h.changes()).toBe(1);
    expect(h.byId()).toMatchObject({
      'read-only': { available: true },
      'ask-first': { available: true, unconfined: true, records: false },
      'sandbox-ok': { available: false, reason: 'needs-setup', setup: true },
      'auto-reviewed': { available: false, reason: 'needs-setup', setup: true },
      berserk: { available: true, records: true },
    });
    expect(h.facet.sandbox?.state()).toEqual({ state: 'idle', error: null, readiness: 'not-configured' });
    // Kept for the run: no listing asks again.
    for (let i = 0; i < 3; i++) h.facet.modes();
    await settle();
    expect(h.script.opened).toHaveLength(1);
    // A listener that left hears nothing more.
    h.stop();
    await h.facet.dispose();
  });

  it('lists all five available where Codex answers ready', async () => {
    const h = make('win32');
    h.facet.modes();
    await h.ready(0, 'ready');
    expect(h.facet.modes().map((mode) => mode.available)).toEqual([true, true, true, true, true]);
    expect(h.byId()['sandbox-ok']).toMatchObject({ records: true, places: null });
  });

  it('reads a sandbox mode’s writable places from the account’s last checked reply for that mode, and tells of them as a change (C65)', async () => {
    const h = make('linux');
    const roots = { ...WORKSPACE, writableRoots: ['/var/build'], networkAccess: true };
    await h.started('sandbox-ok', { sandbox: roots, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(h.byId()['sandbox-ok']?.places).toEqual({ temporary: true, roots: ['/var/build'], network: true });
    expect(h.byId()['auto-reviewed']?.places).toBeNull();
    expect(h.changes()).toBe(1);
    // The same reply again changes nothing, and says nothing.
    await h.started('sandbox-ok', { sandbox: roots, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(h.changes()).toBe(1);
    await h.started('sandbox-ok', { sandbox: { ...WORKSPACE, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(h.byId()['sandbox-ok']?.places).toEqual({ temporary: false, roots: [], network: false });
    expect(h.changes()).toBe(2);
    await h.facet.dispose();
  });

  it('learns from a reply that the account has no sandbox: Ask first is then unconfined, and the two that need it are unavailable (C4)', async () => {
    const h = make('linux');
    const { session } = await h.started('ask-first', { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
    expect(h.byId()).toMatchObject({ 'ask-first': { available: true, unconfined: true, places: null, records: false }, 'sandbox-ok': { available: false, reason: 'needs-setup', setup: false }, 'auto-reviewed': { available: false, reason: 'needs-setup', setup: false } });
    expect(h.changes()).toBe(1);
    expect(typeof session.decide).toBe('function');
    // And from a start that was refused for it: Sandbox ok answered read-only is the same account.
    const other = make('linux');
    await other.started('sandbox-ok', { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(other.byId()['sandbox-ok']).toMatchObject({ available: false, reason: 'needs-setup' });
    expect(other.byId()['ask-first']).toMatchObject({ unconfined: true });
    await Promise.all([h.facet.dispose(), other.facet.dispose()]);
  });

  it('drops what the replies and Codex said of the account at a setup’s end, and asks a fresh process (C73)', async () => {
    const h = make('win32');
    h.facet.modes();
    await h.ready(0, 'notConfigured');
    await h.started('ask-first', { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
    expect(h.byId()['ask-first']).toMatchObject({ unconfined: true });
    // The press: Codex's one request, on a connection of its own.
    expect(h.facet.sandbox?.act('start')).toBe('started');
    expect(h.facet.sandbox?.act('start')).toBe('running');
    await settle();
    const wire = h.script.opened[2];
    wire?.pending('initialize').resolve({});
    await settle();
    expect(wire?.pending('windowsSandbox/setupStart').params).toEqual({ mode: 'elevated', cwd: 'C:\\probe' });
    wire?.pending('windowsSandbox/setupStart').resolve({ started: true });
    await settle();
    expect(h.facet.sandbox?.state().state).toBe('waiting');
    wire?.notify('windowsSandbox/setupCompleted', { mode: 'elevated', success: true, error: null });
    await h.ready(3, 'ready');
    expect(h.facet.sandbox?.state()).toEqual({ state: 'completed', error: null, readiness: 'ready' });
    // The read-only reply was of the account before its setup: it says nothing of it now.
    expect(h.byId()).toMatchObject({ 'ask-first': { unconfined: false, records: true }, 'sandbox-ok': { available: true }, 'auto-reviewed': { available: true } });
    expect(h.changes()).toBeGreaterThanOrEqual(4);
    await h.facet.dispose();
  });

  it('asks readiness again when the instance’s connection is ready, where a read of it failed', async () => {
    const h = make('win32');
    h.facet.modes();
    await settle();
    h.script.opened[0]?.pending('initialize').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    h.facet.modes();
    await settle();
    h.script.opened[1]?.pending('initialize').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    h.facet.modes();
    await settle();
    expect(h.script.opened).toHaveLength(2);
    h.facet.historyAvailable();
    await h.ready(2, 'ready');
    expect(h.byId()['sandbox-ok']).toMatchObject({ available: true });
  });
});
