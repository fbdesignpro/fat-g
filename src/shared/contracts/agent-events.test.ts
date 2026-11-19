// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2 (docs/planning/_archive/M15.md; C9, C10, C113), V1 (M18.md; C47, C59), V2 (M19.md; C3) and V2 (M20a.md;
// C59): the normalized events as a closed, bounded union, at version seven (M20b; C8, C24, C25; M21;
// C20, C63).
import { describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_INPUT, MAX_ACTIVITY_OUTPUT, MAX_STEPS } from './activity';
import { AGENT_EVENTS_VERSION, type AgentEvent, AgentEventSchema, cutLine, cutTo, HistoryActivitySchema, HistoryMessageSchema, HistoryTurnSchema, MAX_AGENT_ID, MAX_MESSAGE_TEXT, MAX_NOTICE_DETAIL, MAX_OPTIONS, MAX_QUESTION_TEXT, MAX_QUESTIONS, NOTICE_KINDS, QUESTION_RESOLUTIONS, TURN_FAILURES } from './agent-events';
import { MAX_CONTEXT_LABEL, MAX_CONTEXT_PARTS, MAX_CONTEXT_TOKENS, MAX_LINE_INPUT, MAX_REFERENCE } from './sessions';

const EVENTS: readonly AgentEvent[] = [
  { type: 'session-started', reference: 'ref-1', folder: 'C:\\work\\project' },
  { type: 'turn-started', turnId: 't1', providerTurnId: 'provider-turn-1' },
  { type: 'message', turnId: 't1', role: 'user', itemId: 'i1', phase: null, text: 'Hello', clientId: 'm1' },
  { type: 'message', turnId: 't1', role: 'assistant', itemId: 'i2', phase: 'commentary', text: 'Reading…' },
  { type: 'message', turnId: 't1', role: 'assistant', itemId: 'i3', phase: 'final', text: 'Which one?', questions: [{ title: 'Pick', options: ['a', 'b'] }], cut: true },
  { type: 'message-delta', turnId: 't1', itemId: 'i3', phase: 'final', text: 'Which' },
  { type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'read', name: 'Read', summary: 'Read notes.txt', input: '{"file_path":"notes.txt"}', files: [{ path: 'notes.txt', line: 12 }], providerAt: 1_579_924_800_000 },
  { type: 'activity-ended', turnId: 't1', itemId: 'a1', status: 'failed', output: 'no such file', exitCode: 1, providerAt: 1_579_924_800_050, durationMs: 0 },
  { type: 'action-changed', turnId: 't1', kind: 'reading', line: 'I will read it', file: 'sample.txt' },
  { type: 'worker-started', workerId: 'w1', description: 'reads a file' },
  { type: 'worker-progressed', workerId: 'w1', kind: 'running' },
  { type: 'worker-ended', workerId: 'w1', outcome: 'failed' },
  { type: 'in-force', turnId: 't1', model: 'some-model', effort: null },
  { type: 'notice', turnId: 't1', kind: 'turn-failed', detail: 'The model does not exist.' },
  { type: 'notice', kind: 'start-failed', step: 'reopen' },
  { type: 'turn-ended', turnId: 't1', outcome: 'failed', reported: false, failure: 'connection-lost' },
  { type: 'question-raised', turnId: 't1', requestId: 'request-1', sourceId: 'toolu_1', questions: [{ text: 'Which file?', header: 'File', options: [{ label: 'notes-1.txt', description: 'The first note' }, { label: 'notes-2.txt', description: null }], multiple: false, freeText: true, secret: false }], cut: false },
  { type: 'question-resolved', requestId: 'request-1', reason: 'withdrawn' },
];

describe('the normalized agent events (V2)', () => {
  it.each(EVENTS.map((event) => [event.type, event] as const))('%s passes its schema', (_type, event) => {
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it('cover every member of the union, and every notice kind is one', () => {
    expect(new Set(EVENTS.map((event) => event.type))).toEqual(new Set(['session-started', 'turn-started', 'message', 'message-delta', 'activity-started', 'activity-ended', 'action-changed', 'worker-started', 'worker-progressed', 'worker-ended', 'in-force', 'notice', 'turn-ended', 'question-raised', 'question-resolved']));
    for (const kind of NOTICE_KINDS) expect(AgentEventSchema.safeParse({ type: 'notice', kind }).success).toBe(true);
  });

  it('refuse an unknown event, an unknown field, and anything for approvals, plans or the deltas of anything but a message (C9; M19, S2)', () => {
    for (const type of ['approval-requested', 'question-asked', 'plan-updated', 'file-changed', 'reasoning-delta', 'plan-delta', 'output-delta', 'thread-started']) {
      expect(AgentEventSchema.safeParse({ type, turnId: 't1' }).success).toBe(false);
    }
    expect(AgentEventSchema.safeParse({ type: 'turn-started', turnId: 't1', threadId: 'x' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'message', turnId: 't1', role: 'assistant', itemId: 'i', phase: 'final', text: 'x', frame: {} }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'worker-started', workerId: 'w', agentPath: '/root/x' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'turn-ended', turnId: 't1', outcome: 'stopped', reported: false }).success).toBe(false);
  });

  it('bound every string', () => {
    const long = (n: number): string => 'x'.repeat(n);
    const message = (patch: object): unknown => ({ type: 'message', turnId: 't1', role: 'assistant', itemId: 'i', phase: 'final', text: 'x', ...patch });
    const refused: unknown[] = [
      { type: 'session-started', reference: long(MAX_REFERENCE + 1), folder: '/p' },
      { type: 'session-started', reference: 'r', folder: long(4097) },
      { type: 'session-started', reference: 'r\u0000', folder: '/p' },
      { type: 'turn-started', turnId: long(129) },
      { type: 'turn-started', turnId: '' },
      message({ text: long(MAX_MESSAGE_TEXT + 1) }),
      message({ itemId: long(MAX_AGENT_ID + 1) }),
      message({ itemId: 'a\nb' }),
      message({ clientId: long(MAX_AGENT_ID + 1) }),
      message({ questions: Array.from({ length: MAX_QUESTIONS + 1 }, () => ({ title: 't', options: [] })) }),
      message({ questions: [{ title: 't', options: Array.from({ length: MAX_OPTIONS + 1 }, () => 'o') }] }),
      message({ questions: [{ title: long(MAX_QUESTION_TEXT + 1), options: [] }] }),
      message({ questions: [{ title: 't', options: [long(MAX_QUESTION_TEXT + 1)] }] }),
      { type: 'action-changed', turnId: 't1', kind: 'reading', line: long(MAX_LINE_INPUT + 1) },
      { type: 'action-changed', turnId: 't1', kind: 'reading', file: long(MAX_LINE_INPUT + 1) },
      { type: 'action-changed', turnId: 't1', kind: 'sleeping' },
      { type: 'worker-started', workerId: long(MAX_AGENT_ID + 1) },
      { type: 'worker-started', workerId: 'w', description: long(MAX_LINE_INPUT + 1) },
      { type: 'notice', kind: 'turn-failed', detail: long(MAX_NOTICE_DETAIL + 1) },
      { type: 'notice', kind: 'something-else' },
      { type: 'in-force', turnId: 't1', model: long(129) },
    ];
    for (const event of refused) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 80)).toBe(false);
    // At the bound, each passes.
    expect(AgentEventSchema.safeParse(message({ text: long(MAX_MESSAGE_TEXT), itemId: long(MAX_AGENT_ID) })).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'notice', kind: 'turn-failed', detail: long(MAX_NOTICE_DETAIL) }).success).toBe(true);
  });

  it('accepts only closed, bounded waiting metadata, without provider prose or target ids', () => {
    const event = { type: 'action-changed', turnId: 't1', kind: 'waiting' };
    for (const wait of [{ reason: 'subagents' }, { reason: 'subagents', count: 1 }, { reason: 'subagents', count: 256 }, { reason: 'provider' }]) {
      expect(AgentEventSchema.safeParse({ ...event, wait }).success).toBe(true);
    }
    for (const wait of [{ reason: 'retry' }, { reason: 'subagents', count: 0 }, { reason: 'subagents', count: 257 }, { reason: 'subagents', count: 1.5 }, { reason: 'provider', count: 1 }, { reason: 'subagents', name: 'private task' }, { reason: 'subagents', targets: ['private-id'] }]) {
      expect(AgentEventSchema.safeParse({ ...event, wait }).success).toBe(false);
    }
  });

  it('carry, since version twelve, a context reading of bounded counts and clean labels, with nothing else (decision 0033)', () => {
    expect(AGENT_EVENTS_VERSION).toBe(14);
    const reading = { used: 23_605, window: 1_000_000, compactAt: 967_000, parts: [{ label: 'System prompt', tokens: 3_183 }, { label: 'MCP tools (deferred)', tokens: 0 }], messages: { toolCalls: 1, toolResults: 2, answers: 3, prompts: 4, attachments: 0, other: 0 }, lastCall: { input: 4, cacheRead: 23_000, cacheWrite: 120, output: 8 }, calls: { input: 9, output: 3, reasoning: 1 } };
    expect(AgentEventSchema.parse({ type: 'context', reading })).toEqual({ type: 'context', reading });
    // Only the count and the window are needed; a null threshold is the CLI's word that it compacts nothing.
    expect(AgentEventSchema.safeParse({ type: 'context', reading: { used: 0, window: 1 } }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'context', reading: { used: 5, window: 10, compactAt: null } }).success).toBe(true);
    for (const bad of [
      { ...reading, used: -1 },
      { ...reading, used: 1.5 },
      { ...reading, window: 0 },
      { ...reading, window: MAX_CONTEXT_TOKENS + 1 },
      { ...reading, compactAt: 0 },
      { ...reading, parts: Array.from({ length: MAX_CONTEXT_PARTS + 1 }, () => ({ label: 'Messages', tokens: 1 })) },
      { ...reading, parts: [{ label: 'x'.repeat(MAX_CONTEXT_LABEL + 1), tokens: 1 }] },
      { ...reading, parts: [{ label: 'C:\\Users\\me\\CLAUDE.md', tokens: 1 }] },
      { ...reading, parts: [{ label: 'Memory\nfiles', tokens: 1 }] },
      { ...reading, parts: [{ label: '', tokens: 1 }] },
      { ...reading, lastCall: { input: 1 } },
      { ...reading, model: 'opus' },
    ]) expect(AgentEventSchema.safeParse({ type: 'context', reading: bad }).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'context', reading, sessionId: 'x' }).success).toBe(false);
  });

  it('carry, since version eleven, a change of whether a message can go into the running turn, with nothing else', () => {
    expect(AgentEventSchema.safeParse({ type: 'steer-changed' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'steer-changed', state: 'open' }).success).toBe(false);
  });

  it('carry, since version ten, the model a sub-agent runs on and its agent definition, at its start and once it spoke (M106, C14, C20, C38)', () => {
    const started = { type: 'worker-started', workerId: 'w1', description: 'Reads a file', model: 'haiku', agentType: 'general-purpose' };
    expect(AgentEventSchema.parse(started)).toEqual(started);
    expect(AgentEventSchema.safeParse({ type: 'worker-model', workerId: 'w1', model: 'claude-haiku-4-5-20251001' }).success).toBe(true);
    // A worker item's start names them too, and an activity's history may.
    expect(AgentEventSchema.safeParse({ type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'worker', name: 'Agent', summary: 'Reads a file', model: 'opus', agentType: 'Explore', pairedWorkerId: 'w1' }).success).toBe(true);
    for (const event of [
      { ...started, model: '' },
      { ...started, model: 'x'.repeat(129) },
      { ...started, model: 'a\nb' },
      { ...started, agentType: 'x'.repeat(MAX_LINE_INPUT + 1) },
      { type: 'worker-model', workerId: 'w1' },
      { type: 'worker-model', workerId: 'w1', model: '' },
      { type: 'worker-model', workerId: 'w1', model: 'm', agentType: 'Explore' },
      { type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'worker', name: 'Agent', summary: 's', model: '' },
    ]) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 80)).toBe(false);
  });

  it('carry, since version seven, a question asked as a request, with its questions bounded, and what became of one, by its reasons (M21, C20, C63)', () => {
    const asked = { text: 'Which file?', header: null, options: [{ label: 'a', description: null }], multiple: true, freeText: false, secret: false };
    const raised = { type: 'question-raised', turnId: 't1', requestId: 'request-1', sourceId: 'item-1', questions: [asked], cut: true };
    expect(AgentEventSchema.safeParse(raised).success).toBe(true);
    // A worker's names its worker, and the turn that started it.
    expect(AgentEventSchema.safeParse({ ...raised, workerId: 'worker-1' }).success).toBe(true);
    for (const patch of [
      { questions: [] },
      { questions: Array.from({ length: MAX_QUESTIONS + 1 }, () => asked) },
      { questions: [{ ...asked, text: 'x'.repeat(MAX_QUESTION_TEXT + 1) }] },
      { questions: [{ ...asked, options: Array.from({ length: MAX_OPTIONS + 1 }, () => ({ label: 'a', description: null })) }] },
      { questions: [{ ...asked, key: 'the provider’s own' }] },
      { requestId: '' },
      { requestId: 'x'.repeat(MAX_AGENT_ID + 1) },
      { sourceId: 'a' + String.fromCharCode(10) + 'b' },
      { cut: undefined },
      // A question is no aside's: an aside takes no request.
      { asideId: 'aside-1' },
      // And it carries no raw request: the adapter keeps that.
      { input: { questions: [] } },
    ]) expect(AgentEventSchema.safeParse({ ...raised, ...patch }).success, JSON.stringify(Object.keys(patch))).toBe(false);
    // The fourth is M22's (C91): the request came again under its id with another payload.
    expect(QUESTION_RESOLUTIONS).toEqual(['withdrawn', 'dropped', 'confirmed', 'changed']);
    for (const reason of QUESTION_RESOLUTIONS) expect(AgentEventSchema.safeParse({ type: 'question-resolved', requestId: 'request-1', reason }).success, reason).toBe(true);
    for (const event of [{ type: 'question-resolved', requestId: 'request-1', reason: 'expired' }, { type: 'question-resolved', requestId: 'request-1' }, { type: 'question-resolved', requestId: 'request-1', reason: 'dropped', turnId: 't1' }]) expect(AgentEventSchema.safeParse(event).success).toBe(false);
  });

  it('keep version six: each event an aside may tell passes with and without its id, a message with and without its model, and a turn may end with no answer (M20b, C8, C24, C25)', () => {
    const told: Record<string, unknown>[] = [
      { type: 'turn-started', turnId: 't1' },
      { type: 'message', turnId: 't1', role: 'assistant', itemId: 'item-1', phase: 'final', text: 'An answer.' },
      { type: 'message-delta', turnId: 't1', itemId: 'item-1', phase: 'final', text: 'An' },
      { type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'read', name: 'read', summary: 'Read a file' },
      { type: 'activity-ended', turnId: 't1', itemId: 'a1', status: 'completed' },
      { type: 'notice', turnId: 't1', kind: 'no-answer' },
      { type: 'turn-ended', turnId: 't1', outcome: 'completed', reported: true },
    ];
    expect(told.map((event) => event['type'])).toEqual(['turn-started', 'message', 'message-delta', 'activity-started', 'activity-ended', 'notice', 'turn-ended']);
    for (const event of told) {
      expect(AgentEventSchema.safeParse(event).success, String(event['type'])).toBe(true);
      expect(AgentEventSchema.safeParse({ ...event, asideId: 'aside-1' }).success, `${String(event['type'])} of an aside`).toBe(true);
      // An id as any other: bounded, with no control character, and never empty.
      for (const asideId of ['', 'a' + String.fromCharCode(10) + 'b', 'x'.repeat(MAX_AGENT_ID + 1)]) expect(AgentEventSchema.safeParse({ ...event, asideId }).success, `${String(event['type'])}: ${asideId.length}`).toBe(false);
    }
    // No other event is an aside's: a worker's, a reference's and a plan's are the session's alone.
    for (const event of [{ type: 'worker-started', workerId: 'w1' }, { type: 'session-started', reference: 'r', folder: 'f' }, { type: 'in-force', turnId: 't1', model: 'm', effort: null }]) {
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
      expect(AgentEventSchema.safeParse({ ...event, asideId: 'aside-1' }).success, event.type).toBe(false);
    }
    // The model that wrote a message, where its provider named one other than the session's (C7).
    const message = told[1] as Record<string, unknown>;
    expect(AgentEventSchema.safeParse({ ...message, model: 'another-model' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...message, model: '' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...told[2], model: 'another-model' }).success).toBe(false);
    expect(NOTICE_KINDS).toContain('no-answer');
  });

  it('keep version five’s deltas: a message may arrive in them, by its turn, its item id, its phase so far and the text to append (M19, C3)', () => {
    const delta = { type: 'message-delta', turnId: 't1', itemId: 'item-1', phase: 'commentary', text: 'Hel' };
    expect(AgentEventSchema.safeParse(delta).success).toBe(true);
    // The first one for an id opens its message, and may carry no text; a provider that labels no phase says null.
    expect(AgentEventSchema.safeParse({ ...delta, text: '', phase: null }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...delta, text: 'x'.repeat(MAX_MESSAGE_TEXT) }).success).toBe(true);
    // Bounded as a message is, and strict: no role, no cut flag, no frame.
    expect(AgentEventSchema.safeParse({ ...delta, text: 'x'.repeat(MAX_MESSAGE_TEXT + 1) }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...delta, itemId: 'a\nb' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...delta, itemId: '' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...delta, phase: 'thinking' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...delta, role: 'assistant' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...delta, cut: true }).success).toBe(false);
    const { turnId: _turn, ...noTurn } = delta;
    expect(AgentEventSchema.safeParse(noTurn).success).toBe(false);
    // The whole message is unchanged in shape: it completes a message its deltas opened, or stands alone (C4).
    expect(AgentEventSchema.safeParse({ type: 'message', turnId: 't1', role: 'assistant', itemId: 'item-1', phase: 'commentary', text: 'Hello' }).success).toBe(true);
  });

  it('keep version three’s fields: a turn’s end may name its answer, and a start may be found overruled or leave a folder out (M16, C74, C78)', () => {
    const end = { type: 'turn-ended', turnId: 't1', outcome: 'completed', reported: true };
    expect(AgentEventSchema.safeParse({ ...end, answerItemId: 'item-9' }).success).toBe(true);
    // An id of the provider's, bounded as every other: no control character, and not over its length.
    expect(AgentEventSchema.safeParse({ ...end, answerItemId: 'a\nb' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...end, answerItemId: 'x'.repeat(MAX_AGENT_ID + 1) }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...end, answerItemId: '' }).success).toBe(false);
    expect([...NOTICE_KINDS]).toEqual(expect.arrayContaining(['folder-not-passed', 'start-overruled']));
    expect([...TURN_FAILURES]).toContain('start-overruled');
    expect(AgentEventSchema.safeParse({ type: 'turn-ended', turnId: 't1', outcome: 'failed', reported: false, failure: 'start-overruled' }).success).toBe(true);
    // A folder left out is a kind and nothing else: a notice has no place for a path.
    expect(AgentEventSchema.safeParse({ type: 'notice', kind: 'folder-not-passed' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'notice', kind: 'folder-not-passed', folder: 'C:\\project' }).success).toBe(false);
  });

  it('keep version two’s fields: a turn’s start may name the provider’s id, and its end says whether the provider reported it (M18, C47, C59)', () => {
    expect(AgentEventSchema.safeParse({ type: 'turn-started', turnId: 't1' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'turn-started', turnId: 't1', providerTurnId: 'a\nb' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'turn-ended', turnId: 't1', outcome: 'completed', reported: true }).success).toBe(true);
    // An end that does not say whose it is is no end.
    expect(AgentEventSchema.safeParse({ type: 'turn-ended', turnId: 't1', outcome: 'completed' }).success).toBe(false);
  });

  it('take a history message with its turn’s id and, for a user’s, the id it was sent with (M18, C47)', () => {
    expect(HistoryMessageSchema.safeParse({ role: 'user', itemId: 'i', phase: null, text: 'q', at: null, turnId: 't', clientId: 'c' }).success).toBe(true);
    expect(HistoryMessageSchema.safeParse({ role: 'assistant', itemId: 'i', phase: 'final', text: 'a', at: 5, cut: true, turnId: 't' }).success).toBe(true);
    expect(HistoryMessageSchema.safeParse({ role: 'assistant', itemId: 'i', phase: 'final', text: 'a', at: 5 }).success).toBe(false);
    expect(HistoryMessageSchema.safeParse({ role: 'assistant', itemId: 'i', phase: 'final', text: 'a', at: 5, turnId: 't', frame: {} }).success).toBe(false);
  });

  it('take a history turn with the provider’s outcome and times, each null when unknown (M18, C51)', () => {
    expect(HistoryTurnSchema.safeParse({ turnId: 't', outcome: 'completed', startedAt: 1, endedAt: 2, durationMs: 1 }).success).toBe(true);
    expect(HistoryTurnSchema.safeParse({ turnId: 't', outcome: null, startedAt: null, endedAt: null, durationMs: null }).success).toBe(true);
    expect(HistoryTurnSchema.safeParse({ turnId: 't', outcome: 'stopped', startedAt: null, endedAt: null, durationMs: null }).success).toBe(false);
    expect(HistoryTurnSchema.safeParse({ turnId: 't', outcome: null, startedAt: 1.5, endedAt: null, durationMs: null }).success).toBe(false);
  });
});

describe('the cut (C113)', () => {
  it('leaves a string at its bound alone, and cuts a longer one to it', () => {
    expect(cutTo('abc', 3)).toEqual({ text: 'abc', cut: false });
    expect(cutTo('abcd', 3)).toEqual({ text: 'abc', cut: true });
    expect(cutTo('', 3)).toEqual({ text: '', cut: false });
  });

  it('never splits a surrogate pair', () => {
    const text = 'ab😀cd';
    expect(cutTo(text, 3)).toEqual({ text: 'ab', cut: true });
    expect(cutTo(text, 4)).toEqual({ text: 'ab😀', cut: true });
    // No cut ends on a lone high surrogate.
    for (let max = 1; max <= text.length; max++) expect(cutTo(text, max).text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('takes the first line that holds anything, at what M14’s events take', () => {
    expect(cutLine('\n  \nfirst line\nsecond')).toBe('first line');
    expect(cutLine('x'.repeat(MAX_LINE_INPUT + 50))).toHaveLength(MAX_LINE_INPUT);
    expect(cutLine('')).toBe('');
  });
});

describe('what a session does between its messages (M20a, V2; C59)', () => {
  const started = { type: 'activity-started', turnId: 't1', itemId: 'a1', activityType: 'command', name: 'commandExecution', summary: 'rg --files' } as const;
  const ended = { type: 'activity-ended', turnId: 't1', itemId: 'a1', status: 'completed' } as const;
  const ok = (event: unknown): boolean => AgentEventSchema.safeParse(event).success;

  it('takes a start with its type, name and line alone, and an end with its status alone', () => {
    expect(ok(started)).toBe(true);
    expect(ok(ended)).toBe(true);
  });

  it('takes a start with everything a start may say: input, files, an edit’s changes, a checklist’s steps, a thinking, a cut and the provider’s time', () => {
    expect(ok({
      ...started, input: 'rg --files', files: [{ path: 'a.md', line: null }], changes: [{ path: 'a.md', kind: 'write', text: 'hello' }], steps: [{ text: 'one', state: 'in-progress' }], thinking: 'a thought',
      cut: { fields: ['input'], output: null, files: 0, steps: 0, changes: 0 }, providerAt: 5,
    })).toBe(true);
  });

  it('takes an end with its output, exit code, changes, steps, thinking, cut, time and duration, a zero included', () => {
    expect(ok({ ...ended, output: 'out', exitCode: -1, changes: [], steps: [{ text: 'one', state: 'completed' }], thinking: '', cut: { fields: ['output'], output: { omitted: 9, at: 10_000 }, files: 0, steps: 0, changes: 0 }, providerAt: 9, durationMs: 0 })).toBe(true);
  });

  it('is a closed type list, and a closed end: a type fat-g does not know, a plan among them, fails, and so does an end that is neither completed nor failed', () => {
    expect(ok({ ...started, activityType: 'plan' })).toBe(false);
    expect(ok({ ...started, activityType: 'tool' })).toBe(false);
    expect(ok({ ...ended, status: 'unfinished' })).toBe(false);
    expect(ok({ ...ended, status: 'running' })).toBe(false);
  });

  it('is strict: a field it does not name fails, a command line under another name among them', () => {
    expect(ok({ ...started, command: 'rm -rf ~' })).toBe(false);
    expect(ok({ ...ended, input: 'late' })).toBe(false);
    expect(ok({ ...started, files: [{ path: 'a', line: null, cwd: 'C:\\Users\\someone' }] })).toBe(false);
  });

  it('fails a string past its bound, which an adapter cuts first', () => {
    expect(ok({ ...started, input: 'x'.repeat(MAX_ACTIVITY_INPUT + 1) })).toBe(false);
    expect(ok({ ...ended, output: 'x'.repeat(MAX_ACTIVITY_OUTPUT + 1) })).toBe(false);
    expect(ok({ ...started, steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ text: 's', state: 'pending' })) })).toBe(false);
  });

  it('carries a worker’s id on each of the four events that may name one (C20)', () => {
    const named: readonly AgentEvent[] = [
      { type: 'message', turnId: 't1', role: 'assistant', itemId: 'i9', phase: 'final', text: 'The file holds one line.', workerId: 'w1' },
      { type: 'message-delta', turnId: 't1', itemId: 'i9', phase: 'final', text: 'The file', workerId: 'w1' },
      { ...started, workerId: 'w1' },
      { ...ended, workerId: 'w1' },
    ];
    for (const event of named) expect(AgentEventSchema.parse(event)).toEqual(event);
    // An id that is no id fails, as an item's does.
    for (const event of named) expect(ok({ ...event, workerId: '' }), event.type).toBe(false);
    for (const event of named) expect(ok({ ...event, workerId: 'x'.repeat(MAX_AGENT_ID + 1) }), event.type).toBe(false);
  });

  it('names the worker a worker item started apart from whose item it is (C23)', () => {
    expect(ok({ ...started, activityType: 'worker', pairedWorkerId: 'w1' })).toBe(true);
    expect(ok({ ...started, activityType: 'worker', pairedWorkerId: '' })).toBe(false);
    // No other event carries one.
    expect(ok({ ...ended, pairedWorkerId: 'w1' })).toBe(false);
  });

  it('a start carries a checklist’s steps, and a second one for the same item passes the same schema: what it replaces is main’s to do (C59)', () => {
    const first = { ...started, itemId: 'turn-1#plan', activityType: 'checklist', name: 'plan', summary: 'Tasks', steps: [{ text: 'one', state: 'in-progress' }, { text: 'two', state: 'pending' }] } as const;
    const second = { ...first, steps: [{ text: 'one', state: 'completed' }, { text: 'two', state: 'in-progress' }] } as const;
    expect(ok(first)).toBe(true);
    expect(ok(second)).toBe(true);
  });
});

describe('an activity read from history (M20a; C19)', () => {
  const activity = { turnId: 'provider-turn-1', itemId: 'a1', activityType: 'command', name: 'commandExecution', summary: 'ls', status: 'completed', at: null, order: 2 } as const;

  it('is what its two events carry, as one, with its place in its turn and no start time of its own', () => {
    expect(HistoryActivitySchema.safeParse(activity).success).toBe(true);
    expect(HistoryActivitySchema.safeParse({ ...activity, input: 'ls', output: 'a\nb', exitCode: 0, durationMs: 0, files: [{ path: 'a', line: null }], at: 1_579_924_800_000 }).success).toBe(true);
  });

  it('may read unfinished, which no live end does, and never running', () => {
    expect(HistoryActivitySchema.safeParse({ ...activity, status: 'unfinished' }).success).toBe(true);
    expect(HistoryActivitySchema.safeParse({ ...activity, status: 'running' }).success).toBe(false);
  });

  it('needs its place, and a message of such a history may name one', () => {
    const { order: _order, ...unplaced } = activity;
    expect(HistoryActivitySchema.safeParse(unplaced).success).toBe(false);
    const message = { role: 'assistant', itemId: 'i1', phase: 'final', text: 'Done.', turnId: 'provider-turn-1', at: null } as const;
    expect(HistoryMessageSchema.safeParse({ ...message, order: 3 }).success).toBe(true);
    expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
    expect(HistoryMessageSchema.safeParse({ ...message, order: -1 }).success).toBe(false);
  });

describe('a plan (M22b, V3; C9, C10, C14, C56, C61)', () => {
  it('is raised with its whole text, written as deltas and completed whole, its text bounded by the line alone', () => {
    const text = 'p'.repeat(MAX_MESSAGE_TEXT + 1);
    expect(AgentEventSchema.safeParse({ type: 'plan-raised', turnId: 't1', requestId: 'request-1', sourceId: 'tool-1', text }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'plan-delta', turnId: 't1', itemId: 'plan-1', text: '' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'plan-completed', turnId: 't1', itemId: 'plan-1', text }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'plan-completed', turnId: 't1', itemId: 'plan-1', text: 'p'.repeat(4 * 1024 * 1024 + 1) }).success).toBe(false);
    for (const reason of QUESTION_RESOLUTIONS) expect(AgentEventSchema.safeParse({ type: 'plan-resolved', requestId: 'request-1', reason }).success).toBe(true);
    // A plan is no worker's and no aside's: the turn's alone.
    expect(AgentEventSchema.safeParse({ type: 'plan-raised', turnId: 't1', requestId: 'r', sourceId: 's', text: 'x', workerId: 'w' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'plan-delta', turnId: 't1', itemId: 'p', text: 'x', asideId: 'a' }).success).toBe(false);
  });

  it('has two notices of its own: no plan reached fat-g, and one too large to receive', () => {
    expect(NOTICE_KINDS).toEqual(expect.arrayContaining(['plan-missing', 'plan-too-large']));
  });
});
});
