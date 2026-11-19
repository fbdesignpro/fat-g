// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V30 (pure) and V22's arithmetic: where a drop lands, how the list makes room, and what a move does
// (docs/planning/_archive/M12.md, Design 10; C68, C72, C74, C75, C86).
import { describe, expect, it } from 'vitest';
import { project, unreadable } from '../test/records';
import { applyMove, dropAt, HIDDEN_ROW, isOwnPlace, type ListLayout, makeRoom, positionText, stepMove } from './reorder';

// Four visible rows of 36 px (one unreadable), the hidden row, and two hidden projects below it.
const A = project('a');
const B = project('b');
const X = unreadable('x');
const C = project('c');
const H1 = project('h1', { hidden: true });
const H2 = project('h2', { hidden: true });
const ENTRIES = [A, H1, B, X, C, H2];

function layout(hiddenOpen: boolean, overrides: Partial<ListLayout> = {}): ListLayout {
  const visible = [A, B, X, C].map((entry, index) => ({ key: entry.key, group: 'visible' as const, top: index * 36, bottom: index * 36 + 36 }));
  const hidden = hiddenOpen ? [H1, H2].map((entry, index) => ({ key: entry.key, group: 'hidden' as const, top: 180 + index * 36, bottom: 216 + index * 36 })) : [];
  return { entries: [...visible, ...hidden], hiddenRow: { top: 144, bottom: 180 }, hiddenOpen, firstHidden: H1.key, ...overrides };
}

describe('dropAt', () => {
  it.each([
    ['above the first entry', 5, A.key],
    ['below the middle of the first', 20, B.key],
    ['just above the unreadable entry', 85, X.key],
    ['just below it: an unreadable entry has gaps around it', 110, C.key],
    ['below the last visible entry', 130, null],
  ])('finds the visible gap %s', (_name, y, before) => {
    expect(dropAt(layout(false), y)).toEqual({ hidden: false, before, row: false });
  });

  it('makes the hidden row a target: hidden, first in the hidden list (C75)', () => {
    expect(dropAt(layout(false), 150)).toEqual({ hidden: true, before: H1.key, row: true });
    // Below a closed row is the row.
    expect(dropAt(layout(false), 400)).toEqual({ hidden: true, before: H1.key, row: true });
  });

  it('makes the row a target with nothing hidden yet: last, which is first', () => {
    expect(dropAt(layout(false, { firstHidden: null }), 150)).toEqual({ hidden: true, before: null, row: true });
  });

  it.each([
    ['above the first hidden entry', 185, H1.key],
    ['between the hidden entries', 210, H2.key],
    ['below the last one', 250, null],
  ])('finds the gap in the open hidden list %s (C74)', (_name, y, before) => {
    expect(dropAt(layout(true), y)).toEqual({ hidden: true, before, row: false });
  });

  it('puts every drop in the visible gaps when there is no hidden row', () => {
    expect(dropAt(layout(false, { hiddenRow: null }), 500)).toEqual({ hidden: false, before: null, row: false });
  });

  it('finds the only visible gap of an empty group', () => {
    expect(dropAt({ entries: [], hiddenRow: { top: 0, bottom: 36 }, hiddenOpen: false, firstHidden: null }, -5)).toEqual({ hidden: false, before: null, row: false });
  });
});

// C86: the entries between a dragged project and its target move one header's height towards its old
// place, which closes it and opens the gap. Rows as laid out: a, b, x, c, the hidden row, h1, h2.
describe('makeRoom (C86)', () => {
  const room = (open: boolean, dragged: string, target: { hidden: boolean; before: string | null; row?: boolean }) => {
    const { shifts, gap } = makeRoom(layout(open), dragged, { row: false, ...target });
    return { shifts: Object.fromEntries(shifts), gap };
  };
  const at = (top: number) => ({ top, bottom: top + 36 });

  it.each([
    ['down: the entries on the way move up', A.key, { hidden: false, before: C.key }, { [B.key]: -36, [X.key]: -36 }, at(72)],
    ['up: the entries on the way move down', C.key, { hidden: false, before: B.key }, { [B.key]: 36, [X.key]: 36 }, at(36)],
    ['to the end of the visible group, before the hidden row', A.key, { hidden: false, before: null }, { [B.key]: -36, [X.key]: -36, [C.key]: -36 }, at(108)],
    ['past an unreadable entry, which moves too', C.key, { hidden: false, before: X.key }, { [X.key]: 36 }, at(72)],
  ] as const)('opens the gap %s', (_name, dragged, target, shifts, gap) => {
    expect(room(false, dragged, target)).toEqual({ shifts, gap });
  });

  it.each([
    ['before itself', B.key],
    ['before the entry after it', X.key],
  ])('moves nothing for its own place (%s): the gap is its place', (_name, before) => {
    expect(room(false, B.key, { hidden: false, before })).toEqual({ shifts: {}, gap: at(36) });
  });

  it('closes its place and draws no gap on a closed hidden row, which lights up instead (C75)', () => {
    expect(room(false, A.key, { hidden: true, before: H1.key, row: true })).toEqual({
      shifts: { [B.key]: -36, [X.key]: -36, [C.key]: -36, [HIDDEN_ROW]: -36 },
      gap: null,
    });
  });

  it('opens the gap under the hidden row when its list is open: first in the hidden list (C74, C75)', () => {
    expect(room(true, B.key, { hidden: true, before: H1.key, row: true })).toEqual({
      shifts: { [X.key]: -36, [C.key]: -36, [HIDDEN_ROW]: -36 },
      gap: at(144),
    });
  });

  it('moves the hidden row and the entries between, both ways across it (C74)', () => {
    expect(room(true, H2.key, { hidden: false, before: A.key })).toEqual({
      shifts: { [A.key]: 36, [B.key]: 36, [X.key]: 36, [C.key]: 36, [HIDDEN_ROW]: 36, [H1.key]: 36 },
      gap: at(0),
    });
    expect(room(true, A.key, { hidden: true, before: null })).toEqual({
      shifts: { [B.key]: -36, [X.key]: -36, [C.key]: -36, [HIDDEN_ROW]: -36, [H1.key]: -36, [H2.key]: -36 },
      gap: at(216),
    });
  });

  it('makes no room for an entry it cannot find', () => {
    expect(room(false, 'gone', { hidden: false, before: null })).toEqual({ shifts: {}, gap: null });
  });
});

// M100 (C61, V16): the projects stand --gap-grid apart, and an entry is as tall as its header and its
// sessions. Each item passed moves by the dragged one's height and the gap after it, so the drop puts
// every item where the preview had it, and nothing jumps.
describe('makeRoom over a spaced list (M100, C61)', () => {
  const GAP = 8;
  const HEIGHTS: Readonly<Record<string, number>> = { a: 100, b: 36, x: 36, c: 60, row: 36, h1: 80 };
  /** Where each key stands, top to bottom, `GAP` apart. */
  const laid = (keys: readonly string[]): Map<string, { top: number; bottom: number }> => {
    const boxes = new Map<string, { top: number; bottom: number }>();
    let top = 0;
    for (const key of keys) {
      const height = HEIGHTS[key] ?? 0;
      boxes.set(key, { top, bottom: top + height });
      top += height + GAP;
    }
    return boxes;
  };
  const spaced = (keys: readonly string[], row = false): ListLayout => {
    const boxes = laid(row ? [...keys, 'row', 'h1'] : keys);
    const entries = [...keys, ...(row ? ['h1'] : [])].map((key) => ({ key, group: key === 'h1' ? 'hidden' as const : 'visible' as const, ...(boxes.get(key) ?? { top: 0, bottom: 0 }) }));
    return { entries, hiddenRow: row ? boxes.get('row') ?? null : null, hiddenOpen: row, firstHidden: row ? 'h1' : null };
  };
  /** The visible keys after a move, as main puts them. */
  const moved = (keys: readonly string[], dragged: string, before: string | null): string[] => {
    const rest = keys.filter((key) => key !== dragged);
    const at = before === null ? rest.length : rest.indexOf(before);
    return [...rest.slice(0, at), dragged, ...rest.slice(at)];
  };
  const KEYS = ['a', 'b', 'x', 'c'];

  it.each([
    ['down, past two', 'a', 'c'],
    ['down, to the end', 'a', null],
    ['up, past two', 'c', 'b'],
    ['up, to the start', 'c', 'a'],
    ['the last one, whose gap is the one before it', 'c', 'b'],
    ['a short one past a tall one', 'b', 'c'],
  ] as const)('moves each item passed by the dragged one’s height and the gap, and the drop leaves every item where the preview had it (%s)', (_name, dragged, before) => {
    const was = laid(KEYS);
    const after = laid(moved(KEYS, dragged, before));
    const { shifts, gap } = makeRoom(spaced(KEYS), dragged, { hidden: false, before, row: false });
    expect(shifts.size).toBeGreaterThan(0);
    for (const [key, shift] of shifts) {
      expect((was.get(key)?.top ?? NaN) + shift, key).toBe(after.get(key)?.top);
      expect(Math.abs(shift)).toBe((HEIGHTS[dragged] ?? 0) + GAP);
    }
    // The gap is where the dropped entry will stand.
    expect(gap).toEqual(after.get(dragged));
  });

  it('moves the hidden row by the same, with the gap that follows the dragged entry', () => {
    const { shifts } = makeRoom(spaced(KEYS, true), 'b', { hidden: false, before: null, row: false });
    expect(Object.fromEntries(shifts)).toEqual({ x: -(36 + GAP), c: -(36 + GAP) });
    const across = makeRoom(spaced(KEYS, true), 'a', { hidden: true, before: 'h1', row: true });
    expect(Object.fromEntries(across.shifts)).toEqual({ b: -(100 + GAP), x: -(100 + GAP), c: -(100 + GAP), [HIDDEN_ROW]: -(100 + GAP) });
  });
});

describe('isOwnPlace (C68)', () => {
  it('knows the gaps on either side of a project in its group', () => {
    expect(isOwnPlace(ENTRIES, B.key, { hidden: false, before: B.key })).toBe(true);
    expect(isOwnPlace(ENTRIES, B.key, { hidden: false, before: X.key })).toBe(true);
    expect(isOwnPlace(ENTRIES, C.key, { hidden: false, before: null })).toBe(true);
    expect(isOwnPlace(ENTRIES, H1.key, { hidden: true, before: H1.key })).toBe(true);
    expect(isOwnPlace(ENTRIES, H2.key, { hidden: true, before: null })).toBe(true);
  });

  it('knows a place elsewhere, or in the other group', () => {
    expect(isOwnPlace(ENTRIES, B.key, { hidden: false, before: A.key })).toBe(false);
    expect(isOwnPlace(ENTRIES, C.key, { hidden: true, before: null })).toBe(false);
    expect(isOwnPlace(ENTRIES, H1.key, { hidden: false, before: null })).toBe(false);
  });
});

describe('applyMove: main’s rules', () => {
  const names = (entries: readonly (typeof ENTRIES)[number][]) => entries.map((entry) => (entry.kind === 'project' ? `${entry.name}${entry.hidden ? '*' : ''}` : '?'));

  it.each([
    ['before another entry', A.key, false, C.key, ['h1*', 'b', '?', 'a', 'c', 'h2*']],
    ['to the end of its group', A.key, false, null, ['h1*', 'b', '?', 'c', 'a', 'h2*']],
    ['across the hidden row, hiding it', B.key, true, H1.key, ['a', 'b*', 'h1*', '?', 'c', 'h2*']],
    ['to the end of the hidden list', A.key, true, null, ['h1*', 'b', '?', 'c', 'h2*', 'a*']],
    ['back among the visible, showing it', H2.key, false, A.key, ['h2', 'a', 'h1*', 'b', '?', 'c']],
  ] as const)('moves a project %s', (_name, key, hidden, before, expected) => {
    expect(names(applyMove(ENTRIES, key, hidden, before))).toEqual(expected);
  });

  it('never moves an unreadable entry', () => {
    expect(applyMove(ENTRIES, X.key, false, A.key)).toBe(ENTRIES);
  });
});

describe('stepMove and positionText (C72)', () => {
  it('moves one place within the group, passing entries of the other group', () => {
    expect(stepMove(ENTRIES, B.key, -1)).toEqual({ hidden: false, before: A.key });
    expect(stepMove(ENTRIES, B.key, 1)).toEqual({ hidden: false, before: C.key });
    expect(stepMove(ENTRIES, X.key, 1)).toBeNull();
    expect(stepMove(ENTRIES, H1.key, 1)).toEqual({ hidden: true, before: null });
  });

  it('does nothing at the ends of a group', () => {
    expect(stepMove(ENTRIES, A.key, -1)).toBeNull();
    expect(stepMove(ENTRIES, C.key, 1)).toBeNull();
    expect(stepMove(ENTRIES, H1.key, -1)).toBeNull();
  });

  it('says the position in its group', () => {
    expect(positionText(ENTRIES, B.key)).toBe('b, position 2 of 4 in visible projects.');
    expect(positionText(ENTRIES, H2.key)).toBe('h2, position 2 of 2 in hidden projects.');
  });
});
