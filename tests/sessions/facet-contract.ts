// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One set of tests for every session facet (docs/planning/_archive/M15.md, V2; C7, C8, C81): what main
// relies on, whatever runs behind it. The example provider's facet and Codex's, against its replay
// fake, both pass it (tests/sessions/facet-contract.test.ts, tests/codex/).
//
// It covers a facet that reads its earlier conversation back and one that cannot (docs/planning/_archive/
// M18.md, Design 1; C6, C25, C47, C59): the harness says which. Every turn's end says whether the
// provider reported it; a history page's turns and messages pass their schemas, and each message
// names a turn of its page.
//
// It takes a turn's answer either way (docs/planning/_archive/M16.md, Design 6; C74, C84): a message labelled
// `final` as it arrives, or a message the turn's completed end names. A provider that labels no
// phase tells it the second way. An end that is not completed names none.
//
// And it takes a message either way (docs/planning/_archive/M19.md, Design 1; C3–C5, C57): whole, or in
// deltas completed by its whole message. A message's deltas are folded into it before the contract
// looks (`foldDeltas`): each names its turn, opens or follows its message's opening, and comes
// before the whole message of its id, which a turn that completed always gives.
//
// And it takes what a session does (docs/planning/_archive/M20a.md, Design 1; C3, C20, C23, C53): an activity
// started and then ended under the same id, turn and owner; a worker's messages and activities
// under the id of a worker that was started; and a worker's item paired with one. A provider that
// tells none of it passes as it did (`workFaults`). The session's own messages are the turn's: a
// worker's is never its answer.
//
// And it takes a question asked beside a session (docs/planning/_archive/M20b.md, Design 2, 9; C24–C26), for
// a provider whose descriptor says it answers one: an ask that completes, one stopped and one
// refused. Every outcome is an event that names the aside, under the aside's own turn; the
// session's own turn, asked beside, is told as it would be. A provider that answers none has no
// `ask` member, and passes as it did.
//
// And it takes a question the session asks as a request (docs/planning/_archive/M21.md, Design 2, 8; C11, C20,
// C22, C30, C63), for a provider whose descriptor says it asks one: an answer that completes, a
// request main refuses, and one a Stop leaves to its turn's end. The request is raised under its
// turn, with its questions in their bounds; an answer is given by places and confirmed by the
// provider's own word. A provider that asks none has no `answer` member, and passes as it did.
// One whose descriptor says `declines` takes a question the user skipped, confirmed by its own word,
// and its turn completes; one that does not has no `decline` member (M100b, C31, C33, C35).
//
// And it takes what a session may do (docs/planning/_archive/M22.md, Design 2, 4, 11; C2, C8, C11–C13, C21,
// C35, C39, C46), for a provider whose descriptor declares modes with one that asks: a start under a
// declared mode, confirmed by the provider's own word, and one whose start reports another, which
// takes no prompt; a change on the live process where the provider declares one, and no such member
// where it declares none; an action approved, one denied, one granted for the session with the next
// request unasked, one a Stop leaves to its turn's end, one main refuses, and one pending when the
// session is closed, said dropped before the end. A provider that declares no mode has neither
// `decide` nor `setMode`, and its facet says nothing of modes; it passes as it did.
//
// And it takes a plan turn (docs/planning/_archive/M22b.md, Design 1, 8; C2, C5, C10, C13, C14, C55), for a
// provider whose descriptor declares plans: under a mode its capability lists, the turn proposes a
// plan — in a request that holds the turn, whose three decisions it takes, or as an item it writes,
// opened, grown and completed whole — and a later turn that names `plannedBefore` is a turn as any.
// Its facet says whether its account takes a plan turn now. A provider that declares no plans has
// no `plans` member on its facet and no `decidePlan` on its sessions; it passes as it did.
import { describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema, HistoryMessageSchema, HistoryTurnSchema } from '@shared/contracts/agent-events';
import type { AsideCapability } from '@shared/contracts/aside';
import type { GivenAnswer } from '@shared/contracts/interaction';
import { isModeId, type PermissionCapability } from '@shared/contracts/permissions';
import type { PlanCapability } from '@shared/contracts/plans';
import type { ContextReading } from '@shared/contracts/sessions';
import type { AsideRequest, ProviderSession, SessionFacet, SessionStart } from '@shared/provider-kit/sessions';

/** What the shared tests need of a provider that answers asides (M20b, C26). */
export interface AsideHarness {
  /** What its descriptor declares (C24). */
  readonly capability: Exclude<AsideCapability, 'none'>;
  /** A question it answers. */
  readonly question: string;
  /** Makes it refuse the next ask. */
  refuseNext(): void | Promise<void>;
  /** Makes it leave the next ask unanswered until that ask is stopped. */
  holdNext(): void | Promise<void>;
  /** Takes back whatever the two above set and was not used. */
  release(): void | Promise<void>;
}

/** What the shared tests need of a provider that asks blocking questions (M21, C30). */
export interface QuestionHarness {
  /** What its descriptor declares: its sessions take `answer` exactly then. */
  readonly capability: 'blocking' | 'both';
  /** A prompt whose turn asks a question as a request, and completes once it is answered. */
  readonly prompt: string;
  /** Makes ready whatever such a turn needs of the provider, before each: a fake's control. */
  arm?(): void | Promise<void>;
}

/** What the shared tests need of a provider whose sessions ask leave to act (M22, C35). */
export interface PermissionHarness {
  /** What its descriptor declares: its facet says which of these an account can use, and its sessions take `decide`. */
  readonly capability: PermissionCapability;
  /** The mode every other test of the contract starts its sessions under: one the harness's `prompt` is answered under. */
  readonly mode: string;
  /** A mode that asks, which the three prompts below are sent under. */
  readonly asking: string;
  /** A prompt whose turn asks leave for one action, and ends once that is decided — approved once, or denied. */
  readonly prompt: string;
  /** A prompt whose turn's request can be granted for the session, and a later one the grant covers: asked on the same process, it asks nothing. */
  readonly session: { readonly prompt: string; readonly again: string };
  /** A change the provider takes on a live process, where its descriptor declares one: from the mode the session is started under. */
  readonly idle?: { readonly from: string; readonly to: string };
  /** Makes ready whatever such a turn needs of the provider, before each: a fake's control. */
  arm?(): void | Promise<void>;
  /** Makes the next start report another mode than the one it is asked for. */
  mismatchNext(): void | Promise<void>;
}

/** What the shared tests need of a provider that plans (M22b, C2, C10, C14). */
export interface PlanHarness {
  /** What its descriptor declares: a plan turn under these modes. */
  readonly capability: PlanCapability;
  /** How it proposes a plan: in a request that holds its turn, or as an item its turn writes. */
  readonly kind: 'request' | 'item';
  /** A prompt whose plan turn proposes a plan, under `mode`. */
  readonly prompt: string;
  /** A mode its capability lists: what the plan turn's session is started under. */
  readonly mode: string;
  /** Makes ready whatever such a turn needs of the provider, before each: a fake's control. */
  arm?(): void | Promise<void>;
}

export interface FacetHarness {
  readonly facet: SessionFacet;
  /** What the provider's descriptor says of `capabilities.history` (M18, C6): the facet has its `history` member exactly then. */
  readonly history: boolean;
  /** A folder a session may start in. */
  readonly folder: string;
  readonly model: string;
  readonly effort: string | null;
  /** A prompt the provider answers with a turn that completes. */
  readonly prompt: string;
  /** Present exactly where the provider's descriptor says it answers asides (M20b, C24). */
  readonly asides?: AsideHarness;
  /** Present exactly where the provider's descriptor says its sessions ask blocking questions (M21, C30). */
  readonly questions?: QuestionHarness;
  /** Present exactly where the provider's descriptor declares modes with one that asks (M22, C39). */
  readonly permissions?: PermissionHarness;
  /** Present exactly where the provider's descriptor declares plans (M22b, C2). */
  readonly plans?: PlanHarness;
  dispose(): Promise<void>;
}

/** A start as main makes one: under the harness's own mode, or `mode`, where its provider declares any; null where it declares none. */
function startOf(harness: FacetHarness, mode?: string): SessionStart {
  return { folder: harness.folder, model: harness.model, effort: harness.effort, speed: null, otherFolders: [], mode: harness.permissions === undefined ? null : mode ?? harness.permissions.mode, processKey: 'process-1' };
}

export interface Collected {
  readonly events: AgentEvent[];
  /**
   * The session's context readings (decision 0033), apart from `events`: one a turn's end asks for
   * may come while an aside runs, and is the session's own, outside what the contract compares.
   */
  readonly readings: ContextReading[];
  /** Resolves with the events once a `turn-ended` for `turnId` has come. */
  ended(turnId: string): Promise<AgentEvent[]>;
  /** Resolves with the first event `wanted` takes, once it has come: `what` names it where it never does. */
  first<T extends AgentEvent>(wanted: (event: AgentEvent) => event is T, what: string): Promise<T>;
}

export function collect(session: ProviderSession, timeoutMs = 10_000): Collected {
  const events: AgentEvent[] = [];
  const readings: ContextReading[] = [];
  const waiters = new Set<() => void>();
  session.subscribe((event) => { if (event.type === 'context') readings.push(event.reading); else events.push(event); for (const waiter of [...waiters]) waiter(); });
  return {
    events,
    readings,
    ended(turnId) {
      const done = (): boolean => events.some((event) => event.type === 'turn-ended' && event.turnId === turnId);
      return new Promise((resolve, reject) => {
        const check = (): void => { if (done()) { clearTimeout(timer); waiters.delete(check); resolve(events); } };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no turn-ended for ${turnId}; got ${events.map((event) => event.type).join(', ')}`)); }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    first<T extends AgentEvent>(wanted: (event: AgentEvent) => event is T, what: string): Promise<T> {
      return new Promise((resolve, reject) => {
        const check = (): void => {
          const found = events.find(wanted);
          if (found !== undefined) { clearTimeout(timer); waiters.delete(check); resolve(found); }
        };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no ${what}; got ${events.map((event) => event.type).join(', ')}`)); }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}

const turnOf = (event: AgentEvent): string | undefined => ('turnId' in event ? event.turnId : undefined);

export interface Folded {
  /** The events with every `message-delta` taken out: what a provider that streams nothing would have said. */
  readonly events: AgentEvent[];
  /** What the deltas of each message brought, by its item id, in the order the messages opened. */
  readonly streamed: Map<string, string>;
  /** The item ids a delta opened and no whole message completed. */
  readonly open: string[];
  /** What is wrong with the deltas' order, if anything: one after its message completed, or for another turn than its message's. */
  readonly faults: string[];
}

/** A message's deltas folded into the message (M19, C57). */
export function foldDeltas(events: readonly AgentEvent[]): Folded {
  const streamed = new Map<string, string>();
  const turns = new Map<string, string>();
  const completed = new Set<string>();
  const faults: string[] = [];
  const kept: AgentEvent[] = [];
  for (const event of events) {
    if (event.type === 'message-delta') {
      if (completed.has(event.itemId)) faults.push(`a delta after its message: ${event.itemId}`);
      if (turns.has(event.itemId) && turns.get(event.itemId) !== event.turnId) faults.push(`a delta of another turn: ${event.itemId}`);
      turns.set(event.itemId, event.turnId);
      streamed.set(event.itemId, (streamed.get(event.itemId) ?? '') + event.text);
      continue;
    }
    if (event.type === 'message' && event.role === 'assistant') {
      if (turns.has(event.itemId) && turns.get(event.itemId) !== event.turnId) faults.push(`a message of another turn than its deltas: ${event.itemId}`);
      completed.add(event.itemId);
    }
    kept.push(event);
  }
  return { events: kept, streamed, open: [...streamed.keys()].filter((itemId) => !completed.has(itemId)), faults };
}

/** An event without the answer its turn's end may name (M16, C84): how a completed end is compared. */
function withoutAnswer(event: AgentEvent): AgentEvent {
  if (event.type !== 'turn-ended') return event;
  const { answerItemId: _answer, ...end } = event;
  return end;
}

/**
 * What is wrong with a turn's telling of its work (M20a, C53): nothing, for a provider that tells
 * none. An activity's end follows a start of its id, under the same turn and the same owner, and no
 * start follows its end; a second start before it, which replaces the item (C59), is none. Whatever
 * names a worker — a message, a delta, an activity of the worker's, the pairing of the item that
 * started it — names one that was started, and only a worker's item is paired.
 */
export function workFaults(events: readonly AgentEvent[]): string[] {
  const faults: string[] = [];
  const workers = new Set<string>();
  const open = new Map<string, { readonly turnId: string; readonly workerId: string | undefined }>();
  const ended = new Set<string>();
  const key = (workerId: string | undefined, itemId: string): string => `${workerId ?? ''}\u0000${itemId}`;
  for (const event of events) {
    if (event.type === 'worker-started') { workers.add(event.workerId); continue; }
    if ((event.type === 'message' || event.type === 'message-delta' || event.type === 'activity-started' || event.type === 'activity-ended') && event.workerId !== undefined && !workers.has(event.workerId)) faults.push(`${event.type} of a worker that was never started: ${event.itemId}`);
    if (event.type === 'activity-started') {
      const id = key(event.workerId, event.itemId);
      if (event.pairedWorkerId !== undefined && event.activityType !== 'worker') faults.push(`a pairing on an item that is no worker's: ${event.itemId}`);
      if (event.pairedWorkerId !== undefined && !workers.has(event.pairedWorkerId)) faults.push(`a pairing with a worker that was never started: ${event.itemId}`);
      if (ended.has(id)) faults.push(`a start after its end: ${event.itemId}`);
      const before = open.get(id);
      if (before !== undefined && before.turnId !== event.turnId) faults.push(`a second start under another turn: ${event.itemId}`);
      open.set(id, { turnId: event.turnId, workerId: event.workerId });
    } else if (event.type === 'activity-ended') {
      const id = key(event.workerId, event.itemId);
      const started = open.get(id);
      if (started === undefined) faults.push(`an end with no start: ${event.itemId}`);
      else if (started.turnId !== event.turnId) faults.push(`an end under another turn than its start: ${event.itemId}`);
      ended.add(id);
    }
  }
  return faults;
}

const asideOf = (event: AgentEvent): string | undefined => ('asideId' in event ? event.asideId : undefined);

/** An ask as main makes one (C26): the aside's id, its turn's, the text, the message's id, and what the session's newest ended turn was. */
function asideRequest(n: number, harness: FacetHarness, told: readonly AgentEvent[], patch: Partial<AsideRequest> = {}): AsideRequest {
  const through = told.findLast((event) => event.type === 'turn-started' && asideOf(event) === undefined);
  return {
    asideId: `aside-${n}`, turnId: `aside-turn-${n}`, text: harness.asides?.question ?? '', messageId: `00000000-0000-4000-8000-00000000a5${String(n).padStart(2, '0')}`, history: [],
    throughTurn: through?.type === 'turn-started' ? through.providerTurnId ?? null : null, effort: harness.effort, speed: null, ...patch,
  };
}

const isRaised = (event: AgentEvent): event is Extract<AgentEvent, { type: 'question-raised' }> => event.type === 'question-raised';
const isResolved = (event: AgentEvent): event is Extract<AgentEvent, { type: 'question-resolved' }> => event.type === 'question-resolved';
/** An answer that fits whatever was asked (M21, C78): the first option of each question, or a text where it has none. */
const answerTo = (raised: Extract<AgentEvent, { type: 'question-raised' }>): GivenAnswer[] => raised.questions.map((question) => (question.options.length > 0 && !question.secret ? { options: [0], text: null } : { options: [], text: 'An answer.' }));

const isAsked = (event: AgentEvent): event is Extract<AgentEvent, { type: 'approval-raised' }> => event.type === 'approval-raised';
const isDecided = (event: AgentEvent): event is Extract<AgentEvent, { type: 'approval-resolved' }> => event.type === 'approval-resolved';
/** The modes an event said the process runs under, in order (M22, C2). */
const modesSaid = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => (event.type === 'in-force' && event.mode !== undefined ? [event.mode] : []));
/** Something the model said: a message of an assistant's, whole or as it is written. */
const isSaid = (event: AgentEvent): boolean => event.type === 'message-delta' || (event.type === 'message' && event.role === 'assistant');
/** The failures a start that reported another policy ends its turn with (C46). */
const POLICY_FAILURES: readonly string[] = ['policy-mismatch', 'not-read-only'];

export function describeFacetContract(name: string, setup: () => Promise<FacetHarness>, declares: { readonly asides: boolean; readonly questions?: boolean; readonly declines?: boolean; readonly permissions?: boolean; readonly plans?: boolean } = { asides: false }): void {
  describe(`the session facet's contract: ${name}`, () => {
    // M23 (V11; C21, C36, C58, C73): images go with a prompt as a field every provider takes; a steer and
    // a command list are members a provider has or not, and where it has them they keep their contract.
    it('takes a prompt with images as any prompt, its turn going to its end (M23, C21)', async () => {
      const harness = await setup();
      try {
        const session = harness.facet.start(startOf(harness));
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1', attachments: [{ mediaType: 'image/png', path: `${harness.folder}/image.png`, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }] });
        const events = await seen.ended('turn-1');
        expect(events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
        await session.close();
      } finally { await harness.dispose(); }
    });

    it('offers no steer with no turn, has a steer state exactly where it has steer, and answers a steer with an outcome, never a rejection (M23, C36, C38)', async () => {
      const harness = await setup();
      try {
        const session = harness.facet.start(startOf(harness));
        expect(session.steer === undefined).toBe(session.steerState === undefined);
        if (session.steer !== undefined) {
          expect(session.steerState?.()).toBe('wait');
          // With no turn running, nothing is written: the message would be the next prompt's.
          const outcome = await session.steer({ turnId: 'turn-1', messageId: 'steer-1', prompt: 'Also this' });
          expect(['taken', 'handed', 'turn-over', 'refused', 'unknown']).toContain(outcome.kind);
          expect(outcome.kind).toBe('turn-over');
        }
        await session.close();
      } finally { await harness.dispose(); }
    });

    it('lists commands, where it lists any, as rows of single-token names; a session lists none before its process said (M23, C58, C65)', async () => {
      const harness = await setup();
      try {
        const rows = await harness.facet.commands?.(harness.folder, new AbortController().signal);
        for (const row of rows ?? []) {
          expect(row.name).toMatch(/^[^\s/]\S*$/u);
          expect(['commands', 'skills']).toContain(row.group);
          expect(row.selector === null || /^[0-9a-f]{16,64}$/.test(row.selector)).toBe(true);
        }
        const session = harness.facet.start(startOf(harness));
        if (session.commands !== undefined) expect(session.commands()).toBeNull();
        await session.close();
      } finally { await harness.dispose(); }
    });
    if (declares.plans !== true) {
      it('takes no plan turn: its descriptor declares no plans, and neither its facet nor its sessions have the members (M22b, C2)', async () => {
        const harness = await setup();
        try {
          expect(harness.plans).toBeUndefined();
          expect(harness.facet.plans).toBeUndefined();
          const session = harness.facet.start(startOf(harness));
          expect('decidePlan' in session).toBe(false);
          await session.close();
        } finally { await harness.dispose(); }
      });
    } else {
      /** A plan turn's session, under the plan's mode, with its turn sent. */
      const planning = async (harness: FacetHarness) => {
        const plans = harness.plans as PlanHarness;
        expect(plans).toBeDefined();
        await plans.arm?.();
        const session = harness.facet.start(startOf(harness, plans.mode));
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: plans.prompt, effort: harness.effort, speed: null, messageId: 'message-1', plan: true });
        return { session, seen, plans };
      };

      it('declares its plan turns under modes of its own, and says its account takes one (M22b, C2, C5, C13)', async () => {
        const harness = await setup();
        try {
          const { capability, mode } = harness.plans as PlanHarness;
          expect(capability.modes).toContain(mode);
          expect(capability.unavailable).not.toBe('');
          // Ids of its own modes, where it declares modes.
          if (harness.permissions !== undefined) for (const id of capability.modes) expect(harness.permissions.capability.modes.map((declared) => declared.id)).toContain(id);
          expect(harness.facet.plans?.()).toEqual({ available: true });
        } finally { await harness.dispose(); }
      });

      it('proposes a plan from a plan turn, under its turn, with its whole text, and takes the turn on to its end (M22b, C10, C14)', async () => {
        const harness = await setup();
        try {
          const { session, seen, plans } = await planning(harness);
          if (plans.kind === 'request') {
            const raised = await seen.first((event): event is Extract<AgentEvent, { type: 'plan-raised' }> => event.type === 'plan-raised', 'plan-raised');
            expect(raised).toMatchObject({ turnId: 'turn-1' });
            expect(raised.text).not.toBe('');
            expect(typeof session.decidePlan).toBe('function');
            // The turn waits on the decision; Execute carries it on to its end.
            expect(seen.events.some((event) => event.type === 'turn-ended')).toBe(false);
            expect(await session.decidePlan?.(raised.requestId, { kind: 'execute' })).toBe(true);
            // What it then asks leave for, under the plan's mode, is denied as a user may: the turn goes on to its end.
            const denied = new Set<string>();
            session.subscribe((event) => { if (event.type === 'approval-raised' && !denied.has(event.requestId)) { denied.add(event.requestId); void session.decide?.(event.requestId, 'deny'); } });
            for (const event of seen.events) if (event.type === 'approval-raised' && !denied.has(event.requestId)) { denied.add(event.requestId); void session.decide?.(event.requestId, 'deny'); }
          } else {
            const completed = await seen.first((event): event is Extract<AgentEvent, { type: 'plan-completed' }> => event.type === 'plan-completed', 'plan-completed');
            const deltas = seen.events.filter((event): event is Extract<AgentEvent, { type: 'plan-delta' }> => event.type === 'plan-delta' && event.itemId === completed.itemId);
            // Opened by its first, which may carry no text; completed whole, the authority.
            expect(deltas.length).toBeGreaterThan(0);
            expect(deltas.every((event) => event.turnId === 'turn-1')).toBe(true);
            expect(completed).toMatchObject({ turnId: 'turn-1' });
            expect(completed.text).not.toBe('');
            expect('decidePlan' in session).toBe(false);
          }
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(told.at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'completed', reported: true });
          await session.close();
        } finally { await harness.dispose(); }
      });

      it('takes a later turn that names a thread planned before as a turn as any (M22b, C55)', async () => {
        const harness = await setup();
        try {
          await (harness.plans as PlanHarness).arm?.();
          const session = harness.facet.start(startOf(harness, (harness.plans as PlanHarness).mode));
          const seen = collect(session);
          session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1', plannedBefore: true });
          const told = await seen.ended('turn-1');
          expect(told.some((event) => event.type === 'plan-raised' || event.type === 'plan-delta')).toBe(false);
          expect(told.at(-1)).toMatchObject({ type: 'turn-ended', reported: true });
          await session.close();
        } finally { await harness.dispose(); }
      });
    }

    if (declares.permissions !== true) {
      it('takes no decision and no change of mode: its descriptor declares no mode that asks, and neither its sessions nor its facet have the members (M22, C35, C39)', async () => {
        const harness = await setup();
        try {
          expect(harness.permissions).toBeUndefined();
          const session = harness.facet.start(startOf(harness));
          expect('decide' in session).toBe(false);
          expect('setMode' in session).toBe(false);
          expect(harness.facet.modes).toBeUndefined();
          expect(harness.facet.transition).toBeUndefined();
          expect(harness.facet.onModesChanged).toBeUndefined();
          await session.close();
        } finally { await harness.dispose(); }
      });
    } else {
      /** A session under the asking mode whose turn has asked leave: the request as it was raised, and everything told so far. */
      const asked = async (harness: FacetHarness, prompt?: string) => {
        const permissions = harness.permissions as PermissionHarness;
        expect(permissions).toBeDefined();
        await permissions.arm?.();
        const session = harness.facet.start(startOf(harness, permissions.asking));
        expect(typeof session.decide).toBe('function');
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: prompt ?? permissions.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        const raised = await seen.first(isAsked, 'approval-raised');
        return { session, seen, raised, permissions };
      };

      it('declares its modes in ids of its own, one of them its reading mode, and says which of them an account can use (M22, C39, C43, C45)', async () => {
        const harness = await setup();
        try {
          const { capability, mode, asking } = harness.permissions as PermissionHarness;
          const ids = capability.modes.map((declared) => declared.id);
          expect(ids.every(isModeId)).toBe(true);
          expect(new Set(ids).size).toBe(ids.length);
          // One reading mode, which asks nothing; the fallback is listed, and is never one that acts unasked.
          expect(capability.modes.filter((declared) => declared.reading).map((declared) => declared.asks)).toEqual([false]);
          const fallback = capability.modes.find((declared) => declared.id === capability.fallback);
          expect(fallback !== undefined && (fallback.asks || fallback.reading)).toBe(true);
          expect(capability.modes.find((declared) => declared.id === asking)?.asks).toBe(true);
          expect(ids).toContain(mode);
          // The three members go together, and with the declaration: what the account can use is said of declared modes alone.
          const { modes, transition, onModesChanged } = harness.facet;
          if (modes === undefined || transition === undefined || onModesChanged === undefined) throw new Error('the facet lacks a member its descriptor’s modes require');
          expect(modes().every((answer) => ids.includes(answer.id))).toBe(true);
          expect(modes().every((answer) => answer.available === (answer.reason === null))).toBe(true);
          // A change is taken on the live process exactly where the mode it reaches says so.
          for (const from of capability.modes) for (const to of capability.modes) {
            if (from.id !== to.id) expect(transition(from.id, to.id), `${from.id} to ${to.id}`).toBe(to.transitionsFrom.includes(from.id) ? 'idle' : 'restart');
          }
          const off = onModesChanged(() => undefined);
          expect(typeof off).toBe('function');
          off();
        } finally { await harness.dispose(); }
      });

      it('runs under the mode it was started with, and says so by the provider’s own word before anything it says (M22, C2, C39)', async () => {
        const harness = await setup();
        try {
          const { mode } = harness.permissions as PermissionHarness;
          const session = harness.facet.start(startOf(harness));
          const seen = collect(session);
          session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
          const told = await seen.ended('turn-1');
          // Said at least once, and never another: a prompt goes only to a process that reported the mode asked for.
          expect(modesSaid(told).length).toBeGreaterThan(0);
          expect(new Set(modesSaid(told))).toEqual(new Set([mode]));
          const said = told.findIndex((event) => event.type === 'in-force' && event.mode === mode);
          const spoke = told.findIndex(isSaid);
          expect(spoke === -1 || said < spoke).toBe(true);
          expect(told.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('takes no prompt where its start reports another mode: a notice of its kind, a failed end of the session’s own, and nothing said (M22, C46)', async () => {
        const harness = await setup();
        try {
          const permissions = harness.permissions as PermissionHarness;
          await permissions.mismatchNext();
          const session = harness.facet.start(startOf(harness, permissions.asking));
          const seen = collect(session);
          session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          const ends = told.filter((event) => event.type === 'turn-ended');
          expect(ends).toHaveLength(1);
          expect(ends[0]).toMatchObject({ turnId: 'turn-1', outcome: 'failed', reported: false });
          const failure = ends[0]?.type === 'turn-ended' ? ends[0].failure : undefined;
          expect(POLICY_FAILURES).toContain(failure);
          expect(told.filter((event) => event.type === 'notice').map((event) => (event.type === 'notice' ? event.kind : ''))).toContain(failure);
          // The mode asked for was never confirmed, and the model was asked nothing.
          expect(modesSaid(told)).not.toContain(permissions.asking);
          expect(told.some(isSaid)).toBe(false);
          expect(told.some(isAsked)).toBe(false);
          await session.close();
        } finally { await harness.dispose(); }
      });

      it('changes its mode on the live process where its descriptor declares that, confirmed by the provider’s own word; and has no such member where it declares none (M22, C2, C5, C90)', async () => {
        const harness = await setup();
        try {
          const permissions = harness.permissions as PermissionHarness;
          const declared = permissions.capability.modes.some((mode) => mode.transitionsFrom.length > 0);
          expect(permissions.idle !== undefined).toBe(declared);
          if (permissions.idle === undefined) {
            const session = harness.facet.start(startOf(harness));
            expect('setMode' in session).toBe(false);
            await session.close();
            return;
          }
          const { from, to } = permissions.idle;
          expect(harness.facet.transition?.(from, to)).toBe('idle');
          const session = harness.facet.start(startOf(harness, from));
          const seen = collect(session);
          session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
          expect(modesSaid(await seen.ended('turn-1')).at(-1)).toBe(from);
          const before = seen.events.length;
          await expect(session.setMode?.(to)).resolves.toEqual({ confirmed: true });
          // Its confirmation is an event too, under no turn: the session was idle.
          const changed = seen.events.slice(before);
          for (const event of changed) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(modesSaid(changed).at(-1)).toBe(to);
          expect(changed.some((event) => event.type === 'turn-started' || event.type === 'turn-ended')).toBe(false);
          // The process is the same one, and takes what comes next under the new mode.
          const then = seen.events.length;
          session.send({ turnId: 'turn-2', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-2' });
          const next = (await seen.ended('turn-2')).slice(then);
          expect(next.some((event) => event.type === 'session-started')).toBe(false);
          expect(modesSaid(next).every((mode) => mode === to)).toBe(true);
          expect(next.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true }]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('asks leave as a request under its turn, takes an approval for once, confirms it by the provider’s own word, and completes (M22, C8, C12, C13)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised, permissions } = await asked(harness);
          expect(AgentEventSchema.safeParse(raised).success).toBe(true);
          expect(raised).toMatchObject({ turnId: 'turn-1' });
          expect(raised.workerId).toBeUndefined();
          expect(raised.request.choices).toEqual(expect.arrayContaining(['approve', 'deny']));
          expect(raised.request.cut).toBe(false);
          // Asked under the mode that asks, which the process said it runs under.
          expect(modesSaid(seen.events)).toContain(permissions.asking);
          // The turn waits: nothing ended it, and nothing became of the request yet.
          expect(seen.events.some((event) => event.type === 'turn-ended' || event.type === 'approval-resolved')).toBe(false);
          await expect(session.decide?.(raised.requestId, 'approve')).resolves.toBe(true);
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          // One request, and one word of what became of it: the provider took the decision.
          expect(told.filter(isAsked)).toHaveLength(1);
          expect(told.filter(isDecided)).toEqual([{ type: 'approval-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
          expect(told.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
          expect(foldDeltas(told).faults).toEqual([]);
          expect(workFaults(told)).toEqual([]);
          // What it did with the leave is the action's own item, and it was declined by no one.
          expect(told.filter((event) => event.type === 'activity-ended' && event.status === 'declined')).toEqual([]);
          // A decision on a request that is held no more settles nothing, and never rejects.
          const before = seen.events.length;
          await expect(session.decide?.(raised.requestId, 'approve')).resolves.toEqual(expect.any(Boolean));
          await expect(session.decide?.('no-such-request', 'deny')).resolves.toEqual(expect.any(Boolean));
          expect(seen.events.slice(before).filter(isDecided)).toEqual([]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('takes a denial: confirmed as any decision, the action never run, and the turn ended by the provider’s own word (M22, C13, C76)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          await expect(session.decide?.(raised.requestId, 'deny')).resolves.toBe(true);
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(told.filter(isDecided)).toEqual([{ type: 'approval-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
          const ends = told.filter((event) => event.type === 'turn-ended');
          expect(ends).toHaveLength(1);
          expect(ends[0]).toMatchObject({ turnId: 'turn-1', reported: true });
          // Whatever the provider tells of the action, it never tells that it ran.
          expect(told.filter((event) => event.type === 'activity-ended' && event.itemId === raised.sourceId && event.status === 'completed')).toEqual([]);
          expect(workFaults(told)).toEqual([]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('takes a grant for the session where the request offers one, and asks nothing for what it covers on the same process (M22, C21, C57)', async () => {
        const harness = await setup();
        try {
          const granting = (harness.permissions as PermissionHarness).session;
          const { session, seen, raised } = await asked(harness, granting.prompt);
          // Offered by the request itself, in the CLI's own words for what it covers: never a choice of fat-g's.
          expect(raised.request.choices).toContain('approve-session');
          expect(raised.request.grant?.covers.trim()).not.toBe('');
          await expect(session.decide?.(raised.requestId, 'approve-session')).resolves.toBe(true);
          const first = await seen.ended('turn-1');
          expect(first.filter(isDecided)).toEqual([{ type: 'approval-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
          const then = seen.events.length;
          session.send({ turnId: 'turn-2', prompt: granting.again, effort: harness.effort, speed: null, messageId: 'message-2' });
          const next = (await seen.ended('turn-2')).slice(then);
          for (const event of next) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(next.filter(isAsked)).toEqual([]);
          expect(next.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true }]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('leaves a request held at a Stop to its turn’s end: interrupted, with nothing confirmed and nothing dropped (M22, C11)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          session.stop();
          const told = await seen.ended('turn-1');
          expect(told.filter((event) => event.type === 'turn-ended')).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: expect.any(Boolean) as boolean }]);
          // The registry's sweep at the turn's end withdraws it: the adapter says neither that the decision was taken nor that the process was lost.
          expect(told.filter(isDecided).filter((event) => event.requestId === raised.requestId && event.reason !== 'withdrawn')).toEqual([]);
          // Nothing is held any more: a decision that comes late approves nothing.
          const before = seen.events.length;
          await expect(session.decide?.(raised.requestId, 'approve')).resolves.toEqual(expect.any(Boolean));
          expect(seen.events.slice(before).filter(isDecided).filter((event) => event.reason === 'confirmed')).toEqual([]);
          await session.close();
        } finally { await harness.dispose(); }
      });

      it('refuses a request main cannot place: a notice says so, nothing is confirmed, and its turn still ends (M22, C9, C13)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          await expect(session.decide?.(raised.requestId, null)).resolves.toEqual(expect.any(Boolean));
          await seen.first((event): event is Extract<AgentEvent, { type: 'notice' }> => event.type === 'notice' && event.kind === 'request-refused', 'request-refused notice');
          // Whatever the provider makes of the refusal, the turn is the session's to stop.
          if (!seen.events.some((event) => event.type === 'turn-ended')) session.stop();
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(told.filter(isDecided).filter((event) => event.reason === 'confirmed')).toEqual([]);
          expect(told.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
          expect(told.filter((event) => event.type === 'activity-ended' && event.itemId === raised.sourceId && event.status === 'completed')).toEqual([]);
          await session.close();
        } finally { await harness.dispose(); }
      });

      it('says a request still held dropped before the end its close makes: a loss never reads as a withdrawal (M22, C11, C12)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          await expect(session.close()).resolves.toEqual({ ok: true });
          const told = seen.events;
          const dropped = told.findIndex((event) => event.type === 'approval-resolved' && event.requestId === raised.requestId);
          const end = told.findIndex((event) => event.type === 'turn-ended');
          expect(told[dropped]).toEqual({ type: 'approval-resolved', requestId: raised.requestId, reason: 'dropped' });
          expect(told.filter(isDecided)).toHaveLength(1);
          expect(told[end]).toMatchObject({ turnId: 'turn-1', reported: false });
          expect(dropped).toBeLessThan(end);
          // Gone with its process: nothing takes a decision now.
          await expect(session.decide?.(raised.requestId, 'approve')).resolves.toBe(false);
        } finally { await harness.dispose(); }
      });
    }

    if (declares.questions !== true) {
      it('takes no answer: its descriptor declares no blocking question, and its sessions have no such member (M21, C30)', async () => {
        const harness = await setup();
        try {
          expect(harness.questions).toBeUndefined();
          const session = harness.facet.start(startOf(harness));
          expect('answer' in session).toBe(false);
          await session.close();
        } finally { await harness.dispose(); }
      });
    } else {
      /** A session whose turn has asked: the request as it was raised, and everything told so far. */
      const asked = async (harness: FacetHarness) => {
        const questions = harness.questions as QuestionHarness;
        expect(questions).toBeDefined();
        await questions.arm?.();
        const session = harness.facet.start(startOf(harness));
        expect(typeof session.answer).toBe('function');
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: questions.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        const raised = await seen.first(isRaised, 'question-raised');
        return { session, seen, raised };
      };

      it('raises a question as a request under its turn, takes its answer by places, confirms it by the provider’s own word, and completes (M21, C20, C30, C63)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          expect(AgentEventSchema.safeParse(raised).success).toBe(true);
          expect(raised).toMatchObject({ turnId: 'turn-1' });
          expect(raised.workerId).toBeUndefined();
          expect(raised.questions.length).toBeGreaterThan(0);
          // The turn waits: nothing ended it, and nothing became of the request yet.
          expect(seen.events.some((event) => event.type === 'turn-ended' || event.type === 'question-resolved')).toBe(false);
          session.answer?.(raised.requestId, answerTo(raised));
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          // One request, and one word of what became of it: the provider took the answer.
          expect(told.filter(isRaised)).toHaveLength(1);
          expect(told.filter(isResolved)).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
          expect(told.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
          expect(foldDeltas(told).faults).toEqual([]);
          expect(workFaults(told)).toEqual([]);
          // An answer to a request that is held no more is nothing.
          session.answer?.(raised.requestId, answerTo(raised));
          session.answer?.('no-such-request', answerTo(raised));
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      if (declares.declines === true) {
        it('declines a question the user skipped: one word of the provider’s that it took the reply, and its turn completes (M100b, C31, C35)', async () => {
          const harness = await setup();
          try {
            const { session, seen, raised } = await asked(harness);
            expect(typeof session.decline).toBe('function');
            session.decline?.(raised.requestId);
            const told = await seen.ended('turn-1');
            for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
            expect(told.filter(isResolved)).toEqual([{ type: 'question-resolved', requestId: raised.requestId, reason: 'confirmed' }]);
            expect(told.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
            // Replied to once: a second decline, or an answer after it, is nothing.
            session.decline?.(raised.requestId);
            session.answer?.(raised.requestId, answerTo(raised));
            await expect(session.close()).resolves.toEqual({ ok: true });
          } finally { await harness.dispose(); }
        });
      } else {
        it('declines nothing: its descriptor does not say `declines`, and its sessions have no such member (M100b, C33)', async () => {
          const harness = await setup();
          try {
            const session = harness.facet.start(startOf(harness));
            expect('decline' in session).toBe(false);
            await session.close();
          } finally { await harness.dispose(); }
        });
      }

      it('refuses a request main cannot place: a notice says so, nothing is confirmed, and its turn still ends (M21, C11, C30)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          session.answer?.(raised.requestId, null);
          await seen.first((event): event is Extract<AgentEvent, { type: 'notice' }> => event.type === 'notice' && event.kind === 'request-refused', 'request-refused notice');
          // Whatever the provider makes of the refusal, the turn is the session's to stop.
          if (!seen.events.some((event) => event.type === 'turn-ended')) session.stop();
          const told = await seen.ended('turn-1');
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(told.filter(isResolved).filter((event) => event.reason === 'confirmed')).toEqual([]);
          expect(told.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
          await session.close();
        } finally { await harness.dispose(); }
      });

      it('leaves a request held at a Stop to its turn’s end: interrupted, with nothing confirmed and nothing dropped (M21, C22, C27)', async () => {
        const harness = await setup();
        try {
          const { session, seen, raised } = await asked(harness);
          session.stop();
          const told = await seen.ended('turn-1');
          expect(told.filter((event) => event.type === 'turn-ended')).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: expect.any(Boolean) as boolean }]);
          // The registry's sweep at the turn's end withdraws it: the adapter says neither that the answer was taken nor that the process was lost.
          expect(told.filter(isResolved).filter((event) => event.requestId === raised.requestId && event.reason !== 'withdrawn')).toEqual([]);
          // Nothing is held any more: an answer that comes late is nothing, and the session takes what comes next.
          session.answer?.(raised.requestId, answerTo(raised));
          await session.close();
        } finally { await harness.dispose(); }
      });
    }

    if (!declares.asides) {
      it('takes no question beside a session: its descriptor declares none, and its sessions have no such member (M20b, C24)', async () => {
        const harness = await setup();
        try {
          expect(harness.asides).toBeUndefined();
          const session = harness.facet.start(startOf(harness));
          expect('ask' in session).toBe(false);
          expect('stopAside' in session).toBe(false);
          await session.close();
        } finally { await harness.dispose(); }
      });
    } else {
      /** A session that has held a turn: what main requires before it takes an ask (C10). */
      const held = async (harness: FacetHarness) => {
        const session = harness.facet.start(startOf(harness));
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        await seen.ended('turn-1');
        return { session, seen };
      };

      it('answers a question asked beside a session: every event names the aside and its own turn, and it ends by the provider’s own word (M20b, C25, C26)', async () => {
        const harness = await setup();
        try {
          const asides = harness.asides as AsideHarness;
          expect(asides).toBeDefined();
          const { session, seen } = await held(harness);
          const before = seen.events.length;
          session.ask?.(asideRequest(1, harness, seen.events));
          const told = (await seen.ended('aside-turn-1')).slice(before);
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          // Nothing else was said meanwhile: the session, idle, tells nothing of its own for an aside.
          expect(told.map(asideOf)).toEqual(told.map(() => 'aside-1'));
          expect(told.filter((event) => turnOf(event) !== undefined).every((event) => turnOf(event) === 'aside-turn-1')).toBe(true);
          const folded = foldDeltas(told);
          expect(folded.faults).toEqual([]);
          expect(folded.open).toEqual([]);
          expect(workFaults(told)).toEqual([]);
          // One end, the provider's own, and the last thing said of it.
          const ends = told.filter((event) => event.type === 'turn-ended');
          expect(ends.map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'completed', reported: true }]);
          expect(told.at(-1)?.type).toBe('turn-ended');
          // Its answer is a message of the aside's turn, with something in it; nothing of the session's state is told for it.
          const said = folded.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [event] : []));
          expect(said.length).toBeGreaterThan(0);
          const answerItemId = ends[0]?.type === 'turn-ended' ? ends[0].answerItemId : undefined;
          const answer = said.find((message) => message.itemId === answerItemId) ?? said.findLast((message) => message.phase === 'final');
          expect(answer?.text.trim()).not.toBe('');
          expect(answer).toBeDefined();
          expect(told.filter((event) => ['session-started', 'in-force', 'action-changed', 'worker-started', 'worker-progressed', 'worker-ended'].includes(event.type))).toEqual([]);
          // As its capability says: an answer as it is written, or whole; what it did, or nothing.
          expect(told.some((event) => event.type === 'message-delta')).toBe(asides.capability.streamed);
          if (asides.capability.tools === 'none') expect(told.filter((event) => event.type === 'activity-started' || event.type === 'activity-ended')).toEqual([]);

          // The session goes on as it was: its next prompt is a turn of its own, with no aside's name in it.
          const then = seen.events.length;
          session.send({ turnId: 'turn-2', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-2' });
          const next = (await seen.ended('turn-2')).slice(then);
          expect(next.map(asideOf).filter((id) => id !== undefined)).toEqual([]);
          expect(next.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true }]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('answers beside a turn of the session’s, each event under its own name, and both end (M20b, C17, C21, C34)', async () => {
        const harness = await setup();
        try {
          const { session, seen } = await held(harness);
          const before = seen.events.length;
          session.send({ turnId: 'turn-2', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-2' });
          session.ask?.(asideRequest(1, harness, seen.events.slice(0, before)));
          await Promise.all([seen.ended('turn-2'), seen.ended('aside-turn-1')]);
          const told = seen.events.slice(before);
          const own = told.filter((event) => asideOf(event) === undefined);
          const asked = told.filter((event) => asideOf(event) === 'aside-1');
          expect(own.length + asked.length).toBe(told.length);
          // The session's turn is told as a turn asked nothing beside is: its events name it alone, and it completes.
          expect(own.filter((event) => turnOf(event) !== undefined).every((event) => turnOf(event) === 'turn-2')).toBe(true);
          expect(own.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true }]);
          expect(foldDeltas(own).faults).toEqual([]);
          expect(foldDeltas(own).open).toEqual([]);
          expect(workFaults(own)).toEqual([]);
          expect(asked.filter((event) => turnOf(event) !== undefined).every((event) => turnOf(event) === 'aside-turn-1')).toBe(true);
          expect(asked.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'completed', reported: true }]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('ends a stopped aside as interrupted, by its own Stop alone, and the session takes what comes next (M20b, C12, C70)', async () => {
        const harness = await setup();
        try {
          const asides = harness.asides as AsideHarness;
          const { session, seen } = await held(harness);
          await asides.holdNext();
          const before = seen.events.length;
          session.ask?.(asideRequest(1, harness, seen.events));
          await new Promise((resolve) => setTimeout(resolve, 50));
          session.stopAside?.('aside-1');
          const told = (await seen.ended('aside-turn-1')).slice(before);
          await asides.release();
          expect(told.map(asideOf)).toEqual(told.map(() => 'aside-1'));
          const ends = told.filter((event) => event.type === 'turn-ended');
          // Whose end it is depends on the route: a Stop the provider confirmed is its own word, one pressed before the provider named the turn is not.
          expect(ends).toHaveLength(1);
          expect(ends[0]).toMatchObject({ turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'interrupted' });
          expect(told.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(false);
          // A Stop of an aside that is not asked is nothing.
          session.stopAside?.('aside-9');
          // The session's own turn was never stopped, and its process is still its own.
          const then = seen.events.length;
          session.send({ turnId: 'turn-2', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-2' });
          const next = (await seen.ended('turn-2')).slice(then);
          expect(next.filter((event) => event.type === 'turn-ended').map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true }]);
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('ends a refused aside as failed, with a notice that names it, and the session is untouched (M20b, C13, C19, C62)', async () => {
        const harness = await setup();
        try {
          const asides = harness.asides as AsideHarness;
          const { session, seen } = await held(harness);
          await asides.refuseNext();
          const before = seen.events.length;
          session.ask?.(asideRequest(1, harness, seen.events));
          const told = (await seen.ended('aside-turn-1')).slice(before);
          await asides.release();
          for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
          expect(told.map(asideOf)).toEqual(told.map(() => 'aside-1'));
          const end = told.at(-1);
          expect(end).toMatchObject({ type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'failed' });
          // Said in a notice of the aside's own, before its end: never as a message, and never as the session's.
          expect(told.filter((event) => event.type === 'notice')).toHaveLength(1);
          expect(told.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(false);
          // The aside can be asked again, and the session takes its next prompt.
          session.ask?.(asideRequest(2, harness, seen.events));
          expect((await seen.ended('aside-turn-2')).findLast((event) => event.type === 'turn-ended')).toMatchObject({ asideId: 'aside-2', outcome: 'completed', reported: true });
          session.send({ turnId: 'turn-2', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-2' });
          expect((await seen.ended('turn-2')).findLast((event) => event.type === 'turn-ended')).toMatchObject({ turnId: 'turn-2', outcome: 'completed' });
          await expect(session.close()).resolves.toEqual({ ok: true });
        } finally { await harness.dispose(); }
      });

      it('ends an open aside when the session is closed, before the session’s own close answers (M20b, C34)', async () => {
        const harness = await setup();
        try {
          const asides = harness.asides as AsideHarness;
          const { session, seen } = await held(harness);
          await asides.holdNext();
          const before = seen.events.length;
          session.ask?.(asideRequest(1, harness, seen.events));
          await new Promise((resolve) => setTimeout(resolve, 50));
          await expect(session.close()).resolves.toEqual({ ok: true });
          await asides.release();
          const ends = seen.events.slice(before).filter((event) => event.type === 'turn-ended');
          expect(ends).toHaveLength(1);
          // Ended by the session, and never by a word the provider did not say.
          expect(ends[0]).toMatchObject({ turnId: 'aside-turn-1', asideId: 'aside-1', reported: false });
          expect(ends[0]?.type === 'turn-ended' ? ends[0].outcome : 'completed').not.toBe('completed');
        } finally { await harness.dispose(); }
      });
    }

    it('says nothing before its first prompt, then runs a turn whose every event passes the schema and names its turn', async () => {
      const harness = await setup();
      try {
        const session = harness.facet.start(startOf(harness));
        const seen = collect(session);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(seen.events).toEqual([]);

        session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        const told = await seen.ended('turn-1');
        for (const event of told) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
        expect(told.filter((event) => turnOf(event) !== undefined).every((event) => turnOf(event) === 'turn-1')).toBe(true);
        // A message may come in deltas (M19, C57): each is folded into its message, and a turn that
        // completed left none open. From here on the contract looks at whole messages alone.
        const folded = foldDeltas(told);
        expect(folded.faults).toEqual([]);
        expect(folded.open).toEqual([]);
        const { events } = folded;
        // What it did, where it tells any (M20a, C53): each activity ended under the id, turn and owner it started with.
        expect(workFaults(told)).toEqual([]);
        // A turn that ran to its end ends by the provider's own word (M18, C59). The answer it may
        // name is looked at below: the end is compared without it (M16, C84).
        const ends = events.filter((event) => event.type === 'turn-ended');
        expect(ends.map(withoutAnswer)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
        expect(events.at(-1)?.type).toBe('turn-ended');

        // The reference comes once, with the folder the session started in, before the turn's end.
        const started = events.filter((event) => event.type === 'session-started');
        expect(started).toHaveLength(1);
        expect(started[0]).toMatchObject({ folder: harness.folder });

        // The answer is a message, told either way (M16, C74, C84): labelled `final` as it arrives,
        // or named by its item id on the turn's completed end. A named answer is a message the turn
        // gave; the echo of the user's own carries the id it was sent with.
        // The session's own: what a worker of it said is the worker's (M20a, C20), and never the answer.
        const said = events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' && event.workerId === undefined ? [event] : []));
        const answerItemId = ends[0]?.answerItemId;
        const named = answerItemId !== undefined && said.some((message) => message.itemId === answerItemId);
        if (answerItemId !== undefined) expect(named).toBe(true);
        expect(named || said.some((message) => message.phase === 'final')).toBe(true);
        const echo = events.find((event) => event.type === 'message' && event.role === 'user');
        if (echo?.type === 'message') expect(echo.clientId).toBe('message-1');
        await expect(session.close()).resolves.toEqual({ ok: true });
      } finally { await harness.dispose(); }
    });

    it('ends a turn as interrupted when it is stopped, and takes the next prompt', async () => {
      const harness = await setup();
      try {
        const session = harness.facet.start(startOf(harness));
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        session.stop();
        const events = await seen.ended('turn-1');
        // Whose end it is depends on the provider (M18, C59): a Stop it confirmed is its own word, a prompt stopped before it reached the provider is not.
        expect(events.filter((event) => event.type === 'turn-ended')).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: expect.any(Boolean) as boolean }]);
        for (const event of events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event.type)).toBe(true);
        // A message may be left open by a Stop (M19, C18); what was told of it is in order all the same,
        // and so is what was told of its work (M20a, C53).
        expect(foldDeltas(events).faults).toEqual([]);
        expect(workFaults(events)).toEqual([]);
        await session.close();
      } finally { await harness.dispose(); }
    });

    it('resolves `closed` when it is closed, ending a running turn first: an end the provider did not report', async () => {
      const harness = await setup();
      try {
        const session = harness.facet.start(startOf(harness));
        const seen = collect(session);
        session.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        const result = await session.close();
        expect(result).toEqual({ ok: true });
        await expect(session.closed).resolves.toEqual({ ok: true });
        // The session's own end, never the provider's (M18, C59).
        expect(seen.events.filter((event) => event.type === 'turn-ended')).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
        await expect(session.recheck()).resolves.toEqual({ ok: true });
      } finally { await harness.dispose(); }
    });

    it('resumes a session by its reference, with no second reference, and reads its earlier conversation back where the provider can', async () => {
      const harness = await setup();
      try {
        const first = harness.facet.start(startOf(harness));
        const seenFirst = collect(first);
        first.send({ turnId: 'turn-1', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-1' });
        const firstEvents = await seenFirst.ended('turn-1');
        const started = firstEvents.find((event) => event.type === 'session-started');
        const firstTurn = firstEvents.find((event) => event.type === 'turn-started');
        await first.close();
        if (started?.type !== 'session-started') throw new Error('no reference');

        const again = harness.facet.resume({ ...startOf(harness), reference: started.reference, processKey: 'process-2' });
        const seen = collect(again);
        again.send({ turnId: 'turn-2', prompt: harness.prompt, effort: harness.effort, speed: null, messageId: 'message-2' });
        const events = foldDeltas(await seen.ended('turn-2')).events;
        expect(events.some((event) => event.type === 'session-started')).toBe(false);
        expect(withoutAnswer(events.at(-1) as AgentEvent)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true });
        await again.close();

        // The member and the capability go together (M18, C6): without it, nothing is asked.
        const { history } = harness.facet;
        if (!harness.history) { expect(history).toBeUndefined(); return; }
        if (history === undefined) throw new Error('the facet has no history member');

        const answer = await history.read(started.reference, { cursor: null, size: 8, detail: 'full' }, new AbortController().signal);
        if (answer.kind !== 'page') throw new Error(`the history read answered ${answer.kind}`);
        expect(answer.messages.length).toBeGreaterThan(0);
        for (const message of answer.messages) expect(HistoryMessageSchema.safeParse(message).success).toBe(true);
        expect(answer.messages.some((message) => message.role === 'user')).toBe(true);
        expect(answer.messages.some((message) => message.role === 'assistant')).toBe(true);

        // Its turns, with their ids, outcome and times (M18, C47, C51), and each message under one of them, in their order.
        expect(answer.turns.length).toBeGreaterThan(0);
        for (const turn of answer.turns) expect(HistoryTurnSchema.safeParse(turn).success, turn.turnId).toBe(true);
        const ids = answer.turns.map((turn) => turn.turnId);
        expect(new Set(ids).size).toBe(ids.length);
        const places = answer.messages.map((message) => ids.indexOf(message.turnId));
        expect(places.every((place) => place !== -1)).toBe(true);
        expect(places).toEqual([...places].sort((a, b) => a - b));
        // The turn this test ran first is one of them, by the id its start gave.
        if (firstTurn?.type === 'turn-started' && firstTurn.providerTurnId !== undefined) expect(ids).toContain(firstTurn.providerTurnId);

        // Asked for no item, the same turns and no message.
        const bare = await history.read(started.reference, { cursor: null, size: 8, detail: 'none' }, new AbortController().signal);
        if (bare.kind !== 'page') throw new Error(`the history read answered ${bare.kind}`);
        expect(bare.messages).toEqual([]);
        expect(bare.turns.map((turn) => turn.turnId)).toEqual(ids);
        for (const turn of bare.turns) expect(HistoryTurnSchema.safeParse(turn).success, turn.turnId).toBe(true);
      } finally { await harness.dispose(); }
    });
  });
}
