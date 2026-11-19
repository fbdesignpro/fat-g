// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where the focus goes when what holds it in the chat's foot leaves the page (M15, C68; M22, C46,
// C89; M22b, C24): to the chat's list, never to the page's body. The composer, the reason in its
// place, the plan's panel and the prompt-type bar each use it; its own module, since the composer
// imports from the bar.
import { type RefObject, useLayoutEffect, useRef } from 'react';
import { focusQuietly } from '../ui/focus';
import { LIST_MARK } from './MessageList';

/**
 * The input row and the reason that stands in its place change places as a block comes and goes
 * (C68; M22, C46, C89): a start that confirmed no mode takes the input away under the hands that
 * just sent from it. Whichever leaves while the focus is in it hands the focus to the chat's list,
 * as a card that settles does (M21, C43) — never to the page's body. Run before it leaves the page,
 * while the focus is still its own; given to its outer element, by the component that leaves.
 */
export function useFootFocus(): RefObject<HTMLDivElement | null> {
  const foot = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = foot.current;
    // The chat it stands in, which holds the list: read while it is still in the page.
    const chat = element?.closest<HTMLElement>(`[${CHAT_MARK}]`) ?? null;
    return () => {
      if (element === null || !element.contains(document.activeElement)) return;
      focusQuietly(chat?.querySelector<HTMLElement>(`[${LIST_MARK}]`));
    };
  }, []);
  return foot;
}

/** What the chat area's outer element carries: the session whose chat it is. */
export const CHAT_MARK = 'data-chat-session';
