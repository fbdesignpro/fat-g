// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What starts an aside from the page (docs/planning/_archive/M20b.md, Design 7, 8; C41, C50, C53, C73):
// Explain this on a selection, a new side question, and the reopening of one that exists. Each ends
// at the opener, which opens or selects the aside's one tab.
//
// The page makes an aside's id (C73): a new tab exists before its first question is sent, so it has
// its id before main has answered anything. For Explain this main answers with the id to open — the
// one sent, or the one the same selection already has (C50).
import { type AsideSource, asideTitle } from '@shared/contracts/aside';
import { ASK_REFUSALS, type AskRefusal, blockWords, CHAT_LINES } from '@shared/contracts/chat';
import { MODE_WORDS } from '@shared/contracts/permissions';
import type { SendBlock } from '@shared/contracts/sessions';
import { openAside } from '../artifacts/opener';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { setAsideProblem } from './asides-store';
import { CHANGING_MODE_TEXT } from './card-words';

export const ASK_FAILED_TEXT = 'fat-g could not ask the question.';
/** Temporarily hide standalone Explain buttons; selection-menu actions remain available. */
export const EXPLAIN_BUTTONS_VISIBLE: boolean = false;

function refusalWords(reason: AskRefusal, provider: string): string {
  switch (reason) {
    case 'unknown-session': return 'This session is no longer listed.';
    case 'unknown-aside': return 'This side question is no longer saved in fat-g.';
    case 'unsupported': return `${provider} takes no question beside a session in this version.`;
    case 'no-conversation': return `${provider} holds no conversation of this session yet. Ask once its first answer has arrived.`;
    case 'aside-running': return 'This side question is still being answered. Ask again once it has finished.';
    case 'busy': return 'This session is being removed, or fat-g is closing, so nothing was asked.';
    case 'unconfirmed': return CHAT_LINES.unconfirmed(provider);
    case 'storage-failed': return 'fat-g could not save your question, so nothing was asked. Try again.';
    // A change of the chat's mode, and a sandbox setup, hold a question as they hold a prompt (M22, C62, C90).
    case 'changing-mode': return CHANGING_MODE_TEXT;
    case 'setting-up': return `${MODE_WORDS.settingUp(provider)} Ask again once it has ended.`;
  }
}

const isRefusal = (reason: AskRefusal | SendBlock): reason is AskRefusal => (ASK_REFUSALS as readonly string[]).includes(reason);

/** Why an ask was not taken, in fat-g's words (C73): the question stays where it was typed. */
export function askRefusalText(reason: AskRefusal | SendBlock, provider: string): string {
  return isRefusal(reason) ? refusalWords(reason, provider) : blockWords(reason, provider).text;
}

/** A session's provider, by the name fat-g's words use. */
export function providerNameOf(sessionId: string): string {
  const snapshot = useAppState.getState().snapshot;
  const providerId = snapshot?.sessions?.sessions.find((entry) => entry.record.id === sessionId)?.record.providerId;
  return snapshot?.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId ?? '';
}

const newId = (): string => crypto.randomUUID();

/**
 * Explain this (C5, C41, C50): asks about a selection, and opens the tab of the aside main names.
 * Neither the focus nor the place of what was being read moves. A refusal is said in one line by
 * the toolbar, and nothing opens.
 */
export async function explain(sessionId: string, source: AsideSource): Promise<void> {
  setAsideProblem(sessionId, null);
  try {
    const answer = await invoke('chat:ask', { sessionId, asideId: newId(), source });
    if (answer.status === 'accepted') openAside(sessionId, answer.asideId, asideTitle(source, ''));
    else setAsideProblem(sessionId, askRefusalText(answer.reason, providerNameOf(sessionId)));
  } catch {
    setAsideProblem(sessionId, ASK_FAILED_TEXT);
  }
}

/** A new side question (C53), optionally prefilled, with the focus in its field. Nothing is sent until a question is. */
export function newSideQuestion(sessionId: string, draft?: string): void {
  setAsideProblem(sessionId, null);
  openAside(sessionId, newId(), null, true, draft);
}
