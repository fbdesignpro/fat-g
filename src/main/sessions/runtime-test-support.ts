// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session facet for the runtime's tests: every session it makes is in a test's hands — what was
// sent to it, its events, its end. It launches nothing. Not a test, and it imports no test library:
// the runtime-dependencies test reads this file as source.
import type { AgentEvent, HistoryMessage, HistoryTurn } from '@shared/contracts/agent-events';
import type { SteerState } from '@shared/contracts/composer';
import type { CommandNoticeKind } from '@shared/contracts/conversation';
import type { ApprovalChoice, GivenAnswer } from '@shared/contracts/interaction';
import type { ModeAvailability, ModeTransition } from '@shared/contracts/permissions';
import type { PlanAvailability } from '@shared/contracts/plans';
import type { AsideRequest, HistoryAnswer, HistoryFacet, HistoryRequest, ModeChange, PlanAnswer, ProviderCommand, ProviderSession, SandboxFacet, SessionFacet, SessionResume, SessionStart, SteerOutcome, SteerRequest, TurnRequest } from '@shared/provider-kit/sessions';

export interface FakeSession {
  readonly kind: 'start' | 'resume';
  readonly options: SessionStart & { readonly reference?: string };
  readonly sent: TurnRequest[];
  /** The questions asked beside it (M20b), and the asides whose Stop was pressed, in order. */
  readonly asked: AsideRequest[];
  readonly asideStops: string[];
  /** The answers given to its requests (M21), in order: null for a request main refused. */
  readonly answered: { readonly requestId: string; readonly answers: readonly GivenAnswer[] | null }[];
  /** The decisions given to its requests (M22), in order: null for a request main refused. */
  readonly decided: { readonly requestId: string; readonly choice: ApprovalChoice | null }[];
  /** The decisions given to its plans' requests (M22b), in order: null for a request main refused. */
  readonly planned: { readonly requestId: string; readonly answer: PlanAnswer | null }[];
  /** What a decision's write answers (M22, C12): it went, the process did not take it, or — `silent` — the promise never settles. */
  delivery: boolean | 'silent';
  /** The modes asked of the live process (M22, C2), in order, and what each is answered: a change, or — `hold` — nothing until `settleMode`. */
  readonly modeSets: string[];
  modeChange: ModeChange | 'hold';
  /** Answers the change a `hold` left waiting. */
  settleMode(change: ModeChange): void;
  stops: number;
  closes: number;
  /** `close()` does not end the session by itself: the test ends it, as a tree that takes its time does. */
  slowClose: boolean;
  /** What `close()` and the session's own end answer, and what a look at it afterwards finds. */
  cleanup: { ok: boolean };
  recheck: { ok: boolean };
  rechecks: number;
  /** Messages sent into its running turn (M23), in order. */
  readonly steers: SteerRequest[];
  /** Whether it says a message can be sent into its turn now (M23, C35): a test changes it, and emits `steer-changed` where the runtime should hear of it. */
  steerState: SteerState;
  /** What a steer answers (M23, C38–C40), or — `hold` — nothing until `settleSteer`. */
  steerOutcome: SteerOutcome | 'hold';
  /** Answers the steer a `hold` left waiting. */
  settleSteer(outcome: SteerOutcome): void;
  /** What its process lists of its commands (M23): null until a test says. */
  listed: readonly ProviderCommand[] | null;
  readonly session: ProviderSession;
  emit(event: AgentEvent | Record<string, unknown>): void;
  /** The session ends by itself. */
  end(result?: { ok: boolean }): void;
  readonly ended: boolean;
}

export interface FakeFacet {
  /** With its history member, or — made with `history: false` — without (M18, C25). */
  readonly facet: SessionFacet;
  readonly made: FakeSession[];
  latest(): FakeSession;
  /** Every history page asked for, in order. */
  readonly reads: { reference: string; page: HistoryRequest }[];
  /** What a history read answers; a function sees the request. */
  history: HistoryAnswer | ((reference: string, page: HistoryRequest) => HistoryAnswer | Promise<HistoryAnswer>);
  /** The facet says earlier messages can be read again. */
  available(): void;
  /** Told of each prompt as it is dispatched, before it is recorded as sent: what a test checks at that moment. */
  onSend: ((turn: TurnRequest) => void) | null;
}

/** What a fake facet says of its plans (M22b): whether its account's CLI takes a plan turn now. Its sessions take a plan's decision. */
export interface FakePlans {
  availability?: () => PlanAvailability;
}

/** What a fake facet says of its modes (M22): how a change is made, what an account can use, and its sandbox's setup. Each in the test's hands. */
export interface FakePermissions {
  transition?: (from: string, to: string) => ModeTransition;
  modes?: () => readonly ModeAvailability[];
  sandbox?: SandboxFacet;
}

export function fakeFacet(options: { /** Its sessions take a message during a turn (M23, C36). */ readonly steers?: boolean; /** Its commands (M23): listed by each process, or — a function — by the instance for a folder; fat-g's own; and whether the CLI's come only once a process ran. */ readonly commands?: 'process' | ((folder: string) => readonly ProviderCommand[] | null); readonly interceptedCommands?: SessionFacet['interceptedCommands']; readonly commandsOnceStarted?: boolean; /** Its sessions run under modes (M22): they take a decision, and a change of mode on the live process. */ readonly permissions?: FakePermissions; /** False: its sessions take no answer, as a provider's that asks no blocking question (M21, C30). */ readonly questions?: boolean; readonly history?: boolean; /** False: its sessions take no ask, as a provider's that answers no aside (M20b, C24). */ readonly asides?: boolean; /** The provider's own commands that are answered and never sent (M20b, C55). */ readonly intercepts?: (prompt: string) => CommandNoticeKind | null; /** Its sessions plan (M22b). */ readonly plans?: FakePlans } = {}): FakeFacet {
  const made: FakeSession[] = [];
  const listeners = new Set<() => void>();
  const reads: { reference: string; page: HistoryRequest }[] = [];

  const facet: { onSend: ((turn: TurnRequest) => void) | null } = { onSend: null };

  const asides = options.asides !== false;
  const steers = options.steers === true;
  const listing = options.commands;
  const questions = options.questions !== false;
  const { permissions, plans } = options;
  function make(kind: 'start' | 'resume', options: SessionStart | SessionResume): ProviderSession {
    const subscribers = new Set<(event: AgentEvent) => void>();
    let ended = false;
    let resolveClosed: (result: { ok: boolean }) => void = () => undefined;
    const closed = new Promise<{ ok: boolean }>((resolve) => { resolveClosed = resolve; });
    let waitingMode: ((change: ModeChange) => void) | null = null;
    let waitingSteer: ((outcome: SteerOutcome) => void) | null = null;
    const fake: FakeSession = {
      kind, options, sent: [], asked: [], asideStops: [], answered: [], decided: [], planned: [], delivery: true, modeSets: [], modeChange: { confirmed: true }, stops: 0, closes: 0, slowClose: false, cleanup: { ok: true }, recheck: { ok: true }, rechecks: 0,
      steers: [], steerState: 'open', steerOutcome: { kind: 'taken' }, listed: null,
      settleMode(change) { const settle = waitingMode; waitingMode = null; settle?.(change); },
      settleSteer(outcome) { const settle = waitingSteer; waitingSteer = null; settle?.(outcome); },
      get ended() { return ended; },
      emit(event) { for (const subscriber of [...subscribers]) subscriber(event as AgentEvent); },
      end(result) {
        if (ended) return;
        ended = true;
        resolveClosed(result ?? fake.cleanup);
      },
      session: {
        subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
        send(turn) { facet.onSend?.(turn); fake.sent.push(turn); },
        stop() { fake.stops += 1; },
        ...(asides ? { ask(aside: AsideRequest) { fake.asked.push(aside); }, stopAside(asideId: string) { fake.asideStops.push(asideId); } } : {}),
        ...(listing === 'process' ? { commands() { return fake.listed; } } : {}),
        ...(steers ? {
          steerState() { return fake.steerState; },
          steer(request: SteerRequest) {
            fake.steers.push(request);
            const { steerOutcome } = fake;
            return steerOutcome === 'hold' ? new Promise<SteerOutcome>((resolve) => { waitingSteer = resolve; }) : Promise.resolve(steerOutcome);
          },
        } : {}),
        ...(questions ? { answer(requestId: string, answers: readonly GivenAnswer[] | null) { fake.answered.push({ requestId, answers }); } } : {}),
        ...(plans === undefined ? {} : {
          decidePlan(requestId: string, answer: PlanAnswer | null) {
            fake.planned.push({ requestId, answer });
            return Promise.resolve(fake.delivery !== false);
          },
        }),
        ...(permissions === undefined ? {} : {
          decide(requestId: string, choice: ApprovalChoice | null) {
            fake.decided.push({ requestId, choice });
            const { delivery } = fake;
            return delivery === 'silent' ? new Promise<boolean>(() => undefined) : Promise.resolve(delivery);
          },
          setMode(mode: string) {
            fake.modeSets.push(mode);
            const { modeChange } = fake;
            return modeChange === 'hold' ? new Promise<ModeChange>((resolve) => { waitingMode = resolve; }) : Promise.resolve(modeChange);
          },
        }),
        closed,
        close() { fake.closes += 1; if (!fake.slowClose) fake.end(); return closed; },
        recheck() { fake.rechecks += 1; return Promise.resolve(fake.recheck); },
      },
    };
    made.push(fake);
    return fake.session;
  }

  const history: HistoryFacet = {
    read(reference, page) {
      reads.push({ reference, page });
      return Promise.resolve(typeof fake.history === 'function' ? fake.history(reference, page) : fake.history);
    },
    onAvailable(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const fake: FakeFacet = {
    made, reads,
    get onSend() { return facet.onSend; },
    set onSend(listener) { facet.onSend = listener; },
    history: { kind: 'page', turns: [], messages: [], next: null },
    latest() {
      const last = made.at(-1);
      if (last === undefined) throw new Error('no session was made');
      return last;
    },
    available() { for (const listener of [...listeners]) listener(); },
    facet: {
      start: (start) => make('start', start),
      resume: (resume) => make('resume', resume),
      ...(options.history === false ? {} : { history }),
      ...(options.intercepts === undefined ? {} : { intercepts: options.intercepts }),
      ...(typeof listing === 'function' ? { commands: (folder: string) => Promise.resolve(listing(folder)) } : {}),
      ...(options.interceptedCommands === undefined ? {} : { interceptedCommands: options.interceptedCommands }),
      ...(options.commandsOnceStarted === true ? { commandsOnceStarted: true } : {}),
      ...(plans === undefined ? {} : { plans: () => plans.availability?.() ?? { available: true } }),
      ...(permissions === undefined ? {} : {
        modes: () => permissions.modes?.() ?? [],
        transition: (from: string, to: string) => permissions.transition?.(from, to) ?? 'restart',
        onModesChanged: () => () => undefined,
        ...(permissions.sandbox === undefined ? {} : { sandbox: permissions.sandbox }),
      }),
    },
  };
  return fake;
}

export interface FakeHistoryTurn {
  readonly turn: HistoryTurn;
  /** In the provider's order. Each names this turn. */
  readonly messages: readonly HistoryMessage[];
}

/** A turn of a provider's history, completed, with fixed times a test can tell from the local clock's. */
export function historyTurn(turnId: string, messages: readonly Omit<HistoryMessage, 'turnId' | 'at'>[] = [], patch: Partial<HistoryTurn> = {}): FakeHistoryTurn {
  const turn: HistoryTurn = { turnId, outcome: 'completed', startedAt: 1_000, endedAt: 3_000, durationMs: 1_900, ...patch };
  return { turn, messages: messages.map((message) => ({ ...message, turnId, at: turn.startedAt })) };
}

/**
 * A provider's history, oldest first, paged as a facet pages it (M18, C51): newest first, `size`
 * turns from a cursor, each page's turns and messages oldest first. `none` gives turns alone and
 * `summary` the user's message and the final answer. `dropped` says which requests are too large to
 * take. The cursor is how many newer turns were already given.
 */
export function pagedHistory(
  turns: readonly FakeHistoryTurn[] | (() => readonly FakeHistoryTurn[]),
  dropped: (page: HistoryRequest, turns: readonly FakeHistoryTurn[]) => boolean = () => false,
): (reference: string, page: HistoryRequest) => HistoryAnswer {
  return (_reference, page) => {
    const newestFirst = [...(typeof turns === 'function' ? turns() : turns)].reverse();
    const offset = page.cursor === null ? 0 : Number(page.cursor);
    if (!Number.isInteger(offset) || offset < 0) return { kind: 'failed' };
    const slice = newestFirst.slice(offset, offset + page.size);
    if (dropped(page, slice)) return { kind: 'dropped' };
    const oldestFirst = [...slice].reverse();
    const messages = page.detail === 'none' ? [] : oldestFirst.flatMap((entry) => (page.detail === 'full' ? entry.messages : entry.messages.filter((message) => message.role === 'user' || message.phase === 'final')));
    return { kind: 'page', turns: oldestFirst.map((entry) => entry.turn), messages, next: offset + page.size < newestFirst.length ? String(offset + page.size) : null };
  };
}
