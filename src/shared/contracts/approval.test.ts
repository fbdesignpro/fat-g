// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V9, V22, V27 (docs/planning/_archive/M22.md; C8, C9, C12, C13, C48, C56, C57, C76, C77, C91, C92): an
// approval as the contract has it — the request and its bounds, the copy the store keeps, the body
// read by its kind, the events that carry one, and fat-g's words for it.
import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATUSES, DECLINED_BY, endedBody, ENDED_STATUSES, HISTORY_STATUSES, isEnded, startedBody } from './activity';
import { AGENT_EVENTS_VERSION, AgentEventSchema, HistoryActivitySchema, NOTICE_KINDS, REFUSED_BOUNDS, REQUEST_RESOLUTIONS, TURN_FAILURES } from './agent-events';
import { blockWords, ChatDecideRequestSchema, ChatSetModeRequestSchema, DECIDE_REFUSALS, mebibytes, noticeWords, SET_MODE_REFUSALS } from './chat';
import { type ConversationItem, itemUnits } from './conversation';
import {
  APPROVAL_CHOICES,
  APPROVAL_OUTCOMES,
  APPROVAL_WORDS,
  type ApprovalBody,
  approvalOf,
  approvalOverBound,
  type ApprovalRequest,
  ApprovalRequestSchema,
  approvalUnits,
  approvalWords,
  askWords,
  authorityWords,
  CHOICE_OUTCOMES,
  grantSent,
  interactionUnits,
  isDecided,
  isSettled,
  MAX_APPROVAL_CHANGE_UNITS,
  MAX_APPROVAL_CHOICES,
  MAX_APPROVAL_DETAIL,
  MAX_APPROVAL_PATH,
  MAX_APPROVAL_TARGETS,
  outcomeWords,
  questionOf,
  raisedApproval,
  raisedBody,
  readInteraction,
  storedRequest,
  WITHDRAWN_BY,
} from './interaction';
import { ACTION_KINDS, actionLabel, isModeBlock, SEND_BLOCKS, SessionEventSchema } from './sessions';

const long = (length: number): string => 'x'.repeat(length);
const COMMAND: ApprovalRequest = {
  kind: 'command', tool: 'Bash', summary: 'touch notes.txt', folder: 'D:\\Code\\fat-g', targets: ['D:\\Code\\fat-g\\notes.txt'], outside: false, reason: 'To make the note.', authority: [{ kind: 'mode', mode: 'edits-ok' }],
  detail: { kind: 'command', command: 'touch notes.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' }, modeThatWouldStop: null, cut: false,
};
const change = (path: string, text: string | null, patch: Partial<{ replace: string | null; all: boolean | null }> = {}) => ({ path, kind: 'update' as const, text, replace: null, all: null, ...patch });
const CHANGE: ApprovalRequest = { ...COMMAND, kind: 'file-change', tool: 'Edit', choices: ['approve', 'deny'], grant: null, detail: { kind: 'changes', changes: [change('a.txt', 'new', { replace: 'old', all: false })] } };
const withDetail = (detail: ApprovalRequest['detail']): ApprovalRequest => ({ ...CHANGE, detail });

describe('a request, as an event may carry it (V3; C8, C9, C48)', () => {
  it('passes whole, a command’s, a change’s and a tool’s', () => {
    expect(ApprovalRequestSchema.safeParse(COMMAND).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse(CHANGE).success).toBe(true);
    expect(ApprovalRequestSchema.safeParse({ ...CHANGE, kind: 'tool', tool: 'mcp__notes__add', detail: { kind: 'input', text: '{"title":"x"}' }, folder: null, targets: [] }).success).toBe(true);
    // A file change of a million units, its parts counted together, is within its bound (C48).
    const half = MAX_APPROVAL_CHANGE_UNITS / 2;
    expect(ApprovalRequestSchema.safeParse(withDetail({ kind: 'changes', changes: [change('a.txt', long(half), { replace: long(half), all: true })] })).success).toBe(true);
  });

  it.each<[string, Partial<ApprovalRequest> | Record<string, unknown>]>([
    ['more than 32 targets', { targets: Array.from({ length: MAX_APPROVAL_TARGETS + 1 }, (_, n) => `f${n}`) }],
    ['a path over its bound', { targets: [long(MAX_APPROVAL_PATH + 1)] }],
    ['a command over its bound', { detail: { kind: 'command', command: long(MAX_APPROVAL_DETAIL + 1) } }],
    ['a change over its bound, its parts together', { detail: { kind: 'changes', changes: [change('a.txt', long(MAX_APPROVAL_CHANGE_UNITS), { replace: 'x', all: false })] } }],
    ['a change with no file', { detail: { kind: 'changes', changes: [] } }],
    ['no way to approve it', { choices: ['deny'] }],
    ['a choice twice', { choices: ['approve', 'approve', 'deny'] }],
    ['the session’s choice with no grant behind it', { choices: ['approve', 'approve-session', 'deny'], grant: null }],
    ['a grant with no choice for it', { choices: ['approve', 'deny'], grant: { covers: 'x' } }],
    ['a choice fat-g does not have', { choices: ['approve', 'deny', 'always'] }],
    ['a native word for a mode', { modeThatWouldStop: 'acceptEdits' }],
    ['a copy said cut', { cut: true }],
    ['a raw request beside it', { input: { command: 'x' } }],
  ])('refuses %s', (_name, patch) => {
    expect(ApprovalRequestSchema.safeParse({ ...COMMAND, ...patch }).success).toBe(false);
  });

  it('names the bound a request is past, with its size, so its adapter refuses it and never shows it cut (C9, C48)', () => {
    expect(approvalOverBound(COMMAND)).toBeNull();
    expect(approvalOverBound({ ...COMMAND, targets: Array.from({ length: 40 }, (_, n) => `f${n}`) })).toEqual({ bound: 'targets', size: 40 });
    expect(approvalOverBound({ ...COMMAND, choices: Array.from({ length: MAX_APPROVAL_CHOICES + 1 }, () => 'approve' as const) })).toEqual({ bound: 'choices', size: 17 });
    expect(approvalOverBound({ ...COMMAND, detail: { kind: 'command', command: long(MAX_APPROVAL_DETAIL + 1) } })).toEqual({ bound: 'detail', size: MAX_APPROVAL_DETAIL + 1 });
    expect(approvalOverBound(withDetail({ kind: 'input', text: long(MAX_APPROVAL_DETAIL + 1) }))).toEqual({ bound: 'detail', size: MAX_APPROVAL_DETAIL + 1 });
    expect(approvalOverBound(withDetail({ kind: 'changes', changes: [change('a.txt', long(MAX_APPROVAL_CHANGE_UNITS + 1))] }))).toEqual({ bound: 'detail', size: MAX_APPROVAL_CHANGE_UNITS + 1 });
    expect(approvalOverBound(withDetail({ kind: 'changes', changes: Array.from({ length: 33 }, (_, n) => change(`f${n}`, 'x')) }))).toEqual({ bound: 'targets', size: 33 });
    // A path is never cut: a cut one would name another file.
    expect(approvalOverBound(withDetail({ kind: 'changes', changes: [change(long(MAX_APPROVAL_PATH + 1), 'x')] }))).toEqual({ bound: 'path', size: MAX_APPROVAL_PATH + 1 });
    expect(approvalOverBound({ ...COMMAND, folder: long(MAX_APPROVAL_PATH + 1) })).toEqual({ bound: 'path', size: MAX_APPROVAL_PATH + 1 });
  });
});

describe('the copy the store keeps (V22; C48, C77)', () => {
  it('is the request as it is, where nothing passes an activity’s bounds', () => {
    expect(storedRequest(COMMAND)).toEqual(COMMAND);
  });

  it('cuts a command and an input at 10,000 units, a change’s each text at 20,000 and its changes at 20, and says cut', () => {
    const command = storedRequest({ ...COMMAND, detail: { kind: 'command', command: long(MAX_APPROVAL_DETAIL) } });
    expect(command).toMatchObject({ cut: true, detail: { kind: 'command' } });
    expect(command.detail.kind === 'command' ? command.detail.command.length : 0).toBe(10_000);
    const input = storedRequest(withDetail({ kind: 'input', text: long(10_001) }));
    expect(input.cut).toBe(true);
    expect(input.detail.kind === 'input' ? input.detail.text.length : 0).toBe(10_000);
    const changes = storedRequest(withDetail({ kind: 'changes', changes: Array.from({ length: 21 }, (_, n) => change(`f${n}`, long(n === 0 ? 20_001 : 5), { replace: long(n === 1 ? 20_001 : 5), all: true })) }));
    expect(changes.cut).toBe(true);
    const kept = changes.detail.kind === 'changes' ? changes.detail.changes : [];
    expect(kept).toHaveLength(20);
    expect([kept[0]?.text?.length, kept[1]?.replace?.length, kept[0]?.all]).toEqual([20_000, 20_000, true]);
    // Twenty-one short changes lose one, and say so.
    expect(storedRequest(withDetail({ kind: 'changes', changes: Array.from({ length: 21 }, (_, n) => change(`f${n}`, 'x')) })).cut).toBe(true);
  });

  it('counts a request by its strings, the kept copy’s being what a page counts (C36)', () => {
    expect(approvalUnits(COMMAND)).toBe('Bash'.length + 'touch notes.txt'.length * 2 + 'D:\\Code\\fat-g'.length + 'D:\\Code\\fat-g\\notes.txt'.length + 'To make the note.'.length + 'Bash(touch notes.txt)'.length);
    const body = raisedApproval(withDetail({ kind: 'changes', changes: [change('a.txt', long(100_000))] }));
    expect(interactionUnits(body)).toBeLessThan(21_000);
    const item = { blocks: [], questions: [], detail: null, activity: null, interaction: body } as unknown as ConversationItem;
    expect(itemUnits(item)).toBe(interactionUnits(body));
  });
});

describe('the body, by its kind (V22; C77)', () => {
  it('is pending at its raising, with nothing decided, delivered, confirmed or granted', () => {
    expect(raisedApproval(COMMAND)).toEqual({ kind: 'approval', request: COMMAND, outcome: 'pending', decidedAt: null, settledAt: null, delivered: null, confirmedAt: null, withdrawnBy: null, grant: null });
    expect(APPROVAL_OUTCOMES).toEqual(['pending', 'approved', 'approved-session', 'denied', 'withdrawn', 'dropped']);
    expect(APPROVAL_CHOICES.map((choice) => CHOICE_OUTCOMES[choice])).toEqual(['approved', 'approved-session', 'denied']);
    expect(APPROVAL_OUTCOMES.filter(isDecided)).toEqual(['approved', 'approved-session', 'denied']);
    expect(APPROVAL_OUTCOMES.filter((outcome) => !isSettled(outcome))).toEqual(['pending']);
  });

  it('is read by its kind, and a body that names none is a question’s, as every one written before M22 is', () => {
    const question = raisedBody('blocking', [{ text: 'Which?', header: null, options: [{ label: 'a', description: null }], multiple: false, freeText: false, secret: false }], false);
    const { kind: _kind, ...unnamed } = question;
    expect(readInteraction(unnamed)).toEqual(question);
    expect(readInteraction({ ...unnamed, kind: 'a-later-kind' })).toMatchObject({ kind: 'question' });
    const stored = JSON.parse(JSON.stringify({ ...raisedApproval(COMMAND), outcome: 'approved-session', decidedAt: 5, delivered: true, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k' } })) as unknown;
    const read = readInteraction(stored);
    expect(read).toMatchObject({ kind: 'approval', request: COMMAND, outcome: 'approved-session', decidedAt: 5, delivered: true, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k', live: false } });
    expect(approvalOf({ interaction: read })).not.toBeNull();
    expect(questionOf({ interaction: read })).toBeNull();
    expect(approvalOf({ interaction: question })).toBeNull();
    expect(approvalOf({ interaction: null })).toBeNull();
  });

  it('reads the keys it knows and fails for none it does not: an outcome it does not know claims nothing', () => {
    const read = readInteraction({ kind: 'approval', outcome: 'a-later-outcome', request: { kind: 'odd', targets: ['a', 4], choices: ['approve', 'later'], authority: [{ kind: 'odd' }, 'x'], detail: { kind: 'odd' } }, grant: { covers: 4 }, later: true }) as ApprovalBody;
    expect(read).toMatchObject({ kind: 'approval', outcome: 'dropped', grant: null, delivered: null, request: { kind: 'tool', targets: ['a'], choices: ['approve'], authority: [{ kind: 'other', mode: null }], detail: { kind: 'input', text: '' } } });
    // A detail this build cannot read is shown as none, and said cut.
    expect(read.request.cut).toBe(true);
    expect(readInteraction({ kind: 'approval', request: { detail: { kind: 'changes', changes: [{ path: 'a', kind: 'odd', text: 3, all: 'x' }, { nope: 1 }] } } })).toMatchObject({ request: { cut: false, detail: { kind: 'changes', changes: [{ path: 'a', kind: 'other', text: null, replace: null, all: null }] } } });
  });

  it('says a grant was sent only where its decision’s reply was delivered (C92)', () => {
    const base = { outcome: 'approved-session' as const, grant: { covers: 'x', processKey: 'k', live: true } };
    expect(grantSent({ ...base, delivered: true })).toBe(true);
    for (const delivered of [false, null]) expect(grantSent({ ...base, delivered })).toBe(false);
    expect(grantSent({ ...base, grant: null, delivered: true })).toBe(false);
    expect(grantSent({ outcome: 'approved', grant: null, delivered: true })).toBe(false);
  });
});

describe('the events, version eight (V3; C8, C76, C91)', () => {
  const raised = { type: 'approval-raised', turnId: 't1', requestId: 'n:7', sourceId: 'call_1', request: COMMAND };

  it('carry an approval’s raising with its request whole, and what became of it by a request’s four reasons', () => {
    expect(AGENT_EVENTS_VERSION).toBeGreaterThanOrEqual(8);
    expect(AgentEventSchema.safeParse(raised).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...raised, workerId: 'worker-1' }).success).toBe(true);
    for (const patch of [{ requestId: '' }, { sourceId: undefined }, { request: { ...COMMAND, cut: true } }, { request: undefined }, { asideId: 'aside-1' }, { input: {} }, { questions: [] }]) expect(AgentEventSchema.safeParse({ ...raised, ...patch }).success, JSON.stringify(Object.keys(patch))).toBe(false);
    expect(REQUEST_RESOLUTIONS).toEqual(['withdrawn', 'dropped', 'confirmed', 'changed']);
    for (const reason of REQUEST_RESOLUTIONS) expect(AgentEventSchema.safeParse({ type: 'approval-resolved', requestId: 'n:7', reason }).success, reason).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'approval-resolved', requestId: 'n:7', reason: 'approved' }).success).toBe(false);
    expect(WITHDRAWN_BY).toEqual(['request', 'turn', 'changed']);
  });

  it('name the mode a process confirmed by its id, with or without a turn, and never by a native word', () => {
    expect(AgentEventSchema.safeParse({ type: 'in-force', turnId: 't1', mode: 'ask-first' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'in-force', mode: 'edits-ok' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'in-force', turnId: 't1', mode: 'acceptEdits' }).success).toBe(false);
    // The summary's own event takes a null, which takes the mode back at the process's end.
    const session = '5e551000-0000-4000-8000-000000000001';
    expect(SessionEventSchema.safeParse({ type: 'in-force', sessionId: session, mode: null }).success).toBe(true);
    expect(SessionEventSchema.safeParse({ type: 'in-force', sessionId: session, mode: 'Ask first' }).success).toBe(false);
  });

  it('end an activity declined, with who declined it where known, live and from history (C76)', () => {
    expect(ACTIVITY_STATUSES).toContain('declined');
    expect(ENDED_STATUSES).toEqual(['completed', 'failed', 'declined']);
    expect(HISTORY_STATUSES).toContain('declined');
    const ended = { type: 'activity-ended', turnId: 't1', itemId: 'call_1', status: 'declined' };
    expect(AgentEventSchema.safeParse(ended).success).toBe(true);
    for (const declinedBy of DECLINED_BY) expect(AgentEventSchema.safeParse({ ...ended, declinedBy }).success, declinedBy).toBe(true);
    expect(AgentEventSchema.safeParse({ ...ended, declinedBy: 'reviewer' }).success).toBe(false);
    expect(HistoryActivitySchema.safeParse({ turnId: 'p1', itemId: 'call_1', activityType: 'command', name: 'commandExecution', summary: 'touch x', status: 'declined', at: null, order: 1 }).success).toBe(true);
    const started = startedBody({ type: 'command', name: 'Bash', summary: 'touch x' });
    expect(started.declinedBy).toBeNull();
    const declined = endedBody(started, { status: 'declined', declinedBy: 'user' });
    expect(declined).toMatchObject({ status: 'declined', declinedBy: 'user' });
    expect(isEnded(declined.status)).toBe(true);
    // Who declined it stands for a declined item alone.
    expect(endedBody(started, { status: 'failed', declinedBy: 'user' }).declinedBy).toBeNull();
  });

  it('have a notice for a policy the provider reported, one for a line too long to read, and a refusal that names its size', () => {
    expect(NOTICE_KINDS).toEqual(expect.arrayContaining(['policy-mismatch', 'line-too-long']));
    expect(TURN_FAILURES).toContain('policy-mismatch');
    expect(REFUSED_BOUNDS).toEqual(['targets', 'choices', 'detail', 'path', 'line']);
    expect(AgentEventSchema.safeParse({ type: 'notice', turnId: 't1', kind: 'request-refused', bound: 'detail', size: 1_048_577 }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'notice', kind: 'line-too-long', size: 6_500_000 }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'notice', kind: 'request-refused', bound: 'content', size: 4 }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ type: 'notice', kind: 'request-refused', bound: 'detail', size: -1 }).success).toBe(false);
  });
});

describe('the channels’ requests (V7; C88)', () => {
  const sessionId = '5e551000-0000-4000-8000-000000000001';

  it('take a mode by its id and a decision by the card’s item and one of fat-g’s choices, and nothing else', () => {
    expect(ChatSetModeRequestSchema.safeParse({ sessionId, mode: 'ask-first' }).success).toBe(true);
    for (const request of [{ sessionId, mode: 'acceptEdits' }, { sessionId, mode: '' }, { sessionId }, { sessionId, mode: 'ask-first', restart: false }, { sessionId: 'x', mode: 'ask-first' }]) expect(ChatSetModeRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    for (const choice of APPROVAL_CHOICES) expect(ChatDecideRequestSchema.safeParse({ sessionId, itemId: 'card-1', choice }).success, choice).toBe(true);
    // The page cannot invent a choice, a scope, a rule or a tool's input.
    for (const request of [{ sessionId, itemId: 'card-1', choice: 'acceptForSession' }, { sessionId, itemId: 'card-1', choice: 'approve', destination: 'localSettings' }, { sessionId, itemId: 'card-1', choice: 'approve', updatedInput: {} }, { sessionId, itemId: 'card-1' }, { sessionId, requestId: 'n:1', choice: 'approve' }]) expect(ChatDecideRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  it('have a closed list of why each was not taken', () => {
    // `plan-pending` (M22b, C58): a plan's decision holds the chat's mode.
    expect(SET_MODE_REFUSALS).toEqual(['unknown-session', 'unsupported', 'unknown-mode', 'mode-unavailable', 'same', 'running', 'changing-mode', 'setting-up', 'busy', 'unconfirmed', 'not-confirmed', 'storage-failed', 'plan-pending']);
    expect(DECIDE_REFUSALS).toEqual(['unknown-session', 'unknown-item', 'not-pending', 'not-offered', 'changing-mode', 'setting-up', 'busy', 'storage-failed']);
  });
});

describe('fat-g’s words (V9, V23; C13, C14, C46, C56, C57, C78, C92)', () => {
  it('say what became of an approval, one line for each way it settles', () => {
    const words = (outcome: ApprovalBody['outcome'], patch: Partial<Pick<ApprovalBody, 'withdrawnBy' | 'delivered'>> = {}, unconfirmed = false): string | null => approvalWords({ outcome, withdrawnBy: null, delivered: null, ...patch }, unconfirmed);
    expect(words('pending')).toBeNull();
    expect([words('approved'), words('approved-session'), words('denied')]).toEqual(['Approved once', 'Approved for this session', 'Denied']);
    // Written and never confirmed, once what carried it is over (M21, C68).
    expect([words('approved', {}, true), words('approved-session', {}, true), words('denied', {}, true)]).toEqual(['Approved; the CLI did not confirm it', 'Approved for this session; the CLI did not confirm it', 'Denied; the CLI did not confirm it']);
    // The process refused the reply: said so whatever still runs (C92).
    expect([words('approved', { delivered: false }), words('approved-session', { delivered: false }, true)]).toEqual(['Approved; the process did not take it', 'Approved for this session; the process did not take it']);
    expect([words('withdrawn', { withdrawnBy: 'request' }), words('withdrawn', { withdrawnBy: 'turn' }), words('withdrawn', { withdrawnBy: 'changed' })]).toEqual(['Withdrawn: the model went on without an answer', 'Withdrawn: the reply ended', 'Withdrawn: the request changed under its id and was refused']);
    expect(words('dropped')).toBe('Not answered: the session’s process ended');
    // One function words either kind's card.
    expect(outcomeWords({ outcome: 'approved', withdrawnBy: null, delivered: true }, false)).toBe('Approved once');
    expect(outcomeWords({ outcome: 'withdrawn', withdrawnBy: 'changed' }, false)).toBe('Withdrawn: the request changed under its id and was refused');
  });

  it('say who asks and for what, what a grant covers, and what the CLI’s own offers would grant', () => {
    expect([askWords('command', 'Claude'), askWords('file-change', 'Codex'), askWords('tool', 'Sub-agent')]).toEqual(['Claude asks to run a command', 'Codex asks to change a file', 'Sub-agent asks to use a tool']);
    expect(APPROVAL_WORDS.approveSession('notes.txt')).toBe('Approve for this session: notes.txt');
    expect(APPROVAL_WORDS.wouldStop('Edits ok')).toBe('Edits ok would stop this question');
    expect(authorityWords({ kind: 'mode', mode: 'edits-ok' }, 'Edits ok')).toBe('a mode: Edits ok');
    expect(authorityWords({ kind: 'mode', mode: null }, null)).toBe('a change of mode');
    expect([authorityWords({ kind: 'folder', mode: null }, null), authorityWords({ kind: 'saved-rule', mode: null }, null), authorityWords({ kind: 'network', mode: null }, null)]).toEqual(['a folder', 'a rule saved beyond this session', 'network access']);
  });

  it('read "Waiting for your approval" on the session’s own line (C78)', () => {
    expect(ACTION_KINDS).toContain('approving');
    expect(actionLabel('approving')).toBe('Waiting for your approval');
    expect(APPROVAL_WORDS.waiting).toBe('Waiting for your approval');
  });

  it('name the chat’s mode in the two mode blocks, whose remedy is the change itself (C46, C89)', () => {
    expect(SEND_BLOCKS.slice(-2)).toEqual(['mode-unconfirmed', 'mode-unavailable']);
    expect(SEND_BLOCKS.filter(isModeBlock)).toEqual(['mode-unconfirmed', 'mode-unavailable']);
    expect(isModeBlock(null)).toBe(false);
    expect(blockWords('mode-unavailable', 'Codex', { label: 'Sandbox ok', reason: 'needs-setup' })).toEqual({ text: 'Sandbox ok needs Codex’s sandbox, which this account does not have. Choose another mode.', remedy: 'change-mode' });
    expect(blockWords('mode-unconfirmed', 'Codex', { label: 'Ask first', reason: null })).toEqual({ text: 'Codex reported another policy than Ask first; nothing was sent. Choose a mode this account runs.', remedy: 'change-mode' });
    for (const block of ['mode-unconfirmed', 'mode-unavailable'] as const) expect(blockWords(block, 'Codex').remedy).toBe('change-mode');
  });

  it('word a notice with the mode fat-g asked for, and a refusal with the size that caused it (C46, C48, C67, C71)', () => {
    expect(noticeWords('policy-mismatch', 'Codex', undefined, { mode: 'Ask first' })).toBe('Codex reported another policy than Ask first; nothing was sent. Choose a mode this account runs, or check Codex’s own configuration.');
    expect(noticeWords('not-read-only', 'Claude', undefined, { mode: 'Ask first' })).toBe('Claude did not start under Ask first, so nothing was sent. Its own configuration may ask for another policy than fat-g asked for.');
    // With no mode, the restricted start's words stand as they were.
    expect(noticeWords('not-read-only', 'Codex')).toContain('restricted start');
    expect(noticeWords('start-overruled', 'Claude', undefined, { mode: 'Edits ok' })).toContain('other tools or permissions than Edits ok asks for');
    expect(mebibytes(6_500_000)).toBe('6.2 MiB');
    expect(noticeWords('request-refused', 'Claude', undefined, { bound: 'line', size: 6_500_000 })).toBe('Claude sent a request in a line of 6.2 MiB, more than fat-g reads. It was refused; work continues.');
    expect(noticeWords('request-refused', 'Claude', undefined, { bound: 'detail', size: 1_048_577 })).toBe('Claude asked leave for an action of 1,048,577 characters, more than fat-g shows whole. It was refused, never shown cut.');
    expect(noticeWords('request-refused', 'Codex', undefined, { bound: 'targets', size: 40 })).toContain('names 40 files');
    expect(noticeWords('request-refused', 'Codex')).toBe('Codex asked for something fat-g does not grant in this version. It was refused.');
    // Under a reading mode the mode is why, by its name; under any other the request is one fat-g shows no card for.
    expect(noticeWords('request-refused', 'Codex', undefined, { mode: 'Read only', reading: true })).toBe('Codex asked to act, and this chat is Read only: the request was refused. Change the chat’s mode to be asked instead.');
    expect(noticeWords('request-refused', 'Codex', undefined, { mode: 'Ask first', reading: false })).toBe('Codex asked for something fat-g does not grant in this version. It was refused.');
    expect(noticeWords('line-too-long', 'Codex', undefined, { size: 6_500_000 })).toContain('(6.2 MiB)');
    expect(noticeWords('line-too-long', 'Codex')).toContain('everything running here was stopped');
  });
});
