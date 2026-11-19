// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The normalized agent events, version thirteen (docs/planning/_archive/M15.md, Design 2; C9–C11, C113;
// M18.md, Design 1; C47, C59; M16.md, Design 6; C78; M19.md, Design 1; C3–C6; M20a.md, Design 2; C59;
// M20b.md, Design 2; C25; M21.md, Design 2; C20, C63; M22.md, Design 3, 4; C8, C76; M22b.md, Design 1; C9,
// C10, C14, C61; docs/planning/_archive/M106.md, Design 1; C20, C38): what an adapter tells main of a session,
// whatever its CLI. A closed union, each member a strict schema; main checks every event against
// it before the bridge takes it, and drops and counts one that fails.
//
// No field carries a provider's name for a thing (S3): a turn is named by the id the runtime made
// when it accepted the prompt (C11, C86), a worker by the adapter's own id for it.
//
// Two kinds of field (C10). Conversation text — a message's text and questions, a notice's detail —
// is kept as the CLI sent it, bounded and never rewritten, and goes to the chat alone. Every other
// field is an id, a kind or a label: bounded, with no command line, no account field and no raw
// frame. A string that is only too long never fails its schema: the adapter cuts it first (`cutTo`).
//
// Version two carries what the conversation store matches by (M18, C47): a turn's start names the
// provider's own id for the turn beside the runtime's, a turn's end says whether the provider itself
// reported it (C59), and a message read from history names its turn and, for the user's own, the id
// it was sent with.
//
// Version three carries what a second provider showed (M16, C78). A provider that labels no phase
// names its turn's answer on the turn's end, by the message's item id (C74): the store then sets
// that one message's phase, in the write that stores the end. Two notices are new, for a folder
// that could not be handed over (C20) and for a start found overruled after the prompt was sent
// (C62), which is a turn's failure of its own too.
//
// Version four carries a message as it is written (M19, C3–C5): `message-delta` opens a message at
// the first one for its item id and appends at each later one, and the `message` event of that id,
// unchanged, completes it. The whole message is the authority: its text replaces what the deltas
// brought. A provider that sends no delta says its messages whole, as before, and declares nothing:
// streaming is no capability.
//
// Version five carries what a session does between its messages (M20a, C59). `activity-started`
// opens an item of the conversation for a read, a command, a tool's use, a sub-agent, a thinking or
// a checklist, and `activity-ended` ends it, each field bounded as activity.ts says and cut by the
// adapter first. A start for an item id that is already open opens nothing: it replaces what the
// first one said, which is how a checklist's each update travels, and how a worker item learns the
// worker paired with it. A message, a delta and both of these may name the worker whose item it is
// (C20): what a worker says and does is kept under it, and is never the session's own.
//
// Version six carries a question asked beside the session (M20b, C25). A message, a delta, an
// activity's start and end, a turn's start and end and a notice may name the aside whose event it
// is: an aside has turns of its own, each a question and its answer, and nothing of them is the
// session's — not its turn, its answer, its action line nor its status. A message may name the
// model that wrote it, where the provider says another answered than the session's. A reply that
// is no answer ends its aside's turn as failed, with a notice of its own.
//
// Version seven carries a question asked as a request (M21, C20, C63). `question-raised` says the
// provider made a request that holds its turn, or its worker, until it is answered: its id, the id
// of what carried it, and its questions, bounded for the card (interaction.ts) — the adapter keeps
// the request as it came, and encodes the answer from that. `question-resolved` says what became of
// one, by a reason: the provider took it back, its process could not take the answer or was lost
// with it pending, or the provider confirmed it took the answer. Both go to the request registry,
// and the bridge gives nothing for either.
//
// Version eight carries an action asked leave for (M22, C8, C76). `approval-raised` says the
// provider asked whether a command may run, a file may change or a tool may be used, and holds its
// turn, or its worker, for the decision: its id, the id of what carried it, and the request,
// bounded and provider-neutral (interaction.ts) — the adapter keeps the request as it came, and
// answers from that. `approval-resolved` says what became of one, by M21's reasons. Both of a
// request's resolutions gain a fourth reason, `changed`: the request came again under its id with
// another payload, and its adapter refused that and let the first go (C91). `in-force` may name the
// mode the process runs under, at each confirmation of it (C2). An activity may end `declined`,
// with who declined it where the adapter knows (C76). Three notices are new: a policy the provider
// reported that is not the mode's, a line too long to read that may have been a request, and — on
// the refusal of a request — which bound it was past.
//
// Version nine carries a plan (M22b, C9, C10, C14, C56, C61). `plan-raised` says the provider asked
// for the user's decision on a plan it proposed, and holds its turn for it — Claude's request — with
// the plan's whole text and the id of what carried it. `plan-delta` opens a plan being written at the
// first one for its item id, which may carry no text, and appends at each later one; `plan-completed`
// gives its whole text, which is the authority (M19, C4). `plan-resolved` says what became of a
// plan's request, by a request's reasons. A plan's text is bounded by the line alone (C60, C61).
// Two notices are new: a plan request that carried no plan, and one too large to receive.
//
// Version ten carries the model a sub-agent runs on (M106, C14, C15, C20, C38). `worker-started` and a
// worker item's start may name it, as the CLI names it at the start — an alias, a key — and the agent
// definition it runs as; `worker-model` names it where a CLI says it only once the worker has spoken,
// for the summary, beside a second start of the worker item for the chat. A model is a key or nothing.
//
// Version eleven says that whether a message can go into the running turn changed (M23b):
// `steer-changed`, with nothing else in it.
//
// Version twelve carries how full a session's context window is (decision 0033): `context`, a reading
// of counts and the CLI's own labels for the parts of it, which replaces the one held. It goes to the
// summary alone, and is never stored.
import { z } from 'zod';
import { ReturnedImageSchema } from './returned-images';
import { activityEndFields, activityStartFields, ENDED_STATUSES, HISTORY_STATUSES } from './activity';
import { cutTo } from './cut';
import { ApprovalRequestSchema, InteractionQuestionsSchema, MAX_OPTIONS, MAX_QUESTION_TEXT, MAX_QUESTIONS } from './interaction';
import { ModeIdSchema } from './permissions';
import { MAX_PLAN_TEXT } from './plans';
import { ACTION_KINDS, ActionWaitSchema, ContextReadingSchema, MAX_LINE_INPUT, MAX_REFERENCE, REPORTED_OUTCOMES, SERVED_SPEEDS, ServedReasonSchema } from './sessions';

export { cutTo };

// Version thirteen adds closed waiting metadata and tool-writing ownership to transient actions (M105).
// Version fourteen delivers bounded returned-image payloads to main alone.
export const AGENT_EVENTS_VERSION = 14;

/** A message's text, and a prompt (C53, C54). */
export const MAX_MESSAGE_TEXT = 100_000;
/** The CLI's own words in a notice (C39). */
export const MAX_NOTICE_DETAIL = 500;
/** How many questions, how many options each, and a question's title and each of its options: interaction.ts has them, a request's questions sharing them (M21, C7). */
export { MAX_OPTIONS, MAX_QUESTION_TEXT, MAX_QUESTIONS };
/** An id of the provider's: an item, a worker. Over it, the value is no id and its frame is dropped. */
export const MAX_AGENT_ID = 256;
/** A history message's images (M23, C25): how many are kept, and how long a path each may name. */
export const MAX_HISTORY_IMAGES = 32;
export const MAX_HISTORY_IMAGE_PATH = 4096;

/** A label's input (C43, C113): the first line that holds anything, cut to what M14's events take. */
export function cutLine(value: string): string {
  const first = value.split(/\r?\n/).find((part) => part.trim() !== '') ?? '';
  return cutTo(first, MAX_LINE_INPUT).text;
}

export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** An assistant message is the turn's answer, or what the agent says while it works (C40). */
export const MESSAGE_PHASES = ['commentary', 'final'] as const;
export type MessagePhase = (typeof MESSAGE_PHASES)[number];

/**
 * What an adapter may tell the chat besides messages (Design 7). The words are fat-g's, chosen by
 * main from the kind; only `turn-failed` carries a detail, the CLI's own message.
 */
export const NOTICE_KINDS = [
  /** A start that failed after the prompt was accepted (C87), with its step. */
  'start-failed',
  /** The provider did not take the restricted start, seen before any prompt was sent (C21). */
  'not-read-only',
  /** The start was found overruled after the prompt was sent, and the session was stopped (M16, C62). */
  'start-overruled',
  /** The provider refused to reopen the session, as it does one that is gone (C25, C129). */
  'session-not-reopened',
  'turn-failed',
  'connection-lost',
  /** The turn's end never arrived (C89). */
  'output-lost',
  'stop-unconfirmed',
  /** Workers left after their turn were stopped, or went with their process (C100). */
  'workers-stopped',
  'workers-lost',
  /** The CLI asked for something; nothing is granted (C34). Once per turn. */
  'request-refused',
  /** One of the project's other folders could not be handed to the provider (M16, C20). It carries no path. */
  'folder-not-passed',
  /** An aside's reply held no answer: none, or a placeholder that no model wrote (M20b, C25). */
  'no-answer',
  /**
   * The provider started, or reported at a turn's start, another policy than the chat's mode asks
   * for (M22, C7, C46): `detail` is what it reported, in its own words. Nothing was sent after it.
   */
  'policy-mismatch',
  /**
   * A line over a session's limit that is or may be a request, and whose id could not be read (M22,
   * C71): everything its process ran was stopped. `size` is the line's, in bytes.
   */
  'line-too-long',
  /** A plan request that carried no plan (M22b, C9): it was refused, and no version was made. */
  'plan-missing',
  /** A plan too large to receive (M22b, C61): past the line a session carries, refused or left unfinished, and no version was made of it. */
  'plan-too-large',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * Which bound a refused request was past (M22, C9, C48, C67), on a `request-refused` notice that
 * names its size: how many targets or choices, a detail's or a path's UTF-16 units, or a line's bytes.
 */
export const REFUSED_BOUNDS = ['targets', 'choices', 'detail', 'path', 'line'] as const;
export type RefusedBound = (typeof REFUSED_BOUNDS)[number];

/** Where a start failed, in fat-g's terms (C87): starting the CLI, opening or reopening the session, sending the prompt. */
export const START_STEPS = ['launch', 'open', 'reopen', 'send'] as const;
export type StartStep = (typeof START_STEPS)[number];

/**
 * What became of a request, as its adapter says it (M21, C20, C63): a question's, and an
 * approval's (M22, C8). `changed` (M22, C91): it came again under its id with another payload,
 * which the adapter refused on the wire, letting the first go.
 */
export const REQUEST_RESOLUTIONS = ['withdrawn', 'dropped', 'confirmed', 'changed'] as const;
export type RequestResolution = (typeof REQUEST_RESOLUTIONS)[number];
export const QUESTION_RESOLUTIONS = REQUEST_RESOLUTIONS;
export type QuestionResolution = RequestResolution;

/** What a `delivery` event says of a handed message (M23, C38, C43). */
export const DELIVERY_EVENT_STATES = ['taken', 'cancelled', 'not-confirmed'] as const;
export type DeliveryEventState = (typeof DELIVERY_EVENT_STATES)[number];

/** Why a turn failed, for the log's count (C75): a kind, never a text. `policy-mismatch` (M22, C46): its start reported another policy than the chat's mode. */
export const TURN_FAILURES = ['start-failed', 'not-read-only', 'start-overruled', 'session-not-reopened', 'turn-failed', 'connection-lost', 'end-lost', 'policy-mismatch'] as const;
export type TurnFailure = (typeof TURN_FAILURES)[number];

const noControl = (value: string): boolean => !/\p{Cc}/u.test(value);
const turnId = z.string().min(1).max(128);
const agentId = z.string().min(1).max(MAX_AGENT_ID).refine(noControl, 'control character');
const line = z.string().max(MAX_LINE_INPUT);
const catalogKey = z.string().min(1).max(128).refine(noControl, 'control character');
const text = z.string().max(MAX_MESSAGE_TEXT);
/** A plan's text: no length of fat-g's, the line's alone (M22b, C60, C61). */
const planText = z.string().max(MAX_PLAN_TEXT);
const questionText = z.string().max(MAX_QUESTION_TEXT);
const questions = z.array(z.strictObject({ title: questionText, options: z.array(questionText).max(MAX_OPTIONS) })).max(MAX_QUESTIONS);
const actionFields = { kind: z.enum(ACTION_KINDS), wait: ActionWaitSchema.optional(), tool: z.literal(true).optional(), line: line.optional(), file: line.optional() };
const time = z.number().int().min(0);
/** Whose item it is, when it is a worker's and not the session's own (M20a, C20): the adapter's id for the worker. */
const workerId = agentId.optional();
/**
 * The aside whose event it is (M20b, C25): the id main gave its ask. An event that names one is the
 * aside's alone — its `turnId` is a turn of the aside's own — and never the session's.
 */
const asideId = agentId.optional();

const messageFields = {
  role: z.enum(MESSAGE_ROLES),
  /** The provider's id for it. */
  itemId: agentId,
  /** Null for the user's own. */
  phase: z.enum(MESSAGE_PHASES).nullable(),
  text,
  questions: questions.optional(),
  /** The text or the questions were cut to their bounds (C113). */
  cut: z.boolean().optional(),
};

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('image-returned'), turnId, itemId: agentId, workerId, image: ReturnedImageSchema }),
  /** The provider's session can be reopened by this reference, started in this folder (C20, C130). */
  z.strictObject({ type: z.literal('session-started'), reference: z.string().min(1).max(MAX_REFERENCE).refine(noControl, 'control character'), folder: z.string().min(1).max(4096) }),
  /** The provider took the prompt (C38). `providerTurnId` is its own id for the turn, when it has one (M18, C47). */
  z.strictObject({ type: z.literal('turn-started'), turnId, providerTurnId: agentId.optional(), asideId }),
  /**
   * A whole message (C40, C41), or the provider's echo of the user's own (C56): `clientId` is then
   * the id the prompt was sent with, when the echo carries it. `model` (M20b, C25): the model that
   * wrote it, where the provider says another answered than the session's; left out otherwise.
   */
  z.strictObject({ type: z.literal('message'), turnId, ...messageFields, clientId: agentId.optional(), workerId, asideId, model: catalogKey.optional() }),
  /**
   * More of an assistant's message, as it is written (M19, C3): `itemId` is the provider's id for
   * the message, as `message.itemId` is, `phase` what is known of its phase so far — null where
   * the provider has not said, as one that names the answer only at the turn's end cannot (C79) —
   * and `text` what to append. The first one for an id opens its message, and may carry no text.
   */
  z.strictObject({ type: z.literal('message-delta'), turnId, itemId: agentId, phase: z.enum(MESSAGE_PHASES).nullable(), text, workerId, asideId }),
  /**
   * Something the session does between its messages began (M20a, C59): `itemId` is the provider's
   * id for it, `turnId` the turn it belongs to — for a worker's, the turn that started the worker,
   * whether or not that turn has ended (C20). `pairedWorkerId`: on a worker item, the worker it
   * started, once known (C23). `providerAt`: when the provider says it began. One for an item id
   * that is already open replaces what the first one said, and opens nothing.
   */
  z.strictObject({ type: z.literal('activity-started'), turnId, itemId: agentId, workerId, asideId, pairedWorkerId: agentId.optional(), ...activityStartFields, providerAt: time.optional() }),
  /**
   * It ended, as the provider reports it (C6): `failed` on an error flag, a non-zero exit code or a
   * failed status. `providerAt`: when the provider says it ended; `durationMs`: how long the
   * provider says it took, a zero included. One that names an item whose turn has ended still ends it.
   * `untimed`: its start frame never came, so its two events came together and no duration is
   * measured for it (C7): it has the provider's, or none.
   */
  z.strictObject({ type: z.literal('activity-ended'), turnId, itemId: agentId, workerId, asideId, status: z.enum(ENDED_STATUSES), ...activityEndFields, providerAt: time.optional(), durationMs: time.optional(), untimed: z.literal(true).optional() }),
  z.strictObject({ type: z.literal('action-changed'), turnId, ...actionFields }),
  /**
   * A sub-agent began. `model` (M106, C14, C15): the model it runs on as the CLI names it at the start,
   * an alias included; left out where it names none. `agentType` (C20): the agent definition it runs
   * as, where the CLI names one.
   */
  z.strictObject({ type: z.literal('worker-started'), workerId: agentId, description: line.optional(), model: catalogKey.optional(), agentType: line.optional() }),
  /** The model a listed sub-agent runs on, named once it has spoken (M106, C14, C38): it replaces what its start named. */
  z.strictObject({ type: z.literal('worker-model'), workerId: agentId, model: catalogKey }),
  z.strictObject({ type: z.literal('worker-progressed'), workerId: agentId, ...actionFields }),
  z.strictObject({ type: z.literal('worker-ended'), workerId: agentId, outcome: z.enum(['completed', 'failed']) }),
  /**
   * What the provider says the turn runs with, when it says so during the turn (C45). `mode` (M22,
   * C2): the id of the mode the process runs under, at each confirmation of it — a start's check, a
   * change's reply. Never a native word. `turnId` is left out by a confirmation no turn carries.
   * `served` (decision 0016): where the session asked for a faster tier, the speed its CLI
   * says it ran at — `standard` with the CLI's reason id where it fell back (models research §6).
   */
  z.strictObject({ type: z.literal('in-force'), turnId: turnId.optional(), model: catalogKey.optional(), effort: catalogKey.nullable().optional(), mode: ModeIdSchema.optional(), served: z.enum(SERVED_SPEEDS).optional(), servedReason: ServedReasonSchema.nullable().optional() }),
  /** `bound` and `size` (M22, C9, C48, C67, C71): on a refusal for a size, which bound and how much; on `line-too-long`, the line's bytes. */
  z.strictObject({ type: z.literal('notice'), turnId: turnId.optional(), kind: z.enum(NOTICE_KINDS), step: z.enum(START_STEPS).optional(), detail: z.string().max(MAX_NOTICE_DETAIL).optional(), bound: z.enum(REFUSED_BOUNDS).optional(), size: z.number().int().min(0).optional(), asideId }),
  /**
   * The turn is over. `reported` is true only when the provider itself said so (M18, C59): an end
   * the adapter makes — the turn's end lost, the connection lost, a Stop the provider never
   * confirmed, a failed start, the session closed — is the session's end and never the provider's.
   *
   * `answerItemId` (M16, C74): the item id of the message that is the turn's answer, from a provider
   * that labels no phase as its messages arrive. Only an end the provider reported as completed
   * names one; a provider that labels each message itself names none.
   */
  z.strictObject({ type: z.literal('turn-ended'), turnId, outcome: z.enum(REPORTED_OUTCOMES), reported: z.boolean(), failure: z.enum(TURN_FAILURES).optional(), answerItemId: agentId.optional(), asideId }),
  /**
   * The provider asked the user a question and holds its turn for the answer (M21, C20): a request
   * the adapter can place — under the session's current turn, or, `workerId`, under a worker it has
   * paired and not ended, `turnId` then being the turn that started the worker. `requestId`: the
   * provider's id of the request, by which `answer` names it. `sourceId`: the provider's id of what
   * carried it, where the card stands. `questions`: bounded for the card, `cut` where anything went.
   */
  z.strictObject({ type: z.literal('question-raised'), turnId, workerId, requestId: agentId, sourceId: agentId, questions: InteractionQuestionsSchema, cut: z.boolean() }),
  /**
   * What became of a request (M21, C20, C63, C67). `withdrawn`: the provider took it back while its
   * owner went on. `dropped`: its process could not take the answer, or was lost with the request
   * still unanswered — never an answer whose write went (C70). `confirmed`: the provider's word that
   * it took the answer (C62). An owner's end says nothing here: the registry sweeps at that end.
   */
  z.strictObject({ type: z.literal('question-resolved'), requestId: agentId, reason: z.enum(QUESTION_RESOLUTIONS) }),
  /**
   * The provider asked leave for an action and holds its turn for the decision (M22, C8): a request
   * the adapter can place, as a question's is — under the session's current turn, or, `workerId`,
   * under a worker it has paired and not ended. `requestId`: the adapter's lossless key for the
   * request, by which `decide` names it — a number and a string of one spelling are two (C10).
   * `sourceId`: the provider's id of what carried it, which the action's own activity shares (C14).
   * `request`: the whole action, within every bound; one past a bound is refused by its adapter and
   * never raised (C9, C48).
   */
  z.strictObject({ type: z.literal('approval-raised'), turnId, workerId, requestId: agentId, sourceId: agentId, request: ApprovalRequestSchema }),
  /** What became of an approval's request (M22, C8, C12, C91), by a question's reasons: `confirmed` is the provider's word that it took the decision, and says nothing of the action's success. */
  z.strictObject({ type: z.literal('approval-resolved'), requestId: agentId, reason: z.enum(REQUEST_RESOLUTIONS) }),
  /**
   * The provider proposed a plan and holds its turn for the user's decision (M22b, C10): a request
   * of the session's current turn, its key `requestId`, by which `decidePlan` names it, `sourceId`
   * the provider's id of what carried it, and `text` the plan's whole text, as the request carried it.
   */
  z.strictObject({ type: z.literal('plan-raised'), turnId, requestId: agentId, sourceId: agentId, text: planText }),
  /**
   * More of a plan being written (M22b, C14): `itemId` is the provider's id for the plan, and `text`
   * what to append. The first one for an id opens it, and may carry no text. A worker's plan is none.
   */
  z.strictObject({ type: z.literal('plan-delta'), turnId, itemId: agentId, text: planText }),
  /** The plan's whole text (M22b, C14): the authority, whatever its deltas brought. */
  z.strictObject({ type: z.literal('plan-completed'), turnId, itemId: agentId, text: planText }),
  /** What became of a plan's request (M22b, C6, C56), by a request's reasons. */
  z.strictObject({ type: z.literal('plan-resolved'), requestId: agentId, reason: z.enum(REQUEST_RESOLUTIONS) }),
  /**
   * The provider's later word on a message handed into a running turn (M23, C38, C42–C44), by the
   * chat's id for it: `taken` into that turn; `cancelled` by a Stop, never to run; `not-confirmed`
   * where the process ended with no word of it.
   */
  z.strictObject({ type: z.literal('delivery'), messageId: agentId, state: z.enum(DELIVERY_EVENT_STATES) }),
  /**
   * A message handed into a turn that ended first ran as the provider's next turn (M23, C42): `turnId`
   * is that turn's, the adapter's own, and every event of it names it, as a sent turn's do.
   */
  z.strictObject({ type: z.literal('held-turn-started'), turnId, messageId: agentId }),
  /**
   * Whether a message can go into the running turn changed, with no other event saying so: main asks
   * the session's `steerState` again, and a Send now it holds goes in once that says `open`.
   */
  z.strictObject({ type: z.literal('steer-changed') }),
  /** How full the session's context window is, as its CLI reported it (decision 0033): for the summary alone. */
  z.strictObject({ type: z.literal('context'), reading: ContextReadingSchema }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];
export type AgentMessageEvent = Extract<AgentEvent, { type: 'message' }>;
export type AgentDeltaEvent = Extract<AgentEvent, { type: 'message-delta' }>;
export type AgentActivityStarted = Extract<AgentEvent, { type: 'activity-started' }>;
export type AgentActivityEnded = Extract<AgentEvent, { type: 'activity-ended' }>;
export type AgentQuestion = NonNullable<AgentMessageEvent['questions']>[number];
export type AgentQuestionRaised = Extract<AgentEvent, { type: 'question-raised' }>;
export type AgentQuestionResolved = Extract<AgentEvent, { type: 'question-resolved' }>;
export type AgentApprovalRaised = Extract<AgentEvent, { type: 'approval-raised' }>;
export type AgentApprovalResolved = Extract<AgentEvent, { type: 'approval-resolved' }>;
export type AgentPlanRaised = Extract<AgentEvent, { type: 'plan-raised' }>;
export type AgentPlanResolved = Extract<AgentEvent, { type: 'plan-resolved' }>;
export type AgentPlanDelta = Extract<AgentEvent, { type: 'plan-delta' }>;
export type AgentPlanCompleted = Extract<AgentEvent, { type: 'plan-completed' }>;

/**
 * A message read back from the provider's own history (C92; M18, C47): what a `message` event
 * carries, with the provider's own id for its turn in place of the runtime's, which was another
 * run's, and for a user's message the id it was sent with, when the provider kept it. `at` is when
 * its turn started, when the provider says.
 */
export const HistoryMessageSchema = z.strictObject({
  ...messageFields,
  turnId: agentId,
  clientId: agentId.optional(),
  at: time.nullable(),
  /**
   * Its place among its turn's items in the provider's order, from a history that gives activities
   * too (M20a, C19): what puts a turn's messages and activities in one order. Left out, a turn's
   * messages are in the order they were given, and before any activity that names no earlier place.
   */
  order: z.number().int().min(0).optional(),
  /**
   * A user's message's images, as the provider's history names them (M23, C24, C25): each by the path
   * it was sent with, as received. Main matches a path under fat-g's own images' folder to the image
   * it holds, and reads none; any other reads "image not available". Left out for a message with none.
   */
  images: z.array(z.strictObject({ path: z.string().min(1).max(MAX_HISTORY_IMAGE_PATH) })).max(MAX_HISTORY_IMAGES).optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/**
 * An activity read back from the provider's own history (M20a, C19): what its two events would have
 * carried, as one, with the provider's own id for its turn. It has its status as history gives it
 * and its duration where the item has one, and no start time of its own: `at` is when its turn
 * started, when the provider says. `order` is its place among its turn's items.
 */
export const HistoryActivitySchema = z.strictObject({
  turnId: agentId,
  itemId: agentId,
  ...activityStartFields,
  ...activityEndFields,
  summary: activityStartFields.summary,
  status: z.enum(HISTORY_STATUSES),
  durationMs: time.optional(),
  at: time.nullable(),
  order: z.number().int().min(0),
});
export type HistoryActivity = z.infer<typeof HistoryActivitySchema>;

/**
 * A plan read back from the provider's own history (M22b, C28): its item, its turn by the provider's
 * own id, its whole text, and its place among its turn's items. It is reconciled with the plan line
 * the store holds for it, and is a message where there is none: what fat-g did not see arrive, it
 * did not record as a version.
 */
export const HistoryPlanSchema = z.strictObject({
  turnId: agentId,
  itemId: agentId,
  text: planText,
  at: time.nullable(),
  order: z.number().int().min(0),
});
export type HistoryPlan = z.infer<typeof HistoryPlanSchema>;

/**
 * A turn of the provider's own history (M18, C47, C51): its id, how the provider says it ended —
 * null while it runs, or for a status fat-g does not know — and its times, each null when the
 * provider gives none.
 */
export const HistoryTurnSchema = z.strictObject({
  turnId: agentId,
  outcome: z.enum(REPORTED_OUTCOMES).nullable(),
  startedAt: time.nullable(),
  endedAt: time.nullable(),
  durationMs: time.nullable(),
});
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;
