// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6: the name rule of decision 0011, item 6 (docs/planning/_archive/M12.md, C16).
import { describe, expect, it } from 'vitest';
import { limitPresetNameInput, NAME_MAX_GRAPHEMES, normalizeName, normalizePresetName, normalizeSessionName, normalizeText, SESSION_NAME_MAX_GRAPHEMES } from './names';

describe('normalizeName', () => {
  it.each([
    ['trims the ends', '  fat-g  ', 'fat-g'],
    ['collapses a run of spaces', 'my   project', 'my project'],
    ['turns tabs and line breaks into one space', 'my\t\tproject\r\nnotes', 'my project notes'],
    ['counts Unicode spaces as whitespace', 'my  project', 'my project'],
    ['removes the remaining control characters', 'a\u0000b\u007fc\u009fd', 'abcd'],
    ['leaves no double space where a control character stood', 'a \u0000 b', 'a b'],
    ['keeps letters of every script and emoji', 'Café 東京 👩‍💻', 'Café 東京 👩‍💻'],
  ])('%s', (_name, input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it.each([['an empty string', ''], ['only whitespace', ' \t\r\n '], ['only control characters', '\u0000\u0007']])('makes %s empty', (_name, input) => {
    expect(normalizeName(input)).toBe('');
  });

  it('keeps a name of exactly 60 grapheme clusters whole', () => {
    const name = 'a'.repeat(NAME_MAX_GRAPHEMES);
    expect(normalizeName(name)).toBe(name);
  });

  it('cuts a longer name to its first 59 clusters and "…"', () => {
    expect(normalizeName('b'.repeat(61))).toBe(`${'b'.repeat(59)}…`);
  });

  it('counts grapheme clusters, not code units: a family emoji is one', () => {
    const family = '👨‍👩‍👧‍👦';
    const name = family.repeat(61);
    const result = normalizeName(name);
    expect(result).toBe(`${family.repeat(59)}…`);
    expect(normalizeName(family.repeat(60))).toBe(family.repeat(60));
  });

  it('never splits a combining sequence', () => {
    const accented = 'é';
    expect(normalizeName(accented.repeat(70))).toBe(`${accented.repeat(59)}…`);
  });

  it('is the same after a second pass', () => {
    for (const input of ['  x  y ', 'z'.repeat(80), 'a\u0000 b']) expect(normalizeName(normalizeName(input))).toBe(normalizeName(input));
  });
});

describe('preset names', () => {
  it('limits only preset names to 18 visible characters, keeping Unicode clusters whole', () => {
    for (const cluster of ['a', '👩‍💻', 'é']) {
      expect(normalizePresetName(cluster.repeat(18))).toBe(cluster.repeat(18));
      expect(normalizePresetName(cluster.repeat(19))).toBe(`${cluster.repeat(17)}…`);
      expect(limitPresetNameInput(cluster.repeat(19))).toBe(cluster.repeat(18));
    }
    expect(normalizePresetName('  Careful\n review\u0000 ')).toBe('Careful review');
    expect(normalizeName('a'.repeat(60))).toBe('a'.repeat(60));
  });

  it('keeps a trailing space while typing, and counts cleaned names rather than pasted whitespace', () => {
    expect(limitPresetNameInput('Review ')).toBe('Review ');
    expect(limitPresetNameInput('  Review   carefully  ')).toBe('Review carefully ');
    expect(normalizePresetName(limitPresetNameInput('  Review   carefully  '))).toBe('Review carefully');
  });
});

describe('normalizeSessionName', () => {
  it('keeps a descriptive title whole without widening project names', () => {
    const title = 'x'.repeat(SESSION_NAME_MAX_GRAPHEMES);
    expect(normalizeSessionName(title)).toBe(title);
    expect(normalizeName(title)).toBe(`${'x'.repeat(59)}…`);
    expect(normalizeSessionName('  A longer\n title\u0000  ')).toBe('A longer title');
  });

  it('cuts at 160 graphemes without splitting an emoji or a combining sequence', () => {
    for (const cluster of ['👩‍💻', 'é']) {
      expect(normalizeSessionName(cluster.repeat(161))).toBe(`${cluster.repeat(159)}…`);
    }
  });
});

// M13, C9: the catalog cleans a CLI's and the override's text with the same rule, at its own lengths.
describe('normalizeText', () => {
  it('is the name rule at any length', () => {
    expect(normalizeText('  a\tb  ', 200)).toBe('a b');
    expect(normalizeText('d'.repeat(200), 200)).toBe('d'.repeat(200));
    expect(normalizeText('d'.repeat(201), 200)).toBe(`${'d'.repeat(199)}…`);
    for (const input of ['  x  y ', 'z'.repeat(80), 'a\u0000 b']) expect(normalizeText(input, NAME_MAX_GRAPHEMES)).toBe(normalizeName(input));
  });
});
