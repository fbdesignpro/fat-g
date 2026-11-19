// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What each element was given the focus with. jsdom has no `:focus-visible` and ignores the
// `focusVisible` option, so a test cannot see the ring; what it can see is which call asked for a
// quiet focus (ui/focus.ts), which is what the page's behaviour rests on. The option itself is
// checked in the running page, not here.

/** The focus calls seen since it was installed, newest last. `undo` puts the real `focus` back. */
export interface FocusWatch {
  readonly calls: { readonly element: Element; readonly options: FocusOptions | undefined }[];
  /** Whether the last focus `element` was given was a quiet one. False where it was never focused. */
  quiet: (element: Element | null) => boolean;
  undo: () => void;
}

export function watchFocus(): FocusWatch {
  const calls: { element: Element; options: FocusOptions | undefined }[] = [];
  // Read unbound on purpose: it is called with its element below, and put back as it was by `undo`.
  const real = Reflect.get(HTMLElement.prototype, 'focus');
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
    calls.push({ element: this, options });
    real.call(this, options);
  };
  return {
    calls,
    quiet: (element) => {
      const last = [...calls].reverse().find((call) => call.element === element);
      return last?.options?.focusVisible === false;
    },
    undo: () => {
      HTMLElement.prototype.focus = real;
    },
  };
}
