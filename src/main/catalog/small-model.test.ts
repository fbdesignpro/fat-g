// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { sampleModel } from '../../../tests/support/catalog';
import { latestSmallModel } from './small-model';

const version = (id: string) => /^small-\d+\.\d+$/.test(id) ? id.slice(6).split('.').map(Number) : null;
const model = (key: string, extra: Parameters<typeof sampleModel>[0] = {}) => sampleModel({ key, resolvedId: key, ...extra });

describe('latest small model selection', () => {
  it('compares versions numerically using the resolved identity and returns the CLI selection key', () => {
    expect(latestSmallModel([
      model('small-6.9'), model('rolling', { resolvedId: 'small-6.10' }), model('large-7.0'),
    ], version)).toBe('rolling');
  });

  it('leaves hidden, override-only and unrecognized models out, and keeps CLI order on ties', () => {
    expect(latestSmallModel([
      model('small-8.0', { hidden: true }), model('small-9.0', { origin: 'override' }),
      model('first', { resolvedId: 'small-6.0' }), model('second', { resolvedId: 'small-6.0' }),
    ], version)).toBe('first');
    expect(latestSmallModel([model('large-7.0')], version)).toBeUndefined();
    expect(latestSmallModel([model('small-6.0')], undefined)).toBeUndefined();
  });

  it('uses the key when no resolved identity is reported and rejects invalid version components', () => {
    expect(latestSmallModel([model('small-6.1', { resolvedId: null })], version)).toBe('small-6.1');
    for (const invalid of [[NaN], [Infinity], [-1], [0.5]]) {
      expect(latestSmallModel([model('small')], () => invalid)).toBeUndefined();
    }
  });
});
