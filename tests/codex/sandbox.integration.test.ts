// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V18, V19, the adapter's part (docs/planning/_archive/M22.md, Design 7, 11; C4, C55, C60–C62, C72, C73):
// Codex's own sandbox setup for one account, on the real adapter and process layer against the
// replay fake, which answers readiness, the setup and each start as K1's and K6's captures have
// them. No test here uses the real CLI, and none sends a real setup: the fake's changes nothing.
//
// Codex's setup is Windows' alone, so the adapter is told which system it runs on: the tests run
// the same on the three systems CI covers. What was asked, and of which process, is read from what
// the fake noted of the account's sandbox. Every wait is on the facet's own word that something
// changed, never on a guess at how long a process takes.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModeAvailability, SandboxSetupView } from '@shared/contracts/permissions';
import { setupHolds } from '@shared/contracts/permissions';
import type { SandboxFacet, SessionFacet } from '@shared/provider-kit/sessions';
import { CODEX_INSTANCES } from '../../src/main/providers/codex/descriptor';
import { codexHarness, eventually, type Harness, PROMPTS, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

const READINESS = 'windowsSandbox/readiness';
const SETUP = 'windowsSandbox/setupStart';
const modesOf = (facet: SessionFacet): Record<string, ModeAvailability> => Object.fromEntries((facet.modes?.() ?? []).map((mode) => [mode.id, mode]));
const setupOf = (facet: SessionFacet): SandboxFacet => { if (facet.sandbox === undefined) throw new Error('the facet has no setup'); return facet.sandbox; };
/** Resolves once `read` answers, looked at now and at each change the facet tells of. */
function changedTo<T>(facet: SessionFacet, read: () => T | undefined | false, what: string, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let stop: () => void = () => undefined;
    const timer = setTimeout(() => { stop(); reject(new Error(`${what} did not come; the setup is ${JSON.stringify(facet.sandbox?.state())}`)); }, timeoutMs);
    const check = (): void => {
      const value = read();
      if (value === undefined || value === false) return;
      clearTimeout(timer); stop(); resolve(value);
    };
    stop = facet.onModesChanged?.(check) ?? stop;
    check();
  });
}
const stateIs = (facet: SessionFacet, state: SandboxSetupView['state']) => changedTo(facet, () => (setupOf(facet).state().state === state ? setupOf(facet).state() : undefined), `the setup’s ${state}`);
const readinessIs = (facet: SessionFacet, readiness: SandboxSetupView['readiness']) => changedTo(facet, () => (setupOf(facet).state().readiness === readiness ? setupOf(facet).state() : undefined), `readiness ${String(readiness)}`);
const asked = (h: Harness, home?: string) => (h.sandbox(home).asked ?? []).map((entry) => entry.method);
const sessionPids = (h: Harness): number[] => Object.values(h.threads()).flatMap((thread) => thread.launches.map((launch) => launch.pid));
/** Resolves once the process is no longer running: its connection was closed, and its tree ended. */
const gone = (h: Harness, pid: number): Promise<true> => eventually(() => !h.running().includes(pid), 20_000, 'the sandbox connection’s end');

describe('on a system other than Windows (V18, V19; C62, C73)', () => {
  it.each(['linux', 'darwin'] as const)('%s: there is no setup and no control, nothing is asked, and every mode stands available for the start reply to decide', async (platform) => {
    const h = harness = await codexHarness({ platform });
    expect(h.facet.sandbox).toBeUndefined();
    const modes = modesOf(h.facet);
    expect(Object.values(modes).map((mode) => [mode.id, mode.available, mode.setup])).toEqual([['read-only', true, false], ['ask-first', true, false], ['sandbox-ok', true, false], ['auto-reviewed', true, false], ['berserk', true, false]]);
    // A session runs, and still nothing was asked of a sandbox: the one process beside the instance's own is the session's.
    const session = watch(h.facet.start({ folder: h.project, model: 'gpt-6-luna', effort: 'low', speed: null, otherFolders: [], mode: 'ask-first', processKey: 'process-1' }));
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(h.sandbox()).toEqual({});
    expect(h.pids()).toHaveLength(2);
    // The reply decided: this account has no sandbox, so the two that need one are unavailable, with no control to set one up.
    expect(modesOf(h.facet)).toMatchObject({ 'ask-first': { available: true, unconfined: true }, 'sandbox-ok': { available: false, reason: 'needs-setup', setup: false }, 'auto-reviewed': { available: false, reason: 'needs-setup', setup: false } });
  });
});

describe('readiness, on Windows (V18, V19; C60, C73)', () => {
  it('asks Codex once, when the modes are first listed, on a process of its own that starts no thread and is closed at the reply', async () => {
    const h = harness = await codexHarness({ platform: 'win32' });
    // Nothing is asked before the modes are listed: the instance's own process is the only one.
    expect(h.sandbox()).toEqual({});
    expect(h.pids()).toHaveLength(1);
    // Still being read: its own reason, which a queued message waits on (M23, C89).
    expect(modesOf(h.facet)['sandbox-ok']).toMatchObject({ available: false, reason: 'pending', setup: false });
    await readinessIs(h.facet, 'not-configured');
    // The control is offered now that Codex has said none is set up, and only for the modes that need the sandbox.
    expect(Object.values(modesOf(h.facet)).filter((mode) => mode.setup).map((mode) => mode.id)).toEqual(['sandbox-ok', 'auto-reviewed']);
    expect(modesOf(h.facet)['ask-first']).toMatchObject({ available: true, unconfined: true });
    expect(h.sandbox().asked).toEqual([{ pid: expect.any(Number) as number, method: READINESS, params: null }]);
    // A process of its own: not the instance's, and it ran no thread. It is gone.
    const [pid] = (h.sandbox().asked ?? []).map((entry) => entry.pid);
    expect(h.pids()).toHaveLength(2);
    expect(h.pids()[0]).not.toBe(pid);
    expect(h.threads()).toEqual({});
    await gone(h, pid as number);
    // Kept for the run: listing again asks nothing.
    for (let i = 0; i < 3; i++) modesOf(h.facet);
    expect(setupOf(h.facet).state()).toEqual({ state: 'idle', error: null, readiness: 'not-configured' });
    expect(asked(h)).toEqual([READINESS]);
  });

  it('lists the five available where the account’s sandbox is ready, and offers no setup', async () => {
    const h = harness = await codexHarness({ platform: 'win32' });
    h.control({ sandboxState: 'ready' });
    modesOf(h.facet);
    await readinessIs(h.facet, 'ready');
    expect(Object.values(modesOf(h.facet)).map((mode) => [mode.available, mode.setup])).toEqual([[true, false], [true, false], [true, false], [true, false], [true, false]]);
    expect(modesOf(h.facet)).toMatchObject({ 'read-only': { records: false }, 'ask-first': { records: true, unconfined: false }, 'sandbox-ok': { records: true }, berserk: { records: true } });
    expect(setupOf(h.facet).act('start')).toBe('no-setup');
    expect(asked(h)).toEqual([READINESS]);
  });
});

describe('the setup, at the user’s press (V18; C60–C62, C72)', () => {
  /** A Windows account with no sandbox, its readiness read. */
  async function unset(control: Record<string, unknown> = {}, sandboxTimings?: { setupMs: number }): Promise<Harness> {
    const h = harness = await codexHarness({ platform: 'win32', ...(sandboxTimings === undefined ? {} : { sandboxTimings }) });
    h.control(control);
    modesOf(h.facet);
    await readinessIs(h.facet, 'not-configured');
    return h;
  }

  it('sends nothing without the press', async () => {
    const h = await unset();
    for (let i = 0; i < 3; i++) modesOf(h.facet);
    expect(asked(h)).toEqual([READINESS]);
    expect(setupOf(h.facet).act('stop-waiting')).toBe('no-setup');
  });

  it('approved: Codex’s one request, on a connection of its own; its success confirmed from a fresh process, and by the next start’s reply (C60, C61)', async () => {
    const h = await unset();
    expect(setupOf(h.facet).act('start')).toBe('started');
    expect(setupHolds(setupOf(h.facet).state())).toBe(true);
    // A second press while one runs sends nothing more.
    expect(setupOf(h.facet).act('start')).toBe('running');
    expect(await stateIs(h.facet, 'completed')).toEqual({ state: 'completed', error: null, readiness: 'ready' });
    expect(setupHolds(setupOf(h.facet).state())).toBe(false);
    // The one request, in the elevated mode, with fat-g's probe folder; then readiness, of another process.
    const notes = h.sandbox().asked ?? [];
    expect(notes.map((entry) => entry.method)).toEqual([READINESS, SETUP, READINESS]);
    expect(notes[1]?.params).toEqual({ mode: 'elevated', cwd: h.context.probeDirectory });
    expect(new Set(notes.map((entry) => entry.pid)).size).toBe(3);
    expect(h.threads()).toEqual({});
    expect(h.sandbox().state).toBe('ready');
    // The modes that needed it are available, with no control.
    expect(modesOf(h.facet)).toMatchObject({ 'sandbox-ok': { available: true, setup: false, records: true }, 'auto-reviewed': { available: true, setup: false }, 'ask-first': { unconfined: false } });
    // And the next start's reply says the same: a workspace sandbox, as asked.
    const session = watch(h.facet.start({ folder: h.project, model: 'gpt-6-luna', effort: 'low', speed: null, otherFolders: [], mode: 'sandbox-ok', processKey: 'process-1' }));
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(session.events.filter((event) => event.type === 'in-force')).toEqual([{ type: 'in-force', mode: 'sandbox-ok' }]);
    expect(modesOf(h.facet)['sandbox-ok']?.places).toEqual({ temporary: true, roots: [], network: false });
    // Neither sandbox process ran the session's thread.
    expect(notes.map((entry) => entry.pid).filter((pid) => sessionPids(h).includes(pid))).toEqual([]);
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS]);
  });

  it('declined: the mode stays unavailable with Codex’s own reason and the control to try again, and a new press sends a new request (C61)', async () => {
    const h = await unset({ setupOutcome: 'declined' });
    expect(setupOf(h.facet).act('start')).toBe('started');
    const failed = await stateIs(h.facet, 'failed');
    // K6's own words for a cancelled prompt.
    expect(failed.error).toContain('1223');
    expect(failed.error?.length).toBeLessThanOrEqual(500);
    await readinessIs(h.facet, 'not-configured');
    expect(setupOf(h.facet).state()).toEqual({ state: 'failed', error: failed.error, readiness: 'not-configured' });
    expect(modesOf(h.facet)['sandbox-ok']).toMatchObject({ available: false, reason: 'needs-setup', setup: true });
    expect(h.sandbox().state).toBeUndefined();
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS]);
    // Try again, approved this time.
    h.control({});
    expect(setupOf(h.facet).act('start')).toBe('started');
    expect((await stateIs(h.facet, 'completed')).readiness).toBe('ready');
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS, SETUP, READINESS]);
  });

  it.each([
    ['setupRefused', { setupRefused: true }],
    ['setupNoStarted', { setupNoStarted: true }],
  ])('%s: a request Codex refuses, or answers without `started`, fails the setup, releases the account and asks readiness again (C72)', async (_name, control) => {
    const h = await unset(control);
    setupOf(h.facet).act('start');
    expect(await stateIs(h.facet, 'failed')).toMatchObject({ state: 'failed', error: null });
    await readinessIs(h.facet, 'not-configured');
    expect(modesOf(h.facet)['sandbox-ok']).toMatchObject({ available: false, setup: true });
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS]);
  });

  it('setupNoReply: a request that is not answered ends as an unknown outcome, with one readiness from a fresh process and no second request (C72)', async () => {
    const h = await unset({ setupNoReply: true }, { setupMs: 300 });
    setupOf(h.facet).act('start');
    expect((await stateIs(h.facet, 'unknown')).error).toBeNull();
    await readinessIs(h.facet, 'not-configured');
    expect(setupOf(h.facet).state()).toEqual({ state: 'unknown', error: null, readiness: 'not-configured' });
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS]);
  });

  it('setupOutcome drop: the connection ends before Codex’s word — unknown, read again, and never asked twice (C72)', async () => {
    const h = await unset({ setupOutcome: 'drop' });
    setupOf(h.facet).act('start');
    await stateIs(h.facet, 'unknown');
    await readinessIs(h.facet, 'not-configured');
    expect(setupHolds(setupOf(h.facet).state())).toBe(false);
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS]);
  });

  it('setupOutcome never: the wait has no clock of fat-g’s, and ends when the user lets go — unknown, the connection closed, readiness read (C72)', async () => {
    const h = await unset({ setupOutcome: 'never' });
    setupOf(h.facet).act('start');
    await stateIs(h.facet, 'waiting');
    const setupPid = (h.sandbox().asked ?? []).find((entry) => entry.method === SETUP)?.pid as number;
    expect(h.running()).toContain(setupPid);
    expect(setupOf(h.facet).act('stop-waiting')).toBe('stopping');
    expect(setupOf(h.facet).state().state).toBe('unknown');
    await readinessIs(h.facet, 'not-configured');
    await gone(h, setupPid);
    expect(asked(h)).toEqual([READINESS, SETUP, READINESS]);
    expect(setupOf(h.facet).act('stop-waiting')).toBe('no-setup');
  });

  it('keeps nothing of a setup across a restart: an adapter made anew stands on readiness alone, which a fresh process answers', async () => {
    const h = await unset();
    setupOf(h.facet).act('start');
    await stateIs(h.facet, 'completed');
    // Another adapter for the same account, as fat-g started again: nothing of the setup is kept, and readiness says ready.
    const again = await h.adapter();
    expect(again.facet.sandbox?.state()).toEqual({ state: 'idle', error: null, readiness: null });
    again.facet.modes?.();
    await readinessIs(again.facet, 'ready');
    expect(modesOf(again.facet)['sandbox-ok']).toMatchObject({ available: true, setup: false });
  });

  it('belongs to one account: setting up an added account’s sandbox leaves the first account’s as it was (C62)', async () => {
    const h = await unset();
    const home = path.join(h.dir, 'home-b');
    const other = await h.adapter({ variable: CODEX_INSTANCES.variable, folder: home, withhold: CODEX_INSTANCES.withhold });
    other.facet.modes?.();
    await readinessIs(other.facet, 'not-configured');
    expect(setupOf(other.facet).act('start')).toBe('started');
    expect((await stateIs(other.facet, 'completed')).readiness).toBe('ready');
    expect(modesOf(other.facet)['sandbox-ok']).toMatchObject({ available: true });
    // Its requests were its own processes', under its own home; the first account was sent nothing more.
    expect(asked(h, home)).toEqual([READINESS, SETUP, READINESS]);
    expect(h.sandbox(home).state).toBe('ready');
    expect(asked(h)).toEqual([READINESS]);
    expect(h.sandbox().state).toBeUndefined();
    expect(setupOf(h.facet).state()).toEqual({ state: 'idle', error: null, readiness: 'not-configured' });
    expect(modesOf(h.facet)['sandbox-ok']).toMatchObject({ available: false, setup: true });
  });
});
