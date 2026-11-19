// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The plan workflow coordinator (decision 0029): one authoritative workflow for each plan, shared by
// every chat that takes part in it. The chats may offer the same actions; main admits one operation
// at a time — a review, a revision, an implementation — reserved here, synchronously, before anything
// is made or sent, against the revision the page drew its controls from.
//
//   plans:decide   ─► checks ─► the operation written into `plan.json` ─► the other chats' requests
//                     retired where it is carried out ─► the chat's own native decision, or a turn
//                     carrying the version's whole text ─► refused: ready again
//   a version made ─► `plan.json`'s commit made it ready ─► older lines superseded, their requests retired
//   a turn's end   ─► a revision with no version: ready on the version before; an implementation that
//                     ended well, its workers stopped and no card waiting: implemented, then deleted
//   Discard        ─► cancelled in `plan.json` ─► every request retired and settled ─► deleted
//   a launch       ─► what a crash or a quit left, recovered from `plan.json` and the conversations
//
// Participation is the workflow's alone, apart from a provider's request: retiring a chat's pending
// request leaves its part in the plan, so its panel shows the newest version, and its next decision
// sends that version's whole text. A plan carried out or discarded is deleted (the maintainer);
// where it was implemented stays in each chat's conversation as a note.
//
// Each change written is shown in every chat of the plan at its push (the maintainer):
// PLAN READY in all of them while it is ready, and while one chat or the reviewer holds it, what the
// others wait on — a kind alone, in each one's summary.
//
// Electron-free, and no provider is named here: the plan store, the conversation store, the chat
// service and the runtime are handed in, the runtime late bound since it asks this coordinator
// before it sends. Nothing of a plan's text or title is logged: kinds and counts alone.
import { MAX_PLAN_TEXT, type PlanDecideRequest, type PlanDecideResult, type PlanOutcome, planFeedback, planPrompt, planToken } from '@shared/contracts/plans';
import type { PlanWait, TurnOutcome } from '@shared/contracts/sessions';
import { isWorkflowActive, type SessionWorkflow, type WorkflowBusy, type WorkflowPush, type WorkflowState, type WorkflowView } from '@shared/contracts/workflow';
import type { ConversationStore } from '../conversations/store';
import type { PlanFileRecord, WorkflowOperationRecord, WorkflowRecord } from '../plans/format';
import type { PlanStore } from '../plans/store';
import type { SessionRecord } from '../records/format';
import type { ChatService } from './chat-service';
import type { PlanService } from './plans';
import type { SessionRuntime } from './runtime';

/** What the coordinator asks of the runtime: its sends, its requests and its sessions' running state. Late bound. */
export interface WorkflowRuntime extends Pick<SessionRuntime, 'planLine' | 'decidePlan' | 'sendComposed' | 'stop'> {
  /** Closes a plan's request the chat holds, as Cancel answers it, its line settled as `outcome`. False where none could be. */
  retire(sessionId: string, itemId: string, outcome: PlanOutcome): boolean;
  /** Resolves once the session runs nothing: no turn, no worker. */
  untilIdle(sessionId: string): Promise<void>;
  /** Plan released in the chat's saved draft. */
  releasePlan(sessionId: string): void;
  /** PLAN READY raised in the chat, or let go. */
  planReady(sessionId: string, waiting: boolean, flash?: false): void;
  /** What the chat waits on while another holds its plan, or null. */
  planWait(sessionId: string, wait: PlanWait | null): void;
  /** The chat's mode reads only, and carries out no plan. */
  readsOnly(sessionId: string): boolean;
}

export interface WorkflowHost {
  record(sessionId: string): SessionRecord | undefined;
  /** A listed session's name; null where it is not listed. */
  name(sessionId: string): string | null;
  running(sessionId: string): boolean;
  quitting(): boolean;
}

/** What a review's own service tells the coordinator, and asks of it: late bound, as the runtime. */
export interface WorkflowReviews {
  /** The review was closed — cancelled — for its reviewer's removal, shelving or completion: the service's own write. */
  cancelFor(planId: string, reviewId: string): Promise<void>;
}

export interface WorkflowOptions {
  /** A newly completed version has become actionable; never called during recovery or joining. */
  readonly onReady?: (planId: string, version: number) => void;
  readonly store: Pick<PlanStore, 'get' | 'all' | 'setWorkflow' | 'read' | 'remove' | 'review'>;
  readonly conversations: Pick<ConversationStore, 'status' | 'planWaiters' | 'item' | 'turn' | 'turnAnswer' | 'planNote' | 'setPlanNote'>;
  readonly chat: Pick<ChatService, 'setPlan'>;
  /** The plan service, told of each line settled here, so that it waits no more: late bound. */
  readonly lines?: () => Pick<PlanService, 'settled'> | undefined;
  readonly host: WorkflowHost;
  readonly runtime: () => WorkflowRuntime | undefined;
  readonly reviews?: () => WorkflowReviews | undefined;
  /** Ids alone, to the Main window alone. */
  readonly push?: (push: WorkflowPush) => void;
  /** A plan was deleted: the page reads it again, and finds it gone. */
  readonly removed?: (planId: string) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Twelve hex digits, for a block's token. */
  readonly token?: () => string;
  /** Counts and kinds alone. */
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

/** Why a chat's own prompt waits: its plan's decision, a review or a revision holds the plan. */
export type WorkflowBlock = 'plan-pending';

/** What kind of send asks: typed by the user (a queued one included), or an async card's answer. Composed sends are the coordinator's own. */
export type SendKind = { readonly kind: 'typed'; readonly plan: boolean } | { readonly kind: 'answer' };

/** A reservation held while a review's session is made, before anything durable is written. */
export interface WorkflowReservation {
  readonly planId: string;
  readonly id: string;
}

export interface WorkflowCoordinator {
  /** A plan's workflow as the page draws it; null for a plan not held. */
  view(planId: string): WorkflowView | null;
  /** A chat's part in a plan's workflow, or the note a plan carried out left it; null for none. */
  forSession(sessionId: string): SessionWorkflow | null;
  /** Whether a send of the chat's own waits on its plan, by its kind; null where it may go. */
  admit(sessionId: string, send: SendKind): WorkflowBlock | null;
  /** The chat's plan is ready, so that a change of mode may be taken once its request is retired: the plan's id, or null. */
  readyIn(sessionId: string): string | null;
  /** The request the chat holds on its plan, retired so its mode can change; resolves once its turn has ended. */
  retireForMode(sessionId: string): Promise<void>;
  decide(request: PlanDecideRequest): Promise<PlanDecideResult>;
  /** The plan service's chain: may this session's turn write a version of this plan now? */
  admits(planId: string, sessionId: string, turnId: string): boolean;
  /** A version of the plan completed: its commit made the workflow ready on it in the same write. */
  versionMade(planId: string, version: number): void;
  /** A plan brought into a chat, or a new plan its maker takes part in: the chat leaves any other plan it went on beside. */
  joined(planId: string, sessionId: string): void;

  // ── A review's (decision 0029, with the review service) ──
  /** Reserves a review's start from a participant: `locked`, `stale` or `not-pending` where it cannot start. */
  reserveReview(planId: string, sessionId: string, revision: number, version: number): WorkflowReservation | 'locked' | 'not-pending';
  /** The review exists: the plan is under review, held by its reviewer. False where the write failed. */
  reviewStarted(reservation: WorkflowReservation, reviewId: string, reviewerId: string): boolean;
  /** A reservation let go of. */
  release(reservation: WorkflowReservation): void;
  /** Reserves an integration's hand-off from a live review. */
  reserveHandOff(planId: string, reviewId: string): WorkflowReservation | 'locked';
  /** The integration is written: the plan is being revised by its target, which takes part in it. */
  handOff(reservation: WorkflowReservation, targetId: string, turnId: string): boolean;
  /** The review closed, failed, or its integration's send was refused: the plan is ready again on its version. */
  reviewEnded(planId: string, reviewId: string): void;

  // ── The runtime's hooks ──
  /** A prompt was accepted, before it is sent: `answered`, the async card it answers. */
  accepted(sessionId: string, turnId: string, answered: string | null): void;
  turnEnded(sessionId: string, turnId: string, outcome: TurnOutcome): void;
  /** The session runs nothing any more. */
  idle(sessionId: string): void;
  /** An async card was dismissed. */
  cardSettled(sessionId: string, itemId: string): void;
  /** The session's process ended. */
  lost(sessionId: string): void;
  /** The session is no longer listed. */
  forget(sessionId: string): void;
  /** The session was marked Done, or shelved. */
  closed(sessionId: string, how: 'done' | 'shelved'): void;
  /** Every request and line waiting on these plans settled, for their removal. Answers how many. */
  settleForRemoval(planIds: readonly string[]): Promise<number>;
  /** At a launch, once the runtime and the services are made. */
  launched(): Promise<void>;
  /** Resolves once nothing the coordinator started is under way: for tests. */
  settled(): Promise<void>;
  counts(): Readonly<Record<string, number>>;
}

const hex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** What a chat of the plan waits on while another holds it in each state; an interrupted implementation is still waited on. */
const WAITS: Partial<Record<WorkflowState, PlanWait>> = { reviewing: 'review', revising: 'revision', implementing: 'implementation', interrupted: 'implementation' };

export function createWorkflowCoordinator(options: WorkflowOptions): WorkflowCoordinator {
  const { store, conversations, chat, host } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const token = options.token ?? hex;
  const log = options.log ?? console;
  const tally = new Map<string, number>();
  /** Work under way on a plan that every decision waits for, by plan. */
  const busy = new Map<string, { readonly id: string; readonly kind: WorkflowBusy }>();
  /** What the coordinator started and has not finished: what `settled` waits for. */
  const running = new Set<Promise<unknown>>();
  /** Each implementation's last turn and how it ended, by operation: what decides it implemented once its session is idle. */
  const ended = new Map<string, { readonly turnId: string; readonly outcome: TurnOutcome }>();

  function count(what: string): void {
    const total = (tally.get(what) ?? 0) + 1;
    tally.set(what, total);
    if (/^10*$/.test(String(total))) log.info(`[workflow] ${what}, ${total} so far`);
  }

  function track<T>(work: Promise<T>): Promise<T> {
    running.add(work);
    void work.finally(() => running.delete(work)).catch(() => undefined);
    return work;
  }

  const runtime = (): WorkflowRuntime | undefined => options.runtime();
  const plans = (): readonly PlanFileRecord[] => { try { return store.all(); } catch { return []; } };
  const holderOf = (workflow: WorkflowRecord): string | null => workflow.operation?.sessionId ?? null;

  /** Everyone a change of the plan's workflow may read otherwise for: its chats, its holder, and any named. Each chat shows it. */
  function push(plan: PlanFileRecord | null, planId: string, also: readonly string[] = [], silentSession?: string): void {
    const ids = new Set([...(plan?.workflow.participants ?? []), ...(plan === null ? [] : [holderOf(plan.workflow)].flatMap((id) => (id === null ? [] : [id]))), ...also]);
    show(plan, also, silentSession);
    options.push?.({ planId, sessionIds: [...ids] });
  }

  /**
   * What each chat of the plan shows (the maintainer): PLAN READY in every one while the
   * plan is ready; while a chat or the reviewer holds it, what the others wait on, and nothing in the
   * chat carrying it out, which shows its own turn; nothing once it is carried out or discarded, nor
   * in a named chat that no longer takes part in it.
   */
  function show(plan: PlanFileRecord | null, also: readonly string[], silentSession?: string): void {
    const live = runtime();
    if (live === undefined) return;
    const participants = plan?.workflow.participants ?? [];
    const holder = plan === null ? null : holderOf(plan.workflow);
    for (const sessionId of participants) {
      live.planReady(sessionId, plan?.workflow.state === 'ready', sessionId === silentSession ? false : undefined);
      live.planWait(sessionId, plan === null || sessionId === holder ? null : WAITS[plan.workflow.state] ?? null);
    }
    quiet(also.filter((sessionId) => !participants.includes(sessionId)));
  }

  /** Neither PLAN READY nor a wait in each chat named. */
  function quiet(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      runtime()?.planReady(sessionId, false);
      runtime()?.planWait(sessionId, null);
    }
  }

  /** One change of a plan's workflow, written whole; null where its plan is gone or the write failed, which is counted. */
  function write(planId: string, change: (workflow: WorkflowRecord, plan: PlanFileRecord) => WorkflowRecord | null): PlanFileRecord | null {
    try {
      return store.setWorkflow(planId, (plan) => {
        const next = change(plan.workflow, plan);
        return next === null ? null : { ...next, revision: plan.workflow.revision + 1 };
      });
    } catch {
      count('workflow not written (storage)');
      return null;
    }
  }

  function workflowView(plan: PlanFileRecord): WorkflowView {
    const { workflow } = plan;
    const op = workflow.operation;
    return {
      planId: plan.id, state: workflow.state, revision: workflow.revision, version: workflow.version, participants: [...workflow.participants],
      holder: op === null ? null : { sessionId: op.sessionId, chat: host.record(op.sessionId) === undefined ? null : host.name(op.sessionId) ?? '' },
      operation: op?.kind ?? null,
      reviewId: op?.kind === 'review' ? op.reviewId : null,
      busy: busy.get(plan.id)?.kind ?? null,
    };
  }

  /**
   * The plan a chat takes part in: the one whose operation it holds first, then one still in play,
   * then one on its way to deletion. A chat takes part in one plan in play at a time; a new plan it
   * makes takes it out of the one it went on beside, as soon as that plan is begun.
   */
  function participantPlan(sessionId: string): PlanFileRecord | null {
    const taking = plans().filter((plan) => plan.workflow.participants.includes(sessionId));
    return taking.find((plan) => holderOf(plan.workflow) === sessionId && isWorkflowActive(plan.workflow.state))
      ?? taking.find((plan) => isWorkflowActive(plan.workflow.state))
      ?? taking[0] ?? null;
  }
  /** The plan a chat reviews now. */
  const reviewedBy = (sessionId: string): PlanFileRecord | null => plans().find((plan) => plan.workflow.state === 'reviewing' && plan.workflow.operation?.sessionId === sessionId) ?? null;
  /** The plans whose operation the chat holds. */
  const heldBy = (sessionId: string): PlanFileRecord[] => plans().filter((plan) => plan.workflow.operation?.sessionId === sessionId && isWorkflowActive(plan.workflow.state));

  function lineOf(sessionId: string, planId: string): { readonly itemId: string; readonly turnId: string; readonly version: number; readonly request: boolean } | null {
    const line = runtime()?.planLine(sessionId) ?? null;
    return line !== null && line.planId === planId ? line : null;
  }

  /**
   * Every line still waiting on the plan, in every chat, settled as `outcome` where `which` takes them:
   * written here and now, and those a request holds retired through their process, the turn they wait
   * in ending. `done` resolves once each retired request's session runs nothing; null where none was retired.
   */
  function settleLines(planId: string, outcome: PlanOutcome, which: (row: { readonly conversationId: string; readonly version: number }) => boolean): { readonly settled: number; readonly done: Promise<void> | null } {
    let rows: ReturnType<ConversationStore['planWaiters']>;
    try { rows = conversations.status().kind === 'ok' ? conversations.planWaiters(planId) : []; } catch { count('lines not read (storage)'); return { settled: 0, done: null }; }
    const waits: Promise<void>[] = [];
    let settled = 0;
    for (const row of rows) {
      if (!which(row)) continue;
      const held = runtime()?.planLine(row.conversationId) ?? null;
      if (row.request && held?.itemId === row.itemId && held.request) {
        if (runtime()?.retire(row.conversationId, row.itemId, outcome) === true) {
          settled += 1;
          waits.push(runtime()?.untilIdle(row.conversationId) ?? Promise.resolve());
          count(`request retired (${outcome})`);
          continue;
        }
      }
      const at = now();
      if (chat.setPlan(row.conversationId, row.itemId, ['pending', 'writing'], { outcome, ...(outcome === 'cancelled' || outcome === 'left' ? { decidedAt: at } : { settledAt: at }) }) === true) {
        settled += 1;
        options.lines?.()?.settled(row.conversationId, row.itemId);
      }
    }
    return { settled, done: waits.length === 0 ? null : Promise.all(waits).then(() => undefined) };
  }

  /** The same, resolving once every retired request's turn has ended: what an operation waits for before it goes on. */
  async function settleAll(planId: string, outcome: PlanOutcome, which: (row: { readonly conversationId: string; readonly version: number }) => boolean): Promise<number> {
    const { settled, done } = settleLines(planId, outcome, which);
    if (done !== null) await done;
    return settled;
  }

  /** PLAN READY let go of, and Plan released, in each chat named. */
  function letGo(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      runtime()?.planReady(sessionId, false);
      runtime()?.releasePlan(sessionId);
    }
  }

  /** What a decision's refusal says, with the workflow as it is now. */
  const refusal = (reason: 'stale' | 'locked' | 'not-pending', plan: PlanFileRecord): PlanDecideResult => ({ status: 'refused', reason, workflow: workflowView(plan) });

  // ── Endings (decision 0029; the maintainer) ──────────────────────────────────────

  /**
   * A plan carried out (its `implemented` written): each chat that took part keeps where it was, its
   * Plan released, and the plan is deleted with its reviews. A launch that finds it so does the same.
   */
  async function finishImplemented(plan: PlanFileRecord): Promise<void> {
    const executor = plan.workflow.operation?.sessionId ?? null;
    const at = now();
    for (const sessionId of plan.workflow.participants) {
      if (executor !== null && host.record(sessionId) !== undefined) {
        try { conversations.setPlanNote(sessionId, { sessionId: executor, at }); } catch { count('note not written (storage)'); }
      }
    }
    letGo(plan.workflow.participants);
    await settleAll(plan.id, 'elsewhere', () => true);
    remove(plan, executor === null ? [] : [executor]);
    count('plan implemented');
  }

  /** A plan discarded (its `cancelled` written): every request on it retired, every line settled, Plan released, the plan deleted. */
  async function finishCancelled(plan: PlanFileRecord): Promise<number> {
    busy.set(plan.id, { id: newId(), kind: 'cancelling' });
    push(plan, plan.id);
    try {
      const settled = await settleAll(plan.id, 'cancelled', () => true);
      letGo(plan.workflow.participants);
      remove(plan);
      count('plan discarded');
      return settled;
    } finally {
      busy.delete(plan.id);
    }
  }

  function remove(plan: PlanFileRecord, also: readonly string[] = []): void {
    let outcome: ReturnType<PlanStore['remove']> | null = null;
    try { outcome = store.remove(plan.id); } catch { count('plan not deleted (storage)'); }
    // A version still written keeps it until a launch finds its state.
    if (outcome === 'writing') count('plan not deleted (writing)');
    push(plan, plan.id, also);
    options.removed?.(plan.id);
  }

  /** An implementation's last turn ended well: implemented once its session runs nothing and no card of its turns waits. */
  function evaluate(plan: PlanFileRecord): void {
    const op = plan.workflow.operation;
    if (plan.workflow.state !== 'implementing' || op === null || op.kind !== 'implementation') return;
    const last = ended.get(op.id);
    if (last === undefined || last.outcome !== 'completed' || last.turnId !== op.turns.at(-1)) return;
    if (host.running(op.sessionId)) return;
    if (cardWaits(op)) return;
    const written = write(plan.id, (workflow) => (workflow.operation?.id === op.id && workflow.state === 'implementing' ? { ...workflow, state: 'implemented' } : null));
    if (written === null || written.workflow.state !== 'implemented') return;
    ended.delete(op.id);
    void track(finishImplemented(written));
  }

  /** A question card still open in one of the operation's turns: what may yet continue it. */
  function cardWaits(op: WorkflowOperationRecord): boolean {
    try { return op.turns.some((turnId) => (conversations.turnAnswer(op.sessionId, turnId)?.card ?? null) !== null); } catch { return false; }
  }

  /** A revision that ended with no complete version: ready again on the version before, its unfinished text kept. */
  function endRevision(plan: PlanFileRecord, op: WorkflowOperationRecord): void {
    const written = write(plan.id, (workflow) => (workflow.operation?.id === op.id && workflow.state === 'revising' ? { ...workflow, state: 'ready', operation: null } : null));
    if (written === null) return;
    count('revision ended without a version');
    push(written, plan.id);
  }

  /**
   * The chat carrying out an implementation is removed or marked Done, or a launch no longer finds it,
   * and nothing says it succeeded: the plan is ready again on its version in the chats left, for any of
   * them to carry out or discard; with none left it stays among the project's plans, to be brought
   * again (the maintainer). That chat takes part in it no more.
   */
  const released = (op: WorkflowOperationRecord) => (workflow: WorkflowRecord): WorkflowRecord | null => (
    workflow.operation?.id === op.id && (workflow.state === 'implementing' || workflow.state === 'interrupted')
      ? { ...workflow, state: 'ready', operation: null, participants: workflow.participants.filter((one) => one !== op.sessionId) }
      : null
  );

  function release(plan: PlanFileRecord, op: WorkflowOperationRecord): void {
    const written = write(plan.id, released(op));
    if (written === null || written.workflow.state !== 'ready') return;
    ended.delete(op.id);
    letGo([op.sessionId]);
    count('implementation released');
    push(written, plan.id, [op.sessionId]);
  }

  function interrupt(plan: PlanFileRecord, op: WorkflowOperationRecord): void {
    const written = write(plan.id, (workflow) => (workflow.operation?.id === op.id && workflow.state === 'implementing' ? { ...workflow, state: 'interrupted' } : null));
    if (written === null) return;
    count('implementation interrupted');
    push(written, plan.id);
  }

  /** Discard: `cancelled` written first, then everything it settles, then the plan deleted. */
  async function discard(plan: PlanFileRecord): Promise<PlanDecideResult> {
    const written = write(plan.id, (workflow) => ({ ...workflow, state: 'cancelled', operation: null }));
    if (written === null) return { status: 'refused', reason: 'storage-failed' };
    await track(finishCancelled(written));
    return { status: 'decided' };
  }

  // ── Decisions (decision 0029) ─────────────────────────────────────────────────────────────────

  /**
   * Execute or feedback in a chat: its native decision where it holds one on the version, else a turn
   * carrying the version's whole text. The operation is written with the turn first, so the turn that
   * carries it out is known before anything is sent.
   */
  async function carry(plan: PlanFileRecord, sessionId: string, decision: 'execute' | 'feedback', text: string | null, op: WorkflowOperationRecord): Promise<PlanDecideResult> {
    const version = plan.workflow.version ?? 0;
    const line = lineOf(sessionId, plan.id);
    const usable = line !== null && line.version === version;
    const turnId = usable && line.request ? line.turnId : newId();
    const noted = write(plan.id, (workflow) => (workflow.operation?.id === op.id ? { ...workflow, operation: { ...op, turns: [turnId] } } : null));
    if (noted === null) return { status: 'refused', reason: 'storage-failed' };
    const live = runtime();
    if (live === undefined) return { status: 'refused', reason: 'busy' };
    if (usable) return live.decidePlan(sessionId, line.itemId, decision, text ?? undefined, line.request ? undefined : turnId);
    // A chat that holds no decision on this version: the version's whole text, never its author's conversation.
    const read = store.read(plan.id, version, 0, MAX_PLAN_TEXT);
    if (read === null || read.state !== 'complete') return { status: 'refused', reason: 'storage-failed' };
    const prompt = planPrompt({ decision, planId: plan.id, version, text: read.text, feedback: text, token: planToken(read.text + (text ?? ''), token) });
    const sent = await live.sendComposed(sessionId, { prompt, turnId, messageId: newId(), plan: decision === 'feedback', fields: { planId: plan.id, version, intent: decision === 'execute' ? 'execute' : 'revise' }, names: false });
    return sent.status === 'accepted' ? { status: 'decided' } : sent;
  }

  /** An operation's start refused: the plan is ready again, where the operation is still its. */
  function undo(planId: string, op: WorkflowOperationRecord): void {
    const written = write(planId, (workflow) => (workflow.operation?.id === op.id ? { ...workflow, state: 'ready', operation: null } : null));
    if (written !== null) push(written, planId);
  }

  async function decide(request: PlanDecideRequest): Promise<PlanDecideResult> {
    const { sessionId, planId, decision } = request;
    if (host.quitting()) return { status: 'refused', reason: 'busy' };
    if (host.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
    const plan = store.get(planId);
    if (plan === null) return { status: 'refused', reason: 'unknown-plan' };
    const { workflow } = plan;
    if (!workflow.participants.includes(sessionId)) return { status: 'refused', reason: 'not-participant' };
    if (busy.has(planId)) return refusal('locked', plan);
    if (request.revision !== workflow.revision) return refusal('stale', plan);
    // Discard is offered where the plan is ready, and where its implementation was interrupted.
    if (decision === 'cancel') {
      if (workflow.state !== 'ready' && workflow.state !== 'interrupted') return refusal('locked', plan);
      count('decided (discard)');
      return discard(plan);
    }
    if (workflow.state !== 'ready') return refusal('locked', plan);
    if (decision === 'leave') return leave(plan, sessionId);
    const version = workflow.version;
    if (version === null) return refusal('not-pending', plan);
    if (decision === 'execute' && runtime()?.readsOnly(sessionId) === true) return { status: 'refused', reason: 'reads-only' };
    const hash = plan.versions.find((one) => one.version === version)?.hash ?? null;
    const op: WorkflowOperationRecord = { id: newId(), kind: decision === 'execute' ? 'implementation' : 'revision', sessionId, version, hash, turns: [], reviewId: null, at: now(), unknown: {} };
    // Reserved in one write, before anything awaits: a competing decision finds it taken.
    const reserved = write(planId, (held) => (held.state === 'ready' && held.revision === request.revision ? { ...held, state: decision === 'execute' ? 'implementing' : 'revising', operation: op } : null));
    if (reserved === null) return { status: 'refused', reason: 'storage-failed' };
    if (reserved.workflow.operation?.id !== op.id) return refusal('stale', reserved);
    push(reserved, planId);
    count(`decided (${decision})`);
    if (decision === 'execute') {
      // Every other chat's request on the plan is retired first, and its turn ended (decision 0029).
      const others = reserved.workflow.participants.filter((one) => one !== sessionId);
      busy.set(planId, { id: op.id, kind: 'retiring' });
      push(reserved, planId);
      try { await track(settleAll(planId, 'elsewhere', (row) => row.conversationId !== sessionId)); } finally { busy.delete(planId); }
      letGo(others);
    }
    // The user's feedback goes with fat-g's request, whatever route carries it (the maintainer).
    const answer = await carry(reserved, sessionId, decision, 'text' in request ? planFeedback(request.text) : null, op);
    if (answer.status !== 'decided') { undo(planId, op); return answer; }
    if (decision === 'execute') letGo([sessionId]);
    else runtime()?.planReady(sessionId, false);
    push(store.get(planId), planId);
    return answer;
  }

  /** Leave plan mode, keep plan: the chat leaves the plan, its request retired and its line settled `left`; the plan stays for the others. */
  async function leave(plan: PlanFileRecord, sessionId: string): Promise<PlanDecideResult> {
    const written = write(plan.id, (workflow) => ({ ...workflow, participants: workflow.participants.filter((one) => one !== sessionId) }));
    if (written === null) return { status: 'refused', reason: 'storage-failed' };
    await track(settleAll(plan.id, 'left', (row) => row.conversationId === sessionId));
    letGo([sessionId]);
    push(written, plan.id, [sessionId]);
    count('left');
    return { status: 'decided' };
  }

  /** The chat leaves the plans it took part in that went on beside it, with nothing of its own holding them. */
  function detach(sessionId: string, except: string | null): void {
    for (const plan of plans()) {
      if (plan.id === except || !plan.workflow.participants.includes(sessionId) || holderOf(plan.workflow) === sessionId) continue;
      const written = write(plan.id, (workflow) => ({ ...workflow, participants: workflow.participants.filter((one) => one !== sessionId) }));
      if (written !== null) push(written, plan.id, [sessionId]);
    }
  }

  return {
    view(planId) {
      const plan = store.get(planId);
      return plan === null ? null : workflowView(plan);
    },

    forSession(sessionId) {
      const plan = participantPlan(sessionId);
      if (plan !== null && plan.workflow.state === 'implemented') {
        const executor = plan.workflow.operation?.sessionId ?? sessionId;
        return { kind: 'implemented', sessionId: executor, chat: host.record(executor) === undefined ? null : host.name(executor) ?? '', at: plan.workflow.operation?.at ?? now() };
      }
      if (plan !== null) return { kind: 'plan', role: 'participant', workflow: workflowView(plan) };
      const reviewing = reviewedBy(sessionId);
      if (reviewing !== null) return { kind: 'plan', role: 'reviewer', workflow: workflowView(reviewing) };
      let note: ReturnType<ConversationStore['planNote']>;
      try { note = conversations.status().kind === 'ok' ? conversations.planNote(sessionId) : null; } catch { note = null; }
      return note === null ? null : { kind: 'implemented', sessionId: note.sessionId, chat: host.record(note.sessionId) === undefined ? null : host.name(note.sessionId) ?? '', at: note.at };
    },

    admit(sessionId, send) {
      const plan = participantPlan(sessionId);
      if (plan !== null) {
        const { state } = plan.workflow;
        const holder = holderOf(plan.workflow) === sessionId;
        if (state === 'ready' || state === 'reviewing' || state === 'cancelled' || busy.get(plan.id)?.kind === 'cancelling') return 'plan-pending';
        // The writer's card may carry its revision on; nothing else of the chat's goes meanwhile.
        if (state === 'revising') return holder && send.kind === 'answer' ? null : 'plan-pending';
        // The chat carrying it out continues it with ordinary prompts, and plans nothing else meanwhile.
        if ((state === 'implementing' || state === 'interrupted') && holder && send.kind === 'typed' && send.plan) return 'plan-pending';
      }
      // A review is a hard stop (the maintainer): its reviewer takes no prompt of the user's own while it is open.
      if (send.kind === 'typed' && reviewedBy(sessionId) !== null) return 'plan-pending';
      return null;
    },

    readyIn(sessionId) {
      const plan = participantPlan(sessionId);
      return plan !== null && plan.workflow.state === 'ready' && !busy.has(plan.id) ? plan.id : null;
    },

    async retireForMode(sessionId) {
      const plan = participantPlan(sessionId);
      const line = plan === null ? null : lineOf(sessionId, plan.id);
      if (plan === null || line === null || !line.request) return;
      if (runtime()?.retire(sessionId, line.itemId, 'retired') === true) {
        count('request retired (mode)');
        await track(runtime()?.untilIdle(sessionId) ?? Promise.resolve());
      }
    },

    decide: (request) => track(decide(request)),

    admits(planId, sessionId, turnId) {
      const plan = store.get(planId);
      if (plan === null) return false;
      const { workflow } = plan;
      const op = workflow.operation;
      if (workflow.state === 'revising' && op !== null && op.sessionId === sessionId && op.turns.includes(turnId)) return true;
      // A second plan the same turn writes (M22b, C78): the next version of the one it wrote, while nothing else holds the plan.
      const current = plan.versions.find((one) => one.version === workflow.version);
      return workflow.state === 'ready' && !busy.has(planId) && current !== undefined && current.sessionId === sessionId && current.turnId === turnId;
    },

    versionMade(planId, version) {
      const plan = store.get(planId);
      if (plan === null || plan.workflow.state !== 'ready' || plan.workflow.version !== version) return;
      const writer = plan.versions.find((one) => one.version === version)?.sessionId ?? null;
      if (writer !== null) {
        detach(writer, planId);
        try { if (conversations.status().kind === 'ok') conversations.setPlanNote(writer, null); } catch { count('note not cleared (storage)'); }
      }
      // Every decision on an older version stands on this one now: its line superseded, its request
      // retired — every decision waiting a moment, where one is, until that request's turn has ended.
      // Every chat of the plan reads PLAN READY on it, at the push.
      const { done } = settleLines(planId, 'superseded', (row) => row.version < version);
      const notifyReady = (): void => {
        if (options.onReady === undefined) return;
        const current = store.get(planId);
        if (!host.quitting() && current?.workflow.state === 'ready' && current.workflow.version === version && !busy.has(planId)) options.onReady?.(planId, version);
      };
      if (done !== null) {
        const id = newId();
        busy.set(planId, { id, kind: 'retiring' });
        void track(done.finally(() => {
          if (busy.get(planId)?.id === id) busy.delete(planId);
          push(store.get(planId), planId);
          notifyReady();
        }));
      }
      push(plan, planId);
      if (done === null) notifyReady();
      count('version ready');
    },

    joined(planId, sessionId) {
      detach(sessionId, planId);
      try { if (conversations.status().kind === 'ok') conversations.setPlanNote(sessionId, null); } catch { count('note not cleared (storage)'); }
      const plan = store.get(planId);
      if (plan === null) return;
      const written = plan.workflow.participants.includes(sessionId) ? plan : write(planId, (workflow) => ({ ...workflow, participants: [...workflow.participants, sessionId] }));
      // Bringing an existing plan is the user's own action, not a new plan arriving.
      push(written ?? plan, planId, [sessionId], sessionId);
      count('joined');
    },

    reserveReview(planId, sessionId, revision, version) {
      const plan = store.get(planId);
      if (plan === null || !plan.workflow.participants.includes(sessionId)) return 'not-pending';
      if (busy.has(planId) || plan.workflow.state !== 'ready' || plan.workflow.revision !== revision) return 'locked';
      if (plan.workflow.version !== version) return 'not-pending';
      const reservation = { planId, id: newId() };
      busy.set(planId, { id: reservation.id, kind: 'starting' });
      push(plan, planId);
      return reservation;
    },

    reviewStarted(reservation, reviewId, reviewerId) {
      const op: WorkflowOperationRecord = { id: reservation.id, kind: 'review', sessionId: reviewerId, version: null, hash: null, turns: [], reviewId, at: now(), unknown: {} };
      const written = write(reservation.planId, (workflow) => (workflow.state === 'ready' ? { ...workflow, state: 'reviewing', operation: { ...op, version: workflow.version } } : null));
      if (written === null || written.workflow.operation?.id !== reservation.id) return false;
      // Each chat of the plan waits on the review from here, at the push.
      push(written, reservation.planId, [reviewerId]);
      count('review started');
      return true;
    },

    release(reservation) {
      if (busy.get(reservation.planId)?.id === reservation.id) busy.delete(reservation.planId);
      push(store.get(reservation.planId), reservation.planId);
    },

    reserveHandOff(planId, reviewId) {
      const plan = store.get(planId);
      if (plan === null || busy.has(planId) || plan.workflow.state !== 'reviewing' || plan.workflow.operation?.reviewId !== reviewId) return 'locked';
      const reservation = { planId, id: newId() };
      busy.set(planId, { id: reservation.id, kind: 'starting' });
      return reservation;
    },

    handOff(reservation, targetId, turnId) {
      const written = write(reservation.planId, (workflow) => {
        const review = workflow.operation;
        if (workflow.state !== 'reviewing' || review === null) return null;
        const participants = workflow.participants.includes(targetId) ? workflow.participants : [...workflow.participants, targetId];
        return { ...workflow, state: 'revising', participants, operation: { id: reservation.id, kind: 'revision', sessionId: targetId, version: workflow.version, hash: review.hash, turns: [turnId], reviewId: review.reviewId, at: now(), unknown: {} } };
      });
      if (written === null || written.workflow.operation?.id !== reservation.id) return false;
      detach(targetId, reservation.planId);
      push(written, reservation.planId, [targetId]);
      count('handed to integration');
      return true;
    },

    reviewEnded(planId, reviewId) {
      const written = write(planId, (workflow) => {
        const op = workflow.operation;
        // A review that closed, failed or was stopped; or the revision its integration began, where its send was refused.
        if (op === null || op.reviewId !== reviewId || (workflow.state !== 'reviewing' && workflow.state !== 'revising')) return null;
        if (workflow.state === 'revising' && op.kind !== 'revision') return null;
        return { ...workflow, state: 'ready', operation: null };
      });
      if (written === null) return;
      count('review ended');
      push(written, planId);
    },

    accepted(sessionId, turnId, answered) {
      for (const plan of heldBy(sessionId)) {
        const op = plan.workflow.operation;
        if (op === null || op.turns.includes(turnId)) continue;
        // Every prompt of the chat carrying it out continues the implementation, an interrupted one's too (decision 0029).
        if (op.kind === 'implementation' && (plan.workflow.state === 'implementing' || plan.workflow.state === 'interrupted')) {
          write(plan.id, (workflow) => (workflow.operation?.id === op.id ? { ...workflow, state: 'implementing', operation: { ...op, turns: [...op.turns, turnId] } } : null));
          push(store.get(plan.id), plan.id);
          continue;
        }
        // A card's answer carries the writer's revision on.
        if (op.kind === 'revision' && plan.workflow.state === 'revising' && answered !== null) {
          let card: ReturnType<ConversationStore['item']>;
          try { card = conversations.item(sessionId, answered); } catch { card = null; }
          if (card !== null && op.turns.includes(card.item.turnId)) write(plan.id, (workflow) => (workflow.operation?.id === op.id ? { ...workflow, operation: { ...op, turns: [...op.turns, turnId] } } : null));
        }
      }
    },

    turnEnded(sessionId, turnId, outcome) {
      for (const plan of heldBy(sessionId)) {
        const op = plan.workflow.operation;
        if (op === null || !op.turns.includes(turnId)) continue;
        if (op.kind === 'revision' && plan.workflow.state === 'revising') {
          // A turn that ends by asking may carry the revision on.
          let card: string | null = null;
          if (outcome === 'completed') { try { card = conversations.turnAnswer(sessionId, turnId)?.card ?? null; } catch { card = null; } }
          if (card === null) endRevision(plan, op);
        } else if (op.kind === 'implementation' && plan.workflow.state === 'implementing' && op.turns.at(-1) === turnId) {
          ended.set(op.id, { turnId, outcome });
          if (outcome === 'completed') evaluate(plan);
          else interrupt(plan, op);
        }
      }
    },

    idle(sessionId) {
      for (const plan of heldBy(sessionId)) evaluate(plan);
    },

    cardSettled(sessionId, itemId) {
      for (const plan of heldBy(sessionId)) {
        const op = plan.workflow.operation;
        if (op === null) continue;
        let card: ReturnType<ConversationStore['item']>;
        try { card = conversations.item(sessionId, itemId); } catch { card = null; }
        if (card === null || !op.turns.includes(card.item.turnId)) continue;
        if (op.kind === 'revision' && plan.workflow.state === 'revising' && !host.running(sessionId)) endRevision(plan, op);
        else evaluate(plan);
      }
    },

    lost(sessionId) {
      for (const plan of heldBy(sessionId)) {
        const op = plan.workflow.operation;
        if (op === null) continue;
        if (op.kind === 'revision' && plan.workflow.state === 'revising') endRevision(plan, op);
        if (op.kind === 'implementation' && plan.workflow.state === 'implementing') interrupt(plan, op);
      }
    },

    forget(sessionId) {
      for (const plan of plans()) {
        const { workflow } = plan;
        const op = workflow.operation;
        if (op?.sessionId === sessionId && isWorkflowActive(workflow.state)) {
          // The chat carrying it out is gone: the plan goes back to the chats left.
          if (op.kind === 'implementation') { release(plan, op); continue; }
          // The writer stopped with its removal: the plan is ready again on its version. A reviewer's
          // review is its service's to end, which readies the plan.
          if (op.kind === 'revision') endRevision(plan, op);
        }
        if (workflow.participants.includes(sessionId)) {
          const written = write(plan.id, (held) => ({ ...held, participants: held.participants.filter((one) => one !== sessionId) }));
          if (written !== null) push(written, plan.id);
        }
      }
    },

    closed(sessionId, how) {
      for (const plan of heldBy(sessionId)) {
        const op = plan.workflow.operation;
        if (op === null) continue;
        // Shelving, or marking Done, an active reviewer cancels its review (decision 0029).
        if (op.kind === 'review' && op.reviewId !== null && plan.workflow.state === 'reviewing') { void track(options.reviews?.()?.cancelFor(plan.id, op.reviewId) ?? Promise.resolve()); continue; }
        // Done on the chat of an implementation that runs nothing gives the plan back to the chats left
        // (the maintainer); shelving keeps it, to be continued once unshelved.
        if (op.kind === 'implementation' && how === 'done' && !host.running(sessionId)) release(plan, op);
      }
    },

    async settleForRemoval(planIds) {
      let settled = 0;
      for (const planId of planIds) {
        const plan = store.get(planId);
        if (plan === null) continue;
        const op = plan.workflow.operation;
        if (plan.workflow.state === 'reviewing' && op?.reviewId != null) await track(options.reviews?.()?.cancelFor(planId, op.reviewId) ?? Promise.resolve());
        settled += await track(settleAll(planId, 'cancelled', () => true));
        letGo(plan.workflow.participants);
        push(store.get(planId) ?? plan, planId);
        // Removed next, whatever state it was left in: nothing of it shows in its chats.
        quiet(plan.workflow.participants);
      }
      return settled;
    },

    async launched() {
      for (const plan of plans()) {
        let current: PlanFileRecord | null = plan;
        // A chat no longer listed takes part in nothing.
        const gone = plan.workflow.participants.filter((sessionId) => host.record(sessionId) === undefined && sessionId !== holderOf(plan.workflow));
        if (gone.length > 0) current = write(plan.id, (workflow) => ({ ...workflow, participants: workflow.participants.filter((one) => !gone.includes(one)) })) ?? plan;
        const { workflow } = current;
        const op = workflow.operation;
        if (workflow.state === 'implemented') { await track(finishImplemented(current)); continue; }
        if (workflow.state === 'cancelled') { await track(finishCancelled(current)); continue; }
        if (op === null) continue;
        if (workflow.state === 'reviewing') {
          // A review waiting for its findings' decisions stays while its reviewer is listed; one that was
          // running ended with the launch. One whose reviewer is gone — the records started over, or a
          // crash cut its removal short — is cancelled, as that removal would have (the maintainer).
          const review = op.reviewId === null ? null : store.review(plan.id, op.reviewId);
          const ended = review === null || review.state === 'failed' || review.state === 'closed';
          const orphaned = host.record(op.sessionId) === undefined;
          if (!ended && orphaned && op.reviewId !== null) await track(options.reviews?.()?.cancelFor(plan.id, op.reviewId) ?? Promise.resolve());
          // Its close readies the plan; where it did not, the launch does.
          if (ended || orphaned) write(plan.id, (held) => (held.operation?.id === op.id ? { ...held, state: 'ready', operation: null } : null));
        } else if (workflow.state === 'revising') {
          // A complete version would have readied it in its own write: none came.
          write(plan.id, (held) => (held.operation?.id === op.id ? { ...held, state: 'ready', operation: null } : null));
        } else if (workflow.state === 'implementing' || workflow.state === 'interrupted') {
          // Implemented only where its last turn's success is on the disk and no card of it waits.
          let outcome: TurnOutcome | null;
          const last = op.turns.at(-1);
          try { outcome = last === undefined ? null : conversations.turn(op.sessionId, last)?.sessionOutcome ?? null; } catch { outcome = null; }
          const done = workflow.state === 'implementing' && outcome === 'completed' && !cardWaits(op);
          // The chat carrying it out is gone, and nothing says it succeeded: the plan goes back to the chats left.
          if (!done && host.record(op.sessionId) === undefined) write(plan.id, released(op));
          else if (workflow.state === 'implementing') {
            const written = write(plan.id, (held) => (held.operation?.id === op.id ? { ...held, state: done ? 'implemented' : 'interrupted' } : null));
            if (done && written !== null) await track(finishImplemented(written));
          }
        }
      }
      // What each chat of a plan still kept shows, as no summary holds it at a launch.
      for (const plan of plans()) show(plan, []);
    },

    async settled() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },

    counts: () => Object.fromEntries(tally),
  };
}
