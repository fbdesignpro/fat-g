// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V20 (docs/planning/_archive/M19b.md; C55): the lookup of a bare name, on the recording stand-in. A model
// names a file by its name alone; the reader looks it up in the project's trusted folders, the
// nearest first, and what it finds goes through the same checks as any target.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileReadAnswer } from '@shared/contracts/files';
import { createReadLimiter, READ_DEADLINE_MS } from './limiter';
import { harness, SESSION, standIn } from './test-support';
import { findByName, WALK_MAX_ENTRIES } from './walk';

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
const on = (platform: string) => (...parts: string[]): string => (platform === 'win32' ? `C:\\${parts.join('\\')}` : `/${parts.join('/')}`);
const read = (h: ReturnType<typeof harness>, target: string): Promise<FileReadAnswer | null> => h.reader.read({ sessionId: SESSION, target });
const lists = (h: ReturnType<typeof harness>): string[] => h.calls.filter((call) => call.op === 'list').map((call) => call.path);

afterEach(() => {
  vi.useRealTimers();
});

describe.each(PLATFORMS)('a bare name that is no file where it resolves, on %s (V20; C55)', (platform) => {
  const abs = on(platform);
  const root = abs('proj');

  it('is found in a subfolder of a trusted root, and opened through the same checks', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'README.md')]: '# Tide tools\n', [abs('proj', 'field notes', 'harbour-log.md')]: '# Harbour log\n' }, roots: [root] });
    expect(await read(h, 'harbour-log.md:3')).toEqual({ outcome: 'text', path: abs('proj', 'field notes', 'harbour-log.md'), root, view: 'markdown', text: '# Harbour log\n', revision: { mtimeMs: 0, size: 14 }, line: 3, column: null });
    // Looked for where it resolves first, then in the folders, then checked as any target: its real path too.
    expect(h.asked()).toEqual([
      `stat ${abs('proj', 'harbour-log.md')}`, `list ${root}`, `list ${abs('proj', 'field notes')}`, `stat ${abs('proj', 'field notes', 'harbour-log.md')}`,
      `realpath ${abs('proj', 'field notes', 'harbour-log.md')}`, `realpath ${root}`, `read ${abs('proj', 'field notes', 'harbour-log.md')}`,
      `stat ${abs('proj', 'field notes', 'harbour-log.md')}`, `realpath ${abs('proj', 'field notes', 'harbour-log.md')}`, `realpath ${root}`,
    ]);
  });

  it('opens none of two files of the name, and says several', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'a', 'notes.md')]: '# A\n', [abs('proj', 'b', 'notes.md')]: '# B\n' }, roots: [root] });
    expect(await read(h, 'notes.md')).toEqual({ outcome: 'refused', why: 'several' });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });

  it('says not found for a name that is nowhere', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'a', 'other.md')]: '' }, roots: [root] });
    expect(await read(h, 'console.log')).toEqual({ outcome: 'refused', why: 'not-found' });
  });

  it('goes nearest folders first, breadth first from each root', async () => {
    const h = harness({
      platform,
      tree: { [abs('proj', 'a', 'deep', 'deeper', 'x.md')]: '', [abs('proj', 'b', 'x.txt')]: '', [abs('second', 'c', 'y.md')]: '' },
      roots: [root, abs('second')],
    });
    await read(h, 'nowhere.md');
    expect(lists(h)).toEqual([root, abs('second'), abs('proj', 'a'), abs('proj', 'b'), abs('second', 'c'), abs('proj', 'a', 'deep'), abs('proj', 'a', 'deep', 'deeper')]);
  });

  it('follows no link, and enters no dot folder, no node_modules, no refused folder, and no root that is untrusted or missing', async () => {
    const h = harness({
      platform,
      tree: {
        [abs('proj', 'src', 'ok.md')]: '',
        [abs('proj', '.git', 'wanted.md')]: '# in a dot folder\n',
        [abs('proj', 'node_modules', 'pkg', 'wanted.md')]: '# in a dependency\n',
        [abs('proj', 'accounts', 'work', 'wanted.md')]: '# in an account\n',
        [abs('elsewhere', 'wanted.md')]: '# outside\n',
        [abs('proj', 'door')]: { link: abs('elsewhere') },
        [abs('proj', 'wanted-link.md')]: { link: abs('elsewhere', 'wanted.md') },
        [abs('untrusted', 'wanted.md')]: '# untrusted\n',
        [abs('gone', 'wanted.md')]: '# missing\n',
      },
      roots: [root, { path: abs('untrusted'), answer: 'not-trusted' }, abs('gone')],
      refused: [abs('proj', 'accounts', 'work')],
    });
    h.missing.add(abs('gone'));
    expect(await read(h, 'wanted.md')).toEqual({ outcome: 'refused', why: 'not-found' });
    // `accounts` is entered, and the account's folder inside it is not.
    expect(lists(h)).toEqual([root, abs('proj', 'src'), abs('proj', 'accounts')]);
  });

  it('counts a file of the name in node_modules as none: the project’s own is the one', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'docs', 'README.md')]: '# Ours\n', [abs('proj', 'node_modules', 'pkg', 'README.md')]: '# A dependency’s\n' }, roots: [root] });
    expect(await read(h, 'README.md')).toMatchObject({ outcome: 'text', text: '# Ours\n' });
  });

  it('starts no walk for a target with a separator, nor for one found where it resolves', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'README.md')]: '# Top\n', [abs('proj', 'sub', 'x.md')]: '' }, roots: [root] });
    expect(await read(h, 'docs/x.md')).toEqual({ outcome: 'refused', why: 'not-found' });
    expect(await read(h, './x.md')).toEqual({ outcome: 'refused', why: 'not-found' });
    expect(await read(h, 'README.md')).toMatchObject({ outcome: 'text' });
    expect(lists(h)).toEqual([]);
  });
});

describe('the walk’s names and bounds (V20; C55)', () => {
  it('compares a name as each system compares stored paths', async () => {
    const windows = harness({ platform: 'win32', tree: { 'C:\\proj\\Docs\\Harbour-Log.MD': '# H\n' }, roots: ['C:\\proj'] });
    expect(await read(windows, 'harbour-log.md')).toMatchObject({ outcome: 'text', path: 'C:\\proj\\Docs\\Harbour-Log.MD' });
    const linux = harness({ platform: 'linux', tree: { '/proj/Docs/Harbour-Log.MD': '# H\n' }, roots: ['/proj'] });
    expect(await read(linux, 'harbour-log.md')).toEqual({ outcome: 'refused', why: 'not-found' });
  });

  it('looks up no name with a drive in it on Windows, and neither of the two dots', async () => {
    const h = harness({ platform: 'win32', tree: { 'C:\\proj\\a\\x.md': '' }, roots: ['C:\\proj'], folder: 'C:\\proj\\a' });
    for (const target of ['..', '.']) expect((await read(h, target))?.outcome).toBe('refused');
    expect(lists(h)).toEqual([]);
  });

  it('stops at 20,000 entries: a file past them is not found', async () => {
    expect(WALK_MAX_ENTRIES).toBe(20_000);
    const tree: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) tree[`/proj/a/f${index}.txt`] = '';
    tree['/proj/z/wanted.md'] = '# W\n';
    const stand = standIn('linux', tree);
    const clock = () => createReadLimiter().begin();
    const walk = (maxEntries: number) => findByName({ fs: stand.fs, clock: clock(), platform: 'linux', roots: ['/proj'], name: 'wanted.md', refused: () => false, maxEntries });
    // The root's two folders, then `a`'s sixty files: the bound ends the walk before `z` is listed.
    expect(await walk(40)).toEqual({ found: 'none' });
    expect(stand.calls.map((call) => call.path)).toEqual(['/proj', '/proj/a']);
    expect(await walk(70)).toEqual({ found: 'one', path: '/proj/z/wanted.md' });
  });

  it('stops at the read’s deadline: a folder that does not answer gives “no answer”, and one found before it is the answer', async () => {
    vi.useFakeTimers();
    const h = harness({ platform: 'linux', tree: { '/proj/a/x.md': '', '/proj/b/y.md': '' }, roots: ['/proj'] });
    h.hung.add('/proj/a');
    const answer = read(h, 'wanted.md');
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(await answer).toEqual({ outcome: 'refused', why: 'no-answer' });
    // Nothing more was asked once the deadline had passed.
    expect(lists(h)).toEqual(['/proj', '/proj/a']);

    const stand = standIn('linux', { '/proj/wanted.md': '# W\n', '/proj/a/x.md': '' });
    stand.hung.add('/proj/a');
    const found = findByName({ fs: stand.fs, clock: createReadLimiter().begin(), platform: 'linux', roots: ['/proj'], name: 'wanted.md', refused: () => false });
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(await found).toEqual({ found: 'one', path: '/proj/wanted.md' });
  });

  it('passes over a folder that cannot be listed, and goes on', async () => {
    const h = harness({ platform: 'linux', tree: { '/proj/locked/x.md': '', '/proj/open/wanted.md': '# W\n' }, roots: ['/proj'] });
    h.failing.set('/proj/locked', 'EACCES');
    expect(await read(h, 'wanted.md')).toMatchObject({ outcome: 'text', path: '/proj/open/wanted.md' });
  });
});
