// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sessions: fat-g's own records of the conversations it started, and what main knows of each while
// it runs (docs/planning/_archive/M14.md, decision 0011). Main keeps the record in records.json and the live
// summary in memory only; the Main window sees both inside the app state, and acts only through the
// channels whose request schemas are here. The Pet sees none of it.
//
// Renderer-safe: types, schemas and pure helpers only, so main and the page order a list, word a
// status and format a time the same way.
import { z } from 'zod';
import type { ResolvedAvatar } from './avatars';
import { catalogId } from './catalog';
import type { InstanceId } from './instances';
import { MAX_QUESTIONS } from './interaction';
import { normalizeName } from './names';
import { type ChatMode, ModeIdSchema } from './permissions';
import { ModelPresetSchema } from './presets';
import { SESSION_FLAGS } from './session-flags';
import { SessionOrderGroupSchema } from './session-order';

// ── The record, as the page sees it (C2, C65) ─────────────────────────────────────────────────

/** The speed a CLI says a turn of a session that asked for a faster tier ran at (decision 0016). */
export const SERVED_SPEEDS = ['fast', 'standard'] as const;
export type ServedSpeed = (typeof SERVED_SPEEDS)[number];
/** Why a turn ran at standard speed, as its CLI names it: an id such as `out_of_credits`, `cooldown`, `not-offered`. */
export const ServedReasonSchema = z.string().min(1).max(64).regex(/^[\w.-]+$/);

/** Where a session's name came from, highest rank first (C8, C9). */
export const NAME_SOURCES = ['user', 'generated', 'provider', 'first-message'] as const;
export type NameSource = (typeof NAME_SOURCES)[number];

export function isNameSource(value: unknown): value is NameSource {
  return typeof value === 'string' && (NAME_SOURCES as readonly string[]).includes(value);
}

/** A name replaces the stored one when its source ranks the same or higher; any name replaces none (C9). */
export function nameReplaces(current: NameSource | null, next: NameSource): boolean {
  return current === null || NAME_SOURCES.indexOf(next) <= NAME_SOURCES.indexOf(current);
}

/** How a turn ended. `stopped` is main's alone: fat-g quit, or crashed, while it ran (C16, C75). */
export const TURN_OUTCOMES = ['completed', 'interrupted', 'failed', 'stopped'] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];
/** What a source may report: every outcome but `stopped`. */
export const REPORTED_OUTCOMES = ['completed', 'interrupted', 'failed'] as const;
export type ReportedOutcome = (typeof REPORTED_OUTCOMES)[number];

export interface LastTurn {
  /**
   * The runtime's id for the turn (M18, C29): what the record and the conversation store are
   * reconciled by. The session's alone, like the rest of this: never the provider's id.
   */
  readonly turnId: string;
  readonly startedAt: number;
  /** Null while the turn runs — or for good, when fat-g was closed without a quit (C74). */
  readonly endedAt: number | null;
  readonly outcome: TurnOutcome | null;
}

/**
 * What the page shows of a session's record. The provider's session reference, the folder it
 * started in and its account's configuration folder stay in main (C65; M14b, C61).
 */
export interface SessionView {
  readonly id: string;
  readonly projectId: string;
  readonly providerId: string;
  /** Which of the provider's instances it runs on (M14b, C26): an id, never a label or a folder. */
  readonly instanceId: InstanceId;
  /** The catalog's key (C7); one the catalog no longer has resolves to its generic entry. */
  readonly model: string;
  /** Null for a model with no levels. */
  readonly effort: string | null;
  /**
   * The speed tier its turns ask for, by the id its model lists (decision 0016); null
   * for standard speed. Changed as the effort is, and in force from the next turn.
   */
  readonly speed: string | null;
  /** Null until it has one: it is then shown by its creation time, which is never stored (C8). */
  readonly name: string | null;
  readonly nameSource: NameSource | null;
  readonly starred: boolean;
  readonly toDo: boolean;
  readonly toVerify: boolean;
  /** When it was shelved, or null. Never set together with `completedAt`. */
  readonly shelvedAt: number | null;
  /** When it was completed, or null (C38). */
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
}

/** Neither shelved nor completed: in the list of active capsules, dragged within its group. */
export function isActive(record: Pick<SessionView, 'completedAt' | 'shelvedAt'>): boolean {
  return record.completedAt === null && record.shelvedAt === null;
}

/** The session's name, or — with none yet — when it was created (C8). */
export function sessionDisplayName(session: Pick<SessionView, 'name' | 'createdAt'>, locale?: string, timeZone?: string): string {
  if (session.name !== null) return session.name;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone === undefined ? {} : { timeZone }) }).format(session.createdAt);
}

/** A session no turn of which has run (M100, C71; M26 round 2): its capsule, its Cancel and its draft's title all follow this. */
export function notStarted(entry: { readonly summary: Pick<SessionSummary, 'status'> }): boolean {
  return entry.summary.status === 'not-started';
}

/** What a session with no turn yet is shown as, and what goes before a name written for one from its draft (M26 round 2). */
export const NEW_SESSION_TEXT = 'New session';

/**
 * What a session is shown by: its name, or its creation time while it has none (C8) — and, for a
 * name fat-g wrote from a draft before anything ran, "New session: " before it (M26 round 2). The
 * prefix goes by itself at the first turn, which is also when a better title replaces the name.
 * A name the user typed is shown as they typed it, started or not; so is a chat's that takes part in
 * a plan, which is drawn as a started one (decision 0029).
 */
export function sessionLabel(entry: { readonly record: Pick<SessionView, 'name' | 'nameSource' | 'createdAt'>; readonly summary: Pick<SessionSummary, 'status' | 'attention' | 'planWait'> }, locale?: string, timeZone?: string): string {
  const name = sessionDisplayName(entry.record, locale, timeZone);
  return notStarted(entry) && !inPlan(entry.summary) && entry.record.nameSource === 'generated' ? `${NEW_SESSION_TEXT}: ${name}` : name;
}

// ── The live summary (C15–C21, C23, C109, C113, C114) ─────────────────────────────────────────

export const SESSION_STATUSES = ['not-started', 'idle', 'running'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * `plan` (M22b, C27): a plan's decision waits for the user — PLAN READY, with no count. `review`
 * (M22e): a review's findings wait in the reviewer's triage panel for the user to decide what to
 * integrate — PLAN REVIEW, with no count.
 */
export const ATTENTION_KINDS = ['ready', 'question', 'approval', 'plan', 'review', 'error', 'stopped'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** What a session can be waiting on the user for (C19). `plan` (M22b, C27): a plan a request holds, Claude's. */
export const REQUEST_KINDS = ['question', 'approval', 'plan'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** `approving` (M22, C78): an approval of the session's own turn waits for the user's decision. `plan-ready` (M22b, C27): a plan of its turn does. */
export const ACTION_KINDS = ['thinking', 'writing', 'reading', 'running', 'tool', 'waiting', 'asking', 'approving', 'plan-ready', 'compacting'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** M105: status metadata only. No provider text or worker identifiers cross this boundary. */
export const ActionWaitSchema = z.discriminatedUnion('reason', [
  z.strictObject({ reason: z.literal('subagents'), count: z.number().int().min(1).max(256).optional() }),
  z.strictObject({ reason: z.literal('provider') }),
]);
export type ActionWait = z.infer<typeof ActionWaitSchema>;
export const ACTION_GRACE_MS = 2000;
export const ActionHoldSchema = z.strictObject({ kind: z.enum(ACTION_KINDS), wait: ActionWaitSchema.optional(), until: z.number().int().min(0) });
export type ActionHold = z.infer<typeof ActionHoldSchema>;

export const AGENT_STATES = ['running', 'completed', 'failed'] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export interface SessionAction {
  readonly kind: ActionKind;
  readonly wait?: ActionWait;
  /** Distinguishes a writing tool from response text for the display grace. Never persisted. */
  readonly tool?: true;
  /** One line, clamped like a name, with no absolute path (C21). */
  readonly label: string;
  /**
   * What the label says beyond the kind's own words (M100, C52): the provider's line, else the file's
   * name, cleaned as the label is; null with neither. Its status is the kind's words (`actionStatus`).
   * Absent where a summary was written before it, which reads as null.
   */
  readonly detail?: string | null;
}

export interface Attention {
  readonly kind: AttentionKind;
  /** Unanswered requests of that kind; 1 for the kinds that count nothing. */
  readonly count: number;
  /** Visiting acknowledges ready/error/stopped notifications; pending decisions remain false. */
  readonly acknowledged: boolean;
  /** A user-initiated transition stays lit without flashing. Live presentation only. */
  readonly flash?: false;
}

export interface AgentView {
  readonly id: string;
  /** Its place in the order the session started the workers it lists, from 1, never reused (C113; M106, C28). */
  readonly number: number;
  readonly label: string;
  readonly state: AgentState;
  readonly action: SessionAction | null;
  readonly displayHold?: ActionHold;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /**
   * The model it runs on, as its CLI names it — a key, or an alias until the worker names the id
   * (M106, C14, C38); null while the CLI names none, which the page draws as the session's, assumed (C16).
   */
  readonly model: string | null;
  /** The agent definition it runs as, where the CLI names one (M106, C20): a clean label, or null. */
  readonly agentType: string | null;
  /**
   * Its own requests no one has answered (M106, C8): the kind of the oldest and that kind's count, as
   * the session's attention counts them, never acknowledged; null with none, and for a finished one.
   */
  readonly attention: Attention | null;
}

export interface SessionSummary {
  /** `running` from a turn's start to its end — or, past its end, to its last worker's (C16, C114). */
  readonly status: SessionStatus;
  /** Stamped by main when the turn starts; null between turns (C17). The page derives the elapsed time. */
  readonly turnStartedAt: number | null;
  /** Live clock only: time held for the turn's own blocking decisions, never stored in records. */
  readonly turnWait?: { readonly turnId: string; readonly ms: number; readonly since: number | null };
  /** The agents that run (C18). */
  readonly activeWorkers: number;
  readonly attention: Attention | null;
  readonly action: SessionAction | null;
  readonly displayHold?: ActionHold;
  /**
   * In the order they started (C113): every running one, and the most recently finished, across
   * turns and restarts, up to `MAX_FINISHED_AGENTS` (M106, C26, C27).
   */
  readonly agents: readonly AgentView[];
  /** In force: the record's until a source reports what the session runs with (C23). */
  readonly model: string;
  readonly effort: string | null;
  /**
   * The id of the mode the session's process runs under, as its last start or change confirmed it
   * (M22, C2, C75); null while no process of it has confirmed one — before its first start, and
   * after every end of its process. Never a native word.
   */
  readonly mode: string | null;
  /**
   * What the chat waits on while another chat, or the plan's reviewer, holds the plan it takes part in
   * (decision 0029; the maintainer): a kind alone, never the plan's. Absent while it waits
   * on none — it is no attention, and nothing acknowledges it.
   */
  readonly planWait?: PlanWait;
  /**
   * The session asked for a faster tier and its last turn that said its speed ran at standard speed
   * (decision 0016), with its CLI's reason id where it gave one. Absent otherwise: a turn
   * served fast takes it back. A live reading, never stored.
   */
  readonly notFast?: { readonly reason: string | null };
  /**
   * How full the session's context window is, as its CLI last reported it (decision 0033). Absent
   * until a process of it has reported one; each report replaces it. A live reading, never stored.
   */
  readonly context?: ContextReading;
}

// ── A chat's context window (decision 0033) ───────────────────────────────────────────────────
// What the CLI says of the conversation its model holds: counts, and the CLI's own labels for the
// parts of it, never a path or a configured name. Main holds it in the summary alone.

/** Most labelled parts a reading carries, and the longest label. */
export const MAX_CONTEXT_PARTS = 16;
export const MAX_CONTEXT_LABEL = 40;
/** Larger than any window a CLI reports: a count past it is no reading. */
export const MAX_CONTEXT_TOKENS = 1_000_000_000;
/** A part's label: the CLI's own words, letters, spaces and brackets alone. */
export const CONTEXT_LABEL = /^[A-Za-z][A-Za-z ()]*$/;

/** Tokens of one model call, or of all the calls so far: what was read anew, from the cache, written to it, and given out. */
export interface ContextCalls {
  /** Input not read from the provider's cache. */
  readonly input: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output: number;
  /** Of the output, what the model reasoned, where the CLI tells them apart. */
  readonly reasoning?: number;
}

/** What the conversation's messages hold, by kind, where the CLI counts them. */
export interface ContextMessages {
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly answers: number;
  readonly prompts: number;
  readonly attachments: number;
  /** What the CLI counted and gave no kind. */
  readonly other: number;
}

export interface ContextReading {
  /** Tokens in the context now. */
  readonly used: number;
  /** The model's context window. */
  readonly window: number;
  /** Where the CLI compacts by itself; null when it says it will not; absent where it does not say. */
  readonly compactAt?: number | null;
  /** The parts of what is used, in the CLI's order and by its labels. */
  readonly parts?: readonly { readonly label: string; readonly tokens: number }[];
  readonly messages?: ContextMessages;
  /** The last call of the session's own model. */
  readonly lastCall?: ContextCalls;
  /** Every call of the conversation so far, as the CLI totals them. */
  readonly calls?: ContextCalls;
}

const contextTokens = z.number().int().min(0).max(MAX_CONTEXT_TOKENS);
const ContextCallsSchema = z.strictObject({ input: contextTokens, cacheRead: contextTokens.optional(), cacheWrite: contextTokens.optional(), output: contextTokens, reasoning: contextTokens.optional() });

export const ContextReadingSchema: z.ZodType<ContextReading> = z.strictObject({
  used: contextTokens,
  window: contextTokens.min(1),
  compactAt: contextTokens.min(1).nullable().optional(),
  parts: z.array(z.strictObject({ label: z.string().min(1).max(MAX_CONTEXT_LABEL).regex(CONTEXT_LABEL), tokens: contextTokens })).max(MAX_CONTEXT_PARTS).optional(),
  messages: z.strictObject({ toolCalls: contextTokens, toolResults: contextTokens, answers: contextTokens, prompts: contextTokens, attachments: contextTokens, other: contextTokens }).optional(),
  lastCall: ContextCallsSchema.optional(),
  calls: ContextCallsSchema.optional(),
});

const sameCalls = (a: ContextCalls | undefined, b: ContextCalls | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.input === b.input && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite && a.output === b.output && a.reasoning === b.reasoning);

/** Whether two readings say the same: a report that changes nothing is no change of the summary. */
export function sameContext(a: ContextReading | undefined, b: ContextReading | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.used !== b.used || a.window !== b.window || a.compactAt !== b.compactAt) return false;
  if (!sameCalls(a.lastCall, b.lastCall) || !sameCalls(a.calls, b.calls)) return false;
  const [ma, mb] = [a.messages, b.messages];
  if (ma !== mb && (ma === undefined || mb === undefined || ma.toolCalls !== mb.toolCalls || ma.toolResults !== mb.toolResults || ma.answers !== mb.answers || ma.prompts !== mb.prompts || ma.attachments !== mb.attachments || ma.other !== mb.other)) return false;
  const [pa, pb] = [a.parts, b.parts];
  if (pa === pb) return true;
  if (pa === undefined || pb === undefined || pa.length !== pb.length) return false;
  return pa.every((part, at) => part.label === pb[at]?.label && part.tokens === pb[at]?.tokens);
}

/** What a chat of a plan waits on while another holds it (decision 0029): its review, its revision, its implementation. */
export const PLAN_WAITS = ['review', 'revision', 'implementation'] as const;
export type PlanWait = (typeof PLAN_WAITS)[number];

/**
 * Why a session cannot be used now (M14, C108; M14b, C29, C62). It stays listed and selectable, with
 * its Remove; its effort menu is disabled, and main refuses a change whatever the page shows.
 */
export const SESSION_HOLDS = [
  /** The provider is switched off in Settings, or this build does not have it. */
  'provider-unavailable',
  /** Its instance is switched off, blocked, or no longer configured. */
  'instance-unavailable',
  /** It started in a configuration folder that is not the one its instance has now. */
  'folder-moved',
] as const;
export type SessionHold = (typeof SESSION_HOLDS)[number];

/**
 * Why a session cannot take a prompt (M15, C105; Design 9): the first check that fails, in this
 * order. One word, never a path. Main says it in the session's entry and checks the same list
 * again when a prompt is sent; a running session has none shown, since its button is Stop.
 */
export const SEND_BLOCKS = [
  'records-refused',
  /** The conversation store is refused (M18, C33): a prompt could not be recorded, and no history is read. */
  'conversations-refused',
  /** The demo source is on: its sessions are scripted (C32). */
  'demo',
  /** The provider is not in this build, is switched off, or its CLI was not found (C31). */
  'provider-unavailable',
  /** The provider has no sessions in this version (C6). */
  'no-sessions',
  'instance-unavailable',
  'folder-moved',
  /** The project is no longer offered to the provider (C31). */
  'not-offered',
  /** The instance's latest account read said that no one is signed in (C112). */
  'signed-out',
  /** The registry holds no runtime for the instance (C112). */
  'not-connected',
  /** A started session's folder is no longer a root of its project (C30). */
  'folder-not-root',
  'folder-not-trusted',
  'folder-missing',
  /**
   * The session's model, the exact version it was made with, is no longer in its account's list
   * (decision 0016): no other is put in its place. Its earlier messages are still read.
   */
  'model-not-listed',
  /**
   * The session's last start, or its last change of mode, did not confirm the chat's mode (M22,
   * C46, C75): nothing is sent until a mode its account runs is chosen. A change of mode is never
   * refused for it, since the change is its remedy (C89).
   */
  'mode-unconfirmed',
  /** The chat's saved mode is one its account cannot use now (M22, C43): never substituted, and remedied the same way. */
  'mode-unavailable',
] as const;
export type SendBlock = (typeof SEND_BLOCKS)[number];

/** The two blocks a change of mode remedies (M22, C89): read for a prompt and an aside's question, and never for the change itself. */
export function isModeBlock(block: SendBlock | null): block is 'mode-unconfirmed' | 'mode-unavailable' {
  return block === 'mode-unconfirmed' || block === 'mode-unavailable';
}

export interface SessionEntry {
  readonly record: SessionView;
  readonly summary: SessionSummary;
  /** Null for a session that can be used. Main's to say: the page holds no folder to compare. */
  readonly hold: SessionHold | null;
  /** Why it cannot take a prompt now, or null (M15, C105): shown in place of the chat's input. */
  readonly block: SendBlock | null;
  /**
   * The chat's mode and where it came from (M22, C1, C40, C82): its saved one, or — for a chat that
   * has saved none yet — what the hierarchy gives it now. Null for a provider that declares no mode,
   * and while the conversation store cannot say. The header draws it before the chat is read.
   */
  readonly mode: ChatMode | null;
  /** A change of its mode is under way (M22, C90): nothing else of it is taken meanwhile. */
  readonly changingMode: boolean;
  /**
   * A plan's decision waits in the chat (M22b, C56, C58): the header's mode control is held, a prompt
   * is refused and Review existing plan says why. Left out, or false, where none does.
   */
  readonly planPending?: boolean;
  /**
   * Its draft or its queue holds something (M23, C83): a presence alone, never what. A session not
   * started and not named keeps its capsule by it, its images alone included. Left out where none does.
   */
  readonly content?: true;
  /**
   * What its capsule, its rows and the model column draw (M102, C29): resolved by main, in M102 its
   * provider's default face; null for none, and before the avatars' first scan lands (C57). M103 puts
   * its model's assignment first. The Pet's projection holds none of it (C35).
   */
  readonly avatar: ResolvedAvatar | null;
  /**
   * Its listed sub-agents' avatars, by sub-agent id, each resolved by its own model as `avatar` is by
   * the session's (M106, C17): one with no model has none here, and its row draws `avatar`. Left out
   * where no listed sub-agent names a model. The Pet's projection holds none of it.
   */
  readonly agentAvatars?: Readonly<Record<string, ResolvedAvatar | null>>;
}

/** The Main window's `AppStateSnapshot.sessions` (C65). */
export interface SessionsState {
  /** Every session whose project can be read, in stored order (C11). */
  readonly sessions: readonly SessionEntry[];
  /** One for the Main window, held by main and never saved (C33). */
  readonly selectedId: string | null;
  /** Session entries no project's removal reaches (C107). */
  readonly orphans: number;
}

/** How many workers a list may hold, a reported set included (C116; M106, C27). */
const MAX_WORKERS = 256;

const time = z.number().int().min(0);
const label = z.string().refine((value) => value !== '' && normalizeName(value) === value, 'not a clean label');
const catalogKey = z.string().refine((value) => catalogId(value) !== null, 'not a catalog id');
// The detail is optional (M100, C52): a summary written without it still passes.
const ActionSchema = z.strictObject({ kind: z.enum(ACTION_KINDS), wait: ActionWaitSchema.optional(), tool: z.literal(true).optional(), label, detail: label.nullable().optional() });
const AttentionSchema = z.strictObject({ kind: z.enum(ATTENTION_KINDS), count: z.number().int().min(1), acknowledged: z.boolean(), flash: z.literal(false).optional() });

/** What a fixture summary, and anything main publishes, must pass (C30). */
export const SessionSummarySchema: z.ZodType<SessionSummary> = z.strictObject({
  status: z.enum(SESSION_STATUSES),
  turnStartedAt: time.nullable(),
  turnWait: z.strictObject({ turnId: z.string().min(1), ms: z.number().min(0), since: time.nullable() }).optional(),
  activeWorkers: z.number().int().min(0),
  attention: AttentionSchema.nullable(),
  action: ActionSchema.nullable(),
  displayHold: ActionHoldSchema.optional(),
  agents: z.array(
    z.strictObject({
      id: z.string().min(1),
      number: z.number().int().min(1),
      label,
      state: z.enum(AGENT_STATES),
      action: ActionSchema.nullable(),
      displayHold: ActionHoldSchema.optional(),
      startedAt: time,
      finishedAt: time.nullable(),
      model: catalogKey.nullable(),
      agentType: label.nullable(),
      attention: AttentionSchema.nullable(),
    }),
  ).max(MAX_WORKERS),
  model: z.string().min(1),
  effort: z.string().min(1).nullable(),
  mode: ModeIdSchema.nullable(),
  planWait: z.enum(PLAN_WAITS).optional(),
  notFast: z.strictObject({ reason: ServedReasonSchema.nullable() }).optional(),
  context: ContextReadingSchema.optional(),
});

// ── Words (C21, C40–C42, C52, C62) ────────────────────────────────────────────────────────────

/** fat-g's words for an action whose source sent no line of its own (C21); `verb` goes before a file's name.
 * Only Thinking has a trailing ellipsis, so the other statuses do not look truncated. */
const ACTION_WORDS: Readonly<Record<ActionKind, { readonly alone: string; readonly verb: string | null }>> = {
  thinking: { alone: 'Thinking…', verb: null },
  writing: { alone: 'Writing', verb: 'Writing' },
  reading: { alone: 'Reading', verb: 'Reading' },
  running: { alone: 'Running a command', verb: 'Running' },
  tool: { alone: 'Using a tool', verb: null },
  waiting: { alone: 'Waiting', verb: null },
  asking: { alone: 'Asking a question', verb: null },
  approving: { alone: 'Waiting for your approval', verb: null },
  'plan-ready': { alone: 'Plan ready', verb: null },
  compacting: { alone: 'Compacting', verb: null },
};

/**
 * An absolute path, up to its last segment. A drive or UNC path with backslashes runs to its last
 * backslash, spaces included — a Windows user name often has one; the others run to a space.
 */
const PATHS = /(?:(?<!\w)[A-Za-z]:\\|\\\\)(?:(?!\b[A-Za-z]:[\\/]).)*\\|(?<!\w)[A-Za-z]:\/(?:[^\s/]+\/)*|(?<![\w.:/~-])\/(?:[^\s/]+\/)+/g;

/**
 * A provider's own status line as a label (C21): its first line, every absolute path cut to its last
 * segment, clamped like a name. Empty when nothing is left.
 */
export function cleanLabel(line: string): string {
  const first = line.split(/\r?\n/).find((part) => part.trim() !== '') ?? '';
  return normalizeName(first.replace(PATHS, ''));
}

/** The last segment of a path, as a label would show it. */
function fileName(file: string): string {
  const segments = file.split(/[\\/]/).filter((segment) => segment.trim() !== '');
  return normalizeName(segments.at(-1) ?? '');
}

/** An action's label: the provider's line when it sends one, else fat-g's words for the kind (C21). */
export function actionLabel(kind: ActionKind, line?: string, file?: string): string {
  const own = line === undefined ? '' : cleanLabel(line);
  if (own !== '') return own;
  const { alone, verb } = ACTION_WORDS[kind];
  const name = file === undefined ? '' : fileName(file);
  return name === '' || verb === null ? alone : normalizeName(`${verb} ${name}`);
}

/**
 * An action's detail, apart from its status (M100, C52): the provider's line when it sends one, else
 * the file's name, each cleaned as the label is; null with neither.
 */
export function actionDetail(line?: string, file?: string): string | null {
  const own = line === undefined ? '' : cleanLabel(line);
  if (own !== '') return own;
  const name = file === undefined ? '' : fileName(file);
  return name === '' ? null : name;
}

/** An action's status: fat-g's words for its kind, "Thinking…", "Reading" (M100, C51–C53). */
export function actionStatus(action: ActionKind | Pick<SessionAction, 'kind' | 'wait'>): string {
  const kind = typeof action === 'string' ? action : action.kind;
  if (typeof action !== 'string' && kind === 'waiting' && action.wait?.reason === 'subagents') {
    const count = action.wait.count;
    return count === undefined ? 'Waiting for sub-agents' : count === 1 ? 'Waiting for a sub-agent' : `Waiting for ${count} sub-agents`;
  }
  return ACTION_WORDS[kind].alone;
}

/** What a session reads while its turn has ended and its workers still run (C114). Its words are its whole label: it has no detail. */
export function waitingOnWorkers(count: number): SessionAction {
  const wait: ActionWait = { reason: 'subagents', count: Math.min(256, count) };
  return { kind: 'waiting', wait, label: actionStatus({ kind: 'waiting', wait }), detail: null };
}

/** A worker's label: its description, else its provider identifier, else its number (C113). */
export function workerLabel(number: number, description?: string, identifier?: string): string {
  for (const candidate of [description, identifier]) {
    const cleaned = candidate === undefined ? '' : cleanLabel(candidate);
    if (cleaned !== '') return cleaned;
  }
  return `Worker ${number}`;
}

/** "ready", "3 Questions", "1 Approval", "plan ready", "error", "stopped": the attention in words (C41, C52; M22b, C27). */
export function attentionWords(attention: Pick<Attention, 'kind' | 'count'>): string {
  switch (attention.kind) {
    case 'question':
      return attention.count === 1 ? '1 Question' : `${attention.count} Questions`;
    case 'approval':
      return attention.count === 1 ? '1 Approval' : `${attention.count} Approvals`;
    // No count: a session never has more than one plan pending (M22b, C27).
    case 'plan':
      return 'plan ready';
    // A reviewer's findings wait for the user's decisions (M22e).
    case 'review':
      return 'plan review';
    case 'ready':
    case 'error':
    case 'stopped':
      return attention.kind;
  }
}

/** What a chat of a plan says while another holds the plan (decision 0029; the maintainer). */
export const PLAN_WAIT_WORDS: Readonly<Record<PlanWait, string>> = {
  review: 'Waiting on plan review',
  revision: 'Waiting on plan revision',
  implementation: 'Waiting on plan implementation',
};

/**
 * The plan's wait where it is what the chat shows (decision 0029; the maintainer): over
 * READY, and over a plan's request the chat still holds on an older state of the same plan, but under
 * its own question, approval, error or stop, and under a turn of its own that runs.
 */
export function planWaitShown(summary: Pick<SessionSummary, 'planWait' | 'attention' | 'status'>): PlanWait | null {
  const wait = summary.planWait ?? null;
  if (wait === null) return null;
  const kind = summary.attention?.kind ?? null;
  if (kind !== null && kind !== 'ready' && kind !== 'plan') return null;
  return summary.status === 'running' && kind !== 'plan' ? null : wait;
}

/** Whether the chat takes part in a plan that is ready or held elsewhere: drawn as a started chat is, though it has run nothing. */
export function inPlan(summary: Pick<SessionSummary, 'attention' | 'planWait'>): boolean {
  return summary.attention?.kind === 'plan' || summary.planWait !== undefined;
}

/**
 * A notification the user has not seen, or a decision still pending (decision 0010), where it is what
 * the chat shows rather than a plan's wait: what lights the Main window's icon.
 */
export function unseenAttention(summary: Pick<SessionSummary, 'planWait' | 'attention' | 'status'>): boolean {
  return planWaitShown(summary) === null && summary.attention !== null && !summary.attention.acknowledged;
}

/** What the Pet lists (decision 0010): an active session whose turn runs, or that waits on the user. */
export function waitsOnYou(entry: { readonly record: Pick<SessionView, 'completedAt' | 'shelvedAt'>; readonly summary: Pick<SessionSummary, 'planWait' | 'attention' | 'status'> }): boolean {
  return isActive(entry.record) && (entry.summary.status === 'running' || unseenAttention(entry.summary));
}

/** A session's state in words, for a capsule's accessible name and the avatar column (C43, C62). */
export function statusWords(summary: SessionSummary): string {
  const wait = planWaitShown(summary);
  if (wait !== null) return PLAN_WAIT_WORDS[wait];
  if (summary.attention !== null) return capitalize(attentionWords(summary.attention));
  if (summary.status === 'running') return summary.action?.label ?? actionStatus('thinking');
  return summary.status === 'idle' ? 'Idle' : 'Not started';
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "+3 active subagents" (C40): what a capsule's accessible name says. */
export function workersText(count: number): string {
  return `+${count} active ${count === 1 ? 'subagent' : 'subagents'}`;
}

/** "3 subagents": the subagent count beside a capsule's elapsed time. */
export function workersLine(count: number): string {
  return `${count} ${count === 1 ? 'subagent' : 'subagents'}`;
}

// ── Elapsed time (C51) ────────────────────────────────────────────────────────────────────────

/**
 * "32s" under a minute, "4m7s" under an hour, then "1h12m5s": whole seconds throughout, the seconds
 * kept after an hour. One form wherever a running time shows — the status bar, a capsule, a worker
 * row, and the speaker bar, whose reference it is (the maintainer).
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${seconds % 60}s` : `${Math.floor(minutes / 60)}h${minutes % 60}m${seconds % 60}s`;
}

// ── The list's parts (C37–C39, C46–C48, C50) ──────────────────────────────────────────────────

/** How many completed sessions show at first, and how many Show more and Show less add and take (C48). */
export const COMPLETED_STEP = 5;

export type SessionGroup = 'starred' | 'unstarred';

/** A session's star group; its lifecycle list is a separate ordering boundary. */
export function groupOfSession(record: Pick<SessionView, 'starred'>): SessionGroup {
  return record.starred ? 'starred' : 'unstarred';
}

export interface SessionParts<T> {
  /** Neither shelved nor completed: the starred first, each group in stored order (C38, C39). */
  readonly active: readonly T[];
  /** The shelf: the shelved, the starred first, each group in saved order. */
  readonly shelf: readonly T[];
  /** The toggle row's two counts, or null when neither part has a session (C37, C47). */
  readonly row: { readonly shelf: number; readonly completed: number } | null;
  /** The completed, the starred first, each group in saved order, cut to `shown` (C48). */
  readonly completed: readonly T[];
  readonly showMore: boolean;
  readonly showLess: boolean;
}

/**
 * One project's sessions, in stored order, as the four parts the list draws (C50). The star files no
 * session anywhere: in each part the starred stand first (the maintainer).
 */
export function sessionParts<T extends { readonly record: Pick<SessionView, 'starred' | 'completedAt' | 'shelvedAt'> }>(sessions: readonly T[], shown: number): SessionParts<T> {
  const starredFirst = (list: readonly T[]): readonly T[] => [...list.filter((session) => session.record.starred), ...list.filter((session) => !session.record.starred)];
  const active = starredFirst(sessions.filter((session) => isActive(session.record)));
  const shelf = starredFirst(sessions.filter((session) => session.record.shelvedAt !== null));
  const completed = starredFirst(sessions.filter((session) => session.record.completedAt !== null));
  const cut = Math.max(0, shown);
  return {
    active,
    shelf,
    row: shelf.length + completed.length === 0 ? null : { shelf: shelf.length, completed: completed.length },
    completed: completed.slice(0, cut),
    showMore: completed.length > cut,
    showLess: Math.min(cut, completed.length) > COMPLETED_STEP,
  };
}

export interface OrderedAgents {
  /** The most recently started first, so the longest-running is at the bottom (C92). */
  readonly running: readonly AgentView[];
  /** The most recently finished first. */
  readonly finished: readonly AgentView[];
}

/**
 * How many finished sub-agents a session's summary keeps (M106, C27): the most recently finished by
 * `orderAgents`' order, every running one beside them.
 */
export const MAX_FINISHED_AGENTS = 100;

export function orderAgents(agents: readonly AgentView[]): OrderedAgents {
  return {
    running: agents.filter((agent) => agent.state === 'running').sort((a, b) => b.startedAt - a.startedAt || b.number - a.number),
    finished: agents.filter((agent) => agent.state !== 'running').sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0) || b.number - a.number),
  };
}

// ── A source's events (C25, C115, C116) ───────────────────────────────────────────────────────
// Every event names its session, and what it belongs to there: a turn, by the id its turn-started
// event chose, or a worker, by its own id. Main checks each against its schema before taking it.

/** What a source may send as a line: main keeps the first one and clamps it (C21). */
export const MAX_LINE_INPUT = 2000;
export const MAX_REFERENCE = 256;

const sessionId = z.guid();
const turnId = z.string().min(1).max(128);
const workerId = z.string().min(1).max(256);
const requestId = z.string().min(1).max(256);
const line = z.string().max(MAX_LINE_INPUT);
/** No control character: an opaque id, never text (C5). */
const reference = z.string().min(1).max(MAX_REFERENCE).refine((value) => !/\p{Cc}/u.test(value), 'control character');
const actionFields = { kind: z.enum(ACTION_KINDS).nullable(), wait: ActionWaitSchema.optional(), tool: z.literal(true).optional(), line: line.optional(), file: line.optional() };
const owner = z.union([z.strictObject({ turnId }), z.strictObject({ workerId })]);

/** A finished sub-agent the conversation store lists (M106, C26): what its worker item holds. */
export const ListedWorkerSchema = z.strictObject({
  workerId,
  label: line,
  status: z.enum(['completed', 'failed']),
  model: catalogKey.nullable(),
  agentType: line.nullable(),
  startedAt: time,
  finishedAt: time.nullable(),
});
export type ListedWorker = z.infer<typeof ListedWorkerSchema>;

export const SessionEventSchema = z.discriminatedUnion('type', [
  /** The provider's session exists: its opaque id, and the folder it started in (C5, C6). */
  z.strictObject({ type: z.literal('reference-set'), sessionId, reference, folder: z.string().min(1).max(4096) }),
  z.strictObject({ type: z.literal('turn-started'), sessionId, turnId }),
  z.strictObject({ type: z.literal('turn-ended'), sessionId, turnId, outcome: z.enum(REPORTED_OUTCOMES) }),
  /** A null kind is no action. */
  z.strictObject({ type: z.literal('action-changed'), sessionId, turnId, ...actionFields }),
  /** `model` and `agentType` (M106, C14, C20): as the CLI named them at the start, each one line. */
  z.strictObject({ type: z.literal('worker-started'), sessionId, workerId, description: line.optional(), identifier: line.optional(), model: catalogKey.optional(), agentType: line.optional() }),
  /** The model a listed worker runs on, named after its start (M106, C38). */
  z.strictObject({ type: z.literal('worker-model'), sessionId, workerId, model: catalogKey }),
  /**
   * A session's finished sub-agents as the conversation store holds them, at launch (M106, C26): the
   * most recent first, each completed or failed with its label, model, agent definition and times.
   * It replaces the list of a session that does not run, and is nothing for one that does.
   */
  z.strictObject({ type: z.literal('workers-listed'), sessionId, workers: z.array(ListedWorkerSchema).max(MAX_FINISHED_AGENTS) }),
  z.strictObject({ type: z.literal('worker-progressed'), sessionId, workerId, ...actionFields }),
  z.strictObject({ type: z.literal('worker-ended'), sessionId, workerId, outcome: z.enum(['completed', 'failed']) }),
  /** The whole set of the session's running workers: a listed one missing from it has ended (C116). */
  z.strictObject({ type: z.literal('workers-reported'), sessionId, workerIds: z.array(workerId).max(MAX_WORKERS) }),
  /** `count`: what the attention counts the request as (M100b, C24, C25) — a question's request its questions, an approval one. A count alone, never a text. */
  z.strictObject({ type: z.literal('request-raised'), sessionId, owner, requestId, kind: z.enum(REQUEST_KINDS), count: z.number().int().min(1).max(MAX_QUESTIONS) }),
  z.strictObject({ type: z.literal('request-resolved'), sessionId, owner, requestId }),
  /**
   * What the session runs with (C23). A field left out is not reported. `withdrawn` takes back what
   * was reported, so the summary follows the record again (M15, C103): a turn's effort holds for
   * that turn, and no longer.
   */
  /** `mode` (M22, C2): the mode the session's process runs under, as a start or a change confirmed it; null takes it back, at the process's end. */
  z.strictObject({ type: z.literal('in-force'), sessionId, model: catalogKey.optional(), effort: catalogKey.nullable().optional(), mode: ModeIdSchema.nullable().optional(), withdrawn: z.literal(true).optional(), served: z.enum(SERVED_SPEEDS).optional(), servedReason: ServedReasonSchema.nullable().optional() }),
  /** How full the session's context window is, as its CLI reported it (decision 0033): it replaces the reading held. */
  z.strictObject({ type: z.literal('context'), sessionId, reading: ContextReadingSchema }),
  z.strictObject({ type: z.literal('name-reported'), sessionId, name: z.string().max(MAX_LINE_INPUT), source: z.enum(NAME_SOURCES) }),
  /**
   * A plan the chat takes part in waits for its decision, with no request holding it, or no longer
   * does (M22b, C27): what a turn's end reads as PLAN READY in READY's place. Since decision 0029 the
   * workflow raises it in every chat of a ready plan, a brought one's too (the maintainer).
   */
  z.strictObject({ type: z.literal('plan-waiting'), sessionId, waiting: z.boolean(), flash: z.literal(false).optional() }),
  /** Another chat, or the reviewer, holds the plan the chat takes part in, or no longer does (decision 0029): what it waits on. */
  z.strictObject({ type: z.literal('plan-wait'), sessionId, wait: z.enum(PLAN_WAITS).nullable() }),
  /**
   * A review's triage panel stands in the reviewer's chat, its findings waiting for the user's
   * decisions, or no longer does (M22e): PLAN REVIEW in READY's place. A launch raises nothing.
   */
  z.strictObject({ type: z.literal('review-waiting'), sessionId, waiting: z.boolean() }),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
export type EventOwner = z.infer<typeof owner>;

// ── Requests (C31) ────────────────────────────────────────────────────────────────────────────

const id = z.guid();

export const SessionCreateRequestSchema = z.strictObject({ projectId: id, preset: ModelPresetSchema });
export const SessionSetDraftPresetRequestSchema = z.strictObject({ id, preset: ModelPresetSchema });
export const SessionIdRequestSchema = z.strictObject({ id });
/** Cancellation must never remove a session whose first turn has already started. */
export const SessionRemoveRequestSchema = z.strictObject({ id, draftOnly: z.literal(true).optional() });
/** One flag set or cleared; the others are left as they are. */
export const SessionSetFlagRequestSchema = z.strictObject({ id, flag: z.enum(SESSION_FLAGS), on: z.boolean() });
/** A name the user typed (M26): bounded here, normalized and clamped by main, kept as the user's. */
export const SessionRenameRequestSchema = z.strictObject({ id, name: z.string().max(MAX_LINE_INPUT) });
/**
 * The composer's unsent text of a session no turn has run (M26 round 2): what the secretary
 * describes it by. Cut to the most a title is written from before it is sent, so no more of a draft
 * than that ever leaves the page.
 */
export const SessionDescribeDraftRequestSchema = z.strictObject({
  id,
  text: z.string().min(1).max(MAX_LINE_INPUT).refine((value) => value.trim() !== '', 'only whitespace'),
});
/** Before the session `before` names, in its own project and group, or at that group's end (C55). */
export const SessionMoveRequestSchema = z.strictObject({ id, before: id.nullable(), group: SessionOrderGroupSchema });
export const SessionSetEffortRequestSchema = z.strictObject({ id, effort: catalogKey });
/** A speed tier's id, as the session's model lists it, or null for standard speed (decision 0016). */
export const SessionSetSpeedRequestSchema = z.strictObject({ id, speed: catalogKey.nullable() });
export const AnswerQuitRequestSchema = z.strictObject({ quit: z.boolean() });

export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;
export type SessionSetDraftPresetRequest = z.infer<typeof SessionSetDraftPresetRequestSchema>;
export type SessionIdRequest = z.infer<typeof SessionIdRequestSchema>;
export type SessionRemoveRequest = z.infer<typeof SessionRemoveRequestSchema>;
export type SessionSetFlagRequest = z.infer<typeof SessionSetFlagRequestSchema>;
export type SessionRenameRequest = z.infer<typeof SessionRenameRequestSchema>;
export type SessionDescribeDraftRequest = z.infer<typeof SessionDescribeDraftRequestSchema>;
export type SessionMoveRequest = z.infer<typeof SessionMoveRequestSchema>;
export type SessionSetEffortRequest = z.infer<typeof SessionSetEffortRequestSchema>;
export type SessionSetSpeedRequest = z.infer<typeof SessionSetSpeedRequestSchema>;
export type AnswerQuitRequest = z.infer<typeof AnswerQuitRequestSchema>;

// ── Answers ───────────────────────────────────────────────────────────────────────────────────

export const SESSION_REFUSALS = [
  'draft-locked',
  'records-refused',
  /** A removal while the conversation store is refused (M18, C42): it could not reach the chats, and would leave them behind. */
  'conversations-refused',
  /** A removal whose mark could not be written to the conversation store (M18, C63): nothing was removed. */
  'storage-failed',
  'unknown-session',
  'unknown-project',
  /** A turn runs, or its workers still do (C35, C36, C114). */
  'running',
  /** The project is not enabled for the preset's provider (C32). */
  'provider-not-offered',
  /** The provider is switched off in Settings, or this build does not have it (C32, C108). */
  'provider-unavailable',
  /** The instance is switched off, blocked, or not configured (M14b, C25, C29). */
  'instance-unavailable',
  /** The session started in another configuration folder than its instance has now (M14b, C62). */
  'folder-moved',
  /** Hidden, or not in the list the provider's CLI reported. */
  'model-not-listed',
  'effort-not-listed',
  /** A speed tier the model does not list (decision 0016). */
  'speed-not-listed',
  /** A speed tier asked of an account whose catalog entry says fat-g cannot ask for one (decision 0016). */
  'speed-unavailable',
  /** A move to another project or group, or made against a group the session has since left. */
  'outside-group',
  /** A rename to a name that is empty once normalized (M26). */
  'name-empty',
] as const;
export type SessionRefusalReason = (typeof SESSION_REFUSALS)[number];

/**
 * What a session that runs is doing, as a refusal because it runs says it (M22e; the maintainer's
 * V6 review): a review's turn, a review's findings being integrated, a plan turn, a plan's revision
 * from feedback, a plan carried out, its workers alone after its turn, or any other turn. A kind
 * alone: nothing of a prompt or a plan.
 */
export const RUNNING_DOINGS = ['review', 'integration', 'plan', 'revision', 'execution', 'workers', 'turn'] as const;
export type RunningDoing = (typeof RUNNING_DOINGS)[number];

/** `doing`: on a refusal because the session runs, what it is doing, where main says it. */
export type SessionRefusal = { readonly status: 'refused'; readonly reason: SessionRefusalReason; readonly doing?: RunningDoing };
export type SessionSaved = { readonly status: 'saved' };
export type SessionCreated = { readonly status: 'saved'; readonly id: string };
/**
 * A draft the secretary was asked to describe (M26 round 2): `taken` says a request went out, whose
 * answer names the session later or never; `skipped` that nothing was asked — the session has run,
 * the user named it, or generated names are switched off. Neither saves anything by itself.
 */
export type SessionDescribeResult = { readonly status: 'taken' } | { readonly status: 'skipped' } | SessionRefusal;

export type AnswerQuitResult = { readonly status: 'answered' } | { readonly status: 'refused'; readonly reason: 'no-question' };
