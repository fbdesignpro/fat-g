// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V17 (docs/planning/_archive/M19.md; C52): the long-conversation fixture is the one K3 measured — generated
// identically each time, here and on every system CI runs. Its sha256 is the spike's
// (spikes/m19/k3.mjs, `fixtureFacts`): every turn's prompt and answer, then the static message at
// the bound, the nested one and the three streams, each followed by a zero.
//
// V11 (docs/planning/_archive/M20a.md; C44): the fixture gains what its turns did, a group of twenty
// activities a turn with one in ten at an output's bound, and a worker's answer. They are added
// after M19's parts, from generators of their own seeds, so the spike's hash still holds; a second
// one holds theirs.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_OUTPUT } from '@shared/contracts/activity';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import * as fixture from '../../fixtures/conversations/long-conversation.mjs';

const SHA256 = '96d31180a20bfc08ab66e29c2d51837467bff5c7e62865ba52c10900d2111da4';

function hashOf(): string {
  const hash = createHash('sha256');
  for (let n = 1; n <= fixture.TURNS; n += 1) {
    const { prompt, answer } = fixture.turn(n);
    hash.update(prompt).update('\u0000').update(answer).update('\u0000');
  }
  for (const text of [fixture.largeMessage(), fixture.nestedMessage(), ...fixture.STREAMS.map((kind) => fixture.streamText(kind))]) hash.update(text).update('\u0000');
  return hash.digest('hex');
}

/** M20a's parts: every turn's activities, each field followed by a zero, then the worker's answer. */
const ACTIVITY_SHA256 = '247eb83ee2655a5b1988e3d56fba4f588fa6c6d30b0f77d61f8e983b79c4374f';

function activityHash(): string {
  const hash = createHash('sha256');
  for (let n = 1; n <= fixture.TURNS; n += 1) {
    for (const activity of fixture.activities(n)) {
      for (const part of [activity.id, activity.type, activity.name, activity.summary, activity.input, activity.output, activity.file ?? '', String(activity.exitCode)]) hash.update(part).update('\u0000');
    }
  }
  hash.update(fixture.workerText()).update('\u0000');
  return hash.digest('hex');
}

describe('the long-conversation fixture (C52)', () => {
  it('is generated identically each time: its bytes are the ones the spike measured', () => {
    expect(hashOf()).toBe(SHA256);
    expect(hashOf()).toBe(SHA256);
  });

  it('holds 2,000 turns, a static message at the bound, a deeply nested one, and three streams: 20,000 units mixed, a fence and a table at the bound', () => {
    expect(fixture.TURNS).toBe(2_000);
    expect(fixture.BOUND).toBe(MAX_MESSAGE_TEXT);
    expect(fixture.largeMessage()).toHaveLength(MAX_MESSAGE_TEXT);
    expect(fixture.nestedMessage().split('\n').some((line) => line.startsWith('  '.repeat(fixture.NESTING - 1)))).toBe(true);
    expect([...fixture.STREAMS]).toEqual(['mixed', 'fence', 'table']);
    expect(fixture.streamText('mixed')).toHaveLength(fixture.MIXED_UNITS);
    expect(fixture.MIXED_UNITS).toBe(20_000);
    expect(fixture.streamText('fence')).toHaveLength(MAX_MESSAGE_TEXT);
    expect(fixture.streamText('table')).toHaveLength(MAX_MESSAGE_TEXT);
    // One fence, opened after a line of words and closed by the text's last line; one table, a row a line.
    expect(fixture.streamText('fence').split('\n').filter((line) => line.startsWith('```'))).toEqual(['```js', '```']);
    expect(fixture.streamText('table').split('\n').slice(2).every((line) => line === '' || line.startsWith('|'))).toBe(true);
  });

  it('gives the newest turns as items, oldest first, a prompt and then its answer', () => {
    const items = fixture.items(250);
    expect(items).toHaveLength(500);
    expect(items[0]).toEqual({ id: 'u1751', role: 'user', text: fixture.turn(1_751).prompt });
    expect(items.at(-1)).toEqual({ id: 'a2000', role: 'assistant', text: fixture.turn(2_000).answer });
  });
});

describe('the fixture’s activity (M20a: V11; C44)', () => {
  it('is generated identically each time, and leaves every text M19 measured as it was', () => {
    expect(activityHash()).toBe(ACTIVITY_SHA256);
    expect(activityHash()).toBe(ACTIVITY_SHA256);
    // The spike's own hash, taken again after the activity was generated: nothing above moved.
    expect(hashOf()).toBe(SHA256);
  }, 120_000);

  it('gives every turn a group of twenty: reads, searches and commands in turn, each with what it was given and what it returned', () => {
    expect(fixture.ACTIVITIES).toBe(20);
    for (const n of [1, 2, 1_000, fixture.TURNS, fixture.TURNS + 1]) {
      const group = fixture.activities(n);
      expect(group, String(n)).toHaveLength(20);
      expect(group.map((activity) => activity.type), String(n)).toEqual(Array.from({ length: 20 }, (_, index) => ['read', 'search', 'command'][index % 3]));
      expect(new Set(group.map((activity) => activity.id)).size, String(n)).toBe(20);
      for (const activity of group) {
        expect(activity.summary.length, activity.id).toBeGreaterThan(0);
        expect(activity.input.length, activity.id).toBeGreaterThan(0);
        expect(activity.summary.includes('\n'), activity.id).toBe(false);
        expect(activity.file === null, activity.id).toBe(activity.type !== 'read');
        expect(activity.exitCode, activity.id).toBe(activity.type === 'command' ? 0 : null);
      }
    }
    // Two turns are not one another's.
    expect(JSON.stringify(fixture.activities(1))).not.toBe(JSON.stringify(fixture.activities(2)));
  });

  it('gives one in ten an output at the bound, exactly, and the others a few lines', () => {
    expect(fixture.OUTPUT_BOUND).toBe(MAX_ACTIVITY_OUTPUT);
    const sizes = fixture.activities(fixture.TURNS).map((activity) => activity.output.length);
    expect(sizes.filter((size) => size === MAX_ACTIVITY_OUTPUT)).toHaveLength(2);
    expect(sizes.map((size, index) => (size === MAX_ACTIVITY_OUTPUT ? index : -1)).filter((index) => index >= 0)).toEqual([9, 19]);
    expect(sizes.filter((size) => size !== MAX_ACTIVITY_OUTPUT).every((size) => size >= 40 && size <= 400)).toBe(true);
  });

  it('names two more streams, played only by their names, and a worker’s answer of mixed Markdown', () => {
    expect([...fixture.ACTIVITY_STREAMS]).toEqual(['tools', 'worker']);
    expect([...fixture.STREAMS]).toEqual(['mixed', 'fence', 'table']);
    expect(fixture.workerText().length).toBeGreaterThan(fixture.MIXED_UNITS - 100);
    expect(fixture.workerText().length).toBeLessThanOrEqual(fixture.MIXED_UNITS);
    expect(fixture.workerText()).not.toBe(fixture.streamText('mixed'));
  });
});
