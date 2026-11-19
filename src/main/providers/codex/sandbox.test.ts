// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V18, V19, the adapter's part (docs/planning/_archive/M22.md, Design 7; C60–C62, C72, C73): an account's
// sandbox connection, on a scripted process. What it asks and on which connection, when each
// connection is closed, and every end of a setup — Codex's word, a refusal, an answer that never
// comes, a connection that ends first, the user letting go — with the frames K6's two setups
// captured. The same against the replay fake, on a real process, is in tests/codex/.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupHolds } from '@shared/contracts/permissions';
import { ProcessFailure } from '@shared/provider-kit/process';
import { mayBeSent } from './methods';
import { createCodexSandbox, MAX_READINESS_ATTEMPTS, SANDBOX_TIMINGS } from './sandbox';
import { scriptedContext, type ScriptedConnection, settle } from './session-test-support';

const executable = { path: 'C:\\bin\\codex.exe', kind: 'native' } as const;
const READINESS = 'windowsSandbox/readiness';
const SETUP = 'windowsSandbox/setupStart';
const COMPLETED = 'windowsSandbox/setupCompleted';

interface Captured { readonly dir: string; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown } }
const capture = (name: string): Captured[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: Captured[] }).frames;
/** K6's two setups: the one the maintainer approved, and the one they declined. */
const APPROVED = capture('m22-codex-setup');
const DECLINED = capture('m22-codex-setup-declined');
const completedOf = (frames: Captured[]) => frames.find((f) => f.dir === 'recv' && f.frame.method === COMPLETED)?.frame.params as Record<string, unknown>;
const replyTo = (frames: Captured[], method: string, nth = 0) => { const sent = frames.filter((f) => f.dir === 'send' && f.frame.method === method)[nth]; return frames.find((f) => f.dir === 'recv' && f.frame.method === undefined && f.frame.id === sent?.frame.id)?.frame.result; };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(hasExecutable = true) {
  const script = scriptedContext();
  let found = hasExecutable;
  let changes = 0;
  let ended = 0;
  let listener: (() => void) | null = null;
  const sandbox = createCodexSandbox({ context: script.context, executable: () => (found ? executable : undefined), argsPrefix: ['fake.mjs'], applicationVersion: '9.9.9', onChanged: () => { changes += 1; listener?.(); }, onSetupEnded: () => { ended += 1; } });
  /** The `nth` connection opened, once its handshake is made. */
  const shaken = async (nth: number): Promise<ScriptedConnection> => {
    await settle();
    const wire = script.opened[nth];
    if (wire === undefined) throw new Error(`no connection ${String(nth)} was opened; ${String(script.opened.length)} were`);
    wire.pending('initialize').resolve({ platformFamily: 'windows' });
    await settle();
    return wire;
  };
  return {
    script, sandbox, shaken,
    changes: () => changes,
    ended: () => ended,
    /** What hears each change, as the registry does, which lists the modes again at once. */
    listen(heard: () => void) { listener = heard; },
    detect() { found = true; },
    /** Every request of a method, over every connection, in order. */
    sent: (method: string) => script.opened.flatMap((wire) => wire.requests.filter((request) => request.method === method)),
    /** Readiness read and answered on the `nth` connection. */
    async answer(nth: number, status: unknown) {
      const wire = await shaken(nth);
      wire.pending(READINESS).resolve(status === undefined ? {} : { status });
      await settle();
      return wire;
    },
    /** Up to `setupStart` being sent on the `nth` connection, with readiness known as not configured from the first. */
    async pressed(nth = 1) {
      sandbox.readiness();
      await this.answer(0, 'notConfigured');
      expect(sandbox.act('start')).toBe('started');
      return shaken(nth);
    },
  };
}

describe('readiness, asked of a fresh process (V18, V19; C61, C73)', () => {
  it('asks nothing until the account’s modes are first listed, then one request on a connection of its own, closed at its reply', async () => {
    const h = setup();
    await settle();
    expect(h.script.opened).toHaveLength(0);
    expect(h.sandbox.view()).toEqual({ state: 'idle', error: null, readiness: null });
    // The first listing: nothing is known yet, and the read is under way.
    expect(h.sandbox.readiness()).toBeNull();
    const wire = await h.shaken(0);
    // Started as the account's other processes are: the same executable and argument, in fat-g's own probe folder.
    expect(wire.options.executable).toEqual(executable);
    expect(wire.options.args).toEqual(['fake.mjs', 'app-server']);
    expect(wire.options.options).toEqual({ cwd: 'C:\\probe', stdoutLimit: 1024 * 1024 });
    // `clientInfo` alone, nothing experimental, then the one request, with no parameters, as K1 sent it.
    expect(wire.requests[0]).toMatchObject({ method: 'initialize', params: { clientInfo: { name: 'fat_g', title: 'fat-g', version: '9.9.9' } } });
    expect(wire.notifications).toEqual([{ method: 'initialized', params: {} }]);
    expect(wire.pending(READINESS).params).toBeUndefined();
    expect(wire.pending(READINESS).timeoutMs).toBe(SANDBOX_TIMINGS.readinessMs);
    expect(wire.closes).toBe(0);
    wire.pending(READINESS).resolve(replyTo(APPROVED, READINESS));
    await settle();
    expect(replyTo(APPROVED, READINESS)).toEqual({ status: 'notConfigured' });
    expect(wire.closes).toBe(1);
    expect(h.changes()).toBe(1);
    expect(h.sandbox.readiness()).toBe('not-configured');
    // It started no thread and sent no prompt: the handshake and that request are all it ever sent.
    expect(wire.requests.map((request) => request.method)).toEqual(['initialize', READINESS]);
    for (const method of wire.requests.map((request) => request.method)) expect(mayBeSent('sandbox', method)).toBe(true);
  });

  it('keeps the answer for the run: no later listing asks again', async () => {
    const h = setup();
    h.sandbox.readiness();
    await h.answer(0, 'ready');
    for (let i = 0; i < 5; i++) expect(h.sandbox.readiness()).toBe('ready');
    await settle();
    expect(h.script.opened).toHaveLength(1);
    expect(h.changes()).toBe(1);
  });

  it.each([['ready', 'ready'], ['notConfigured', 'not-configured'], ['updateRequired', 'update-required']])('reads Codex’s %s as %s', async (status, expected) => {
    const h = setup();
    h.sandbox.readiness();
    await h.answer(0, status);
    expect(h.sandbox.view()).toEqual({ state: 'idle', error: null, readiness: expected });
  });

  it('joins a read under way: a second listing before the answer opens nothing more', async () => {
    const h = setup();
    h.sandbox.readiness();
    h.sandbox.readiness();
    await settle();
    h.sandbox.readiness();
    expect(h.script.opened).toHaveLength(1);
  });

  it('asks again after a read that failed — an answer it does not know, a refusal, a deadline — a few times and no more; and once more when the instance’s connection is ready again', async () => {
    const h = setup();
    h.sandbox.readiness();
    await h.answer(0, 'somethingNew');
    expect(h.sandbox.readiness()).toBeNull();
    expect(h.changes()).toBe(0);
    // The second attempt is refused by the CLI.
    const second = await h.shaken(1);
    second.pending(READINESS).reject(new ProcessFailure('rpc-error', -32601));
    await settle();
    expect(second.closes).toBe(1);
    expect(MAX_READINESS_ATTEMPTS).toBe(2);
    for (let i = 0; i < 4; i++) expect(h.sandbox.readiness()).toBeNull();
    await settle();
    expect(h.script.opened).toHaveLength(2);
    // The instance's own connection became ready: the CLI answers again, so it is asked once more.
    h.sandbox.retry();
    await h.answer(2, 'ready');
    expect(h.sandbox.readiness()).toBe('ready');
    // And never while an answer is known.
    h.sandbox.retry();
    await settle();
    expect(h.script.opened).toHaveLength(3);
  });

  it('closes the process when its handshake or its request gets no answer in time', async () => {
    const h = setup();
    h.sandbox.readiness();
    await settle();
    await vi.advanceTimersByTimeAsync(SANDBOX_TIMINGS.launchMs);
    expect(h.script.opened[0]?.closes).toBe(1);
    h.sandbox.readiness();
    const wire = await h.shaken(1);
    await vi.advanceTimersByTimeAsync(SANDBOX_TIMINGS.readinessMs);
    expect(wire.closes).toBe(1);
    expect(h.sandbox.readiness()).toBeNull();
  });

  it('starts nothing before the CLI is found, and asks once it is: a listing that came too early is no failed read', async () => {
    const h = setup(false);
    for (let i = 0; i < 5; i++) expect(h.sandbox.readiness()).toBeNull();
    await settle();
    expect(h.script.opened).toHaveLength(0);
    expect(h.sandbox.act('start')).toBe('no-setup');
    h.detect();
    h.sandbox.readiness();
    await h.answer(0, 'ready');
    expect(h.sandbox.readiness()).toBe('ready');
  });

  it('is not asked by a retry before the modes were ever listed', async () => {
    const h = setup();
    h.sandbox.retry();
    await settle();
    expect(h.script.opened).toHaveLength(0);
  });
});

describe('the setup, at the user’s press alone (V18; C60–C62, C72)', () => {
  it('sends nothing without a press: listing the modes and reading readiness never starts one', async () => {
    const h = setup();
    h.sandbox.readiness();
    await h.answer(0, 'notConfigured');
    h.sandbox.readiness();
    h.sandbox.retry();
    await settle();
    expect(h.sent(SETUP)).toEqual([]);
    expect(h.sandbox.view().state).toBe('idle');
  });

  it('sends Codex’s one request on a connection of its own, in the elevated mode, with fat-g’s probe folder, as K6 sent it', async () => {
    const h = setup();
    const wire = await h.pressed();
    expect(h.sandbox.view()).toEqual({ state: 'starting', error: null, readiness: 'not-configured' });
    expect(setupHolds(h.sandbox.view())).toBe(true);
    expect(wire).not.toBe(h.script.opened[0]);
    expect(wire.options.args).toEqual(['fake.mjs', 'app-server']);
    expect(wire.requests.map((request) => request.method)).toEqual(['initialize', SETUP]);
    expect(wire.pending(SETUP).params).toEqual({ mode: 'elevated', cwd: 'C:\\probe' });
    expect(Object.keys(APPROVED.find((f) => f.dir === 'send' && f.frame.method === SETUP)?.frame.params ?? {}).sort()).toEqual(['cwd', 'mode']);
    expect(APPROVED.find((f) => f.dir === 'send' && f.frame.method === SETUP)?.frame.params?.['mode']).toBe('elevated');
    // A deadline on the reply alone.
    expect(wire.pending(SETUP).timeoutMs).toBe(SANDBOX_TIMINGS.setupMs);
    expect(h.changes()).toBe(2);
  });

  it('waits for Codex’s word with no clock, then confirms a success from a fresh process, never by the completion alone (C61, C72)', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve(replyTo(APPROVED, SETUP));
    await settle();
    expect(replyTo(APPROVED, SETUP)).toEqual({ started: true });
    expect(h.sandbox.view()).toEqual({ state: 'waiting', error: null, readiness: 'not-configured' });
    // Windows is asking the administrator: an hour passes, and nothing ends the wait.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.sandbox.view().state).toBe('waiting');
    expect(wire.closes).toBe(0);
    expect(h.sent(SETUP)).toHaveLength(1);
    wire.notify(COMPLETED, completedOf(APPROVED));
    await settle();
    expect(completedOf(APPROVED)).toEqual({ mode: 'elevated', success: true, error: null });
    // Its own connection is closed, and readiness is asked of another: the process that ran the setup still answers that none is set up (K6).
    expect(wire.closes).toBe(1);
    expect(wire.requests.map((request) => request.method)).toEqual(['initialize', SETUP]);
    expect(replyTo(APPROVED, READINESS, 1)).toEqual({ status: 'notConfigured' });
    expect(h.sandbox.view().state).toBe('waiting');
    expect(h.ended()).toBe(0);
    const fresh = await h.answer(2, 'ready');
    expect(fresh.closes).toBe(1);
    expect(h.sandbox.view()).toEqual({ state: 'completed', error: null, readiness: 'ready' });
    expect(setupHolds(h.sandbox.view())).toBe(false);
    expect(h.ended()).toBe(1);
    // One request for the one press, and nothing more is asked afterwards.
    expect(h.sent(SETUP)).toHaveLength(1);
    expect(h.sandbox.readiness()).toBe('ready');
    await settle();
    expect(h.script.opened).toHaveLength(3);
    expect(h.sandbox.act('start')).toBe('no-setup');
  });

  it('says the outcome is unknown where Codex said it succeeded and a fresh process does not say ready, with what it answered', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    wire.notify(COMPLETED, { mode: 'elevated', success: true, error: null });
    await h.answer(2, 'notConfigured');
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: 'not-configured' });
    expect(h.ended()).toBe(1);
  });

  it('leaves the mode unavailable with Codex’s own reason where it says the setup did not succeed, a declined prompt among them, and asks readiness again (C61)', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    wire.notify(COMPLETED, completedOf(DECLINED));
    await settle();
    expect(completedOf(DECLINED)).toMatchObject({ success: false });
    expect(h.sandbox.view()).toEqual({ state: 'failed', error: completedOf(DECLINED)['error'], readiness: null });
    expect(String(completedOf(DECLINED)['error'])).toContain('1223');
    expect(wire.closes).toBe(1);
    expect(h.ended()).toBe(1);
    // The account is released at once, and what a fresh process answers is read.
    expect(setupHolds(h.sandbox.view())).toBe(false);
    await h.answer(2, 'notConfigured');
    expect(h.sandbox.view()).toEqual({ state: 'failed', error: completedOf(DECLINED)['error'], readiness: 'not-configured' });
    // No second request by itself; a new press sends one.
    expect(h.sent(SETUP)).toHaveLength(1);
    expect(h.sandbox.act('start')).toBe('started');
    await h.shaken(3);
    expect(h.sent(SETUP)).toHaveLength(2);
    expect(h.sandbox.view().state).toBe('starting');
  });

  it('asks readiness once after a setup’s end, though whoever hears of the end lists the modes again at once', async () => {
    const h = setup();
    const wire = await h.pressed();
    // As the registry's listener does at every change: the modes are listed, which asks for readiness.
    h.listen(() => { h.sandbox.readiness(); });
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    wire.notify(COMPLETED, completedOf(DECLINED));
    await settle();
    expect(h.sandbox.view().state).toBe('failed');
    // One fresh process, and one question: the listing joined the read the end had started.
    await h.answer(2, 'notConfigured');
    expect(h.script.opened).toHaveLength(3);
    expect(h.sent(READINESS)).toHaveLength(2);
    expect(h.sandbox.view()).toMatchObject({ state: 'failed', readiness: 'not-configured' });
    // And Stop waiting's end the same.
    expect(h.sandbox.act('start')).toBe('started');
    const again = await h.shaken(3);
    again.pending(SETUP).resolve({ started: true });
    await settle();
    expect(h.sandbox.act('stop-waiting')).toBe('stopping');
    await h.answer(4, 'notConfigured');
    expect(h.script.opened).toHaveLength(5);
    expect(h.sent(READINESS)).toHaveLength(3);
    expect(h.sent(SETUP)).toHaveLength(2);
  });

  it('bounds Codex’s reason, and takes a completion it cannot read as one that did not succeed', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    wire.notify(COMPLETED, { mode: 'elevated', success: false, error: 'e'.repeat(2_000) });
    await settle();
    expect(h.sandbox.view().error).toHaveLength(500);

    const odd = setup();
    const second = await odd.pressed();
    second.pending(SETUP).resolve({ started: true });
    await settle();
    second.notify(COMPLETED, null);
    await settle();
    expect(odd.sandbox.view()).toMatchObject({ state: 'failed', error: null });
  });

  it.each([
    ['Codex refuses the request', (wire: ScriptedConnection) => wire.pending(SETUP).reject(new ProcessFailure('rpc-error', -32600))],
    ['Codex answers without `started`', (wire: ScriptedConnection) => wire.pending(SETUP).resolve({})],
    ['Codex answers that it did not start', (wire: ScriptedConnection) => wire.pending(SETUP).resolve({ started: false })],
  ])('fails the setup where %s: the connection is closed, the account released, and readiness asked again (C72)', async (_name, answer) => {
    const h = setup();
    const wire = await h.pressed();
    answer(wire);
    await settle();
    expect(h.sandbox.view()).toEqual({ state: 'failed', error: null, readiness: null });
    expect(wire.closes).toBe(1);
    expect(h.ended()).toBe(1);
    await h.answer(2, 'notConfigured');
    expect(h.sent(SETUP)).toHaveLength(1);
  });

  it('says the outcome is unknown where the request is not answered: it may have been taken, and no second one is sent (C72)', async () => {
    const h = setup();
    const wire = await h.pressed();
    await vi.advanceTimersByTimeAsync(SANDBOX_TIMINGS.setupMs);
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: null });
    expect(wire.closes).toBe(1);
    // One readiness from a fresh process, and what it answers is shown.
    await h.answer(2, 'notConfigured');
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: 'not-configured' });
    expect(h.sent(SETUP)).toHaveLength(1);
    expect(h.sent(READINESS)).toHaveLength(2);
  });

  it('says the outcome is unknown where the connection ends before Codex’s word, and a sandbox a fresh process then reports is taken as there', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    wire.end();
    await settle();
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: null });
    expect(h.ended()).toBe(1);
    await h.answer(2, 'ready');
    // Still an outcome fat-g did not hear, with what Codex reports beside it.
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: 'ready' });
    expect(h.sent(SETUP)).toHaveLength(1);
  });

  it('lets go of the wait at the user’s word: the connection is closed, the outcome unknown, readiness read, and a late completion changes nothing (C72)', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    expect(h.sandbox.act('stop-waiting')).toBe('stopping');
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: null });
    expect(setupHolds(h.sandbox.view())).toBe(false);
    await settle();
    expect(wire.closes).toBe(1);
    await h.answer(2, 'notConfigured');
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: 'not-configured' });
    expect(h.ended()).toBe(1);
    expect(h.sandbox.act('stop-waiting')).toBe('no-setup');
    expect(h.sent(SETUP)).toHaveLength(1);
  });

  it('lets go while the fresh process is still being asked after a success: unknown at once, and that answer is no confirmation', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    wire.notify(COMPLETED, { mode: 'elevated', success: true, error: null });
    await h.shaken(2);
    expect(h.sandbox.act('stop-waiting')).toBe('stopping');
    expect(h.sandbox.view().state).toBe('unknown');
    // The read the stop started is the one whose answer is shown.
    await h.answer(3, 'ready');
    h.script.opened[2]?.pending(READINESS).resolve({ status: 'ready' });
    await settle();
    expect(h.sandbox.view()).toEqual({ state: 'unknown', error: null, readiness: 'ready' });
    expect(h.ended()).toBe(1);
  });

  it('lets go before the request has gone: nothing was asked of Codex, and nothing is sent for that press', async () => {
    const h = setup();
    h.sandbox.readiness();
    await h.answer(0, 'notConfigured');
    expect(h.sandbox.act('start')).toBe('started');
    // Its process is still starting.
    expect(h.sandbox.act('stop-waiting')).toBe('stopping');
    expect(h.sandbox.view()).toEqual({ state: 'idle', error: null, readiness: 'not-configured' });
    const wire = await h.shaken(1);
    expect(wire.closes).toBe(1);
    expect(h.sent(SETUP)).toEqual([]);
    expect(h.ended()).toBe(0);
  });

  it('fails a setup whose process could not be started: nothing was sent', async () => {
    const h = setup();
    h.sandbox.readiness();
    await h.answer(0, 'notConfigured');
    h.script.failNextOpen();
    expect(h.sandbox.act('start')).toBe('started');
    await settle();
    expect(h.sandbox.view()).toMatchObject({ state: 'failed', error: null });
    expect(h.sent(SETUP)).toEqual([]);
  });

  it('answers `running` to a second press while one is under way, and sends no second request (C62)', async () => {
    const h = setup();
    const wire = await h.pressed();
    expect(h.sandbox.act('start')).toBe('running');
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    expect(h.sandbox.act('start')).toBe('running');
    await settle();
    expect(h.sent(SETUP)).toHaveLength(1);
    expect(h.script.opened).toHaveLength(2);
  });

  it('offers none where Codex says the sandbox is ready, and none before Codex has said anything of it (C60)', async () => {
    const ready = setup();
    ready.sandbox.readiness();
    await ready.answer(0, 'ready');
    expect(ready.sandbox.act('start')).toBe('no-setup');
    const unknown = setup();
    expect(unknown.sandbox.act('start')).toBe('no-setup');
    expect(unknown.sandbox.act('stop-waiting')).toBe('no-setup');
    await settle();
    expect([...ready.sent(SETUP), ...unknown.sent(SETUP)]).toEqual([]);
    expect(unknown.script.opened).toHaveLength(0);
  });

  it('asks readiness on no setup’s own connection, and reads none while a setup is under way', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    for (let i = 0; i < 3; i++) h.sandbox.readiness();
    h.sandbox.retry();
    await settle();
    expect(h.script.opened).toHaveLength(2);
    expect(wire.requests.map((request) => request.method)).not.toContain(READINESS);
  });

  it('never sends the unelevated mode, on any path', async () => {
    const h = setup();
    const wire = await h.pressed();
    wire.pending(SETUP).reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    await h.answer(2, 'notConfigured');
    h.sandbox.act('start');
    await h.shaken(3);
    expect(h.sent(SETUP).map((request) => request.params)).toEqual([{ mode: 'elevated', cwd: 'C:\\probe' }, { mode: 'elevated', cwd: 'C:\\probe' }]);
  });

  it('keeps nothing of a setup across a restart: a sandbox made anew stands on readiness alone', async () => {
    const first = setup();
    const wire = await first.pressed();
    wire.pending(SETUP).resolve({ started: true });
    await settle();
    await first.sandbox.dispose();
    expect(wire.closes).toBe(1);
    // After fat-g starts again: idle, nothing known, and nothing sent until the modes are listed.
    const again = setup();
    await settle();
    expect(again.sandbox.view()).toEqual({ state: 'idle', error: null, readiness: null });
    expect(again.script.opened).toHaveLength(0);
  });

  it('closes whatever is open when the adapter is disposed, and says nothing more', async () => {
    const h = setup();
    h.sandbox.readiness();
    const wire = await h.shaken(0);
    const before = h.changes();
    await h.sandbox.dispose();
    await settle();
    // Closed by the disposal, and again by the read's own end: a close is idempotent.
    expect(wire.closes).toBeGreaterThanOrEqual(1);
    expect(h.changes()).toBe(before);
    expect(h.sandbox.act('start')).toBe('no-setup');
  });
});
