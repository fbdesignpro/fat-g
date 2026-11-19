// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The request registry (docs/planning/_archive/M21.md, Design 2; C10–C15, C59, C61, C67, C70, C75, C76, C78;
// decision 0026; docs/planning/_archive/M22.md, Design 4; C10–C14, C49, C78, C79, C91; decision 0027): every
// live request of every session, whatever its provider. A request is something a session's CLI
// asked and holds a turn, or a worker, for: a question, or leave for an action — an approval — or
// a plan's decision (docs/planning/_archive/M22b.md, Design 6; C10–C12, C56; decision 0029), whose version
// the plan service writes before its line; an elicitation (M22c) takes the same registry.
//
// Memory alone, empty at launch: nothing pending survives a restart (C13). It names no provider and
// holds no raw request — the adapter keeps that, and encodes the answer from it (C59) — only what
// an event carried: a question's bounded questions, for the fit of an answer, or an approval's
// bounded view whole, for the choices a decision may name and for the live card, which shows the
// action whole while its request lives (M22, C79); and the id of the item the request opened.
// Nothing of a request reaches a log from here but counts by kind (C34).
//
//   raised ─► repeated: nothing, counted — an approval whose view differs is a defect, refused too
//          ─► an owner that is not current: refused through the session, counted
//          ─► the item written and pushed, or the request refused the same way
//          ─► pending: the session's attention raised, its line "Asking a question" or
//             "Waiting for your approval"
//
//   pending  ── an answer, a decline, a decision ────────► answered (the item, then the CLI)
//            ── withdrawn by the CLI ────────────────────► gone: the item `withdrawn`, by request
//            ── changed under its id, and refused by its
//               adapter (M22, C91) ──────────────────────► gone: the item `withdrawn`, as changed
//            ── its owner's end: the turn's, the worker's ► gone: the item `withdrawn`, by turn
//            ── dropped: said by the adapter at a loss,
//               or by the runtime before it ends anything ► gone: the item `dropped`
//   answered ── confirmed by the CLI ────────────────────► gone: the item's mark
//            ── dropped: the adapter's word of a failed
//               write, and nothing else ─────────────────► gone: a question's item `dropped`, an
//                                                           approval's said not delivered
//            ── the close of the handle it came on ──────► gone: the item unchanged
//
// An answered entry stays until one of those three (C75): its owner's end and the drops before a
// Stop or a close touch the pending alone, so that a write still queued when its process is stopped
// finds its item when the stop rejects it, and an answer written and never confirmed is never
// relabelled by an end (C70). An answer and a withdrawal race by their arrival: the first settles
// the item, and any other pairing is counted and changes nothing (C14).
//
// A decision is written before it is sent (M22, C12, C49): the outcome, and the grant where the
// choice is the session's, in one durable write; a failed write sends nothing. Whether the reply's
// write to the process went is the session's own word, told apart from the CLI's confirmation and
// from the action's success, which is its activity's alone.
//
// A request is keyed by its session, the process generation it came on and the adapter's key for
// the request — lossless, so a number and a string of one spelling never meet (C10). The summary
// knows it by its item's id, which is fat-g's own: no id of the provider's goes there.
import type { AgentApprovalRaised, AgentApprovalResolved, AgentPlanRaised, AgentPlanResolved, AgentQuestionRaised, AgentQuestionResolved } from '@shared/contracts/agent-events';
import type { WaitingQuestion } from '@shared/contracts/chat';
import { type ApprovalChoice, type ApprovalRequest, CHOICE_OUTCOMES, fits, type GivenAnswer, type InteractionQuestion, keptAnswers, noneAnswered, sentAnswers } from '@shared/contracts/interaction';
import { DECISION_OUTCOMES, type PlanOutcome } from '@shared/contracts/plans';
import type { EventOwner } from '@shared/contracts/sessions';
import type { PlanAnswer } from '@shared/provider-kit/sessions';
import type { ChatService } from './chat-service';
import type { PlanService } from './plans';
import type { SessionService } from './service';

/** The kinds of request the registry holds: a closed list, of which M21 raises the first, M22 the second and M22b the third. */
export const REQUEST_REGISTRY_KINDS = ['question', 'approval', 'plan'] as const;
export type RegistryKind = (typeof REQUEST_REGISTRY_KINDS)[number];

/**
 * What the registry asks of a provider's session: an answer by the questions' places, or a
 * decision by one of the request's own choices — and, null, the refusal of a request main cannot
 * place (C11, C30). `decide` answers whether the reply's write went (M22, C12), where its session says.
 */
export interface Answerable {
  answer(requestId: string, answers: readonly GivenAnswer[] | null): void;
  decide(requestId: string, choice: ApprovalChoice | null): Promise<boolean> | undefined;
  /** The user skipped a question (M100b, C31): its request declined, where its session takes that. */
  decline(requestId: string): void;
  /** A plan's decision (M22b, C11), or — null — the refusal of a plan's request main cannot keep: whether the reply's write went. */
  decidePlan?(requestId: string, answer: PlanAnswer | null): Promise<boolean> | undefined;
}

export interface RequestRegistryOptions {
  readonly sessions: Pick<SessionService, 'apply' | 'owns'>;
  readonly chat: Pick<ChatService, 'raise' | 'raiseApproval' | 'answer' | 'decline' | 'decide' | 'delivered' | 'confirm' | 'settle' | 'notTaken'> & Partial<Pick<ChatService, 'setPlan' | 'setPlanFeedback'>>;
  /** What makes a plan's request a version and a line (M22b, C10). Without it a plan's request is refused, as one main cannot keep. */
  readonly plans?: Pick<PlanService, 'raise'>;
  readonly now?: () => number;
  readonly monotonic?: () => number;
  /** Counts by kind (C34): `raised`, `answered`, `withdrawn`, `dropped`, `confirmed`, `refused`, `repeated`, `discarded`. Never a text. */
  readonly count?: (what: string) => void;
}

/** Why an answer was not taken. `not-pending`: no pending request of the session's current process opened that item (C13). */
export type RegistryAnswer = 'answered' | 'not-pending' | 'mismatch' | 'incomplete' | 'storage-failed';

/** Why a question was not declined (M100b, C31): as an answer's, by the same item and process. */
export type RegistryDecline = 'declined' | 'not-pending' | 'storage-failed';

/** Why a decision was not taken (M22, C13, C88). `not-offered`: the request's own view lists no such choice. */
export type RegistryDecision = 'decided' | 'not-pending' | 'not-offered' | 'storage-failed';

/** Why a plan's decision was not taken (M22b, C12): as an approval's, by the same line and process. */
export type RegistryPlanDecision = 'decided' | 'not-pending' | 'storage-failed';

export interface RequestRegistry {
  /** Time this turn spent held for its own requests, counting overlapping requests once. */
  waitedMs(sessionId: string, turnId: string): number;
  /** A request the adapter could place (C11). Opens one card, or refuses the request through `to`. */
  raise(sessionId: string, generation: number, event: AgentQuestionRaised | AgentApprovalRaised | AgentPlanRaised, to: Answerable): void;
  /** What the adapter says became of a request (C20, C63, C67; M22, C91). */
  resolve(sessionId: string, generation: number, event: AgentQuestionResolved | AgentApprovalResolved | AgentPlanResolved): void;
  /**
   * The user's answer to the card `itemId` (C13, C31, C78): taken only for a request held pending
   * on `generation`, the session's current one, and one that fits its questions and answers one of
   * them at least (M100b, C30). The item is written first, then `to` is told, a blank question as
   * "No answer".
   */
  answer(sessionId: string, generation: number, itemId: string, answers: readonly (GivenAnswer | null)[], to: Answerable): RegistryAnswer;
  /**
   * The user skipped the card `itemId` (M100b, C31): taken only for a question's request held
   * pending on `generation`. The item reads `dismissed` on disk first, then `to` declines the
   * request; the CLI's word that it took the reply marks nothing more, and one the process could not
   * take reads `dropped`, as an answer's does.
   */
  decline(sessionId: string, generation: number, itemId: string, to: Answerable): RegistryDecline;
  /**
   * The user's decision on the approval `itemId` (M22, C13, C49, C88): taken only for a request
   * held pending on `generation`, and only for a choice its own view lists. The outcome is written
   * first — with the grant, for the session's choice, under `processKey`, the key of the process it
   * is sent to (C81) — then `to` is told, and what it says of the write is kept as the delivery.
   */
  decide(sessionId: string, generation: number, itemId: string, choice: ApprovalChoice, to: Answerable, processKey: string): RegistryDecision;
  /**
   * The user's decision on the plan's line `itemId` (M22b, C11, C12): taken only for a request held
   * pending on `generation`. The outcome is written first, then `to` is told; the CLI's word that it
   * took the reply marks the line confirmed.
   */
  decidePlan(sessionId: string, generation: number, itemId: string, answer: PlanAnswer, to: Answerable, outcome?: PlanOutcome): RegistryPlanDecision;
  /** The session's plan's line a request holds pending now, or null (M22b, C56, C58). */
  plan(sessionId: string): string | null;
  /** The provider's end of a turn (C12): its pending requests are withdrawn; a running worker's are left. */
  turnEnded(sessionId: string, turnId: string): void;
  /** A worker's end (C12, C65): its pending requests are withdrawn. */
  workerEnded(sessionId: string, workerId: string): void;
  /** Every pending request of the session is dropped (C67): before anything the runtime ends itself, and first thing when its handle closes. */
  dropAll(sessionId: string): void;
  /** The handle of that generation closed (C75): every entry of it is let go, with no change to its item. */
  closed(sessionId: string, generation: number): void;
  /** Whether the item's request is pending on this run (C61, C76): the read's overlay. An answered one is not. */
  pending(sessionId: string, itemId: string): boolean;
  /** A pending approval's request, whole (M22, C79): what the live card shows in place of the store's cut copy. Null for any other item. */
  view(sessionId: string, itemId: string): ApprovalRequest | null;
  /** Whether anything of the session waits for the user now (M22, C2): what a change of its mode is refused for. */
  any(sessionId: string): boolean;
  /** The session's workers' pending items, each by its worker (C73). */
  waiting(sessionId: string): readonly WaitingQuestion[];
  /** The session is no longer listed: what is held of it goes, with no change to any item. */
  forget(sessionId: string): void;
}

interface Entry {
  readonly kind: RegistryKind;
  readonly key: string;
  readonly generation: number;
  readonly requestId: string;
  readonly owner: EventOwner;
  /** The turn the item is in: the owner's own, or the one that started the worker. */
  readonly turnId: string;
  readonly itemId: string;
  /** A question's, as the event carried them: what an answer must fit (C78). Empty for an approval. */
  readonly questions: readonly InteractionQuestion[];
  /** An approval's request, whole, as the event carried it (M22, C79): held while the request lives. Null for a question. */
  readonly request: ApprovalRequest | null;
  state: 'pending' | 'answered';
}

const keyOf = (generation: number, requestId: string): string => `${generation}/${requestId}`;
const workerOf = (owner: EventOwner): string | null => ('workerId' in owner ? owner.workerId : null);

export function createRequestRegistry(options: RequestRegistryOptions): RequestRegistry {
  const { sessions, chat } = options;
  const count = options.count ?? (() => undefined);
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  // Only the latest turn per session is needed; worker requests do not hold their parent turn.
  const waits = new Map<string, { turnId: string; pending: Set<string>; since: number; ms: number }>();
  /** By session, then by generation and request id: in the order they were raised. */
  const held = new Map<string, Map<string, Entry>>();

  const entriesOf = (sessionId: string): Entry[] => [...(held.get(sessionId)?.values() ?? [])];

  function remove(sessionId: string, entry: Entry): void {
    stopWaiting(sessionId, entry);
    const entries = held.get(sessionId);
    if (entries === undefined) return;
    entries.delete(entry.key);
    if (entries.size === 0) held.delete(sessionId);
  }

  /** The attention the request raised is resolved, by the id the summary knows it by. */
  function resolved(sessionId: string, entry: Entry): void {
    stopWaiting(sessionId, entry);
    sessions.apply({ type: 'request-resolved', sessionId, owner: entry.owner, requestId: entry.itemId });
  }

  function stopWaiting(sessionId: string, entry: Entry): void {
    if (!('turnId' in entry.owner)) return;
    const wait = waits.get(sessionId);
    if (wait?.turnId !== entry.turnId || !wait.pending.delete(entry.itemId)) return;
    if (wait.pending.size === 0) wait.ms += Math.max(0, monotonic() - wait.since);
  }

  /** These pending entries take an outcome together: one write, the attention resolved, and each let go. */
  function sweep(sessionId: string, entries: readonly Entry[], outcome: 'withdrawn' | 'dropped'): void {
    if (entries.length === 0) return;
    chat.settle(sessionId, entries.map((entry) => entry.itemId), outcome, outcome === 'withdrawn' ? 'turn' : undefined);
    for (const entry of entries) {
      resolved(sessionId, entry);
      remove(sessionId, entry);
      count(`${entry.kind} ${outcome}`);
    }
  }

  const pendingOf = (sessionId: string): Entry[] => entriesOf(sessionId).filter((entry) => entry.state === 'pending');

  /** A request main cannot place or keep is refused through its session, as its kind is refused (C11). */
  function refuse(event: AgentQuestionRaised | AgentApprovalRaised | AgentPlanRaised, to: Answerable): void {
    if (event.type === 'approval-raised') void to.decide(event.requestId, null);
    else if (event.type === 'plan-raised') void to.decidePlan?.(event.requestId, null);
    else to.answer(event.requestId, null);
  }

  function hold(sessionId: string, entry: Entry): void {
    const entries = held.get(sessionId) ?? new Map<string, Entry>();
    entries.set(entry.key, entry);
    held.set(sessionId, entries);
    if ('turnId' in entry.owner) {
      let wait = waits.get(sessionId);
      if (wait?.turnId !== entry.turnId) {
        wait = { turnId: entry.turnId, pending: new Set(), since: 0, ms: 0 };
        waits.set(sessionId, wait);
      }
      if (wait.pending.size === 0) wait.since = monotonic();
      wait.pending.add(entry.itemId);
    }
  }

  return {
    waitedMs(sessionId, turnId) {
      const wait = waits.get(sessionId);
      return wait?.turnId === turnId ? wait.ms + (wait.pending.size === 0 ? 0 : Math.max(0, monotonic() - wait.since)) : 0;
    },
    raise(sessionId, generation, event, to) {
      const kind: RegistryKind = event.type === 'approval-raised' ? 'approval' : event.type === 'plan-raised' ? 'plan' : 'question';
      const key = keyOf(generation, event.requestId);
      const repeated = held.get(sessionId)?.get(key);
      if (repeated !== undefined) {
        // A repeated delivery makes one card (C11): on any state. Its adapter compared it with its
        // hold before it came here (M22, C91), so an approval whose view differs is a defect:
        // counted, and refused through the session rather than left to an earlier card's decision.
        if (event.type === 'approval-raised' && (repeated.request === null || JSON.stringify(repeated.request) !== JSON.stringify(event.request))) {
          count('approval repeated (changed: a defect)');
          refuse(event, to);
          return;
        }
        count(`${kind} repeated`);
        return;
      }
      // A plan is the turn's own (M22b, C10): a worker's is none.
      const owner: EventOwner = event.type === 'plan-raised' || event.workerId === undefined ? { turnId: event.turnId } : { workerId: event.workerId };
      if (!sessions.owns(sessionId, owner)) {
        // No request the CLI made waits on nothing (C11): refused through the session, as one it cannot show is.
        count(`${kind} discarded (${'turnId' in owner ? 'stale turn' : 'stale worker'})`);
        refuse(event, to);
        return;
      }
      // Held from the moment its card is written, before the card's push (C76): a read made from
      // inside that push finds the request pending, as every later one does — and an approval's
      // whole view, which that push lays over the store's cut copy (M22, C79).
      const common = { key, generation, requestId: event.requestId, owner, turnId: event.turnId, state: 'pending' as const };
      const at = { turnId: event.turnId, workerId: event.type === 'plan-raised' ? null : event.workerId ?? null, providerItemId: event.sourceId };
      const itemId = event.type === 'approval-raised'
        ? chat.raiseApproval(sessionId, { ...at, request: event.request }, (kept) => { hold(sessionId, { ...common, kind: 'approval', itemId: kept, questions: [], request: event.request }); })
        : event.type === 'plan-raised'
          // Its version first, then its line (M22b, C10, C62): the plan service writes both.
          ? options.plans?.raise(sessionId, { turnId: event.turnId, sourceId: event.sourceId, text: event.text }, (kept) => { hold(sessionId, { ...common, kind: 'plan', itemId: kept, questions: [], request: null }); }) ?? null
          : chat.raise(sessionId, { ...at, questions: event.questions, cut: event.cut }, (kept) => { hold(sessionId, { ...common, kind: 'question', itemId: kept, questions: event.questions, request: null }); });
      if (itemId === null) {
        // A card that cannot be kept cannot be shown (C33).
        count(`${kind} refused (not kept)`);
        refuse(event, to);
        return;
      }
      // Counted by its questions (M100b, C24, C25): the number alone reaches the summary.
      sessions.apply({ type: 'request-raised', sessionId, owner, requestId: itemId, kind, count: event.type === 'question-raised' ? event.questions.length : 1 });
      // fat-g's words for the kind (C15; M22, C78; M22b, C27): no text of the request's goes to the summary.
      count(`${kind} raised`);
    },

    resolve(sessionId, generation, event) {
      const kind: RegistryKind = event.type === 'approval-resolved' ? 'approval' : event.type === 'plan-resolved' ? 'plan' : 'question';
      const entry = held.get(sessionId)?.get(keyOf(generation, event.requestId));
      if (entry === undefined || entry.kind !== kind) { count(`${kind} ${event.reason} for no request`); return; }
      if (event.reason === 'confirmed' && entry.state === 'answered') {
        chat.confirm(sessionId, entry.itemId);
        remove(sessionId, entry);
        count(`${kind} confirmed`);
        return;
      }
      if ((event.reason === 'withdrawn' || event.reason === 'changed') && entry.state === 'pending') {
        // The CLI took it back while its owner went on (C12) — or sent it again under its id with
        // another payload, which its adapter refused, letting this one go (M22, C91).
        chat.settle(sessionId, [entry.itemId], 'withdrawn', event.reason === 'changed' ? 'changed' : 'request');
        resolved(sessionId, entry);
        remove(sessionId, entry);
        count(`${kind} ${event.reason === 'changed' ? 'withdrawn (changed)' : 'withdrawn'}`);
        return;
      }
      if (event.reason === 'dropped') {
        if (entry.state === 'pending') {
          // Still held unanswered when its process was lost (C67).
          chat.settle(sessionId, [entry.itemId], 'dropped');
          resolved(sessionId, entry);
        } else if (entry.kind === 'approval') {
          // The process could not take the decision (M22, C12, C92): it stands as decided, and said not delivered.
          chat.delivered(sessionId, entry.itemId, false);
        } else if (entry.kind === 'plan') {
          // The process could not take the plan's decision (M22b, C11): it stands as the user took it.
        } else {
          // The one thing that drops an answered item: its process could not take the answer (C14, C70).
          chat.notTaken(sessionId, entry.itemId);
        }
        remove(sessionId, entry);
        count(`${kind} dropped (${entry.state})`);
        return;
      }
      // A withdrawal after an answer, a confirmation of nothing answered: the first to arrive settled it (C14).
      count(`${kind} ${event.reason} ignored (${entry.state})`);
    },

    answer(sessionId, generation, itemId, answers, to) {
      const entry = entriesOf(sessionId).find((candidate) => candidate.itemId === itemId && candidate.generation === generation);
      if (entry === undefined || entry.kind !== 'question' || entry.state !== 'pending') return 'not-pending';
      if (!fits(entry.questions, answers)) return 'mismatch';
      // One question answered at least (M100b, C30): a card with none is skipped, never submitted.
      if (noneAnswered(answers)) return 'incomplete';
      // On disk before it is sent (C33): final on fat-g's side whatever the CLI does next (C14). The
      // item keeps a blank question as none; the CLI's `answers` names each question (C45), a blank
      // one as "No answer" (M100b, C30).
      const written = chat.answer(sessionId, itemId, keptAnswers(entry.questions, answers));
      if (written !== 'answered') return written;
      entry.state = 'answered';
      stopWaiting(sessionId, entry);
      to.answer(entry.requestId, sentAnswers(answers));
      resolved(sessionId, entry);
      count('question answered');
      return 'answered';
    },

    decline(sessionId, generation, itemId, to) {
      const entry = entriesOf(sessionId).find((candidate) => candidate.itemId === itemId && candidate.generation === generation);
      if (entry === undefined || entry.kind !== 'question' || entry.state !== 'pending') return 'not-pending';
      // On disk before it is sent, as an answer is (C33): skipped on fat-g's side whatever the CLI does next.
      const written = chat.decline(sessionId, itemId);
      if (written !== 'declined') return written;
      // Replied to: the CLI's word that it took the reply, or a drop, lets it go (C75).
      entry.state = 'answered';
      stopWaiting(sessionId, entry);
      to.decline(entry.requestId);
      resolved(sessionId, entry);
      count('question declined');
      return 'declined';
    },

    decide(sessionId, generation, itemId, choice, to, processKey) {
      const entry = entriesOf(sessionId).find((candidate) => candidate.itemId === itemId && candidate.generation === generation);
      if (entry === undefined || entry.kind !== 'approval' || entry.request === null || entry.state !== 'pending') return 'not-pending';
      // Only what the request's own view lists (C88): the page cannot invent a choice or broaden a scope.
      if (!entry.request.choices.includes(choice)) return 'not-offered';
      const covers = choice === 'approve-session' ? entry.request.grant?.covers ?? null : null;
      if (choice === 'approve-session' && covers === null) return 'not-offered';
      // On disk before it is sent (C12, C49): the outcome, and the grant with the process it is
      // sent to, in the one write. A failed write sends nothing.
      const written = chat.decide(sessionId, itemId, CHOICE_OUTCOMES[choice], covers === null ? null : { covers, processKey });
      if (written !== 'decided') return written;
      entry.state = 'answered';
      stopWaiting(sessionId, entry);
      const sent = to.decide(entry.requestId, choice);
      // Whether the reply's write went (C12, C92): the session's word, kept with the decision. A
      // session that says nothing leaves the delivery unknown, as a loss before the write does.
      void sent?.then((went) => { chat.delivered(sessionId, itemId, went); }, () => undefined);
      resolved(sessionId, entry);
      count(`approval decided (${choice})`);
      return 'decided';
    },

    decidePlan(sessionId, generation, itemId, answer, to, outcome) {
      const entry = entriesOf(sessionId).find((candidate) => candidate.itemId === itemId && candidate.generation === generation);
      if (entry === undefined || entry.kind !== 'plan' || entry.state !== 'pending') return 'not-pending';
      // On disk before it is sent (C12): the decision stands on fat-g's side whatever the CLI does next.
      // A request retired by the plan's workflow (decision 0029) is written as why: answered as Cancel, decided by no one here.
      const at = now();
      const change = outcome === undefined ? { outcome: DECISION_OUTCOMES[answer.kind], decidedAt: at } : { outcome, ...(outcome === 'cancelled' || outcome === 'left' ? { decidedAt: at } : { settledAt: at }) };
      // A feedback is kept as the user's message after the line, as it is sent (the maintainer).
      const written = (answer.kind === 'feedback' && outcome === undefined && chat.setPlanFeedback !== undefined ? chat.setPlanFeedback(sessionId, itemId, change, answer.text) : chat.setPlan?.(sessionId, itemId, 'pending', change)) ?? false;
      if (written === null) return 'not-pending';
      if (!written) return 'storage-failed';
      entry.state = 'answered';
      stopWaiting(sessionId, entry);
      void to.decidePlan?.(entry.requestId, answer);
      resolved(sessionId, entry);
      // Execute and feedback carry the turn on; Cancel ends it (C11, C77).
      count(`plan decided (${answer.kind})`);
      return 'decided';
    },

    plan: (sessionId) => pendingOf(sessionId).find((entry) => entry.kind === 'plan')?.itemId ?? null,

    turnEnded(sessionId, turnId) {
      sweep(sessionId, pendingOf(sessionId).filter((entry) => 'turnId' in entry.owner && entry.owner.turnId === turnId), 'withdrawn');
    },

    workerEnded(sessionId, workerId) {
      sweep(sessionId, pendingOf(sessionId).filter((entry) => workerOf(entry.owner) === workerId), 'withdrawn');
    },

    dropAll(sessionId) {
      sweep(sessionId, pendingOf(sessionId), 'dropped');
    },

    closed(sessionId, generation) {
      // Its holds went with the process, so no mark can come (C75): the card says so once what
      // carried the answer is over (C68), and the item is not touched.
      for (const entry of entriesOf(sessionId)) if (entry.generation === generation) remove(sessionId, entry);
    },

    pending: (sessionId, itemId) => entriesOf(sessionId).some((entry) => entry.itemId === itemId && entry.state === 'pending'),

    view: (sessionId, itemId) => entriesOf(sessionId).find((entry) => entry.itemId === itemId && entry.state === 'pending')?.request ?? null,

    any: (sessionId) => pendingOf(sessionId).length > 0,

    waiting: (sessionId) => pendingOf(sessionId).flatMap((entry) => { const workerId = workerOf(entry.owner); return workerId === null || entry.kind === 'plan' ? [] : [{ workerId, itemId: entry.itemId, kind: entry.kind }]; }),

    forget(sessionId) {
      held.delete(sessionId);
      waits.delete(sessionId);
    },
  };
}
