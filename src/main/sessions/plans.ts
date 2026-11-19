// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Plans in their chats (docs/planning/_archive/M22b.md, Design 6; C10, C12, C14, C15, C19, C56, C59, C60,
// C63–C65, C68, C72–C74, C78; decision 0029): what makes a provider's plan a version of the plan
// store and a line of its chat, and a line's decision the prompt that carries it out. Electron-free,
// and no provider is named here: the plan store, the conversation store and the chat service are
// handed in.
//
//   plan-raised (a request)  ─► the chain ─► the version written whole ─► the line, pending, its request held
//   plan-delta, the first    ─► the chain ─► the version listed drafting, its draft opened ─► the line, writing
//   plan-delta, each next    ─► the draft appended ─► the tab's push
//   plan-completed           ─► the version complete: the authority ─► the line, pending
//   the turn's end, a loss   ─► each draft of it unfinished ─► its line, unfinished
//
// The chain (C19, C78): a version made in a turn belongs to the plan of that turn's newest line — its
// next version, refused where that line was executed — else to the plan its prompt's fields name for
// a revision, else to a new plan of the session's project, titled by its text's first heading or
// its prompt's first line. A version's number is its plan's highest plus one. A second plan item in
// one Codex turn is the next version, and the line of the one before it is withdrawn as changed:
// a decision stands on the newest.
//
// What waits (C56, C58): a line no request holds — a Codex plan's, or one brought into a chat (C64)
// — waits from its completion until its decision, across a restart; the registry says what a
// request's line does. The service keeps the first for every chat, read once from the store.
//
// The workflow (decision 0029): a version of a plan already held is written only where the plan's
// workflow admits it — the revision a chat holds, by its turns, or a second plan of the turn that
// wrote the version every decision stands on — and a turn whose plan was removed writes none. A new
// plan, and a plan brought into a chat, register their chat with the coordinator, and a read
// carries the workflow its chats share. Lines are history: what a chat decides is the workflow's.
//
// Nothing of a plan's text or title is logged (C22): counts and kinds alone.
import { type PlanBody, planOf, raisedPlan } from '@shared/contracts/interaction';
import {
  MAX_PLAN_PUSH,
  MAX_PLAN_TEXT,
  type PlanFields,
  type PlanIntegration,
  type PlanOrigin,
  type PlanPush,
  planPrompt,
  type PlanRead,
  type PlanReadRequest,
  type PlanSummary,
  type PlansStorage,
  planTitle,
  planToken,
  type PlanVersionView,
} from '@shared/contracts/plans';
import type { WorkflowView } from '@shared/contracts/workflow';
import type { ConversationStore } from '../conversations/store';
import type { PlanFileRecord, PlanVersionRecord } from '../plans/format';
import type { PlanStore, VersionSource, VersionTarget } from '../plans/store';
import type { SessionRecord } from '../records/format';
import type { ChatService } from './chat-service';

/** A chat whose line on a plan waits (C24, C25, C73): the session and the version its line stands on. */
export interface PlanWaiter {
  readonly sessionId: string;
  readonly version: number;
}

/** A line that waits for its decision, with no request holding it (C56). */
export interface WaitingLine {
  readonly itemId: string;
  readonly planId: string;
  readonly version: number;
  readonly came: PlanOrigin;
}

/** What a decision that starts a turn sends (C15, C65, C68, C69): its prompt, its fields, and whether it is a plan turn. */
export interface ComposedDecision {
  readonly prompt: string;
  readonly fields: PlanFields;
  /** Feedback plans the next version: a plan turn. Execute is a turn under the chat's mode. */
  readonly plan: boolean;
  readonly outcome: 'feedback' | 'executed';
}

export type BringOutcome =
  /** `title`: the plan's, for the name of a chat that has none (decision 0029). */
  | { readonly status: 'brought'; readonly itemId: string; readonly title: string }
  | { readonly status: 'refused'; readonly reason: 'unknown-session' | 'unknown-plan' | 'other-project' | 'not-complete' | 'stale' | 'plan-pending' | 'storage-failed' };

export interface PlanServiceOptions {
  readonly store: PlanStore;
  readonly conversations: Pick<ConversationStore, 'status' | 'turnPlan' | 'pendingPlans' | 'planWaiters' | 'item'>;
  readonly chat: Pick<ChatService, 'addPlan' | 'setPlan' | 'bringPlan'>;
  /** A listed session's record: its project, its provider, its account and its model. */
  readonly record: (sessionId: string) => SessionRecord | undefined;
  /** A listed session's name, for a version's chat; null where it is not listed. */
  readonly chatName?: (sessionId: string) => string | null;
  /** Whether the registry holds a request's line pending on this run (C56): the runtime's word, late bound. */
  readonly requestPending?: (sessionId: string, itemId: string) => boolean;
  /** Told of a plan's change, for the page's tab: its version's state, and more text of a version being written (C25, C60). */
  readonly push?: (push: PlanPush) => void;
  /**
   * A review's integration that a version made in this turn carries out (M22e, C11, C49): the review
   * service's word, late bound — its review, its integration, the findings it sent, its plan and the
   * version it revises. Null for a turn no integration is `sent` by.
   */
  readonly integration?: (sessionId: string, turnId: string) => (PlanIntegration & { readonly planId: string; readonly revises: number }) | null;
  /** A version completed (M22e, C27, C36): the review service settles what names it and says what it made stale. */
  readonly versionMade?: (planId: string, version: number) => void;
  /** Whether the plan's workflow admits a version from this session's turn now (decision 0029): the coordinator's word, late bound. */
  readonly admits?: (planId: string, sessionId: string, turnId: string) => boolean;
  /** A chat that made a new plan, or brought one in, takes part in it (decision 0029). */
  readonly joined?: (planId: string, sessionId: string) => void;
  /** The plan's workflow as the page draws it (decision 0029). */
  readonly workflow?: (planId: string) => WorkflowView | null;
  readonly now?: () => number;
  /** Twelve hex digits, for a block's token (C68). */
  readonly token?: () => string;
  /** Counts and kinds alone (C22). */
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

export interface PlanService {
  /**
   * A plan's request (C10): its version written whole, then its line, pending, `kept` told the
   * line's id before its push. Null where nothing could be kept: the registry refuses the request.
   */
  raise(sessionId: string, raised: { readonly turnId: string; readonly sourceId: string; readonly text: string }, kept: (itemId: string) => void): string | null;
  /** More of a plan being written (C14, C59): the first opens its version and its line. */
  delta(sessionId: string, delta: { readonly turnId: string; readonly itemId: string; readonly text: string }): void;
  /** A plan's whole text (C14): its version complete, its line pending. Answers whether a line now waits. */
  completed(sessionId: string, completed: { readonly turnId: string; readonly itemId: string; readonly text: string }): boolean;
  /** A turn's end (C59, C74): what it was still writing is unfinished. */
  turnEnded(sessionId: string, turnId: string): void;
  /** The session's process ended: everything it was writing is unfinished. */
  lost(sessionId: string): void;
  /** Every draft so far, to the disk (C59): at a Stop and at the quit. */
  flush(): void;
  /** The chat's line that waits with no request holding it, or null (C56, C58). */
  waiting(sessionId: string): WaitingLine | null;
  /** A turn that carries out the line's decision was accepted (C12): it no longer waits. */
  settled(sessionId: string, itemId: string): void;
  /** Cancel of a line no request holds (C15): written and pushed. */
  cancel(sessionId: string, itemId: string): 'cancelled' | 'not-pending' | 'storage-failed';
  /** What a decision that starts a turn sends (C15, C65, C68, C72), checked against the line as it waits. */
  compose(sessionId: string, itemId: string, decision: 'feedback' | 'execute', feedback: string | null): ComposedDecision | 'unknown-item' | 'not-pending' | 'storage-failed';
  /** A plan brought into the chat (C64, C76): checked against the list the user chose from. */
  bring(sessionId: string, request: { readonly planId: string; readonly version: number; readonly hash: string }, at: { readonly turnId: string; readonly at: number; readonly started: boolean }): BringOutcome;
  /** A read of a plan (C20, C60): its versions, and a range of one. */
  read(request: PlanReadRequest): PlanRead | { readonly status: 'refused'; readonly reason: 'unknown-plan' | 'unknown-version' | 'storage-failed' };
  /** A project's plans, newest first (C63, C67). */
  list(projectId: string): readonly PlanSummary[];
  /** The chats whose line on a plan waits on this run (C73): a request's only while its registry holds it. */
  waiters(planId: string): readonly (PlanWaiter & { readonly itemId: string; readonly request: boolean })[];
  storage(listed: ReadonlySet<string> | null): PlansStorage;
  /** The session is no longer listed: what is kept of it goes. */
  forget(sessionId: string): void;
  /** Counts by kind (C22). */
  counts(): Readonly<Record<string, number>>;
}

/** A plan being written (C59): by its session and the provider's item id. */
interface Draft {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerItemId: string;
  readonly planId: string;
  readonly version: number;
  readonly lineId: string;
  /** UTF-16 units received. */
  length: number;
  readonly title: string;
}

const draftKey = (sessionId: string, providerItemId: string): string => `${sessionId}/${providerItemId}`;
const hex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export function createPlanService(options: PlanServiceOptions): PlanService {
  const { store, conversations, chat } = options;
  const now = options.now ?? Date.now;
  const token = options.token ?? hex;
  const log = options.log ?? console;
  const drafts = new Map<string, Draft>();
  /** The lines that wait with no request holding them, by session (C56): read once from the store, then kept here. */
  let waiting: Map<string, Map<string, WaitingLine>> | null = null;
  const tally = new Map<string, number>();

  function count(what: string): void {
    const total = (tally.get(what) ?? 0) + 1;
    tally.set(what, total);
    if (/^10*$/.test(String(total))) log.info(`[plans] ${what}, ${total} so far`);
  }

  function lines(): Map<string, Map<string, WaitingLine>> {
    if (waiting !== null) return waiting;
    // Nothing waits in a store fat-g cannot read, and Start fresh opens an empty one: asked again then, with no failure counted.
    if (conversations.status().kind === 'refused') return new Map();
    const read = new Map<string, Map<string, WaitingLine>>();
    try {
      // A request's line is its registry's to say (C56): none is held at a launch, so none waits.
      for (const row of conversations.pendingPlans()) {
        if (row.request) continue;
        const stored = conversations.item(row.conversationId, row.itemId);
        const body = stored === null ? null : planOf(stored.item);
        if (body === null) continue;
        const held = read.get(row.conversationId) ?? new Map<string, WaitingLine>();
        held.set(row.itemId, { itemId: row.itemId, planId: row.planId, version: row.version, came: body.came });
        read.set(row.conversationId, held);
      }
    } catch {
      // Read again at the next ask: the store may come back.
      count('waiting lines not read (storage)');
      return read;
    }
    waiting = read;
    return read;
  }
  function wait(sessionId: string, line: WaitingLine): void {
    const all = lines();
    const held = all.get(sessionId) ?? new Map<string, WaitingLine>();
    held.set(line.itemId, line);
    all.set(sessionId, held);
  }
  function unwait(sessionId: string, itemId: string): void {
    const held = lines().get(sessionId);
    held?.delete(itemId);
    if (held?.size === 0) lines().delete(sessionId);
  }

  type Chained = { readonly target: VersionTarget; readonly source: VersionSource; readonly superseded: string | null };
  /**
   * Where a version made in this turn goes (C19, C78), and who made it. Refused — by why, for the
   * count — where the turn's plan was carried out already, was removed, or its workflow does not
   * admit a version from this turn (decision 0029); null where the session or its turn is not held.
   */
  function chain(sessionId: string, turnId: string, text: string): Chained | 'executed' | 'removed' | 'not-admitted' | null {
    const chained = chainOf(sessionId, turnId, text);
    if (chained === null || typeof chained === 'string') return chained;
    const { planId } = chained.target;
    return planId !== null && options.admits?.(planId, sessionId, turnId) === false ? 'not-admitted' : chained;
  }

  function chainOf(sessionId: string, turnId: string, text: string): Chained | 'executed' | 'removed' | null {
    const record = options.record(sessionId);
    if (record === undefined) return null;
    let state: ReturnType<typeof conversations.turnPlan>;
    try { state = conversations.turnPlan(sessionId, turnId); } catch { return null; }
    const base = { sessionId, turnId, providerId: record.providerId, instanceId: record.instanceId, model: record.model };
    const newest = state?.newest ?? null;
    const held = newest === null ? null : store.get(newest.planId);
    if (newest !== null && held !== null && newest.outcome === 'executed') return 'executed';
    // A review's integration sent by this turn (M22e, C11, C49): the version is its plan's next,
    // caused `integration`, revising the version reviewed — whatever else was written meanwhile.
    const integration = options.integration?.(sessionId, turnId) ?? null;
    const integrated = integration === null ? null : store.get(integration.planId);
    if (integration !== null && integrated === null) return 'removed';
    if (integration !== null && integrated !== null) {
      const superseded = newest !== null && (newest.outcome === 'pending' || newest.outcome === 'writing') ? newest.itemId : null;
      return {
        target: { planId: integrated.id, projectId: integrated.projectId, title: integrated.title },
        source: { ...base, cause: 'integration', revises: integration.revises, integration: { reviewId: integration.reviewId, integrationId: integration.integrationId, findings: integration.findings } },
        superseded,
      };
    }
    // The plan this turn wrote, or was told to revise, is gone: nothing makes a new one of its next version.
    if (newest !== null && held === null) return 'removed';
    if (newest !== null && held !== null) {
      // A version that replaces one still waiting, or still being written, in the same turn: the decision stands on the newest.
      const superseded = newest.outcome === 'pending' || newest.outcome === 'writing' ? newest.itemId : null;
      return { target: { planId: held.id, projectId: held.projectId, title: held.title }, source: { ...base, cause: newest.outcome === 'feedback' ? 'feedback' : 'plan-turn', revises: newest.version }, superseded };
    }
    const fields = state?.fields ?? null;
    const named = fields === null || fields.intent !== 'revise' ? null : store.get(fields.planId);
    if (fields !== null && fields.intent === 'revise' && (named === null || named.projectId !== record.projectId)) return 'removed';
    if (fields !== null && named !== null) {
      return { target: { planId: named.id, projectId: named.projectId, title: named.title }, source: { ...base, cause: 'feedback', revises: fields.version }, superseded: null };
    }
    return { target: { planId: null, projectId: record.projectId, title: planTitle(text, state?.prompt ?? null) }, source: { ...base, cause: 'plan-turn', revises: null }, superseded: null };
  }

  /** The line a newer version of the same turn replaces (C78): withdrawn as changed, and no longer waiting. */
  function supersede(sessionId: string, itemId: string | null): void {
    if (itemId === null) return;
    const draft = [...drafts.values()].find((one) => one.sessionId === sessionId && one.lineId === itemId);
    if (draft !== undefined) unfinish(draft);
    chat.setPlan(sessionId, itemId, ['pending', 'writing'], { outcome: 'withdrawn', settledAt: now(), withdrawnBy: 'changed' });
    unwait(sessionId, itemId);
  }

  function pushOf(planId: string, version: number, state: PlanVersionRecord['state']): void {
    options.push?.({ planId, version, state });
  }

  /** More of a version's text for the tab (C60): in pushes of at most 64 KiB each. */
  function pushText(draft: Draft, text: string): void {
    for (let at = 0; at < text.length; at += MAX_PLAN_PUSH) {
      const append = text.slice(at, at + MAX_PLAN_PUSH);
      options.push?.({ planId: draft.planId, version: draft.version, state: 'drafting', partial: { before: draft.length, append } });
      draft.length += append.length;
    }
  }

  function unfinish(draft: Draft): void {
    drafts.delete(draftKey(draft.sessionId, draft.providerItemId));
    try { store.unfinish(draft.planId, draft.version); } catch { count('draft not unfinished (storage)'); }
    chat.setPlan(draft.sessionId, draft.lineId, 'writing', { outcome: 'unfinished', settledAt: now() });
    pushOf(draft.planId, draft.version, 'unfinished');
    count('plan unfinished');
  }

  function view(version: PlanVersionRecord): PlanVersionView {
    return {
      version: version.version, state: version.state, at: version.at, cause: version.cause, revises: version.revises,
      providerId: version.providerId, model: version.model, sessionId: version.sessionId, chat: options.chatName?.(version.sessionId) ?? null,
      length: version.length, hash: version.hash, integration: version.integration,
    };
  }

  function summary(plan: PlanFileRecord): PlanSummary | null {
    const latest = plan.versions.at(-1);
    if (latest === undefined) return null;
    const complete = [...plan.versions].reverse().find((version) => version.state === 'complete') ?? null;
    return {
      planId: plan.id, title: plan.title, createdAt: plan.createdAt, versions: plan.versions.length, latest: view(latest), complete: complete === null ? null : view(complete),
      state: plan.workflow.state, participants: plan.workflow.participants.length,
    };
  }

  /** The workflow as the coordinator draws it; without one, as the plan's record holds it. */
  function workflowOf(plan: PlanFileRecord): WorkflowView {
    const held = options.workflow?.(plan.id) ?? null;
    if (held !== null) return held;
    const { workflow } = plan;
    return {
      planId: plan.id, state: workflow.state, revision: workflow.revision, version: workflow.version, participants: [...workflow.participants],
      holder: workflow.operation === null ? null : { sessionId: workflow.operation.sessionId, chat: options.chatName?.(workflow.operation.sessionId) ?? null },
      operation: workflow.operation?.kind ?? null, reviewId: workflow.operation?.kind === 'review' ? workflow.operation.reviewId : null, busy: null,
    };
  }

  function waitersOf(planId: string): (PlanWaiter & { readonly itemId: string; readonly request: boolean })[] {
    let rows: ReturnType<typeof conversations.planWaiters>;
    try { rows = conversations.planWaiters(planId); } catch { return []; }
    return rows.filter((row) => !row.request || options.requestPending?.(row.conversationId, row.itemId) === true).map((row) => ({ sessionId: row.conversationId, version: row.version, itemId: row.itemId, request: row.request }));
  }

  function delta(sessionId: string, delta: { readonly turnId: string; readonly itemId: string; readonly text: string }): void {
    const key = draftKey(sessionId, delta.itemId);
    let draft = drafts.get(key);
    if (draft === undefined) {
      // The first opens the version and its line (C59, C74).
      const chained = chain(sessionId, delta.turnId, '');
      if (chained === null || typeof chained === 'string') { count(`plan refused (${chained ?? 'no record'})`); return; }
      let begun: ReturnType<PlanStore['begin']>;
      try { begun = store.begin(chained.target, chained.source); } catch { count('plan not begun (storage)'); return; }
      supersede(sessionId, chained.superseded);
      // A new plan's maker takes part in it from its first word (decision 0029).
      if (chained.target.planId === null) options.joined?.(begun.planId, sessionId);
      const lineId = chat.addPlan(sessionId, delta.turnId, { providerItemId: delta.itemId, body: raisedPlan({ planId: begun.planId, version: begun.version, came: 'made', request: false, writing: true }) });
      if (lineId === null) {
        // No line to stand for it: the draft is kept as it is, and finished as unfinished.
        try { store.unfinish(begun.planId, begun.version); } catch { /* the store says so at the next launch */ }
        count('plan line not kept');
        return;
      }
      draft = { sessionId, turnId: delta.turnId, providerItemId: delta.itemId, planId: begun.planId, version: begun.version, lineId, length: 0, title: chained.target.title };
      drafts.set(key, draft);
      pushOf(begun.planId, begun.version, 'drafting');
      count('plan opened');
    }
    if (delta.text === '') return;
    try { store.append(draft.planId, draft.version, delta.text); } catch { count('plan not appended (storage)'); return; }
    pushText(draft, delta.text);
  }

  function waitingOf(sessionId: string): WaitingLine | null {
    const held = lines().get(sessionId);
    return held === undefined ? null : [...held.values()].at(-1) ?? null;
  }

  return {
    raise(sessionId, raised, kept) {
      const chained = chain(sessionId, raised.turnId, raised.text);
      if (chained === null || typeof chained === 'string') { count(`plan refused (${chained ?? 'no record'})`); return null; }
      let made: ReturnType<PlanStore['write']>;
      try { made = store.write(chained.target, chained.source, raised.text); } catch { count('plan not written (storage)'); return null; }
      supersede(sessionId, chained.superseded);
      if (chained.target.planId === null) options.joined?.(made.planId, sessionId);
      const id = chat.addPlan(sessionId, raised.turnId, { providerItemId: raised.sourceId, body: raisedPlan({ planId: made.planId, version: made.version, came: 'made', request: true }) }, kept);
      pushOf(made.planId, made.version, 'complete');
      options.versionMade?.(made.planId, made.version);
      count(id === null ? 'plan line not kept' : 'plan raised');
      return id;
    },

    delta,

    completed(sessionId, completed) {
      const key = draftKey(sessionId, completed.itemId);
      // A plan whose deltas never came is opened by its completion.
      if (!drafts.has(key)) delta(sessionId, { turnId: completed.turnId, itemId: completed.itemId, text: '' });
      const draft = drafts.get(key);
      if (draft === undefined) return false;
      drafts.delete(key);
      const plan = store.get(draft.planId);
      // A plan's title is its first complete version's (C19): its text's first heading, else its prompt's first line.
      const titled = plan !== null && plan.versions.some((one) => one.version !== draft.version && one.state === 'complete');
      const title = titled ? plan.title : planTitle(completed.text, draft.title);
      try { store.complete(draft.planId, draft.version, completed.text, title); } catch {
        count('plan not completed (storage)');
        drafts.set(key, draft);
        unfinish(draft);
        return false;
      }
      const set = chat.setPlan(sessionId, draft.lineId, 'writing', { outcome: 'pending' });
      pushOf(draft.planId, draft.version, 'complete');
      options.versionMade?.(draft.planId, draft.version);
      if (set !== true) { count('plan line not set pending'); return false; }
      wait(sessionId, { itemId: draft.lineId, planId: draft.planId, version: draft.version, came: 'made' });
      count('plan completed');
      return true;
    },

    turnEnded(sessionId, turnId) {
      for (const draft of [...drafts.values()]) if (draft.sessionId === sessionId && draft.turnId === turnId) unfinish(draft);
    },

    lost(sessionId) {
      for (const draft of [...drafts.values()]) if (draft.sessionId === sessionId) unfinish(draft);
    },

    flush() {
      try { store.flush(); } catch { count('drafts not flushed (storage)'); }
    },

    waiting: waitingOf,

    settled(sessionId, itemId) {
      unwait(sessionId, itemId);
    },

    cancel(sessionId, itemId) {
      const written = chat.setPlan(sessionId, itemId, 'pending', { outcome: 'cancelled', decidedAt: now() });
      if (written === null) return 'not-pending';
      if (!written) return 'storage-failed';
      unwait(sessionId, itemId);
      count('plan cancelled');
      return 'cancelled';
    },

    compose(sessionId, itemId, decision, feedback) {
      let stored: ReturnType<typeof conversations.item>;
      try { stored = conversations.item(sessionId, itemId); } catch { return 'storage-failed'; }
      const body: PlanBody | null = stored === null ? null : planOf(stored.item);
      if (body === null) return 'unknown-item';
      if (body.outcome !== 'pending' || body.request) return 'not-pending';
      // The block holds the version's whole text for a plan brought into the chat, and nothing in the
      // plan's own chat, whose session holds the plan already (C15, C65, C68).
      let text: string | null = null;
      if (body.came === 'brought') {
        const read = store.read(body.planId, body.version, 0, MAX_PLAN_TEXT);
        if (read === null || read.state !== 'complete') return 'not-pending';
        text = read.text;
      }
      const prompt = planPrompt({ decision, planId: body.planId, version: body.version, text, feedback, token: planToken(text ?? feedback ?? '', token) });
      return { prompt, fields: { planId: body.planId, version: body.version, intent: decision === 'execute' ? 'execute' : 'revise' }, plan: decision === 'feedback', outcome: decision === 'execute' ? 'executed' : 'feedback' };
    },

    bring(sessionId, request, at) {
      const record = options.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const plan = store.get(request.planId);
      if (plan === null) return { status: 'refused', reason: 'unknown-plan' };
      if (plan.projectId !== record.projectId) return { status: 'refused', reason: 'other-project' };
      const version = plan.versions.find((one) => one.version === request.version);
      if (version === undefined || version.state !== 'complete') return { status: 'refused', reason: 'not-complete' };
      if (version.hash !== request.hash) return { status: 'refused', reason: 'stale' };
      if (waitingOf(sessionId) !== null) return { status: 'refused', reason: 'plan-pending' };
      const id = chat.bringPlan(sessionId, at, raisedPlan({ planId: plan.id, version: version.version, came: 'brought', request: false }));
      if (id === null) return { status: 'refused', reason: 'storage-failed' };
      wait(sessionId, { itemId: id, planId: plan.id, version: version.version, came: 'brought' });
      // The chat takes part in its workflow from here (decision 0029), whatever holds the plan now.
      options.joined?.(plan.id, sessionId);
      count('plan brought');
      return { status: 'brought', itemId: id, title: plan.title };
    },

    read(request) {
      const plan = store.get(request.planId);
      if (plan === null) return { status: 'refused', reason: 'unknown-plan' };
      const chosen = request.version === undefined ? ([...plan.versions].reverse().find((one) => one.state === 'complete') ?? plan.versions.at(-1)) : plan.versions.find((one) => one.version === request.version);
      if (chosen === undefined) return { status: 'refused', reason: 'unknown-version' };
      const read = store.read(plan.id, chosen.version, request.start, request.length);
      if (read === null) return { status: 'refused', reason: 'storage-failed' };
      return {
        status: 'read', planId: plan.id, projectId: plan.projectId, title: plan.title, createdAt: plan.createdAt,
        versions: plan.versions.map(view), workflow: workflowOf(plan),
        version: chosen.version, length: read.length, hash: read.hash, start: read.start, text: read.text,
      };
    },

    list(projectId) {
      return store.list(projectId).flatMap((plan) => { const one = summary(plan); return one === null ? [] : [one]; });
    },

    waiters: waitersOf,

    storage: (listed) => store.storage(listed),

    forget(sessionId) {
      lines().delete(sessionId);
      for (const [key, draft] of [...drafts]) if (draft.sessionId === sessionId) drafts.delete(key);
    },

    counts: () => Object.fromEntries(tally),
  };
}
