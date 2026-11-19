// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A speed tier's words (decision 0016; the maintainer): after the level, the bolt and the tier's short name.
import { describe, expect, it } from 'vitest';
import { speedExplanation, speedName, speedRefusal, speedText, tierOf, withSpeed } from './speed-text';

const FAST = { id: 'priority', name: 'Fast' };
const ULTRA = { id: 'ultra-priority', name: 'Ultra fast' };

describe('a speed tier’s words', () => {
  it('names a tier short: Fast, and Ultra for Ultra fast', () => {
    expect([speedName(FAST), speedName(ULTRA), speedName({ id: 'x', name: 'fast' })]).toEqual(['Fast', 'Ultra', 'fast']);
    expect([speedText(FAST), speedText(ULTRA)]).toEqual(['⚡Fast', '⚡Ultra']);
  });

  it('says the level, then the tier, and the level alone at standard speed', () => {
    expect(withSpeed('Extra High', FAST)).toBe('Extra High - ⚡Fast');
    expect(withSpeed('Extra High', ULTRA)).toBe('Extra High - ⚡Ultra');
    expect(withSpeed('Extra High', undefined)).toBe('Extra High');
  });

  it('finds a speed’s tier among a model’s, by its id where the model no longer lists it', () => {
    expect(tierOf([FAST, ULTRA], 'ultra-priority')).toBe(ULTRA);
    expect(tierOf([FAST], 'gone')).toEqual({ id: 'gone', name: 'gone' });
    expect(tierOf([FAST], null)).toBeUndefined();
  });

  it('explains a tier by its cost, then its CLI’s words, and says why an account cannot ask for one', () => {
    expect(speedExplanation({ warning: 'Billed as extra usage, at a higher rate.', description: null })).toBe('Billed as extra usage, at a higher rate.');
    expect(speedExplanation({ description: '1.5x speed, increased usage' })).toBe('1.5x speed, increased usage');
    expect(speedExplanation({ description: null })).toBeUndefined();
    expect(speedRefusal({ possible: true, reason: null })).toBeNull();
    expect(speedRefusal({ possible: false, reason: 'preference' })).toBe('fat-g cannot ask this account for a faster tier (preference).');
  });
});
