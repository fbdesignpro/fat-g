// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for the mode control and the grants list that the contract does not hold (docs/
// planning/_archive/M22.md, Design 3, 5, 10; C46, C57, C82, C86, C87, C92): the names of the control's parts,
// why a change of mode was not taken, and the grants list's own lines. A mode's label and its
// description are its provider's declaration, the inherited line and the line on the CLI's rules
// are its descriptor's, and every other word said of a mode is the contract's (`MODE_WORDS`,
// `modeReasonWords`, `modeTitle`), which main's tests share.
//
// Provider-neutral: a provider is named by the display name it is given, a mode by its label. No
// mode's id and no provider's word is here.
import { blockWords, CHAT_LINES, SET_MODE_REFUSALS, type SetModeRefusal } from '@shared/contracts/chat';
import { MODE_WORDS, type ModeAvailability, modeReasonWords } from '@shared/contracts/permissions';
import type { SendBlock } from '@shared/contracts/sessions';

/** The names of the mode control's parts (C82). */
export const MODE_LABELS = {
  /** The menu's heading and accessible name. */
  menu: 'Permission Mode',
  tooltip: 'Choose what the agent can do and when it asks for approval.',
  button: (title: string): string => `Mode: ${title}`,
  /** An unavailable mode's own control, which opens the setup's dialog (C60): named by the mode it is for. */
  setUp: `${MODE_WORDS.setUp}…`,
  setUpFor: (label: string): string => `${MODE_WORDS.setUp}… (${label})`,
  /** A mode its account cannot use, where main gave no reason for it. */
  cannotUse: (label: string): string => `This account cannot use ${label}.`,
} as const;

export const SET_MODE_FAILED_TEXT = 'fat-g could not change the mode.';

const isOwn = (reason: SetModeRefusal | SendBlock): reason is SetModeRefusal => (SET_MODE_REFUSALS as readonly string[]).includes(reason);

/**
 * Why a change of mode was not taken, in fat-g's words (C2, C43, C46, C89, C90); null where there is
 * nothing to say — the mode asked for is the chat's already. `asked`: the mode that was asked for,
 * by its label and what its account can do with it, since `mode-unavailable` is said of that one
 * and never of the mode it would replace. `detail`: with `not-confirmed`, what the CLI said instead.
 */
export function setModeRefusalText(reason: SetModeRefusal | SendBlock, provider: string, asked: { readonly label: string; readonly availability: Pick<ModeAvailability, 'reason'> }, detail: string | null = null): string | null {
  // A block of the session's own, which the gate said before it looked at the mode.
  if (!isOwn(reason)) return blockWords(reason, provider).text;
  switch (reason) {
    case 'same': return null;
    case 'unknown-session': return 'This session is no longer listed.';
    case 'unsupported': return `${provider} sessions have no modes in this version.`;
    case 'unknown-mode': return `${provider} no longer lists this mode.`;
    case 'mode-unavailable': return asked.availability.reason === null ? MODE_LABELS.cannotUse(asked.label) : modeReasonWords(asked.availability.reason, asked.label, provider);
    case 'running': return MODE_WORDS.busy;
    case 'changing-mode': return 'Another change of this chat’s mode is under way.';
    case 'setting-up': return MODE_WORDS.settingUp(provider);
    case 'busy': return 'This session is being removed, or fat-g is closing, so its mode was not changed.';
    case 'unconfirmed': return CHAT_LINES.unconfirmed(provider);
    case 'not-confirmed': return `${provider} did not confirm ${asked.label}, so this chat’s mode is as it was and nothing can be sent until a mode is confirmed.${detail === null || detail === '' ? '' : ` ${provider} reported: ${detail}`}`;
    case 'storage-failed': return 'fat-g could not save the mode, so it is as it was.';
    case 'plan-pending': return MODE_WORDS.planPending;
  }
}

/** The grants list's own lines (C57, C86, C92). */
export const GRANT_WORDS = {
  title: 'Grants fat-g sent',
  /** What the list is, and is not (C23, C57): said once, under it. */
  record: 'fat-g’s record of what it sent, and no reading of the CLI.',
  /** By the CLI's own word, or without it (C12, C92). */
  confirmed: 'confirmed',
  notConfirmed: 'not confirmed',
  /** By its process: the session's current one, or one that has ended (C81, C86). */
  live: 'live',
  ended: 'ended',
  /** The Sub-agents tab's line that folds every grant, under its completed sub-agents (M106, C31). */
  fold: (count: number): string => (count === 1 ? '1 grant' : `${count} grants`),
} as const;
