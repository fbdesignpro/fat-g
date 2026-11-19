// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a chat session sends and answers (decisions 0020, 0025, 0026, 0027; docs/planning/_archive/M16.md,
// Design 1; C7–C9; M20b.md, Design 3; C13, C15; M21.md, Design 3; C17; M22.md, Design 5, 6; C5, C13,
// C21, C22, C68, C69): two closed unions and their encoders, and the only writer to a chat session's
// process. A chat session can send these ten things and answer these six; a subtype is never a
// string a caller passes, so a login, a change of model and every MCP request have no spelling here.
// The usage and models-only sessions keep their own client and its two subtypes (control-client.ts,
// decision 0006).
//
// Two answers say `allow`. One is the answer to a question the model asked the user (M21, C17), for
// the one tool that asks and for no other name: it grants no action. The other is the user's leave
// for one action (M22, C13): the request's own input, sent back as it came. With it may go the one
// thing that outlives the request — the CLI's own offer of a rule, at the session's scope and no
// other (C21, C69). Nothing here can name another scope, a mode, a folder or a rule the CLI would
// save (C22): the update is written field by field, and never copied from what the CLI offered.
//
// The seventh send changes the permission mode of the live process (M22, C5), and names one of the
// three words such a change may (chat-modes.ts, C74), the plan word, or — setting a plan turn's mode
// back, and only then — the word the process was launched under (M22b, C7, C51), or is never written.
//
// Two answers decide a plan (M22b, C11): its feedback, a refusal of the plan's request in the user's
// own words, after which the model revises it; and Cancel, a refusal with fat-g's words that ends the
// turn. Execute is the user's leave, an `allow` of the request as it came, with no update.
//
// The eighth send is a message written while a turn runs (M23, C36, C43): the same user frame as a
// prompt's, by the same content encoder, under the id fat-g made for that message. It is no control
// request, and no eighth subtype: the session tells the two apart so that neither bypasses the
// checks of the other. An interrupt may ask the CLI to drop the messages it still holds
// (`cancel_queued`), and names nothing else.
//
// The ninth send asks for fast mode, or for standard speed (decision 0020): the same
// `apply_flag_settings` as the effort's, with `fastMode` alone. It holds for the process, and no
// settings file changes; a new process runs at standard speed until it is sent.
//
// The tenth asks how full the conversation's context window is (decision 0033): `get_context_usage`
// with `detail: 'summary'`, which the CLI answers from its last response's usage and its own
// estimates, with no token-count call of its own. Nothing else of the request is ever written.
//
// Protocol only: it knows nothing of turns. Who waits for a reply, and for how long, is the
// session's.
import type { ManagedProcess } from '@shared/provider-kit/process';
import { mayName } from './chat-modes';

/** An image of a prompt (M23, C21): its type and its bytes, which the frame carries as base64 and nothing keeps after the write. */
export interface PromptImage {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * A user frame's content (M23, C21; K2): the text alone, as a prompt always was, or — with images — an
 * array of the text block, where there is text, and one base64 image block per image, in their order.
 */
export function userContent(text: string, images: readonly PromptImage[] = []): unknown {
  if (images.length === 0) return text;
  return [
    ...(text === '' ? [] : [{ type: 'text', text }]),
    ...images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64') } })),
  ];
}

/** One earlier exchange of a side question, as the request's `history` carries it (M20b, C13). */
export interface SideExchange {
  readonly question: string;
  readonly response: string;
}

/** What a chat session sends: these ten, and nothing else (C7; M20b, C13, C15; M22, C5; M23, C36; decisions 0020, 0033). */
export type ChatSend =
  | { readonly kind: 'initialize' }
  /** One prompt as one text, under the id fat-g made for the user's message (C31), with its images where it has any (M23, C21). */
  | { readonly kind: 'prompt'; readonly id: string; readonly text: string; readonly images?: readonly PromptImage[] }
  /** A message written while a turn runs (M23, C36, C42): a prompt's frame, under the message's own id. */
  | { readonly kind: 'steer'; readonly id: string; readonly text: string; readonly images?: readonly PromptImage[] }
  /** `cancelQueued` (M23, C43): the messages the CLI still holds are dropped with the turn, never run after it. */
  | { readonly kind: 'interrupt'; readonly cancelQueued?: boolean }
  /** `effortLevel` alone: it holds for the process, and no settings file changes (C23). */
  | { readonly kind: 'effort'; readonly level: string }
  /** `fastMode` alone (decision 0020): Claude's fast tier on, or standard speed. It holds for the process, and no settings file changes. */
  | { readonly kind: 'fast'; readonly on: boolean }
  /**
   * A question beside the conversation (M20b, C13): its text, and the aside's earlier exchanges,
   * which the CLI keeps none of. It names no model, takes no tool and runs no hook of the user's.
   */
  | { readonly kind: 'side-question'; readonly question: string; readonly history: readonly SideExchange[] }
  /** Takes back a request that waits for its reply, by that request's own id (M20b, C15): a side question's Stop. */
  | { readonly kind: 'cancel'; readonly requestId: string }
  /**
   * The permission mode of the live process, with no turn running (M22, C5, C74): `mode` is the
   * CLI's word for one of the three a change may name, from the mode table. It holds for the
   * process, and no settings file changes.
   */
  | { readonly kind: 'set-mode'; readonly mode: string; readonly restoring?: boolean }
  /** How full the context window is (decision 0033): the summary's detail, which needs no call of the CLI's own. */
  | { readonly kind: 'context' };

/** A question request's `input`, as it came (M21, C17, C59): sent back whole, with the answers beside what it held. */
export type QuestionInput = Readonly<Record<string, unknown>>;

/** An action request's `input`, as it came (M22, C13): sent back whole, and changed by nothing. */
export type ActionInput = Readonly<Record<string, unknown>>;

/**
 * The CLI's own session grant (M22, C21, C69): a rule it offered for a request, to be sent back
 * with that request's `allow`. Its `rules` are the CLI's, as it wrote them; its scope is the
 * session's, whatever scope the offer named, so it lasts for the process and is written nowhere.
 */
export interface SessionGrant {
  readonly type: 'addRules';
  readonly rules: readonly unknown[];
  readonly behavior: 'allow';
  readonly destination: 'session';
}

/** What it answers the CLI: these six (C9; M21, C17; M22, C13; M22b, C9, C11). */
export type ChatAnswer =
  /**
   * `by`: the user's own Deny (M22, C13), or the user's Skip of a question (M100b, C31), which
   * declines the question tool's request in words of its own. Left out, the refusal is fat-g's: an
   * action no session of its kind takes.
   */
  | { readonly kind: 'deny'; readonly requestId: string; readonly by?: 'user' | 'user-skipped' | 'no-plan' }
  | { readonly kind: 'unsupported'; readonly requestId: string }
  /**
   * The user's answer to a question the model asked (M21, C17): an `allow` for the tool that asks
   * the user and for no other name. `input` is the request's own, as it came; `answers` gives
   * each question's whole text its answer, one string a question (C18).
   */
  | { readonly kind: 'allow-question'; readonly requestId: string; readonly tool: 'AskUserQuestion'; readonly input: QuestionInput; readonly answers: Readonly<Record<string, string>> }
  /**
   * The user's leave for one action (M22, C13, C21): an `allow` for the tool the request named —
   * never the one that asks the user, whose `allow` is its answer — with the request's `input` as
   * it came. `grant`: the CLI's own rule for the session, where the user chose it (C69); null for
   * leave given once.
   */
  | { readonly kind: 'allow-action'; readonly requestId: string; readonly tool: string; readonly input: ActionInput; readonly grant: SessionGrant | null }
  /** A plan's feedback (M22b, C11): its request refused in the user's own words, which the model revises the plan from. */
  | { readonly kind: 'plan-feedback'; readonly requestId: string; readonly text: string }
  /** A plan's Cancel (M22b, C11): its request refused in fat-g's words, and the turn interrupted. */
  | { readonly kind: 'plan-cancel'; readonly requestId: string };

/** fat-g's words to a tool request it declines (C9, C22): they name no tool and no path. */
export const DENY_MESSAGE = 'This action is not available in this session.';
/** Its words to one the user denied on its card (M22, C13): the model is told who said no. */
export const USER_DENY_MESSAGE = 'The user denied this action in fat-g';
/** Its words to a question the user skipped (M100b, C31): K1 saw them come back as the tool's result, and the turn go on. */
export const USER_DECLINE_MESSAGE = 'The user declined to answer in fat-g';
/** Its words to a plan's request that carried no plan (M22b, C9). */
export const PLAN_MISSING_MESSAGE = 'No plan reached fat-g: write the plan to its file before calling ExitPlanMode.';
/** Its words to a plan the user cancelled (M22b, C11). */
export const PLAN_CANCEL_MESSAGE = 'The user cancelled this plan in fat-g.';
/** The four a `deny` can say, and no other: fat-g's refusal first. A plan's feedback says the user's own words, and its Cancel fat-g's above. */
export const DENY_MESSAGES = [DENY_MESSAGE, USER_DENY_MESSAGE, USER_DECLINE_MESSAGE, PLAN_MISSING_MESSAGE] as const;

export const CHAT_WIRE_LIMITS = {
  /** Longest request id fat-g echoes back when it answers the CLI: a longer one is counted, and not answered. */
  requestIdChars: 128,
} as const;

/**
 * The frame of one send. `requestId` names a control request; a prompt carries its own id and no other.
 * `launch`: the CLI's word for the mode the process was launched under, which a plan turn's
 * restoration alone may name (M22b, C7, C51).
 */
export function encodeSend(send: ChatSend, requestId: string, launch: string | null = null): unknown {
  switch (send.kind) {
    // Nothing in it (C8): no system prompt, no hook and no MCP server of fat-g's.
    case 'initialize': return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } };
    // A prompt and a message sent now: the same frame, by the same encoder (M23, C36); what tells the two apart is the session's.
    case 'prompt':
    case 'steer': return { type: 'user', uuid: send.id, message: { role: 'user', content: userContent(send.text, send.images) }, parent_tool_use_id: null, session_id: '' };
    case 'interrupt': return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt', ...(send.cancelQueued === true ? { cancel_queued: true } : {}) } };
    case 'effort': return { type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings: { effortLevel: send.level } } };
    case 'fast': return { type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings: { fastMode: send.on } } };
    // `history` only where there is one, as K1 sent it; each pair is its two texts and nothing else.
    case 'side-question': return { type: 'control_request', request_id: requestId, request: { subtype: 'side_question', question: send.question, ...(send.history.length === 0 ? {} : { history: send.history.map((pair) => ({ question: pair.question, response: pair.response })) }) } };
    // It carries the id of the request it takes back, and none of its own.
    case 'cancel': return { type: 'control_cancel_request', request_id: send.requestId };
    case 'set-mode':
      // One of the three words a change may name, or the plan's, or nothing is written (M22, C74; M22b,
      // C7): the word that bypasses permissions only out of plan mode, on the process launched with it.
      if (!mayName(send.mode, launch, send.restoring === true)) throw new TypeError('no change names this mode');
      return { type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode: send.mode } };
    // The summary alone: the full detail counts each part with the token-count API.
    case 'context': return { type: 'control_request', request_id: requestId, request: { subtype: 'get_context_usage', detail: 'summary' } };
    default: throw new TypeError('not one of the ten sends');
  }
}

/** The frame of one answer. */
export function encodeAnswer(answer: ChatAnswer): unknown {
  switch (answer.kind) {
    case 'deny': return { type: 'control_response', response: { subtype: 'success', request_id: answer.requestId, response: { behavior: 'deny', message: answer.by === 'user' ? USER_DENY_MESSAGE : answer.by === 'user-skipped' ? USER_DECLINE_MESSAGE : answer.by === 'no-plan' ? PLAN_MISSING_MESSAGE : DENY_MESSAGE } } };
    // The user's words, as the feedback field gave them (M22b, C11): the one deny whose message is theirs beside a question's.
    case 'plan-feedback': return { type: 'control_response', response: { subtype: 'success', request_id: answer.requestId, response: { behavior: 'deny', message: answer.text } } };
    // fat-g's words, and the turn interrupted (M22b, C11): K1 saw it end `error_during_execution`, `aborted_streaming`.
    case 'plan-cancel': return { type: 'control_response', response: { subtype: 'success', request_id: answer.requestId, response: { behavior: 'deny', message: PLAN_CANCEL_MESSAGE, interrupt: true } } };
    // The reply the usage session's client gives every request (control-client.ts).
    case 'unsupported': return { type: 'control_response', response: { subtype: 'error', request_id: answer.requestId, error: 'unsupported' } };
    case 'allow-question':
      // For the tool that asks the user, and for no other name (C17, C29): the type says so, and so does this.
      if (answer.tool !== 'AskUserQuestion') throw new TypeError('no other tool is allowed');
      // The request's input as it came, and the answers by each question's whole text, as K1 sent them.
      return { type: 'control_response', response: { subtype: 'success', request_id: answer.requestId, response: { behavior: 'allow', updatedInput: { ...answer.input, answers: answer.answers } } } };
    case 'allow-action': {
      // A question is answered, with its answers: it is never given leave as an action is (M22, C13).
      if (answer.tool === 'AskUserQuestion') throw new TypeError('a question is answered, never granted');
      const { grant } = answer;
      // The one update there is (C69): the CLI's own rule, to allow, at the session's scope. Anything else is never written.
      if (grant !== null && (grant.type !== 'addRules' || grant.behavior !== 'allow' || grant.destination !== 'session' || !Array.isArray(grant.rules))) throw new TypeError('not a session grant');
      const update = grant === null ? {} : { updatedPermissions: [{ type: 'addRules', rules: grant.rules, behavior: 'allow', destination: 'session' }] };
      // The request's input as it came, as K2 sent it, and that one rule alone beside it.
      return { type: 'control_response', response: { subtype: 'success', request_id: answer.requestId, response: { behavior: 'allow', updatedInput: answer.input, ...update } } };
    }
    default: throw new TypeError('not one of the six answers');
  }
}

// ── The CLI's own offers (M22, C8, C21, C56, C68) ─────────────────────────────────────────────
// A request to act comes with what the CLI would let the user grant beyond it. Each is read here
// for its kind alone, to be said on the card; one kind can be sent back, as the grant above, and
// the others never are.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What one of a request's offers would grant (C8, C68).
 *
 *   grant    a rule that allows: the one a session grant is made of, whatever scope the CLI wrote on
 *            it. `covers` is the rule's text, the CLI's own. `saved`: as offered, it would be kept
 *            beyond the session — which fat-g never sends (C22).
 *   rule     any other offer that holds rules — one that denies, replaces or removes: never a grant.
 *            `saved` as above.
 *   mode     a change of permission mode, by the CLI's word for the mode.
 *   folder   another folder to work in.
 *   other    an offer this build does not know.
 */
export type Offer =
  | { readonly kind: 'grant'; readonly grant: SessionGrant; readonly covers: string; readonly saved: boolean }
  | { readonly kind: 'rule'; readonly saved: boolean }
  | { readonly kind: 'mode'; readonly word: string | null }
  | { readonly kind: 'folder' }
  | { readonly kind: 'other' };

/**
 * A rule's text as the CLI writes one (C56): what it allows of the tool, or the tool's name for a
 * rule that allows all of it. The request's own tool is left unsaid; another's is named before it.
 * Null for rules that cannot be read whole, of which no grant is made.
 */
function ruleText(rules: readonly unknown[], tool: string): string | null {
  const parts: string[] = [];
  for (const rule of rules) {
    if (!isRecord(rule) || typeof rule['toolName'] !== 'string' || rule['toolName'] === '') return null;
    const content = rule['ruleContent'];
    if (content !== undefined && content !== null && typeof content !== 'string') return null;
    const named = rule['toolName'];
    if (typeof content !== 'string' || content === '') parts.push(named);
    else parts.push(named === tool ? content : `${named}(${content})`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

/** One offer, by its kind. `tool`: the tool the request named, for the rule's text. */
export function readOffer(suggestion: unknown, tool: string): Offer {
  if (!isRecord(suggestion)) return { kind: 'other' };
  // Any scope but the session's is one the CLI would keep the offer at.
  const saved = typeof suggestion['destination'] === 'string' && suggestion['destination'] !== 'session';
  switch (suggestion['type']) {
    case 'setMode': return { kind: 'mode', word: typeof suggestion['mode'] === 'string' ? suggestion['mode'] : null };
    case 'addDirectories': return { kind: 'folder' };
    case 'addRules': {
      const rules: unknown = suggestion['rules'];
      const covers = suggestion['behavior'] === 'allow' && Array.isArray(rules) ? ruleText(rules, tool) : null;
      if (covers === null || !Array.isArray(rules)) return { kind: 'rule', saved };
      // The rules as the CLI wrote them, and the session's scope in place of the one it wrote (C69).
      return { kind: 'grant', grant: { type: 'addRules', rules, behavior: 'allow', destination: 'session' }, covers, saved };
    }
    default: return Array.isArray(suggestion['rules']) ? { kind: 'rule', saved } : { kind: 'other' };
  }
}

export interface ChatWire {
  /**
   * Writes one of the ten. `requestId` is the id its control request was given, by which the
   * reply is matched; a prompt has none, and neither has a cancel, which is answered through the
   * request it takes back. `written` settles once the bytes were handed to the process, and rejects
   * with a ProcessFailure when they could not be.
   */
  send(what: ChatSend, signal?: AbortSignal): { readonly requestId: string | null; readonly written: Promise<void> };
  /**
   * Answers one request of the CLI's. The promise is the write's (M21, C14, C66): true once the line
   * was handed to the process, false when the process refused it or had ended — and for an id over
   * the limit, which is never echoed, so nothing was written.
   */
  answer(what: ChatAnswer): Promise<boolean>;
}

/**
 * The one writer to a chat session's process. It takes no output subscription: the session reads.
 * `launch`: the CLI's word for the mode the process was launched under (M22b, C51), which the wire
 * holds for the restoration's check, so that no word read from a frame decides what a change names.
 */
export function createChatWire(child: Pick<ManagedProcess, 'write'>, launch: string | null = null): ChatWire {
  const encoder = new TextEncoder();
  let nextId = 1;
  const line = (frame: unknown): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`);
  return {
    send(what, signal) {
      const requestId = what.kind === 'prompt' || what.kind === 'cancel' ? null : `fatg_${nextId++}`;
      return { requestId, written: child.write(line(encodeSend(what, requestId ?? '', launch)), signal) };
    },
    answer(what) {
      if (what.requestId.length > CHAT_WIRE_LIMITS.requestIdChars) return Promise.resolve(false);
      return child.write(line(encodeAnswer(what))).then(() => true, () => false);
    },
  };
}
