// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Records the baselines into tests/fixtures/baselines/ (decision 0014, item 4), run by
// do-record-baselines.bat with FATG_RECORD_BASELINES set; skipped in every other run. It writes
// the baseline of each format this build has none of at the version it writes, and replaces no
// file: before the first release a format's raise deletes the old version's file first, and after
// it the old file stays, read by migration, and the new one joins it.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINES_DIR, FORMATS, recordBaselines } from './record';

const RECORDING = process.env['FATG_RECORD_BASELINES'] === '1';

describe.runIf(RECORDING)('recording the baselines (do-record-baselines.bat)', () => {
  it('writes the baseline of each format this build has none of at its version, and replaces none', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'fatg-baselines-'));
    try {
      await recordBaselines(scratch);
      const written: string[] = [];
      const kept: string[] = [];
      for (const format of FORMATS) {
        const target = path.join(BASELINES_DIR, format.file);
        if (existsSync(target)) {
          kept.push(format.file);
          continue;
        }
        copyFileSync(path.join(scratch, format.file), target);
        written.push(format.file);
      }
      console.log(`Recorded ${written.length === 0 ? 'nothing: every format has its baseline' : written.join(', ')}.${kept.length === 0 ? '' : ` Kept as committed: ${kept.join(', ')}.`}`);
      expect(written.length + kept.length).toBe(FORMATS.length);
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe.skipIf(RECORDING)('the recorder', () => {
  it('is skipped unless FATG_RECORD_BASELINES is set', () => {
    expect(RECORDING).toBe(false);
  });
});
