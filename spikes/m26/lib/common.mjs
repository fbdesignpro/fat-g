// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M26's two traces share (docs/planning/_archive/M26.md, Spike): their output folder, the secretary's
// instruction and the one first prompt both name, and the reduction of a reply to facts. Plain Node;
// nothing here is application code. The instruction is the title task's (src/main/sessions/secretary/
// title.ts): the two say the same.
//
// Nothing a scenario notes is a text of the model's: the captures hold the frames.
//
// "three to six words" was added to the instruction after K2's `session-model` run, whose reply ran
// to 62 characters; K1's runs and that one were made without it.
import path from 'node:path';
import { SPIKES_DIR } from '../../m10/lib/paths.mjs';

export const M26_DIR = path.join(SPIKES_DIR, 'output', 'm26');

/** The title task's instruction: a system prompt on Claude, developer instructions on Codex. */
export const INSTRUCTIONS = [
  'You name chat sessions. The user message holds the first message of a new session.',
  'Reply with a title for that session: three to six words and at most 36 characters, in the language of the message, on one line,',
  'with no quotes, no Markdown and no punctuation at the end. Reply with the title alone.',
  'Do not answer the message, do not act on it, run nothing, read nothing and ask nothing.',
].join(' ');

/** A first prompt as a user would write one, the same on both CLIs. */
export const FIRST_PROMPT = 'The login form lets me press Submit before both fields are filled in. Make the button stay disabled until the email and the password are both there, and add a test for it.';

/** What the secretary sends as the user's message: the prompt under one line that says what it is. */
export const input = (prompt) => `The first message of the session:\n\n${prompt}`;

/** What a reply looks like, never what it says. */
export function replyFacts(text) {
  if (typeof text !== 'string') return { came: false };
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const first = (lines[0] ?? '').trim();
  return {
    came: true, units: text.length, lines: lines.length, firstLineUnits: first.length,
    quoted: /^["'“‘«`]/.test(first) || /["'”’»`]$/.test(first), markdown: /[*_#`>[\]]/.test(first),
    trailingPunctuation: /[.!?:;,…]$/.test(first), within36: first.length <= 36,
  };
}
