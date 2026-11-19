// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M21's two traces share (M21, C1–C3): their output folder, the state one invocation leaves
// for the next (the Codex thread's id), the prompts that invite a question, how each answer is
// chosen, and fat-g's words for an async answer (C26). Plain Node; nothing here is application code.
//
// Nothing a scenario notes is a text of the model's: the captures hold the frames. An answer is
// read in memory for a yes or no — does it name the word the chosen file holds — and nothing more
// of it is kept. What the spike itself wrote (its answers, the CLI's fixed words back) is noted.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';

export const M21_DIR = path.join(SPIKES_DIR, 'output', 'm21');

/** What one invocation leaves for the next (raw; ignored folder): ids, never a text. */
const STATE = () => path.join(M21_DIR, 'state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

/** The word each notes file plants (spikes/m10/lib/scratch.mjs, TRACE_FILES): what an answer is checked for. */
export const WORDS = Object.freeze({ 'notes-1.txt': /tide table/i, 'notes-2.txt': /kettle/i, 'notes-3.txt': /logbook|blue drawer/i, 'notes-4.txt': /spare bulbs|top shelf/i });

/** The prompts, one per case. Each asks for the question tool by its name, as T6's prompt did, so that the case happens. */
export const PROMPTS = Object.freeze({
  one: 'Before you read anything, ask me with your AskUserQuestion tool which of notes-1.txt and notes-2.txt I want read, offering those two as the options. Then read the one I pick and tell me in one sentence what it says.',
  multi: 'Before you read anything, ask me with your AskUserQuestion tool, in a single question that allows several answers to be selected, which of notes-1.txt, notes-2.txt and notes-3.txt I want read, offering those three as the options. Then read every one I pick and tell me in one sentence each what they say.',
  two: 'Before you read anything, ask me two questions in one single call of your AskUserQuestion tool: first, which of notes-1.txt and notes-2.txt I want read, with those two as the options; second, whether I want the answer in English or in French, with those two as the options. Then read the file I named, even if it was not one of the options, and tell me in one sentence what it says, in the language I chose.',
  stop: 'Before you read anything, ask me with your AskUserQuestion tool which of notes-1.txt and notes-2.txt I want read, offering those two as the options. Then read the one I pick and tell me in one sentence what it says.',
  worker: 'Use the Agent tool to hand this task to a sub-agent, and do not do it yourself: the sub-agent must first ask the user, with its AskUserQuestion tool, which of notes-1.txt and notes-2.txt to read, offering those two as the options, then read the one the user picks and report in one sentence what it says. When the sub-agent is done, tell me in one sentence what it reported.',
  killed: 'Before you read anything, ask me with your AskUserQuestion tool which of notes-1.txt and notes-2.txt I want read, offering those two as the options. Then read the one I pick and tell me in one sentence what it says.',
  resumed: 'Go on.',
  codexPlan: 'Before you plan anything, ask me with your request_user_input tool which of notes-1.txt and notes-2.txt the plan should be about, offering those two as the options, and wait for my answer. Then write a two-line plan for summarising the file I pick.',
  codexAsync: 'Ask me which of notes-1.txt and notes-2.txt I want read, offering those two as options, and do not read anything until I have answered: end your turn right after asking, without waiting.',
  codexAsyncTwo: 'Ask me two questions at once, each with its options: which of notes-1.txt and notes-2.txt I want read, and whether I want it quoted or summarised. Do not read anything until I have answered: end your turn right after asking, without waiting.',
});

/**
 * fat-g's words for an async answer (C26): each question's title on a line and its answer on the
 * next, questions separated by a blank line. `answers`: [{ title, answer }].
 */
export function asyncAnswerPrompt(answers) {
  return answers.map(({ title, answer }) => `${title}\n${answer}`).join('\n\n');
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

/** The option of `options` whose label matches `pattern`, else null. Options are strings (Codex's async) or `{ label, description }`. */
export function optionMatching(options, pattern) {
  for (const option of Array.isArray(options) ? options : []) {
    const label = typeof option === 'string' ? option : option?.label;
    if (typeof label === 'string' && pattern.test(label)) return label;
  }
  return null;
}
