// What tests read of the replay (./replay.mjs), which is plain JavaScript so that the fake runs on
// Node alone. The rest of it is the fake's own.

/** K3's captures of a side thread (M20b): the forks, and the questions sent to them. */
export const FORK_CAPTURES: readonly string[];
/** Those of them that are turns of the session's own, which a side thread is asked during. */
export const FORK_TURN_CAPTURES: readonly string[];
/** K2's captures of a question (M21): the plan turn that asked through a request, and the turns that asked in a message. */
export const QUESTION_CAPTURES: readonly string[];
/** K1's, K4's and K6's captures of a turn under a mode (M22): each of their turns by its own prompt, held at each request for leave. */
export const PERMISSION_CAPTURES: readonly string[];
/** K2's captures of a plan (M22b): each of their turns by its mode, its words and its thread's policy. */
export const PLAN_CAPTURES: readonly string[];
