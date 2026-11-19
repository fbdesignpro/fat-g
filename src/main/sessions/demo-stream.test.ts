// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V17, V29 (docs/planning/_archive/M19.md; C52, C63, C69): the demo source's stream form, in its parts — the
// fixture read from its file, its sessions' streams as agent events, the data folder as every run
// finds it, and the fixture's turns in a real conversation store. The form as a whole is started by
// do-run-stream.bat; no test starts Electron.
//
// V11 (docs/planning/_archive/M20a.md; C44): and its two streams of a turn's work, `tools` and `worker`, with
// the fixture's activity in the conversation the store is filled with.
//
// V17 (docs/planning/_archive/M20b.md; C30): and a question beside the session — an aside's answer written a
// piece at a time, or arriving whole after a wait — with the two hundred asides the session keeps
// from its start.
//
// V12 (docs/planning/_archive/M21.md; C52): and the prompt `question`, a turn that asks — a blocking question
// answered from its card, then one asked in a message — so both cards are seen without a CLI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { drawnDigest } from '@shared/contracts/aside';
import { ApprovalRequestSchema, outcomeWords, questionOf } from '@shared/contracts/interaction';
import { readFindings, reviewPrompt, sendNotesPrompt } from '@shared/contracts/review';
import type { ProviderContext } from '@shared/provider-kit/context';
import { type ContextReading, ContextReadingSchema } from '@shared/contracts/sessions';
import type { ProviderSession } from '@shared/provider-kit/sessions';
import { launchApp, placeRecords, S, sessionEntry, until } from '../../../tests/sessions/app';
import { foldDeltas, workFaults } from '../../../tests/sessions/facet-contract';
import { prepareStreamData, prepareStreamForm } from '../app/demo-stream-data';
import { STREAM_DATA_FOLDER } from '../app/identity';
import { parseDefaults } from '../catalog/defaults';
import { entriesOf, PAGE_ENTRIES } from '@shared/contracts/conversation';
import { createConversationStore } from '../conversations/store';
import { RECORDS_FILE } from '../records/format';
import { createRecordsStore } from '../records/store';
import { PLAN_WORDS } from '@shared/contracts/plans';
import { CONTEXT_WORD, PLAN_LONG_WORD, PLAN_MESSAGES, reviewAnswer, STREAM_CONTEXT, STREAM_FINDINGS, STREAM_FINDINGS_MOVED, STREAM_PLAN, STREAM_PLAN_LONG, STREAM_PLAN_REVISED, STREAM_PLANS } from './demo-stream';
import { APPROVAL_MESSAGES, APPROVAL_VARIANTS, approvalVariant, createStreamForm, STREAM_CHATS, fillConversation, FORM_MESSAGE, loadFixture, QUESTION_ASKED, QUESTION_MESSAGE, QUESTION_WORKER, QUESTION_WORKER_ANSWER, questionVariant, seedAsides, SEEDED_ASIDES, seedPlace, SETUP_FAILURE, SETUP_WAIT_MS, STREAM_ASK_FIRST, STREAM_COMMAND, STREAM_FILE, STREAM_FORM, STREAM_GRANTED, STREAM_PERMISSIONS, STREAM_PROBE, STREAM_PROJECT, STREAM_PROVIDER, STREAM_QUESTION, STREAM_READ_ONLY, STREAM_SESSION, STREAM_STEP_MS, STREAM_STEP_UNITS, streamDefinition, streamFacet, type StreamFixture, streamReport, WHOLE_WAIT_MS, WITHDRAW_WAIT_MS, WITHDRAWN_MESSAGE, WORK_ANSWER, WORK_ANSWER_ASKED, WORK_WORKER } from './demo-stream';

const FIXTURE_FILE = path.resolve('tests/fixtures/conversations/long-conversation.mjs');
const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };
let fixture: StreamFixture;
let root: string;

beforeEach(async () => {
  fixture = await loadFixture(FIXTURE_FILE);
  root = mkdtempSync(path.join(tmpdir(), 'fatg-stream-test-'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

/** A clock in the test's hands. */
function manualTimers() {
  let now = 0;
  let made = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    set: (run: () => void, ms: number): unknown => { made += 1; pending.set(made, { at: now + ms, run }); return made; },
    clear: (handle: unknown): void => { pending.delete(handle as number); },
    /** Runs every timer due, in order, until none is. */
    runAll(): void {
      for (let guard = 0; pending.size > 0 && guard < 100_000; guard += 1) {
        const [id, next] = [...pending].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] as [number, { at: number; run: () => void }];
        pending.delete(id);
        now = next.at;
        next.run();
      }
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
    now: () => now,
  };
}
/** A session's events, its context readings left out (decision 0033): `readings` reads those. */
const collect = (session: ProviderSession): AgentEvent[] => { const events: AgentEvent[] = []; session.subscribe((event) => { if (event.type !== 'context') events.push(event); }); return events; };
const readings = (session: ProviderSession): ContextReading[] => { const said: ContextReading[] = []; session.subscribe((event) => { if (event.type === 'context') said.push(event.reading); }); return said; };
const START = { folder: '/scratch/project', model: 'fixture', effort: null, speed: null, otherFolders: [], mode: null, processKey: 'process-1' } as const;
const request = (n: number, prompt: string) => ({ turnId: `turn-${n}`, prompt, effort: null, speed: null, messageId: `message-${n}` });

describe('M105 synthetic state scenarios', () => {
  it.each(['states', 'states held', 'states lost'])('plays %s through the third provider and cancels its pending steps on Stop', (prompt) => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, prompt));
    timers.runAll();
    expect(events.every((event) => AgentEventSchema.safeParse(event).success)).toBe(true);
    expect(events.filter((event) => event.type === 'action-changed').map((event) => event.kind)).toContain('thinking');
    expect(events.filter((event) => event.type === 'worker-started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'worker-ended')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
    if (prompt === 'states') expect(events).toContainEqual({ type: 'action-changed', turnId: 'turn-1', kind: 'waiting', wait: { reason: 'provider' } });
    session.send(request(2, prompt));
    timers.advance(9000);
    session.stop();
    expect(events.filter((event) => event.type === 'worker-ended')).toHaveLength(4);
    const stopped = events.length;
    timers.runAll();
    expect(events).toHaveLength(stopped);
  });
});

describe('the fixture, read from its file (C52, C69)', () => {
  it('is the long-conversation fixture: 2,000 turns and three streams', () => {
    expect(fixture.TURNS).toBe(2_000);
    expect([...fixture.STREAMS]).toEqual(['mixed', 'fence', 'table']);
    expect(fixture.streamText('mixed')).toHaveLength(20_000);
    expect(fixture.streamText('fence')).toHaveLength(MAX_MESSAGE_TEXT);
    expect(fixture.streamText('table')).toHaveLength(MAX_MESSAGE_TEXT);
  });

  it('refuses a file that is not it', async () => {
    const other = path.join(root, 'other.mjs');
    writeFileSync(other, 'export const TURNS = 3;\n');
    await expect(loadFixture(other)).rejects.toThrow('not the long-conversation fixture');
    await expect(loadFixture(path.join(root, 'missing.mjs'))).rejects.toThrow();
  });
});

describe('a stream, as the form’s sessions tell it (C63)', () => {
  it('plays a stream as a message that is written: opened, grown a piece at a time at its pace, and completed by its whole message', () => {
    const timers = manualTimers();
    const ended: string[] = [];
    const session = streamFacet({ fixture, timers, onTurnStart: (kind) => { ended.push(`${kind}:taken`); }, onTurnEnd: (kind, outcome) => { ended.push(`${kind}:${outcome}`); } }).start(START);
    const events = collect(session);
    session.send(request(1, 'mixed'));
    // Told of the prompt before anything of its stream is said: the page's counts start again there.
    expect(ended).toEqual(['mixed:taken']);
    expect(events).toEqual([]);
    timers.advance(0);
    expect(events.map((event) => event.type)).toEqual(['turn-started', 'session-started', 'message', 'action-changed', 'message-delta']);
    expect(events.at(-1)).toMatchObject({ type: 'message-delta', text: '', phase: 'final' });
    // 5,000 units a second: 125 every 25 ms.
    timers.advance(1_000);
    const written = events.flatMap((event) => (event.type === 'message-delta' ? [event.text] : [])).join('');
    expect(written).toHaveLength((1_000 / STREAM_STEP_MS) * STREAM_STEP_UNITS);
    expect(fixture.streamText('mixed').startsWith(written)).toBe(true);
    timers.runAll();
    const folded = foldDeltas(events);
    expect(folded.faults).toEqual([]);
    expect(folded.open).toEqual([]);
    const whole = folded.events.find((event) => event.type === 'message' && event.role === 'assistant');
    expect(whole).toMatchObject({ phase: 'final', text: fixture.streamText('mixed') });
    expect(folded.streamed.get(whole?.type === 'message' ? whole.itemId : '')).toBe(fixture.streamText('mixed'));
    expect(events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true });
    expect(ended).toEqual(['mixed:taken', 'mixed:completed']);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('plays the stream a prompt names, and the next in the fixture’s order for any other prompt', () => {
    const timers = manualTimers();
    const ended: string[] = [];
    const facet = streamFacet({ fixture, timers, stepUnits: 50_000, onTurnEnd: (kind) => { ended.push(kind); } });
    const session = facet.start(START);
    for (const [n, prompt] of [[1, 'What is this?'], [2, 'another'], [3, '  TABLE  '], [4, 'fence'], [5, 'next, please']] as const) {
      session.send(request(n, prompt));
      timers.runAll();
    }
    // By its number among the turns, unless named: the first is mixed, the second fence; the fifth is the fifth.
    expect(ended).toEqual(['mixed', 'fence', 'table', 'fence', 'fence']);
  });

  it('leaves a stream’s message open when it is stopped, and tells no more of it', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'table'));
    timers.advance(200);
    session.stop();
    const count = events.length;
    timers.runAll();
    expect(events).toHaveLength(count);
    expect(events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    const folded = foldDeltas(events);
    expect(folded.open).toHaveLength(1);
    expect(folded.events.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(false);
    // And takes the next prompt.
    session.send(request(2, 'mixed'));
    timers.runAll();
    expect(events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true });
  });

  it('gives its reference once, and none to a session that resumes; a close ends a running turn as the session’s own', async () => {
    const timers = manualTimers();
    const facet = streamFacet({ fixture, timers, stepUnits: 50_000 });
    const first = facet.start(START);
    const events = collect(first);
    first.send(request(1, 'mixed'));
    timers.runAll();
    first.send(request(2, 'mixed'));
    timers.runAll();
    expect(events.filter((event) => event.type === 'session-started')).toEqual([{ type: 'session-started', reference: 'fixture-stream', folder: START.folder }]);
    const again = facet.resume({ ...START, reference: 'fixture-stream' });
    const later = collect(again);
    again.send(request(3, 'mixed'));
    timers.advance(0);
    expect(later.some((event) => event.type === 'session-started')).toBe(false);
    await expect(again.close()).resolves.toEqual({ ok: true });
    expect(later.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-3', outcome: 'interrupted', reported: false });
    // No id repeats after the resume.
    const ids = [...events, ...later].flatMap((event) => (event.type === 'turn-started' ? [event.providerTurnId] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// Decision 0033: the form's context, as a Claude session's is said.
describe('how full the context is, as the form’s sessions tell it (decision 0033)', () => {
  it('says the conversation’s reading at a process’s first turn and after each turn, a little fuller each time; `context` brings it near the line; a resumed session goes on from it', () => {
    const timers = manualTimers();
    const facet = streamFacet({ fixture, timers, stepUnits: 50_000 });
    const first = facet.start(START);
    const said = readings(first);
    first.send(request(1, 'mixed'));
    expect(said.map((reading) => reading.used)).toEqual([STREAM_CONTEXT.start]);
    timers.runAll();
    first.send(request(2, 'mixed'));
    timers.runAll();
    expect(said.map((reading) => reading.used)).toEqual([STREAM_CONTEXT.start, STREAM_CONTEXT.start + STREAM_CONTEXT.perTurn, STREAM_CONTEXT.start + 2 * STREAM_CONTEXT.perTurn]);
    first.send(request(3, CONTEXT_WORD));
    timers.runAll();
    expect(said.at(-1)).toMatchObject({ used: STREAM_CONTEXT.near, window: STREAM_CONTEXT.window, compactAt: STREAM_CONTEXT.compactAt });
    for (const reading of said) expect(ContextReadingSchema.safeParse(reading).success).toBe(true);
    const again = facet.resume({ ...START, reference: 'fixture-stream' });
    const later = readings(again);
    again.send(request(4, 'mixed'));
    expect(later.map((reading) => reading.used)).toEqual([STREAM_CONTEXT.near]);
  });
});

describe('the form’s provider (C69)', () => {
  it('is found at once with nothing to read but its sessions, and starts no process: it is handed no way to', async () => {
    const definition = streamDefinition(streamFacet({ fixture }));
    expect(definition.descriptor).toMatchObject({ id: STREAM_PROVIDER, capabilities: { sessions: true, history: false, usage: 'none', models: false, account: false, otherFolders: false } });
    expect(definition.executableNames).toEqual([]);
    expect(definition.instances).toBeUndefined();
    // A context with nothing in it: the provider asks it for nothing.
    const provider = definition.factory({} as ProviderContext);
    const signal = new AbortController().signal;
    await expect(provider.detect({ override: null, knownDirs: [] }, signal)).resolves.toEqual({ kind: 'found', installation: { source: 'path', version: null } });
    await expect(provider.getAccount(signal)).resolves.toMatchObject({ kind: 'account' });
    await expect(provider.getUsage(signal)).resolves.toEqual({ kind: 'empty' });
    expect(provider.sessions).toBeDefined();
    // Its look passes the catalog's own check, as a module's catalog-defaults.json must.
    expect(() => parseDefaults(definition)).not.toThrow();
  });
});

describe('the form’s data folder (V29; C69)', () => {
  it('holds one project, on a scratch folder of its own, its session of the form’s provider and two empty chats beside it, as the records store reads them', () => {
    const dir = path.join(root, STREAM_DATA_FOLDER);
    prepareStreamData(dir, 1_578_924_800_000);
    const records = createRecordsStore({ dir, providerIds: [STREAM_PROVIDER], log: QUIET });
    {
      const view = records.getView();
      expect(records.isRefused()).toBe(false);
      expect(view.projects).toHaveLength(1);
      expect(view.projects[0]).toMatchObject({ kind: 'project', id: STREAM_PROJECT, providers: [STREAM_PROVIDER], roots: [{ path: path.join(dir, 'project') }] });
      expect(JSON.parse(readFileSync(path.join(dir, RECORDS_FILE), 'utf8'))).toMatchObject({ projects: [{ id: STREAM_PROJECT }] });
      expect(view.sessions).toHaveLength(3);
      expect(view.sessions[0]).toMatchObject({ id: STREAM_SESSION, projectId: STREAM_PROJECT, providerId: STREAM_PROVIDER, reference: null, lastTurn: null });
      // For a plan its chats share (decision 0029).
      expect(view.sessions.slice(1).map((one) => [one.id, one.name, one.reference])).toEqual(STREAM_CHATS.map((chat) => [chat.id, chat.name, null]));
      expect(existsSync(path.join(dir, 'project'))).toBe(true);
    }
  });

  it('is made anew at each start: the records and the conversation store of the run before are gone, and nothing else in it is touched', () => {
    const dir = path.join(root, STREAM_DATA_FOLDER);
    prepareStreamData(dir);
    writeFileSync(path.join(dir, 'conversations.sqlite'), 'the run before');
    writeFileSync(path.join(dir, 'conversations.sqlite-wal'), 'its log');
    writeFileSync(path.join(dir, RECORDS_FILE), '{"changed":true}');
    writeFileSync(path.join(dir, 'preferences.json'), '{"kept":true}');
    mkdirSync(path.join(dir, 'project', 'left-behind'), { recursive: true });
    prepareStreamData(dir);
    expect(existsSync(path.join(dir, 'conversations.sqlite'))).toBe(false);
    expect(existsSync(path.join(dir, 'conversations.sqlite-wal'))).toBe(false);
    expect(existsSync(path.join(dir, 'project', 'left-behind'))).toBe(false);
    expect((JSON.parse(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')) as { sessions: unknown[] }).sessions[0]).toMatchObject({ id: STREAM_SESSION });
    expect(readFileSync(path.join(dir, 'preferences.json'), 'utf8')).toBe('{"kept":true}');
  });

  it('refuses any folder but its own: neither the development folder nor the packaged app’s is ever written', () => {
    for (const name of ['fat-g', 'fat-g-dev', 'fatg-smoke', 'anything']) {
      const dir = path.join(root, name);
      mkdirSync(dir);
      writeFileSync(path.join(dir, RECORDS_FILE), 'the user’s own');
      expect(() => prepareStreamData(dir)).toThrow('its own data folder alone');
      expect(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')).toBe('the user’s own');
      expect(existsSync(path.join(dir, 'project'))).toBe(false);
    }
  });
});

describe('the form, made ready (C63, C69)', () => {
  it('is its data folder as every run finds it, its fixture read and its one provider: nothing without a fixture named, and nothing in another folder', async () => {
    const dir = path.join(root, STREAM_DATA_FOLDER);
    await expect(prepareStreamForm({ dir, fixtureFile: undefined, log: QUIET })).rejects.toThrow('no fixture was named');
    await expect(prepareStreamForm({ dir, fixtureFile: '', log: QUIET })).rejects.toThrow('no fixture was named');
    // Nothing was written for a form that could not be made.
    expect(existsSync(dir)).toBe(false);
    await expect(prepareStreamForm({ dir: path.join(root, 'fat-g-dev'), fixtureFile: FIXTURE_FILE, log: QUIET })).rejects.toThrow('its own data folder alone');
    expect(existsSync(path.join(root, 'fat-g-dev'))).toBe(false);
    const form = await prepareStreamForm({ dir, fixtureFile: FIXTURE_FILE, log: QUIET });
    expect(form.definition.descriptor.id).toBe(STREAM_PROVIDER);
    expect((JSON.parse(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')) as { sessions: unknown[] }).sessions[0]).toMatchObject({ id: STREAM_SESSION, providerId: STREAM_PROVIDER });
  });

  it('reports the page’s counts before each stream and after it, once the page can be asked, and nothing before', async () => {
    const said: string[] = [];
    const asked: string[] = [];
    const form = createStreamForm({ fixture, log: { info: (line: string) => { said.push(line); }, warn: () => undefined } });
    const session = form.definition.factory({} as ProviderContext).sessions?.start(START);
    // Before the page can be asked, a stream plays and nothing is reported.
    session?.send(request(1, 'mixed'));
    session?.stop();
    // Its own line would follow half a second after its end: the page cannot be asked then either.
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(asked).toEqual([]);
    form.watch((script) => { asked.push(script); return Promise.resolve(script === STREAM_PROBE ? true : `[stream] counted for ${asked.length}`); });
    await Promise.resolve();
    expect(asked).toEqual([STREAM_PROBE]);
    session?.send(request(2, 'table'));
    expect(asked.at(-1)).toBe(streamReport('before the table stream'));
    session?.stop();
    // The stream's own line follows a moment after its end, when the page has drawn it.
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(asked.at(-1)).toBe(streamReport('table stream, interrupted'));
    expect(said.filter((line) => line.startsWith('[stream] counted'))).toHaveLength(2);
    await session?.close();
  });
});

describe('the fixture, in the session’s conversation (C69)', () => {
  it('goes in through the store, a page a transaction, in the fixture’s order, so that the newest window is full', () => {
    const dir = path.join(root, STREAM_DATA_FOLDER);
    mkdirSync(dir);
    const writes: string[] = [];
    const store = createConversationStore({ dir, log: QUIET, synchronous: 'OFF', hook: (point) => { writes.push(point); } });
    try {
      expect(fillConversation(store, fixture, 300)).toBe(300);
      // One transaction a hundred turns, and the two around them: never one a turn.
      expect(writes).toEqual(['ensure', 'merge', 'merge', 'merge', 'reached']);
      const newest = store.newestPage(STREAM_SESSION);
      // A page is bounded by its entries and its size (M20a, C31): a turn is three entries here, its
      // prompt, the group of what it did and its answer, and an entry is kept whole or not at all.
      const entries = entriesOf(newest.items);
      expect(entries.length).toBeLessThanOrEqual(PAGE_ENTRIES);
      expect(entries.length).toBeGreaterThanOrEqual(30);
      expect(newest.older).toBe(true);
      // The newest turn last: its prompt, its twenty activities in the fixture's order, and its answer, each as the fixture has it.
      const last = fixture.turn(300);
      const [prompt, group, answer] = entries.slice(-3);
      expect([prompt, answer].map((entry) => entry?.map((item) => [item.role, item.blocks[0]?.text]))).toEqual([[['user', last.prompt]], [['assistant', last.answer]]]);
      expect(group?.map((item) => [item.kind, item.activity?.type, item.activity?.summary, item.activity?.output, item.activity?.status, item.state])).toEqual(fixture.activities(300).map((activity) => ['activity', activity.type, activity.summary, activity.output, 'completed', 'complete']));
      // One in ten has an output at the bound, kept whole: nothing of it is cut.
      expect(group?.filter((item) => item.activity?.output?.length === 20_000)).toHaveLength(2);
      expect(group?.every((item) => item.activity?.cut === null && item.workerId === null && item.origin === 'provider')).toBe(true);
      expect(group?.find((item) => item.activity?.type === 'read')?.activity?.files).toEqual([{ path: fixture.activities(300)[0]?.file, line: null }]);
      expect(newest.items.at(-1)).toMatchObject({ state: 'complete', phase: 'final', origin: 'provider' });
      const window = store.window(STREAM_SESSION, store.pageBefore(STREAM_SESSION, newest.items[0]?.id ?? '')?.items[0]?.id ?? '', 'newest');
      expect(window?.items.length).toBeGreaterThanOrEqual(200);
      // In order, oldest first: turn 1's prompt is the conversation's first item.
      const first = store.conversation(STREAM_SESSION);
      expect(first).toMatchObject({ reachedStart: true });
      const places = newest.turns.map((turn) => turn.place);
      expect(places).toEqual([...places].sort((a, b) => a - b));
      expect(newest.turns.at(-1)).toMatchObject({ providerTurnId: 'fixture-turn-300', providerOutcome: 'completed', providerDurationMs: 30_000 });
    } finally { store.close(); }
  });
});

describe('the page’s counts (C63)', () => {
  it('are a script main puts in the page in this form alone: it counts long tasks and frames, times the newest page, and reports under a label', () => {
    expect(STREAM_PROBE).toContain("'longtask'");
    expect(STREAM_PROBE).toContain("'long-animation-frame'");
    expect(STREAM_PROBE).toContain('newestPageMs');
    // It reads no text of a conversation, and sends nothing anywhere: counts and times, to the console.
    expect(STREAM_PROBE).not.toMatch(/textContent|innerText|innerHTML|fetch\(|XMLHttpRequest|sendBeacon|window\.fatg/);
    expect(streamReport('table stream, completed')).toBe('window.__fatgStreamReport ? window.__fatgStreamReport("table stream, completed") : null');
  });
});

// ── M20a (V11; C44): a turn's work, and a worker whose answer streams beside it ───────────────
describe('a turn of tools, as the form’s sessions tell it (M20a: V11; C44)', () => {
  const of = <T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] => events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);

  it('reads the fixture’s activity with it, and refuses a fixture that has none', async () => {
    expect([...fixture.ACTIVITY_STREAMS]).toEqual(['tools', 'worker']);
    expect(fixture.activities(1)).toHaveLength(20);
    const earlier = path.join(root, 'earlier.mjs');
    writeFileSync(earlier, 'export const TURNS = 3;\nexport const STREAMS = [];\nexport const turn = () => ({ prompt: "", answer: "" });\nexport const streamText = () => "";\n');
    await expect(loadFixture(earlier)).rejects.toThrow('not the long-conversation fixture as M20a has it');
  });

  it('plays `tools` as twenty activities, each started at one step and ended at the next, then a short answer', () => {
    const timers = manualTimers();
    const ended: string[] = [];
    const session = streamFacet({ fixture, timers, onTurnStart: (kind) => { ended.push(`${kind}:taken`); }, onTurnEnd: (kind, outcome) => { ended.push(`${kind}:${outcome}`); } }).start(START);
    const events = collect(session);
    session.send(request(1, ' Tools '));
    timers.advance(0);
    expect(events.map((event) => event.type)).toEqual(['turn-started', 'session-started', 'message', 'action-changed']);
    // One event a step: a start, then its end.
    timers.advance(STREAM_STEP_MS * 4);
    expect(events.slice(4).map((event) => event.type)).toEqual(['activity-started', 'activity-ended', 'activity-started', 'activity-ended']);
    timers.runAll();
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(workFaults(events)).toEqual([]);
    // The fixture's own twenty, of the turn past its last: the same at every run.
    const done = fixture.activities(fixture.TURNS + 1);
    expect(of(events, 'activity-started').map((event) => [event.itemId, event.activityType, event.name, event.summary, event.input, event.files?.[0]?.path ?? null])).toEqual(done.map((activity) => [`fixture-1-${activity.id}`, activity.type, activity.name, activity.summary, activity.input, activity.file]));
    expect(of(events, 'activity-ended').map((event) => [event.itemId, event.status, event.output, event.exitCode ?? null])).toEqual(done.map((activity) => [`fixture-1-${activity.id}`, 'completed', activity.output, activity.exitCode]));
    // Two of them with an output at the bound, whole: the schema takes them, and nothing is cut.
    expect(of(events, 'activity-ended').filter((event) => event.output?.length === 20_000)).toHaveLength(2);
    expect(events.slice(-2)).toEqual([{ type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-stream-1', phase: 'final', text: WORK_ANSWER }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
    expect(events.some((event) => event.type === 'worker-started' || ('workerId' in event && event.workerId !== undefined))).toBe(false);
    expect(ended).toEqual(['tools:taken', 'tools:completed']);
    // Forty steps of tools at the form's pace: a second.
    expect(timers.now()).toBe(STREAM_STEP_MS * 40);
  });

  it('plays `worker` as the same tools with a worker whose answer is written beside them, under its id, and ends the worker and its item before the turn’s answer', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'worker'));
    timers.advance(0);
    expect(events.slice(4)).toEqual([
      { type: 'worker-started', workerId: 'fixture-worker-1', description: WORK_WORKER },
      { type: 'activity-started', turnId: 'turn-1', itemId: 'fixture-launch-1', activityType: 'worker', name: 'Worker', summary: WORK_WORKER, pairedWorkerId: 'fixture-worker-1' },
      { type: 'message-delta', turnId: 'turn-1', itemId: 'fixture-report-1', phase: null, text: '', workerId: 'fixture-worker-1' },
    ]);
    // A step: a piece of the worker's answer, and one event of the session's own tools.
    timers.advance(STREAM_STEP_MS * 2);
    expect(events.slice(7).map((event) => [event.type, 'workerId' in event ? event.workerId ?? null : null])).toEqual([
      ['message-delta', 'fixture-worker-1'], ['activity-started', null], ['message-delta', 'fixture-worker-1'], ['activity-ended', null],
    ]);
    timers.runAll();
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(workFaults(events)).toEqual([]);
    const folded = foldDeltas(events);
    expect(folded.faults).toEqual([]);
    expect(folded.open).toEqual([]);
    // The worker's answer, whole, is what its deltas wrote, and the session's own tools are all there.
    const report = of(events, 'message').find((event) => event.workerId !== undefined);
    expect(report).toMatchObject({ itemId: 'fixture-report-1', workerId: 'fixture-worker-1', phase: null, text: fixture.workerText() });
    expect(folded.streamed.get('fixture-report-1')).toBe(fixture.workerText());
    expect(of(events, 'activity-started').filter((event) => event.workerId === undefined && event.activityType !== 'worker')).toHaveLength(20);
    // The item that started the worker ends as the worker does, just before its end is said; the turn's answer follows.
    expect(events.slice(-5).map((event) => event.type)).toEqual(['message', 'activity-ended', 'worker-ended', 'message', 'turn-ended']);
    expect(events.at(-4)).toEqual({ type: 'activity-ended', turnId: 'turn-1', itemId: 'fixture-launch-1', status: 'completed' });
    expect(events.at(-3)).toEqual({ type: 'worker-ended', workerId: 'fixture-worker-1', outcome: 'completed' });
    expect(events.at(-2)).toMatchObject({ role: 'assistant', phase: 'final', text: WORK_ANSWER });
    // The worker's 20,000 units at the form's pace outlast the forty steps of tools.
    expect(timers.now()).toBe(STREAM_STEP_MS * Math.ceil(fixture.workerText().length / STREAM_STEP_UNITS));
  });

  it('ends a worker that is still running, and the item that started it, as failed when its turn is stopped', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'worker'));
    timers.advance(STREAM_STEP_MS * 5);
    session.stop();
    const count = events.length;
    timers.runAll();
    expect(events).toHaveLength(count);
    expect(events.slice(-3)).toEqual([
      { type: 'activity-ended', turnId: 'turn-1', itemId: 'fixture-launch-1', status: 'failed' },
      { type: 'worker-ended', workerId: 'fixture-worker-1', outcome: 'failed' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true },
    ]);
    expect(workFaults(events)).toEqual([]);
    // A tool that had started is left open, as a provider leaves one it was stopped in.
    expect(of(events, 'activity-started').filter((event) => event.activityType !== 'worker').length).toBe(of(events, 'activity-ended').filter((event) => event.itemId !== 'fixture-launch-1').length + 1);
    // And the next prompt plays as any: no worker of the last turn is ended again.
    session.send(request(2, 'tools'));
    timers.runAll();
    expect(of(events, 'worker-ended')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true });
  });

  it('plays neither for a prompt that does not name it: the three answers keep their order', () => {
    const timers = manualTimers();
    const ended: string[] = [];
    const session = streamFacet({ fixture, timers, stepUnits: 50_000, onTurnEnd: (kind) => { ended.push(kind); } }).start(START);
    for (const [n, prompt] of [[1, 'run the tools'], [2, 'tools'], [3, 'a worker, please'], [4, 'worker']] as const) {
      session.send(request(n, prompt));
      timers.runAll();
    }
    expect(ended).toEqual(['mixed', 'tools', 'table', 'worker']);
  });

  it('runs through main as a session’s turn does: its group in the chat, the worker’s answer under the worker’s id', async () => {
    const dir = path.join(root, 'data');
    mkdirSync(dir);
    const facet = streamFacet({ fixture, stepMs: 0, stepUnits: 5_000 });
    const { descriptor } = streamDefinition(facet);
    placeRecords(dir, path.join(root, 'project'), descriptor.id, [sessionEntry(1, descriptor.id, { model: 'fixture' })]);
    const app = launchApp({ dir, descriptor, facet: () => facet, log: QUIET });
    try {
      expect(await app.runtime.send(S(1), 'worker')).toEqual({ status: 'accepted' });
      await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 20_000);
      await app.service.settled();
      const shape = app.read(1).items.map((item) => (item.kind === 'activity' ? `${item.activity?.type}:${item.activity?.status}` : `${item.role}:${item.phase}`));
      expect(shape[0]).toBe('user:null');
      expect(shape.at(-1)).toBe('assistant:final');
      expect(shape.slice(1, -1)).toEqual(['worker:completed', ...fixture.activities(fixture.TURNS + 1).map((activity) => `${activity.type}:completed`)]);
      // One group between the prompt and the answer.
      expect(entriesOf(app.read(1).items).map((entry) => entry.length)).toEqual([1, 21, 1]);
      const theirs = app.runtime.readWorker(S(1), 'fixture-worker-1');
      expect(theirs.status === 'read' && theirs.items.map((item) => [item.role, item.state, item.workerId, item.blocks[0]?.text.length])).toEqual([['assistant', 'complete', 'fixture-worker-1', fixture.workerText().length]]);
      expect(app.chat.activityCounts()).toMatchObject({ started: { worker: 1, read: 7, search: 7, command: 6 }, cut: 0 });
    } finally { await app.quit(); }
  }, 60_000);
});

describe('a question beside the session, as the form’s sessions tell it (M20b: V17)', () => {
  const aside = (n: number, text = 'Explain this passage.') => ({ asideId: `aside-${n}`, turnId: `aside-turn-${n}`, text, messageId: `aside-message-${n}`, history: [], throughTurn: null, effort: null, speed: null });
  const ofAside = (events: readonly AgentEvent[], n: number): AgentEvent[] => events.filter((event) => 'asideId' in event && event.asideId === `aside-${n}`);

  it('declares that it answers one, as it is written, from the conversation alone', () => {
    expect(streamDefinition(streamFacet({ fixture })).descriptor.capabilities.asides).toEqual({ followUp: true, streamed: true, tools: 'none' });
  });

  it('writes an aside’s answer a piece at a time under the aside’s own turn, at the pace a stream is written', () => {
    const timers = manualTimers();
    const told: string[] = [];
    const session = streamFacet({ fixture, timers, onTurnStart: (kind) => { told.push(`${kind}:taken`); }, onTurnEnd: (kind, outcome) => { told.push(`${kind}:${outcome}`); } }).start(START);
    const events = collect(session);
    session.ask?.(aside(1));
    expect(told).toEqual(['aside:taken']);
    timers.advance(0);
    expect(events.map((event) => event.type)).toEqual(['turn-started', 'message-delta']);
    timers.advance(1_000);
    expect(events.flatMap((event) => (event.type === 'message-delta' ? [event.text] : [])).join('')).toHaveLength((1_000 / STREAM_STEP_MS) * STREAM_STEP_UNITS);
    timers.runAll();
    // Every event of it names the aside, and its turn; no reference, no echo and no action is told for it.
    expect(ofAside(events, 1)).toEqual(events);
    expect(events.every((event) => !('turnId' in event) || event.turnId === 'aside-turn-1')).toBe(true);
    const folded = foldDeltas(events);
    expect([folded.faults, folded.open]).toEqual([[], []]);
    expect(folded.events.map((event) => event.type)).toEqual(['turn-started', 'message', 'turn-ended']);
    expect(folded.events[1]).toMatchObject({ role: 'assistant', phase: 'final', text: fixture.streamText('mixed') });
    expect(events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'completed', reported: true });
    expect(told).toEqual(['aside:taken', 'aside:completed']);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('answers whole, after a wait, a question that begins with the word: one message, and nothing of it before', () => {
    const timers = manualTimers();
    const told: string[] = [];
    const session = streamFacet({ fixture, timers, onTurnEnd: (kind, outcome) => { told.push(`${kind}:${outcome}`); } }).start(START);
    const events = collect(session);
    session.ask?.(aside(1, '  Whole, please: what is this?'));
    timers.advance(WHOLE_WAIT_MS - 1);
    expect(events.map((event) => event.type)).toEqual(['turn-started']);
    timers.advance(1);
    expect(events.map((event) => event.type)).toEqual(['turn-started', 'message', 'turn-ended']);
    expect(events[1]).toMatchObject({ text: fixture.streamText('mixed'), asideId: 'aside-1', phase: 'final' });
    expect(told).toEqual(['aside-whole:completed']);
  });

  it('plays an aside beside a turn of the session’s, and beside another aside, each under its own name; an aside’s Stop ends that aside alone', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'mixed'));
    session.ask?.(aside(1));
    session.ask?.(aside(2));
    // A second question of an aside whose answer is being written is not taken.
    session.ask?.({ ...aside(1), turnId: 'aside-turn-1b' });
    timers.advance(200);
    session.stopAside?.('aside-2');
    expect(ofAside(events, 2).at(-1)).toEqual({ type: 'turn-ended', turnId: 'aside-turn-2', asideId: 'aside-2', outcome: 'interrupted', reported: true });
    timers.runAll();
    const own = events.filter((event) => !('asideId' in event) || event.asideId === undefined);
    expect(own.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true });
    expect(foldDeltas(own).open).toEqual([]);
    expect(ofAside(events, 1).at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'completed' });
    // The stopped aside's message was left as far as it was written: no whole message completed it.
    expect(ofAside(events, 2).some((event) => event.type === 'message')).toBe(false);
    expect(events.some((event) => 'turnId' in event && event.turnId === 'aside-turn-1b')).toBe(false);
  });

  it('ends an open aside when the session is closed, as the session’s own, before its turn', async () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'mixed'));
    session.ask?.(aside(1));
    timers.advance(100);
    await session.close();
    expect(events.filter((event) => event.type === 'turn-ended')).toEqual([
      { type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'interrupted', reported: false },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false },
    ]);
  });
});

describe('the asides the session keeps from its start (M20b: V17; C30, C75)', () => {
  it('finds where an answer’s opening words are drawn: after a quotation’s, a heading’s or a list item’s mark, and nowhere for a table or a code block', () => {
    expect(seedPlace('The stays the nine blue it rye.')).toEqual({ range: { start: 0, end: 18 }, digest: drawnDigest('The stays the nine'), excerpt: 'The stays the nine' });
    expect(seedPlace('> Rye sells the spare feeds.').excerpt).toBe('Rye sells the spare');
    expect(seedPlace('#### Lamp boils boils green logbook').excerpt).toBe('Lamp boils boils green');
    expect(seedPlace('1. Keeper with under lighthouse.').excerpt).toBe('Keeper with under lighthouse');
    expect(seedPlace('- one item').range).toEqual({ start: 0, end: 8 });
    // Nothing drawn begins as a table's source does: its digest is of no text the page draws, and nothing is painted for it.
    const table = seedPlace('| Name | Count |\n| :--- | ---: |');
    expect(table.range).toEqual({ start: 0, end: 0 });
    expect(table.digest).not.toBe(drawnDigest(''));
    expect(table.excerpt).not.toBe('');
  });

  it('are two hundred, two about each of the newest hundred answers, each a conversation of its own with its question and its answer, ended', () => {
    const dir = path.join(root, STREAM_DATA_FOLDER);
    mkdirSync(dir);
    const store = createConversationStore({ dir, log: QUIET, synchronous: 'OFF' });
    try {
      fillConversation(store, fixture, 300);
      expect(seedAsides(store)).toBe(SEEDED_ASIDES);
      const markers = store.asides(STREAM_SESSION);
      expect(markers).toHaveLength(200);
      // Each about an answer of the session's own conversation, two an answer.
      const answers = new Map<string, number>();
      for (const marker of markers) answers.set(marker.source?.itemId ?? '', (answers.get(marker.source?.itemId ?? '') ?? 0) + 1);
      expect(answers.size).toBe(100);
      expect([...answers.values()].every((count) => count === 2)).toBe(true);
      // The newest hundred: turns 201 to 300 of the three hundred written, which a full window of the page holds.
      const texts = new Map<string, string>();
      for (let page = store.newestPage(STREAM_SESSION), guard = 0; guard < 100; guard += 1) {
        for (const item of page.items) texts.set(item.id, item.blocks[0]?.text ?? '');
        const before = page.older ? store.pageBefore(STREAM_SESSION, page.items[0]?.id ?? '') : null;
        if (before === null) break;
        page = before;
      }
      expect(new Set([...answers.keys()].map((id) => texts.get(id)))).toEqual(new Set(Array.from({ length: 100 }, (_, index) => fixture.turn(201 + index).answer)));
      // A marker carries a place and no text; the aside itself has its passage.
      expect(JSON.stringify(markers)).not.toMatch(/"excerpt"/);
      const first = store.aside(markers[0]?.id ?? '');
      expect(first).toMatchObject({ parentId: STREAM_SESSION });
      expect(first?.source?.excerpt.length).toBeGreaterThan(0);
      // Its conversation: a question and an answer, under one ended turn; none of it in the session's own pages.
      const page = store.newestPage(markers[0]?.id ?? '');
      expect(page.items.map((item) => [item.role, item.state])).toEqual([['user', 'complete'], ['assistant', 'complete']]);
      expect(page.turns).toMatchObject([{ providerOutcome: 'completed', sessionOutcome: 'completed' }]);
      expect(store.newestPage(STREAM_SESSION).items.some((item) => item.conversationId !== STREAM_SESSION)).toBe(false);
      // The session's own conversation is as the fixture filled it.
      expect(store.newestPage(STREAM_SESSION).items.at(-1)?.blocks[0]?.text).toBe(fixture.turn(300).answer);
    } finally { store.close(); }
  }, 60_000);

  it('are listed by the session’s read through main, and one asked there is answered in its own conversation', async () => {
    const dir = path.join(root, 'data');
    mkdirSync(dir);
    const facet = streamFacet({ fixture, stepMs: 0, stepUnits: 5_000 });
    const { descriptor } = streamDefinition(facet);
    placeRecords(dir, path.join(root, 'project'), descriptor.id, [sessionEntry(1, descriptor.id, { model: 'fixture' })]);
    const app = launchApp({ dir, descriptor, facet: () => facet, log: QUIET });
    try {
      // A conversation the provider holds, first: the session's own turn.
      expect(await app.runtime.send(S(1), 'mixed')).toEqual({ status: 'accepted' });
      await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 20_000);
      await app.service.settled();
      expect(app.read(1).asking).toEqual({ followUp: true, streamed: true, tools: 'none' });
      const asideId = 'a51de000-0000-4000-8000-000000000001';
      expect(await app.runtime.ask({ sessionId: S(1), asideId, text: 'What is this about?' })).toEqual({ status: 'accepted', asideId });
      await until(() => { const read = app.runtime.readAside(S(1), asideId); return read.status === 'read' && !read.aside.running && read.items.length === 2; }, 'the aside’s answer', 20_000);
      const read = app.runtime.readAside(S(1), asideId);
      expect(read.status === 'read' && read.items.map((item) => [item.role, item.state, item.blocks[0]?.text.length])).toEqual([['user', 'complete', 'What is this about?'.length], ['assistant', 'complete', fixture.streamText('mixed').length]]);
      expect(app.read(1).asides.map((marker) => marker.id)).toEqual([asideId]);
      // Its partial pushes named the aside, under the session's id.
      expect(app.pushes.filter((push) => push.asideId === asideId).every((push) => push.sessionId === S(1))).toBe(true);
    } finally { await app.quit(); }
  }, 60_000);
});

describe('a turn that asks, as the form’s sessions tell it (M21: V12; C52)', () => {
  it('declares questions of both kinds, and its sessions take an answer', () => {
    const facet = streamFacet({ fixture });
    expect(streamDefinition(facet).descriptor.capabilities.questions).toBe('both');
    expect(typeof facet.start(START).answer).toBe('function');
  });

  it('plays `question` as a request that holds the turn, then, once answered, a confirmation, a message that carries a question, and the turn’s end', () => {
    const timers = manualTimers();
    const ended: string[] = [];
    const session = streamFacet({ fixture, timers, onTurnStart: (kind) => { ended.push(`${kind}:taken`); }, onTurnEnd: (kind, outcome) => { ended.push(`${kind}:${outcome}`); } }).start(START);
    const events = collect(session);
    session.send(request(1, ' Question '));
    timers.runAll();
    expect(events.map((event) => event.type)).toEqual(['turn-started', 'session-started', 'message', 'action-changed', 'question-raised']);
    expect(events.at(-1)).toEqual({ type: 'question-raised', turnId: 'turn-1', requestId: 'fixture-request-1', sourceId: 'fixture-question-1', questions: [STREAM_QUESTION], cut: false });
    // It waits, however long: nothing more is said until the answer comes.
    timers.advance(3_600_000);
    expect(events).toHaveLength(5);
    expect(ended).toEqual(['question:taken']);
    // An answer that names another request changes nothing.
    session.answer?.('another-request', [{ options: [0], text: null }]);
    expect(events).toHaveLength(5);
    session.answer?.('fixture-request-1', [{ options: [1], text: 'and slowly' }]);
    expect(events.slice(5)).toEqual([
      { type: 'question-resolved', requestId: 'fixture-request-1', reason: 'confirmed' },
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-asking-1', phase: 'final', text: QUESTION_MESSAGE, questions: QUESTION_ASKED },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true },
    ]);
    expect(ended).toEqual(['question:taken', 'question:completed']);
    // Answered once: a second answer finds nothing held.
    session.answer?.('fixture-request-1', [{ options: [0], text: null }]);
    expect(events).toHaveLength(8);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('leaves a request held at a Stop to the turn’s end, says it dropped before the end a close makes, and ends the turn with nothing confirmed where main refuses it', async () => {
    const timers = manualTimers();
    const facet = streamFacet({ fixture, timers });
    const stopped = facet.start(START);
    const first = collect(stopped);
    stopped.send(request(1, 'question'));
    timers.runAll();
    stopped.stop();
    expect(first.slice(5)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);

    const closing = facet.start(START);
    const second = collect(closing);
    closing.send(request(2, 'question'));
    timers.runAll();
    await closing.close();
    // The adapter's own order at its process's end (C67): the drop first, then the end it makes.
    expect(second.slice(-2)).toEqual([{ type: 'question-resolved', requestId: 'fixture-request-2', reason: 'dropped' }, { type: 'turn-ended', turnId: 'turn-2', outcome: 'interrupted', reported: false }]);

    const refused = facet.start(START);
    const third = collect(refused);
    refused.send(request(3, 'question'));
    timers.runAll();
    refused.answer?.('fixture-request-3', null);
    expect(third.map((event) => event.type).slice(-2)).toEqual(['message', 'turn-ended']);
    expect(third.some((event) => event.type === 'question-resolved')).toBe(false);
  });

  // V16 (C88): the cards no CLI shows on request, each by a word after the prompt.
  it('reads the prompt and one word after it: the plain turn, a variant’s, and no turn that asks for anything else', () => {
    expect(questionVariant(' Question ')).toBe('one');
    expect(questionVariant('question form')).toBe('form');
    expect(questionVariant('QUESTION  Worker')).toBe('worker');
    expect(questionVariant('question withdrawn')).toBe('withdrawn');
    expect(questionVariant('question lost')).toBe('lost');
    for (const prompt of ['question about the table', 'question other', 'questions', 'a question', '']) expect(questionVariant(prompt), prompt).toBeNull();
  });

  it('plays `question form` as four questions in one request — one to choose, several to choose among, a text alone, a secret — and confirms nothing once answered', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'question form'));
    timers.runAll();
    expect(events.at(-1)).toEqual({ type: 'question-raised', turnId: 'turn-1', requestId: 'fixture-request-1', sourceId: 'fixture-question-1', questions: STREAM_FORM, cut: false });
    expect(STREAM_FORM.map((question) => [question.multiple, question.options.length, question.freeText, question.secret])).toEqual([[false, 3, false, false], [true, 3, false, false], [false, 0, true, false], [false, 0, false, true]]);
    session.answer?.('fixture-request-1', [{ options: [1], text: null }, { options: [0, 2], text: null }, { options: [], text: 'a run' }, { options: [], text: 'a token' }]);
    expect(events.slice(5)).toEqual([
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-form-1', phase: 'final', text: FORM_MESSAGE },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true },
    ]);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('plays `question worker` as a sub-agent that asks: the request names it, and its answer is confirmed before the worker says a line and ends', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'question worker'));
    timers.runAll();
    expect(events.slice(4)).toEqual([
      { type: 'worker-started', workerId: 'fixture-worker-1', description: QUESTION_WORKER },
      { type: 'activity-started', turnId: 'turn-1', itemId: 'fixture-launch-1', activityType: 'worker', name: 'Worker', summary: QUESTION_WORKER, pairedWorkerId: 'fixture-worker-1' },
      { type: 'action-changed', turnId: 'turn-1', kind: 'waiting' },
      { type: 'question-raised', turnId: 'turn-1', workerId: 'fixture-worker-1', requestId: 'fixture-request-1', sourceId: 'fixture-question-1', questions: [STREAM_QUESTION], cut: false },
    ]);
    session.answer?.('fixture-request-1', [{ options: [1], text: null }]);
    expect(events.slice(8)).toEqual([
      { type: 'question-resolved', requestId: 'fixture-request-1', reason: 'confirmed' },
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-report-1', phase: null, text: QUESTION_WORKER_ANSWER, workerId: 'fixture-worker-1' },
      { type: 'activity-ended', turnId: 'turn-1', itemId: 'fixture-launch-1', status: 'completed' },
      { type: 'worker-ended', workerId: 'fixture-worker-1', outcome: 'completed' },
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-stream-1', phase: 'final', text: WORK_ANSWER_ASKED },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true },
    ]);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('plays `question withdrawn` as a request the provider takes back after its wait and goes on from; answered first, it is as the plain turn', () => {
    const timers = manualTimers();
    const facet = streamFacet({ fixture, timers });
    const session = facet.start(START);
    const events = collect(session);
    session.send(request(1, 'question withdrawn'));
    timers.advance(WITHDRAW_WAIT_MS - 1);
    expect(events.at(-1)).toMatchObject({ type: 'question-raised', requestId: 'fixture-request-1', questions: [STREAM_QUESTION] });
    timers.advance(1);
    expect(events.slice(5)).toEqual([
      { type: 'question-resolved', requestId: 'fixture-request-1', reason: 'withdrawn' },
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-went-on-1', phase: 'final', text: WITHDRAWN_MESSAGE },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true },
    ]);
    // Taken back: an answer that comes after finds nothing held.
    session.answer?.('fixture-request-1', [{ options: [0], text: null }]);
    expect(events).toHaveLength(8);

    const answered = facet.start(START);
    const second = collect(answered);
    answered.send(request(2, 'question withdrawn'));
    timers.advance(10);
    answered.answer?.('fixture-request-2', [{ options: [0], text: null }]);
    timers.advance(WITHDRAW_WAIT_MS * 2);
    expect(second.map((event) => event.type).slice(-3)).toEqual(['question-resolved', 'message', 'turn-ended']);
    expect(second.filter((event) => event.type === 'question-resolved')).toEqual([{ type: 'question-resolved', requestId: 'fixture-request-2', reason: 'confirmed' }]);
  });

  it('plays `question lost` as a session whose process is lost with the request held: dropped first, then the end the session makes itself', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, 'question lost'));
    timers.advance(WITHDRAW_WAIT_MS);
    expect(events.slice(5)).toEqual([
      { type: 'question-resolved', requestId: 'fixture-request-1', reason: 'dropped' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false },
    ]);
    // The session takes the next prompt: only that turn was lost.
    session.send(request(2, 'question'));
    timers.advance(10);
    expect(events.at(-1)).toMatchObject({ type: 'question-raised', requestId: 'fixture-request-2' });
  });

  it('shows through main what each settles as: a form answered and never confirmed, a secret kept as the fact alone, a sub-agent’s card in its own read, and a request the model took back', async () => {
    const dir = path.join(root, 'variants');
    mkdirSync(dir);
    const facet = streamFacet({ fixture, stepMs: 0, stepUnits: 50_000, timers: { set: (run, ms) => setTimeout(run, Math.min(ms, 20)), clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); } } });
    const { descriptor } = streamDefinition(facet);
    placeRecords(dir, path.join(root, 'project'), descriptor.id, [sessionEntry(1, descriptor.id, { model: 'fixture' })]);
    const app = launchApp({ dir, descriptor, facet: () => facet, log: QUIET });
    const cards = () => app.read(1).items.filter((item) => item.kind === 'interaction');
    const rest = () => until(() => !app.service.isRunning(S(1)), 'the turn’s end', 20_000);
    try {
      // The form: four answers, the secret's text sent and not kept, and no confirmation.
      expect(await app.runtime.send(S(1), 'question form')).toEqual({ status: 'accepted' });
      await until(() => cards().length === 1, 'the form’s card');
      expect(cards()[0]?.interaction).toMatchObject({ kind: 'question', questions: STREAM_FORM });
      expect(await app.runtime.answer(S(1), cards()[0]?.id ?? '', [{ question: 0, options: [1], text: null }, { question: 1, options: [0, 2], text: null }, { question: 2, options: [], text: 'a run' }, { question: 3, options: [], text: 'NEEDLE-TOKEN' }])).toEqual({ status: 'answered' });
      await rest();
      const form = cards()[0]?.interaction;
      expect(form).toMatchObject({ outcome: 'answered', confirmedAt: null, answers: [{ options: [1], text: null, secret: false }, { options: [0, 2], text: null, secret: false }, { options: [], text: 'a run', secret: false }, { options: [], text: null, secret: true }] });
      expect(form === null || form === undefined ? null : outcomeWords(form, true)).toBe('Answered; the model did not confirm it');
      expect(JSON.stringify(app.read(1))).not.toContain('NEEDLE-TOKEN');

      // The sub-agent's: in the worker's own read, listed as waiting in the session's, and confirmed.
      expect(await app.runtime.send(S(1), 'question worker')).toEqual({ status: 'accepted' });
      await until(() => app.read(1).waiting.length === 1, 'the sub-agent’s question');
      const [waits] = app.read(1).waiting;
      const worker = app.runtime.readWorker(S(1), waits?.workerId ?? '');
      const asked = worker.status === 'read' ? worker.items.find((item) => item.kind === 'interaction') : undefined;
      expect(asked).toMatchObject({ id: waits?.itemId, workerId: waits?.workerId, interaction: { mode: 'blocking', outcome: 'pending' } });
      expect(cards()).toHaveLength(1);
      expect(await app.runtime.answer(S(1), asked?.id ?? '', [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
      await rest();
      const after = app.runtime.readWorker(S(1), waits?.workerId ?? '');
      const settled = after.status === 'read' ? after.items.find((item) => item.kind === 'interaction')?.interaction : undefined;
      expect(settled).toMatchObject({ outcome: 'answered' });
      expect(settled?.confirmedAt).not.toBeNull();
      expect(app.read(1).waiting).toEqual([]);

      // The one taken back: withdrawn by the model, the turn going on to its end.
      expect(await app.runtime.send(S(1), 'question withdrawn')).toEqual({ status: 'accepted' });
      await until(() => cards().length === 2, 'the third card');
      await rest();
      const withdrawn = cards()[1]?.interaction;
      expect(withdrawn).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'request' });
      expect(withdrawn === null || withdrawn === undefined ? null : outcomeWords(withdrawn, false)).toBe('Withdrawn: the model went on without an answer');
      expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });

      // The one whose process is lost: not answered, and never withdrawn.
      expect(await app.runtime.send(S(1), 'question lost')).toEqual({ status: 'accepted' });
      await until(() => cards().length === 3, 'the fourth card');
      await rest();
      const lost = cards()[2]?.interaction;
      expect(lost).toMatchObject({ outcome: 'dropped' });
      expect(lost === null || lost === undefined ? null : outcomeWords(lost, false)).toBe('Not answered: the session’s process ended');
    } finally { await app.quit(); }
  }, 60_000);

  it('shows both cards through main: the first answered from its card and confirmed, the second answered by a prompt in fat-g’s words, which plays a stream', async () => {
    const dir = path.join(root, 'data');
    mkdirSync(dir);
    const facet = streamFacet({ fixture, stepMs: 0, stepUnits: 50_000 });
    const { descriptor } = streamDefinition(facet);
    placeRecords(dir, path.join(root, 'project'), descriptor.id, [sessionEntry(1, descriptor.id, { model: 'fixture' })]);
    const app = launchApp({ dir, descriptor, facet: () => facet, log: QUIET });
    const cards = () => app.read(1).items.filter((item) => item.kind === 'interaction');
    try {
      expect(await app.runtime.send(S(1), 'question')).toEqual({ status: 'accepted' });
      await until(() => cards().length === 1, 'the blocking card');
      expect(cards()[0]?.interaction).toMatchObject({ mode: 'blocking', outcome: 'pending', questions: [STREAM_QUESTION] });
      expect(app.summary(1)).toMatchObject({ status: 'running', attention: { kind: 'question', count: 1 }, action: { kind: 'asking', label: 'Asking a question' } });
      expect(await app.runtime.answer(S(1), cards()[0]?.id ?? '', [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
      await until(() => !app.service.isRunning(S(1)), 'the turn’s end');
      const [first, second] = cards();
      expect(first?.interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [0], text: null, secret: false }] });
      expect(first?.interaction?.confirmedAt).not.toBeNull();
      // The message that asked, then its card: open, and no attention beyond the turn's own end.
      expect(app.read(1).items.map((item) => item.kind)).toEqual(['message', 'interaction', 'message', 'interaction']);
      expect(second?.interaction).toMatchObject({ mode: 'async', outcome: 'open', questions: [{ text: 'How long should the answer be?', options: [{ label: 'A line' }, { label: 'A page' }] }] });
      expect(app.summary(1)?.attention).toMatchObject({ kind: 'ready' });
      expect(await app.runtime.answer(S(1), second?.id ?? '', [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
      await until(() => !app.service.isRunning(S(1)), 'the answering turn’s end', 20_000);
      await app.service.settled();
      expect(app.texts(1)).toContain('user: How long should the answer be?\nA page');
      const answered = questionOf(cards()[1] ?? { interaction: null });
      expect(answered).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }] });
      expect(answered?.confirmedAt).not.toBeNull();
      expect(app.read(1).turns.find((turn) => turn.id === answered?.answeredBy)?.state).toBe('ended');
    } finally { await app.quit(); }
  }, 60_000);
});

// ── A turn that asks leave (docs/planning/_archive/M22.md, Design 11; V12; C35) ─────────────────────────
describe('a turn that asks leave, as the form’s sessions tell it (M22: V12; C35)', () => {
  const ASKING = { ...START, mode: STREAM_ASK_FIRST } as const;
  const asking = (timers: ReturnType<typeof manualTimers>, start: typeof START | typeof ASKING | { readonly folder: string; readonly model: string; readonly effort: null; readonly speed: null; readonly otherFolders: readonly []; readonly mode: string; readonly processKey: string } = ASKING) => {
    const facet = streamFacet({ fixture, timers });
    const session = facet.start(start);
    return { facet, session, events: collect(session) };
  };
  const play = (session: ProviderSession, timers: ReturnType<typeof manualTimers>, n: number, prompt: string): void => { session.send(request(n, prompt)); timers.advance(0); };
  const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

  it('declares two modes, a reading one and one that asks, with a setup of its own, and its sessions take a decision', () => {
    const facet = streamFacet({ fixture });
    const { permissions } = streamDefinition(facet).descriptor.capabilities;
    expect(permissions).toBe(STREAM_PERMISSIONS);
    expect(STREAM_PERMISSIONS.modes.map((mode) => [mode.id, mode.reading, mode.asks])).toEqual([[STREAM_READ_ONLY, true, false], [STREAM_ASK_FIRST, false, true]]);
    expect(STREAM_PERMISSIONS).toMatchObject({ fallback: STREAM_ASK_FIRST, setup: { changes: expect.any(String) as string, approval: expect.any(String) as string, waiting: expect.any(String) as string } });
    expect(facet.modes?.().map((mode) => [mode.id, mode.available])).toEqual([[STREAM_READ_ONLY, true], [STREAM_ASK_FIRST, true]]);
    expect(facet.transition?.(STREAM_ASK_FIRST, STREAM_READ_ONLY)).toBe('restart');
    expect(typeof facet.start(ASKING).decide).toBe('function');
    expect(APPROVAL_VARIANTS.map((word) => approvalVariant(`approval ${word}`))).toEqual([...APPROVAL_VARIANTS]);
    expect([approvalVariant(' Approval '), approvalVariant('approval twice over'), approvalVariant('approve'), approvalVariant('approval nothing')]).toEqual(['command', null, null, null]);
  });

  it('plays `approval` as a request that holds the turn, under the mode its process confirmed, then, once approved, the action and the turn’s end', async () => {
    const timers = manualTimers();
    const ended: string[] = [];
    const session = streamFacet({ fixture, timers, onTurnStart: (kind) => { ended.push(`${kind}:taken`); }, onTurnEnd: (kind, outcome) => { ended.push(`${kind}:${outcome}`); } }).start(ASKING);
    const events = collect(session);
    play(session, timers, 1, 'approval');
    expect(types(events)).toEqual(['in-force', 'turn-started', 'session-started', 'message', 'action-changed', 'approval-raised']);
    expect(events[0]).toEqual({ type: 'in-force', turnId: 'turn-1', mode: STREAM_ASK_FIRST });
    expect(events.at(-1)).toEqual({ type: 'approval-raised', turnId: 'turn-1', requestId: 's:fixture-approval-1', sourceId: 'fixture-action-1', request: STREAM_COMMAND });
    // It waits, however long, and a decision that names another request changes nothing.
    timers.advance(3_600_000);
    expect(await session.decide?.('s:another', 'approve')).toBe(false);
    expect(events).toHaveLength(6);
    expect(await session.decide?.('s:fixture-approval-1', 'approve')).toBe(true);
    expect(events.slice(6)).toEqual([
      { type: 'approval-resolved', requestId: 's:fixture-approval-1', reason: 'confirmed' },
      { type: 'activity-started', turnId: 'turn-1', itemId: 'fixture-action-1', activityType: 'command', name: 'Bash', summary: STREAM_COMMAND.summary },
      { type: 'activity-ended', turnId: 'turn-1', itemId: 'fixture-action-1', status: 'completed', exitCode: 0 },
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'fixture-stream-1', phase: 'final', text: APPROVAL_MESSAGES.ran },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true },
    ]);
    expect(ended).toEqual(['approval:taken', 'approval:completed']);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('ends a denied action declined by the user, and one a refusal answered with nothing confirmed', async () => {
    const timers = manualTimers();
    const { session, events } = asking(timers);
    play(session, timers, 1, 'approval command');
    await session.decide?.('s:fixture-approval-1', 'deny');
    expect(events.slice(6)).toMatchObject([
      { type: 'approval-resolved', reason: 'confirmed' },
      { type: 'activity-started', itemId: 'fixture-action-1' },
      { type: 'activity-ended', itemId: 'fixture-action-1', status: 'declined', declinedBy: 'user' },
      { type: 'message', text: APPROVAL_MESSAGES.denied },
      { type: 'turn-ended', outcome: 'completed' },
    ]);
    const before = events.length;
    play(session, timers, 2, 'approval');
    await session.decide?.('s:fixture-approval-2', null);
    expect(types(events.slice(before))).toEqual(['turn-started', 'message', 'action-changed', 'approval-raised', 'message', 'turn-ended']);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('plays `approval grant` with the session’s choice, and runs the same prompt with no card once granted, for that process alone', async () => {
    const timers = manualTimers();
    const { facet, session, events } = asking(timers);
    play(session, timers, 1, 'approval grant');
    expect(events.at(-1)).toMatchObject({ type: 'approval-raised', request: { choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' } } });
    await session.decide?.('s:fixture-approval-1', 'approve-session');
    const before = events.length;
    play(session, timers, 2, 'approval grant');
    // Covered by the grant: the action runs, and nothing asks.
    expect(types(events.slice(before))).toEqual(['turn-started', 'message', 'action-changed', 'activity-started', 'activity-ended', 'message', 'turn-ended']);
    // `command` is another action: it asks all the same.
    play(session, timers, 3, 'approval command');
    expect(events.at(-1)).toMatchObject({ type: 'approval-raised', request: { grant: null } });
    // Another process of the same form holds no grant.
    const again = facet.resume({ ...ASKING, reference: 'fixture-stream', processKey: 'process-2' });
    const later = collect(again);
    play(again, timers, 4, 'approval grant');
    expect(later.at(-1)).toMatchObject({ type: 'approval-raised', requestId: 's:fixture-approval-4' });
  });

  it('plays `approval file` as two changes, one of every matching passage and one outside the project’s folders, within every bound', () => {
    const timers = manualTimers();
    const { session, events } = asking(timers);
    play(session, timers, 1, 'approval file');
    const raised = events.at(-1);
    expect(raised).toMatchObject({ type: 'approval-raised', request: { kind: 'file-change', outside: true, authority: [{ kind: 'folder', mode: null }], choices: ['approve', 'deny'], grant: null } });
    expect(STREAM_FILE.detail.kind === 'changes' ? STREAM_FILE.detail.changes.map((change) => [change.kind, change.all]) : []).toEqual([['update', true], ['write', null]]);
    expect(ApprovalRequestSchema.safeParse(STREAM_FILE).success).toBe(true);
    for (const request of [STREAM_COMMAND, STREAM_GRANTED]) expect(ApprovalRequestSchema.safeParse(request).success).toBe(true);
  });

  it('plays `approval denied` with no card: the action ends declined by a rule of the configuration', () => {
    const timers = manualTimers();
    const { session, events } = asking(timers);
    play(session, timers, 1, 'approval denied');
    expect(types(events)).toEqual(['in-force', 'turn-started', 'session-started', 'message', 'action-changed', 'activity-started', 'activity-ended', 'message', 'turn-ended']);
    expect(events[6]).toMatchObject({ type: 'activity-ended', status: 'declined', declinedBy: 'rule' });
    expect(events[7]).toMatchObject({ text: APPROVAL_MESSAGES.byRule });
  });

  it('plays `approval worker` as a sub-agent’s request, decided in its own thread', async () => {
    const timers = manualTimers();
    const { session, events } = asking(timers);
    play(session, timers, 1, 'approval worker');
    expect(types(events).slice(4)).toEqual(['action-changed', 'worker-started', 'activity-started', 'action-changed', 'approval-raised']);
    expect(events.at(-1)).toMatchObject({ type: 'approval-raised', workerId: 'fixture-worker-1', requestId: 's:fixture-approval-1' });
    const before = events.length;
    await session.decide?.('s:fixture-approval-1', 'approve');
    expect(events.slice(before)).toMatchObject([
      { type: 'approval-resolved', reason: 'confirmed' },
      { type: 'activity-started', itemId: 'fixture-action-1', workerId: 'fixture-worker-1' },
      { type: 'activity-ended', itemId: 'fixture-action-1', workerId: 'fixture-worker-1', status: 'completed' },
      { type: 'activity-ended', itemId: 'fixture-launch-1', status: 'completed' },
      { type: 'worker-ended', workerId: 'fixture-worker-1', outcome: 'completed' },
      { type: 'message', text: APPROVAL_MESSAGES.workerRan },
      { type: 'turn-ended', outcome: 'completed' },
    ]);
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it.each([[STREAM_READ_ONLY], [null]])('refuses every asking word under the reading mode (%s), as a real request is', (mode) => {
    const timers = manualTimers();
    const { session, events } = asking(timers, mode === null ? START : { ...START, mode });
    for (const [n, word] of ['command', 'file', 'grant', 'denied', 'worker'].entries()) play(session, timers, n + 1, `approval ${word}`);
    expect(events.filter((event) => event.type === 'approval-raised' || event.type === 'activity-started')).toEqual([]);
    expect(events.filter((event) => event.type === 'notice')).toHaveLength(5);
    expect(events.filter((event) => event.type === 'message' && event.role === 'assistant').every((event) => event.type === 'message' && event.text === APPROVAL_MESSAGES.refused)).toBe(true);
  });

  it('says a request still held dropped before the end its close makes, and leaves one held at a Stop to the turn’s end', () => {
    const timers = manualTimers();
    const { session, events } = asking(timers);
    play(session, timers, 1, 'approval');
    void session.close();
    expect(events.slice(-2)).toEqual([{ type: 'approval-resolved', requestId: 's:fixture-approval-1', reason: 'dropped' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    const second = asking(timers);
    play(second.session, timers, 2, 'approval');
    second.session.stop();
    expect(second.events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'interrupted', reported: true });
    expect(second.events.some((event) => event.type === 'approval-resolved')).toBe(false);
  });

  it('arms a setup at `approval setup`: the asking mode needs it, the first try fails with its reason, and the second completes', () => {
    const timers = manualTimers();
    const { facet, session, events } = asking(timers);
    let changes = 0;
    facet.onModesChanged?.(() => { changes += 1; });
    expect(facet.sandbox?.act('start')).toBe('no-setup');
    play(session, timers, 1, 'approval setup');
    expect(events.filter((event) => event.type === 'message' && event.role === 'assistant')).toMatchObject([{ text: APPROVAL_MESSAGES.armed }]);
    expect(changes).toBe(1);
    expect(facet.modes?.()[1]).toMatchObject({ id: STREAM_ASK_FIRST, available: false, reason: 'needs-setup', setup: true });
    expect(facet.sandbox?.state()).toEqual({ state: 'idle', error: null, readiness: 'not-configured' });
    // The press, and nothing before it.
    expect(facet.sandbox?.act('start')).toBe('started');
    expect(facet.sandbox?.state().state).toBe('starting');
    expect(facet.sandbox?.act('start')).toBe('running');
    timers.advance(0);
    expect(facet.sandbox?.state().state).toBe('waiting');
    timers.advance(SETUP_WAIT_MS);
    expect(facet.sandbox?.state()).toEqual({ state: 'failed', error: SETUP_FAILURE, readiness: 'not-configured' });
    expect(facet.modes?.()[1]?.available).toBe(false);
    // Try again: a new press, which completes.
    expect(facet.sandbox?.act('start')).toBe('started');
    timers.advance(SETUP_WAIT_MS);
    expect(facet.sandbox?.state()).toEqual({ state: 'completed', error: null, readiness: 'ready' });
    expect(facet.modes?.()[1]).toMatchObject({ available: true, reason: null, setup: false });
    expect(changes).toBeGreaterThan(4);
  });

  it('waits for nothing at `approval unknown` until Stop waiting, whose outcome is unknown; the next press completes', () => {
    const timers = manualTimers();
    const { facet, session } = asking(timers);
    play(session, timers, 1, 'approval unknown');
    expect(facet.sandbox?.act('stop-waiting')).toBe('no-setup');
    expect(facet.sandbox?.act('start')).toBe('started');
    timers.advance(3_600_000);
    expect(facet.sandbox?.state().state).toBe('waiting');
    expect(facet.sandbox?.act('stop-waiting')).toBe('stopping');
    expect(facet.sandbox?.state()).toEqual({ state: 'unknown', error: null, readiness: 'not-configured' });
    expect(facet.modes?.()[1]?.available).toBe(false);
    expect(facet.sandbox?.act('start')).toBe('started');
    timers.advance(SETUP_WAIT_MS);
    expect(facet.sandbox?.state().state).toBe('completed');
  });
});

// M22b (V8): plans in the stream form, so that the page can be seen planning without a CLI.
describe('a plan, as the form’s sessions tell it (M22b: V8)', () => {
  const plan = (n: number, prompt: string) => ({ ...request(n, prompt), plan: true });
  const types = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type);

  it('declares a plan turn under Ask first and none under Read only, as Claude does, and its account plans', () => {
    const facet = streamFacet({ fixture });
    expect(streamDefinition(facet).descriptor.capabilities.plans).toBe(STREAM_PLANS);
    expect(STREAM_PLANS.modes).toEqual([STREAM_ASK_FIRST]);
    expect(STREAM_PLANS.modes).not.toContain(STREAM_READ_ONLY);
    expect(facet.plans?.()).toEqual({ available: true });
  });

  it('writes a plan turn’s plan as Codex does — opened empty, a piece a step, completed whole — and ends the turn', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(plan(1, 'Plan the tides.'));
    timers.advance(0);
    for (let step = 0; step < 200; step += 1) timers.advance(STREAM_STEP_MS);
    const deltas = events.filter((event) => event.type === 'plan-delta');
    expect(deltas[0]).toMatchObject({ text: '' });
    expect(deltas.map((event) => (event.type === 'plan-delta' ? event.text : '')).join('')).toBe(STREAM_PLAN);
    expect(events.find((event) => event.type === 'plan-completed')).toMatchObject({ turnId: 'turn-1', text: STREAM_PLAN });
    expect(types(events).at(-1)).toBe('turn-ended');
    for (const event of events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('asks about a plan in a request for a prompt that begins with `request`: feedback brings the next version, Execute runs it', async () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(plan(1, 'request a plan of the tides'));
    timers.advance(0);
    expect(events.at(-1)).toEqual({ type: 'plan-raised', turnId: 'turn-1', requestId: 'fixture-plan-1-1', sourceId: 'fixture-plan-use-1-1', text: STREAM_PLAN });
    expect(await session.decidePlan?.('fixture-plan-1-1', { kind: 'feedback', text: 'One more step.' })).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'plan-raised', requestId: 'fixture-plan-1-2', text: STREAM_PLAN_REVISED });
    expect(await session.decidePlan?.('fixture-plan-1-2', { kind: 'execute' })).toBe(true);
    expect(events.slice(-3).map((event) => event.type)).toEqual(['plan-resolved', 'message', 'turn-ended']);
    expect(events.at(-2)).toMatchObject({ text: PLAN_MESSAGES.executed });
    // Cancel ends a turn stopped.
    session.send(plan(2, 'request another'));
    timers.advance(0);
    await session.decidePlan?.('fixture-plan-2-1', { kind: 'cancel' });
    expect(events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'interrupted', reported: true });
  });

  it('plans a text past the tab’s whole draw for the word `long`, written slowly, and asks about it whole in a request', async () => {
    expect(STREAM_PLAN_LONG.length).toBeGreaterThan(256 * 1024);
    expect(STREAM_PLAN_LONG.match(/^## /gm)?.length).toBe(60);
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(plan(1, `Plan the tides ${PLAN_LONG_WORD}`));
    timers.advance(0);
    for (let step = 0; step < 20; step += 1) timers.advance(700);
    const deltas = events.filter((event) => event.type === 'plan-delta');
    expect(deltas.length).toBeGreaterThan(10);
    expect(events.find((event) => event.type === 'plan-completed')).toMatchObject({ text: STREAM_PLAN_LONG });
    session.send(plan(2, `request ${PLAN_LONG_WORD}`));
    timers.advance(0);
    expect(events.at(-1)).toMatchObject({ type: 'plan-raised', text: STREAM_PLAN_LONG });
    await session.decidePlan?.('fixture-plan-2-1', { kind: 'cancel' });
  });

  it('runs a plan for fat-g’s Execute words, and plans the next version for a plan turn that carries a block', () => {
    const timers = manualTimers();
    const session = streamFacet({ fixture, timers }).start(START);
    const events = collect(session);
    session.send(request(1, `${PLAN_WORDS.execute}\n\n<fat-g-plan id="a1b2c3d4-0000-4000-8000-000000000001" version="1" token="0123456789ab">\n</fat-g-plan token="0123456789ab">`));
    timers.advance(0);
    expect(events.find((event) => event.type === 'message' && event.role === 'assistant')).toMatchObject({ text: PLAN_MESSAGES.executed });
    session.send(plan(2, 'Shorter.\n\n<fat-g-plan id="a1b2c3d4-0000-4000-8000-000000000001" version="1" token="0123456789ab">\n</fat-g-plan token="0123456789ab">'));
    timers.advance(0);
    for (let step = 0; step < 200; step += 1) timers.advance(STREAM_STEP_MS);
    expect(events.filter((event) => event.type === 'plan-completed').map((event) => (event.type === 'plan-completed' ? event.text : ''))).toEqual([STREAM_PLAN_REVISED]);
  });
});

describe('a review, as the form’s provider answers one (M22e: B7, V6)', () => {
  const PROMPT = reviewPrompt({ title: 'Measure the tides', planId: 'a1b2c3d4-0000-4000-8000-000000000001', version: 1, text: STREAM_PLAN, token: '0123456789ab', folder: 'D:\tides' });
  const issues = (text: string) => { const read = readFindings(text, 2); if (read.verdict !== 'findings') throw new Error(read.verdict); return read; };

  it('answers fat-g’s review prompt with five findings over three tiers, the first anchored at the plan’s heading', () => {
    const answer = reviewAnswer(PROMPT, false);
    const read = issues(answer?.text ?? '');
    expect(read.block.issues.map((finding) => finding.id)).toEqual(['T1.1', 'T1.2', 'T2.1', 'T3.1', 'T3.2']);
    expect(read.block.issues[0]?.anchor).toEqual({ heading: 'Measure the tides', quote: 'Read the tide tables for January.' });
    expect(read.before.length).toBeGreaterThan(0);
    expect(reviewAnswer('Anything else.', false)).toBeNull();
  });

  it('answers Send notes with the review again, one finding moved under a new id naming `was`, and a note that asks with prose above it unchanged', () => {
    const notes = sendNotesPrompt({ findings: STREAM_FINDINGS, marks: {}, notes: { 'T2.1': 'This is minor.' } });
    const settled = reviewAnswer(notes, false);
    expect(settled?.moved).toBe(true);
    const moved = issues(settled?.text ?? '').block.issues.find((finding) => finding.was !== undefined);
    expect(moved).toMatchObject({ id: 'T3.3', tier: 3, was: 'T2.1' });
    const asking = reviewAnswer(sendNotesPrompt({ findings: STREAM_FINDINGS_MOVED, marks: {}, notes: { 'T1.1': 'Why do you ask this?' } }), true);
    expect(asking?.moved).toBe(true);
    const read = issues(asking?.text ?? '');
    expect(read.block.issues).toEqual(STREAM_FINDINGS_MOVED);
    expect(read.before).toContain('You asked');
  });

  // The maintainer: what the page says of findings an answer set aside, made to be seen.
  it('answers a note holding `garble` with the review as it stands, T1.2 with no correction and a new finding with no id', () => {
    const garbled = reviewAnswer(sendNotesPrompt({ findings: STREAM_FINDINGS_MOVED, marks: {}, notes: { 'T1.2': 'Please garble this.' } }), true);
    expect(garbled?.moved).toBe(true);
    const read = issues(garbled?.text ?? '');
    expect(read.block.issues).toEqual(STREAM_FINDINGS_MOVED.filter((finding) => finding.id !== 'T1.2'));
    expect(read.setAside).toEqual([{ position: 2, id: 'T1.2', problem: 'correction' }, { position: 6, id: null, problem: 'id' }]);
  });
});
