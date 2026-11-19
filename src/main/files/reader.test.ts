// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V5, V21 (docs/planning/_archive/M19b.md; C25–C34, C51, C56, C59): main's reader, on a file system
// stand-in that records every call. Each system's path rules run on every system. A refusal that the
// first confinement makes must have asked the file system nothing: `asked()` is what one read asked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_BYTES_BOUND, type FileReadAnswer } from '@shared/contracts/files';
import { createLookups } from '../records/lookup';
import { refusedFolders } from './confine';
import { READ_DEADLINE_MS, READ_SLOTS } from './limiter';
import { harness, SESSION, standIn } from './test-support';

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
/** An absolute path on a platform, from its parts. */
const on = (platform: string) => (...parts: string[]): string => (platform === 'win32' ? `C:\\${parts.join('\\')}` : `/${parts.join('/')}`);
const read = (h: ReturnType<typeof harness>, target: string, from?: string): Promise<FileReadAnswer | null> => h.reader.read({ sessionId: SESSION, target, ...(from === undefined ? {} : { from }) });
const OUTSIDE = { outcome: 'refused', why: 'outside' };

afterEach(() => {
  vi.useRealTimers();
});

describe.each(PLATFORMS)('the confinements, on %s (V4; C25–C28, C51)', (platform) => {
  const abs = on(platform);
  const root = abs('proj');
  const tree = {
    [abs('proj', 'README.md')]: '# Tide tools\n',
    [abs('proj', 'src', 'tides.js')]: 'export const a = 1;\n',
    [abs('proj', 'field notes', 'harbour-log.md')]: '# Harbour log\n',
    [abs('elsewhere', 'secret.md')]: '# Secret\n',
    [abs('other', 'a.md')]: '# Another project\n',
    [abs('proj', 'link.md')]: { link: abs('elsewhere', 'secret.md') },
    [abs('proj', 'junction')]: { link: abs('elsewhere') },
    [abs('proj', 'inner.md')]: { link: abs('proj', 'README.md') },
  };
  const make = () => harness({ platform, tree, roots: [root] });

  it('reads a file inside a trusted root, by a relative target resolved against the session’s folder', async () => {
    const h = make();
    expect(await read(h, 'README.md')).toEqual({ outcome: 'text', path: abs('proj', 'README.md'), root, view: 'markdown', text: '# Tide tools\n', revision: { mtimeMs: 0, size: 13 }, line: null, column: null });
    expect(await read(h, 'src/tides.js:12')).toMatchObject({ outcome: 'text', path: abs('proj', 'src', 'tides.js'), view: 'plain', line: 12, column: null });
    expect(await read(h, abs('proj', 'field notes', 'harbour-log.md'))).toMatchObject({ outcome: 'text', text: '# Harbour log\n' });
  });

  it.each([
    ['.. out of the root', '../elsewhere/secret.md'],
    ['.. past the root, back into another folder', '../../elsewhere/../elsewhere/secret.md'],
    ['an absolute path elsewhere', abs('elsewhere', 'secret.md')],
    ['another project’s root', abs('other', 'a.md')],
    ['a share’s path', '//host/share/a.md'],
    ['a file: URL with a host', 'file://host/share/a.md'],
  ])('refuses %s as outside, and asks the file system nothing', async (_name, target) => {
    const h = make();
    expect(await read(h, target)).toEqual(OUTSIDE);
    expect(h.asked()).toEqual([]);
  });

  it('refuses a link and a junction inside a root that lead out of it, on their real path', async () => {
    const h = make();
    expect(await read(h, 'link.md')).toEqual(OUTSIDE);
    // It was asked about: the stored path lies inside the root, and only the real one does not.
    expect(h.asked()).toContain(`stat ${abs('proj', 'link.md')}`);
    expect(await read(h, 'junction/secret.md')).toEqual(OUTSIDE);
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });

  it('reads a link inside a root that stays inside it, and answers the file’s real path', async () => {
    expect(await read(make(), 'inner.md')).toMatchObject({ outcome: 'text', path: abs('proj', 'README.md'), text: '# Tide tools\n' });
  });

  it.each([['not trusted', 'not-trusted' as const], ['not answered', null]])('holds nothing in a root that is %s', async (_name, answer) => {
    const h = harness({ platform, tree, roots: [{ path: root, answer }], folder: root });
    expect(await read(h, 'README.md')).toEqual(OUTSIDE);
    expect(await read(h, abs('proj', 'README.md'))).toEqual(OUTSIDE);
    expect(h.asked()).toEqual([]);
  });

  it('holds nothing in a root that is marked missing', async () => {
    const h = make();
    h.missing.add(root);
    expect(await read(h, 'README.md')).toEqual(OUTSIDE);
    expect(h.asked()).toEqual([]);
  });

  it('reads in any trusted root of the session’s project, and in no other project’s', async () => {
    const h = harness({ platform, tree, roots: [root, abs('other')] });
    expect(await read(h, abs('other', 'a.md'))).toMatchObject({ outcome: 'text', root: abs('other') });
    h.roots.pop();
    expect(await read(h, abs('other', 'a.md'))).toEqual(OUTSIDE);
  });

  it('answers a bad request for a session that is not listed, and for a `from` that is no absolute path', async () => {
    const h = make();
    expect(await h.reader.read({ sessionId: '11111111-1111-4111-8111-111111111111', target: 'README.md' })).toBeNull();
    expect(await read(h, 'README.md', 'docs/guide.md')).toBeNull();
    expect(h.asked()).toEqual([]);
  });

  it('refuses a target that names nothing, and a session with no folder', async () => {
    expect(await read(make(), 'a\0b.md')).toEqual({ outcome: 'refused', why: 'not-found' });
    expect(await read(harness({ platform, tree, roots: [root], folder: null }), 'README.md')).toEqual(OUTSIDE);
  });

  describe('under a root that is the home folder (C28, C51)', () => {
    const home = abs('home', 'me');
    const definitions = [
      { descriptor: { id: 'claude' }, instances: { variable: 'CLAUDE_CONFIG_DIR', defaultFolder: ['.claude'], withhold: { exact: [], prefixes: [] } } },
      { descriptor: { id: 'codex' }, instances: { variable: 'CODEX_HOME', defaultFolder: ['.codex'], withhold: { exact: [], prefixes: [] } } },
      { descriptor: { id: 'plain' } },
    ];
    const folders = refusedFolders({
      definitions: definitions as never,
      instances: { codex: { added: [{ key: 'work', folder: abs('home', 'me', 'accounts', 'work') }, { key: 'unset', folder: null }] } },
      env: { CLAUDE_CONFIG_DIR: abs('home', 'me', 'alt-claude') },
      home,
      dataFolder: abs('home', 'me', 'AppData', 'fat-g'),
      platform,
    });
    const homeTree = {
      [abs('home', 'me', '.claude', 'settings.json')]: '{}',
      [abs('home', 'me', '.codex', 'config.toml')]: 'model = "x"\n',
      [abs('home', 'me', 'alt-claude', 'settings.json')]: '{}',
      [abs('home', 'me', 'accounts', 'work', 'auth.json')]: '{}',
      [abs('home', 'me', 'AppData', 'fat-g', 'records.json')]: '{}',
      [abs('home', 'me', '.ssh', 'known_hosts.txt')]: 'host key\n',
      [abs('home', 'me', 'notes.md')]: '# Notes\n',
      [abs('home', 'me', 'sneaky.json')]: { link: abs('home', 'me', '.claude', 'settings.json') },
      [abs('real-config')]: { folder: true as const },
      [abs('real-config', 'auth.json')]: '{}',
    };

    it('gathers each provider’s default folder, the one its variable names, each added account’s and the data folder', () => {
      expect(folders).toEqual([abs('home', 'me', '.claude'), abs('home', 'me', 'alt-claude'), abs('home', 'me', '.codex'), abs('home', 'me', 'accounts', 'work'), abs('home', 'me', 'AppData', 'fat-g')]);
    });

    it.each([
      ['a provider’s default folder', ['.claude', 'settings.json']],
      ['the other provider’s', ['.codex', 'config.toml']],
      ['the folder a provider’s variable names', ['alt-claude', 'settings.json']],
      ['an added account’s folder', ['accounts', 'work', 'auth.json']],
      ['fat-g’s data folder', ['AppData', 'fat-g', 'records.json']],
    ])('refuses a path in %s as outside, with no call', async (_name, parts) => {
      const h = harness({ platform, tree: homeTree, roots: [home], refused: folders });
      expect(await read(h, parts.join('/'))).toEqual(OUTSIDE);
      expect(await read(h, abs('home', 'me', ...parts))).toEqual(OUTSIDE);
      expect(h.asked()).toEqual([]);
    });

    it('refuses a link that leads into one of them, on its real path, with nothing read', async () => {
      const h = harness({ platform, tree: homeTree, roots: [home], refused: folders });
      expect(await read(h, 'sneaky.json')).toEqual(OUTSIDE);
      expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
    });

    it('refuses a path under such a folder’s real path too, where the stored one is a link', async () => {
      // The configuration folder is itself a link: a file reached by its real path is as refused.
      const linked = { ...homeTree, [abs('home', 'me', 'alt-claude')]: { link: abs('real-config') }, [abs('home', 'me', 'door')]: { link: abs('real-config') } };
      const h = harness({ platform, tree: linked, roots: [home, abs('real-config')], refused: folders });
      expect(await read(h, abs('real-config', 'auth.json'))).toEqual(OUTSIDE);
      expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
    });

    it('reads a file in .ssh under it, and any other file of the home folder: only those folders are refused', async () => {
      const h = harness({ platform, tree: homeTree, roots: [home], refused: folders });
      expect(await read(h, '.ssh/known_hosts.txt')).toMatchObject({ outcome: 'text', text: 'host key\n' });
      expect(await read(h, 'notes.md')).toMatchObject({ outcome: 'text', view: 'markdown' });
    });
  });
});

describe('letter case and Unicode forms follow each system’s rules (V4; M12, C78)', () => {
  it('folds letter case on Windows, and takes either separator', async () => {
    const h = harness({ platform: 'win32', tree: { 'C:\\Proj\\Src\\Tides.js': 'x\n' }, roots: ['C:\\Proj'] });
    expect(await read(h, 'SRC/TIDES.JS')).toMatchObject({ outcome: 'text', path: 'C:\\Proj\\Src\\Tides.js', root: 'C:\\Proj' });
    expect(await read(h, 'c:/proj/src/tides.js')).toMatchObject({ outcome: 'text', path: 'C:\\Proj\\Src\\Tides.js' });
  });

  it('reads /C:/… as the drive’s path on Windows, with its line (C22)', async () => {
    const h = harness({ platform: 'win32', tree: { 'C:\\Proj\\src\\tides.js': 'x\n' }, roots: ['C:\\Proj'] });
    expect(await read(h, '/C:/Proj/src/tides.js:12')).toMatchObject({ outcome: 'text', path: 'C:\\Proj\\src\\tides.js', line: 12 });
  });

  it('holds a path to its spelling on Linux: another case is another folder, refused with no call', async () => {
    const h = harness({ platform: 'linux', tree: { '/proj/a.md': '# A\n' }, roots: ['/proj'] });
    expect(await read(h, '/PROJ/a.md')).toEqual(OUTSIDE);
    expect(h.asked()).toEqual([]);
    expect(await read(h, '/proj/a.md')).toMatchObject({ outcome: 'text' });
  });

  it('folds case and Unicode forms on macOS', async () => {
    const composed = '/proj/caf\u00e9';
    const h = harness({ platform: 'darwin', tree: { [`${composed}/a.md`]: '# A\n' }, roots: [composed] });
    expect(await read(h, '/Proj/cafe\u0301/A.md')).toMatchObject({ outcome: 'text', path: `${composed}/a.md` });
  });

  it('refuses a share that is no root on Windows before anything is asked, in every spelling', async () => {
    const h = harness({ platform: 'win32', tree: { 'C:\\Proj\\a.md': '# A\n' }, roots: ['C:\\Proj'] });
    for (const target of ['\\\\host\\share\\a.md', '//host/share/a.md', '\\\\?\\C:\\Proj\\a.md', '\\\\.\\pipe\\x', 'file://host/share/a.md', 'file:////host/share/a.md']) {
      expect(await read(h, target), target).toEqual(OUTSIDE);
    }
    expect(h.asked()).toEqual([]);
  });

  it('reads a share that is a root: it is the user’s own', async () => {
    const h = harness({ platform: 'win32', tree: { '\\\\nas\\work\\a.md': '# A\n' }, roots: ['\\\\nas\\work'] });
    expect(await read(h, 'a.md')).toMatchObject({ outcome: 'text', path: '\\\\nas\\work\\a.md' });
  });
});

describe.each(PLATFORMS)('what is read, on %s (V5; C29–C34, C59)', (platform) => {
  const abs = on(platform);
  const root = abs('proj');
  const text = (value: string) => new TextEncoder().encode(value);
  const utf16 = (value: string, big: boolean): Uint8Array => {
    const bytes = new Uint8Array(2 + value.length * 2);
    bytes.set(big ? [0xfe, 0xff] : [0xff, 0xfe]);
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      bytes.set(big ? [unit >> 8, unit & 0xff] : [unit & 0xff, unit >> 8], 2 + index * 2);
    }
    return bytes;
  };

  it('refuses a folder, and a file that is not regular', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'docs', 'a.md')]: '', [abs('proj', 'pipe.txt')]: { device: true } }, roots: [root] });
    expect(await read(h, 'docs')).toEqual({ outcome: 'refused', why: 'folder' });
    expect(await read(h, '.')).toEqual({ outcome: 'refused', why: 'folder' });
    expect(await read(h, 'pipe.txt')).toEqual({ outcome: 'refused', why: 'not-regular' });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });

  it('never opens a file over the bound: its size is asked first', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'big.txt')]: { size: FILE_BYTES_BOUND + 1 }, [abs('proj', 'edge.txt')]: { size: FILE_BYTES_BOUND, bytes: text('edge') } }, roots: [root] });
    expect(await read(h, 'big.txt:3')).toEqual({ outcome: 'unshown', why: 'too-large', path: abs('proj', 'big.txt'), root, line: 3, column: null });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
    // One of exactly the bound is read.
    expect(await read(h, 'edge.txt')).toMatchObject({ outcome: 'text' });
  });

  it('cuts off a file that grows past the bound between its size and its read, as too large', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'grows.log')]: { size: 10, bytes: new Uint8Array(FILE_BYTES_BOUND + 64).fill(0x61) } }, roots: [root] });
    const answer = await read(h, 'grows.log');
    expect(answer).toEqual({ outcome: 'unshown', why: 'too-large', path: abs('proj', 'grows.log'), root, line: null, column: null });
    expect(answer).not.toHaveProperty('text');
  });

  it.each([
    ['UTF-8', text('héllo ✓\n')],
    ['UTF-8 with its mark', new Uint8Array([0xef, 0xbb, 0xbf, ...text('héllo ✓\n')])],
    ['UTF-16, little-endian, with its mark', utf16('héllo ✓\n', false)],
    ['UTF-16, big-endian, with its mark', utf16('héllo ✓\n', true)],
  ])('gives the text of %s, without the mark', async (_name, bytes) => {
    const h = harness({ platform, tree: { [abs('proj', 'a.txt')]: bytes }, roots: [root] });
    expect(await read(h, 'a.txt')).toMatchObject({ outcome: 'text', view: 'plain', text: 'héllo ✓\n' });
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0x21])],
    ['a U+0000 in the decoded text', new Uint8Array([0x61, 0x00, 0x62])],
    ['half a unit of UTF-16', new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x62])],
    ['a program', new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
  ])('answers “not text” for %s, with no text in the answer', async (_name, bytes) => {
    const h = harness({ platform, tree: { [abs('proj', 'a.txt')]: bytes }, roots: [root] });
    const answer = await read(h, 'a.txt');
    expect(answer).toEqual({ outcome: 'unshown', why: 'not-text', path: abs('proj', 'a.txt'), root, line: null, column: null });
    expect(answer).not.toHaveProperty('text');
  });

  it('gives an empty file as an empty text', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'empty.md')]: '' }, roots: [root] });
    expect(await read(h, 'empty.md')).toMatchObject({ outcome: 'text', view: 'markdown', text: '' });
  });

  // V21 (C31, C56): the view is named from the shared lists, and an unlisted file's bytes are never read.
  it('names the view from the lists, and reads none of an unlisted file’s bytes', async () => {
    const h = harness({
      platform,
      tree: { [abs('proj', 'a.MARKDOWN')]: '# A\n', [abs('proj', 'b.JSON')]: '{}', [abs('proj', 'Makefile')]: 'all:\n', [abs('proj', 'c.xyz')]: 'never read', [abs('proj', 'photo.png')]: new Uint8Array([0x89, 0x50]) },
      roots: [root],
    });
    expect(await read(h, 'a.MARKDOWN')).toMatchObject({ outcome: 'text', view: 'markdown' });
    expect(await read(h, 'b.JSON')).toMatchObject({ outcome: 'text', view: 'plain' });
    expect(await read(h, 'Makefile')).toMatchObject({ outcome: 'text', view: 'plain' });
    h.asked();
    expect(await read(h, 'c.xyz')).toEqual({ outcome: 'unshown', why: 'other-kind', path: abs('proj', 'c.xyz'), root, line: null, column: null });
    expect(h.asked().filter((call) => call.startsWith('read '))).toEqual([]);
    // An image's name is read as an image (decision 0022, item 15): one that is none opens the tab that says so.
    expect(await read(h, 'photo.png')).toMatchObject({ outcome: 'unshown', why: 'other-kind' });
    expect(h.asked().filter((call) => call.startsWith('read '))).toEqual([`read ${abs('proj', 'photo.png')}`]);
  });

  it('checks again at every read: a root whose trust was withdrawn refuses the next, and a file gone is not found', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'a.md')]: '# A\n' }, roots: [root] });
    expect(await read(h, abs('proj', 'a.md'))).toMatchObject({ outcome: 'text' });
    h.set(abs('proj', 'a.md'), '# Changed\n');
    expect(await read(h, abs('proj', 'a.md'))).toMatchObject({ outcome: 'text', text: '# Changed\n' });
    h.remove(abs('proj', 'a.md'));
    expect(await read(h, abs('proj', 'a.md'))).toEqual({ outcome: 'refused', why: 'not-found' });
    h.set(abs('proj', 'a.md'), '# Back\n');
    const [first] = h.roots;
    if (first !== undefined) first.answer = 'not-trusted';
    h.asked();
    expect(await read(h, abs('proj', 'a.md'))).toEqual(OUTSIDE);
    expect(h.asked()).toEqual([]);
  });

  it('answers the real path, the root’s real path, the view, the text and the target’s line and column', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'src', 'a.ts')]: 'const a = 1;\n' }, roots: [root] });
    expect(await read(h, 'src/a.ts:7:3')).toEqual({ outcome: 'text', path: abs('proj', 'src', 'a.ts'), root, view: 'plain', text: 'const a = 1;\n', revision: { mtimeMs: 0, size: 13 }, line: 7, column: 3 });
  });

  // C59: the stored root is not followed when it is stored, so for a root that is a link it is no prefix of the file's real path.
  it('names the root by its real path, under which the file’s real path lies, where the stored root is a link', async () => {
    const h = harness({ platform, tree: { [abs('door')]: { link: abs('real', 'proj') }, [abs('real', 'proj', 'docs', 'a.md')]: '# A\n' }, roots: [abs('door')] });
    expect(await read(h, 'docs/a.md')).toMatchObject({ outcome: 'text', path: abs('real', 'proj', 'docs', 'a.md'), root: abs('real', 'proj') });
  });

  it('resolves a reference inside a shown file against that file’s folder', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'README.md')]: '# Top\n', [abs('proj', 'docs', 'guide.md')]: '# Guide\n', [abs('proj', 'docs', 'more', 'x.md')]: '# X\n' }, roots: [root] });
    const from = abs('proj', 'docs', 'guide.md');
    expect(await read(h, '../README.md', from)).toMatchObject({ outcome: 'text', text: '# Top\n' });
    expect(await read(h, 'more/x.md#L2', from)).toMatchObject({ outcome: 'text', text: '# X\n', line: 2 });
    // Against the session's folder it is no file: the base is the file's own folder.
    expect(await read(h, 'more/x.md')).toEqual({ outcome: 'refused', why: 'not-found' });
    // And it is confined as any target is.
    expect(await read(h, '../../elsewhere/a.md', from)).toEqual(OUTSIDE);
  });

  it('tries a target as written and then percent-decoded, and one with a heading’s fragment without it', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'field notes', 'log.md')]: '# Log\n', [abs('proj', 'a%20b.md')]: '# Literal\n', [abs('proj', 'a b.md')]: '# Decoded\n' }, roots: [root] });
    expect(await read(h, 'field%20notes/log.md')).toMatchObject({ outcome: 'text', text: '# Log\n' });
    expect(await read(h, 'a%20b.md')).toMatchObject({ outcome: 'text', text: '# Literal\n' });
    expect(await read(h, 'field%20notes/log.md#the-log')).toMatchObject({ outcome: 'text', text: '# Log\n', line: null });
  });

  it('says “no answer” when the file system fails in a way that names no missing file', async () => {
    const h = harness({ platform, tree: { [abs('proj', 'a.md')]: '# A\n' }, roots: [root] });
    h.failing.set(abs('proj', 'a.md'), 'EACCES');
    expect(await read(h, 'a.md')).toEqual({ outcome: 'refused', why: 'no-answer' });
  });
});

describe('a drive that does not answer (V5; C34)', () => {
  const root = 'N:\\proj';
  const file = 'N:\\proj\\a.md';

  it('gives “no answer” past the read’s deadline, counted from when it was asked', async () => {
    vi.useFakeTimers();
    const h = harness({ platform: 'win32', tree: { [file]: '# A\n' }, roots: [root] });
    h.hung.add(file);
    const answer = read(h, 'a.md');
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1);
    let settled = false;
    void answer.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toEqual({ outcome: 'refused', why: 'no-answer' });
    expect(READ_DEADLINE_MS).toBe(10_000);
  });

  it('holds no slot of the lookups’: a root’s check still answers while both read slots are taken', async () => {
    vi.useFakeTimers();
    const stand = standIn('win32', { [file]: '# A\n', 'N:\\proj\\b.md': '# B\n', 'C:\\local': { folder: true } });
    const h = harness({ platform: 'win32', tree: { [file]: '# A\n', 'N:\\proj\\b.md': '# B\n' }, roots: [root] });
    h.hung.add(file).add('N:\\proj\\b.md');
    const hung = [read(h, 'a.md'), read(h, 'b.md')];
    await vi.advanceTimersByTimeAsync(0);
    expect(READ_SLOTS).toBe(2);
    // The lookups are another limiter: their two slots are free.
    const lookups = createLookups({ fs: stand.lookupFs });
    expect(await lookups.realpath('C:\\local')).toBe('C:\\local');
    expect(await lookups.folder('C:\\local')).toBe('present');
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(await Promise.all(hung)).toEqual([{ outcome: 'refused', why: 'no-answer' }, { outcome: 'refused', why: 'no-answer' }]);
  });

  it('gives “no answer” when the real paths do not answer: they go through the lookups’ own deadline', async () => {
    vi.useFakeTimers();
    const h = harness({ platform: 'win32', tree: { [file]: '# A\n' }, roots: [root] });
    const realpath = h.lookupFs.realpath.bind(h.lookupFs);
    // The stat answers, and the real path never does.
    h.lookupFs.realpath = (target) => (target === file ? new Promise<string>(() => undefined) : realpath(target));
    const answer = read(h, 'a.md');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await answer).toEqual({ outcome: 'refused', why: 'no-answer' });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });
});

describe('Show in folder’s path (V13; C43)', () => {
  const tree = { 'C:\\proj\\a.md': '# A\n', 'C:\\elsewhere\\b.md': '# B\n', 'C:\\proj\\out.md': { link: 'C:\\elsewhere\\b.md' }, 'C:\\proj\\.claude\\x.json': '{}' };
  const locate = (h: ReturnType<typeof harness>, path: string) => h.reader.locate({ sessionId: SESSION, path });

  it('passes the same confinements, and answers the real path', async () => {
    const h = harness({ platform: 'win32', tree, roots: ['C:\\proj'], refused: ['C:\\proj\\.claude'] });
    expect(await locate(h, 'c:/proj/A.md')).toEqual({ ok: true, path: 'C:\\proj\\a.md' });
    expect(h.calls.filter((call) => call.op !== 'realpath')).toEqual([]);
  });

  it.each([['a path elsewhere', 'C:\\elsewhere\\b.md'], ['a share', '\\\\host\\share\\a.md'], ['a refused folder', 'C:\\proj\\.claude\\x.json'], ['a relative path', 'a.md'], ['.. out of the root', 'C:\\proj\\..\\elsewhere\\b.md']])(
    'refuses %s with no call',
    async (_name, path) => {
      const h = harness({ platform: 'win32', tree, roots: ['C:\\proj'], refused: ['C:\\proj\\.claude'] });
      expect(await locate(h, path)).toEqual({ ok: false, why: 'outside' });
      expect(h.asked()).toEqual([]);
    },
  );

  it('refuses a link that leads out, on its real path, and a file that is gone', async () => {
    const h = harness({ platform: 'win32', tree, roots: ['C:\\proj'] });
    expect(await locate(h, 'C:\\proj\\out.md')).toEqual({ ok: false, why: 'outside' });
    expect(await locate(h, 'C:\\proj\\gone.md')).toEqual({ ok: false, why: 'no-answer' });
    expect(await h.reader.locate({ sessionId: '11111111-1111-4111-8111-111111111111', path: 'C:\\proj\\a.md' })).toBeNull();
  });
});

describe.each(PLATFORMS)('where a reference leads, on %s (decision 0022)', (platform) => {
  const abs = on(platform);
  const root = abs('proj');
  const tree = {
    [abs('proj', 'README.md')]: '# Tide tools\n',
    [abs('proj', 'src', 'tides.js')]: 'export const a = 1;\n',
    [abs('proj', 'docs', 'notes', 'harbour.md')]: '# Harbour\n',
    [abs('proj', 'pipe.txt')]: { device: true as const },
    [abs('elsewhere', 'secret.md')]: '# Secret\n',
    [abs('proj', 'junction')]: { link: abs('elsewhere') },
    [abs('proj', 'inside')]: { link: abs('proj', 'docs') },
  };
  const make = () => harness({ platform, tree, roots: [root] });
  const place = (h: ReturnType<typeof harness>, target: string, from?: string) => h.reader.place({ sessionId: SESSION, target, ...(from === undefined ? {} : { from }) });

  it('places a file and a folder by their real paths, resolved as a read resolves them, and reads neither', async () => {
    const h = make();
    expect(await place(h, 'src/tides.js:12')).toEqual({ ok: true, kind: 'file', path: abs('proj', 'src', 'tides.js') });
    expect(await place(h, 'docs')).toEqual({ ok: true, kind: 'folder', path: abs('proj', 'docs') });
    expect(await place(h, '.')).toEqual({ ok: true, kind: 'folder', path: root });
    expect(await place(h, 'notes', abs('proj', 'docs', 'README.md'))).toEqual({ ok: true, kind: 'folder', path: abs('proj', 'docs', 'notes') });
    // A bare name is looked up as a read's is.
    expect(await place(h, 'harbour.md')).toEqual({ ok: true, kind: 'file', path: abs('proj', 'docs', 'notes', 'harbour.md') });
    // A link to a folder inside the root: the folder it leads to.
    expect(await place(h, 'inside')).toEqual({ ok: true, kind: 'folder', path: abs('proj', 'docs') });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });

  it.each([
    ['.. out of the root', '..'],
    ['an absolute folder elsewhere', abs('elsewhere')],
    ['a share’s path', '//host/share'],
  ])('refuses %s as outside, and asks the file system nothing', async (_name, target) => {
    const h = make();
    expect(await place(h, target)).toEqual({ ok: false, why: 'outside' });
    expect(h.asked()).toEqual([]);
  });

  it('refuses a junction that leads out on its real path, and what is not there or not a file', async () => {
    const h = make();
    expect(await place(h, 'junction')).toEqual({ ok: false, why: 'outside' });
    expect(await place(h, 'gone')).toEqual({ ok: false, why: 'not-found' });
    expect(await place(h, 'pipe.txt')).toEqual({ ok: false, why: 'not-regular' });
    expect(await h.reader.place({ sessionId: '11111111-1111-4111-8111-111111111111', target: 'docs' })).toBeNull();
    expect(await place(h, 'docs', 'docs/README.md')).toBeNull();
  });

  it('leaves a read’s refusal of a folder as it was', async () => {
    expect(await read(make(), 'docs')).toEqual({ outcome: 'refused', why: 'folder' });
  });
});
