// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M106's two traces share (docs/planning/_archive/M106-spec-sheet.md; C14, C15, C37): their output folder,
// the marker words the spike dictates, the prompts, and a reader of the fields that name a model.
// Plain Node; nothing here is application code.
//
// Nothing a scenario notes is a text of the model's: a note says whether an answer holds a marker
// word the spike dictated, never what else it says. A model's id is the CLI's own name, not the
// user's, and is noted as it came.
import path from 'node:path';
import { SPIKES_DIR } from '../../m10/lib/paths.mjs';

export const M106_DIR = path.join(SPIKES_DIR, 'output', 'm106');

/** The words the spike dictates, which an answer either holds or does not. */
export const MARKERS = Object.freeze({
  foreground: 'FOREGROUND-4471',
  backgroundOne: 'BACKGROUND-9026',
  backgroundTwo: 'BACKGROUND-3158',
  spawn: 'SPAWNED-7703',
  activity: 'SPAWNED-2284',
});

/** The models asked for a sub-agent, by the CLI's own aliases (Claude) and keys (Codex). */
export const ASKED = Object.freeze({ claudeForeground: 'haiku', claudeBackgroundOne: 'haiku', claudeBackgroundTwo: 'opus', codex: 'gpt-5.6-terra' });

/** The prompts: each of its own words, so that no earlier capture's prompt chooses it (tests/fakes/replay.test.ts). */
export const PROMPTS = Object.freeze({
  claudeForeground: `Use your Agent tool exactly once, with its model parameter set to "${ASKED.claudeForeground}" and run_in_background set to false, to hand this task to a sub-agent, and do not do it yourself: the sub-agent must reply with only the word ${MARKERS.foreground} and use no tool. When it has reported, tell me in one sentence which word it reported.`,
  claudeBackground: `Use your Agent tool exactly twice, both calls in the same reply, each with run_in_background set to true: the first with its model parameter set to "${ASKED.claudeBackgroundOne}", whose task is to read README.md with its Read tool and then reply with only the word ${MARKERS.backgroundOne}; the second with its model parameter set to "${ASKED.claudeBackgroundTwo}", whose task is to read README.md with its Read tool and then reply with only the word ${MARKERS.backgroundTwo}. Neither may use any other tool. Do not wait for them: end your reply at once with the one word STARTED.`,
  codexSpawn: (workerModel) => `Spawn exactly one sub-agent with your agent-spawning tool and hand it this task; do not do it yourself: it must reply with only the word ${MARKERS.spawn} and use no tool. If the tool lets you choose the sub-agent's model, choose ${workerModel}. Wait for it, then tell me in one sentence which word it reported.`,
  codexActivity: (workerModel) => `Start exactly one sub-agent with your agent-spawning tool and give it this task; do not do it yourself: it must answer with only the word ${MARKERS.activity} and use no tool. If the tool lets you choose the sub-agent's model, choose ${workerModel}. Wait for it, then tell me in one sentence which word it answered.`,
});

/** Whether a text holds one of the spike's own marker words. */
export const holds = (text, word) => typeof text === 'string' && new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);

/** Every field of a value whose name says model, nickname or role, with its value, by its path: what a frame names of a model. */
export function modelFields(value, trail = '', found = []) {
  if (Array.isArray(value)) value.forEach((item, i) => modelFields(item, `${trail}[${i}]`, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (/model|nickname|role/i.test(key) && !/modelContextWindow|modelProvider/.test(key)) found.push({ at: `${trail}.${key}`, value: typeof inner === 'string' || inner === null ? inner : typeof inner });
      modelFields(inner, `${trail}.${key}`, found);
    }
  }
  return found;
}
