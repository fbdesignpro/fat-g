// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V1, V2 (docs/planning/_archive/M103.md, Design 2; C3–C6; decision 0031): the read pass over the
// avatar section as the file holds it — the overrides and the active families; an overlay an older
// revision held no longer read (revision 15) — and the settlement of a patch, pure, over plain JSON,
// against the normalized merge.
import { describe, expect, it } from 'vitest';
import type { AvatarRef } from '@shared/contracts/avatars';
import { mergeAssignments, type PreferencesPatch } from '@shared/contracts/prefs';
import { readRawAssignments, readRawAvatars, settleRawAvatars } from './assignments';
import type { RawDocument } from './compatibility';

const ref = (avatar: string, family = 'Orange', origin: AvatarRef['origin'] = 'built-in'): AvatarRef => ({ origin, family, avatar });
const X = ref('X');
const Y = ref('Y');
const Z = ref('Z', 'Mine', 'user');
const IDS = ['claude', 'codex'];
const doc = (assignments: unknown, extra: RawDocument = {}): RawDocument => ({ schemaVersion: 15, minReaderVersion: 15, avatars: { assignments, ...extra } });
const assignmentsOf = (raw: RawDocument): unknown => (raw['avatars'] as RawDocument)['assignments'];
const settle = (raw: RawDocument, providerId: string, key: string, reference: AvatarRef | null): RawDocument => settleRawAvatars(raw, { assignments: { [providerId]: { [key]: reference } } });

describe('the read pass (V1; C5)', () => {
  it('preserves separate version and alias bindings in the existing identifier dictionary', () => {
    expect(readRawAssignments({ assignments: { claude: { opus: X, 'claude-opus-5-5': Y } } }, IDS)).toEqual({ claude: { opus: X, 'claude-opus-5-5': Y } });
    const both = settle(doc({ claude: { opus: X } }), 'claude', 'claude-opus-5-5', X);
    expect(assignmentsOf(both)).toEqual({ claude: { opus: X, 'claude-opus-5-5': X } });
    expect(both['schemaVersion']).toBe(15);
  });

  it('keeps each registered provider’s entries of the form', () => {
    expect(readRawAssignments({ assignments: { claude: { opus: X }, codex: { 'gpt-6-sol': Y } } }, IDS)).toEqual({ claude: { opus: X }, codex: { 'gpt-6-sol': Y } });
  });

  it.each<[string, unknown]>([
    ['a key that is no catalog id', { 'not a key!': X }],
    ['an origin it does not know', { opus: { ...X, origin: 'elsewhere' } }],
    ['a field beside the three', { opus: { ...X, path: 'C:\\art' } }],
    ['an empty name', { opus: { ...X, avatar: '' } }],
    ['a name past 255 units', { opus: { ...X, family: 'x'.repeat(256) } }],
    ['a value that is no object', { opus: 'Orange/X' }],
  ])('drops %s, keeping the entries beside it', (_name, entries) => {
    expect(readRawAssignments({ assignments: { claude: { ...(entries as RawDocument), sonnet: Y } } }, IDS)).toEqual({ claude: { sonnet: Y } });
  });

  it('drops a provider this build does not register, and reads a section of the wrong form as none', () => {
    expect(readRawAssignments({ assignments: { gemini: { pro: X }, codex: { 'gpt-6-sol': Y } } }, IDS)).toEqual({ codex: { 'gpt-6-sol': Y } });
    expect(readRawAssignments({ assignments: { claude: ['opus'] } }, IDS)).toEqual({});
    expect(readRawAssignments({ assignments: [X] }, IDS)).toEqual({});
    expect(readRawAssignments('avatars', IDS)).toEqual({});
    expect(readRawAssignments(undefined, IDS)).toEqual({});
  });

  it('keeps one avatar on several models, of one provider or several (decision 0031)', () => {
    const section = { assignments: { codex: { b: X }, claude: { sonnet: Y, opus: X, Zeta: X } } };
    expect(readRawAssignments(section, IDS)).toEqual({ claude: { Zeta: X, opus: X, sonnet: Y }, codex: { b: X } });
  });

  it('keeps the active families of registered providers alone, and reads no overlay', () => {
    const section = {
      assignments: {},
      active: { claude: { origin: 'built-in', family: 'Claude Elements' }, codex: { origin: 'elsewhere', family: 'X' }, gemini: { origin: 'user', family: 'Mine' } },
      overlay: { enabled: false, families: { 'built-in/Codex Spatial': { size: 18 } } },
    };
    expect(readRawAvatars(section, IDS)).toEqual({
      assignments: {},
      active: { claude: { origin: 'built-in', family: 'Claude Elements' } },
    });
    expect(readRawAvatars(undefined, IDS)).toEqual({ assignments: {}, active: {} });
  });
});

describe('a patch’s settlement (V2; C6)', () => {
  it('sets one model’s reference, keeping every other entry and every unknown field', () => {
    const raw = doc({ claude: { opus: Y, futureKey: 'keep' }, gemini: { pro: Z } }, { futureAvatars: [1] });
    const next = settle(raw, 'codex', 'gpt-6-sol', X);
    expect(next['avatars']).toEqual({ assignments: { claude: { opus: Y, futureKey: 'keep' }, gemini: { pro: Z }, codex: { 'gpt-6-sol': X } }, futureAvatars: [1] });
    expect(raw).toEqual(doc({ claude: { opus: Y, futureKey: 'keep' }, gemini: { pro: Z } }, { futureAvatars: [1] }));
  });

  it('leaves a reference another model holds where it is', () => {
    const raw = doc({ claude: { opus: X, sonnet: Y } });
    expect(assignmentsOf(settle(raw, 'claude', 'haiku', X))).toEqual({ claude: { opus: X, sonnet: Y, haiku: X } });
    expect(assignmentsOf(settle(raw, 'codex', 'gpt-6-sol', X))).toEqual({ claude: { opus: X, sonnet: Y }, codex: { 'gpt-6-sol': X } });
  });

  it('changes nothing when the same patch comes again', () => {
    const raw = doc({ claude: { opus: { avatar: 'X', origin: 'built-in', family: 'Orange' }, sonnet: Y } });
    expect(JSON.stringify(settle(raw, 'claude', 'opus', X))).toBe(JSON.stringify(raw));
    expect(JSON.stringify(settle(raw, 'claude', 'haiku', null))).toBe(JSON.stringify(raw));
    expect(settleRawAvatars(raw, undefined)).toBe(raw);
  });

  it('clears one model’s reference with null, and a malformed value at that key alone', () => {
    const raw = doc({ claude: { opus: X, sonnet: Y, 'not a key!': X }, codex: { a: 'broken' } });
    expect(assignmentsOf(settle(raw, 'claude', 'opus', null))).toEqual({ claude: { sonnet: Y, 'not a key!': X }, codex: { a: 'broken' } });
    expect(assignmentsOf(settle(raw, 'codex', 'a', null))).toEqual({ claude: { opus: X, sonnet: Y, 'not a key!': X }, codex: {} });
  });

  it('makes the section where the file has none, or one of the wrong form', () => {
    expect(settle({ schemaVersion: 15 }, 'claude', 'opus', X)['avatars']).toEqual({ assignments: { claude: { opus: X } } });
    expect(settle({ avatars: 'none' }, 'claude', 'opus', X)['avatars']).toEqual({ assignments: { claude: { opus: X } } });
    expect(settle({ avatars: { assignments: [] } }, 'claude', 'opus', X)['avatars']).toEqual({ assignments: { claude: { opus: X } } });
  });

  it('sets and removes an active family, keeping the rest of the section as the file holds it', () => {
    const raw: RawDocument = { avatars: { assignments: { claude: { opus: X } }, active: { codex: { origin: 'user', family: 'Mine' } }, future: { x: 1 } } };
    const patch: PreferencesPatch['avatars'] = { active: { claude: { origin: 'built-in', family: 'Claude Elements' }, codex: null } };
    expect(settleRawAvatars(raw, patch)['avatars']).toEqual({
      assignments: { claude: { opus: X } },
      active: { claude: { origin: 'built-in', family: 'Claude Elements' } },
      future: { x: 1 },
    });
  });
});

describe('the two merges agree (V2; C4, C6)', () => {
  const start = { claude: { opus: X, sonnet: Y }, codex: { 'gpt-6-sol': Z } };
  it.each<[string, string, string, AvatarRef | null]>([
    ['a set', 'claude', 'haiku', ref('W')],
    ['a second model on one avatar', 'claude', 'haiku', X],
    ['one avatar across providers', 'codex', 'gpt-6-luna', Y],
    ['the same again', 'claude', 'opus', X],
    ['a clear', 'codex', 'gpt-6-sol', null],
    ['a clear of nothing', 'codex', 'gpt-6-luna', null],
  ])('for %s', (_name, providerId, key, reference) => {
    const raw = settle(doc(start), providerId, key, reference);
    expect(readRawAssignments(raw['avatars'], IDS)).toEqual(mergeAssignments(start, { [providerId]: { [key]: reference } }));
  });

});
