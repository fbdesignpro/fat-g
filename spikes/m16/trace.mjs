// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M16's spikes K2 to K27 (M16, S14, S15, C4, C5, C73): new traces of the installed Claude CLI under the
// arguments a chat session will be launched with, in a scratch configuration folder. K1 is M10's
// own trace.mjs run again, compared by recheck.mjs.
//
//   node spikes/m16/trace.mjs --scenario <id> [--confirm-turns <n>] [--again] [--path <executable>]
//   node spikes/m16/trace.mjs --list
//
// Without --confirm-turns equal to the scenario's own count it prints its plan and launches
// nothing (S10). One invocation is one run; at most three runs per scenario.
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { runScenario } from './lib/common.mjs';
import { SCENARIOS as CHAT } from './scenarios/chat.mjs';
import { SCENARIOS as GATE } from './scenarios/gate.mjs';
import { SCENARIOS as SESSIONS } from './scenarios/sessions.mjs';
import { SCENARIOS as TURNS } from './scenarios/turns.mjs';

export const SCENARIOS = Object.freeze({ ...SESSIONS, ...GATE, ...TURNS, ...CHAT });

if (isMain(import.meta.url)) {
  await runSpike('m16-trace', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(20)} ${String(scenario.turns).padStart(2)} turn(s)${scenario.atMost ? ' at most' : ''}  ${scenario.title}`);
      log(`total: ${Object.values(SCENARIOS).reduce((sum, scenario) => sum + scenario.turns, 0)} turn(s) for one run of each`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m16/trace.mjs --scenario ${Object.keys(SCENARIOS).join('|')} [--confirm-turns <n>] [--again] [--path <executable>]`); return 1; }
    return runScenario('m16-trace', scenario, frame);
  });
}
