// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A leaving session's slot stays where its capsule was drawn, once main has moved it to another list.
import { describe, expect, it } from 'vitest';
import { withHeldSlots } from './held-slots';

describe('withHeldSlots', () => {
  it('puts a slot back after the capsule it followed', () => {
    expect(withHeldSlots(['a', 'c'], [{ id: 'b', after: 'a' }])).toEqual(['a', 'b', 'c']);
  });

  it('puts a slot that was first back first, and a list with only slots left keeps them', () => {
    expect(withHeldSlots(['b'], [{ id: 'a', after: null }])).toEqual(['a', 'b']);
    expect(withHeldSlots([], [{ id: 'a', after: null }])).toEqual(['a']);
  });

  it('chains slots that followed each other, whichever left first', () => {
    // c left first (after b), then b (after a): b is placed, then c after it.
    expect(withHeldSlots(['a', 'd'], [{ id: 'c', after: 'b' }, { id: 'b', after: 'a' }])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves a slot still in the list where the list has it, and puts one whose neighbour is gone last', () => {
    expect(withHeldSlots(['a', 'b'], [{ id: 'b', after: 'a' }])).toEqual(['a', 'b']);
    expect(withHeldSlots(['a'], [{ id: 'z', after: 'gone' }])).toEqual(['a', 'z']);
  });
});
