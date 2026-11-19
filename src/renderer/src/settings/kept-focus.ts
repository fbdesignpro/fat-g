// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { focusQuietly } from '../ui/focus';

/**
 * A choice that is saved at once is disabled while it is saved, and a disabled control cannot hold
 * the focus: the browser takes it to the page's body as the group is disabled, and the next arrow
 * key goes nowhere — the first key that moves through a group of radios would be the last. A group
 * that lost the focus that way, and no other, takes it back on its chosen option as soon as it can
 * be used again; a focus that went elsewhere meanwhile is left where it is. Given to the group's
 * `fieldset`.
 */
export function useKeptFocus(disabled: boolean): RefObject<HTMLFieldSetElement | null> {
  const group = useRef<HTMLFieldSetElement | null>(null);
  const lost = useRef(false);

  useEffect(() => {
    const element = group.current;
    if (element === null) return;
    // The loss itself is the one sign: a control of a disabled group that gives the focus to nothing.
    // It comes as the group is disabled, before anything here can look at what had the focus.
    const onFocusOut = (event: FocusEvent): void => { lost.current = element.disabled && event.relatedTarget === null; };
    element.addEventListener('focusout', onFocusOut, true);
    return () => element.removeEventListener('focusout', onFocusOut, true);
  }, []);

  useLayoutEffect(() => {
    if (disabled || !lost.current) return;
    lost.current = false;
    if (document.activeElement === document.body) focusQuietly(group.current?.querySelector<HTMLInputElement>('input:checked'));
  }, [disabled]);

  return group;
}
