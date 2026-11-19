// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for the chats no listed session has (docs/planning/_archive/M18.md, Design 8; C31, C32): the
// dim row at the foot of the project column, the read-only chat and Settings' Storage section say
// the same things the same way.

/** "3 chats without a session": the row's words, and the confirmation's title after "Remove". */
export function detachedText(count: number): string {
  return count === 1 ? '1 chat without a session' : `${count} chats without a session`;
}

/** What a removal's confirmation says (C32): how many chats go, and that nothing of a provider's does. */
export function removeDetachedText(count: number): string {
  return `fat-g deletes ${count === 1 ? 'the chat it saved, and it' : `the ${count} chats it saved, and they`} cannot be brought back. Nothing in the providers’ own histories is deleted.`;
}

/** Said when a removal was refused, or failed: nothing went. */
export function removeDetachedFailedText(count: number): string {
  return `fat-g could not remove ${count === 1 ? 'it' : 'them'}, and nothing was changed.`;
}
