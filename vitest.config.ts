// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const alias = { '@shared': resolve(import.meta.dirname, 'src/shared') };

/**
 * The tests that launch real processes: the process layer's own (tests/process/), the Claude and
 * Codex adapters against their fake CLIs (M7, M15, M16), the tests that hold the fakes themselves
 * to their captures and accounts (tests/fakes/), the two providers side by side (M16), and the
 * conversation store's killed-writer tests (M18). They are a project of their own, below.
 */
const PROCESS_TREES = [
  'tests/process/**/*.test.ts', 'tests/claude/**/*.test.ts', 'tests/codex/**/*.test.ts', 'tests/conversations/**/*.test.ts',
  'tests/fakes/**/*.test.ts', 'tests/sessions/parity.test.ts',
] as const;

/**
 * A test's time limit in every project, where Vitest's own is 5 s. These tests wait on what they
 * do, never on a guess at how long it takes, so the limit only ends a test that hangs. Many write
 * real files or end a process tree: a write that waits for the disk is two milliseconds on a quiet
 * machine and now and then a second or more on a busy one, and the limit leaves room for that. The
 * adapters' harnesses set a longer one of their own. The page's tests have it too since M19: one
 * that fills a chat's window draws some five hundred messages, each read as Markdown, which is two
 * seconds on the development machine and passed five on a CI runner.
 */
const TEST_TIMEOUT_MS = 20_000;

export default defineConfig({
  test: {
    projects: [
      {
        // Main process, preload, shared contracts and repo-level tests run in plain Node — no
        // Electron. That is why security-critical logic lives in pure modules (origins, csp,
        // protocol-path, ipc/sender-policy, ipc/dispatch, state/projection).
        resolve: { alias },
        // Tests exercise the development flavor (src/main/build-flags.d.ts).
        define: { __FATG_SMOKE_HOOKS__: 'true' },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'src/shared/**/*.test.ts', 'tests/**/*.test.ts'],
          exclude: PROCESS_TREES.map((pattern) => pattern.replace('/**/*.test.ts', '/**')),
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        // Every test that launches real process trees: the process layer's own, each adapter against
        // its fake CLI, and the two providers side by side. They run after the two projects above,
        // a few files at a time, so that neither they nor the timing tests elsewhere wait on a
        // starved machine: a tree's forced end takes a second or two, and many at once take longer
        // than a test's five.
        resolve: { alias },
        define: { __FATG_SMOKE_HOOKS__: 'true' },
        test: {
          name: 'process-trees',
          environment: 'node',
          include: [...PROCESS_TREES],
          testTimeout: TEST_TIMEOUT_MS,
          sequence: { groupOrder: 1 },
          maxWorkers: 3,
        },
      },
      {
        resolve: { alias },
        plugins: [react()],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          // And the page with a full window while a message is written into it (M19, C52): tests/chat/.
          include: ['src/renderer/**/*.test.{ts,tsx}', 'tests/chat/**/*.test.tsx'],
          // CSS reaches tests empty, except the tokens: the theme tests compute styles from the real ones.
          css: { include: [/styles[\\/]tokens\.css/] },
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});
