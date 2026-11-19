// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnvelope } from './envelope';
import { errorKind } from './error-kind';
import { readJsonFile, serializeJson } from './json-file';
import { lstat, rename } from 'node:fs/promises';
import { MAX_SUFFIX, setAside, setAsideName, setAsideStamp, setAsideTogether, type SetAsideIo } from './set-aside';

const errno = (code: string, message = code): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

describe('readEnvelope', () => {
  it.each([
    ['a matching file', { schemaVersion: 1, minReaderVersion: 1 }, 1, { kind: 'ok', schemaVersion: 1, minReaderVersion: 1 }],
    ['a newer file this reader may edit', { schemaVersion: 2, minReaderVersion: 1 }, 1, { kind: 'ok', schemaVersion: 2, minReaderVersion: 1 }],
    ['a file that needs a newer reader', { schemaVersion: 2, minReaderVersion: 2 }, 1, { kind: 'newer', schemaVersion: 2, minReaderVersion: 2 }],
    ['an older format', { schemaVersion: 1, minReaderVersion: 1 }, 2, { kind: 'older', schemaVersion: 1, minReaderVersion: 1 }],
  ])('reads %s', (_name, document, reader, expected) => {
    expect(readEnvelope(document, reader)).toEqual(expected);
  });

  it.each([
    ['null', null],
    ['an array', [1]],
    ['a number', 42],
    ['no envelope', {}],
    ['a missing minimum', { schemaVersion: 1 }],
    ['a zero', { schemaVersion: 0, minReaderVersion: 0 }],
    ['a fraction', { schemaVersion: 1.5, minReaderVersion: 1 }],
    ['a string', { schemaVersion: '1', minReaderVersion: 1 }],
    ['a minimum above the version', { schemaVersion: 1, minReaderVersion: 2 }],
  ])('calls %s corrupt', (_name, document) => {
    expect(readEnvelope(document, 1)).toEqual({ kind: 'corrupt' });
  });
});

describe('readJsonFile', () => {
  it('tells a missing file from one the OS refused, and neither from bad JSON', () => {
    expect(readJsonFile('x', () => { throw errno('ENOENT'); })).toEqual({ kind: 'missing' });
    expect(readJsonFile('x', () => { throw errno('EBUSY', "EBUSY: resource busy, open 'C:\\Users\\someone\\records.json'"); })).toEqual({ kind: 'unreadable', code: 'EBUSY' });
    expect(readJsonFile('x', () => { throw new Error('no code'); })).toEqual({ kind: 'unreadable', code: null });
    expect(readJsonFile('x', () => '{')).toEqual({ kind: 'invalid-json' });
    expect(readJsonFile('x', () => '[1]')).toEqual({ kind: 'parsed', value: [1] });
  });

  it('writes two-space JSON with a final newline', () => {
    expect(serializeJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });
});

describe('errorKind (C54, C77)', () => {
  it('names the class and a code, never the message', () => {
    const error = errno('EPERM', "EPERM: operation not permitted, rename 'C:\\Users\\someone\\records.json.tmp'");
    expect(errorKind(error)).toBe('Error EPERM');
    expect(errorKind(new TypeError('secret name'))).toBe('TypeError');
    class RecordsBusy extends Error {}
    expect(errorKind(new RecordsBusy('x'))).toBe('RecordsBusy');
  });

  it('drops a code that is not a code', () => {
    expect(errorKind(Object.assign(new Error('x'), { code: 'C:\\Users\\someone' }))).toBe('Error');
    expect(errorKind(Object.assign(new Error('x'), { code: 42 }))).toBe('Error');
  });

  it('says unknown for what is not an object', () => {
    expect(errorKind('C:\\Users\\someone')).toBe('unknown');
    expect(errorKind(undefined)).toBe('unknown');
    expect(errorKind(Object.create(null))).toBe('unknown');
  });
});

describe('setAside (C61)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fatg-aside-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const at = Date.parse('2020-01-21T14:03:12.345Z');

  it('dates the name in UTC to the second, legal in every file name', () => {
    expect(setAsideStamp(at)).toBe('2020-01-21T14-03-12Z');
    expect(setAsideName('records.json', at)).toBe('records.set-aside.2020-01-21T14-03-12Z.json');
    expect(setAsideName('records.json', at, 2)).toBe('records.set-aside.2020-01-21T14-03-12Z-2.json');
  });

  it('moves the file byte-identical, and never over an earlier copy', async () => {
    const bytes = '{ "schemaVersion": 9, broken\r\n';
    writeFileSync(path.join(dir, 'records.json'), bytes);
    const first = await setAside(dir, 'records.json', at);
    expect(first).toBe(path.join(dir, 'records.set-aside.2020-01-21T14-03-12Z.json'));
    writeFileSync(path.join(dir, 'records.json'), 'second');
    const second = await setAside(dir, 'records.json', at);
    expect(path.basename(second)).toBe('records.set-aside.2020-01-21T14-03-12Z-2.json');
    expect(readFileSync(first, 'utf8')).toBe(bytes);
    expect(readFileSync(second, 'utf8')).toBe('second');
    expect(readdirSync(dir).sort()).toEqual([path.basename(first), path.basename(second)].sort());
  });

  it('rejects, moving nothing, when the rename fails or every name is taken', async () => {
    writeFileSync(path.join(dir, 'records.json'), 'x');
    const failing: SetAsideIo = { lstat: () => Promise.reject(errno('ENOENT')), rename: () => Promise.reject(errno('EBUSY')) };
    await expect(setAside(dir, 'records.json', at, failing)).rejects.toMatchObject({ code: 'EBUSY' });
    const full: SetAsideIo = { lstat: () => Promise.resolve({}), rename: () => Promise.reject(new Error('never called')) };
    await expect(setAside(dir, 'records.json', at, full)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readdirSync(dir)).toEqual(['records.json']);
    expect(MAX_SUFFIX).toBe(99);
  });

  it('does not take an lstat failure other than ENOENT as a free name', async () => {
    const io: SetAsideIo = { lstat: () => Promise.reject(errno('EACCES')), rename: () => Promise.resolve() };
    await expect(setAside(dir, 'records.json', at, io)).rejects.toMatchObject({ code: 'EACCES' });
  });
});

// M18 (V18; C40): the conversation store is its main file and what SQLite keeps beside it.
describe('setAsideTogether (M18, C40)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fatg-aside-together-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const at = Date.parse('2020-01-25T14:03:12.345Z');
  const NAMES = ['conversations.sqlite', 'conversations.sqlite-wal', 'conversations.sqlite-shm'];
  const fill = (): void => { for (const name of NAMES) writeFileSync(path.join(dir, name), `bytes of ${name}`); };

  it('moves the files together under one dated name, each keeping its ending and its bytes', async () => {
    fill();
    const kept = await setAsideTogether(dir, NAMES, at);
    expect(kept).toBe(path.join(dir, 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite'));
    expect(readdirSync(dir).sort()).toEqual(['conversations.set-aside.2020-01-25T14-03-12Z.sqlite', 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite-shm', 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite-wal']);
    for (const name of NAMES) expect(readFileSync(path.join(dir, name.replace('conversations.', 'conversations.set-aside.2020-01-25T14-03-12Z.')), 'utf8')).toBe(`bytes of ${name}`);
  });

  it('passes over a file that is not there: a store closed cleanly is its main file alone', async () => {
    writeFileSync(path.join(dir, 'conversations.sqlite'), 'main');
    await setAsideTogether(dir, NAMES, at);
    expect(readdirSync(dir)).toEqual(['conversations.set-aside.2020-01-25T14-03-12Z.sqlite']);
  });

  it('finds one attempt number free for every name: a set never shares a number with part of an earlier one', async () => {
    fill();
    // An earlier copy's log alone is in the way.
    writeFileSync(path.join(dir, 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite-wal'), 'earlier');
    const kept = await setAsideTogether(dir, NAMES, at);
    expect(path.basename(kept)).toBe('conversations.set-aside.2020-01-25T14-03-12Z-2.sqlite');
    expect(readdirSync(dir).filter((name) => name.includes('Z-2.')).sort()).toEqual(['conversations.set-aside.2020-01-25T14-03-12Z-2.sqlite', 'conversations.set-aside.2020-01-25T14-03-12Z-2.sqlite-shm', 'conversations.set-aside.2020-01-25T14-03-12Z-2.sqlite-wal']);
    expect(readFileSync(path.join(dir, 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite-wal'), 'utf8')).toBe('earlier');
  });

  it('moves back what it moved when a later rename fails: all of them, or none', async () => {
    fill();
    let calls = 0;
    // The second rename fails: the log's.
    const io: SetAsideIo = { lstat, rename: (from, to) => { calls += 1; return calls === 2 ? Promise.reject(errno('EBUSY')) : rename(from, to); } };
    await expect(setAsideTogether(dir, NAMES, at, io)).rejects.toMatchObject({ code: 'EBUSY' });
    expect(readdirSync(dir).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) expect(readFileSync(path.join(dir, name), 'utf8')).toBe(`bytes of ${name}`);
  });

  it('rejects when every name is taken, and for no names at all', async () => {
    fill();
    const full: SetAsideIo = { lstat: () => Promise.resolve({}), rename: () => Promise.reject(new Error('never called')) };
    await expect(setAsideTogether(dir, NAMES, at, full)).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(setAsideTogether(dir, [], at)).rejects.toThrow();
    expect(readdirSync(dir).sort()).toEqual([...NAMES].sort());
  });
});
