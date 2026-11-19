// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7, V8, V14, V30, V53, V60 (docs/planning/_archive/M15.md) and V2, V5 (M18.md): the session runtime on the
// real Codex adapter and process layer, against the replay fake. The records store, the conversation
// store, the session service, the gate and the chat service are the app's own; only Electron is
// absent. The same runtime with a facet in the test's hands is in src/main/sessions/runtime.test.ts,
// and what the history check does on Codex is in history.integration.test.ts.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationItem } from '@shared/contracts/conversation';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession } from '../sessions/app';
import { codexHarness, eventually, type Harness, PROMPTS, STREAMED } from './harness';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface Launch { readonly app: App; close(): Promise<void> }

let harness: Harness | undefined;
let launched: Launch[] = [];
afterEach(async () => {
  for (const launch of launched) await launch.close();
  launched = [];
  await harness?.dispose();
  harness = undefined;
});

const dataDir = (h: Harness) => path.join(h.dir, 'records');
const place = (h: Harness, sessions: number[]): void => placeRecords(dataDir(h), h.project, 'codex', sessions.map((n) => sessionEntry(n, 'codex', { model: 'gpt-6-astra' })));
const stored = (h: Harness, n: number) => storedSession(dataDir(h), n);

/**
 * One run of the app's session side, on the data folder as it is on disk. Given an adapter of its
 * own, its close ends that adapter as the app's quit does, and with it the sessions' processes.
 */
function launch(h: Harness, own?: { readonly provider: AgentProvider; readonly facet: SessionFacet }): App {
  const facet = own?.facet ?? h.facet;
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet, log, userDefault: () => 'ask-first' });
  launched.push({ app, async close() { await app.quit(); await own?.provider.dispose(); } });
  return app;
}
/** Ends a run as the app's quit does. */
async function quit(app: App): Promise<void> {
  const entry = launched.find((candidate) => candidate.app === app);
  launched = launched.filter((candidate) => candidate !== entry);
  await entry?.close();
}

const shape = (items: readonly ConversationItem[]) => items.map((item) => (item.kind === 'activity' ? `activity:${item.activity?.type}` : item.role === 'assistant' ? `assistant:${item.phase}` : item.role ?? item.notice));
const idle = (app: App, n: number) => eventually(() => !app.service.isRunning(S(n)), 15_000, 'the session coming to rest');
const checked = (app: App, n: number) => eventually(() => app.read(n).history.state === 'checked', 10_000, 'the history check');
/** The processes a thread was launched on that are still running. */
const sessionPids = (h: Harness) => Object.values(h.threads()).flatMap((thread) => thread.launches.map((entry) => entry.pid)).filter((pid) => h.running().includes(pid));

describe('a prompt, from the composer to the record (V14)', () => {
  it.each(['win32', 'linux'] as const)('starts the session in its project’s folder, shows the answer, stores the thread, and sends the next prompt on the same process (%s)', async (platform) => {
    const h = harness = await codexHarness({ platform });
    place(h, [1]);
    const app = launch(h);
    expect(app.service.blockOf(S(1))).toBeNull();

    expect(await app.runtime.send(S(1), PROMPTS.saved)).toEqual({ status: 'accepted' });
    // Running from the acceptance, before any process has answered.
    expect(app.summary(1)?.status).toBe('running');
    await idle(app, 1);
    await app.service.settled();

    const record = stored(h, 1);
    const reference = record?.['reference'] as string;
    expect(typeof reference).toBe('string');
    expect(record).toMatchObject({ folder: h.project, nameSource: 'first-message', lastTurn: { outcome: 'completed' } });
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    const first = app.read(1);
    // Its messages, and the read it ran between them (M20a, C19).
    expect(shape(first.items)).toEqual(['user', 'assistant:commentary', 'activity:read', 'assistant:final']);
    expect(first.items[0]?.blocks[0]?.text).toBe(PROMPTS.saved);
    // Named by Codex: the echo gave the user's message its item id.
    expect(first.items.every((item) => typeof item.providerItemId === 'string')).toBe(true);
    // A session first started in this run has nothing earlier to check, and the store holds its start.
    expect(first.history).toEqual({ state: 'checked', olderUnread: false, earlierMissing: false });
    expect(h.threads()[reference]).toMatchObject({ cwd: h.project, turns: ['m15-saved'] });
    // The store keeps the reference with the folder it started in, as the record does (M18, C28),
    // and the turn under Codex's own id for it (C47).
    expect(app.conversations.conversation(S(1))).toMatchObject({ reference, folder: h.project });
    expect(typeof app.conversations.lastLocalTurn(S(1))?.providerTurnId).toBe('string');

    expect(await app.runtime.send(S(1), PROMPTS.resume)).toEqual({ status: 'accepted' });
    await idle(app, 1);
    expect(h.threads()[reference]?.turns).toEqual(['m15-saved', 'm15-resume']);
    expect(h.threads()[reference]?.launches).toHaveLength(1);
    expect(Object.keys(h.threads())).toEqual([reference]);
    expect(app.read(1).items.filter((item) => item.role === 'user').map((item) => item.blocks[0]?.text)).toEqual([PROMPTS.saved, PROMPTS.resume]);
    // The name came from the first prompt, and stays.
    await app.service.settled();
    expect(stored(h, 1)?.['name']).toBe(record?.['name']);
    // Nothing of the conversation is in the log.
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain(PROMPTS.saved.slice(0, 24));
  });

  it('shows a failed turn as ERROR with its notice and the CLI’s own words, kept after a restart (M18, C34)', async () => {
    const h = harness = await codexHarness();
    place(h, [1]);
    const app = launch(h, await h.adapter());
    expect(await app.runtime.send(S(1), PROMPTS.t5)).toEqual({ status: 'accepted' });
    await idle(app, 1);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'error' });
    const notice = app.read(1).items.find((item) => item.kind === 'notice');
    expect(notice).toMatchObject({ notice: 'turn-failed', role: null });
    expect(typeof notice?.detail).toBe('string');
    expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await idle(app, 1);
    expect(app.summary(1)?.attention).toMatchObject({ kind: 'ready' });
    const before = app.read(1).items;
    await app.service.settled();
    await quit(app);

    // The next run reads the notice back with its detail: it is conversation content.
    const again = launch(h);
    expect(again.read(1).items).toEqual(before);
    expect(again.read(1).turns.map((turn) => turn.outcome)).toEqual(['failed', 'completed']);
  });
});

describe('Stop, from the composer (V8)', () => {
  it('interrupts the turn: its record says interrupted, the session reads READY as the user’s own doing, and its process takes the next prompt', async () => {
    const h = harness = await codexHarness();
    place(h, [1]);
    const app = launch(h);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'refused', reason: 'not-running' });
    expect(await app.runtime.send(S(1), PROMPTS.t4)).toEqual({ status: 'accepted' });
    // Thinking now exists before the first provider frame (M105). This case stops a CLI turn
    // already doing work; the separate startup-cancellation cases cover stopping before that.
    await eventually(() => { const action = app.summary(1)?.action; return action != null && action.kind !== 'thinking'; }, 10_000, 'the turn’s first provider action');
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(app, 1);
    await app.service.settled();
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    expect(stored(h, 1)?.['lastTurn']).toMatchObject({ outcome: 'interrupted' });
    expect(Object.values(h.threads()).flatMap((thread) => thread.interrupts)).toHaveLength(1);
    // Codex confirmed the interrupt: the end is the provider's own, and the turn reads ended.
    expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'interrupted' });

    expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await idle(app, 1);
    expect(Object.values(h.threads())[0]?.launches).toHaveLength(1);
  });
});

describe('a later run (V7, V30, V60; M18, V2)', () => {
  it('shows the chat from the store with no session started and nothing asked, then resumes the thread in a new process', async () => {
    const h = harness = await codexHarness();
    place(h, [1]);
    const before = launch(h, await h.adapter());
    await before.runtime.send(S(1), PROMPTS.saved);
    await idle(before, 1);
    await before.service.settled();
    const live = before.read(1).items;
    const reference = stored(h, 1)?.['reference'] as string;
    await quit(before);
    await eventually(() => sessionPids(h).length === 0, 10_000, 'the session’s process ending');

    const app = launch(h);
    // The chat written by one launch is read by the next (V2): the same items by the same ids, with
    // no session process, no history read, and no change to the summary.
    expect(app.read(1).items).toEqual(live);
    expect(app.read(1).history).toEqual({ state: 'not-checked', olderUnread: false, earlierMissing: false });
    expect(h.threads()[reference]?.historyReads ?? []).toEqual([]);
    expect(sessionPids(h)).toEqual([]);
    // Its finished turn reads READY at the launch, already seen (0029; the maintainer's amendment of M14's C106).
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready', count: 1, acknowledged: true } });

    // Selected, its history is checked on the connection that was already there.
    await app.select(1);
    await checked(app, 1);
    expect(h.threads()[reference]?.launches).toHaveLength(1);
    const earlier = app.read(1).items;
    // What was recorded live stays as it was, first (V60).
    expect(earlier.slice(0, live.length)).toEqual(live);

    expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await idle(app, 1);
    expect(h.threads()[reference]?.launches).toHaveLength(2);
    expect(h.threads()[reference]?.turns).toEqual(['m15-saved', STREAMED.t1]);
    expect(Object.keys(h.threads())).toEqual([reference]);
    const all = app.read(1).items;
    // What was there stays, and the new turn follows it.
    expect(all.slice(0, earlier.length)).toEqual(earlier);
    expect(all[earlier.length]).toMatchObject({ role: 'user', origin: 'local' });
    expect(all[earlier.length]?.blocks[0]?.text).toBe(PROMPTS.t1);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    await app.service.settled();
    expect(stored(h, 1)).toMatchObject({ reference, lastTurn: { outcome: 'completed' } });
  });

  it('keeps the chat readable when Codex refuses to reopen the conversation (M18, V5; C13)', async () => {
    const h = harness = await codexHarness();
    place(h, [1]);
    const before = launch(h, await h.adapter());
    await before.runtime.send(S(1), PROMPTS.saved);
    await idle(before, 1);
    await before.service.settled();
    const live = before.read(1).items;
    await quit(before);

    const app = launch(h);
    await app.select(1);
    await checked(app, 1);
    // The thread is gone from Codex, as one deleted in its own app would be.
    h.control({ resumeRefused: 'malformed' });
    expect(await app.runtime.send(S(1), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await idle(app, 1);
    const after = app.read(1).items;
    // Everything recorded is still read; the refusal is a line after it, and the prompt is shown once.
    expect(after.slice(0, live.length)).toEqual(live);
    expect(after.some((item) => item.kind === 'notice')).toBe(true);
    expect(after.filter((item) => item.role === 'user' && item.blocks[0]?.text === PROMPTS.t1)).toHaveLength(1);
  });
});

describe('a session that leaves (V42)', () => {
  it('closes its process when its record is removed, and reads none of it after', async () => {
    const h = harness = await codexHarness();
    place(h, [1, 2]);
    const app = launch(h);
    await app.runtime.send(S(1), PROMPTS.t1);
    await app.runtime.send(S(2), PROMPTS.t1);
    await idle(app, 1);
    await idle(app, 2);
    await app.service.settled();
    expect(sessionPids(h)).toHaveLength(2);

    // As the Main window's Remove does it: the chat goes with the record (M18, C21).
    expect(await app.removal.run([S(1)], () => app.service.remove(S(1)), (answer) => answer.status === 'saved')).toMatchObject({ status: 'saved' });
    await eventually(() => sessionPids(h).length === 1, 10_000, 'the removed session’s process ending');
    expect(app.runtime.read(S(1))).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(app.conversations.conversation(S(1))).toBeNull();
    // Nothing of Codex's is deleted: both threads are still its own (C22).
    expect(Object.keys(h.threads())).toHaveLength(2);
    // The other session is untouched: same process, and it takes a prompt.
    expect(await app.runtime.send(S(2), PROMPTS.t1)).toEqual({ status: 'accepted' });
    await idle(app, 2);
    expect(sessionPids(h)).toHaveLength(1);
  });
});
