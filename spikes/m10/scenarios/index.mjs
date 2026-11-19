// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import t1 from './t1-basic.mjs';
import t2 from './t2-effort.mjs';
import t3 from './t3-subagent.mjs';
import t4 from './t4-interrupt.mjs';
import t5 from './t5-error.mjs';
import t6 from './t6-question.mjs';
import t7 from './t7-declined.mjs';
import t8 from './t8-model.mjs';

export const SCENARIOS = Object.freeze(Object.fromEntries([t1, t2, t3, t4, t5, t6, t7, t8].map((s) => [s.id, s])));

/** The read tools every Claude scenario gets (C17). */
export const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
