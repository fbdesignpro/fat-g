// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V26, V31 (docs/planning/_archive/M21.md; C10–C15, C67, C70, C75, C76, C78) and V3, V23, V27, V31
// (docs/planning/_archive/M22.md; C10–C14, C49, C78, C88, C91, C92): the request registry's
// state machine, on every pairing — what a request raised, repeated or out of place does, what an
// answer, a withdrawal, a drop and a confirmation each do to a pending and to an answered entry,
// what each end sweeps, and what the read's overlay is told. With the summary's and the chat's
// doings recorded: the same through a real store and a real session service is runtime-questions.
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentApprovalRaised, AgentQuestionRaised } from '@shared/contracts/agent-events';
import type { ApprovalChoice, BoundQuestion, GivenAnswer, RaisedApprovalRequest } from '@shared/contracts/interaction';
import type { EventOwner } from '@shared/contracts/sessions';
import { createRequestRegistry, type RequestRegistry } from './requests';

const S = '5e551000-0000-4000-8000-000000000001';
const OTHER = '5e551000-0000-4000-8000-000000000002';
const QUESTION: BoundQuestion = { text: 'Which file should I read?', header: 'File', options: [{ label: 'notes-1.txt', description: null }, { label: 'notes-2.txt', description: null }], multiple: false, freeText: true, secret: false };

let registry: RequestRegistry;
/** What the registry did, in order: to the summary, to the chat, to the session and to its count. */
let did: string[];
/** The owners the summary holds current. */
let current: { turn: string | null; workers: string[] };
let world: { raise: 'keep' | 'fail'; answer: 'answered' | 'not-pending' | 'storage-failed'; decline?: 'declined' | 'not-pending' | 'storage-failed'; decide: 'decided' | 'not-pending' | 'storage-failed' };
let items: number;
let mono: number;
/** What the session's write of a decision answers (M22, C12): went, not taken, or — undefined — nothing said. */
let write: boolean | undefined = true;
const to = {
  answer(requestId: string, answers: readonly GivenAnswer[] | null): void { did.push(`session.answer ${requestId} ${answers === null ? 'refused' : JSON.stringify(answers)}`); },
  decide(requestId: string, choice: ApprovalChoice | null): Promise<boolean> | undefined { did.push(`session.decide ${requestId} ${choice ?? 'refused'}`); return write === undefined ? undefined : Promise.resolve(write); },
  decline(requestId: string): void { did.push(`session.decline ${requestId}`); },
  decidePlan(requestId: string, answer: unknown): Promise<boolean> { did.push(`session.decidePlan ${requestId} ${answer === null ? 'refused' : JSON.stringify(answer)}`); return Promise.resolve(true); },
};

beforeEach(() => {
  did = [];
  items = 0;
  mono = 0;
  current = { turn: 't1', workers: [] };
  world = { raise: 'keep', answer: 'answered', decide: 'decided' };
  write = true;
  const ownerWords = (owner: EventOwner): string => ('turnId' in owner ? `turn ${owner.turnId}` : `worker ${owner.workerId}`);
  registry = createRequestRegistry({
    monotonic: () => mono,
    sessions: {
      apply(event) {
        const applied = event as { type: string; owner?: EventOwner; requestId?: string; kind?: string; turnId?: string; count?: number };
        did.push(applied.type === 'action-changed' ? `summary action ${applied.kind}` : `summary ${applied.type} ${applied.requestId} (${applied.owner === undefined ? '' : ownerWords(applied.owner)})${applied.type === 'request-raised' ? ` ${applied.kind} ×${applied.count}` : ''}`);
      },
      owns: (_id, owner) => ('turnId' in owner ? owner.turnId === current.turn : current.workers.includes(owner.workerId)),
    },
    chat: {
      raise(_sessionId, question, kept) {
        if (world.raise === 'fail') return null;
        items += 1;
        did.push(`chat.raise card-${items} in ${question.turnId}${question.workerId === null ? '' : ` of ${question.workerId}`} at ${question.providerItemId}`);
        // As the chat service does: told once the card is written, before its push.
        kept?.(`card-${items}`);
        return `card-${items}`;
      },
      answer(_sessionId, itemId, answers) { did.push(`chat.answer ${itemId} ${JSON.stringify(answers)}`); return world.answer; },
      decline(_sessionId, itemId) { did.push(`chat.decline ${itemId}`); return world.decline ?? 'declined'; },
      confirm(_sessionId, itemId) { did.push(`chat.confirm ${itemId}`); },
      settle(_sessionId, itemIds, outcome, withdrawnBy) { did.push(`chat.settle ${itemIds.join(',')} ${outcome}${withdrawnBy === undefined ? '' : ` by ${withdrawnBy}`}`); },
      notTaken(_sessionId, itemId) { did.push(`chat.notTaken ${itemId}`); },
      raiseApproval(_sessionId, approval, kept) {
        if (world.raise === 'fail') return null;
        items += 1;
        did.push(`chat.raiseApproval card-${items} in ${approval.turnId}${approval.workerId === null ? '' : ` of ${approval.workerId}`} at ${approval.providerItemId}`);
        kept?.(`card-${items}`);
        return `card-${items}`;
      },
      decide(_sessionId, itemId, outcome, grant) { did.push(`chat.decide ${itemId} ${outcome}${grant === null ? '' : ` grant ${JSON.stringify(grant)}`}`); return world.decide; },
      delivered(_sessionId, itemId, went) { did.push(`chat.delivered ${itemId} ${went}`); },
    },
    count: (what) => { did.push(`count ${what}`); },
  });
});

const raised = (requestId: string, patch: Partial<AgentQuestionRaised> = {}): AgentQuestionRaised => ({ type: 'question-raised', turnId: 't1', requestId, sourceId: `source-${requestId}`, questions: [QUESTION], cut: false, ...patch });
const raise = (requestId: string, patch: Partial<AgentQuestionRaised> = {}, generation = 1, session = S): void => { registry.raise(session, generation, raised(requestId, patch), to); };
const resolve = (requestId: string, reason: 'withdrawn' | 'dropped' | 'confirmed', generation = 1): void => { registry.resolve(S, generation, { type: 'question-resolved', requestId, reason }); };
const pick = (option: number): GivenAnswer => ({ options: [option], text: null });
/** What happened since the last look. */
const since = (): string[] => did.splice(0);

describe('time held for decisions', () => {
  it('counts overlapping requests once and ends the wait on an answer, before confirmation', () => {
    mono = 100;
    raise('r1');
    mono = 300;
    raise('r2');
    mono = 500;
    resolve('r1', 'withdrawn');
    expect(registry.waitedMs(S, 't1')).toBe(400);
    mono = 800;
    expect(registry.answer(S, 1, 'card-2', [pick(0)], to)).toBe('answered');
    mono = 2_000;
    expect(registry.waitedMs(S, 't1')).toBe(700);
    expect(registry.waitedMs(S, 'another-turn')).toBe(0);
  });

  it('keeps waiting on a failed save and excludes worker requests from the parent timer', () => {
    current.workers = ['w1'];
    raise('worker', { workerId: 'w1' });
    mono = 100;
    expect(registry.waitedMs(S, 't1')).toBe(0);
    raise('parent');
    world.answer = 'storage-failed';
    mono = 300;
    expect(registry.answer(S, 1, 'card-2', [pick(0)], to)).toBe('storage-failed');
    mono = 600;
    expect(registry.waitedMs(S, 't1')).toBe(500);
    registry.turnEnded(S, 't1');
    mono = 900;
    expect(registry.waitedMs(S, 't1')).toBe(500);
  });
});

describe('a request raised (V3; C10, C11, C15)', () => {
  it('opens one item, raises the attention under the item’s id, and makes the session’s line read asking', () => {
    raise('r1');
    expect(since()).toEqual([
      'chat.raise card-1 in t1 at source-r1',
      'summary request-raised card-1 (turn t1) question ×1',
      'count question raised',
    ]);
    expect(registry.pending(S, 'card-1')).toBe(true);
    expect(registry.waiting(S)).toEqual([]);
  });

  it('opens nothing for the same id again, on any state, and counts it: a repeated delivery makes one card', () => {
    raise('r1');
    since();
    raise('r1');
    expect(since()).toEqual(['count question repeated']);
    registry.answer(S, 1, 'card-1', [pick(0)], to);
    since();
    raise('r1');
    expect(since()).toEqual(['count question repeated']);
    // The same id on another process is another request.
    raise('r1', {}, 2);
    expect(since()[0]).toBe('chat.raise card-2 in t1 at source-r1');
  });

  it.each<[string, Partial<AgentQuestionRaised>, string]>([
    ['another turn than the session’s current one', { turnId: 't0' }, 'stale turn'],
    ['a worker not listed as running', { workerId: 'worker-9' }, 'stale worker'],
  ])('is discarded, counted and refused through the session for %s', (_name, patch, kind) => {
    raise('r1', patch);
    expect(since()).toEqual([`count question discarded (${kind})`, 'session.answer r1 refused']);
    expect(registry.pending(S, 'card-1')).toBe(false);
  });

  it('is refused the same way where its card could not be kept: one that cannot be kept cannot be shown (C33)', () => {
    world.raise = 'fail';
    raise('r1');
    expect(since()).toEqual(['count question refused (not kept)', 'session.answer r1 refused']);
  });

  it('is a worker’s under its worker: listed as waiting, with no line of the session’s changed', () => {
    current.workers = ['worker-1'];
    raise('r1', { workerId: 'worker-1', turnId: 't0' });
    expect(since()).toEqual([
      'chat.raise card-1 in t0 of worker-1 at source-r1',
      'summary request-raised card-1 (worker worker-1) question ×1',
      'count question raised',
    ]);
    expect(registry.waiting(S)).toEqual([{ workerId: 'worker-1', itemId: 'card-1', kind: 'question' }]);
  });
});

describe('an answer (V3; C13, C14, C31, C78)', () => {
  it('writes the item first, then tells the session, resolves the attention and makes the line read thinking', () => {
    raise('r1');
    since();
    expect(registry.answer(S, 1, 'card-1', [pick(1)], to)).toBe('answered');
    expect(since()).toEqual([
      'chat.answer card-1 [{"options":[1],"text":null,"secret":false}]',
      'session.answer r1 [{"options":[1],"text":null}]',
      'summary request-resolved card-1 (turn t1)',
      'count question answered',
    ]);
    // Answered, and so no longer pending: the read's overlay restores nothing (C76).
    expect(registry.pending(S, 'card-1')).toBe(false);
  });

  it('is refused as not pending: a second answer, one after a withdrawal, one on an earlier generation, one for another session’s card and one for no card', () => {
    raise('r1');
    raise('r2');
    registry.answer(S, 1, 'card-1', [pick(0)], to);
    resolve('r2', 'withdrawn');
    raise('r3', {}, 1, OTHER);
    since();
    expect(registry.answer(S, 1, 'card-1', [pick(0)], to)).toBe('not-pending');
    expect(registry.answer(S, 1, 'card-2', [pick(0)], to)).toBe('not-pending');
    expect(registry.answer(S, 1, 'card-3', [pick(0)], to)).toBe('not-pending');
    expect(registry.answer(S, 1, 'no-card', [pick(0)], to)).toBe('not-pending');
    raise('r4');
    since();
    // The session's process is another now: nothing raised on the earlier one is answered (C13).
    expect(registry.answer(S, 2, 'card-4', [pick(0)], to)).toBe('not-pending');
    expect(since()).toEqual([]);
  });

  it.each<[string, (GivenAnswer | null)[], string]>([
    ['a text where none is taken', [{ options: [0], text: 'and this' }], 'mismatch'],
    ['several options where one may be chosen', [{ options: [0, 1], text: null }], 'mismatch'],
    ['a place past the options', [pick(2)], 'mismatch'],
    ['more answers than questions', [pick(0), pick(1)], 'mismatch'],
    ['no answer to its one question', [null], 'incomplete'],
  ])('is refused before any write for %s, and stays pending', (_name, answers, reason) => {
    raise('r1', { questions: [{ ...QUESTION, freeText: false }] });
    since();
    expect(registry.answer(S, 1, 'card-1', answers, to)).toBe(reason);
    expect(since()).toEqual([]);
    expect(registry.pending(S, 'card-1')).toBe(true);
  });

  it('sends a question left blank as "No answer", keeps it as none, and refuses a card with none answered (M100b, C30)', () => {
    raise('r1', { questions: [QUESTION, QUESTION] });
    expect(since()).toContain('summary request-raised card-1 (turn t1) question ×2');
    expect(registry.answer(S, 1, 'card-1', [null, { options: [], text: '  ' }], to)).toBe('incomplete');
    expect(registry.answer(S, 1, 'card-1', [pick(0)], to)).toBe('mismatch');
    expect(since()).toEqual([]);
    expect(registry.answer(S, 1, 'card-1', [pick(0), null], to)).toBe('answered');
    const [written, sent] = since();
    expect(written).toBe('chat.answer card-1 [{"options":[0],"text":null,"secret":false},null]');
    // The CLI's answers name each question (C45): the blank one in fat-g's words.
    expect(sent).toBe('session.answer r1 [{"options":[0],"text":null},{"options":[],"text":"No answer"}]');
  });

  // M100b, V10 (C31): Skip on a blocking card.
  it('declines a skipped question: the item written first, then the session told, the attention resolved; stale once replied to', () => {
    raise('r1', { questions: [QUESTION, QUESTION] });
    since();
    expect(registry.decline(S, 1, 'card-1', to)).toBe('declined');
    expect(since()).toEqual(['chat.decline card-1', 'session.decline r1', 'summary request-resolved card-1 (turn t1)', 'count question declined']);
    expect(registry.pending(S, 'card-1')).toBe(false);
    // Replied to: neither a second Skip nor an answer is taken, and nothing is written or sent.
    expect(registry.decline(S, 1, 'card-1', to)).toBe('not-pending');
    expect(registry.answer(S, 1, 'card-1', [pick(0), null], to)).toBe('not-pending');
    expect(since()).toEqual([]);
    // The CLI's word that it took the decline lets it go; a drop instead reads `dropped`, as an answer's does.
    resolve('r1', 'confirmed');
    expect(since()).toEqual(['chat.confirm card-1', 'count question confirmed']);
    raise('r2');
    expect(registry.decline(S, 1, 'card-2', to)).toBe('declined');
    since();
    resolve('r2', 'dropped');
    expect(since()).toEqual(['chat.notTaken card-2', 'count question dropped (answered)']);
  });

  it('declines nothing it does not hold pending, nor on another process, nor where the skip could not be recorded', () => {
    expect(registry.decline(S, 1, 'no-card', to)).toBe('not-pending');
    raise('r1');
    since();
    expect(registry.decline(S, 2, 'card-1', to)).toBe('not-pending');
    world.decline = 'storage-failed';
    expect(registry.decline(S, 1, 'card-1', to)).toBe('storage-failed');
    expect(since()).toEqual(['chat.decline card-1']);
    expect(registry.pending(S, 'card-1')).toBe(true);
  });

  it('keeps a secret’s answer as the fact alone in the item, and gives its text to the session alone (C44)', () => {
    raise('r1', { questions: [{ ...QUESTION, secret: true, freeText: false }] });
    since();
    registry.answer(S, 1, 'card-1', [{ options: [], text: 'hunter2' }], to);
    const [written, sent] = since();
    expect(written).toBe('chat.answer card-1 [{"options":[],"text":null,"secret":true}]');
    expect(sent).toBe('session.answer r1 [{"options":[],"text":"hunter2"}]');
  });

  it('sends nothing where the answer could not be recorded, and stays pending (C33)', () => {
    raise('r1');
    since();
    world.answer = 'storage-failed';
    expect(registry.answer(S, 1, 'card-1', [pick(0)], to)).toBe('storage-failed');
    expect(since()).toEqual(['chat.answer card-1 [{"options":[0],"text":null,"secret":false}]']);
    expect(registry.pending(S, 'card-1')).toBe(true);
    world.answer = 'answered';
    expect(registry.answer(S, 1, 'card-1', [pick(0)], to)).toBe('answered');
  });
});

describe('what the adapter says became of a request, on each state (V3, V26, V31; C12, C14, C63, C67, C70)', () => {
  type Step = readonly ['pending' | 'answered', 'withdrawn' | 'dropped' | 'confirmed', readonly string[], /** Held after it. */ boolean];
  const steps: readonly Step[] = [
    ['pending', 'withdrawn', ['chat.settle card-1 withdrawn by request', 'summary request-resolved card-1 (turn t1)', 'count question withdrawn'], false],
    ['pending', 'dropped', ['chat.settle card-1 dropped', 'summary request-resolved card-1 (turn t1)', 'count question dropped (pending)'], false],
    // A confirmation of nothing answered: counted, and the card still waits.
    ['pending', 'confirmed', ['count question confirmed ignored (pending)'], true],
    // A withdrawal after an answer is dropped and counted: the first to arrive settled the item (C14).
    ['answered', 'withdrawn', ['count question withdrawn ignored (answered)'], true],
    // The adapter's word of a failed write: the one thing that drops an answered item (C70).
    ['answered', 'dropped', ['chat.notTaken card-1', 'count question dropped (answered)'], false],
    ['answered', 'confirmed', ['chat.confirm card-1', 'count question confirmed'], false],
  ];

  it.each(steps)('%s, then %s', (state, reason, expected, held) => {
    raise('r1');
    if (state === 'answered') registry.answer(S, 1, 'card-1', [pick(0)], to);
    since();
    resolve('r1', reason);
    expect(since()).toEqual(expected);
    // Held still: a second word for it finds its entry. Let go: it is counted, and changes nothing.
    resolve('r1', 'dropped');
    expect(since().some((line) => line.startsWith('chat.'))).toBe(held);
  });

  it('counts a word for a request it does not hold — another generation’s, one let go, one never raised — and changes nothing (V31)', () => {
    raise('r1');
    since();
    resolve('r1', 'dropped', 2);
    resolve('r9', 'confirmed');
    expect(since()).toEqual(['count question dropped for no request', 'count question confirmed for no request']);
    expect(registry.pending(S, 'card-1')).toBe(true);
  });
});

describe('the ends (V3, V26, V31; C12, C65, C67, C70, C75)', () => {
  /** r1 of the turn, pending; r2 of the turn, answered; r3 of a worker, pending; r4 of the worker, answered. */
  function four(): void {
    current.workers = ['worker-1'];
    raise('r1');
    raise('r2');
    raise('r3', { workerId: 'worker-1' });
    raise('r4', { workerId: 'worker-1' });
    registry.answer(S, 1, 'card-2', [pick(0)], to);
    registry.answer(S, 1, 'card-4', [pick(0)], to);
    since();
  }
  /** Which of the four the registry still holds: a confirmation finds an answered one, a drop a pending one. */
  const pendingNow = (): string[] => ['card-1', 'card-2', 'card-3', 'card-4'].filter((id) => registry.pending(S, id));

  it('withdraws the turn’s pending requests at the provider’s end of the turn, and leaves a running worker’s', () => {
    four();
    registry.turnEnded(S, 't1');
    expect(since()).toEqual(['chat.settle card-1 withdrawn by turn', 'summary request-resolved card-1 (turn t1)', 'count question withdrawn']);
    expect(pendingNow()).toEqual(['card-3']);
    expect(registry.waiting(S)).toEqual([{ workerId: 'worker-1', itemId: 'card-3', kind: 'question' }]);
    // Another turn's end sweeps nothing.
    registry.turnEnded(S, 't0');
    expect(since()).toEqual([]);
  });

  it('withdraws a worker’s pending requests at the worker’s end, and no other’s', () => {
    four();
    registry.workerEnded(S, 'worker-1');
    expect(since()).toEqual(['chat.settle card-3 withdrawn by turn', 'summary request-resolved card-3 (worker worker-1)', 'count question withdrawn']);
    expect(pendingNow()).toEqual(['card-1']);
    expect(registry.waiting(S)).toEqual([]);
  });

  it('drops every pending request of the session in one write, and no other session’s', () => {
    four();
    raise('r5', {}, 1, OTHER);
    since();
    registry.dropAll(S);
    expect(since()).toEqual([
      'chat.settle card-1,card-3 dropped',
      'summary request-resolved card-1 (turn t1)', 'count question dropped',
      'summary request-resolved card-3 (worker worker-1)', 'count question dropped',
    ]);
    expect(pendingNow()).toEqual([]);
    expect(registry.pending(OTHER, 'card-5')).toBe(true);
    registry.dropAll(S);
    expect(since()).toEqual([]);
  });

  it('keeps an answered entry through its owner’s end and the drops, so a write the stop rejects still finds its item (V31; C75)', () => {
    four();
    registry.turnEnded(S, 't1');
    registry.workerEnded(S, 'worker-1');
    registry.dropAll(S);
    since();
    // The answer's write was still queued when the process was stopped: the adapter says so.
    resolve('r2', 'dropped');
    expect(since()).toEqual(['chat.notTaken card-2', 'count question dropped (answered)']);
    // And the worker's result still confirms the worker's answer after the parent's turn.
    resolve('r4', 'confirmed');
    expect(since()).toEqual(['chat.confirm card-4', 'count question confirmed']);
  });

  it('lets every entry of a generation go at its handle’s close, with no change to any item (V26; C70, C75)', () => {
    four();
    raise('r6', {}, 2);
    since();
    registry.closed(S, 1);
    expect(since()).toEqual([]);
    expect(pendingNow()).toEqual([]);
    // Nothing of that handle is held: a word for it is counted, and the item stays answered.
    resolve('r2', 'dropped');
    resolve('r4', 'confirmed');
    expect(since()).toEqual(['count question dropped for no request', 'count question confirmed for no request']);
    // The newer process's request is untouched.
    expect(registry.pending(S, 'card-5')).toBe(true);
  });

  it('holds nothing of a session that is no longer listed', () => {
    four();
    registry.forget(S);
    expect(pendingNow()).toEqual([]);
    expect(registry.waiting(S)).toEqual([]);
    expect(since()).toEqual([]);
  });
});

describe('what the registry never does (V3; C9, C34)', () => {
  it('leaves a pending request pending however long it waits: no timeout, no default answer', () => {
    raise('r1');
    since();
    // An hour, a day: the registry has no clock to read.
    expect(registry.pending(S, 'card-1')).toBe(true);
    expect(since()).toEqual([]);
  });

  it('tells the summary and its count nothing of a question: ids, kinds and counts alone', () => {
    current.workers = ['worker-1'];
    raise('r1', { questions: [{ ...QUESTION, text: 'NEEDLE-QUESTION', header: 'NEEDLE-HEADER', options: [{ label: 'NEEDLE-LABEL', description: 'NEEDLE-DESCRIPTION' }] }] });
    registry.answer(S, 1, 'card-1', [{ options: [0], text: 'NEEDLE-ANSWER' }], to);
    raise('r2', { workerId: 'worker-1' });
    resolve('r2', 'withdrawn');
    resolve('r1', 'confirmed');
    const said = did.filter((line) => line.startsWith('summary') || line.startsWith('count'));
    expect(said.length).toBeGreaterThan(5);
    expect(said.join('\n')).not.toMatch(/NEEDLE|Which file|notes-|source-/);
  });
});

// ── Approvals (docs/planning/_archive/M22.md; V3, V23, V27, V31; C10–C14, C49, C78, C88, C91, C92) ──────
const REQUEST: RaisedApprovalRequest = {
  kind: 'command', tool: 'Bash', summary: 'touch notes.txt', folder: null, targets: [], outside: false, reason: null, authority: [],
  detail: { kind: 'command', command: 'touch notes.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' }, modeThatWouldStop: null, cut: false,
};
const ONCE: RaisedApprovalRequest = { ...REQUEST, choices: ['approve', 'deny'], grant: null };
const asked = (requestId: string, patch: Partial<AgentApprovalRaised> = {}): AgentApprovalRaised => ({ type: 'approval-raised', turnId: 't1', requestId, sourceId: `item-${requestId}`, request: REQUEST, ...patch });
const ask = (requestId: string, patch: Partial<AgentApprovalRaised> = {}, generation = 1): void => { registry.raise(S, generation, asked(requestId, patch), to); };
const settle = (requestId: string, reason: 'withdrawn' | 'dropped' | 'confirmed' | 'changed', generation = 1): void => { registry.resolve(S, generation, { type: 'approval-resolved', requestId, reason }); };
/** The session's write of a decision has answered, and what the registry made of it has run. */
const written = async (): Promise<void> => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };

describe('an approval raised (V3, V23; C10, C11, C78, C79)', () => {
  it('opens one item, raises the approval attention under the item’s id, and makes the session’s line read approving', () => {
    ask('n:1');
    expect(since()).toEqual([
      'chat.raiseApproval card-1 in t1 at item-n:1',
      'summary request-raised card-1 (turn t1) approval ×1',
      'count approval raised',
    ]);
    expect(registry.pending(S, 'card-1')).toBe(true);
    expect(registry.any(S)).toBe(true);
    // The request, whole, for the live card (C79).
    expect(registry.view(S, 'card-1')).toBe(REQUEST);
    expect(registry.view(S, 'card-9')).toBeNull();
  });

  it('is a worker’s under its worker: listed as waiting by its kind, with no line of the session’s changed', () => {
    current.workers = ['worker-1'];
    ask('n:1', { workerId: 'worker-1', turnId: 't0' });
    expect(since()).toEqual(['chat.raiseApproval card-1 in t0 of worker-1 at item-n:1', 'summary request-raised card-1 (worker worker-1) approval ×1', 'count approval raised']);
    expect(registry.waiting(S)).toEqual([{ workerId: 'worker-1', itemId: 'card-1', kind: 'approval' }]);
  });

  it('keeps a number and a string of one spelling apart, and a question and an approval of one id on one process together', () => {
    ask('n:0');
    ask('s:0');
    expect(did.filter((line) => line.startsWith('chat.raiseApproval'))).toHaveLength(2);
    since();
    // One id is one request, whatever its kind: the second is a repeat, and opens nothing.
    raise('n:0');
    expect(since()).toEqual(['count question repeated']);
  });

  it('opens nothing for an identical delivery again, and refuses one whose view differs as a defect (C91)', () => {
    ask('n:1');
    since();
    ask('n:1');
    expect(since()).toEqual(['count approval repeated']);
    ask('n:1', { request: ONCE });
    expect(since()).toEqual(['count approval repeated (changed: a defect)', 'session.decide n:1 refused']);
    expect(registry.pending(S, 'card-1')).toBe(true);
  });

  it.each<[string, Partial<AgentApprovalRaised>, string]>([
    ['another turn than the session’s current one', { turnId: 't0' }, 'stale turn'],
    ['a worker not listed as running', { workerId: 'worker-9' }, 'stale worker'],
  ])('is discarded, counted and refused through the session’s decide for %s', (_name, patch, kind) => {
    ask('n:1', patch);
    expect(since()).toEqual([`count approval discarded (${kind})`, 'session.decide n:1 refused']);
  });

  it('is refused the same way where its card could not be kept', () => {
    world.raise = 'fail';
    ask('n:1');
    expect(since()).toEqual(['count approval refused (not kept)', 'session.decide n:1 refused']);
    expect(registry.any(S)).toBe(false);
  });
});

describe('a decision (V3, V27; C12, C13, C49, C88, C92)', () => {
  it('is written before it is sent, then told to the session by the request’s own id, the attention resolved and the line moved on', async () => {
    ask('n:1');
    since();
    expect(registry.decide(S, 1, 'card-1', 'approve', to, 'process-1')).toBe('decided');
    expect(since()).toEqual(['chat.decide card-1 approved', 'session.decide n:1 approve', 'summary request-resolved card-1 (turn t1)', 'count approval decided (approve)']);
    expect(registry.pending(S, 'card-1')).toBe(false);
    expect(registry.view(S, 'card-1')).toBeNull();
    // What the session says of its write is the delivery, kept apart (C12).
    await written();
    expect(since()).toEqual(['chat.delivered card-1 true']);
  });

  it('carries the grant for the session’s choice: what the CLI’s own offer covers, and the process it is sent to (C57, C81)', () => {
    ask('n:1');
    since();
    expect(registry.decide(S, 1, 'card-1', 'approve-session', to, 'process-7')).toBe('decided');
    expect(since().slice(0, 2)).toEqual(['chat.decide card-1 approved-session grant {"covers":"Bash(touch notes.txt)","processKey":"process-7"}', 'session.decide n:1 approve-session']);
  });

  it('takes only a choice the request’s own view lists (C88)', () => {
    ask('n:1', { request: ONCE });
    since();
    expect(registry.decide(S, 1, 'card-1', 'approve-session', to, 'process-1')).toBe('not-offered');
    expect(since()).toEqual([]);
    expect(registry.decide(S, 1, 'card-1', 'deny', to, 'process-1')).toBe('decided');
    expect(since()[0]).toBe('chat.decide card-1 denied');
  });

  it('is refused for a card that waits no more, one of another process, and one that is no approval', () => {
    ask('n:1');
    raise('r2');
    expect(registry.decide(S, 2, 'card-1', 'approve', to, 'process-1')).toBe('not-pending');
    expect(registry.decide(S, 1, 'card-9', 'approve', to, 'process-1')).toBe('not-pending');
    // A question's card takes no decision, and an approval's no answer.
    expect(registry.decide(S, 1, 'card-2', 'approve', to, 'process-1')).toBe('not-pending');
    expect(registry.answer(S, 1, 'card-1', [pick(0)], to)).toBe('not-pending');
    expect(registry.decide(S, 1, 'card-1', 'approve', to, 'process-1')).toBe('decided');
    expect(registry.decide(S, 1, 'card-1', 'deny', to, 'process-1')).toBe('not-pending');
  });

  it.each(['storage-failed', 'not-pending'] as const)('sends nothing for a decision the chat answered %s for, and leaves the request pending', (answer) => {
    ask('n:1');
    since();
    world.decide = answer;
    expect(registry.decide(S, 1, 'card-1', 'approve', to, 'process-1')).toBe(answer);
    expect(since()).toEqual(['chat.decide card-1 approved']);
    expect(registry.pending(S, 'card-1')).toBe(true);
  });

  it('says a decision the process did not take is not delivered, and says nothing where the session said nothing (C92)', async () => {
    ask('n:1');
    ask('n:2');
    since();
    write = false;
    registry.decide(S, 1, 'card-1', 'approve', to, 'process-1');
    await written();
    expect(since().at(-1)).toBe('chat.delivered card-1 false');
    write = undefined;
    registry.decide(S, 1, 'card-2', 'approve', to, 'process-1');
    await written();
    expect(since().some((line) => line.startsWith('chat.delivered'))).toBe(false);
  });
});

describe('what becomes of an approval’s request (V3, V31; C12, C14, C91)', () => {
  it('marks a decided one confirmed at the CLI’s word, and lets it go', () => {
    ask('n:1');
    registry.decide(S, 1, 'card-1', 'approve', to, 'process-1');
    since();
    settle('n:1', 'confirmed');
    expect(since()).toEqual(['chat.confirm card-1', 'count approval confirmed']);
    settle('n:1', 'confirmed');
    expect(since()).toEqual(['count approval confirmed for no request']);
  });

  it('withdraws a pending one the CLI took back, and one that changed under its id, each with its cause', () => {
    ask('n:1');
    ask('n:2');
    since();
    settle('n:1', 'withdrawn');
    expect(since()).toEqual(['chat.settle card-1 withdrawn by request', 'summary request-resolved card-1 (turn t1)', 'count approval withdrawn']);
    settle('n:2', 'changed');
    expect(since()).toEqual(['chat.settle card-2 withdrawn by changed', 'summary request-resolved card-2 (turn t1)', 'count approval withdrawn (changed)']);
  });

  it('ignores a withdrawal and a change after a decision: the first to arrive settled it', () => {
    ask('n:1');
    registry.decide(S, 1, 'card-1', 'approve', to, 'process-1');
    since();
    settle('n:1', 'withdrawn');
    settle('n:1', 'changed');
    expect(since()).toEqual(['count approval withdrawn ignored (answered)', 'count approval changed ignored (answered)']);
  });

  it('drops a pending one whose process was lost, and says a decided one it could not take is not delivered: it stands as decided', () => {
    ask('n:1');
    ask('n:2');
    registry.decide(S, 1, 'card-2', 'approve-session', to, 'process-1');
    since();
    settle('n:1', 'dropped');
    expect(since()).toEqual(['chat.settle card-1 dropped', 'summary request-resolved card-1 (turn t1)', 'count approval dropped (pending)']);
    settle('n:2', 'dropped');
    expect(since()).toEqual(['chat.delivered card-2 false', 'count approval dropped (answered)']);
  });

  it('tells a question’s resolution from an approval’s: one naming the other kind’s id is for no request', () => {
    ask('n:1');
    since();
    resolve('n:1', 'withdrawn');
    expect(since()).toEqual(['count question withdrawn for no request']);
    expect(registry.pending(S, 'card-1')).toBe(true);
  });

  it('sweeps approvals with questions at each end: withdrawn at the turn’s, dropped before anything the runtime ends itself', () => {
    ask('n:1');
    raise('r2');
    ask('n:3');
    registry.decide(S, 1, 'card-3', 'approve', to, 'process-1');
    since();
    registry.turnEnded(S, 't1');
    expect(since()).toEqual(['chat.settle card-1,card-2 withdrawn by turn', 'summary request-resolved card-1 (turn t1)', 'count approval withdrawn', 'summary request-resolved card-2 (turn t1)', 'count question withdrawn']);
    ask('n:4');
    since();
    registry.dropAll(S);
    expect(since()).toEqual(['chat.settle card-4 dropped', 'summary request-resolved card-4 (turn t1)', 'count approval dropped']);
    // The decided one is let go with its handle, unchanged.
    registry.closed(S, 1);
    expect(since()).toEqual([]);
    expect(registry.any(S)).toBe(false);
  });

  it('tells the summary and its count nothing of an action: ids, kinds and counts alone', () => {
    ask('n:1', { request: { ...REQUEST, summary: 'NEEDLE-SUMMARY', detail: { kind: 'command', command: 'NEEDLE-COMMAND' }, reason: 'NEEDLE-REASON', targets: ['NEEDLE-TARGET'], grant: { covers: 'NEEDLE-COVERS' } } });
    registry.decide(S, 1, 'card-1', 'approve', to, 'process-1');
    settle('n:1', 'confirmed');
    const said = did.filter((line) => line.startsWith('summary') || line.startsWith('count'));
    expect(said.length).toBeGreaterThan(4);
    expect(said.join('\n')).not.toMatch(/NEEDLE|touch|item-/);
  });
});

// M22b (C10, C11): a plan's request is the third kind. What the plan service does with one is in runtime-plans.test.ts.
describe('a plan’s request (M22b; C10, C11)', () => {
  const plan = { type: 'plan-raised' as const, turnId: 't1', requestId: 'p1', sourceId: 'toolu_p1', text: '# Plan' };

  it('is refused through its session, as one main cannot keep, where no plan service keeps it', () => {
    registry.raise(S, 1, plan, to);
    expect(since()).toEqual(['count plan refused (not kept)', 'session.decidePlan p1 refused']);
    expect(registry.plan(S)).toBeNull();
  });

  it('is refused through its session for a turn that is not the current one', () => {
    registry.raise(S, 1, { ...plan, turnId: 't0' }, to);
    expect(since()).toEqual(['count plan discarded (stale turn)', 'session.decidePlan p1 refused']);
  });

  it('takes no decision for an item it does not hold as a plan’s', () => {
    raise('r1');
    since();
    expect(registry.decidePlan(S, 1, 'card-1', { kind: 'execute' }, to)).toBe('not-pending');
    expect(since()).toEqual([]);
  });
});
