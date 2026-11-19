// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V34 (docs/planning/_archive/M13.md; C25, C62, C75): a third provider, defined only here — the proof that
// adding a provider needs no edit outside its own folder and the list of built-ins. Its defaults are
// an inline object where a real module imports its catalog-defaults.json. Browser-safe:
// tsconfig.web.json compiles this file too, and it imports from src/shared only.
import type { CatalogProvider } from '@shared/contracts/catalog';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { AgentEvent, HistoryMessage, HistoryTurn } from '@shared/contracts/agent-events';
import type { AsideCapability } from '@shared/contracts/aside';
import type { ApprovalChoice, BoundQuestion, GivenAnswer, RaisedApprovalRequest } from '@shared/contracts/interaction';
import type { ModeAvailability, PermissionCapability } from '@shared/contracts/permissions';
import { PLANS_AVAILABLE, type PlanCapability } from '@shared/contracts/plans';
import type { AgentProvider, InstanceSupport, ProviderDefinition } from '@shared/provider-kit/provider';
import type { AsideRequest, HistoryAnswer, HistoryFacet, ModeChange, ProviderSession, SessionFacet, SessionStart, TurnRequest } from '@shared/provider-kit/sessions';

export const EXAMPLE_ID = 'example';
export const EXAMPLE_GUIDE = 'https://example.test/install';

/** What its catalog-defaults.json would hold. */
export const EXAMPLE_DEFAULTS = {
  presentation: { barColor: '#6644aa', icon: { viewBox: '0 0 24 24', path: 'M12 2L22 22H2Z' } },
  canRequestSpeedTier: false,
  efforts: [{ id: 'quick', label: 'Quick' }, { id: 'deep', label: 'Deep', caution: true }],
};

export const EXAMPLE_DESCRIPTOR: ProviderDescriptor = {
  id: EXAMPLE_ID,
  displayName: 'Example',
  installGuidance: 'Install the Example CLI, then sign in from your own terminal.',
  loginCommand: 'example login',
  minPollIntervalSec: 60,
  capabilities: { account: false, usage: 'none', sessions: false, history: false, otherFolders: false, models: false, asides: 'none', questions: 'none', permissions: null },
};

/**
 * What lets it run as several accounts (M14b, C5, C52): a variable and a folder of its own, and
 * one name and one prefix an added account does not inherit, so tests cover both kinds.
 */
export const EXAMPLE_INSTANCES: InstanceSupport = {
  variable: 'EXAMPLE_CLI_HOME',
  defaultFolder: ['.example-cli'],
  withhold: { names: ['EXAMPLE_CLI_TOKEN'], prefixes: ['EXAMPLE_BACKEND_'] },
};

/** Its definition. Installed nowhere, so its adapter launches nothing. */
export function exampleDefinition(): ProviderDefinition {
  return { ...exampleDefinitionWithoutInstances(), instances: EXAMPLE_INSTANCES };
}

/** Its twin: the same provider with no declaration, so one account and no Add account (C5). */
export function exampleDefinitionWithoutInstances(): ProviderDefinition {
  const provider: AgentProvider = {
    descriptor: EXAMPLE_DESCRIPTOR,
    detect: () => Promise.resolve({ kind: 'not-installed', overrideInvalid: false }),
    getAccount: () => Promise.resolve({ kind: 'error', reason: 'temporarily-unavailable' }),
    getUsage: () => Promise.resolve({ kind: 'error', reason: 'temporarily-unavailable' }),
    dispose: () => Promise.resolve(),
  };
  return {
    descriptor: EXAMPLE_DESCRIPTOR,
    catalogDefaults: EXAMPLE_DEFAULTS,
    installationGuide: EXAMPLE_GUIDE,
    executableNames: ['example-cli'],
    installDirectoryHints: [],
    factory: () => provider,
  };
}

/**
 * The entry the catalog builds from those defaults, with no report and no override: its look, and no
 * model until its CLI reports (C94). tests/catalog/example-provider.test.ts keeps it equal to what
 * main builds.
 */
export const EXAMPLE_ENTRY: CatalogProvider = {
  id: EXAMPLE_ID,
  instanceId: 'default',
  presentation: EXAMPLE_DEFAULTS.presentation,
  source: { kind: 'none' },
  speedTierRequest: { possible: false, reason: null },
  models: [],
};

/** The same entry once its CLI has reported two models: what its part of Settings lists then. */
export const EXAMPLE_REPORTED_ENTRY: CatalogProvider = {
  ...EXAMPLE_ENTRY,
  source: { kind: 'report', at: 1_578_924_800_000 },
  models: [
    {
      key: 'example-large', resolvedId: 'example-large-2', name: 'Example Large', description: 'The larger example model.',
      efforts: [{ id: 'quick', label: 'Quick', place: 1, caution: false }, { id: 'deep', label: 'Deep', place: 2, caution: true }],
      listedDefaultEffort: 'quick', listedDefault: true, hidden: false, speedTiers: [], origin: 'reported', overridden: false, hiddenByOverride: false, avatar: null,
    },
    {
      key: 'example-small', resolvedId: null, name: 'Example Small', description: null,
      efforts: [], listedDefaultEffort: null, listedDefault: false, hidden: false, speedTiers: [], origin: 'reported', overridden: false, hiddenByOverride: false, avatar: null,
    },
  ],
};

// ── Its sessions (M15, C81; M18, C25, C47, C59) ───────────────────────────────────────────────
// A facet that replays a fixed script and launches nothing: the proof that the session facet is
// a provider's own to implement. tests/sessions/facet-contract.test.ts holds it to the same tests
// as Codex's, in both its forms: one that reads its earlier conversation back, and one that cannot.
//
// A facet is one conversation at the provider, `EXAMPLE_REFERENCE`, whichever of its sessions runs
// a turn of it. Its turns are numbered across those sessions, so no id repeats after a resume:
// `example-turn-N`, with the items `example-user-N`, `example-note-N` and `example-answer-N`.
//
// Whose end a turn's end is (M18, C59). A turn that plays to its end, and one ended by Stop, end by
// the provider's own word: `reported` is true, and a Stop that comes before the turn's start was
// said says it first, with the reference where that was still to come. A turn ended by `close()`
// ends as the session's own: `reported` is false, and nothing more is said of it.
//
// How a turn's answer is told (M16, C74, C84). In its first form the last message arrives labelled
// `final`. In its second, `answer: 'named'`, it labels no phase: every message arrives as
// commentary, and the turn's completed end names the last one by its item id. An end that is not
// completed names none. Its history labels the answer either way, as a provider reading back does.
//
// How a message is told (M19, C3–C5, C57). In its first form each arrives whole. Made with
// `messages: 'deltas'`, each assistant message is opened by a `message-delta` with no text, grows by
// a few more, and is completed by its whole message, which carries the same text. Its descriptor is
// the same either way: streaming is no capability. A turn stopped between two deltas leaves its
// message open, as a provider does that gives no whole message for an answer it was stopped in.
//
// What it does (M20a, C53). Made with `work: true`, each turn also tells some work before its
// messages: a read of the session's own, started and ended (`example-read-N`); a worker
// (`example-worker-N`), with the item of the session's that started it (`example-launch-N`, paired
// with the worker from its start); and, under the worker's id, a search the worker ran
// (`example-search-N`) and what it reported (`example-report-N`), a message told as the session's
// own are. The launch's item ends as its worker does, just before the worker's end is said. A turn
// stopped while its worker runs ends the worker, and its item, as failed. Its history holds the
// session's own messages alone: nothing of a worker's is the conversation's.
//
// Other roots (M16, C61). Made with `otherFolders: true`, its descriptor says its sessions take a
// project's other roots; either way the facet notes what each start and resume was handed, as
// `handed`, so a test can say what main gave a provider with the capability and one without.
//
// A question beside it (M20b, C24, C26). Made with `asides: 'whole'` or `'streamed'`, its sessions
// take an aside, and its descriptor says so: the capability is declared, where the streaming of a
// session's own messages is not. An ask is answered under the aside's own turn, every event naming
// the aside — its start, one message (`example-aside-N`), whole or in deltas as the form says, and
// its end — beside whatever turn of the session's runs, which it leaves as it is. It keeps nothing
// of an aside: a follow-up brings the aside's earlier exchanges, and its answer says how many it
// was given. `stopAside` ends that aside's turn as interrupted, by the provider's own word, and no
// other; a close ends an open one as the session's own. A test makes it refuse the next ask, or
// leave it unanswered until it is stopped, through the facet's `asides`. Made without `asides`, a
// session has neither member, as a provider that answers none has.
//
// A question it asks (M21, C30). Made with `questions: 'blocking'` or `'both'`, a turn whose prompt
// is `EXAMPLE_QUESTION_PROMPT` asks one as a request before it says anything, and its descriptor
// says so: the request is held before it is told (`example-request-N`, carried by `example-question-N`), the turn waits for `answer`, and
// goes on once it has it — confirmed where it was answered, with the request-refused notice where
// main refused it. A Stop while it waits ends the turn as any, and says nothing of the request; a
// close says it dropped first, as an adapter does at its process's end (C67). With `'both'` the
// turn's note also carries a question, as a provider does that asks in its messages. Made without
// `questions`, a session has no `answer` member, as a provider that asks no blocking question has.
//
// What it may do (M22, C35). Made with `modes: 'restart'` or `'idle'`, its descriptor declares two
// modes under names of its own — `example-look`, its reading one, and `example-ask`, which asks —
// and a session says which it runs under with the first thing it starts, as `in-force`. A turn whose
// prompt is `EXAMPLE_APPROVAL_PROMPT` asks leave for one action before it says anything: the
// request is held before it is told (`example-approval-N`, carried by `example-action-N`), the turn
// waits for `decide`, and goes on once it has it — the action run, or declined at the user's word,
// and the decision confirmed; with the request-refused notice where main refused it. Under
// `example-look` it asks nothing: the notice, and the turn goes on. A grant for the session is its
// process's: once given, the same prompt runs its action unasked until the session is closed. A
// Stop while it waits ends the turn as any; a close says the request dropped first. With `'idle'` a
// change between its two modes is taken on a live process, by `setMode`; with `'restart'` a session
// has no such member, and every change is its process closed. A test makes its next start report
// another mode than the one asked for, its next change refused, or a mode unusable, through the
// facet's `permissions`. Made without `modes`, a session has neither `decide` nor `setMode`.
//
// Its plans (M22b, C2, C14). Made with `plans: true`, and modes, its descriptor declares a plan turn
// under both of its modes, and a turn sent with `plan` writes a plan before its note, as Codex
// writes one: opened with no text (`example-plan-N`), grown a piece at a time, completed whole by
// the same text. Each decision is a turn of its own, so its sessions have no `decidePlan`. Each
// turn's request is noted, as `requests`, for a test to read its `plan` and `plannedBefore`.
//
// Its history. One turn made elsewhere, `example-turn-0`, then each turn the provider took, from
// that turn's end: the user's message with the id it was sent with, and what the provider had said
// by then. A turn closed before its start was said was never the provider's, and is in no history.

export const EXAMPLE_REFERENCE = 'example-session-1';
export const EXAMPLE_ANSWER = 'The example provider read nothing and says hello.';
export const EXAMPLE_NOTE = 'Looking at nothing in particular.';
/** What its `work` form tells (M20a, C53): what its read returned, its worker's description, and what the worker reported. */
export const EXAMPLE_READ = 'The example file holds one line.';
export const EXAMPLE_WORKER = 'Look for the word example';
export const EXAMPLE_REPORT = 'The word example is in one file.';
/** What it answers an aside (M20b, C26): the first question, and a follow-up given `n` earlier exchanges. */
export const EXAMPLE_ASIDE_ANSWER = 'The example provider answers beside the conversation.';
export const exampleFollowUpAnswer = (n: number): string => `${EXAMPLE_ASIDE_ANSWER} It was given ${n} earlier ${n === 1 ? 'exchange' : 'exchanges'}.`;
/** The prompt whose turn asks (M21, C30), in a provider made to: every other prompt is answered as it was. */
export const EXAMPLE_QUESTION_PROMPT = 'Ask me which greeting.';
/** What it asks as a request (M21, C30): one question, two options with a description, and free text taken. */
export const EXAMPLE_QUESTION: BoundQuestion = { text: 'Which greeting should the example use?', header: 'Greeting', options: [{ label: 'Hello', description: 'The usual one.' }, { label: 'Good day', description: null }], multiple: false, freeText: true, secret: false };
/** What its note asks, in its `both` form. */
export const EXAMPLE_ASKED = [{ title: 'Should the example say more?', options: ['Yes', 'No'] }];
/** Its two modes (M22, C35), under names no built-in provider has: the reading one, and the one that asks. */
export const EXAMPLE_LOOK = 'example-look';
export const EXAMPLE_ASK = 'example-ask';
/** What it declares of them, by how a change between them is taken. */
export function examplePermissions(change: 'restart' | 'idle'): PermissionCapability {
  return {
    modes: [
      { id: EXAMPLE_LOOK, label: 'Look only', description: 'The example makes nothing.', asks: false, reading: true, transitionsFrom: change === 'idle' ? [EXAMPLE_ASK] : [] },
      { id: EXAMPLE_ASK, label: 'Ask each time', description: 'The example asks before it makes its note.', asks: true, reading: false, transitionsFrom: change === 'idle' ? [EXAMPLE_LOOK] : [] },
    ],
    fallback: EXAMPLE_ASK, setup: null, inherited: 'The example CLI has no configuration of its own.', rules: 'The example CLI keeps no rule.',
  };
}
/** The prompt whose turn asks leave (M22, C35), in a provider made with modes: every other prompt is answered as it was. */
export const EXAMPLE_APPROVAL_PROMPT = 'Make the example note.';
/** What it asks leave for: one command, which its own grant for the session can cover. */
export const EXAMPLE_APPROVAL: RaisedApprovalRequest = {
  kind: 'command', tool: 'Example', summary: 'make example-note.txt', folder: null, targets: ['example-note.txt'], outside: false, reason: 'To make the note it was asked for.', authority: [],
  detail: { kind: 'command', command: 'example make example-note.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'make example-note.txt' }, modeThatWouldStop: null, cut: false,
};
/** What its CLI says of a change of mode it refuses. */
export const EXAMPLE_CHANGE_REFUSED = 'The example CLI kept its mode.';
/** What a plan turn of the example writes (M22b). */
export const EXAMPLE_PLAN = '# The example plan\n\n1. Say hello.\n2. Say it once more.';
/** What its descriptor declares of its plans: a plan turn under both of its modes. */
export const EXAMPLE_PLANS: PlanCapability = { modes: ['example-look', 'example-ask'], unavailable: 'The example CLI plans under both of its modes.' };

/** A plan as it is written (M22b, C14): opened with no text, then its text in pieces, then whole. */
function examplePlan(turnId: string, n: number): AgentEvent[] {
  const itemId = `example-plan-${n}`;
  const pieces = Array.from({ length: Math.ceil(EXAMPLE_PLAN.length / 10) }, (_, index): AgentEvent => ({ type: 'plan-delta', turnId, itemId, text: EXAMPLE_PLAN.slice(index * 10, (index + 1) * 10) }));
  return [{ type: 'plan-delta', turnId, itemId, text: '' }, ...pieces, { type: 'plan-completed', turnId, itemId, text: EXAMPLE_PLAN }];
}
/** The turn its history starts with: made elsewhere, by no session of fat-g's. */
export const EXAMPLE_EARLIER_TURN: HistoryTurn = { turnId: 'example-turn-0', outcome: 'completed', startedAt: 1_578_924_800_000, endedAt: 1_578_924_804_000, durationMs: 4_000 };
/** That turn's messages. Its prompt was not sent by fat-g: it has no client id. */
export const EXAMPLE_HISTORY: readonly HistoryMessage[] = [
  { role: 'user', itemId: 'example-item-1', phase: null, text: 'An earlier question.', turnId: 'example-turn-0', at: 1_578_924_800_000 },
  { role: 'assistant', itemId: 'example-item-2', phase: 'final', text: 'An earlier answer.', turnId: 'example-turn-0', at: 1_578_924_800_000 },
];

interface ExampleKeptTurn { readonly turn: HistoryTurn; readonly messages: readonly HistoryMessage[] }

/** What one facet's sessions share: the provider's one conversation. */
interface ExampleConversation {
  /** Turns sent so far, by any of the sessions. */
  turns: number;
  /** The turns the provider took, each from its end, oldest first. */
  readonly kept: ExampleKeptTurn[];
}

interface ExampleRunning {
  readonly request: TurnRequest;
  /** The turn's number in its conversation: what each of its ids ends with. */
  readonly n: number;
  readonly script: readonly AgentEvent[];
  /** How many of the script's steps say that the provider took the turn: its start, and the reference when it is still to come. */
  readonly opening: number;
  /** The steps sent so far. */
  next: number;
  readonly startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The request the turn waits on (M21): held before it is told, since main may refuse it at once. */
  held: string | null;
  /** The approval the turn waits on (M22), held the same way. */
  approval: string | null;
  /** Its start reported another mode than the one asked for (M22, C46): the provider never took the prompt. */
  readonly mismatched: boolean;
  /** Goes on with the script, once what the turn waited on is settled. */
  resume: () => void;
}

/** One session: each send plays the script, a step per timer tick, so a Stop can come between two. */
/** A message as it is written: opened with no text, then its text in pieces of `size` units, before the whole message. */
function streamed(message: Extract<AgentEvent, { type: 'message' }>, size = 12): AgentEvent[] {
  const delta = (text: string): AgentEvent => ({ type: 'message-delta', turnId: message.turnId, itemId: message.itemId, phase: message.phase, text, ...(message.workerId === undefined ? {} : { workerId: message.workerId }), ...(message.asideId === undefined ? {} : { asideId: message.asideId }) });
  const pieces = Array.from({ length: Math.ceil(message.text.length / size) }, (_, index) => delta(message.text.slice(index * size, (index + 1) * size)));
  return [delta(''), ...pieces, message];
}

/** What a turn of the `work` form does before it says anything (M20a, C53). */
function exampleWork(turnId: string, n: number, told: (message: Extract<AgentEvent, { type: 'message' }>) => AgentEvent[]): AgentEvent[] {
  const workerId = `example-worker-${n}`;
  return [
    { type: 'activity-started', turnId, itemId: `example-read-${n}`, activityType: 'read', name: 'Read', summary: 'example.txt', input: '{\n  "file": "example.txt"\n}', files: [{ path: 'example.txt', line: null }] },
    { type: 'activity-ended', turnId, itemId: `example-read-${n}`, status: 'completed', output: EXAMPLE_READ },
    { type: 'worker-started', workerId, description: EXAMPLE_WORKER },
    { type: 'activity-started', turnId, itemId: `example-launch-${n}`, activityType: 'worker', name: 'Worker', summary: EXAMPLE_WORKER, pairedWorkerId: workerId },
    { type: 'activity-started', turnId, itemId: `example-search-${n}`, workerId, activityType: 'search', name: 'Search', summary: 'example', input: 'example' },
    { type: 'activity-ended', turnId, itemId: `example-search-${n}`, workerId, status: 'completed', output: 'example.txt' },
    ...told({ type: 'message', turnId, role: 'assistant', itemId: `example-report-${n}`, phase: null, text: EXAMPLE_REPORT, workerId }),
    { type: 'activity-ended', turnId, itemId: `example-launch-${n}`, status: 'completed', output: EXAMPLE_REPORT },
    { type: 'worker-ended', workerId, outcome: 'completed' },
  ];
}

/** The action a turn asked leave for (M22, C35), as it then ran or was declined at the user's word. */
function exampleAction(turnId: string, n: number, status: 'completed' | 'declined'): AgentEvent[] {
  const itemId = `example-action-${n}`;
  return [
    { type: 'activity-started', turnId, itemId, activityType: 'command', name: EXAMPLE_APPROVAL.tool, summary: EXAMPLE_APPROVAL.summary },
    status === 'declined' ? { type: 'activity-ended', turnId, itemId, status, declinedBy: 'user' } : { type: 'activity-ended', turnId, itemId, status, exitCode: 0 },
  ];
}

/** What a test asks of the next aside (M20b): refused, or left unanswered until it is stopped. One use each. */
interface ExampleAsideControl { refuse: boolean; hold: boolean; asked: number }

/** What a test asks of its modes (M22): the next start reporting another mode, the next change refused — one use each — and the modes no account can use. */
interface ExampleModeControl { readonly change: 'restart' | 'idle'; mismatch: boolean; refuseChange: boolean; readonly withheld: Set<string>; readonly listeners: Set<() => void> }

/** An aside whose turn runs: the steps still to say, and the timer that says the next. */
interface ExampleAside { readonly request: AsideRequest; readonly script: readonly AgentEvent[]; next: number; timer: ReturnType<typeof setTimeout> | null }

function exampleSession(options: SessionStart, started: boolean, conversation: ExampleConversation, named: boolean, deltas: boolean, work: boolean, asides: { readonly mode: 'whole' | 'streamed'; readonly control: ExampleAsideControl } | null, questions: 'blocking' | 'both' | null, modes: ExampleModeControl | null, plans: { readonly requests: TurnRequest[] } | null = null): ProviderSession {
  const listeners = new Set<(event: AgentEvent) => void>();
  const emit = (event: AgentEvent): void => { for (const listener of [...listeners]) listener(event); };
  // What its process runs under (M22): the mode it was started with, said with the first thing it
  // starts; a start a test made report another says so instead, and no prompt of it is taken.
  let mode = modes === null ? null : options.mode;
  let modeSaid = false;
  const mismatched = modes !== null && modes.mismatch;
  if (modes !== null) modes.mismatch = false;
  /** The grant this process holds: the action then runs unasked, until the session is closed. */
  let granted = false;
  const asking = new Map<string, ExampleAside>();
  /** An aside's one end: every outcome is an event that names it (C26). */
  const endAside = (asideId: string, outcome: 'completed' | 'interrupted' | 'failed', reported: boolean): void => {
    const open = asking.get(asideId);
    if (open === undefined) return;
    if (open.timer !== null) clearTimeout(open.timer);
    asking.delete(asideId);
    emit({ type: 'turn-ended', turnId: open.request.turnId, asideId, outcome, reported, ...(outcome === 'failed' ? { failure: 'turn-failed' as const } : {}) });
  };
  const ask = (request: AsideRequest): void => {
    if (ended || asides === null || asking.has(request.asideId)) return;
    const { asideId, turnId } = request;
    const { control } = asides;
    const n = ++control.asked;
    const refused = control.refuse;
    const held = !refused && control.hold;
    control.refuse = false;
    control.hold = false;
    const answer: Extract<AgentEvent, { type: 'message' }> = { type: 'message', turnId, role: 'assistant', itemId: `example-aside-${n}`, phase: 'final', text: request.history.length === 0 ? EXAMPLE_ASIDE_ANSWER : exampleFollowUpAnswer(request.history.length), asideId };
    const script: AgentEvent[] = refused
      ? [{ type: 'notice', turnId, kind: 'turn-failed', asideId }]
      : [{ type: 'turn-started', turnId, providerTurnId: `example-aside-turn-${n}`, asideId }, ...(held ? [] : asides.mode === 'streamed' ? streamed(answer) : [answer])];
    const open: ExampleAside = { request, script, next: 0, timer: null };
    asking.set(asideId, open);
    const step = (): void => {
      if (asking.get(asideId) !== open) return;
      if (open.next >= script.length) {
        // Held, it says its start and no more, until it is stopped.
        if (!held) endAside(asideId, refused ? 'failed' : 'completed', true);
        return;
      }
      emit(script[open.next] as AgentEvent);
      open.next += 1;
      if (asking.get(asideId) === open) open.timer = setTimeout(step, 0);
    };
    open.timer = setTimeout(step, 0);
  };
  let referenced = started;
  let running: ExampleRunning | null = null;
  let resolveClosed: (result: { ok: boolean }) => void = () => undefined;
  const closed = new Promise<{ ok: boolean }>((resolve) => { resolveClosed = resolve; });
  let ended = false;
  /** Sends the script's next step. */
  const advance = (turn: ExampleRunning): void => {
    const event = turn.script[turn.next] as AgentEvent;
    turn.next += 1;
    if (event.type === 'session-started') referenced = true;
    // Held before it is told (M21, C11): main may refuse it from inside this emission.
    if (event.type === 'question-raised') turn.held = event.requestId;
    if (event.type === 'approval-raised') turn.approval = event.requestId;
    if (event.type === 'in-force' && event.mode !== undefined) modeSaid = true;
    emit(event);
  };
  /** The provider keeps a turn it took: the user's message, and what it had said of the turn by its end. */
  const keep = (turn: ExampleRunning, outcome: 'completed' | 'interrupted'): void => {
    const endedAt = Date.now();
    const turnId = `example-turn-${turn.n}`;
    const answerId = `example-answer-${turn.n}`;
    // Read back, the answer of a completed turn is labelled, however it was told as it arrived.
    const phaseOf = (itemId: string, phase: HistoryMessage['phase']): HistoryMessage['phase'] => (named && itemId === answerId && outcome === 'completed' ? 'final' : phase);
    const said = turn.script.slice(0, turn.next).flatMap((event): HistoryMessage[] => (event.type === 'message' && event.role === 'assistant' && event.workerId === undefined ? [{ role: 'assistant', itemId: event.itemId, phase: phaseOf(event.itemId, event.phase), text: event.text, turnId, at: turn.startedAt }] : []));
    const user: HistoryMessage = { role: 'user', itemId: `example-user-${turn.n}`, phase: null, text: turn.request.prompt, turnId, clientId: turn.request.messageId, at: turn.startedAt };
    conversation.kept.push({ turn: { turnId, outcome, startedAt: turn.startedAt, endedAt, durationMs: endedAt - turn.startedAt }, messages: [user, ...said] });
  };
  /** The turn's one end: the provider's own word (`reported`), or the session's as it is closed (M18, C59). */
  const end = (turn: ExampleRunning, outcome: 'completed' | 'interrupted', reported: boolean): void => {
    if (turn.timer !== null) clearTimeout(turn.timer);
    running = null;
    // A start that reported another mode is the session's own end, and a failed one (M22, C46).
    if (turn.mismatched) { emit({ type: 'turn-ended', turnId: turn.request.turnId, outcome: 'failed', reported: false, failure: 'policy-mismatch' }); return; }
    // A request still held when the session's own end is made is said dropped first (M21, C67); one
    // held at a Stop is left to the turn's end.
    if (turn.held !== null && !reported) emit({ type: 'question-resolved', requestId: turn.held, reason: 'dropped' });
    turn.held = null;
    if (turn.approval !== null && !reported) emit({ type: 'approval-resolved', requestId: turn.approval, reason: 'dropped' });
    turn.approval = null;
    // A worker still running ends with its turn, as failed, and so does the item that started it (M20a, C23).
    const told = turn.script.slice(0, turn.next);
    for (const begun of told) {
      if (begun.type !== 'worker-started' || told.some((event) => event.type === 'worker-ended' && event.workerId === begun.workerId)) continue;
      const launch = told.find((event) => event.type === 'activity-started' && event.pairedWorkerId === begun.workerId);
      if (launch?.type === 'activity-started') emit({ type: 'activity-ended', turnId: launch.turnId, itemId: launch.itemId, status: 'failed' });
      emit({ type: 'worker-ended', workerId: begun.workerId, outcome: 'failed' });
    }
    // In its history before its end is said, so whoever hears the end can read it.
    if (turn.next > 0) keep(turn, outcome);
    // The second form names its answer on a completed end of its own, and on no other (C74).
    const answered = named && reported && outcome === 'completed' && turn.next >= turn.script.length;
    emit({ type: 'turn-ended', turnId: turn.request.turnId, outcome, reported, ...(answered ? { answerItemId: `example-answer-${turn.n}` } : {}) });
  };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(request: TurnRequest) {
      if (ended || running !== null) return;
      plans?.requests.push(request);
      const n = ++conversation.turns;
      const { turnId } = request;
      const told = (message: Extract<AgentEvent, { type: 'message' }>): AgentEvent[] => (deltas ? streamed(message) : [message]);
      // A turn that asks (M21): the one whose prompt says so, in a provider made to.
      const asks = request.prompt === EXAMPLE_QUESTION_PROMPT ? questions : null;
      const raised: AgentEvent[] = asks === null ? [] : [{ type: 'question-raised', turnId, requestId: `example-request-${n}`, sourceId: `example-question-${n}`, questions: [EXAMPLE_QUESTION], cut: false }];
      // A turn that asks leave (M22): the one whose prompt says so, in a provider made with modes —
      // refused under its reading mode, unasked under its process's grant, and asked otherwise.
      const acts = modes !== null && request.prompt === EXAMPLE_APPROVAL_PROMPT;
      const leave: AgentEvent[] = !acts ? []
        : mode !== EXAMPLE_ASK ? [{ type: 'notice', turnId, kind: 'request-refused' }]
          : granted ? exampleAction(turnId, n, 'completed')
            : [{ type: 'approval-raised', turnId, requestId: `example-approval-${n}`, sourceId: `example-action-${n}`, request: EXAMPLE_APPROVAL }];
      const script: AgentEvent[] = mismatched && !modeSaid ? [{ type: 'notice', turnId, kind: 'policy-mismatch' }] : [
        { type: 'turn-started', turnId, providerTurnId: `example-turn-${n}` },
        ...(mode === null || modeSaid ? [] : [{ type: 'in-force', turnId, mode } as const]),
        ...(referenced ? [] : [{ type: 'session-started', reference: EXAMPLE_REFERENCE, folder: options.folder } as const]),
        { type: 'message', turnId, role: 'user', itemId: `example-user-${n}`, phase: null, text: request.prompt, clientId: request.messageId },
        { type: 'action-changed', turnId, kind: 'thinking' },
        ...raised,
        ...leave,
        // A plan turn's plan (M22b, C14), where it plans.
        ...(plans !== null && request.plan === true ? examplePlan(turnId, n) : []),
        ...(work ? exampleWork(turnId, n, told) : []),
        ...told({ type: 'message', turnId, role: 'assistant', itemId: `example-note-${n}`, phase: 'commentary', text: EXAMPLE_NOTE, ...(asks === 'both' ? { questions: EXAMPLE_ASKED } : {}) }),
        ...told({ type: 'message', turnId, role: 'assistant', itemId: `example-answer-${n}`, phase: named ? 'commentary' : 'final', text: EXAMPLE_ANSWER }),
      ];
      const step = (): void => {
        turn.timer = null;
        if (running !== turn) return;
        if (turn.next >= script.length) { end(turn, 'completed', true); return; }
        advance(turn);
        // A turn that waits for an answer says no more until it has one (M21).
        turn.resume();
      };
      const refused = mismatched && !modeSaid;
      // What says the provider took the turn: its start, the mode where it is still to be said, and the reference where it is still to come.
      const opening = refused ? 0 : 1 + (mode === null || modeSaid ? 0 : 1) + (referenced ? 0 : 1);
      const turn: ExampleRunning = { request, n, script, opening, next: 0, startedAt: Date.now(), timer: null, held: null, approval: null, mismatched: refused, resume: () => { if (running === turn && turn.held === null && turn.approval === null && turn.timer === null) turn.timer = setTimeout(step, 0); } };
      running = turn;
      turn.resume();
    },
    stop() {
      const turn = running;
      if (turn === null) return;
      // The provider had the prompt: the turn's start, and the reference where it was still to come, are said before its end.
      while (running === turn && turn.next < turn.opening) advance(turn);
      if (running === turn) end(turn, 'interrupted', true);
    },
    // A provider that declares no mode but a reading one has no such member (M22, C35).
    ...(modes === null ? {} : {
      decide(requestId: string, choice: ApprovalChoice | null): Promise<boolean> {
        const turn = running;
        if (ended || turn === null || turn.approval !== requestId) return Promise.resolve(false);
        turn.approval = null;
        const { turnId } = turn.request;
        if (choice === null) emit({ type: 'notice', turnId, kind: 'request-refused' });
        else {
          emit({ type: 'approval-resolved', requestId, reason: 'confirmed' });
          if (choice === 'approve-session') granted = true;
          for (const event of exampleAction(turnId, turn.n, choice === 'deny' ? 'declined' : 'completed')) emit(event);
        }
        turn.resume();
        return Promise.resolve(true);
      },
    }),
    // And one whose every change is its process closed has no such member either (C2).
    ...(modes === null || modes.change !== 'idle' ? {} : {
      setMode(to: string): Promise<ModeChange> {
        if (ended || running !== null) return Promise.resolve({ confirmed: false, detail: null });
        if (modes.refuseChange) { modes.refuseChange = false; return Promise.resolve({ confirmed: false, detail: EXAMPLE_CHANGE_REFUSED }); }
        if (to !== EXAMPLE_LOOK && to !== EXAMPLE_ASK) return Promise.resolve({ confirmed: false, detail: null });
        mode = to;
        modeSaid = true;
        emit({ type: 'in-force', mode: to });
        return Promise.resolve({ confirmed: true });
      },
    }),
    // A provider that answers no aside has neither member (C24).
    ...(asides === null ? {} : { ask, stopAside: (asideId: string): void => endAside(asideId, 'interrupted', true) }),
    // A provider that asks no blocking question has no such member (M21, C30).
    ...(questions === null ? {} : {
      answer(requestId: string, answers: readonly GivenAnswer[] | null): void {
        const turn = running;
        if (ended || turn === null || turn.held !== requestId) return;
        turn.held = null;
        emit(answers === null ? { type: 'notice', turnId: turn.request.turnId, kind: 'request-refused' } : { type: 'question-resolved', requestId, reason: 'confirmed' });
        turn.resume();
      },
    }),
    closed,
    close() {
      if (!ended) {
        ended = true;
        // An open aside ends with the session, as the session's own: before the session's turn does (C34).
        for (const asideId of [...asking.keys()]) endAside(asideId, 'interrupted', false);
        if (running !== null) end(running, 'interrupted', false);
        resolveClosed({ ok: true });
      }
      return closed;
    },
    recheck: () => Promise.resolve({ ok: true }),
  };
}

/**
 * Its history, newest page first (M18, C47, C51). The cursor is the id of the oldest turn the page
 * before gave, so a turn that ends between two reads moves no page. An unknown reference, cursor or
 * size, and a read already cancelled, answer `failed`.
 */
function exampleHistory(conversation: ExampleConversation): HistoryFacet {
  const failed: HistoryAnswer = { kind: 'failed' };
  return {
    read(reference, page, signal) {
      if (reference !== EXAMPLE_REFERENCE || signal.aborted || !Number.isInteger(page.size) || page.size < 1) return Promise.resolve(failed);
      const all: readonly ExampleKeptTurn[] = [{ turn: EXAMPLE_EARLIER_TURN, messages: EXAMPLE_HISTORY }, ...conversation.kept];
      const end = page.cursor === null ? all.length : all.findIndex((kept) => kept.turn.turnId === page.cursor);
      // No turn is before the first: a page that reached it gave no cursor.
      if (end < 1) return Promise.resolve(failed);
      const start = Math.max(0, end - page.size);
      const turns = all.slice(start, end);
      const messages = page.detail === 'none' ? [] : turns.flatMap((kept) => (page.detail === 'summary' ? kept.messages.filter((message) => message.role === 'user' || message.phase === 'final') : kept.messages));
      return Promise.resolve({ kind: 'page', turns: turns.map((kept) => kept.turn), messages, next: start === 0 ? null : (turns[0] as ExampleKeptTurn).turn.turnId });
    },
    onAvailable: () => () => undefined,
  };
}

export interface ExampleSessionOptions {
  /** False for a provider that cannot read a conversation back: its facet then has no `history` member (M18, C6, C25). */
  readonly history?: boolean;
  /** How a turn's answer is told (M16, C74, C84): labelled as it arrives, the default, or named on the turn's completed end. */
  readonly answer?: 'labelled' | 'named';
  /** True for a provider whose sessions take a project's other roots: its descriptor then says so (M16, C61). */
  readonly otherFolders?: boolean;
  /** How an assistant's message is told (M19, C57): whole, the default, or in deltas completed by its whole message. No descriptor says which. */
  readonly messages?: 'whole' | 'deltas';
  /** True for turns that tell what they do before what they say (M20a, C53): an activity started and ended, and a worker with its item. No descriptor says so. */
  readonly work?: boolean;
  /** How it answers a question beside a session (M20b, C24, C26): whole, or as it is written. Left out, it answers none, and its descriptor says `none`. */
  readonly asides?: 'whole' | 'streamed';
  /** How it asks the user (M21, C30): as a request each turn waits on, or so and in a message too. Left out, it asks nothing, and its descriptor says `none`. */
  readonly questions?: 'blocking' | 'both';
  /** How a change between its two modes is taken (M22, C35): by its process closed, or on a live one. Left out, it declares no mode, and its descriptor says `null`. */
  readonly modes?: 'restart' | 'idle';
  /** True for a provider that plans (M22b, C2), with modes: its descriptor then declares its plan turns. */
  readonly plans?: boolean;
}

export interface ExampleFacet extends SessionFacet {
  /** The other folders each start and resume was handed, in order (M16, C61). */
  readonly handed: (readonly string[])[];
  /** The mode each start and resume was handed, in order (M22, C39). */
  readonly started: (string | null)[];
  /** What a test asks of the next aside any of its sessions is asked (M20b): one use each. */
  readonly asides: { refuseNext(): void; holdNext(): void };
  /** What a test asks of its modes (M22): the next start reporting another mode than the one asked for, the next change refused, and a mode its account cannot use — or can again, with `null`. */
  readonly permissions: { mismatchNext(): void; refuseNextChange(): void; withhold(mode: string | null): void };
  /** Every turn its sessions were sent, in order (M22b): what a test reads `plan` and `plannedBefore` from. */
  readonly requests: TurnRequest[];
}

/** What the example provider declares of its asides, by the form it was made in. */
export const exampleAsides = (mode: ExampleSessionOptions['asides']): AsideCapability => (mode === undefined ? 'none' : { followUp: true, streamed: mode === 'streamed', tools: 'none' });

/** One conversation's facet. With `history: false` it has no `history` member at all. */
export function exampleSessionFacet(options: ExampleSessionOptions = {}): ExampleFacet {
  const conversation: ExampleConversation = { turns: 0, kept: [] };
  const named = options.answer === 'named';
  const deltas = options.messages === 'deltas';
  const work = options.work === true;
  const handed: (readonly string[])[] = [];
  const control: ExampleAsideControl = { refuse: false, hold: false, asked: 0 };
  const asides = options.asides === undefined ? null : { mode: options.asides, control };
  const questions = options.questions ?? null;
  const modes: ExampleModeControl | null = options.modes === undefined ? null : { change: options.modes, mismatch: false, refuseChange: false, withheld: new Set(), listeners: new Set() };
  const started: (string | null)[] = [];
  const capability = options.modes === undefined ? null : examplePermissions(options.modes);
  const requests: TurnRequest[] = [];
  const plans = options.plans === true ? { requests } : null;
  const sessions: ExampleFacet = {
    handed,
    started,
    requests,
    asides: { refuseNext: () => { control.refuse = true; }, holdNext: () => { control.hold = true; } },
    permissions: {
      mismatchNext: () => { if (modes !== null) modes.mismatch = true; },
      refuseNextChange: () => { if (modes !== null) modes.refuseChange = true; },
      withhold(mode) {
        if (modes === null) return;
        if (mode === null) modes.withheld.clear(); else modes.withheld.add(mode);
        for (const listener of [...modes.listeners]) listener();
      },
    },
    start(start) { handed.push([...start.otherFolders]); started.push(start.mode); return exampleSession(start, false, conversation, named, deltas, work, asides, questions, modes, plans); },
    resume(resume) { handed.push([...resume.otherFolders]); started.push(resume.mode); return exampleSession(resume, true, conversation, named, deltas, work, asides, questions, modes, plans); },
    // Its account plans (M22b, C2), where it plans at all.
    ...(plans === null ? {} : { plans: () => PLANS_AVAILABLE }),
    // The three go together, and with the descriptor's declaration (M22, C39): a provider that declares no mode has none of them.
    ...(modes === null || capability === null ? {} : {
      modes: (): readonly ModeAvailability[] => capability.modes.map(({ id }) => ({ id, available: !modes.withheld.has(id), reason: modes.withheld.has(id) ? 'unvalidated' as const : null, setup: false, records: false, unconfined: false, places: null })),
      transition: (from: string, to: string) => (capability.modes.find((declared) => declared.id === to)?.transitionsFrom.includes(from) === true ? 'idle' as const : 'restart' as const),
      onModesChanged: (listener: () => void) => { modes.listeners.add(listener); return () => modes.listeners.delete(listener); },
    }),
  };
  return options.history === false ? sessions : { ...sessions, history: exampleHistory(conversation) };
}

/**
 * The example provider with sessions: its descriptor says so, and its adapter has the facet (C6);
 * and with history or without, the descriptor's `history` and the facet's member together (M18,
 * C6). Every adapter the definition makes has the same facet, as a CLI's own conversations outlive
 * the adapter that started them: a test that makes its adapter again finds them there.
 */
export function exampleDefinitionWithSessions(options: ExampleSessionOptions = {}): ProviderDefinition {
  const base = exampleDefinition();
  const history = options.history !== false;
  const descriptor: ProviderDescriptor = { ...EXAMPLE_DESCRIPTOR, capabilities: { ...EXAMPLE_DESCRIPTOR.capabilities, sessions: true, history, otherFolders: options.otherFolders === true, asides: exampleAsides(options.asides), questions: options.questions ?? 'none', permissions: options.modes === undefined ? null : examplePermissions(options.modes), plans: options.plans === true ? EXAMPLE_PLANS : null } };
  const facet = exampleSessionFacet({ ...options, history });
  return { ...base, descriptor, factory: (context) => ({ ...base.factory(context), descriptor, sessions: facet }) };
}
