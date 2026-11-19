// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The themes, and the colours the OS paints for each around and before the page: the window's own
// background (the frame shown before the first render) and the window buttons drawn over the title
// strip. Main reads these (src/main/windows/chrome.ts); the page's colours are the tokens in
// src/renderer/src/styles/tokens.css, and tests/architecture/styles.test.ts keeps the two equal.

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** White by default, with a graphite dark option. */
export const DEFAULT_THEME: Theme = 'light';

export interface NativeColors {
  /** The window's background, and the title-bar overlay's. Equal to `--color-chrome`. */
  readonly background: string;
  /** The window buttons' glyphs. Equal to `--color-text`. */
  readonly symbol: string;
  /** Inactive title text and window buttons. Equal to `--color-title-inactive`. */
  readonly inactiveSymbol: string;
}

export const NATIVE_COLORS: Readonly<Record<Theme, NativeColors>> = {
  light: { background: '#ffffff', symbol: '#000000', inactiveSymbol: '#a0a0a0' },
  dark: { background: '#17191c', symbol: '#dde1e7', inactiveSymbol: '#a0a0a0' },
};

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

export const DONE_ANIMATIONS = ['none', 'animation-flash', 'animation-only'] as const;
export type DoneAnimation = (typeof DONE_ANIMATIONS)[number];
export const DEFAULT_DONE_ANIMATION: DoneAnimation = 'animation-flash';

export const CREATION_ANIMATIONS = ['none', 'wipe'] as const;
export type CreationAnimation = (typeof CREATION_ANIMATIONS)[number];
export const DEFAULT_CREATION_ANIMATION: CreationAnimation = 'wipe';

// ── The attention flash (the maintainer) ──────────────────────────────────────────
// A capsule's status bar flashes inverted when it turns to an attention (CapsuleStatus.tsx), in the
// Main window and the Pet. Whether it does, how fast and for how long are the user's, in Settings →
// Appearance; main carries them in the app state, so the Pet follows them without reading preferences.

export const FLASH_SPEEDS = ['slow', 'medium', 'fast'] as const;
export type FlashSpeed = (typeof FLASH_SPEEDS)[number];

/** One flash, inverted then not, in milliseconds: two, four or six a second. */
export const FLASH_CYCLE_MS: Readonly<Record<FlashSpeed, number>> = { slow: 500, medium: 250, fast: 167 };

/** How long it flashes, in seconds: the durations Settings offers, and the only ones a file may hold. */
export const FLASH_SECONDS = [1, 2, 3, 5, 10] as const;
export type FlashSeconds = (typeof FLASH_SECONDS)[number];

export interface AttentionFlash {
  readonly enabled: boolean;
  readonly speed: FlashSpeed;
  readonly seconds: FlashSeconds;
}

export const DEFAULT_ATTENTION_FLASH: AttentionFlash = { enabled: true, speed: 'fast', seconds: 3 };

/** How many flashes fill its duration at its speed: never none. */
export function flashCount(flash: Pick<AttentionFlash, 'speed' | 'seconds'>): number {
  return Math.max(1, Math.round((flash.seconds * 1000) / FLASH_CYCLE_MS[flash.speed]));
}
