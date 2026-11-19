// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One set of tests for every provider's chat through the conversation store (docs/planning/_archive/M18.md,
// Design 11; V4, V12; C9, C10, C13, C14, C19, C21, C22, C25): a facet driven through the real
// runtime, session service and stores in a temporary folder — a turn recorded, a restart, a page, a
// removal, a failed write. The example provider with history, the example provider without, and
// Codex against its replay fake all pass it (store-contract.test.ts, tests/codex/). Nothing here
// names a provider: what differs between them is their descriptor's word.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatCapability } from '@shared/contracts/conversation';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import { storeFiles } from '../../src/main/conversations/format';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession, until } from './app';

/** The store's transactions that write an item: its insert whole, its text as it grows, its completion (M19, C14–C17). */
const ITEM_WRITES: readonly string[] = ['item', 'progress', 'complete'];

export interface StoreHarness {
  readonly descriptor: ProviderDescriptor;
  /** The data folder, empty. */
  readonly dir: string;
  /** A folder a session may start in. */
  readonly folder: string;
  readonly model: string;
  readonly effort: string | null;
  /** A prompt the provider answers with a turn that completes. */
  readonly prompt: string;
  /** The provider's facet for one run of the app. Asked again after a quit, it is the next run's. */
  facet(): Promise<SessionFacet>;
  dispose(): Promise<void>;
}

/** A facet with every call to it counted: what a test says the provider was, or was not, asked. */
function counted(facet: SessionFacet): { readonly facet: SessionFacet; readonly calls: string[] } {
  const calls: string[] = [];
  const session = (kind: string, made: ProviderSession): ProviderSession => ({
    subscribe: (listener) => made.subscribe(listener),
    send(turn) { calls.push(`${kind}:send`); made.send(turn); },
    stop() { calls.push('stop'); made.stop(); },
    closed: made.closed,
    close: () => made.close(),
    recheck: () => made.recheck(),
  });
  const { history } = facet;
  return {
    calls,
    facet: {
      start(options) { calls.push('start'); return session('start', facet.start(options)); },
      resume(options) { calls.push('resume'); return session('resume', facet.resume(options)); },
      ...(history === undefined ? {} : { history: { read(reference, page, signal) { calls.push(`history:${page.detail}`); return history.read(reference, page, signal); }, onAvailable: (listener) => history.onAvailable(listener) } }),
    },
  };
}

export function describeStoreContract(name: string, setup: () => Promise<StoreHarness>): void {
  describe(`the conversation store’s contract: ${name}`, () => {
    /** One run of the app on the harness's data folder, with its provider's calls counted. */
    async function launch(harness: StoreHarness, fault?: () => string | null): Promise<{ readonly app: App; readonly calls: string[] }> {
      const { facet, calls } = counted(await harness.facet());
      const app = launchApp({
        // The mode the captures were taken under, as the user's default: the fallback, Auto reviewed
        // (decision 0027, item 7), is not what these replays confirm.
        dir: harness.dir, descriptor: harness.descriptor, facet: () => facet, userDefault: () => 'ask-first',
        // `item` fails every write of an item, however it is told (M19, C57): whole, or as it is written and then completed.
        store: fault === undefined ? {} : { hook: (point) => { const failing = fault(); if (failing === point || (failing === 'item' && ITEM_WRITES.includes(point))) throw Object.assign(new Error('disk'), { code: 'EIO' }); } },
      });
      return { app, calls };
    }
    const place = (harness: StoreHarness): void => placeRecords(harness.dir, harness.folder, harness.descriptor.id, [sessionEntry(1, harness.descriptor.id, { model: harness.model, effort: harness.effort })]);
    const idle = (app: App) => until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 20_000);
    const checked = (app: App) => until(() => ['checked', 'unsupported', 'failed'].includes(app.read(1).history.state), 'the history check ending', 20_000);
    async function turn(app: App, prompt: string): Promise<void> {
      expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
      await idle(app);
      await app.service.settled();
    }
    const hasHistory = (harness: StoreHarness): boolean => chatCapability(harness.descriptor, 'history') === 'supported';

    it('records a turn as it happens, and reads it back whole after a restart: both sides, times and the outcome, nothing twice', async () => {
      const harness = await setup();
      try {
        place(harness);
        const first = await launch(harness);
        await turn(first.app, harness.prompt);
        const live = first.app.read(1);
        // Both sides, in order: the prompt first, an answer last.
        expect(live.items[0]).toMatchObject({ role: 'user', origin: 'local', kind: 'message' });
        expect(live.items.at(-1)).toMatchObject({ role: 'assistant', phase: 'final' });
        expect(new Set(live.items.map((item) => item.id)).size).toBe(live.items.length);
        // Each item has the time main took it; no provider's time is made up for a message, and an
        // activity has one only where the provider reported it (M20a, C29).
        for (const item of live.items.filter((entry) => entry.kind === 'message')) expect(item.time).toMatchObject({ providerAt: null });
        expect(live.items.every((item) => typeof item.time.receivedAt === 'number')).toBe(true);
        // The provider said the turn was over: it reads ended, with its outcome.
        expect(live.turns).toHaveLength(1);
        expect(live.turns[0]).toMatchObject({ state: 'ended', outcome: 'completed', gap: false, origin: 'local' });
        expect(live).toMatchObject({ latest: true, older: null, storage: 'ok' });
        // The record holds the session's own end of that same turn, by its id (C29).
        expect(storedSession(harness.dir, 1)?.['lastTurn']).toMatchObject({ turnId: live.turns[0]?.id, outcome: 'completed' });
        await first.app.quit();

        // The next run: before anything is asked of the provider, the chat is there.
        const second = await launch(harness);
        const back = second.app.read(1);
        expect(back.items).toEqual(live.items);
        expect(back.turns).toEqual(live.turns);
        expect(second.calls).toEqual([]);
        expect(back.history.state).toBe(hasHistory(harness) ? 'not-checked' : 'unsupported');
        // It started in fat-g, and the store holds its start: nothing earlier is missing.
        expect(back.history.earlierMissing).toBe(false);
        await second.app.quit();
      } finally { await harness.dispose(); }
    });

    it('checks the provider’s history where there is one, and shows nothing twice: local detail is kept, and a second check reads no item', async () => {
      const harness = await setup();
      try {
        place(harness);
        const first = await launch(harness);
        await turn(first.app, harness.prompt);
        const recorded = first.app.read(1).items;
        await first.app.quit();

        const second = await launch(harness);
        await second.app.select(1);
        await checked(second.app);
        if (!hasHistory(harness)) {
          // A provider with no history is asked nothing (C25).
          expect(second.calls).toEqual([]);
          expect(second.app.read(1).items).toEqual(recorded);
        } else {
          expect(second.app.read(1).history.state).toBe('checked');
          const after = second.app.read(1).items;
          // Every recorded item is still there, as it was recorded: same id, same text, same time.
          for (const item of recorded) expect(after.find((candidate) => candidate.id === item.id)).toMatchObject({ blocks: item.blocks, time: item.time, origin: 'local' });
          // The prompt is shown once, whatever the provider's copy of it reads.
          expect(after.filter((item) => item.role === 'user' && item.origin === 'local')).toHaveLength(1);
          const providerIds = after.flatMap((item) => (item.providerItemId === null ? [] : [item.providerItemId]));
          expect(new Set(providerIds).size).toBe(providerIds.length);
          // Nor is anything it did (M20a, C58): an activity recorded as it happened is the one the provider's history names.
          for (const item of recorded.filter((entry) => entry.kind === 'activity')) expect(after.filter((candidate) => candidate.kind === 'activity' && candidate.providerItemId === item.providerItemId).map((candidate) => candidate.id)).toEqual([item.id]);
        }
        const settled = second.app.read(1).items;
        await second.app.quit();

        // Once more: the same page of the provider's, a second time. Nothing is added, and no item is read.
        const third = await launch(harness);
        await third.app.select(1);
        await checked(third.app);
        expect(third.app.read(1).items).toEqual(settled);
        expect(third.calls.filter((call) => call.startsWith('history:') && call !== 'history:none')).toEqual([]);
        await third.app.quit();
      } finally { await harness.dispose(); }
    });

    it('resumes the provider’s session at the next prompt of a later run, and records that turn after the first', async () => {
      const harness = await setup();
      try {
        place(harness);
        const first = await launch(harness);
        await turn(first.app, harness.prompt);
        const reference = storedSession(harness.dir, 1)?.['reference'];
        expect(typeof reference).toBe('string');
        await first.app.quit();

        const second = await launch(harness);
        await second.app.select(1);
        await checked(second.app);
        await turn(second.app, harness.prompt);
        expect(second.calls.filter((call) => call === 'start' || call === 'resume')).toEqual(['resume']);
        expect(storedSession(harness.dir, 1)?.['reference']).toBe(reference);
        const local = second.app.read(1).items.filter((item) => item.role === 'user' && item.origin === 'local');
        expect(local).toHaveLength(2);
        // By their stored places: the later prompt after the earlier one's whole turn.
        expect(local[0]?.order.turn).toBeLessThan(local[1]?.order.turn ?? 0);
        await second.app.quit();
      } finally { await harness.dispose(); }
    });

    it('reads a window from an item, and the page before one', async () => {
      const harness = await setup();
      try {
        place(harness);
        const { app } = await launch(harness);
        await turn(app, harness.prompt);
        await turn(app, harness.prompt);
        const all = app.read(1).items;
        const [first, second] = all;
        if (first === undefined || second === undefined) throw new Error('too few items');
        expect(app.runtime.read(S(1), { from: first.id, keep: 'newest' })).toMatchObject({ status: 'read', items: all, latest: true });
        expect(app.runtime.read(S(1), { from: second.id, keep: 'oldest' })).toMatchObject({ status: 'read', items: all.slice(1), older: second.id });
        expect(app.runtime.page(S(1), second.id)).toMatchObject({ status: 'page', items: [first], older: null });
        expect(app.runtime.page(S(1), 'no-such-item')).toEqual({ status: 'refused', reason: 'unknown-cursor' });
        await app.quit();
      } finally { await harness.dispose(); }
    });

    it('removes the chat with its session, asks the provider nothing, and leaves the text in none of the store’s files', async () => {
      const harness = await setup();
      try {
        place(harness);
        const { app, calls } = await launch(harness);
        await turn(app, harness.prompt);
        const holding = (): string[] => storeFiles().filter((file) => existsSync(path.join(harness.dir, file)) && readFileSync(path.join(harness.dir, file)).includes(harness.prompt));
        expect(holding()).not.toEqual([]);
        const before = calls.length;
        const answer = await app.removal.run([S(1)], () => app.service.remove(S(1)), (result) => result.status === 'saved');
        expect(answer).toEqual({ status: 'saved' });
        // Nothing of the provider's is deleted, and nothing is asked of it (C22).
        expect(calls.slice(before)).toEqual([]);
        expect(app.conversations.conversation(S(1))).toBeNull();
        expect(holding()).toEqual([]);
        expect(app.runtime.read(S(1))).toEqual({ status: 'refused', reason: 'unknown-session' });
        await app.quit();
        expect(readdirSync(harness.dir).filter((file) => readFileSync(path.join(harness.dir, file)).includes(harness.prompt))).toEqual([]);
      } finally { await harness.dispose(); }
    });

    it('refuses a prompt whose record cannot be written, sends nothing, and takes the next one', async () => {
      const harness = await setup();
      try {
        place(harness);
        let fault: string | null = 'accept';
        const { app, calls } = await launch(harness, () => fault);
        expect(await app.runtime.send(S(1), harness.prompt)).toEqual({ status: 'refused', reason: 'storage-failed' });
        // Nothing was dispatched: no session was even asked for.
        expect(calls).toEqual([]);
        expect(app.service.isRunning(S(1))).toBe(false);
        expect(app.read(1).items).toEqual([]);
        fault = null;
        await turn(app, harness.prompt);
        expect(calls.slice(0, 2)).toEqual(['start', 'start:send']);
        expect(app.read(1).items.filter((item) => item.role === 'user')).toHaveLength(1);
        await app.quit();
      } finally { await harness.dispose(); }
    });

    it('keeps a turn’s output shown when it cannot be saved, says that part of it was not, and takes a later prompt', async () => {
      const harness = await setup();
      try {
        place(harness);
        let fault: string | null = null;
        const { app } = await launch(harness, () => fault);
        expect(await app.runtime.send(S(1), harness.prompt)).toEqual({ status: 'accepted' });
        // The prompt is on disk; every item after it fails.
        fault = 'item';
        await idle(app);
        const shown = app.read(1);
        expect(shown.items.at(-1)).toMatchObject({ role: 'assistant', phase: 'final' });
        expect(shown.storage).toBe('failing');
        expect(shown.turns[0]?.gap).toBe(true);
        fault = null;
        await turn(app, harness.prompt);
        expect(app.read(1).items.filter((item) => item.role === 'user')).toHaveLength(2);
        // The gap is in the store now: a check will read that turn again (C51).
        expect(app.conversations.turn(S(1), shown.turns[0]?.id ?? '')?.gap).toBe(true);
        await app.quit();
      } finally { await harness.dispose(); }
    });
  });
}
