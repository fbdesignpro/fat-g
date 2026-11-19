// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The composer's durable input (docs/planning/_archive/M23.md, Design 1, 5–10; C31–C67, C80–C89; decisions
// 0019, 0023, 0030): a session's unsent draft, its queued messages, what became of a message sent
// into a running turn, and the commands and skills its CLI reports. Drafts and queued messages are
// conversation content: main keeps them in the conversation store alone, and the Main window reads
// them over the chat channels. The Pet gets none of it; the status bar gets a count.
//
// Renderer-safe: types, bounds, schemas and fat-g's words. No provider is named here: a skill is
// chosen by an opaque selector main made, never by a path, and a command is a name.
import { z } from 'zod';
import { type AttachmentDescriptor, MAX_IMAGES } from './attachments';
import { ItemIdSchema } from './conversation';
import { MAX_MESSAGE_TEXT } from './agent-events';

// ── A prompt's intent (C87, C88) ──────────────────────────────────────────────────────────────

/** A command's or a skill's name as a row gives it (C65): one token of a CLI's own, never white space. */
export const MAX_COMMAND_NAME = 128;
export const CommandNameSchema = z.string().min(1).max(MAX_COMMAND_NAME).regex(/^[^\s/][^\s]*$/u).refine((value) => !/\p{Cc}/u.test(value), 'control character');

/** A skill's selector (C87): main's opaque encoding of the identity its CLI listed, never a path. */
export const SkillSelectorSchema = z.string().regex(/^[0-9a-f]{16,64}$/);

/** A skill the user chose from the menu (C64, C87): its name as listed and main's selector for it. */
export interface SkillSelection {
  readonly name: string;
  readonly selector: string;
}
export const SkillSelectionSchema = z.strictObject({ name: CommandNameSchema, selector: SkillSelectorSchema });

/**
 * What a prompt is, beside its text and its images (C87): a plan turn (M22b, C1), and a skill chosen
 * from the menu. Kept with a draft and a queued message, so that leaving the session or a restart
 * never changes what a queued message means. A command typed and not chosen is text.
 */
export interface PromptIntent {
  readonly plan: boolean;
  readonly skill: SkillSelection | null;
}
export const NO_INTENT: PromptIntent = { plan: false, skill: null };
export const PromptIntentSchema = z.strictObject({ plan: z.boolean(), skill: SkillSelectionSchema.nullable() });

export function readIntent(value: unknown): PromptIntent {
  const parsed = PromptIntentSchema.safeParse(value);
  return parsed.success ? parsed.data : NO_INTENT;
}

// ── Drafts (C31–C34) ──────────────────────────────────────────────────────────────────────────

/**
 * A session's draft as main holds it (C31, C86). `revision` counts the text's changes the page made,
 * as the page numbered them: an update below or at it is late, and never written over newer input.
 */
export interface DraftView {
  readonly revision: number;
  readonly text: string;
  readonly intent: PromptIntent;
  readonly attachments: readonly AttachmentDescriptor[];
}
export const EMPTY_DRAFT: DraftView = { revision: 0, text: '', intent: NO_INTENT, attachments: [] };

/** How long the page gathers a draft's changes before it hands them to main (C31). */
export const DRAFT_SEND_MS = 300;
/** How often main writes a session's draft at most (C31): and at a switch and at the quit. */
export const DRAFT_WRITE_MS = 2_000;

export const DraftRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const draftText = z.string().max(MAX_MESSAGE_TEXT);
const useIds = z.array(ItemIdSchema).max(MAX_IMAGES);
const sessionId = z.guid();
/** A queued message's id, main's own. */
export const QueueIdSchema = z.guid();

/**
 * A change of a draft (C86): its text and intent at a revision; an image taken out of it, by its use's
 * id; cleared, at a revision; or written now, which a session switch and the quit ask.
 */
export const ChatDraftRequestSchema = z.union([
  z.strictObject({ sessionId, op: z.literal('text'), revision: DraftRevisionSchema, prompt: draftText, intent: PromptIntentSchema }),
  z.strictObject({ sessionId, op: z.literal('remove'), attachmentId: ItemIdSchema }),
  z.strictObject({ sessionId, op: z.literal('clear'), revision: DraftRevisionSchema }),
  z.strictObject({ sessionId, op: z.literal('flush') }),
]);
export type ChatDraftRequest = z.infer<typeof ChatDraftRequestSchema>;

export const DRAFT_REFUSALS = ['unknown-session', 'unknown-attachment', 'busy', 'conversations-refused', 'storage-failed'] as const;
export type DraftRefusal = (typeof DRAFT_REFUSALS)[number];
export type ChatDraftResult = { readonly status: 'saved'; readonly draft: DraftView } | { readonly status: 'refused'; readonly reason: DraftRefusal };

/**
 * Main's ask, before the Main page goes — its window closed, or fat-g quitting (C31): the text the page
 * holds and has not handed over, handed over now. The token names the ask; the page answers it once
 * every draft is in, and main waits for that answer a bounded time.
 */
export interface DraftFlushPush {
  readonly token: number;
}
export const DraftFlushedRequestSchema = z.strictObject({ token: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });
export type DraftFlushedRequest = z.infer<typeof DraftFlushedRequestSchema>;
export type DraftFlushedResult = { readonly status: 'answered' } | { readonly status: 'refused'; readonly reason: 'no-request' };

// ── The queue (C47–C57, C82, C89) ─────────────────────────────────────────────────────────────

/** A session's queue holds this many messages at most (C47): the eleventh is refused in words. */
export const MAX_QUEUE = 10;

/**
 * One queued message (C48, C54): its text, its images and its intent; `sending` while its release is
 * under way. `now`: a Send now held until the turn can take it, which goes at the first opportunity
 * rather than once the session is idle. Main keeps that in memory alone: after a restart the entry is
 * an ordinary first entry, whose first opportunity is the next prompt anyway.
 */
export interface QueuedMessage {
  readonly id: string;
  readonly text: string;
  readonly intent: PromptIntent;
  readonly attachments: readonly AttachmentDescriptor[];
  readonly queuedAt: number;
  readonly sending: boolean;
  readonly now: boolean;
}

/**
 * Why the queue stopped (C89): a refusal of the send path's that waits for no state main settles by
 * itself — the mode unconfirmed or unavailable once read, the CLI missing, the store failing — or a
 * queued message that can no longer mean what it meant: its chosen skill gone, or an image missing.
 * The words and the remedy are the send's own; Resume releases it through the same checks.
 */
export interface QueuePause {
  readonly reason: string;
}

export interface QueueView {
  /** Oldest first: the next to go is the first (C48). */
  readonly entries: readonly QueuedMessage[];
  readonly paused: QueuePause | null;
}
export const EMPTY_QUEUE: QueueView = { entries: [], paused: null };

/** A message's input as Send, Queue and Edit carry it (C86): the draft's text, its images by their uses' ids, and its revision. */
const input = { prompt: draftText, revision: DraftRevisionSchema, attachments: useIds, intent: PromptIntentSchema };

/** Queue next: the draft appended (C48); or a reorder of every entry of the session, by id (C51, C86). */
export const ChatQueueRequestSchema = z.union([
  z.strictObject({ sessionId, op: z.literal('append'), ...input }),
  z.strictObject({ sessionId, op: z.literal('reorder'), ids: z.array(QueueIdSchema).min(1).max(MAX_QUEUE) }),
]);
export const ChatUnqueueRequestSchema = z.strictObject({ sessionId, entryId: QueueIdSchema });
/** Edit (C50): the entry's input comes into the composer, and the draft as it is takes the entry's place. */
export const ChatEditQueuedRequestSchema = z.strictObject({ sessionId, entryId: QueueIdSchema, ...input });
export const ChatResumeQueueRequestSchema = z.strictObject({ sessionId });
export type ChatQueueRequest = z.infer<typeof ChatQueueRequestSchema>;
export type ChatUnqueueRequest = z.infer<typeof ChatUnqueueRequestSchema>;
export type ChatEditQueuedRequest = z.infer<typeof ChatEditQueuedRequestSchema>;
export type ChatResumeQueueRequest = z.infer<typeof ChatResumeQueueRequestSchema>;

export const QUEUE_REFUSALS = [
  'unknown-session',
  /** The id names no entry of this session's queue, or the reorder does not name each of them once. */
  'unknown-entry',
  /** The entry is being sent (C54): it takes no Edit and no Remove. */
  'sending',
  /** The queue holds ten already (C47). */
  'full',
  /** Nothing to queue: no text and no image. */
  'empty',
  /** The images named are not the draft's (C86): the page reads again. */
  'draft-changed',
  /** A message with an image still being kept waits for it (C18). */
  'busy',
  'conversations-refused',
  'storage-failed',
  /** Resume asked for a queue that is not paused. */
  'not-paused',
] as const;
export type QueueRefusal = (typeof QUEUE_REFUSALS)[number];
export type ChatQueueResult = { readonly status: 'saved' } | { readonly status: 'refused'; readonly reason: QueueRefusal };

// ── A message sent into a running turn (C35–C46) ──────────────────────────────────────────────

/**
 * What became of a message sent now (C38–C44). `sent`: handed to the live process, nothing more known;
 * `taken`: the CLI confirmed it joined the turn; `next-prompt`: refused because the turn was over, and
 * sent as the next prompt (C39); `not-sent`: refused for another reason, with the CLI's word, and not
 * sent again; `not-confirmed`: the process or the turn ended with no word, and fat-g sends nothing of
 * it again (C40); `cancelled`: Stop cancelled it while the CLI still held it (C43).
 */
export const DELIVERY_STATES = ['sent', 'taken', 'next-prompt', 'not-sent', 'not-confirmed', 'cancelled'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Settled: nothing more becomes of it. */
export const isDeliverySettled = (state: DeliveryState): boolean => state !== 'sent';

/** A message's delivery as the page draws it under the message. `detail`: the CLI's own code or words, bounded, for `not-sent`. */
export interface DeliveryView {
  readonly state: DeliveryState;
  readonly detail: string | null;
}

export const DELIVERY_WORDS: Readonly<Record<DeliveryState, string>> = {
  sent: 'Sent (not processed yet by model)',
  taken: 'Prompt received by model',
  'next-prompt': 'The previous reply had ended: sent as a new message',
  'not-sent': 'Not sent',
  'not-confirmed': 'Not confirmed: fat-g does not know whether it reached the session',
  cancelled: 'Cancelled by Stop',
};

// ── The busy actions (C35, C37, C80, C88) ─────────────────────────────────────────────────────

/** What Enter does while a turn runs (C80): Send now by default, or Queue. */
export const BUSY_ENTERS = ['send-now', 'queue'] as const;
export type BusyEnter = (typeof BUSY_ENTERS)[number];

/**
 * Whether a message can go into the session's running turn: `open`, now; `wait`, not this instant —
 * the turn not started yet, a change of mode waiting, a Stop, workers alone, no turn at all — so a
 * Send now is held until it can; `unsupported`, never on this process, which cannot take a message
 * during a turn at all.
 */
export const STEER_STATES = ['open', 'wait', 'unsupported'] as const;
export type SteerState = (typeof STEER_STATES)[number];

/** The composer's state beside the conversation, as a chat read carries it (C57, C86). */
export interface ChatComposer {
  readonly draft: DraftView;
  readonly queue: QueueView;
  /** Whether a message can go into the running turn: Send now is withheld only where it is `unsupported`. */
  readonly steer: SteerState;
}
export const EMPTY_COMPOSER: ChatComposer = { draft: EMPTY_DRAFT, queue: EMPTY_QUEUE, steer: 'wait' };

/** Why Send now is withheld while a turn runs, so that Queue stands alone and says why. */
export type SendNowWithheld = 'plan' | 'skill' | 'unsupported';

export const COMPOSER_WORDS = {
  sendNow: 'Send now',
  queue: 'Queue',
  /** The tooltips name their key, and when the message arrives. */
  sendNowKey: (enter: boolean): string => `Send now (${enter ? 'Enter' : 'Ctrl+Enter'}): added to the current reply at the first opportunity`,
  queueKey: (enter: boolean): string => `Queue (${enter ? 'Enter' : 'Ctrl+Enter'}): sent once the current reply and its sub-agents are done`,
  /** The line standing above Queue while Send now is withheld: the cause, and when a message goes. */
  withheld: (cause: SendNowWithheld, provider: string): string => {
    switch (cause) {
      case 'plan': return 'Plan is pressed: planning starts once the current reply and its sub-agents are done.';
      case 'skill': return 'A skill is chosen: this message is sent separately once the current reply and its sub-agents are done.';
      case 'unsupported': return `${provider} cannot take a message while working here: it goes once the current reply and its sub-agents are done. Stop ends the reply sooner.`;
    }
  },
  /** A held Send now's row. */
  held: 'Send now',
  heldLabel: 'Send now, waits for the first opportunity',
  sending: 'Sending…',
  edit: 'Edit',
  remove: 'Remove',
  /** The status bar's count (C82). */
  queued: (count: number): string => `${count} ${count === 1 ? 'message' : 'messages'} queued`,
  full: `The queue holds ${MAX_QUEUE} messages at most.`,
  resume: 'Resume',
  paused: 'The queue is paused.',
  skillUnavailable: 'The skill chosen for this message is no longer listed, so it was not sent.',
  imageMissing: 'An image of this message is no longer available, so it was not sent.',
} as const;

// ── Commands and skills (C58–C67, C86) ────────────────────────────────────────────────────────

/** A row's text as the CLI gave it, cut to this many UTF-16 units (C65). */
export const MAX_COMMAND_TEXT = 200;

/** Which group a row stands in (C60–C64): fat-g's own intercepted commands first, then the CLI's, then its skills. */
export const COMMAND_GROUPS = ['fat-g', 'commands', 'skills'] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * One row of the menu (C58, C65, C86): a name, the CLI's description and argument hint where it gave
 * them, drawn as text. `selector`: main's opaque id for a skill whose choice goes with the prompt as
 * an input of its own (C64, C87); null for a row whose choice is only its text.
 */
export interface CommandRow {
  readonly name: string;
  readonly description: string | null;
  readonly hint: string | null;
  readonly group: CommandGroup;
  readonly selector: string | null;
}

/** The menu's rows for a session (C61): `note` is fat-g's line where the CLI's own are not listed yet. */
export interface CommandList {
  readonly rows: readonly CommandRow[];
  readonly note: string | null;
}

export const ChatCommandsRequestSchema = z.strictObject({ sessionId });
export type ChatCommandsRequest = z.infer<typeof ChatCommandsRequestSchema>;
export type ChatCommandsResult = ({ readonly status: 'read' } & CommandList) | { readonly status: 'refused'; readonly reason: 'unknown-session' };

export const MENU_WORDS = {
  label: 'Commands',
  skills: 'Skills',
  /** fat-g's own rows (C62): what fat-g does in the command's place. */
  own: { 'command-clear': 'fat-g answers it: start a new session for another conversation', 'command-model': 'fat-g answers it: a session’s model is fixed when it is created', 'command-fast': 'fat-g answers it: choose Fast with the effort' } as const,
  /** Before any process of the session has run (C61). */
  notStarted: (provider: string): string => `${provider}’s own commands are listed once the session has started.`,
  /** Announced once at opening (C67). */
  count: (count: number): string => `${count} ${count === 1 ? 'command' : 'commands'} listed`,
  /** The rows listed, none of them begins with what was typed. */
  none: 'No command matches.',
  /** Nothing listed at all, and no line saying why: a CLI with no command or skill to list. */
  empty: 'No commands or skills are listed for this session.',
} as const;

/** The name a message's text begins a command with, after its leading `/` (C59): null where it begins none. */
export function leadingCommand(text: string): string | null {
  const match = /^\/([^\s/]*)/u.exec(text);
  return match === null ? null : match[1] ?? '';
}
