// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for a session's Sub-agents tab (docs/planning/_archive/M100.md, round 8; C78;
// docs/planning/_archive/M106.md, Design 7): its title, the name of its stack, what a row says of its sub-agent
// and its model, the fold lines, and what a sub-agent's thread says where nothing of it can be shown
// (M20a, C47, C48). The grants' own lines are the mode control's words
// (src/renderer/src/session-area/mode-words.ts).
import type { ChatWorkerReadResult } from '@shared/contracts/chat';

export type WorkerRefusal = Extract<ChatWorkerReadResult, { status: 'refused' }>['reason'];

export const AGENTS_WORDS = {
  /** The tab's title, and the name of its stack of sub-agents. */
  title: 'Sub-agents',
  /** The session's tab opened for a grant, and none has run (C11). */
  none: 'No sub-agents',
  /** What a running sub-agent with no action of its own reads (C6). */
  working: 'Working',
  completed: 'Completed',
  failed: 'Failed',
  /** A row whose model the CLI did not name, which draws the session's (C16). */
  assumed: 'Assumed: the CLI did not name this sub-agent’s model',
  assumedSpoken: 'model assumed',
  /** The agent definition every Claude sub-agent runs as by default: it says nothing, and is not drawn (C20). */
  defaultType: 'general-purpose',
} as const;

/** "#3: Count files in working directory": a sub-agent's number opens its label on every row (C7). */
export const numbered = (number: number, label: string): string => `#${number}: ${label}`;

/** "1 completed sub-agent", "3 completed sub-agents": the fold line over the finished ones (C9). */
export function completedText(count: number): string {
  return count === 1 ? '1 completed sub-agent' : `${count} completed sub-agents`;
}

export const THREAD_WORDS = {
  /** A sub-agent the list no longer holds, with no label handed (C24). */
  title: 'Sub-agent',
  /** The list of what it did and said: named apart from the chat's own, which is beside it. */
  list: 'Sub-agent’s messages',
  /** Nothing of it was kept yet: it has said and done nothing. */
  empty: 'This sub-agent has not said or done anything yet.',
} as const;

/** Why a sub-agent's thread shows nothing, in fat-g's words. */
export const WORKER_REFUSALS: Readonly<Record<WorkerRefusal, string>> = {
  'unknown-session': 'This session is no longer listed.',
  'unknown-worker': 'Nothing of this sub-agent is saved in fat-g.',
  'unknown-cursor': 'The earlier part of this sub-agent’s work could not be read.',
};

/** A thread's head: the sub-agent's label, or fat-g's word for one that has none. */
export const threadTitle = (label: string | null | undefined): string => (label === null || label === undefined || label.trim() === '' ? THREAD_WORDS.title : label);
