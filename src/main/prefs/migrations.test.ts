// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Synthetic steps exercise the generic runner independently of the real revision-1 → 2 migration.
import { describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, type Migration, migrate } from './migrations';

const rename =
  (from: string, to: string): Migration =>
  (input) => {
    const { [from]: value, ...rest } = input;
    return { ...rest, [to]: value, schemaVersion: Number(input['schemaVersion']) + 1 };
  };

const steps: Record<number, Migration> = { 1: rename('a', 'b'), 2: rename('b', 'c') };

describe('migrate', () => {
  it('applies each step in order', () => {
    const result = migrate({ schemaVersion: 1, a: 'kept' }, 1, 3, steps);
    expect(result).toEqual({ ok: true, value: { schemaVersion: 3, c: 'kept' }, applied: [1, 2] });
  });

  it('stops at the version asked for', () => {
    const result = migrate({ schemaVersion: 1, a: 'kept' }, 1, 2, steps);
    expect(result).toEqual({ ok: true, value: { schemaVersion: 2, b: 'kept' }, applied: [1] });
  });

  it('does nothing for a file already at the current version', () => {
    const step = vi.fn();
    const file = { schemaVersion: 3, c: 'kept' };
    expect(migrate(file, 3, 3, { 3: step })).toEqual({ ok: true, value: file, applied: [] });
    expect(step).not.toHaveBeenCalled();
  });

  it('reports the version it cannot get past, rather than guessing', () => {
    expect(migrate({ schemaVersion: 1 }, 1, 4, steps)).toEqual({ ok: false, stuckAt: 3 });
  });

  it('gives up before running anything when the first step is missing', () => {
    const later = vi.fn();
    expect(migrate({ schemaVersion: 5 }, 5, 7, { 6: later })).toEqual({ ok: false, stuckAt: 5 });
    expect(later).not.toHaveBeenCalled();
  });

  it('reports a migration that throws without returning a partial document', () => {
    const broken: Migration = () => { throw new Error('migration bug'); };
    expect(migrate({ schemaVersion: 1, secretFutureField: 'kept only in the original' }, 1, 2, { 1: broken }))
      .toEqual({ ok: false, stuckAt: 1 });
  });
});

describe('the real migration map', () => {
  it('establishes the revision-2 compatibility envelope without dropping fields', () => {
    expect(MIGRATIONS[1]?.({ schemaVersion: 1, future: { kept: true } })).toEqual({
      schemaVersion: 2,
      minReaderVersion: 2,
      future: { kept: true },
    });
  });
});
