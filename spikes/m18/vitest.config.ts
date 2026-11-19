// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The repository's `node` test project (vitest.config.ts), with this spike's one test in place of
// the app's: the same runner, the same environment.
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  test: {
    name: 'm18-spike',
    environment: 'node',
    include: ['spikes/m18/**/*.test.ts'],
  },
});
