// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's flags: marks the user sets on it from its capsule's menu. Each is a boolean field of
// the session's record of the same name (decision 0011), so a flag is added here and in the record.
// Renderer-safe: the words and the icons are the page's (src/renderer/src/sessions/flags.tsx).

/** In the order the menu lists them and the capsule draws them. */
export const SESSION_FLAGS = ['starred', 'toDo', 'toVerify'] as const;
export type SessionFlag = (typeof SESSION_FLAGS)[number];

export type SessionFlags = { readonly [F in SessionFlag]: boolean };

/** A new session's flags: none set. */
export const NO_FLAGS: SessionFlags = { starred: false, toDo: false, toVerify: false };

/** What Done keeps: every other flag is cleared when the session is completed. */
export const FLAGS_KEPT_AT_DONE: readonly SessionFlag[] = ['starred'];

export function isSessionFlag(value: unknown): value is SessionFlag {
  return typeof value === 'string' && (SESSION_FLAGS as readonly string[]).includes(value);
}

/** The flags Done clears, each set to false: what a completion writes beside its time. */
export function flagsClearedAtDone(): Partial<Record<SessionFlag, false>> {
  return Object.fromEntries(SESSION_FLAGS.filter((flag) => !FLAGS_KEPT_AT_DONE.includes(flag)).map((flag) => [flag, false]));
}
