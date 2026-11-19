// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The capsule drop arithmetic (docs/planning/_archive/M14.md, V25; C11, C55, C90), on tables.
import { describe, expect, it } from 'vitest';
import { applyCapsuleMove, arrangeMoves, type CapsuleBox, capsuleDropAt, capsulePositionText, capsuleRoom, capsuleStep, groupIds, heldOrder, isOwnCapsulePlace } from './capsule-reorder';

const ROW = 48;
/** One project's active capsules as the list draws them: the starred first. Each is 48 px tall. */
const boxes = (...items: [id: string, group: CapsuleBox['group']][]): CapsuleBox[] => items.map(([id, group], index) => ({ id, group, top: index * ROW, bottom: (index + 1) * ROW }));
const LIST = boxes(['s1', 'starred'], ['s2', 'starred'], ['a', 'unstarred'], ['b', 'unstarred'], ['c', 'unstarred'], ['d', 'unstarred']);

describe('capsuleDropAt (C55)', () => {
  it.each([
    // The unstarred group runs from 96 to 288.
    ['above the first half of its first capsule', 'c', 100, 'a'],
    ['in the second half of the first: before the second', 'c', 130, 'b'],
    ['over its own first half: its own place', 'c', 200, 'c'],
    ['over its own second half: before the next', 'c', 230, 'd'],
    ['in the last capsule’s second half: the end of the group', 'a', 280, null],
    ['at the group’s very top edge', 'c', 96, 'a'],
    ['at the group’s very bottom edge', 'a', 288, null],
  ])('gives the gap %s', (_name, dragged, y, before) => {
    expect(capsuleDropAt(LIST, dragged, y)).toEqual({ before });
  });

  it.each([
    ['above its group, over the starred capsules', 'c', 50],
    ['above the whole list', 'c', -10],
    ['below the whole list', 'c', 300],
  ])('gives nothing %s: a release there cancels', (_name, dragged, y) => {
    expect(capsuleDropAt(LIST, dragged, y)).toBeNull();
  });

  it('keeps a starred capsule within the starred', () => {
    expect(capsuleDropAt(LIST, 's2', 10)).toEqual({ before: 's1' });
    expect(capsuleDropAt(LIST, 's1', 90)).toEqual({ before: null });
    expect(capsuleDropAt(LIST, 's1', 100)).toBeNull();
  });

  it('gives nothing for a capsule the list does not hold', () => {
    expect(capsuleDropAt(LIST, 'gone', 100)).toBeNull();
    expect(capsuleDropAt([], 'a', 0)).toBeNull();
  });
});

describe('capsuleRoom (C55): the others move out of the way', () => {
  it('moves the capsules between its place and the gap one capsule up, for a move down', () => {
    const room = capsuleRoom(LIST, 'a', { before: 'd' });
    expect([...room.shifts]).toEqual([['b', -ROW], ['c', -ROW]]);
    expect(room.gap).toEqual({ top: 192, bottom: 240 });
  });

  it('moves them one capsule down, for a move up', () => {
    const room = capsuleRoom(LIST, 'd', { before: 'b' });
    expect([...room.shifts]).toEqual([['b', ROW], ['c', ROW]]);
    expect(room.gap).toEqual({ top: 144, bottom: 192 });
  });

  it('opens the gap at the group’s end', () => {
    const room = capsuleRoom(LIST, 'a', { before: null });
    expect([...room.shifts.keys()]).toEqual(['b', 'c', 'd']);
    expect(room.gap).toEqual({ top: 240, bottom: 288 });
  });

  // M100 (C61, V16): capsules stand --gap-grid apart; each one passed moves by the dragged one's height and the gap.
  it('moves the capsules passed by its height and the gap between capsules, so the drop leaves each where the preview had it', () => {
    const GAP = 8;
    const spaced = (ids: readonly string[]): CapsuleBox[] => ids.map((id, index) => ({ id, group: 'unstarred', top: index * (ROW + GAP), bottom: index * (ROW + GAP) + ROW }));
    const ids = ['a', 'b', 'c', 'd'];
    const down = capsuleRoom(spaced(ids), 'a', { before: 'd' });
    expect([...down.shifts]).toEqual([['b', -(ROW + GAP)], ['c', -(ROW + GAP)]]);
    // After the drop the order is b, c, a, d: b and c stand where they were moved to, and a in the gap.
    const after = spaced(['b', 'c', 'a', 'd']);
    expect(down.gap).toEqual({ top: after[2]?.top, bottom: after[2]?.bottom });
    expect(spaced(ids)[1]?.top ?? NaN).toBe((after[0]?.top ?? NaN) + ROW + GAP);
    const up = capsuleRoom(spaced(ids), 'd', { before: 'b' });
    expect([...up.shifts]).toEqual([['b', ROW + GAP], ['c', ROW + GAP]]);
    expect(up.gap).toEqual({ top: ROW + GAP, bottom: 2 * ROW + GAP });
  });

  it('moves nothing at its own place, never a capsule of the other group, and nothing outside the group', () => {
    expect([...capsuleRoom(LIST, 'b', { before: 'b' }).shifts]).toEqual([]);
    expect([...capsuleRoom(LIST, 'b', { before: 'c' }).shifts]).toEqual([]);
    expect([...capsuleRoom(LIST, 's1', { before: null }).shifts.keys()]).toEqual(['s2']);
    expect(capsuleRoom(LIST, 'b', null)).toEqual({ shifts: new Map(), gap: null });
  });
});

const session = (id: string, starred = false, completedAt: number | null = null, shelvedAt: number | null = null) => ({ record: { id, starred, completedAt, shelvedAt } });
// Stored order, as the records hold it: groups interleaved, a completed one among them, and a shelved one at the end.
const STORED = [session('a'), session('s1', true), session('b'), session('done', false, 5), session('s2', true), session('c'), session('parked', false, null, 7)];
const order = (sessions: readonly { record: { id: string } }[]) => sessions.map((entry) => entry.record.id);

describe('a move, by main’s rules (C11)', () => {
  it('lists an active session’s group in stored order, and none for a completed or a shelved one', () => {
    expect(groupIds(STORED, 'b')).toEqual(['a', 'b', 'c']);
    expect(groupIds(STORED, 's2')).toEqual(['s1', 's2']);
    expect(groupIds(STORED, 'done')).toEqual(['done']);
    expect(groupIds(STORED, 'parked')).toEqual(['parked']);
    expect(groupIds(STORED, 'gone')).toEqual([]);
  });

  it.each([
    ['before another of its group', 'c', 'a', ['c', 'a', 's1', 'b', 'done', 's2', 'parked']],
    ['to the end of its group', 'a', null, ['s1', 'b', 'done', 's2', 'c', 'a', 'parked']],
    ['a starred one before the other', 's2', 's1', ['a', 's2', 's1', 'b', 'done', 'c', 'parked']],
    ['a starred one to the end of the starred', 's1', null, ['a', 'b', 'done', 's2', 's1', 'c', 'parked']],
  ])('moves %s', (_name, id, before, expected) => {
    expect(order(applyCapsuleMove(STORED, id, before))).toEqual(expected);
  });

  it.each([
    ['to where it is', 'b', 'b'],
    ['before the one its group has next', 'b', 'c'],
    ['to the end, when it is its group’s last', 'c', null],
    ['before a session of the other group', 'b', 's1'],
    ['before a completed session', 'b', 'done'],
    ['a completed session', 'done', null],
    ['before a shelved session', 'b', 'parked'],
    ['a shelved session', 'parked', null],
    ['a session it does not hold', 'gone', null],
  ])('leaves the list as it is for a move %s', (_name, id, before) => {
    expect(applyCapsuleMove(STORED, id, before)).toBe(STORED);
  });

  it('knows a drop at the capsule’s own place', () => {
    const ids = ['a', 'b', 'c'];
    expect([isOwnCapsulePlace(ids, 'b', 'b'), isOwnCapsulePlace(ids, 'b', 'c'), isOwnCapsulePlace(ids, 'c', null)]).toEqual([true, true, true]);
    expect([isOwnCapsulePlace(ids, 'b', 'a'), isOwnCapsulePlace(ids, 'b', null), isOwnCapsulePlace(ids, 'a', 'c')]).toEqual([false, false, false]);
  });
});

describe('a held list (decision 0011, item 12)', () => {
  it('shows the held order in the held sessions’ places, and every other one where it is saved', () => {
    // Saved after c was chosen and a new one made: c first in its group, `new` before them all.
    const saved = [session('new'), session('c'), session('a'), session('s1', true), session('b'), session('done', false, 5), session('s2', true), session('parked', false, null, 7)];
    expect(order(heldOrder(saved, order(STORED)))).toEqual(['new', 'a', 's1', 'b', 'done', 's2', 'c', 'parked']);
  });

  it('keeps each session’s own list and star: a Done shows at once, in the held order’s place', () => {
    const held = heldOrder([session('b'), session('a', false, 9), session('c')], ['a', 'b', 'c']);
    expect(held.map((entry) => [entry.record.id, entry.record.completedAt])).toEqual([['a', 9], ['b', null], ['c', null]]);
  });

  it('forgets a held session that is gone', () => {
    expect(order(heldOrder([session('b'), session('a')], ['gone', 'a', 'b']))).toEqual(['a', 'b']);
  });

  it.each([
    ['nothing for the same order', ['a', 'b', 'c'], ['a', 'b', 'c'], []],
    ['one move for one capsule taken down', ['a', 'b', 'c'], ['b', 'c', 'a'], [{ id: 'a', before: null }]],
    ['one move for one capsule taken up', ['a', 'b', 'c'], ['c', 'a', 'b'], [{ id: 'c', before: 'a' }]],
    // a was chosen (saved first, shown second), then d dropped between b and a.
    ['a promotion held back put back, and the user’s move', ['a', 'b', 'c', 'd'], ['b', 'd', 'a', 'c'], [{ id: 'c', before: null }, { id: 'a', before: 'c' }]],
    ['the reverse', ['a', 'b', 'c'], ['c', 'b', 'a'], [{ id: 'a', before: null }, { id: 'b', before: 'a' }]],
  ])('arranges a group with %s', (_name, saved, shown, expected) => {
    expect(arrangeMoves(saved, shown)).toEqual(expected);
  });

  it('arranges any order of a group into any other', () => {
    const apply = (ids: readonly string[], moves: ReturnType<typeof arrangeMoves>) => moves.reduce((list, move) => order(applyCapsuleMove(list.map((id) => session(id)), move.id, move.before)), ids);
    const all = ['a', 'b', 'c', 'd'];
    const orders = (rest: readonly string[]): string[][] => rest.length === 0 ? [[]] : rest.flatMap((id) => orders(rest.filter((other) => other !== id)).map((tail) => [id, ...tail]));
    for (const saved of orders(all)) for (const shown of orders(all)) expect(apply(saved, arrangeMoves(saved, shown))).toEqual(shown);
  });
});

describe('the keyboard moves (C90)', () => {
  const ids = ['a', 'b', 'c'];
  it.each([
    ['up from the middle', 'b', -1, { before: 'a' }],
    ['down from the middle', 'b', 1, { before: null }],
    ['down from the top', 'a', 1, { before: 'c' }],
    ['up from the top: it stops', 'a', -1, null],
    ['down from the bottom: it stops', 'c', 1, null],
    ['a session that is not in the group', 'x', 1, null],
  ] as const)('%s', (_name, id, direction, expected) => {
    expect(capsuleStep(ids, id, direction)).toEqual(expected);
  });

  it('says the new position, in its group', () => {
    expect(capsulePositionText('Create plan', ['x', 'y', 'z', 'q', 'r'], 'y', { list: 'active', starred: true })).toBe('Create plan, position 2 of 5 in starred sessions.');
    expect(capsulePositionText('Fix login', ['x', 'y'], 'x', { list: 'active', starred: false })).toBe('Fix login, position 1 of 2 in sessions.');
  });
});
