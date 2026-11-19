// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Shared by the scenario modules. A scenario never touches a process or a wire format: it prompts,
// waits for spike-internal events (lib/driver.mjs) and answers requests with semantic decisions,
// which each driver turns into its own wire reply.

/** The success frame arrived: `index` is its frame index. */
export const happened = (index, notes = {}) => ({ outcome: 'happened', successIndex: index, notes });

/** The run ended without the success frame, though no wait expired. */
export const didNotHappen = (why, notes = {}) => ({ outcome: 'did-not-happen', successIndex: null, notes: { why, ...notes } });

export const isEnd = (e) => e.kind === 'turn-end';

/** Waits for the next main-turn end from `from`, under the scenario wait. */
export const turnEnd = (ctx, from) => ctx.wait(isEnd, from);
