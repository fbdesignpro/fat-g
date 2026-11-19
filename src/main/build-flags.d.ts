// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Replaced by the build (electron.vite.config.ts `define`, and vitest.config.ts for tests).

/**
 * True unless this is a release package (scripts/package.mjs). Guard smoke-only code with it
 * directly — `if (__FATG_SMOKE_HOOKS__ && …)` — so a release bundle drops that code entirely.
 */
declare const __FATG_SMOKE_HOOKS__: boolean;
