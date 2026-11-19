// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for a plan's tab (docs/planning/_archive/M22b.md, Design 7; C25, C60, C73): its head line,
// its version chooser, its Remove and what it says where nothing can be shown. No plan's text is
// here: a plan is named by its title, which main gives.
export const PLAN_TAB_WORDS = {
  /** A tab whose plan's title is not read yet. */
  title: 'Plan',
  head: 'Plan',
  versions: 'Version',
  version: (version: number): string => `v${version}`,
  unfinished: 'unfinished: fat-g did not receive the rest of it',
  drafting: 'being written',
  madeBy: (provider: string, model: string): string => `${provider}, ${model}`,
  chat: (chat: string | null): string => (chat === null ? 'its chat was removed' : chat === '' ? 'in an unnamed chat' : `in ${chat}`),
  /** The plan's decisions stand on another version than the one shown (C25; decision 0029). */
  waitsOn: (version: number): string => `Decisions stand on v${version}.`,
  showWaiting: (version: number): string => `Show v${version}`,
  information: 'Plan information',
  remove: 'Remove plan',
  removeTitle: (title: string): string => `Remove ${title}?`,
  removeText: 'fat-g deletes this plan, every version of it and its reviews from its data folder. It cannot be brought back. The chats keep their lines, which say it was removed.',
  /** How many chats take part in it, whose decisions a removal settles first (C73; decision 0029). */
  removeWaiting: (count: number): string => (count === 1 ? '1 chat takes part in it: its decision is settled first.' : `${count} chats take part in it: each one’s decision is settled first.`),
  removeFailed: 'fat-g could not remove the plan, and nothing was changed.',
  removeWriting: 'A version of this plan is still being written: remove it once that ends.',
  reading: 'Reading the plan…',
  removed: 'This plan was removed.',
  failed: 'fat-g could not read this plan.',
} as const;
