// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1, the test-runner leg: the same check, run by vitest in plain Node as `npm test` runs the
// main process's tests (vitest.config.ts, the `node` project).
import { writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { storeCheck } from './lib/store-check.mjs';

test('node:sqlite creates, commits and reopens a store under the test runner', async () => {
  const out = process.env['FATG_SPIKE_OUT'];
  const dir = process.env['FATG_SPIKE_DIR'];
  if (!out || !dir) throw new Error('run through spikes/m18/k1.mjs');
  const report = await storeCheck(dir);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  expect(report.ok).toBe(true);
});
