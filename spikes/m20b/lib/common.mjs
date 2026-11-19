// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M20b's three traces share (M20b, C1–C3): their output folder, the state one invocation
// leaves for the next (the seed session's and thread's ids), fat-g's own words for a question
// beside a session (C51, C52), and the prompts. Plain Node; nothing here is application code.
//
// Nothing a scenario notes is a text of the model's: the captures hold the frames. An answer is
// read in memory for a yes or no — does it name the word the question planted, the file the seed
// turn read — and nothing more of it is kept.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';

export const M20B_DIR = path.join(SPIKES_DIR, 'output', 'm20b');

/** What one invocation leaves for the next (raw; ignored folder): ids, never a text but K3's one exchange. */
const STATE = () => path.join(M20B_DIR, 'state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

/** The seed turn, the same words on both CLIs: it gives the conversation something to hold (K1, K3). */
export const SEED_PROMPT = 'Read README.md, src/tides.js and the Markdown file in the folder called field notes, then tell me in two sentences what this project is for and what nextHighTide returns.';

/** A long turn to ask beside (K1 `during`, K3 `during`): it plants a word a side question can look for. */
export const LONG_PROMPT = 'Remember the word LANTERN. Then read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and summarise all four in one sentence.';

/** C51's template around a selection, fat-g's words. `source` is one of C51's phrases. */
export function seedQuestion(source, excerpt) {
  const quoted = excerpt.split('\n').map((line) => `> ${line}`).join('\n');
  return `This is a question beside the conversation, about a passage in ${source}. Answer it briefly from what the conversation already holds, and take no action.\n\n${quoted}\n\nExplain this passage.`;
}

/** C52's developer instructions for a Codex child, fat-g's words. */
export const DEVELOPER_INSTRUCTIONS = 'You are answering a question asked beside a conversation, not continuing it. Answer briefly from what the conversation already holds. Take no action: run no command and change no file. Reading a file to answer is acceptable.';

/** An excerpt of README.md as a selection would carry it (tests/fixtures/project-files.mjs). */
export const README_EXCERPT = "Small helpers the harbour office uses to read its tide table: they parse the times of the day's tides, find the next high tide and print a height in metres.";
export const README_SOURCE = 'the file README.md, lines 3–3';

/** The questions asked beside the session, one per case; a word each answer is checked for, in memory. */
export const QUESTIONS = Object.freeze({
  idle: { text: seedQuestion(README_SOURCE, README_EXCERPT), looksFor: /tide|harbour|helper/i },
  firstTurn: { text: 'Without running any command: what has the user asked for so far in this conversation, in one sentence?', looksFor: /tide|readme|field notes|project/i },
  codexFollowup: { text: 'What passage was I asking about just before, in this side conversation? Quote its first five words.', looksFor: /small helpers the harbour office/i },
  codexAgain: { text: 'What passage was I asking about earlier in this side conversation, and what is the function in src/tides.js called? One sentence.', looksFor: /harbour office|tide table|helpers/i, alsoLooksFor: /nextHighTide/i },
  during: { text: 'Without using any tool: which word, if any, was I asked to remember in my latest message, and which files has the assistant read in this conversation? Answer in one sentence.', looksFor: /lantern/i, alsoLooksFor: /tides|readme|harbour/i },
  twoA: { text: 'From what this conversation already holds, and without using any tool: what is the function in src/tides.js called and what does it return? One sentence.', looksFor: /nextHighTide/i },
  twoB: { text: 'From what this conversation already holds, and without using any tool: what is the folder with a space in its name called? Answer with its name alone.', looksFor: /field notes/i },
  followupHistory: { question: 'For this side conversation only, remember the word HARBOUR and answer with the single word noted.', response: 'noted' },
  followup: { text: 'Which word did I ask you to remember in this side conversation? Answer with that word alone.', looksFor: /harbour/i },
  cancel: { text: 'Without using any tool, write 40 numbered sentences about lighthouses, one per line.', looksFor: /lighthouse/i },
  read: { text: 'What does the file notes-2.txt in this folder say? Quote it exactly.', looksFor: /kettle/i },
  again: { text: 'Which word did I ask you to remember earlier in this side conversation, and what is the function in src/tides.js called? One sentence.', looksFor: /harbour/i, alsoLooksFor: /nextHighTide/i },
});

/** The scratch login folder's history file for a session, by size alone (never read): null when there is none. */
export function historyBytes(configDir, projectDir, sessionId) {
  const encoded = projectDir.replace(/[^A-Za-z0-9]/g, '-');
  const file = path.join(configDir, 'projects', encoded, `${sessionId}.jsonl`);
  try { return existsSync(file) ? statSync(file).size : null; } catch { return null; }
}

/** Counts of received frames from `from` on, by type key. */
export function typeCounts(driver, typeOf, from = 0) {
  const counts = {};
  for (const f of driver.session.frames) {
    if (f.dir !== 'recv' || f.index < from) continue;
    const key = typeOf(f.frame);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
