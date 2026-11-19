// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for an approval's card that the contract does not hold (docs/planning/_archive/M22.md, Design
// 10; C9, C13, C14, C48, C56, C92): the head of a settled card, the names of the card's parts and of
// its controls, an edit's scope as a line, a change's title, and what the card says of a decision
// it could not send. An outcome's words, a choice's, an authority's and who asks are the
// contract's (`approvalWords`, `APPROVAL_WORDS`, `authorityWords`, `askWords`), which main's tests
// share. None of it is the request's own text: that is the conversation's, and is drawn as it came.
//
// Provider-neutral: a provider is named by the display name it is given, and a mode by the label
// its provider's descriptor declares.
import type { DecideRefusal } from '@shared/contracts/chat';
import { type ApprovalBody, type ApprovalChange, type ApprovalKind, APPROVAL_WORDS, askWords, grantSent } from '@shared/contracts/interaction';
import { MODE_WORDS } from '@shared/contracts/permissions';
import { CHANGE_WORDS } from './activity-words';
import { CHANGING_MODE_TEXT } from './card-words';

/** What a request asked leave for, once it asks no more: the contract's words for it, in the past. */
const ASKED: Readonly<Record<ApprovalKind, string>> = { command: 'run a command', 'file-change': 'change a file', tool: 'use a tool' };

/** The card's head line (C14): who asks, and for what. A request that is settled asks no more. */
export function approvalHead(kind: ApprovalKind, who: string, waiting: boolean): string {
  return waiting ? askWords(kind, who) : `${who} asked to ${ASKED[kind]}`;
}

/** The names of a card's parts, and of its controls (C9, C14, C48). */
export const APPROVAL_LABELS = {
  /** The account a card belongs to, where its provider runs more than one (C14). */
  account: (label: string): string => `Account: ${label}`,
  /** The working folder a request names. */
  folder: 'In folder:',
  /** The CLI said a path the action names is outside the folders the session was given (C9). */
  outside: `Reaches ${APPROVAL_WORDS.outside}`,
  /** The list of the paths an action names. */
  targets: 'Paths',
  command: 'Command',
  input: 'Input',
  copyCommand: 'Copy command',
  copyInput: 'Copy input',
  copyChange: 'Copy change',
  /** The disclosure, by name: what it shows and hides. */
  show: `Show ${APPROVAL_WORDS.detail.toLowerCase()}`,
  hide: `Hide ${APPROVAL_WORDS.detail.toLowerCase()}`,
  /** A change that names a file and holds no text: a deletion, or a kind fat-g was given nothing of. */
  noText: 'No text was given for this change.',
} as const;

/** An edit by match, said beside the action and not behind its disclosure (C9): two edits of opposite scope never read alike. */
export function scopeWords(all: boolean): string {
  return all ? `Replaces ${APPROVAL_WORDS.everyMatch}` : `Replaces ${APPROVAL_WORDS.firstMatch}`;
}

/** A change's title in the detail (C9): its path and its kind, and for an edit by match which of its two texts this is, the scope with the first. */
export function changeTitle(change: Pick<ApprovalChange, 'path' | 'kind' | 'all'>, part: 'whole' | 'old' | 'new'): string {
  const base = `${change.path} — ${CHANGE_WORDS[change.kind]}`;
  const scope = change.all === null ? null : change.all ? APPROVAL_WORDS.everyMatch : APPROVAL_WORDS.firstMatch;
  if (part === 'new') return `${base}: with`;
  if (part === 'old') return `${base}: replaces ${scope ?? 'this text'}`;
  return scope === null ? base : `${base}, ${scope}`;
}

/**
 * What a settled card says of the grant its decision sent (C56, C57, C92), or null: only for a
 * grant whose reply was delivered — what it covers, and that it ended once its process has. One
 * that was not delivered is said by the outcome's own words, and claims no grant.
 */
export function grantWords(body: Pick<ApprovalBody, 'grant' | 'delivered' | 'outcome'>): string | null {
  if (!grantSent(body) || body.grant === null) return null;
  const covers = APPROVAL_WORDS.covers(body.grant.covers);
  return body.grant.live ? covers : `${covers}; ${APPROVAL_WORDS.grantEnded}`;
}

export const DECIDE_FAILED_TEXT = 'fat-g could not send your decision.';
export const STOP_FAILED_TEXT = 'fat-g could not stop the session.';

/**
 * Why a decision was not taken, in fat-g's words; null for a stale press (M21, C71), which says
 * nothing by itself: the item's push, which main sends at every outcome, brings the card's state.
 */
export function decideRefusalText(reason: DecideRefusal, provider: string): string | null {
  switch (reason) {
    case 'not-pending': return null;
    case 'unknown-session': return 'This session is no longer listed.';
    case 'unknown-item': return 'This request is no longer part of the conversation.';
    case 'not-offered': return 'This request does not offer that choice, so nothing was sent.';
    case 'changing-mode': return CHANGING_MODE_TEXT;
    case 'setting-up': return `${MODE_WORDS.settingUp(provider)} Decide again once it has ended.`;
    case 'busy': return 'This session is being removed, or fat-g is closing, so nothing was sent.';
    case 'storage-failed': return 'fat-g could not save your decision, so nothing was sent. Try again.';
  }
}
