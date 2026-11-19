// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { protectedVariables } from './variables';

const support = (variable: string) => ({ variable, defaultFolder: ['.x'], withhold: { names: [], prefixes: [] } });

describe('the variables no per-run override may set (M14b, C8)', () => {
  it('is every variable a definition declares, once each, and none for a module without the declaration', () => {
    expect(protectedVariables([{ instances: support('ONE_HOME') }, {}, { instances: support('TWO_HOME') }, { instances: support('ONE_HOME') }])).toEqual(['ONE_HOME', 'TWO_HOME']);
    expect(protectedVariables([{}, {}])).toEqual([]);
    expect(protectedVariables([])).toEqual([]);
  });
});
