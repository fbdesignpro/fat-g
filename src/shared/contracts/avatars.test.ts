// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V1 (docs/planning/_archive/M104.md, Design 1; C1–C4): a match entry against a model — by its key or its
// resolved id, ASCII case aside, `*` for any run — and the strength that orders two entries.
import { describe, expect, it } from 'vitest';
import { avatarProblemWords, compareStrength, DEFAULT_AVATAR, isDefaultFolder, type MatchEntryView, matchesModel, matchStrength, matchView, matchViewText, strongestMatch } from './avatars';

const any = (key: string): MatchEntryView => ({ provider: null, key });
const only = (provider: string, key: string): MatchEntryView => ({ provider, key });
const model = (key: string, resolvedId: string | null = null) => ({ key, resolvedId });

describe('the match (V1; C1, C3)', () => {
  it('compares a key with the whole of a model’s key, ASCII case aside', () => {
    expect(matchesModel(any('opus'), 'claude', model('opus'))).toBe(true);
    expect(matchesModel(any('OPUS'), 'claude', model('Opus'))).toBe(true);
    expect(matchesModel(any('opus'), 'claude', model('claude-opus'))).toBe(false);
    expect(matchesModel(any('claude-opus'), 'claude', model('opus'))).toBe(false);
  });

  it('lets `*` stand for any run, none included, the whole still compared', () => {
    expect(matchesModel(any('*opus*'), 'claude', model('opus'))).toBe(true);
    expect(matchesModel(any('*opus*'), 'claude', model('claude-opus-5[1m]'))).toBe(true);
    expect(matchesModel(any('*Opus*'), 'claude', model('CLAUDE-OPUS-5'))).toBe(true);
    expect(matchesModel(any('gpt-6-*'), 'codex', model('gpt-6-'))).toBe(true);
    expect(matchesModel(any('gpt-6-*'), 'codex', model('gpt-6-luna'))).toBe(true);
    expect(matchesModel(any('gpt-6-*'), 'codex', model('o-gpt-6-luna'))).toBe(false);
    expect(matchesModel(any('*'), 'codex', model('anything'))).toBe(true);
  });

  it('takes every other character as itself, the pattern’s brackets and dots included', () => {
    expect(matchesModel(any('gpt-5.5'), 'codex', model('gpt-5x5'))).toBe(false);
    expect(matchesModel(any('gpt-5.5'), 'codex', model('gpt-5.5'))).toBe(true);
    expect(matchesModel(any('opus[1m]'), 'claude', model('opus1'))).toBe(false);
    expect(matchesModel(any('opus[1m]'), 'claude', model('opus[1m]'))).toBe(true);
    expect(matchesModel(any('a/b:c@d'), 'claude', model('A/B:C@D'))).toBe(true);
  });

  it('matches by the resolved id where the key does not, and by the key where the id does not', () => {
    // Claude's key is the short form; its resolved id the model's name (M13, C47).
    expect(matchesModel(any('claude-opus-5[1m]'), 'claude', model('opus[1m]', 'claude-opus-5[1m]'))).toBe(true);
    expect(matchesModel(any('claude-opus-*'), 'claude', model('opus', 'claude-opus-5'))).toBe(true);
    expect(matchesModel(any('opus'), 'claude', model('opus', 'claude-opus-5'))).toBe(true);
    expect(matchesModel(any('sonnet'), 'claude', model('opus', 'claude-opus-5'))).toBe(false);
    // A model with no resolved id is matched by its key alone.
    expect(matchesModel(any('claude-opus-*'), 'claude', model('opus', null))).toBe(false);
  });

  it('passes over an entry qualified with another provider’s id, and takes one qualified with this one’s', () => {
    expect(matchesModel(only('codex', '*luna*'), 'claude', model('gpt-6-luna'))).toBe(false);
    expect(matchesModel(only('codex', '*luna*'), 'codex', model('gpt-6-luna'))).toBe(true);
    expect(matchesModel(any('*luna*'), 'claude', model('gpt-6-luna'))).toBe(true);
    // The id is compared as written: no case is set aside.
    expect(matchesModel(only('Codex', '*luna*'), 'codex', model('gpt-6-luna'))).toBe(false);
  });
});

describe('the strength (V1; C4)', () => {
  it('measures an entry by its stars, its other characters and its provider', () => {
    expect(matchStrength(any('opus'))).toEqual({ exact: true, literal: 4, qualified: false });
    expect(matchStrength(only('claude', '*op*us*'))).toEqual({ exact: false, literal: 4, qualified: true });
  });

  it('puts an exact key over any pattern, however much the pattern pins down', () => {
    expect(compareStrength(any('opus'), any('claude-opus-*'))).toBeLessThan(0);
    expect(compareStrength(only('claude', 'claude-opus-*'), any('opus'))).toBeGreaterThan(0);
  });

  it('puts the pattern with more characters other than `*` over the other', () => {
    expect(compareStrength(any('claude-opus-*'), any('*opus*'))).toBeLessThan(0);
    expect(compareStrength(any('*o*p*u*s*'), any('*opus-5*'))).toBeGreaterThan(0);
    // Between two keys too.
    expect(compareStrength(any('claude-opus-5'), any('opus'))).toBeLessThan(0);
  });

  it('puts a qualified entry over an unqualified one of the same text, and finds two alike of equal strength', () => {
    expect(compareStrength(only('claude', '*opus*'), any('*opus*'))).toBeLessThan(0);
    expect(compareStrength(any('*opus*'), only('claude', '*opus*'))).toBeGreaterThan(0);
    expect(compareStrength(any('*opus*'), any('*OPUS*'))).toBe(0);
    expect(compareStrength(any('*opus*'), any('opus**'))).toBe(0);
    expect(compareStrength(only('claude', 'opus'), only('codex', 'luna'))).toBe(0);
  });
});

// Decision 0031: a family's search — main's, and the Avatars tab's account of it — is this one function.
describe('the strongest match in a family', () => {
  const family = [
    { folder: 'Sun', matches: [any('*opus*')] },
    { folder: 'Earth', matches: [any('*opus*'), any('haiku')] },
    { folder: 'Moon', matches: [only('claude', 'claude-opus-5-5')] },
    { folder: 'Mars', matches: [only('codex', '*')] },
  ];

  it('is the avatar whose entry matches the model most strongly, with that entry', () => {
    expect(strongestMatch(family, 'claude', model('opus', 'claude-opus-5-5'))).toEqual({ avatar: family[2], entry: only('claude', 'claude-opus-5-5') });
    expect(strongestMatch(family, 'claude', model('haiku'))?.avatar.folder).toBe('Earth');
  });

  it('is the first in the family’s order at equal strength, and none where nothing matches or the entry is another provider’s', () => {
    expect(strongestMatch(family, 'claude', model('opus'))).toEqual({ avatar: family[0], entry: any('*opus*') });
    expect(strongestMatch(family, 'claude', model('sonnet'))).toBeNull();
    expect(strongestMatch(family, 'codex', model('gpt-6-sol'))?.avatar.folder).toBe('Mars');
    expect(strongestMatch([], 'claude', model('opus'))).toBeNull();
  });
});

describe('the entries as the listing carries them (V5; C2)', () => {
  it('keeps a key for any provider and one for a named provider, in the words the Preview always used', () => {
    expect(matchView('claude-opus-*')).toEqual({ provider: null, key: 'claude-opus-*' });
    expect(matchView({ provider: 'claude', key: 'opus' })).toEqual({ provider: 'claude', key: 'opus' });
    expect(matchViewText(matchView('claude-opus-*'))).toBe('claude-opus-*');
    expect(matchViewText(matchView({ provider: 'claude', key: 'opus' }))).toBe('claude: opus');
  });

  it('cleans a provider id for display, as the Preview showed it', () => {
    expect(matchView({ provider: ' claude\u0007 ', key: 'opus' })).toEqual({ provider: 'claude', key: 'opus' });
    expect(matchViewText({ provider: 'gem​ini', key: 'pro' })).toBe('gemini: pro');
  });
});

describe('the family default (decision 0031)', () => {
  it('is the folder named Default, ASCII case aside, and no other', () => {
    expect(DEFAULT_AVATAR).toBe('Default');
    for (const name of ['Default', 'default', 'DEFAULT', 'dEfAuLt']) expect(isDefaultFolder(name), name).toBe(true);
    for (const name of ['Defaults', 'Default ', ' Default', 'Fallback', 'My Default', '', 'Défault']) expect(isDefaultFolder(name), name).toBe(false);
  });

  it('says in words that a family without one is not used', () => {
    expect(avatarProblemWords({ kind: 'no-default', path: 'Mine' })).toBe('Mine: no Default folder holding portrait.png or portrait.webp, so the family is not used');
  });
});
