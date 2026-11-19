// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session contract's pure helpers (docs/planning/_archive/M14.md: V2, V9, V12).
import { describe, expect, it } from 'vitest';
import { INVOKE_SPECS } from '../ipc/contract';
import {
  actionDetail,
  actionLabel,
  actionStatus,
  type AgentView,
  attentionWords,
  cleanLabel,
  formatElapsed,
  isActive,
  MAX_FINISHED_AGENTS,
  NAME_SOURCES,
  nameReplaces,
  notStarted,
  orderAgents,
  PLAN_WAIT_WORDS,
  planWaitShown,
  sameContext,
  SessionEventSchema,
  sessionDisplayName,
  sessionLabel,
  sessionParts,
  SessionSummarySchema,
  statusWords,
  waitingOnWorkers,
  workerLabel,
  workersLine,
  workersText,
} from './sessions';

// ── V2 ────────────────────────────────────────────────────────────────────────────────────────
describe('the name’s fallback order (C9)', () => {
  // user > generated > provider > first-message: a name replaces one of the same or a lower rank.
  const expected: Record<string, readonly string[]> = {
    user: ['user', 'generated', 'provider', 'first-message'],
    generated: ['generated', 'provider', 'first-message'],
    provider: ['provider', 'first-message'],
    'first-message': ['first-message'],
  };
  it.each(NAME_SOURCES.flatMap((next) => NAME_SOURCES.map((current) => [next, current] as const)))('a %s name over a %s one', (next, current) => {
    expect(nameReplaces(current, next)).toBe(expected[next]?.includes(current));
  });

  it.each(NAME_SOURCES)('a %s name replaces none', (next) => {
    expect(nameReplaces(null, next)).toBe(true);
  });
});

describe('a session’s shown name (C8)', () => {
  it('is its name', () => {
    expect(sessionDisplayName({ name: 'Create plan', createdAt: 0 })).toBe('Create plan');
  });

  it('is its creation time when it has none, which is never a stored name', () => {
    const shown = sessionDisplayName({ name: null, createdAt: Date.UTC(2020, 0, 22, 13, 23) }, 'en-GB', 'UTC');
    // The month's abbreviation is the runtime's locale data's to choose: "Sep" or "Sept".
    expect(shown).toMatch(/^22 Jan 2020, 13:23$/);
  });
});

// M26 (round 2): a name written from a draft before anything ran is shown behind "New session: ",
// and the prefix goes by itself at the first turn, when a title of the session's own replaces it.
describe('a session’s label before its first turn (M26, round 2)', () => {
  const entry = (name: string | null, nameSource: 'user' | 'generated' | null, status: 'not-started' | 'idle') =>
    ({ record: { name, nameSource, createdAt: Date.UTC(2020, 0, 22, 13, 23) }, summary: { status } }) as Parameters<typeof sessionLabel>[0];

  it('says which sessions have run nothing', () => {
    expect(notStarted(entry(null, null, 'not-started'))).toBe(true);
    expect(notStarted(entry(null, null, 'idle'))).toBe(false);
  });

  it('puts New session before a generated name while nothing has run', () => {
    expect(sessionLabel(entry('setting things up', 'generated', 'not-started'))).toBe('New session: setting things up');
  });

  it('leaves a started session’s generated name, and a name the user typed, as they are', () => {
    expect(sessionLabel(entry('setting things up', 'generated', 'idle'))).toBe('setting things up');
    expect(sessionLabel(entry('Create plan', 'user', 'not-started'))).toBe('Create plan');
  });

  it('is the creation time, with nothing before it, for a session with no name', () => {
    expect(sessionLabel(entry(null, null, 'not-started'), 'en-GB', 'UTC')).toMatch(/^22 Jan 2020, 13:23$/);
  });

  // Decision 0029 (the maintainer): drawn as a started chat is, so its plan's name stands alone.
  it('leaves the generated name of a chat that takes part in a plan as it is, though nothing ran', () => {
    const named = entry('Plan: Tidy the notes', 'generated', 'not-started');
    expect(sessionLabel({ ...named, summary: { ...named.summary, attention: { kind: 'plan', count: 1, acknowledged: false } } })).toBe('Plan: Tidy the notes');
    expect(sessionLabel({ ...named, summary: { ...named.summary, planWait: 'review' } })).toBe('Plan: Tidy the notes');
  });
});

// ── C21: labels ───────────────────────────────────────────────────────────────────────────────
describe('cleanLabel (C21)', () => {
  it.each([
    ['keeps one line as it is', 'I’ll read sample.txt to find the cat’s name.', 'I’ll read sample.txt to find the cat’s name.'],
    ['keeps the first line only', 'Reading the notes\nthen the rest\nand more', 'Reading the notes'],
    ['passes over empty first lines', '\n  \nThinking it through', 'Thinking it through'],
    ['cuts a Windows path to its last segment, spaces in it included', 'Reading C:\\Users\\Some One\\Code\\notes.txt now', 'Reading notes.txt now'],
    ['cuts every path on the line', 'Compare C:\\Users\\someone\\a.txt with D:\\work\\b.txt', 'Compare a.txt with b.txt'],
    ['cuts a drive path written with forward slashes', 'Reading C:/Users/someone/notes.txt', 'Reading notes.txt'],
    ['cuts a UNC path', 'Open \\\\server\\share\\plan.md', 'Open plan.md'],
    ['cuts a POSIX path', 'Reading /home/someone/code/notes.txt', 'Reading notes.txt'],
    ['leaves a fraction, a relative path and an address alone', 'Half (1/2) of src/main is at https://example.test/docs', 'Half (1/2) of src/main is at https://example.test/docs'],
    ['removes control characters and runs of spaces', 'Writing\t the \u0007 plan', 'Writing the plan'],
  ])('%s', (_name, line, expected) => {
    expect(cleanLabel(line)).toBe(expected);
  });

  it('clamps like a name: 60 clusters, the last an ellipsis', () => {
    const label = cleanLabel(`I'll read sample.txt to find the cat's name, then compare it with the notes`);
    expect([...label]).toHaveLength(60);
    expect(label).toBe(`I'll read sample.txt to find the cat's name, then compare i…`);
  });

  it('gives nothing for nothing', () => {
    expect(cleanLabel(' \n ')).toBe('');
  });
});

describe('an action’s label (C21)', () => {
  it.each([
    ['thinking', undefined, undefined, 'Thinking…'],
    ['reading', undefined, 'D:\\Code\\fat-g\\notes.txt', 'Reading notes.txt'],
    ['reading', undefined, undefined, 'Reading'],
    ['writing', undefined, '/home/someone/plan.md', 'Writing plan.md'],
    ['running', undefined, undefined, 'Running a command'],
    ['tool', undefined, undefined, 'Using a tool'],
    // fat-g's words for the kind (M21, C15): never the question's text.
    ['asking', undefined, undefined, 'Asking a question'],
    ['compacting', undefined, undefined, 'Compacting'],
    ['waiting', undefined, undefined, 'Waiting'],
    // The provider's own line wins over fat-g's words, and over the file.
    ['reading', 'I’ll read sample.txt to find the cat’s name.', 'D:\\x\\sample.txt', 'I’ll read sample.txt to find the cat’s name.'],
    ['thinking', ' \n ', undefined, 'Thinking…'],
  ] as const)('%s, line %j, file %j', (kind, line, file, expected) => {
    expect(actionLabel(kind, line, file)).toBe(expected);
  });

  // M100 (C52, V13): the detail apart from the status, which is the kind's words.
  it.each([
    [undefined, undefined, null],
    [undefined, '/home/someone/plan.md', 'plan.md'],
    ['I’ll read sample.txt to find the cat’s name.', 'D:\\x\\sample.txt', 'I’ll read sample.txt to find the cat’s name.'],
    ['Reading C:\\Users\\Some One\\notes.txt\nsecond line', undefined, 'Reading notes.txt'],
    [' \n ', undefined, null],
  ] as const)('details line %j, file %j as %j', (line, file, expected) => {
    expect(actionDetail(line, file)).toBe(expected);
  });

  it('gives an action’s status as its kind’s words, whatever its line', () => {
    expect(actionStatus('reading')).toBe('Reading');
    expect(actionStatus('tool')).toBe('Using a tool');
    expect(actionStatus('thinking')).toBe('Thinking…');
  });

  it('words a session waiting on its workers (C114)', () => {
    expect(waitingOnWorkers(2)).toEqual({ kind: 'waiting', label: 'Waiting for 2 sub-agents', detail: null, wait: { reason: 'subagents', count: 2 } });
    expect(waitingOnWorkers(1).label).toBe('Waiting for a sub-agent');
    expect(actionStatus({ kind: 'waiting', wait: { reason: 'subagents' } })).toBe('Waiting for sub-agents');
    expect(actionStatus({ kind: 'waiting', wait: { reason: 'provider' } })).toBe('Waiting');
  });

  it('labels a worker by its description, else its identifier without its path, else its number (C113)', () => {
    expect(workerLabel(1, 'Explore the login flow', 'thread-9')).toBe('Explore the login flow');
    expect(workerLabel(2, undefined, '019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9b')).toBe('019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9b');
    expect(workerLabel(3, '  ', 'C:\\Users\\someone\\.codex\\agents\\explorer')).toBe('explorer');
    expect(workerLabel(4)).toBe('Worker 4');
  });
});

describe('a session’s state in words (C40, C41, C43, C52, C62)', () => {
  it.each([
    [{ kind: 'ready', count: 1 }, 'ready'],
    [{ kind: 'question', count: 1 }, '1 Question'],
    [{ kind: 'question', count: 3 }, '3 Questions'],
    [{ kind: 'approval', count: 1 }, '1 Approval'],
    [{ kind: 'approval', count: 2 }, '2 Approvals'],
    [{ kind: 'error', count: 1 }, 'error'],
    [{ kind: 'stopped', count: 1 }, 'stopped'],
  ] as const)('%j reads %s', (attention, words) => {
    expect(attentionWords(attention)).toBe(words);
  });

  const base = { status: 'idle', turnStartedAt: null, activeWorkers: 0, attention: null, action: null, agents: [], model: 'm', effort: null, mode: null } as const;
  it('carries a user-initiated plan attention without changing its pending status', () => {
    const summary = { ...base, attention: { kind: 'plan', count: 1, acknowledged: false, flash: false } };
    expect(SessionSummarySchema.parse(summary).attention).toEqual(summary.attention);
    expect(SessionSummarySchema.safeParse({ ...summary, attention: { ...summary.attention, flash: 'quiet' } }).success).toBe(false);
  });
  it('names the attention first, then the action, then the status', () => {
    expect(statusWords({ ...base, status: 'not-started' })).toBe('Not started');
    expect(statusWords(base)).toBe('Idle');
    expect(statusWords({ ...base, status: 'running', action: { kind: 'reading', label: 'Reading notes.txt' } })).toBe('Reading notes.txt');
    expect(statusWords({ ...base, status: 'running' })).toBe('Thinking…');
    expect(statusWords({ ...base, status: 'running', action: { kind: 'asking', label: 'Asking a question' }, attention: { kind: 'question', count: 3, acknowledged: true } })).toBe('3 Questions');
    expect(statusWords({ ...base, attention: { kind: 'ready', count: 1, acknowledged: false } })).toBe('Ready');
  });

  // Decision 0029 (the maintainer).
  it('says what a chat of a plan waits on over READY and its plan’s request, and under its own decisions and its own turn', () => {
    expect(statusWords({ ...base, planWait: 'review' })).toBe('Waiting on plan review');
    expect(statusWords({ ...base, planWait: 'revision', attention: { kind: 'ready', count: 1, acknowledged: true } })).toBe('Waiting on plan revision');
    expect(PLAN_WAIT_WORDS.implementation).toBe('Waiting on plan implementation');
    // A request the chat still holds on the plan waits on the same plan.
    expect(planWaitShown({ ...base, status: 'running', planWait: 'review', attention: { kind: 'plan', count: 1, acknowledged: false } })).toBe('review');
    expect(planWaitShown({ ...base, planWait: 'review', attention: { kind: 'error', count: 1, acknowledged: false } })).toBeNull();
    expect(planWaitShown({ ...base, status: 'running', planWait: 'implementation', attention: { kind: 'question', count: 1, acknowledged: false } })).toBeNull();
    expect(planWaitShown({ ...base, status: 'running', planWait: 'implementation' })).toBeNull();
    expect(planWaitShown(base)).toBeNull();
  });

  it('counts the active subagents', () => {
    expect(workersText(8)).toBe('+8 active subagents');
    expect(workersText(1)).toBe('+1 active subagent');
    // The line under a capsule's time (M100, C53).
    expect(workersLine(8)).toBe('8 subagents');
    expect(workersLine(1)).toBe('1 subagent');
  });
});

// ── V12: the formats ──────────────────────────────────────────────────────────────────────────
describe('formatElapsed (C51)', () => {
  it.each([
    [0, '0s'],
    [999, '0s'],
    [32_000, '32s'],
    [59_999, '59s'],
    [60_000, '1m0s'],
    [247_000, '4m7s'],
    [452_000, '7m32s'],
    [3_599_000, '59m59s'],
    [3_600_000, '1h0m0s'],
    [3_725_000, '1h2m5s'],
    [4_320_000, '1h12m0s'],
    [90_000_000, '25h0m0s'],
    [-5_000, '0s'],
  ])('%d ms reads %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

// ── V9: the list's parts ──────────────────────────────────────────────────────────────────────
describe('sessionParts (C37–C39, C46–C48, C50)', () => {
  const s = (name: string, starred = false, completedAt: number | null = null, shelvedAt: number | null = null) => ({ name, record: { starred, completedAt, shelvedAt } });
  const shelved = (name: string, shelvedAt: number, starred = false) => s(name, starred, null, shelvedAt);
  const names = (list: readonly { name: string }[]) => list.map((item) => item.name);
  const completed = (count: number) => Array.from({ length: count }, (_unused, index) => s(`done-${index + 1}`, false, 1000 + index));

  it('gives a project with no session nothing to draw', () => {
    expect(sessionParts([], 5)).toEqual({ active: [], shelf: [], row: null, completed: [], showMore: false, showLess: false });
  });

  it('puts the starred active sessions first, each group in stored order — a new session being first of its own', () => {
    const parts = sessionParts([s('new'), s('b', true), s('c'), s('d', true), s('e')], 5);
    expect(names(parts.active)).toEqual(['b', 'd', 'new', 'c', 'e']);
    expect(parts.row).toBeNull();
  });

  it('keeps the order whatever the sessions’ states: nothing in a record view moves one (C39)', () => {
    const parts = sessionParts([s('a'), s('b'), s('c')], 5);
    expect(names(parts.active)).toEqual(['a', 'b', 'c']);
  });

  it('keeps starred completed sessions among the completed, first, each group in saved order: the star files nothing on the shelf', () => {
    const parts = sessionParts([s('old-star', true, 100), s('active'), s('done', false, 300), s('new-star', true, 200)], 5);
    expect(names(parts.active)).toEqual(['active']);
    expect(parts.shelf).toEqual([]);
    expect(names(parts.completed)).toEqual(['old-star', 'new-star', 'done']);
    expect(parts.row).toEqual({ shelf: 0, completed: 3 });
  });

  it('puts the shelved sessions on the shelf alone, the starred first, each group in saved order, never among the active', () => {
    const parts = sessionParts([shelved('old-shelf', 100), s('active'), s('star-done', true, 900), shelved('new-shelf', 300), shelved('star-shelf', 50, true), s('done', false, 50)], 5);
    expect(names(parts.active)).toEqual(['active']);
    expect(names(parts.shelf)).toEqual(['star-shelf', 'old-shelf', 'new-shelf']);
    expect(names(parts.completed)).toEqual(['star-done', 'done']);
    expect(parts.row).toEqual({ shelf: 3, completed: 2 });
  });

  it('cuts the completed after the starred ones are put first', () => {
    expect(names(sessionParts([...completed(6), s('star', true, 1)], 5).completed)).toEqual(['star', 'done-1', 'done-2', 'done-3', 'done-4']);
  });

  it('tells an active session from a shelved or a completed one', () => {
    expect([isActive(s('a').record), isActive(shelved('b', 1).record), isActive(s('c', false, 1).record)]).toEqual([true, false, false]);
  });

  it('keeps completed order independent of completion timestamps', () => {
    const parts = sessionParts([s('first', false, 100), s('third', false, 300), s('second', false, 200)], 5);
    expect(names(parts.completed)).toEqual(['first', 'third', 'second']);
  });

  it.each([
    ['only starred completed', [s('x', true, 1)], { shelf: 0, completed: 1 }],
    ['only shelved', [shelved('x', 1)], { shelf: 1, completed: 0 }],
    ['only completed', [s('x', false, 1)], { shelf: 0, completed: 1 }],
    ['neither', [s('x'), s('y', true)], null],
  ])('shows the row with %s: %j', (_name, sessions, row) => {
    expect(sessionParts(sessions, 5).row).toEqual(row);
  });

  // Twelve completed: 5 shown, then 10, then all 12; Show more while any remain, Show less past five.
  it.each([
    [3, 5, 3, false, false],
    [5, 5, 5, false, false],
    [6, 5, 5, true, false],
    [12, 5, 5, true, false],
    [12, 10, 10, true, true],
    [12, 15, 12, false, true],
    [6, 10, 6, false, true],
    [12, 0, 0, true, false],
  ])('with %d completed and %d asked for, shows %d (more: %s, less: %s)', (count, shown, drawn, showMore, showLess) => {
    const parts = sessionParts(completed(count), shown);
    expect(parts.completed).toHaveLength(drawn);
    expect([parts.showMore, parts.showLess]).toEqual([showMore, showLess]);
    expect(parts.row).toEqual({ shelf: 0, completed: count });
  });

  it('cuts to the first saved entries', () => {
    expect(names(sessionParts(completed(7), 5).completed)).toEqual(['done-1', 'done-2', 'done-3', 'done-4', 'done-5']);
  });

  it('is the same for a hidden project’s sessions: it knows no project', () => {
    const sessions = [s('a', true), s('b'), s('c', false, 5), shelved('d', 6)];
    expect(sessionParts(sessions, 5)).toEqual(sessionParts([...sessions], 5));
  });
});

describe('orderAgents (C92)', () => {
  const agent = (number: number, state: AgentView['state'], startedAt: number, finishedAt: number | null = null): AgentView =>
    ({ id: `w${number}`, number, label: `Worker ${number}`, state, action: null, startedAt, finishedAt, model: null, agentType: null, attention: null });

  it('puts the running first, the most recently started on top and the longest-running at the bottom', () => {
    const { running } = orderAgents([agent(1, 'running', 100), agent(2, 'completed', 110, 300), agent(3, 'running', 250), agent(4, 'running', 180)]);
    expect(running.map((item) => item.number)).toEqual([3, 4, 1]);
  });

  it('then the finished, the most recently finished first, failed ones among them', () => {
    const { finished } = orderAgents([agent(1, 'completed', 100, 400), agent(2, 'failed', 110, 900), agent(3, 'running', 120), agent(4, 'completed', 130, 600)]);
    expect(finished.map((item) => item.number)).toEqual([2, 4, 1]);
  });

  it('breaks a tie by number, and leaves the list it was given alone', () => {
    const agents = [agent(1, 'running', 100), agent(2, 'running', 100)];
    expect(orderAgents(agents).running.map((item) => item.number)).toEqual([2, 1]);
    expect(agents.map((item) => item.number)).toEqual([1, 2]);
  });
});

// ── The schemas ───────────────────────────────────────────────────────────────────────────────
describe('the summary schema (C30)', () => {
  const summary = { status: 'running', turnStartedAt: 5, activeWorkers: 0, attention: null, action: { kind: 'thinking', label: 'Thinking…' }, agents: [], model: 'gpt-6-sol', effort: null, mode: null };

  it('keeps the transient hold to a kind, safe wait and deadline, with no detail history', () => {
    const displayHold = { kind: 'waiting', wait: { reason: 'subagents', count: 2 }, until: 400 };
    expect(SessionSummarySchema.safeParse({ ...summary, displayHold }).success).toBe(true);
    for (const patch of [{ detail: 'private file' }, { label: 'private task' }, { until: -1 }, { wait: { reason: 'retry' } }]) {
      expect(SessionSummarySchema.safeParse({ ...summary, displayHold: { ...displayHold, ...patch } }).success).toBe(false);
    }
  });

  it('takes a summary, and refuses an extra field, an unknown kind and a label that is not clean', () => {
    expect(SessionSummarySchema.safeParse(summary).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, reference: 'x' }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, status: 'paused' }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, action: { kind: 'thinking', label: 'two\nlines' } }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, attention: { kind: 'question', count: 0, acknowledged: false } }).success).toBe(false);
  });

  // M100 (C52, V13): a summary written before the detail still passes; one with it takes a clean label or null.
  it('takes an action with no detail, a null one or a clean one, and refuses one that is not clean', () => {
    expect(SessionSummarySchema.safeParse({ ...summary, action: { kind: 'reading', label: 'Reading a.ts', detail: 'a.ts' } }).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, action: { kind: 'thinking', label: 'Thinking…', detail: null } }).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, action: { kind: 'reading', label: 'Reading a.ts', detail: '' } }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, action: { kind: 'reading', label: 'Reading a.ts', detail: 'two\nlines' } }).success).toBe(false);
  });

  // M106 (C8, C17, C20, C27, V1): each sub-agent with its model, its agent definition and its attention; the list bounded.
  it('takes a sub-agent with its model, agent definition and attention, each nullable, and bounds the list', () => {
    const agent = { id: 'w1', number: 1, label: 'Reads notes', state: 'running', action: null, startedAt: 5, finishedAt: null, model: 'haiku', agentType: 'Explore', attention: { kind: 'question', count: 1, acknowledged: false } };
    expect(SessionSummarySchema.safeParse({ ...summary, agents: [agent] }).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, agents: [{ ...agent, model: null, agentType: null, attention: null }] }).success).toBe(true);
    for (const patch of [{ model: '' }, { model: 'two words' }, { agentType: '' }, { agentType: 'two\nlines' }, { attention: { kind: 'question', count: 0, acknowledged: false } }, { model: undefined }]) {
      expect(SessionSummarySchema.safeParse({ ...summary, agents: [{ ...agent, ...patch }] }).success, JSON.stringify(patch)).toBe(false);
    }
    const many = (count: number) => Array.from({ length: count }, (_unused, index) => ({ ...agent, id: `w${index + 1}`, number: index + 1 }));
    expect(SessionSummarySchema.safeParse({ ...summary, agents: many(256) }).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, agents: many(257) }).success).toBe(false);
  });

  // Decision 0033: a live context reading, held beside the rest and checked as the event's.
  it('takes a summary with or without a context reading, and refuses one past its bounds', () => {
    expect(SessionSummarySchema.safeParse({ ...summary, context: { used: 15_800, window: 258_400, lastCall: { input: 3_203, cacheRead: 12_544, cacheWrite: 0, output: 53, reasoning: 0 } } }).success).toBe(true);
    expect(SessionSummarySchema.safeParse({ ...summary, context: { used: 1, window: 0 } }).success).toBe(false);
    expect(SessionSummarySchema.safeParse({ ...summary, context: { used: 1, window: 10, model: 'opus' } }).success).toBe(false);
  });
});

describe('sameContext (decision 0033)', () => {
  const reading = { used: 23_605, window: 1_000_000, compactAt: 967_000, parts: [{ label: 'System prompt', tokens: 3_183 }], messages: { toolCalls: 1, toolResults: 2, answers: 3, prompts: 4, attachments: 5, other: 6 }, lastCall: { input: 1, output: 2 } };

  it('says two readings of the same counts are the same, and any other count is a change', () => {
    expect(sameContext(reading, { ...reading, parts: [{ label: 'System prompt', tokens: 3_183 }], messages: { ...reading.messages }, lastCall: { ...reading.lastCall } })).toBe(true);
    expect(sameContext(undefined, undefined)).toBe(true);
    expect(sameContext(reading, undefined)).toBe(false);
    for (const other of [
      { ...reading, used: 23_606 },
      { ...reading, window: 200_000 },
      { ...reading, compactAt: null },
      { ...reading, compactAt: undefined },
      { ...reading, parts: [] },
      { ...reading, parts: [{ label: 'System tools', tokens: 3_183 }] },
      { ...reading, messages: { ...reading.messages, other: 7 } },
      { ...reading, lastCall: { input: 1, output: 3 } },
      { ...reading, calls: { input: 1, output: 2 } },
    ]) expect(sameContext(reading, other), JSON.stringify(other).slice(0, 80)).toBe(false);
  });
});

describe('a source’s events (C25, C115)', () => {
  const sessionId = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';

  it.each([
    { type: 'reference-set', sessionId, reference: '019f2c1a', folder: 'D:\\Code\\fat-g' },
    { type: 'turn-started', sessionId, turnId: 't1' },
    { type: 'turn-ended', sessionId, turnId: 't1', outcome: 'interrupted' },
    { type: 'action-changed', sessionId, turnId: 't1', kind: 'reading', file: 'notes.txt' },
    { type: 'action-changed', sessionId, turnId: 't1', kind: null },
    { type: 'worker-started', sessionId, workerId: 'w1', description: 'Explore' },
    { type: 'worker-started', sessionId, workerId: 'w1', description: 'Explore', model: 'haiku', agentType: 'general-purpose' },
    { type: 'worker-model', sessionId, workerId: 'w1', model: 'claude-haiku-4-5-20251001' },
    { type: 'workers-listed', sessionId, workers: [] },
    { type: 'workers-listed', sessionId, workers: [{ workerId: 'w1', label: 'Explore', status: 'failed', model: null, agentType: null, startedAt: 5, finishedAt: null }] },
    { type: 'worker-progressed', sessionId, workerId: 'w1', kind: 'thinking' },
    { type: 'worker-ended', sessionId, workerId: 'w1', outcome: 'failed' },
    { type: 'workers-reported', sessionId, workerIds: ['w1', 'w2'] },
    { type: 'request-raised', sessionId, owner: { turnId: 't1' }, requestId: 'r1', kind: 'question', count: 2 },
    { type: 'request-raised', sessionId, owner: { workerId: 'w1' }, requestId: 'r2', kind: 'approval', count: 1 },
    { type: 'request-resolved', sessionId, owner: { turnId: 't1' }, requestId: 'r1' },
    { type: 'in-force', sessionId, model: 'gpt-6-sol', effort: null },
    { type: 'name-reported', sessionId, name: 'Create plan', source: 'provider' },
    { type: 'context', sessionId, reading: { used: 15_800, window: 258_400 } },
  ])('takes $type', (event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    ['an unknown type', { type: 'turn-paused', sessionId, turnId: 't1' }],
    ['a turn event with no turn id', { type: 'turn-ended', sessionId, outcome: 'completed' }],
    ['an outcome only main gives', { type: 'turn-ended', sessionId, turnId: 't1', outcome: 'stopped' }],
    ['an extra field', { type: 'turn-started', sessionId, turnId: 't1', prompt: 'do it' }],
    ['a session id that is not a UUID', { type: 'turn-started', sessionId: 'one', turnId: 't1' }],
    ['a request owned by both a turn and a worker', { type: 'request-raised', sessionId, owner: { turnId: 't1', workerId: 'w1' }, requestId: 'r', kind: 'question', count: 1 }],
    ['a reference with a control character', { type: 'reference-set', sessionId, reference: 'a\u0000b', folder: 'D:\\x' }],
    ['a name source this build does not know', { type: 'name-reported', sessionId, name: 'x', source: 'robot' }],
    ['a worker’s model that is no catalog id', { type: 'worker-model', sessionId, workerId: 'w1', model: 'two words' }],
    ['a context reading with no window', { type: 'context', sessionId, reading: { used: 15_800 } }],
    ['a worker started on an empty model', { type: 'worker-started', sessionId, workerId: 'w1', model: '' }],
    ['a listed worker still running', { type: 'workers-listed', sessionId, workers: [{ workerId: 'w1', label: 'x', status: 'running', model: null, agentType: null, startedAt: 5, finishedAt: null }] }],
    ['more listed workers than a summary keeps', { type: 'workers-listed', sessionId, workers: Array.from({ length: MAX_FINISHED_AGENTS + 1 }, (_unused, index) => ({ workerId: `w${index}`, label: 'x', status: 'completed', model: null, agentType: null, startedAt: 5, finishedAt: 6 })) }],
  ])('refuses %s', (_name, event) => {
    expect(SessionEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('the session requests (C31)', () => {
  const id = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';
  const valid: Record<string, unknown> = {
    'sessions:create': { projectId: id, preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null } },
    'sessions:select': { id },
    'sessions:acknowledge': { id },
    'sessions:setFlag': { id, flag: 'toVerify', on: true },
    'sessions:rename': { id, name: 'Login form fix' },
    'sessions:complete': { id },
    'sessions:shelve': { id },
    'sessions:restore': { id },
    'sessions:move': { id, before: null, group: { list: 'active', starred: false } },
    'sessions:setEffort': { id, effort: 'xhigh' },
    'sessions:setSpeed': { id, speed: 'priority' },
    'sessions:remove': { id },
    'sessions:removeOrphans': null,
    'app:answerQuit': { quit: false },
  };

  it.each(Object.entries(valid))('%s takes its request', (channel, request) => {
    expect(INVOKE_SPECS[channel as keyof typeof INVOKE_SPECS].request.safeParse(request).success).toBe(true);
  });

  it('takes a preset with no effort, and refuses one whose model is not an id', () => {
    const { request } = INVOKE_SPECS['sessions:create'];
    expect(request.safeParse({ projectId: id, preset: { providerId: 'claude', instanceId: 'default', model: 'haiku', effort: null, speed: null } }).success).toBe(true);
    expect(request.safeParse({ projectId: id, preset: { providerId: 'claude', instanceId: 'default', model: 'opus', effort: 'high', speed: 'fast' } }).success).toBe(true);
    expect(request.safeParse({ projectId: id, preset: { providerId: 'claude', instanceId: 'default', model: 'two words', effort: null, speed: null } }).success).toBe(false);
    expect(request.safeParse({ projectId: id, preset: { providerId: 'claude', instanceId: 'default', model: 'haiku' } }).success).toBe(false);
    // The speed tier is never left out (decision 0016).
    expect(request.safeParse({ projectId: id, preset: { providerId: 'claude', instanceId: 'default', model: 'haiku', effort: null } }).success).toBe(false);
    expect(request.safeParse({ projectId: id, preset: { providerId: 'claude', instanceId: 'default', model: 'haiku', effort: null, speed: null, name: 'Fast' } }).success).toBe(false);
  });

  it('refuses an id that is not a UUID, and an effort of null: set effort takes a level', () => {
    expect(INVOKE_SPECS['sessions:select'].request.safeParse({ id: 'first' }).success).toBe(false);
    expect(INVOKE_SPECS['sessions:setEffort'].request.safeParse({ id, effort: null }).success).toBe(false);
    // Set speed takes a tier's id, or null for standard speed (decision 0016), and nothing else.
    expect(INVOKE_SPECS['sessions:setSpeed'].request.safeParse({ id, speed: null }).success).toBe(true);
    expect(INVOKE_SPECS['sessions:setSpeed'].request.safeParse({ id, speed: 'very fast' }).success).toBe(false);
    expect(INVOKE_SPECS['sessions:setSpeed'].request.safeParse({ id }).success).toBe(false);
    expect(INVOKE_SPECS['sessions:move'].request.safeParse({ id }).success).toBe(false);
  });

  it('sets one flag it knows, on or off, and nothing else', () => {
    const { request } = INVOKE_SPECS['sessions:setFlag'];
    for (const flag of ['starred', 'toDo', 'toVerify']) expect(request.safeParse({ id, flag, on: false }).success, flag).toBe(true);
    expect(request.safeParse({ id, flag: 'pinned', on: true }).success).toBe(false);
    expect(request.safeParse({ id, flag: 'starred' }).success).toBe(false);
    expect(request.safeParse({ id, starred: true }).success).toBe(false);
  });
});
