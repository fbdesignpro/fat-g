// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 and V23: storing and comparing roots, with the platform injected so each OS's rules run on
// every OS (docs/planning/_archive/M12.md, Design 5).
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLookups, type LookupFs } from './lookup';
import { comparable, firstOverlap, folderName, normalizeRoot, overlapWith, relationOf } from './paths';
import { createRootCheck } from './root-check';

const enoent = (): NodeJS.ErrnoException => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('normalizeRoot (C24)', () => {
  it.each([
    ['win32', 'C:\\Code\\fat-g', 'C:\\Code\\fat-g'],
    ['win32', 'C:\\Code\\fat-g\\', 'C:\\Code\\fat-g'],
    ['win32', 'C:/Code/fat-g/', 'C:\\Code\\fat-g'],
    ['win32', 'c:\\code\\Fat-G', 'c:\\code\\Fat-G'],
    ['win32', 'C:\\Code\\x\\..\\fat-g', 'C:\\Code\\fat-g'],
    ['win32', 'C:\\', 'C:\\'],
    ['win32', 'd:/', 'd:\\'],
    ['win32', '\\\\server\\share\\', '\\\\server\\share\\'],
    ['win32', '\\\\server\\share\\projects\\', '\\\\server\\share\\projects'],
    ['linux', '/home/someone/code/', '/home/someone/code'],
    ['linux', '/home/someone/./code/../app', '/home/someone/app'],
    ['linux', '/', '/'],
    ['darwin', '/Users/someone/Code', '/Users/someone/Code'],
    ['darwin', '/Users/someone/Cafe\u0301', '/Users/someone/Cafe\u0301'],
  ])('%s: %j is stored as %j', (platform, input, expected) => {
    expect(normalizeRoot(input, platform)).toBe(expected);
  });

  it.each([
    ['win32', 'Code\\fat-g'],
    ['win32', '\\Code'],
    ['win32', 'C:Code'],
    ['win32', ''],
    ['win32', 'C:\\a\0b'],
    ['linux', 'code/fat-g'],
    ['linux', 'C:\\Code'],
    ['darwin', '~/Code'],
  ])('%s: refuses %j, which is not absolute', (platform, input) => {
    expect(normalizeRoot(input, platform)).toBeNull();
  });
});

describe('folderName (C17)', () => {
  it.each([
    ['win32', 'C:\\Code\\fat-g', 'fat-g'],
    ['win32', 'C:\\', null],
    ['win32', '\\\\server\\share\\', null],
    ['win32', '\\\\server\\share\\projects', 'projects'],
    ['linux', '/home/someone/website', 'website'],
    ['linux', '/', null],
  ])('%s: %j proposes %j', (platform, root, expected) => {
    expect(folderName(root, platform)).toBe(expected);
  });
});

describe('relationOf', () => {
  it.each([
    ['C:\\a', 'C:\\a', 'same'],
    ['C:\\a', 'C:\\a\\b', 'inside'],
    ['C:\\a\\b', 'C:\\a', 'around'],
    ['C:\\a', 'C:\\ab', 'apart'],
    ['C:\\ab', 'C:\\a', 'apart'],
    ['C:\\', 'C:\\a', 'inside'],
    ['C:\\a', 'C:\\', 'around'],
    ['C:\\a', 'D:\\a', 'apart'],
  ])('%j and %j: %s', (a, b, expected) => {
    expect(relationOf(a, b, '\\')).toBe(expected);
  });

  it('works with POSIX roots too', () => {
    expect(relationOf('/', '/home', '/')).toBe('inside');
    expect(relationOf('/home/a', '/home/ab', '/')).toBe('apart');
  });
});

describe('comparable (C78)', () => {
  it('folds case and separators on Windows', () => {
    expect(comparable('C:\\Code/App', 'win32')).toBe(comparable('c:\\code\\app', 'win32'));
  });

  it('folds case and Unicode forms on macOS', () => {
    expect(comparable('/Users/x/Cafe\u0301', 'darwin')).toBe(comparable('/users/x/Caf\u00e9', 'darwin'));
  });

  it('keeps every difference on Linux', () => {
    expect(comparable('/home/App', 'linux')).not.toBe(comparable('/home/app', 'linux'));
    expect(comparable('/home/Cafe\u0301', 'linux')).not.toBe(comparable('/home/Caf\u00e9', 'linux'));
  });

  it('does not fold separators outside Windows: a backslash is a letter there', () => {
    expect(comparable('/home/a\\b', 'linux')).toBe('/home/a\\b');
  });
});

// ── V23: real paths, with the file system replaced ──────────────────────────────────────────

/** A file system holding these folders, with links, under one case rule. */
function fakeFs(folders: readonly string[], options: { caseSensitive: boolean; links?: Record<string, string>; hang?: readonly string[]; fail?: readonly string[] }): LookupFs {
  const fold = (value: string) => (options.caseSensitive ? value : value.toLowerCase());
  return {
    realpath(value) {
      if (options.hang?.includes(value)) return new Promise(() => undefined);
      if (options.fail?.includes(value)) return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      const target = options.links?.[value] ?? value;
      const found = folders.find((folder) => fold(folder) === fold(target));
      return found === undefined ? Promise.reject(enoent()) : Promise.resolve(found);
    },
    stat(value) {
      const found = folders.find((folder) => fold(folder) === fold(value));
      return found === undefined ? Promise.reject(enoent()) : Promise.resolve({ isDirectory: () => true });
    },
  };
}

describe.each([
  ['win32', 'C:\\Code', '\\'],
  ['darwin', '/Users/someone/Code', '/'],
  ['linux', '/home/someone/code', '/'],
])('real paths on %s (C25, V23)', (platform, base, sep) => {
  const at = (...parts: string[]) => [base, ...parts].join(sep);

  it('on a case-sensitive filesystem, App and app are two folders', async () => {
    const lookups = createLookups({ fs: fakeFs([at('App'), at('app')], { caseSensitive: true }) });
    expect(await firstOverlap([at('App'), at('app')], platform, lookups)).toBeNull();
  });

  it('on a case-insensitive filesystem, App and app are one', async () => {
    const lookups = createLookups({ fs: fakeFs([at('App')], { caseSensitive: false }) });
    expect(await firstOverlap([at('App'), at('app')], platform, lookups)).toEqual({ first: 0, second: 1, relation: 'same' });
  });

  it('nesting follows the same answer', async () => {
    const insensitive = createLookups({ fs: fakeFs([at('App'), at('App', 'src')], { caseSensitive: false }) });
    expect(await firstOverlap([at('app', 'SRC'), at('APP')], platform, insensitive)).toEqual({ first: 0, second: 1, relation: 'around' });
    const sensitive = createLookups({ fs: fakeFs([at('App'), at('app'), at('app', 'src')], { caseSensitive: true }) });
    expect(await firstOverlap([at('App'), at('app', 'src')], platform, sensitive)).toBeNull();
  });

  it('a link counts as the folder it leads to', async () => {
    const lookups = createLookups({ fs: fakeFs([at('App')], { caseSensitive: true, links: { [at('shortcut')]: at('App') } }) });
    expect(await firstOverlap([at('App'), at('shortcut')], platform, lookups)).toEqual({ first: 0, second: 1, relation: 'same' });
  });

  it('falls back to the OS’s usual rules when a real path fails', async () => {
    const lookups = createLookups({ fs: fakeFs([at('App'), at('app')], { caseSensitive: true, fail: [at('app')] }) });
    const result = await firstOverlap([at('App'), at('app')], platform, lookups);
    expect(result).toEqual(platform === 'linux' ? null : { first: 0, second: 1, relation: 'same' });
  });

  it('falls back when a lookup never answers', async () => {
    const lookups = createLookups({ fs: fakeFs([at('App')], { caseSensitive: true, hang: [at('App')] }), deadlineMs: 20 });
    const result = await firstOverlap([at('App'), at('app', 'src')], platform, lookups);
    expect(result).toEqual(platform === 'linux' ? null : { first: 0, second: 1, relation: 'inside' });
  });

  it('compares missing folders by their stored paths', async () => {
    const lookups = createLookups({ fs: fakeFs([], { caseSensitive: true }) });
    expect(await firstOverlap([at('gone'), at('gone', 'deeper')], platform, lookups)).toEqual({ first: 0, second: 1, relation: 'inside' });
  });
});

describe('the overlap order (C26)', () => {
  const lookups = createLookups({ fs: fakeFs([], { caseSensitive: false }) });

  it('reports the first pair a reader meets, the earlier root first', async () => {
    expect(await firstOverlap(['C:\\a', 'C:\\b', 'C:\\b\\c', 'C:\\a'], 'win32', lookups)).toEqual({ first: 1, second: 2, relation: 'inside' });
    expect(await firstOverlap(['C:\\x\\y', 'D:\\z', 'C:\\x'], 'win32', lookups)).toEqual({ first: 0, second: 2, relation: 'around' });
    expect(await firstOverlap(['C:\\a', 'C:\\b'], 'win32', lookups)).toBeNull();
  });

  it('tells the picker how a new folder stands to the draft’s roots', async () => {
    expect(await overlapWith(['C:\\a', 'C:\\b'], 'C:\\b\\c', 'win32', lookups)).toEqual({ index: 1, relation: 'inside' });
    expect(await overlapWith(['C:\\a\\b'], 'C:\\A', 'win32', lookups)).toEqual({ index: 0, relation: 'around' });
    expect(await overlapWith([], 'C:\\A', 'win32', lookups)).toBeNull();
  });
});

describe('the root check (C28, C29)', () => {
  it('marks a missing folder, clears the mark when it is back, and removes nothing', async () => {
    const folders = ['C:\\a'];
    const fs: LookupFs = {
      realpath: () => Promise.reject(enoent()),
      stat: (value) => (folders.includes(value) ? Promise.resolve({ isDirectory: () => true }) : Promise.reject(enoent())),
    };
    let changes = 0;
    const check = createRootCheck(createLookups({ fs }), () => { changes += 1; });
    await check.check(['C:\\a', 'C:\\b']);
    expect([check.isMissing('C:\\a'), check.isMissing('C:\\b'), changes]).toEqual([false, true, 1]);
    await check.check(['C:\\a', 'C:\\b']);
    expect(changes).toBe(1);
    folders.push('C:\\b');
    await check.check(['C:\\b']);
    expect([check.isMissing('C:\\b'), changes]).toEqual([false, 2]);
  });

  it('counts a file where the folder was, and ENOTDIR, as missing; any other refusal as present', async () => {
    const answers: Record<string, () => Promise<{ isDirectory(): boolean }>> = {
      'C:\\file': () => Promise.resolve({ isDirectory: () => false }),
      'C:\\under-a-file\\x': () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTDIR' })),
      'C:\\locked': () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })),
    };
    const check = createRootCheck(createLookups({ fs: { realpath: () => Promise.reject(enoent()), stat: (value) => answers[value]?.() ?? Promise.reject(enoent()) } }), () => undefined);
    await check.check(Object.keys(answers));
    expect(Object.keys(answers).map((root) => check.isMissing(root))).toEqual([true, true, false]);
  });

  it('keeps the previous state for a check that never answers', async () => {
    let hang = false;
    const fs: LookupFs = {
      realpath: () => Promise.reject(enoent()),
      stat: () => (hang ? new Promise(() => undefined) : Promise.reject(enoent())),
    };
    const check = createRootCheck(createLookups({ fs, deadlineMs: 20 }), () => undefined);
    await check.check(['E:\\share']);
    expect(check.isMissing('E:\\share')).toBe(true);
    hang = true;
    await check.check(['E:\\share']);
    expect(check.isMissing('E:\\share')).toBe(true);
    const fresh = createRootCheck(createLookups({ fs, deadlineMs: 20 }), () => undefined);
    await fresh.check(['E:\\share']);
    expect(fresh.isMissing('E:\\share')).toBe(false);
  });
});

// One test on the real disk: whether this filesystem keeps App and app apart is learned by making
// both, and the comparison must agree with it (V23).
describe('on the real disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fatg-case-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('agrees with the filesystem about App and app', async () => {
    const upper = path.join(dir, 'App');
    const lower = path.join(dir, 'app');
    mkdirSync(upper);
    let separate: boolean;
    try {
      mkdirSync(lower);
      separate = statSync(upper).ino !== statSync(lower).ino || statSync(upper).ino === 0;
    } catch {
      separate = false; // EEXIST: the filesystem took `app` for `App`
    }
    const stored = [normalizeRoot(upper, process.platform) ?? '', normalizeRoot(lower, process.platform) ?? ''];
    const result = await firstOverlap(stored, process.platform, createLookups());
    expect(result === null).toBe(separate);
  });
});
