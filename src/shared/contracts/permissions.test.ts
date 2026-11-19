// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V15 (docs/planning/_archive/M22.md; C1, C39, C40, C43, C44, C46, C63): the mode contract — what a
// provider declares, the hierarchy's rule, what an account can use, and fat-g's words for a mode.
import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  declaredTransition,
  isModeId,
  MODE_REASONS,
  MODE_SOURCES,
  MODE_WORDS,
  modeOf,
  modeReasonWords,
  modeTitle,
  type PermissionCapability,
  readingMode,
  resolveMode,
  SANDBOX_SETUP_STATES,
  setupHolds,
} from './permissions';

const mode = (id: string, patch: Partial<PermissionCapability['modes'][number]> = {}) => ({ id, label: id, description: '', asks: true, reading: false, transitionsFrom: [] as string[], ...patch });
const CAPABILITY: PermissionCapability = {
  modes: [mode('read-only', { reading: true, asks: false }), mode('ask-first', { transitionsFrom: ['edits-ok'] }), mode('edits-ok', { transitionsFrom: ['ask-first'] }), mode('berserk', { asks: false })],
  fallback: 'ask-first', setup: null, inherited: '', rules: '',
};
const none = { saved: null, project: null, user: null };

describe('a mode’s id', () => {
  it('is lower-case words joined by hyphens, and nothing else', () => {
    for (const id of ['read-only', 'ask-first', 'a', 'mode2']) expect(isModeId(id), id).toBe(true);
    for (const id of ['', 'Ask first', 'acceptEdits', '-x', 'x'.repeat(65), 4, null, 'a b']) expect(isModeId(id), String(id)).toBe(false);
  });
});

describe('the hierarchy (C1, C43, C44)', () => {
  it.each([
    ['the chat’s saved mode first', { saved: 'edits-ok', project: 'read-only', user: 'berserk' }, { id: 'edits-ok', source: 'chat' }],
    ['then the project’s default', { saved: null, project: 'read-only', user: 'berserk' }, { id: 'read-only', source: 'project' }],
    ['then the user’s', { saved: null, project: null, user: 'berserk' }, { id: 'berserk', source: 'user' }],
    ['then the provider’s fallback', none, { id: 'ask-first', source: 'fallback' }],
  ] as const)('answers %s', (_name, choices, expected) => {
    expect(resolveMode(CAPABILITY, choices)).toEqual(expected);
  });

  it('takes an id the provider does not list for no choice at all: no id crosses providers', () => {
    expect(resolveMode(CAPABILITY, { saved: 'sandbox-ok', project: 'workspace', user: null })).toEqual({ id: 'ask-first', source: 'fallback' });
    expect(resolveMode(CAPABILITY, { saved: null, project: 'sandbox-ok', user: 'edits-ok' })).toEqual({ id: 'edits-ok', source: 'user' });
  });

  it('never substitutes for a choice the account cannot use: only the fallback looks at what is usable', () => {
    const usable = (id: string): boolean => id === 'read-only';
    expect(resolveMode(CAPABILITY, { saved: null, project: 'berserk', user: null }, usable)).toEqual({ id: 'berserk', source: 'project' });
    // The fallback where the account cannot use it: the reading mode, and never one that acts without asking.
    expect(resolveMode(CAPABILITY, none, usable)).toEqual({ id: 'read-only', source: 'fallback' });
  });

  it('answers nothing for a provider that declares no mode', () => {
    expect(resolveMode(null, { saved: 'ask-first', project: null, user: null })).toBeNull();
    expect(resolveMode({ ...CAPABILITY, modes: [] }, none)).toBeNull();
  });
});

describe('what a capability says', () => {
  it('finds a mode by its id, and the reading one', () => {
    expect(modeOf(CAPABILITY, 'edits-ok')?.id).toBe('edits-ok');
    expect(modeOf(CAPABILITY, 'nope')).toBeUndefined();
    expect(modeOf(null, 'edits-ok')).toBeUndefined();
    expect(modeOf(CAPABILITY, null)).toBeUndefined();
    expect(readingMode(CAPABILITY)?.id).toBe('read-only');
  });

  it('says a change is made on the live process only between the modes that name each other, and a restart otherwise', () => {
    expect(declaredTransition(CAPABILITY, 'ask-first', 'edits-ok')).toBe('idle');
    expect(declaredTransition(CAPABILITY, 'edits-ok', 'ask-first')).toBe('idle');
    for (const [from, to] of [['ask-first', 'read-only'], ['read-only', 'ask-first'], ['ask-first', 'berserk'], ['berserk', 'ask-first'], [null, 'edits-ok']] as const) expect(declaredTransition(CAPABILITY, from, to), `${from} → ${to}`).toBe('restart');
    expect(declaredTransition(null, 'ask-first', 'edits-ok')).toBe('restart');
  });

  it('takes a mode nothing is known of yet as usable, with nothing more said', () => {
    expect(availabilityOf(undefined, 'ask-first')).toEqual({ id: 'ask-first', available: true, reason: null, setup: false, records: false, unconfined: false, places: null });
    const known = { id: 'ask-first', available: false, reason: 'needs-setup' as const, setup: true, records: false, unconfined: false, places: null };
    expect(availabilityOf([known], 'ask-first')).toBe(known);
  });
});

describe('a sandbox setup (C62, C72)', () => {
  it('holds its account while it starts and while its completion is awaited, and at no other time', () => {
    const holding = SANDBOX_SETUP_STATES.filter((state) => setupHolds({ state, error: null, readiness: null }));
    expect(holding).toEqual(['starting', 'waiting']);
    expect(setupHolds(null)).toBe(false);
    expect(setupHolds(undefined)).toBe(false);
  });
});

describe('fat-g’s words for a mode (C46, C82, C87)', () => {
  it('titles a mode with where it came from', () => {
    expect(MODE_SOURCES.map((source) => modeTitle('Ask first', source))).toEqual(['Ask first · this chat', 'Ask first · project default', 'Ask first · my default', 'Ask first · fat-g’s default']);
  });

  it('has a reason in words for each way an account cannot use one, naming the mode and no path', () => {
    for (const reason of MODE_REASONS) {
      const words = modeReasonWords(reason, 'Sandbox ok', 'Codex');
      expect(words).toContain('Sandbox ok');
      expect(words).not.toMatch(/[A-Za-z]:\\|\//);
    }
    expect(modeReasonWords('needs-setup', 'Sandbox ok', 'Codex')).toBe('Sandbox ok needs Codex’s sandbox, which this account does not have.');
  });

  it('counts the grants a restart ends, and says what a mode makes its CLI record', () => {
    expect(MODE_WORDS.endsGrants(1)).toBe('Ends this session’s 1 grant');
    expect(MODE_WORDS.endsGrants(3)).toBe('Ends this session’s 3 grants');
    expect(MODE_WORDS.records('Codex')).toBe('Choosing it makes Codex record this folder as trusted in its own configuration');
    expect(MODE_WORDS.line('Edits ok')).toBe('Mode: Edits ok');
  });
});
