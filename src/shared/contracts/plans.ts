// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Plans (docs/planning/_archive/M22b.md, Design 1; C16–C20, C56, C60, C64, C68, C69, C72, C74, C75; decision
// 0029): a plan a session proposes in a plan turn, kept by fat-g as a versioned record in its own
// data folder, listed in its project's registry, linked from a line in the chat and decided from a
// panel. A plan's text is project content: it reaches the conversation's page and the plan's tab,
// and never a log, the app state or the Pet, which get kinds and counts.
//
// Renderer-safe, and provider-neutral: no CLI's word for a plan, a frame or a method is here. The
// block a plan's prompt carries is fat-g's own, written and read by the two functions below, so that
// main, the page and a history read agree on it.
//
// It imports `zod` and the name rule, and nothing of Node, the page or main.
import { z } from 'zod';
import type { SendRefusal } from './chat';
import { normalizeName } from './names';
import type { SendBlock } from './sessions';
import type { WorkflowState, WorkflowView } from './workflow';

// ── Ids and bounds (C16, C60, C61) ────────────────────────────────────────────────────────────

/** The folder of fat-g's data folder that holds the plans (C16): one folder per plan. */
export const PLANS_FOLDER = 'plans';

/** A plan's id, as main makes it: what its folder, its line, a prompt's fields and every channel name it by. */
export const PlanIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/);
export const isPlanId = (value: unknown): value is string => PlanIdSchema.safeParse(value).success;

/** A version's number: 1 for a plan's first, counting up across every version it has had. */
export const MAX_PLAN_VERSION = 100_000;
export const PlanVersionSchema = z.number().int().min(1).max(MAX_PLAN_VERSION);

/** A complete version's content hash: SHA-256 of its UTF-8 bytes, as 64 hex digits (C16). */
export const PlanHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What an event may carry of a plan's text, in UTF-16 units (C60, C61): no length of fat-g's, but
 * the 4 MiB a session's line carries at most, which no text in one line can pass.
 */
export const MAX_PLAN_TEXT = 4 * 1024 * 1024;
/** What one push carries of a plan being written, in UTF-16 units (C60): more is sent as several. */
export const MAX_PLAN_PUSH = 64 * 1024;
/** What one read gives of a version's text, in UTF-16 units (C60). */
export const MAX_PLAN_READ = 1024 * 1024;
/** A version the tab draws whole; a longer one is drawn section by section, those near the view alone (C60). */
export const PLAN_WHOLE_DRAW = 256 * 1024;
/**
 * A feedback's text, in UTF-16 units: as a message's (`MAX_MESSAGE_TEXT`), since it is sent as a
 * prompt (the maintainer; it was 10,000, as an answer's). Refused past it and never cut:
 * the panel takes a longer paste whole, says how far over it is, and sends nothing until it fits.
 * Written out, not imported: agent-events.ts reads this file.
 */
export const MAX_FEEDBACK_TEXT = 100_000;

// ── A version, as the registry lists it (C16, C59, C63) ───────────────────────────────────────

/** `drafting`: a Codex plan being written (C59). `unfinished`: a draft whose completion never came — kept, never decided. */
export const PLAN_VERSION_STATES = ['drafting', 'complete', 'unfinished'] as const;
export type PlanVersionState = (typeof PLAN_VERSION_STATES)[number];

/** How a version came about (C16): a plan turn, feedback on the version before it, or a review's integration (M22e, C11, C35). */
export const PLAN_CAUSES = ['plan-turn', 'feedback', 'integration'] as const;
export type PlanCause = (typeof PLAN_CAUSES)[number];

/** What a version an integration made names (M22e, C11, C35): its review, the integration, and the findings it took. */
export interface PlanIntegration {
  readonly reviewId: string;
  readonly integrationId: string;
  readonly findings: readonly string[];
}

// ── The plan's line: an interaction's body (C17, C56, C74) ────────────────────────────────────

/**
 * What became of a plan's line (C17, C74). `writing`: a Codex plan being written, no decision yet.
 * `pending`: the decision waits. Then the user's — `feedback`, `executed`, `cancelled` — or, for a
 * decision a request held (C56), `withdrawn` when the CLI took it back and `dropped` when its process
 * was lost or fat-g restarted. `unfinished`: the version was never completed (C59), and is no decision.
 *
 * Since a plan's workflow is shared by its chats (decision 0029), a line is history, and four more
 * outcomes say why one closed without its own chat's decision: `superseded` by a newer version,
 * decided `elsewhere`, `left` by its chat with the plan kept, or `retired` — its request closed so
 * that the chat's mode could change, the decision standing in the chat's panel.
 */
export const PLAN_OUTCOMES = ['writing', 'pending', 'feedback', 'executed', 'cancelled', 'withdrawn', 'dropped', 'unfinished', 'superseded', 'elsewhere', 'left', 'retired'] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

/** Made by a turn of this chat, or brought into it from the project's registry (C64). */
export const PLAN_ORIGINS = ['made', 'brought'] as const;
export type PlanOrigin = (typeof PLAN_ORIGINS)[number];

/**
 * The decisions (C11, C15, C65): feedback, Execute, Discard — `cancel`, which discards the plan in
 * every chat — and Leave plan mode, keep plan, which takes one chat out and keeps it for the others.
 */
export const PLAN_DECISIONS = ['feedback', 'execute', 'cancel', 'leave'] as const;
export type PlanDecision = (typeof PLAN_DECISIONS)[number];

/** What a decision makes of the line's outcome. */
export const DECISION_OUTCOMES = { feedback: 'feedback', execute: 'executed', cancel: 'cancelled', leave: 'left' } as const satisfies Record<PlanDecision, PlanOutcome>;

/** Nothing more can become of a line: every outcome but `writing` and `pending`. */
export const isPlanSettled = (outcome: PlanOutcome): boolean => outcome !== 'writing' && outcome !== 'pending';

/** The line's decision in fat-g's words (C23), or null while none is taken. */
export const PLAN_OUTCOME_WORDS: Readonly<Record<PlanOutcome, string | null>> = {
  writing: null,
  pending: null,
  feedback: 'Feedback sent',
  executed: 'Executed',
  cancelled: 'Discarded',
  withdrawn: 'Withdrawn: work continued without a decision',
  dropped: 'Not decided: the session’s process ended',
  unfinished: 'Unfinished: fat-g did not receive the rest of this plan',
  superseded: 'Superseded by a newer version',
  elsewhere: 'Decided in another chat',
  left: 'Left plan mode; the plan was kept',
  retired: 'Request closed for a change of mode; the decision stays open',
};

// ── A prompt's plan fields (C19, C69, C71) ────────────────────────────────────────────────────

/**
 * What a prompt fat-g composes for a plan does with it: plan its next version, carry it out, or read
 * it for a review (M22e, C53), which plans nothing and carries nothing out.
 */
export const PLAN_INTENTS = ['revise', 'execute', 'review'] as const;
export type PlanIntent = (typeof PLAN_INTENTS)[number];

/** Kept on the prompt's item (C69): which plan and which version it names, and what for. */
export interface PlanFields {
  readonly planId: string;
  readonly version: number;
  readonly intent: PlanIntent;
}

export const PlanFieldsSchema = z.strictObject({ planId: PlanIdSchema, version: PlanVersionSchema, intent: z.enum(PLAN_INTENTS) });

export function readPlanFields(value: unknown): PlanFields | null {
  const parsed = PlanFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── The block a plan's prompt carries (C68, C69) ──────────────────────────────────────────────

/** A block's token: twelve hex digits, drawn for each prompt. */
const TOKEN = /^[0-9a-f]{12}$/;
const OPENING = /^<fat-g-plan id="([a-z0-9-]{1,64})" version="([1-9][0-9]{0,5})" token="([0-9a-f]{12})">$/m;

const opening = (planId: string, version: number, token: string): string => `<fat-g-plan id="${planId}" version="${version}" token="${token}">`;
const closing = (token: string): string => `</fat-g-plan token="${token}">`;

/**
 * A token no line of the text can hold (C68): drawn from `draw` until the text names none of it, so
 * that nothing of a plan can close its block.
 */
export function planToken(text: string, draw: () => string): string {
  for (;;) {
    const token = draw();
    if (!TOKEN.test(token)) throw new TypeError('a token is twelve hex digits');
    if (!text.includes(`token="${token}"`)) return token;
  }
}

/** The block: fat-g's opening line, the version's text (empty in the plan's own chat), its closing line. */
export function planBlock(planId: string, version: number, text: string, token: string): string {
  if (!TOKEN.test(token) || text.includes(`token="${token}"`)) throw new TypeError('the token is not the text’s own');
  return text === '' ? `${opening(planId, version, token)}\n${closing(token)}` : `${opening(planId, version, token)}\n${text}\n${closing(token)}`;
}

export interface ReadBlock {
  readonly before: string;
  readonly planId: string;
  readonly version: number;
  readonly text: string;
  readonly after: string;
}

/**
 * The first block of fat-g's a prompt holds, or null (C69): its opening line, matched to the first
 * closing line after it that names the same token. What stands before and after it, without the
 * line breaks that join them, and the text between.
 */
export function readPlanBlock(prompt: string): ReadBlock | null {
  const open = OPENING.exec(prompt);
  if (open === null) return null;
  const [line, planId, number, token] = open as unknown as [string, string, string, string];
  const start = open.index;
  const bodyAt = start + line.length;
  const shut = closing(token);
  // Empty: the closing line follows at once; else the text runs to the line break before it.
  let textEnd: number;
  let closeAt: number;
  if (prompt.startsWith(`\n${shut}`, bodyAt)) { textEnd = bodyAt; closeAt = bodyAt + 1; } else {
    const found = prompt.indexOf(`\n${shut}`, bodyAt + 1);
    if (found === -1 || prompt[bodyAt] !== '\n') return null;
    textEnd = found;
    closeAt = found + 1;
  }
  const end = closeAt + shut.length;
  if (end < prompt.length && prompt[end] !== '\n') return null;
  const text = textEnd === bodyAt ? '' : prompt.slice(bodyAt + 1, textEnd);
  return { before: prompt.slice(0, start).replace(/\n+$/, ''), planId, version: Number(number), text, after: prompt.slice(end).replace(/^\n+/, '') };
}

/**
 * The fields a prompt fat-g composed for a plan names, read back from its block (C69): for a
 * provider's history, which keeps a prompt as it was sent. Its intent is Execute's where the words
 * before the block are one of fat-g's two for it, a review's where they open as a review's
 * instruction does (M22e, C53), and a revision's otherwise. A prompt `cut` short
 * may have lost its closing line: its opening line alone names the plan then.
 */
export function readPlanPrompt(prompt: string, cut = false): PlanFields | null {
  const block = readPlanBlock(prompt);
  const open = block === null && cut ? OPENING.exec(prompt) : null;
  if (block === null && open === null) return null;
  const planId = block?.planId ?? open?.[1] ?? '';
  const version = block?.version ?? Number(open?.[2]);
  const before = block?.before ?? prompt.slice(0, open?.index ?? 0).replace(/\n+$/, '');
  const intent: PlanIntent = before === PLAN_WORDS.execute || before === PLAN_WORDS.broughtExecute ? 'execute' : before.startsWith(PLAN_WORDS.reviewOpening) ? 'review' : 'revise';
  return readPlanFields({ planId, version, intent });
}

/** A feedback prompt's first sentence: its identity is independent of the revision instructions. */
const FEEDBACK_OPENING = "Here is the user's feedback on the plan.";

/** fat-g's fixed words for the prompts it composes (C15, C65). */
export const PLAN_WORDS = {
  /** Execute in the plan's own chat, whose session holds the plan already (C15). */
  execute: 'Implement the plan you proposed.',
  /** Execute of a plan brought into the chat, whose block holds the version's whole text (C65). */
  broughtExecute: 'Implement the plan in the block below.',
  /** Feedback on a brought plan, before its block and the user's own text (C65). */
  broughtFeedback: 'Revise the plan in the block below with the feedback after it, then propose the revised plan.',
  /** The first sentence of a review's instruction (M22e, C3): what a prompt read back from a history is known as a review's by. */
  reviewOpening: 'Review the plan in the block below before anyone implements it.',
  /**
   * fat-g's request before the user's feedback on a plan (the maintainer): a word that
   * the feedback was taken, followed by the revised plan and a summary in the chat.
   */
  feedback: `${FEEDBACK_OPENING} First, acknowledge the specific feedback in a sentence or two and say what you will investigate or change. Investigate the feedback and revise the plan, then propose the complete revised plan. After the revised plan, briefly summarize which feedback you integrated, what changed and why, and anything you did not incorporate and why. If proposing the plan pauses for the user's decision, give that summary immediately before proposing it. Keep the acknowledgement and summary in the chat, outside the plan text.`,
} as const;

/** The user's feedback on a plan as fat-g sends it: its request, then the user's own words. */
export const planFeedback = (text: string): string => `${PLAN_WORDS.feedback}\n\n${text}`;

/** The user's own words of a feedback fat-g sent with its request; null for a text that is not one. */
export function feedbackOf(text: string): string | null {
  if (!text.startsWith(FEEDBACK_OPENING)) return null;
  const end = text.indexOf('\n\n');
  return end < 0 ? null : text.slice(end + 2);
}

/** What a prompt for a decision is made of (C15, C65, C68): the words, the block, and the user's feedback where there is one. */
export interface PlanPromptParts {
  readonly decision: 'feedback' | 'execute';
  readonly planId: string;
  readonly version: number;
  /** The version's whole text for a brought plan; null in the plan's own chat, whose block is empty. */
  readonly text: string | null;
  /** The user's feedback, for a feedback. */
  readonly feedback: string | null;
  readonly token: string;
}

/** The prompt itself (C15, C65, C68): what is sent, and kept in the chat as it was sent (C69). */
export function planPrompt(parts: PlanPromptParts): string {
  const block = planBlock(parts.planId, parts.version, parts.text ?? '', parts.token);
  const feedback = parts.feedback ?? '';
  if (parts.decision === 'execute') return `${parts.text === null ? PLAN_WORDS.execute : PLAN_WORDS.broughtExecute}\n\n${block}`;
  return parts.text === null ? `${feedback}\n\n${block}` : `${PLAN_WORDS.broughtFeedback}\n\n${block}\n\n${feedback}`;
}

// ── A plan's title (C19) ──────────────────────────────────────────────────────────────────────

/** A plan with nothing to name it by. */
export const UNTITLED_PLAN = 'Plan';

/**
 * A line's inline Markdown reduced to its words, for a title drawn as plain text (the maintainer's
 * acceptance): a code span's text without its backticks, emphasis, strong and struck
 * text without their marks, a link's or an image's words without its brackets and address, and an
 * escaped character as itself. A mark inside a word, as in snake_case or 2*3*4, is no mark.
 */
function plainInline(line: string): string {
  // An escaped character is held aside first, as a private-use character, so that no mark is read in it.
  return line
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|])/gu, (_, mark: string) => String.fromCharCode(HELD + mark.charCodeAt(0)))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/(`+)(.+?)\1/gu, '$2')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)(.+?)(?<=\S)\*(?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}])/gu, '$1$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/gu, '$1')
    .replace(/[\uE000-\uE07F]/gu, (held) => String.fromCharCode(held.charCodeAt(0) - HELD));
}

/** Where an escaped character is held while the marks are read: the first of the private-use characters. */
const HELD = 0xe000;

/**
 * The text's first Markdown heading, else the prompt's first line that holds anything: its words
 * without Markdown's marks, normalized as every name is (0011). One left with no letter or digit,
 * a heading of marks alone, is passed over.
 */
/**
 * A plan as its buttons, its tab and the chats named after it say it (M22e): "Plan: <title>", but the
 * title alone where it begins with the word already — a heading "# Plan: …", or the untitled "Plan" —
 * so that no name reads "Plan: Plan: …" (the maintainer).
 */
export const planNamed = (title: string): string => (/^plan\b/iu.test(title) ? title : `Plan: ${title}`);

/**
 * The name of a chat that had none when a plan was brought into it (decision 0029; the maintainer),
 * as the plan's own buttons say it: normalized and cut as every name is, by the records' write.
 */
export const planChatName = (title: string): string => planNamed(title);

export function planTitle(text: string, prompt: string | null): string {
  const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1];
  for (const candidate of [heading, prompt?.split(/\r?\n/).find((line) => line.trim() !== '')]) {
    const name = candidate === undefined ? '' : normalizeName(plainInline(candidate));
    if (/[\p{L}\p{N}]/u.test(name)) return name;
  }
  return UNTITLED_PLAN;
}

// ── The capability (C2, C5, C13, C70) ─────────────────────────────────────────────────────────

/**
 * What a provider's descriptor says of its plan turns (C2, C5): the ids of its modes a plan turn may
 * start from — each adapter's constant of the modes a capture shows one under — and the one line,
 * in the provider's words, that says why the others take none.
 */
export interface PlanCapability {
  readonly modes: readonly string[];
  readonly unavailable: string;
}

/** Whether an account's CLI takes a plan turn now (C13, C80): `cli-refuses` where it refused what a plan turn needs. */
export type PlanAvailability = { readonly available: true } | { readonly available: false; readonly reason: 'cli-refuses' };

export const PLANS_AVAILABLE: PlanAvailability = Object.freeze({ available: true });

/** fat-g's words for a refusal of plan turns by the account's CLI (C13). */
export function planRefusedWords(provider: string): string {
  return `This version of ${provider} refused plan mode, so planning is unavailable in this chat.`;
}

/** Whether a chat may start a plan turn (C5, C13, C70), and if not, why in words: null where it may. */
export function planTurnBlocked(capability: PlanCapability | null | undefined, mode: string | null, availability: PlanAvailability | undefined, provider: string): string | null {
  if (capability === null || capability === undefined) return `${provider} does not support planning in fat-g.`;
  if (availability !== undefined && !availability.available) return planRefusedWords(provider);
  if (mode === null || !capability.modes.includes(mode)) return capability.unavailable;
  return null;
}

// ── The registry and the reads (C20, C60, C63, C75) ───────────────────────────────────────────

/** A version as a read lists it. `chat`: the session that produced it, its name where it is listed, null once it is removed. */
export interface PlanVersionView {
  readonly version: number;
  readonly state: PlanVersionState;
  readonly at: number;
  readonly cause: PlanCause;
  /** The version a feedback revised. */
  readonly revises: number | null;
  readonly providerId: string;
  readonly model: string;
  readonly sessionId: string;
  readonly chat: string | null;
  /** UTF-16 units and the hash: a complete version's, and an unfinished one's of what it received. */
  readonly length: number;
  readonly hash: string;
  /** The review and the findings it integrated, for a version an integration made (M22e, C11). */
  readonly integration: PlanIntegration | null;
}

/** A plan in its project's list (C63, C64, C67), by its latest complete version; one with none is listed with its latest. */
export interface PlanSummary {
  readonly planId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly versions: number;
  readonly latest: PlanVersionView;
  /** The latest complete version, which Review existing plan brings; null for a plan with none. */
  readonly complete: PlanVersionView | null;
  /** Where its workflow stands, and how many chats take part in it. */
  readonly state: WorkflowState;
  readonly participants: number;
}

/** A read of a plan (C20, C60): its versions, and a range of one version's text. */
export interface PlanRead {
  readonly status: 'read';
  readonly planId: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly versions: readonly PlanVersionView[];
  /** The workflow its chats share. */
  readonly workflow: WorkflowView;
  /** The version read, its whole length and hash, and the range given. */
  readonly version: number;
  readonly length: number;
  readonly hash: string;
  readonly start: number;
  readonly text: string;
}

/** The Storage tab's row (C21, C75): every plan fat-g holds, its size on disk, and those whose project is no longer listed. */
export interface PlansStorage {
  readonly count: number;
  /** The reviews those plans hold that can be read (M22e, C6): their size is in `bytes` already. */
  readonly reviews: number;
  readonly bytes: number;
  readonly orphans: number;
}

/**
 * A plan being written, or a plan's line that changed (C25, C60): the plans' one push. `partial`:
 * more text of a version being written — how long it was before, in UTF-16 units, and what to
 * append. Without it, the plan changed — a version arrived, completed or ended — and is read again.
 */
export interface PlanPush {
  readonly planId: string;
  readonly version: number;
  readonly state: PlanVersionState;
  readonly partial?: { readonly before: number; readonly append: string };
}

const sessionId = z.guid();
const projectId = z.string().min(1).max(128).refine((value) => !/\p{Cc}/u.test(value), 'control character');

export const PlanReadRequestSchema = z.strictObject({ planId: PlanIdSchema, version: PlanVersionSchema.optional(), start: z.number().int().min(0).max(MAX_PLAN_TEXT * 64), length: z.number().int().min(1).max(MAX_PLAN_READ) });
export const PlanListRequestSchema = z.strictObject({ projectId });
export const PlanRemoveRequestSchema = z.union([z.strictObject({ planId: PlanIdSchema }), z.strictObject({ all: z.literal(true) })]);
/** A decision names the plan and the workflow's revision the page drew it from: one drawn from an older state sends nothing. */
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PlanDecideRequestSchema = z.union([
  z.strictObject({ sessionId, planId: PlanIdSchema, revision, decision: z.literal('feedback'), text: z.string().min(1).max(MAX_FEEDBACK_TEXT).refine((value) => value.trim() !== '', 'only whitespace') }),
  z.strictObject({ sessionId, planId: PlanIdSchema, revision, decision: z.enum(['execute', 'cancel', 'leave']) }),
]);
export const PlanBringRequestSchema = z.strictObject({ sessionId, planId: PlanIdSchema, version: PlanVersionSchema, hash: PlanHashSchema });
export type PlanReadRequest = z.infer<typeof PlanReadRequestSchema>;
export type PlanListRequest = z.infer<typeof PlanListRequestSchema>;
export type PlanRemoveRequest = z.infer<typeof PlanRemoveRequestSchema>;
export type PlanDecideRequest = z.infer<typeof PlanDecideRequestSchema>;
export type PlanBringRequest = z.infer<typeof PlanBringRequestSchema>;

/** Why a read was not answered. */
export const PLAN_READ_REFUSALS = ['unknown-plan', 'unknown-version', 'storage-failed'] as const;
/** Why a removal was not made (C18, C62, C73). */
export const PLAN_REMOVE_REFUSALS = [
  'unknown-plan',
  /** A version of it is being written: it is removed once that ends (C62). */
  'writing',
  /** The removal settles decisions in chats, which are not touched while the stores cannot be read. */
  'conversations-refused',
  'records-refused',
  'storage-failed',
  /** fat-g is quitting. */
  'busy',
] as const;
/**
 * Why a decision was not taken (C12, C72), besides the send's own for a decision that starts a turn.
 * `not-pending`: the line's decision is not the user's to take now — taken, withdrawn, dropped, still
 * being written, unfinished, its plan removed, or its request gone (C12, C73, C74).
 */
/**
 * `reads-only`: Execute under the provider's reading mode, which can carry out nothing (C81).
 * `unknown-plan`: removed. `not-participant`: the chat takes no part in the plan. `stale`: the
 * workflow changed since the page drew it — another chat's decision came first. `locked`: a review,
 * a revision, an implementation or a discard holds the plan.
 */
export const PLAN_DECIDE_REFUSALS = ['unknown-session', 'unknown-item', 'unknown-plan', 'not-participant', 'stale', 'locked', 'not-pending', 'plans-unavailable', 'reads-only', 'busy', 'changing-mode', 'setting-up', 'storage-failed'] as const;
/** Why a plan was not brought into a chat (C64), besides the send's own: a chat that cannot take a prompt takes no plan. */
export const PLAN_BRING_REFUSALS = [
  'unknown-session',
  'unknown-plan',
  /** The plan is another project's. */
  'other-project',
  /** The version is not complete, or is gone. */
  'not-complete',
  /** The version's hash is not the one the list showed. */
  'stale',
  /** A plan's decision waits in the chat already (C56). */
  'plan-pending',
  'storage-failed',
] as const;
export type PlanReadRefusal = (typeof PLAN_READ_REFUSALS)[number];
export type PlanRemoveRefusal = (typeof PLAN_REMOVE_REFUSALS)[number];
export type PlanDecideRefusal = (typeof PLAN_DECIDE_REFUSALS)[number];
export type PlanBringRefusal = (typeof PLAN_BRING_REFUSALS)[number];

type Refused<Reason extends string> = { readonly status: 'refused'; readonly reason: Reason };
export type PlanReadResult = PlanRead | Refused<PlanReadRefusal>;
export type PlanListResult = { readonly status: 'listed'; readonly plans: readonly PlanSummary[] };
/** `removed`: how many plans went; `settled`: how many decisions waiting on them were cancelled first (C73). */
export type PlanRemoveResult = { readonly status: 'removed'; readonly removed: number; readonly settled: number } | Refused<PlanRemoveRefusal>;
/** A decision that starts a turn meets the send's own refusals too (C15, C65). */
export type PlanDecideResult = { readonly status: 'decided' } | (Refused<PlanDecideRefusal | SendRefusal | SendBlock> & { readonly workflow?: WorkflowView });
/** `itemId`: the plan’s line in the chat. A chat that cannot take a prompt takes no plan (C64). */
export type PlanBringResult = { readonly status: 'brought'; readonly itemId: string } | Refused<PlanBringRefusal | SendRefusal | SendBlock>;
