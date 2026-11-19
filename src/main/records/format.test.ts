// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How one session entry is read (docs/planning/_archive/M14.md, Design 1, "Entries"; V2).
import { describe, expect, it } from 'vitest';
import { FIXED_SESSION_FIELDS, isChangeableField, readSession, RECORDS_VERSION, storedId, storedProjectId } from './format';

const ID = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';
const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const AT = 1_579_701_780_000;

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  projectId: PROJECT,
  providerId: 'codex',
  instanceId: 'default',
  reference: null,
  folder: null,
  configFolder: null,
  model: 'gpt-6-sol',
  effort: 'high',
  speed: null,
  name: null,
  nameSource: null,
  starred: false,
  toDo: false,
  toVerify: false,
  shelvedAt: null,
  completedAt: null,
  createdAt: AT,
  lastActiveAt: AT,
  lastTurn: null,
  ...overrides,
});
const read = (overrides: Record<string, unknown> = {}, platform = 'win32') => readSession(entry(overrides), platform);

describe('the records format', () => {
  it('is version 8 for a session’s speed tier (decision 0016)', () => {
    expect(RECORDS_VERSION).toBe(8);
  });

  it('lets no change set what a session is: its id, project, provider, instance, model and created time (C12; M14b, C26, C55)', () => {
    expect([...FIXED_SESSION_FIELDS].sort()).toEqual(['createdAt', 'id', 'instanceId', 'model', 'projectId', 'providerId']);
    for (const field of FIXED_SESSION_FIELDS) expect(isChangeableField(field)).toBe(false);
    // Every other field of the entry a new session writes may be set.
    for (const field of Object.keys(entry())) expect(isChangeableField(field)).toBe(!(FIXED_SESSION_FIELDS as readonly string[]).includes(field));
    expect(isChangeableField('future')).toBe(false);
  });
});

describe('readSession', () => {
  it('reads the entry a new session writes: no reference, no folder, no name, no turn (C5, C6, C8)', () => {
    expect(read()).toEqual(entry());
  });

  it('reads a started, named, starred, completed session whole (C2)', () => {
    const full = {
      reference: '019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9b', folder: 'D:\\Code\\fat-g', effort: null, name: 'Create plan', nameSource: 'user',
      starred: true, completedAt: AT + 500, lastActiveAt: AT + 400, lastTurn: { turnId: 'turn-0', startedAt: AT + 100, endedAt: AT + 400, outcome: 'completed' },
    };
    expect(read(full)).toEqual(entry(full));
  });

  it('reads a session’s speed tier whole, as its effort is, and lets a change set it (decision 0016)', () => {
    expect(read({ speed: 'fast' })).toEqual(entry({ speed: 'fast' }));
    expect(read({ speed: 'priority' })?.speed).toBe('priority');
    expect(isChangeableField('speed')).toBe(true);
  });

  it('reads a shelved session with every flag set whole', () => {
    const shelved = { reference: 'r', folder: 'D:\\Code', starred: true, toDo: true, toVerify: true, shelvedAt: AT + 600, lastTurn: { turnId: 'turn-0', startedAt: AT + 100, endedAt: AT + 400, outcome: 'completed' } };
    expect(read(shelved)).toEqual(entry(shelved));
  });

  it('normalizes a session title and clamps it at its own longer bound', () => {
    expect(read({ name: '  Create \t\n plan ', nameSource: 'first-message' })?.name).toBe('Create plan');
    expect(read({ name: 'x'.repeat(160), nameSource: 'generated' })?.name).toBe('x'.repeat(160));
    const long = read({ name: 'x'.repeat(180), nameSource: 'provider' })?.name ?? '';
    expect([...long]).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it.each(['user', 'generated', 'provider', 'first-message'])('reads a name from the %s source', (nameSource) => {
    expect(read({ name: 'A name', nameSource })).toMatchObject({ name: 'A name', nameSource });
  });

  it.each(['completed', 'interrupted', 'failed', 'stopped'])('reads a last turn ended %s, and one with no end (C10, C74)', (outcome) => {
    expect(read({ lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: AT + 1, outcome } })?.lastTurn).toEqual({ turnId: 'turn-0', startedAt: AT, endedAt: AT + 1, outcome });
    expect(read({ lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: null, outcome: null } })?.lastTurn).toEqual({ turnId: 'turn-0', startedAt: AT, endedAt: null, outcome: null });
  });

  it('leaves what it does not know out of the record: the raw entry keeps it', () => {
    expect(read({ future: [1], lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: null, outcome: null, tokens: 9 } })).toEqual(entry({ lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: null, outcome: null } }));
  });

  it('reads the instance: the first one’s id, or an added one’s UUID in any letter case (M14b, C26)', () => {
    expect(read()?.instanceId).toBe('default');
    expect(read({ instanceId: '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19' })?.instanceId).toBe('0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19');
    expect(read({ instanceId: '0B6F2C1E-5A4D-4E0B-9A51-7F3D1C0E6B19' })?.instanceId).toBe('0B6F2C1E-5A4D-4E0B-9A51-7F3D1C0E6B19');
  });

  it('reads the configuration folder: null, or an absolute path by the platform’s rules (M14b, C61)', () => {
    expect(read({ reference: 'r', folder: 'D:\\Code', configFolder: 'D:\\accounts\\work' })?.configFolder).toBe('D:\\accounts\\work');
    expect(read({ reference: 'r', folder: '/home/someone/code', configFolder: '/home/someone/.codex' }, 'linux')?.configFolder).toBe('/home/someone/.codex');
    expect(read({ configFolder: '/home/someone/.codex' }, 'win32')).toBeNull();
  });

  it('judges the folder by the platform’s rules', () => {
    expect(read({ reference: 'r', folder: '/home/someone/code' }, 'linux')?.folder).toBe('/home/someone/code');
    expect(read({ reference: 'r', folder: '/home/someone/code' }, 'win32')).toBeNull();
  });

  it.each<[string, unknown]>([
    ['not an object', 42],
    ['a list', [entry()]],
    ['an id that is not a UUID', entry({ id: 'session-1' })],
    ['no id', (({ id: _id, ...rest }) => rest)(entry())],
    ['a project id that is not a UUID', entry({ projectId: 'fat-g' })],
    ['a provider id that is not a catalog id', entry({ providerId: 'co dex' })],
    ['a provider id that is not a string', entry({ providerId: 7 })],
    ['an empty model', entry({ model: '' })],
    ['a model with a space', entry({ model: 'gpt 6' })],
    ['an effort that is not an id', entry({ effort: 'very high' })],
    ['an effort that is neither a string nor null', entry({ effort: 3 })],
    ['a missing effort', (({ effort: _effort, ...rest }) => rest)(entry())],
    ['no speed tier: a version-7 entry', (({ speed: _speed, ...rest }) => rest)(entry())],
    ['a speed tier that is not an id', entry({ speed: 'very fast' })],
    ['a speed tier that is neither a string nor null', entry({ speed: true })],
    ['an empty reference', entry({ reference: '' })],
    ['a reference of 257 characters', entry({ reference: 'r'.repeat(257) })],
    ['a reference with a control character', entry({ reference: 'abc\ndef' })],
    ['a relative folder', entry({ reference: 'r', folder: 'Code\\fat-g' })],
    ['a folder that is not a string', entry({ folder: 5 })],
    ['no instance: a version-2 entry', (({ instanceId: _instanceId, ...rest }) => rest)(entry())],
    ['an instance that is neither the first one’s id nor a UUID', entry({ instanceId: 'work' })],
    ['an instance that is not a string', entry({ instanceId: 1 })],
    ['an empty instance', entry({ instanceId: '' })],
    ['no configuration folder', (({ configFolder: _configFolder, ...rest }) => rest)(entry())],
    ['a relative configuration folder', entry({ configFolder: 'accounts\\work' })],
    ['a configuration folder that is not a string', entry({ configFolder: 5 })],
    ['an empty configuration folder', entry({ configFolder: '' })],
    ['a name with no source', entry({ name: 'Plan' })],
    ['a source with no name', entry({ nameSource: 'user' })],
    ['a source this build does not know', entry({ name: 'Plan', nameSource: 'robot' })],
    ['a name that is empty once normalized', entry({ name: ' \t ', nameSource: 'user' })],
    ['a star that is not a boolean', entry({ starred: 'yes' })],
    ['a To do that is not a boolean', entry({ toDo: 1 })],
    ['no To verify: a version-5 entry', (({ toVerify: _toVerify, ...rest }) => rest)(entry())],
    ['no shelving: a version-5 entry', (({ shelvedAt: _shelvedAt, ...rest }) => rest)(entry())],
    ['a shelving that is not a time', entry({ shelvedAt: true })],
    ['shelved and completed at once', entry({ shelvedAt: AT + 1, completedAt: AT + 2 })],
    ['a completion that is not a time', entry({ completedAt: '2020-01-22' })],
    ['a completion stored as a flag', entry({ completedAt: true })],
    ['a negative time', entry({ createdAt: -1 })],
    ['a fractional time', entry({ lastActiveAt: 1.5 })],
    ['a missing created time', (({ createdAt: _createdAt, ...rest }) => rest)(entry())],
    ['a last turn that is not an object', entry({ lastTurn: 'done' })],
    ['a last turn with no start', entry({ lastTurn: { turnId: 'turn-0', endedAt: AT, outcome: 'completed' } })],
    // The record and the conversation store are reconciled by it (M18, C29).
    ['a last turn with no turn id', entry({ lastTurn: { startedAt: AT, endedAt: AT, outcome: 'completed' } })],
    ['a last turn whose turn id is empty', entry({ lastTurn: { turnId: '', startedAt: AT, endedAt: AT, outcome: 'completed' } })],
    ['a last turn whose turn id is not a string', entry({ lastTurn: { turnId: 7, startedAt: AT, endedAt: AT, outcome: 'completed' } })],
    ['a last turn with an outcome this build does not know', entry({ lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: AT, outcome: 'exploded' } })],
    ['a last turn whose end is not a time', entry({ lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: 'later', outcome: null } })],
    ['a missing last turn', (({ lastTurn: _lastTurn, ...rest }) => rest)(entry())],
  ])('cannot read %s', (_name, raw) => {
    expect(readSession(raw, 'win32')).toBeNull();
  });
});

describe('the ids an entry stores, readable or not (C13, C107)', () => {
  it('gives a session entry’s project id only when it is a UUID', () => {
    expect(storedProjectId({ projectId: PROJECT, id: 'broken' })).toBe(PROJECT);
    for (const raw of [{ projectId: 'fat-g' }, { projectId: 5 }, {}, 'text', null, [PROJECT]]) expect(storedProjectId(raw)).toBeNull();
  });

  it('gives a project entry’s id whenever it is a string', () => {
    expect(storedId({ id: PROJECT, name: 5 })).toBe(PROJECT);
    expect(storedId({ id: 'not-a-uuid' })).toBe('not-a-uuid');
    for (const raw of [{ id: 5 }, {}, 42, null]) expect(storedId(raw)).toBeNull();
  });
});
