// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The chooser grows vertically before splitting each provider across columns.
import { describe, expect, it } from 'vitest';
import { ACCOUNT_HEIGHT, ACCOUNT_WIDTH, chooserShape, columnLeft, HEADING_GAP, HEADING_HEIGHT, LEVEL_HEIGHT, LEVELS_GAP, LEVELS_WIDTH, MIN_TILE_WIDTH, spanWidth, TILE_GAP, TILE_HEIGHT, TILE_WIDTH } from './chooser-shape';

/** About what the model picker leaves its chooser in the minimum window, 1120 × 640, and in a large one. */
const MINIMUM = { width: 1080, height: 490 };
const LARGE = { width: 1880, height: 960 };
/** The capsules beside the levels: what is not capsules in the chooser's width. */
const LEVELS = LEVELS_GAP + LEVELS_WIDTH;
/** How tall `rows` capsules are, down one column. */
const tall = (rows: number) => rows * TILE_HEIGHT + (rows - 1) * TILE_GAP;
/** How wide each of `columns` capsules is once they are narrowed to the minimum window's width. */
const narrowed = (columns: number) => Math.floor((MINIMUM.width - LEVELS - (columns - 1) * TILE_GAP) / columns);
const summary = (groups: number[], space = MINIMUM) => {
  const shape = chooserShape(groups, space);
  return { rows: shape.rows, columns: shape.columns.map((column) => `${column.group}:${column.from}+${column.count}${column.first ? '*' : ''}`), tileWidth: shape.tileWidth };
};

describe('a capsule', () => {
  it('holds the 60 px avatar in its frame, with room for a name and two lines of description beside it', () => {
    expect([TILE_WIDTH, TILE_HEIGHT, TILE_GAP, MIN_TILE_WIDTH]).toEqual([224, 62, 8, 150]);
    expect(spanWidth(3, TILE_WIDTH)).toBe(3 * 224 + 2 * 8);
    expect(columnLeft(2, TILE_WIDTH)).toBe(2 * 232);
  });
});

describe('columns revealed by Show more', () => {
  it('starts with one column per provider and at most eight capsules even in a tall window', () => {
    const shape = chooserShape([3, 20], LARGE, 0, [], false, [1, 1]);
    expect(shape.rows).toBe(8);
    expect(shape.columns.map(({ group, from, count }) => [group, from, count])).toEqual([[0, 0, 3], [1, 0, 8]]);
    const dialog = chooserShape([20], { width: LARGE.width, height: 0 }, 0, [], true, [1]);
    expect(dialog.rows).toBe(8);
    expect(dialog.columns.map((column) => column.count)).toEqual([8]);
  });

  it('reveals an additional column for just the requested provider and reserves room for Show more', () => {
    const shape = chooserShape([20, 20], LARGE, 0, [], false, [1, 2]);
    expect(shape.columns.map(({ group, from, count }) => [group, from, count])).toEqual([[0, 0, 8], [1, 0, 8], [1, 8, 8]]);
    expect(shape.height).toBe(HEADING_HEIGHT + HEADING_GAP + tall(8) + 40);
    const short = chooserShape([20], MINIMUM, 0, [], false, [1]);
    expect(short.columns).toHaveLength(1);
    expect(short.height).toBeLessThanOrEqual(MINIMUM.height);
    expect(short.rows).toBeLessThanOrEqual(8);
  });
});

describe('one column per provider while its models fit vertically', () => {
  it.each<[string, number[], string[]]>([
    ['one provider, three capsules', [3], ['0:0+3*']],
    ['three and nine', [3, 9], ['0:0+3*', '1:0+9*']],
    ['exactly as many as the height holds', [13], ['0:0+13*']],
    ['two providers, one of them taller than the space', [4, 23], ['0:0+4*', '1:0+13*', '1:13+10']],
    ['a provider with no capsule has no column', [0, 5, 0], ['1:0+5*']],
    ['no capsule at all', [], []],
  ])('%s', (_name, groups, columns) => {
    const shape = summary(groups, LARGE);
    expect(shape.columns).toEqual(columns);
    expect(shape.rows).toBe(Math.min(13, Math.max(1, ...groups)));
    expect(shape.tileWidth).toBe(TILE_WIDTH);
  });

  it('adds a column only after the available height fills', () => {
    expect([5, 13, 14, 26, 27, 39, 40].map((count) => chooserShape([count], LARGE).columns.length)).toEqual([1, 1, 2, 2, 3, 3, 4]);
  });
});

describe('in the minimum window', () => {
  it('fits twelve models in two columns at full size beside the levels', () => {
    const shape = chooserShape([12], MINIMUM);
    expect(shape.columns).toHaveLength(2);
    expect(shape.rows).toBe(6);
    expect(shape.tileWidth).toBe(TILE_WIDTH);
    expect(shape.width).toBe(spanWidth(2, TILE_WIDTH) + LEVELS);
    expect(shape.width).toBeLessThanOrEqual(MINIMUM.width);
    expect(shape.height).toBe(HEADING_HEIGHT + HEADING_GAP + tall(6));
    expect(shape.height).toBeLessThanOrEqual(MINIMUM.height);
  });

  it('uses all available rows before adding columns', () => {
    expect(summary([13])).toEqual({ rows: 6, columns: ['0:0+6*', '0:6+6', '0:12+1'], tileWidth: TILE_WIDTH });
    expect(summary([6, 6, 6])).toEqual({ rows: 6, columns: ['0:0+6*', '1:0+6*', '2:0+6*'], tileWidth: TILE_WIDTH });
  });

  it('narrows the columns only past the height, and never below the least a capsule can be', () => {
    // Six rows is all the space holds: 19 models make a fourth column, which three full ones leave no room for.
    expect(chooserShape([18], MINIMUM).tileWidth).toBe(TILE_WIDTH);
    const shape = chooserShape([19], MINIMUM);
    expect(shape.rows).toBe(6);
    expect(shape.columns).toHaveLength(4);
    expect(shape.tileWidth).toBe(narrowed(4));
    expect(shape.tileWidth).toBeLessThan(TILE_WIDTH);
    expect(shape.width).toBeLessThanOrEqual(MINIMUM.width);
    // The catalog's most: 200 models from one provider. Past the least a capsule can be, more rows than
    // the height holds — never capsules under the levels.
    const most = chooserShape([200], MINIMUM);
    expect(most.tileWidth).toBeGreaterThanOrEqual(MIN_TILE_WIDTH);
    expect(most.width).toBeLessThanOrEqual(MINIMUM.width);
    expect(most.rows).toBe(Math.ceil(200 / Math.floor((MINIMUM.width - LEVELS + TILE_GAP) / (MIN_TILE_WIDTH + TILE_GAP))));
    expect(most.height).toBeGreaterThan(MINIMUM.height);
  });
});

describe('where what holds it scrolls', () => {
  it('is as it would be anywhere while full-size capsules fit', () => {
    expect(chooserShape([12], MINIMUM, 0, [], true)).toEqual(chooserShape([12], MINIMUM));
  });

  it('keeps the capsules at full width and takes more rows than the height, instead of narrowing them', () => {
    // Narrowed, nineteen models take four columns of six; scrolled, three full columns of seven.
    expect(chooserShape([19], MINIMUM).tileWidth).toBeLessThan(TILE_WIDTH);
    const shape = chooserShape([19], MINIMUM, 0, [], true);
    expect([shape.rows, shape.columns.length, shape.tileWidth]).toEqual([7, 3, TILE_WIDTH]);
    expect(shape.width).toBeLessThanOrEqual(MINIMUM.width);
    // Four providers in a space three full columns wide: each in one column, as tall as its list.
    const four = chooserShape([10, 12, 4, 6], MINIMUM, 0, [], true);
    expect(four.tileWidth).toBeLessThan(TILE_WIDTH);
    expect(four.rows).toBe(12);
    expect(four.width).toBeLessThanOrEqual(MINIMUM.width);
  });
});

describe('in a larger window', () => {
  it('uses the larger height to keep each provider in fewer columns', () => {
    const shape = chooserShape([39], LARGE);
    expect(shape.rows).toBe(13);
    expect(shape.columns).toHaveLength(3);
    expect(shape.tileWidth).toBe(TILE_WIDTH);
    expect(shape.width).toBeLessThanOrEqual(LARGE.width);
  });

  it('is only as large as its capsules need', () => {
    const shape = chooserShape([3, 9], LARGE);
    expect(shape.width).toBe(spanWidth(2, TILE_WIDTH) + LEVELS);
    expect(shape.height).toBe(HEADING_HEIGHT + HEADING_GAP + tall(9));
  });
});

describe('its height', () => {
  it('follows the tallest column, or the levels when they are taller', () => {
    expect(chooserShape([2], MINIMUM, 0).height).toBe(HEADING_HEIGHT + HEADING_GAP + tall(2));
    expect(chooserShape([2], MINIMUM, 6).height).toBe(HEADING_HEIGHT + HEADING_GAP + 6 * LEVEL_HEIGHT);
    expect(chooserShape([5], MINIMUM, 6).height).toBe(HEADING_HEIGHT + HEADING_GAP + tall(5));
  });

  it('has room for its one sentence with no capsule at all', () => {
    const shape = chooserShape([], MINIMUM);
    expect(shape.columns).toEqual([]);
    expect(shape.width).toBe(TILE_WIDTH + LEVELS);
    expect(shape.height).toBe(HEADING_HEIGHT + HEADING_GAP + TILE_HEIGHT);
  });
});

// M14b, V12 (C44, C45): the band of account buttons under the providers' names.
describe('the account buttons’ band (M14b; C44, C45)', () => {
  it('is none with one account for each provider', () => {
    for (const groups of [[3], [3, 9], [18], [4, 23], [61]]) {
      const before = chooserShape(groups, MINIMUM, 4);
      expect(before.band).toBe(0);
      expect(chooserShape(groups, MINIMUM, 4, groups.map(() => 0))).toEqual(before);
      // One account is no control either.
      expect(chooserShape(groups, MINIMUM, 4, groups.map(() => 1))).toEqual(before);
    }
  });

  it('is one line when a provider’s buttons fit across its columns, and adds exactly that to the height', () => {
    expect([ACCOUNT_WIDTH, ACCOUNT_HEIGHT]).toEqual([96, 24]);
    const plain = chooserShape([3, 9], MINIMUM);
    const shape = chooserShape([3, 9], MINIMUM, 0, [0, 2]);
    expect(shape.band).toBe(ACCOUNT_HEIGHT);
    expect(shape.height).toBe(plain.height + ACCOUNT_HEIGHT);
    expect(shape.width).toBe(plain.width);
    expect(shape.columns).toEqual(plain.columns);
  });

  it.each<[string, number[], number[], number]>([
    ['three accounts on one column wrap to two lines', [5], [3], 2],
    ['eight accounts on one column take four lines', [5], [8], 4],
    ['eight accounts on a provider with two columns take two lines', [12], [8], 2],
    ['eight accounts on a provider with four columns take one line', [24], [8], 1],
    ['the provider that needs the most lines sets the band for all', [5, 12], [8, 8], 4],
    ['a provider with no capsule shows no button, so it asks for no line', [0, 5], [8, 2], 1],
  ])('wraps the buttons within their provider’s columns: %s', (_name, groups, accounts, lines) => {
    expect(chooserShape(groups, MINIMUM, 0, accounts).band).toBe(lines * ACCOUNT_HEIGHT);
  });

  it('fits the models and the account bands within the minimum window', () => {
    for (const [groups, accounts] of [[[18], [8]], [[6, 6], [8, 0]], [[5, 12], [8, 8]]] as const) {
      const shape = chooserShape(groups, MINIMUM, 6, accounts);
      expect(shape.width).toBeLessThanOrEqual(MINIMUM.width);
      expect(shape.height).toBe(HEADING_HEIGHT + HEADING_GAP + shape.band + tall(Math.max(...shape.columns.map((column) => column.count))));
      expect(shape.height).toBeLessThanOrEqual(MINIMUM.height);
    }
  });

  it('gives the band its height before the capsules take more rows: the chooser stays inside its space', () => {
    // Six models took six rows without a band; with four lines of buttons, five fit, in two columns.
    const plain = chooserShape([6], MINIMUM);
    const shape = chooserShape([6], MINIMUM, 0, [8]);
    expect(plain.rows).toBe(6);
    expect(shape.band).toBeGreaterThan(0);
    expect(shape.rows).toBe(5);
    expect(shape.columns).toHaveLength(2);
    expect(shape.height).toBeLessThanOrEqual(MINIMUM.height);
  });
});
