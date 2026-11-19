// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V20's files (docs/planning/_archive/M13.md, Manual): the maintainer copies each of these by hand into the
// development data folder as catalog.json. This keeps each one saying what the review expects.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOverride } from '../../src/main/catalog/override';

const read = (name: string) => readOverride(path.resolve('tests/fixtures/catalog', name), new Set(['claude', 'codex']));

describe('the visual review’s override files', () => {
  it('applied.json is applied, and names the provider it skips', () => {
    expect(read('applied.json')).toMatchObject({ kind: 'applied', unknownProviders: ['gemini'] });
  });

  it.each([['not-json.json', 'not-json', null], ['newer.json', 'newer', null], ['invalid-field.json', 'invalid', 'providers.codex.models.gpt-5.5.hidden']] as const)('%s is ignored as %s', (name, cause, field) => {
    expect(read(name)).toMatchObject({ kind: 'ignored', cause, field });
  });
});
