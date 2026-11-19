// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16, V28, V30 (docs/planning/_archive/M16.md; C43, C46, C48–C50, C75, C76): Claude, on the real adapter and
// process layer against the replay fake, passes the conversation store's contract — the same set
// Codex and the example provider pass (tests/sessions/store-contract.ts). And what Claude alone
// shows: a chat with no history to read back, reopened with no process started; what its turns read
// as after a restart, each by whose end it had; and what the store takes of its frames.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { STORE_FILE, storeFiles } from '../../../src/main/conversations/format';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession, until } from '../../sessions/app';
import { describeStoreContract } from '../../sessions/store-contract';
import { claudeHarness, type Harness } from './harness';

describeStoreContract('Claude, against the replay fake', async () => {
  const h = await claudeHarness();
  let adapter: AgentProvider | undefined;
  return {
    descriptor: h.provider.descriptor,
    dir: path.join(h.dir, 'records'),
    folder: h.project,
    model: 'sonnet',
    effort: 'low',
    prompt: h.prompts.t1,
    // An adapter of its own for each run, ended with it as the app's quit ends it: the next run's
    // sessions start in new processes.
    async facet() {
      await adapter?.dispose();
      const made = await h.adapter();
      adapter = made.provider;
      return made.facet;
    },
    dispose: () => h.dispose(),
  };
});

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
});

const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness, overrides: Record<string, unknown> = {}): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet', ...overrides })]);
const idle = (app: App) => until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 20_000);
function launch(h: Harness, facet: SessionFacet = h.facet): App {
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => facet });
  apps.push(app);
  return app;
}
async function turn(app: App, prompt: string): Promise<void> {
  expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  await idle(app);
  await app.service.settled();
}
/** Ends a run as the app's quit does, with its adapter, and answers the next run's facet. */
async function restart(h: Harness, app: App, provider: AgentProvider = h.provider): Promise<SessionFacet> {
  apps = apps.filter((candidate) => candidate !== app);
  await app.quit();
  await provider.dispose();
  await until(() => h.running('chat').length === 0, 'the session’s process ending', 15_000);
  return (await h.adapter()).facet;
}

describe('a Claude chat with no history to read back (V16; C48–C50)', () => {
  it('reopens what fat-g recorded with no process started, asks the facet nothing, and says its history is unsupported', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const first = launch(h);
    await turn(first, h.prompts.t3);
    const recorded = first.read(1).items;
    // Its messages, and the worker it started between them (M20a, C21).
    expect(recorded.map((item) => (item.kind === 'activity' ? [item.activity?.type, item.activity?.status] : [item.role, item.phase]))).toEqual([['user', null], ['assistant', 'commentary'], ['worker', 'completed'], ['assistant', 'final']]);
    const launches = h.only().entry.launches.length;
    const facet = await restart(h, first);

    // The next run: selected, read, checked. Nothing is asked of Claude, and nothing is launched.
    const asked: string[] = [];
    const watching: SessionFacet = { start(options) { asked.push('start'); return facet.start(options); }, resume(options) { asked.push('resume'); return facet.resume(options); } };
    const second = launch(h, watching);
    await second.select(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(second.read(1).items).toEqual(recorded);
    expect(second.read(1).history).toEqual({ state: 'unsupported', olderUnread: false, earlierMissing: false });
    expect(second.runtime.loadHistory(S(1))).toEqual({ status: 'refused', reason: 'unsupported' });
    expect(asked).toEqual([]);
    expect(h.running('chat')).toEqual([]);
    expect(h.only().entry.launches).toHaveLength(launches);
    // The facet has no history member to ask.
    expect('history' in facet).toBe(false);
  });

  it('resumes at the next prompt of a later run, and adds no message twice: the resumed process sends nothing of the earlier conversation', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const first = launch(h);
    await turn(first, h.prompts.t1);
    const before = first.read(1).items;
    const facet = await restart(h, first);
    const second = launch(h, facet);
    await turn(second, h.prompts.t3);
    const after = second.read(1).items;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).filter((item) => item.kind === 'message').map((item) => [item.role, item.phase])).toEqual([['user', null], ['assistant', 'commentary'], ['assistant', 'final']]);
    expect(new Set(after.map((item) => item.id)).size).toBe(after.length);
    expect(h.only().entry.launches.map((entry) => entry.resume)).toEqual([null, h.only().id]);
  });

  it('says, as plain fact, that earlier messages are not saved where the store lacks the conversation’s start, and shows every recorded message', async () => {
    const h = harness = await claudeHarness();
    // A session that had started before this store existed: after a Start fresh of the conversation store, say.
    place(h, { reference: '22222222-2222-4222-8222-222222222222', folder: h.project, lastTurn: { turnId: 'earlier-turn', startedAt: 5, endedAt: 9, outcome: 'completed' } });
    const app = launch(h);
    await app.select(1);
    expect(app.read(1)).toMatchObject({ items: [], history: { state: 'unsupported', earlierMissing: true } });
    expect(CHAT_LINES.earlierMissing).toBe('Earlier messages of this conversation are not saved in fat-g.');
    // It is still resumed: the next prompt goes to Claude, and what follows is recorded and shown.
    h.control({ resumeMissing: 0 });
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
    await idle(app);
    // The fake holds no such session: the resume is refused with the sign, and the saved chat shows the prompt and the offer.
    expect(app.read(1).items.map((item) => item.role ?? item.notice)).toEqual(['user', 'session-not-reopened']);
    expect(app.read(1).history.earlierMissing).toBe(true);
  });

  it('opens no file of Claude’s and starts no process to read one: the module imports no file system, and names no transcript', () => {
    const folder = path.resolve('src/main/providers/claude');
    for (const file of ['chat-wire.ts', 'chat-launch.ts', 'chat-frames.ts', 'chat-mapper.ts', 'chat-session.ts', 'facet.ts']) {
      const text = readFileSync(path.join(folder, file), 'utf8');
      expect(text, file).not.toMatch(/from\s+'(node:)?(fs|fs\/promises|path|os)'/);
      expect(text, file).not.toMatch(/\.jsonl|projects[\\/]|transcript_path|sessions[\\/]/);
    }
  });
});

describe('what a Claude turn reads as after a restart, by whose end it had (V30; C75, C76)', () => {
  it('ended, for a turn the CLI ended; unfinished, for one lost with its process; not confirmed, for one that ended before Claude took its prompt', async () => {
    const h = harness = await claudeHarness({ timings: { startedMs: 400 } });
    place(h);
    const first = launch(h);
    // 1: completed by the CLI's own `result`.
    await turn(first, h.prompts.t1);
    // 2: the process ends during the turn: the session's own end.
    h.control({ exitDuringTurn: 1 });
    await turn(first, h.prompts.t1);
    // 3: Claude never says it took the prompt: a failed start, after the prompt was written.
    h.control({ hang: 'started' });
    await turn(first, h.prompts.t1);
    h.control({});
    const live = first.read(1).turns.map((entry) => [entry.state, entry.outcome]);
    expect(live).toEqual([['ended', 'completed'], ['unfinished', 'failed'], ['unacknowledged', 'failed']]);
    const facet = await restart(h, first);

    const second = launch(h, facet);
    expect(second.read(1).turns.map((entry) => [entry.state, entry.outcome])).toEqual(live);
    // Nothing settles the two later: Claude has no history to read (C49, C76), and the chat says what is known.
    await second.select(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.read(1).turns.map((entry) => entry.state)).toEqual(['ended', 'unfinished', 'unacknowledged']);
    expect(CHAT_LINES.unacknowledged('Claude')).toBe('Claude did not confirm that it received this message.');
    expect(storedSession(dataDir(h), 1)?.['lastTurn']).toMatchObject({ outcome: 'failed' });
  });

  it('keeps a failed turn’s notice with the CLI’s own words, and an interrupted turn as the CLI’s own end', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const first = launch(h);
    await turn(first, h.prompts.t5);
    expect(await first.runtime.send(S(1), h.prompts.t4)).toEqual({ status: 'accepted' });
    await until(() => {
      const chat = first.read(1);
      const current = chat.turns.at(-1);
      return chat.items.some((item) => item.turnId === current?.id && item.activity?.type === 'read');
    }, 'T4 reaching its first tool call', 15_000);
    expect(first.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await idle(first);
    await first.service.settled();
    const facet = await restart(h, first);
    const second = launch(h, facet);
    const read = second.read(1);
    expect(read.turns.map((entry) => [entry.state, entry.outcome])).toEqual([['ended', 'failed'], ['ended', 'interrupted']]);
    const notice = read.items.find((item) => item.notice === 'turn-failed');
    expect(notice?.detail).toContain('There\'s an issue with the selected model');
    expect(notice?.blocks[0]?.text).toBe('Claude reported an error, and the reply ended.');
    // No message of the failed turn. Of the interrupted one, the text that was being written when the
    // Stop reached it, as it was received: unfinished, the frame the CLI sent with it not completing it
    // (M19, C80), and with no phase, being neither a note nor the answer (C79). The interrupt's marker is no message.
    expect(read.items.filter((item) => item.role === 'assistant').map((item) => [item.phase, item.state, item.blocks[0]?.text, item.turnId === read.turns[1]?.id])).toEqual([[null, 'partial', 'Summ', true]]);
  });
});

describe('what the store takes of Claude’s frames (V16; C43; M20a, C30)', () => {
  it('keeps the messages, the turn, what the session did and its worker’s work under the worker’s id, and no account field or frame', async () => {
    const h = harness = await claudeHarness();
    place(h);
    const app = launch(h);
    // T3's turn runs a worker, whose frames hold a prompt, a file's text and a path.
    await turn(app, h.prompts.t3);
    const stored = (): string => storeFiles().filter((file) => existsSync(path.join(dataDir(h), file))).map((file) => readFileSync(path.join(dataDir(h), file), 'latin1')).join('\n');
    const text = stored();
    expect(text).toContain(h.prompts.t3.slice(0, 40));
    expect(text).toContain('I\'ll have an agent read the file and report back.');
    // What it did is conversation content now (M20a, C30): what the worker was asked, as the input of
    // the session's item that started it, and what the worker read, under the worker's id.
    for (const kept of ['located in the working directory', 'Note three: the logbook is kept in the blue drawer.']) expect(text, kept).toContain(kept);
    const [launched] = app.read(1).items.filter((item) => item.kind === 'activity');
    expect(launched).toMatchObject({ workerId: null, activity: { type: 'worker', status: 'completed', input: expect.stringContaining('located in the working directory') as string } });
    // The session's own read holds none of the worker's items (C22): they are read by its id.
    expect(app.read(1).items.every((item) => item.workerId === null)).toBe(true);
    const workerId = app.pushes.flatMap((push) => ('workerId' in push && typeof push.workerId === 'string' ? [push.workerId] : []))[0] ?? '';
    const theirs = app.runtime.readWorker(S(1), workerId);
    expect(theirs).toMatchObject({ status: 'read', workerId, worker: { id: launched?.id } });
    expect(theirs.status === 'read' && theirs.items.length > 0 && theirs.items.every((item) => item.workerId === workerId)).toBe(true);
    // Nor anything of a reply as it is written but its text: no stream event, no tool input in pieces (M19, C10).
    for (const absent of ['stream_event', 'content_block', 'partial_json', 'input_json_delta', 'text_delta']) expect(text, absent).not.toContain(absent);
    // And no frame's own field: no block type, no task frame, no account or cost.
    for (const absent of ['tool_use', 'tool_result', 'task_started', 'parent_tool_use_id', 'mcp__', 'apiKeySource', 'permissionMode', 'command_lifecycle', 'cache_creation_input_tokens', 'total_cost_usd']) expect(text, absent).not.toContain(absent);
    // The reference and the folder it started in are kept, as the record keeps them (M18, C28); no time of Claude's is (C43).
    expect(app.conversations.conversation(S(1))).toMatchObject({ reference: h.only().id, folder: h.project });
    for (const item of app.read(1).items) expect(item.time.providerAt).toBeNull();
    expect(app.read(1).turns[0]?.time).toMatchObject({ providerStartedAt: null, providerEndedAt: null, providerDurationMs: null });
  });

  it('starts no process and writes no frame while the conversation store is refused, or a prompt’s record fails (V28; C46)', async () => {
    const h = harness = await claudeHarness();
    place(h);
    writeFileSync(path.join(dataDir(h), STORE_FILE), Buffer.alloc(8192, 3));
    const refused = launch(h);
    expect(await refused.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'refused', reason: 'conversations-refused' });
    expect(h.pids('chat')).toEqual([]);
    expect(h.sessions()).toEqual({});
    expect(refused.read(1)).toMatchObject({ items: [], storage: 'refused' });
  });
});
