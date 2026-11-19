// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M22b's two traces share (M22b, C46, C47): their output folder, the state one invocation
// leaves for the next (the Codex thread's id and model), the prompts, and the reductions both use.
// Plain Node; nothing here is application code.
//
// Nothing a scenario notes is a text of the model's: the captures hold the frames. A plan's text is
// measured (its length, its lines, whether its deltas add up to it) and never written into a note.
// What the spike itself wrote — its feedback, its words for a Cancel — is noted.
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';

export const M22B_DIR = path.join(SPIKES_DIR, 'output', 'm22b');

/** What one invocation leaves for the next (raw; ignored folder): ids, never a text. */
const STATE = () => path.join(M22B_DIR, 'state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

/** The prompts: a plan of one small change to a file of the scratch project, and fat-g's words for a decision. */
export const PROMPTS = Object.freeze({
  claudePlan: 'Make a short plan, three steps at most, for this change to the project in the current folder: append the line "reviewed" to the end of notes-1.txt. Do not ask me any question.',
  codexPlan: 'Make a short plan, three steps at most, for this change to the project in the current folder: append the line "reviewed" to the end of notes-1.txt. Do not ask me any question: I have no preference.',
  codexPlanSecond: 'Make a short plan, two steps at most, for this change to the project in the current folder: append the line "second" to the end of notes-2.txt. Do not ask me any question: I have no preference.',
  /** A plan turn that invites Codex's blocking question (M21's prompt). */
  codexPlanQuestion: 'Before you plan anything, ask me with your request_user_input tool which of notes-1.txt and notes-2.txt the plan should be about, offering those two as the options, and wait for my answer. Then write a two-line plan for summarising the file I pick.',
  plainAfterPlan: 'Create the file plain-after-plan.txt in the current folder, containing the single word hello. Then tell me in one short sentence whether it was created.',
  afterResume: 'Create the file after-resume.txt in the current folder, containing the single word hello. Then tell me in one short sentence whether it was created.',
});

/** The user's feedback on a plan (C11, C15): words of the spike's own. */
export const FEEDBACK = 'Add a final step that reads the file back to confirm the line is there.';
/** fat-g's fixed words for a Cancel on Claude (C11). */
export const CANCEL_WORDS = 'The user cancelled this plan in fat-g.';
/** fat-g's fixed words for Execute on Codex (C15). */
export const EXECUTE_WORDS = 'Implement the plan you proposed.';
/** fat-g's words for a question left blank (M100b, C30), and Skip's reply on Codex (C53). */
export const NO_ANSWER = 'No answer';

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

/** Whether `file` is inside `folder`, by its resolved path; Windows compares without case. */
export function inFolder(file, folder) {
  if (typeof file !== 'string' || typeof folder !== 'string') return false;
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const resolved = fold(path.resolve(file));
  const root = fold(path.resolve(folder));
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** The name of the first of `folders` ({ name: dir }) that holds `file`, else `elsewhere`; null for no path. */
export function whereIs(file, folders, base = null) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const full = path.isAbsolute(file) || !base ? file : path.join(base, file);
  for (const [name, dir] of Object.entries(folders).sort(([, a], [, b]) => b.length - a.length)) if (inFolder(full, dir)) return name;
  return 'elsewhere';
}

/** A text cut to `units`, with its length when it was longer: for a CLI's own fixed words. */
export const cut = (text, units = 240) => (typeof text !== 'string' ? null : text.length <= units ? text : `${text.slice(0, units)}… (${text.length} units)`);

/** A CLI's text with the scratch folders named, and nothing of a path that is none of them. */
export function tidy(text, folders, units = 300) {
  if (typeof text !== 'string') return null;
  let out = text;
  for (const [name, dir] of Object.entries(folders).sort(([, a], [, b]) => b.length - a.length)) {
    const forward = dir.split(path.sep).join('/');
    for (const spelling of [dir, forward, dir.split(path.sep).join('\\\\')]) out = out.split(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).join(`<${name}>`);
  }
  return out.toLowerCase().includes(userInfo().username.toLowerCase()) ? `<${text.length} units, naming a path>` : cut(out, units);
}

/** A text's shape: its length, its lines, and whether it opens with a Markdown heading. Never the text. */
export const shapeOf = (text) => (typeof text !== 'string' ? (text === undefined ? 'absent' : typeof text) : { units: text.length, lines: text.split('\n').length, opensWithAHeading: /^#/.test(text.trim()) });
