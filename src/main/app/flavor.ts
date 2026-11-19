// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which build this is. `__FATG_SMOKE_HOOKS__` (src/main/build-flags.d.ts) is false only in release
// packages, whose main bundle therefore contains no smoke code at all: no environment variable can
// make a shipped binary launch fixture executables (decision 0007).

/** A smoke run (`FATG_SMOKE=1`, scripts/smoke.mjs) — only ever true in a build with the hooks. */
export const isSmokeRun: boolean = __FATG_SMOKE_HOOKS__ && process.env['FATG_SMOKE'] === '1';

/** Selected UI integration check; absent for the complete smoke suite and every release build. */
export const smokeScenario: string | undefined = __FATG_SMOKE_HOOKS__ && isSmokeRun ? process.env['FATG_SMOKE_SCENARIO'] : undefined;

/** One of the smoke run's live launches (`FATG_SMOKE_LIVE=1`; M15, B14; M16): a Codex session and a Claude session, each on its replay fake. */
export const isLiveSmokeRun: boolean = __FATG_SMOKE_HOOKS__ && isSmokeRun && process.env['FATG_SMOKE_LIVE'] === '1';

// Read behind the build flag, so a release build folds it away with the variable's name (M14, C27).
const demoValue: string | undefined = __FATG_SMOKE_HOOKS__ ? process.env['FATG_DEMO_SESSIONS'] : undefined;

/**
 * The demo source's switch (src/main/sessions/demo-source.ts; M14, C27, C29): `FATG_DEMO_SESSIONS=1`
 * drives the sessions that exist through its script, and `=seed` also adds three to each project
 * that has none. Always `off` in a release build, which holds no demo code.
 */
export const demoSessions: 'off' | 'on' | 'seed' = demoValue === 'seed' ? 'seed' : demoValue === '1' ? 'on' : 'off';

/**
 * The demo switch's third value, the stream form (src/main/sessions/demo-stream.ts; M19, C63, C69):
 * `FATG_DEMO_SESSIONS=stream` runs fat-g on a provider of the form's own, in a throwaway data folder
 * (src/main/app/identity.ts), with the long-conversation fixture in its one session — what the
 * recorded performance runs are made with. The demo source's script is off in it, and a smoke run
 * is never one. Always false in a release build.
 */
export const isStreamForm: boolean = !isSmokeRun && demoValue === 'stream';

/** Where the stream form's fixture is: the launcher's word (do-run-stream.bat), read behind the build flag as the switch is. */
export const demoFixture: string | undefined = __FATG_SMOKE_HOOKS__ ? process.env['FATG_DEMO_FIXTURE'] : undefined;
