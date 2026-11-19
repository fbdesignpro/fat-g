// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Moving the keyboard focus without lighting it (the maintainer's review).
//
// The page draws a ring round whatever has the focus and the browser judges focus-visible
// (styles/global.css), and a few places add their own marks to it — the chat's list rings itself
// and marks its current message, a capsule rings its whole row. That is the right cue when the
// reader moved there themselves, by Tab or by a key the page acts on, and the wrong one when fat-g
// moved the focus for them: the control they were in left the page, or an action they finished
// handed the focus back. The browser cannot tell the two apart — it lights anything focused after
// a key — so a box appears round the chat or round a capsule with no move of the reader's behind it.
//
// `focusQuietly` is for that second kind: the element takes the keyboard, and is not lit. The
// reader's next Tab, or their first key in it, lights it as ever. Where the focus goes because the
// reader asked for it — a menu's arrows, a dialog opening, the prompt a press selects a session for
// — the plain `focus()` stands.
//
// `focusVisible: false` is the HTML standard's own option for this (FocusOptions), and Chromium
// honours it: measured in the packaged page at Chromium 152, `:focus-visible` matches after a
// plain `focus()` that follows a key, and does not match with the option. Nothing is drawn by
// fat-g to replace it, so a browser that ignored the option would simply light the element as before.

/** Gives `element` the keyboard focus without the ring a reader's own move draws. Nothing to focus: nothing happens. */
export function focusQuietly(element: HTMLElement | null | undefined): void {
  element?.focus({ preventScroll: true, focusVisible: false });
}
