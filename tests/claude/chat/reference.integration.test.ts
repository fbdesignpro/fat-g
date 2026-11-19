// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V38 (docs/planning/_archive/M16.md; C87): when a Claude session gets its reference — at its first frame from
// a model, and not before — on the real adapter and process layer against the replay fake, and
// through the app's own runtime and stores. A session with no answer has no reference: its next
// prompt goes on in its process while that is up, and starts a new conversation once it has ended.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchApp, placeRecords, S, sessionEntry, storedSession, until } from '../../sessions/app';
import { claudeHarness, type Harness, processGone, READING, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));

describe('the reference, through the facet (V38)', () => {
  it('follows the session’s first frame from a model, a tool call as a text, and never the `init`', async () => {
    const h = harness = await claudeHarness();
    const tool = start(h);
    tool.send(h.prompts.t1);
    await tool.ended('turn-1');
    // T1's first reply from a model holds its `Read` call; T3's holds a text. The reference comes at the
    // reply's start, before either (M19, C60): before the read's item and the action it shows (M20a, C18).
    expect(tool.types().slice(0, 5)).toEqual(['turn-started', 'in-force', 'session-started', 'activity-started', 'action-changed']);
    const text = start(h);
    text.send(h.prompts.t3);
    await text.ended('turn-1');
    expect(text.types().slice(0, 4)).toEqual(['turn-started', 'in-force', 'session-started', 'message-delta']);
    for (const s of [tool, text]) expect(s.events.find((event) => event.type === 'session-started')).toMatchObject({ folder: h.project });
    expect(new Set([tool.reference(), text.reference()]).size).toBe(2);
  });

  it('is not reported for a first turn interrupted before it ran, one that failed with the CLI’s own frame, or one the CLI answered by itself', async () => {
    for (const first of ['early', 't5', 'command'] as const) {
      const h = harness = await claudeHarness();
      const s = start(h);
      s.send(h.prompts[first], 1);
      if (first === 'early') {
        await until(() => Object.values(h.sessions()).some((entry) => entry.turns.length === 1), 'the prompt reaching the fake');
        s.session.stop();
      }
      await s.ended('turn-1');
      expect(s.reference(), first).toBeUndefined();
      // The fake, as Claude does, keeps such a session: fat-g holds no link to it (K24).
      expect(h.only().entry.kept).toBe(true);

      // The same process's next turn reports it, at its first frame from a model.
      s.send(h.prompts.t1, 2);
      expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed' });
      expect(s.reference()).toBe(h.only().id);
      const order = s.events.map((event) => event.type);
      expect(order.indexOf('session-started')).toBeGreaterThan(order.lastIndexOf('turn-started'));
      expect(h.only().entry.launches).toHaveLength(1);
      await h.dispose();
      harness = undefined;
    }
  });
});

describe('the reference, through the runtime and the stores (V38; C44, C87)', () => {
  const dataDir = (h: Harness): string => path.join(h.dir, 'records');
  const place = (h: Harness): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet' })]);
  const idle = (app: ReturnType<typeof launchApp>) => until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 20_000);

  it('is in the record and in the conversation store once a model has answered, with the folder it started in', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    try {
      expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
      await idle(app);
      await app.service.settled();
      const { id } = h.only();
      expect(storedSession(dataDir(h), 1)).toMatchObject({ reference: id, folder: h.project });
      expect(app.conversations.conversation(S(1))).toMatchObject({ reference: id, folder: h.project });
    } finally { await app.quit(); }
  });

  it('is missing after a first turn no model answered: the record has none, and the next prompt in the same process brings it', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    try {
      // A prompt that names a command: the CLI answers it by itself (C69).
      expect(await app.runtime.send(S(1), h.prompts.command)).toEqual({ status: 'accepted' });
      await idle(app);
      await app.service.settled();
      expect(storedSession(dataDir(h), 1)).toMatchObject({ reference: null, folder: null });
      expect(app.conversations.conversation(S(1))).toMatchObject({ reference: null });
      // The turn itself completed, and reads so: the CLI's own answer, settled as the answer.
      expect(app.read(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
      expect(app.read(1).items.at(-1)).toMatchObject({ role: 'assistant', phase: 'final' });

      expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
      await idle(app);
      await app.service.settled();
      const { id, entry } = h.only();
      expect(entry.launches).toHaveLength(1);
      expect(storedSession(dataDir(h), 1)).toMatchObject({ reference: id, folder: h.project });
      expect(app.conversations.conversation(S(1))).toMatchObject({ reference: id });
    } finally { await app.quit(); }
  });

  it('starts a new conversation, with no `--resume`, for a prompt written after such a session’s process has ended', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const first = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    expect(await first.runtime.send(S(1), h.prompts.t5)).toEqual({ status: 'accepted' });
    await idle(first);
    await first.service.settled();
    expect(storedSession(dataDir(h), 1)).toMatchObject({ reference: null });
    const [unlinked] = Object.keys(h.sessions());
    // The app quits: the session's process is ended with it.
    await first.quit();
    await h.provider.dispose();
    await until(() => h.running('chat').length === 0, 'the first process ending', 15_000);

    const adapter = await h.adapter();
    const second = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => adapter.facet });
    try {
      // The saved chat still shows the prompt that got no answer.
      expect(second.read(1).items[0]).toMatchObject({ role: 'user' });
      expect(await second.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
      await idle(second);
      await second.service.settled();
      const sessions = h.sessions();
      expect(Object.keys(sessions)).toHaveLength(2);
      const fresh = Object.entries(sessions).find(([id]) => id !== unlinked);
      // A launch of its own, naming no session: Claude's first conversation stays in the user's history, unlinked (C87).
      expect(fresh?.[1].launches).toMatchObject([{ resume: null }]);
      expect(fresh?.[1].launches[0]?.args).not.toContain('--resume');
      expect(storedSession(dataDir(h), 1)).toMatchObject({ reference: fresh?.[0] });
      expect(sessions[unlinked as string]?.launches).toHaveLength(1);
    } finally { await second.quit(); }
  });

  it('keeps the reference when the turn it came in was then cut by its process’s end, and resumes by it (C90)', async () => {
    const h = harness = await claudeHarness();
    place(h);
    h.control({ exitDuringTurn: 1 });
    const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    try {
      expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
      await idle(app);
      await app.service.settled();
      const { id } = h.only();
      expect(storedSession(dataDir(h), 1)).toMatchObject({ reference: id });
      // The cut turn is the session's own end: it reads unfinished, and nothing will settle it (C76).
      expect(app.read(1).turns[0]).toMatchObject({ state: 'unfinished' });
      expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
      await idle(app);
      expect(h.only().entry.launches.map((launch) => launch.resume)).toEqual([null, id]);
      await processGone(h, { closed: Promise.resolve() }, 1);
    } finally { await app.quit(); }
  });
});
