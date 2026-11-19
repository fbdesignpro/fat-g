// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V3, V10, V21, V24 (docs/planning/_archive/M19b.md; C15, C22, C49, C52, C56, C65): what reads an address,
// a target, a code span and the words that say a line beside a reference, on tables, with each
// system's rules run on every system; and the names shown as text. Pure: nothing here asks a file
// system anything.
import { describe, expect, it } from 'vitest';
import {
  FILE_BYTES_BOUND, hasSeparator, lastPart, LINE_WORDS_SPAN, MARKDOWN_EXTENSIONS, MAX_ADDRESS, MAX_ADDRESS_REQUEST, MAX_TARGET, readAddress, readCodeSpanPath,
  readLineAfter, readLineBefore, readTarget,
  TEXT_FILE_EXTENSIONS, TEXT_FILE_NAMES, TEXT_FILES, viewOf,
} from './files';
import { MAX_PATH } from './projects';

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
const POSIX = ['darwin', 'linux'] as const;

describe('an address (V2; C15)', () => {
  describe.each(PLATFORMS)('on %s', (platform) => {
    it.each([
      'http://example.com', 'https://example.com', 'https://example.com/a/b?c=d#e', 'HTTPS://EXAMPLE.COM/x', 'http://localhost:3000/', 'https://user@example.com/x',
      'http://127.0.0.1:8080/a', 'https://xn--exmple-cua.com/', 'http://www.example.org', '  https://example.com/padded  ',
    ])('reads %s as external', (address) => {
      expect(readAddress(address, platform)).toBe('external');
    });

    it.each(['file:///C:/a/b.md', 'file:///home/a/b.md', 'file://server/share/a.md', 'FILE:///x.md'])('reads the file: URL %s as local', (address) => {
      expect(readAddress(address, platform)).toBe('local');
    });

    it.each(['README.md', './x.md', '../docs/a.md', 'src/tides.js:12', 'docs/a.md#L3', 'field notes/harbour-log.md', 'a%20b.md', '~/notes.md'])('reads %s, a path with no scheme, as local', (address) => {
      expect(readAddress(address, platform)).toBe('local');
    });

    // By a URL's syntax `main.py` is a scheme here; it is a file's name with its line (C22).
    it.each(['main.py:10', 'README.md:7', 'Makefile:12', 'tides.js:12:4', 'a.md:999'])('reads %s, a bare name with a line, as local', (address) => {
      expect(readAddress(address, platform)).toBe('local');
    });

    it.each(['localhost:3000', 'example.com:8080', 'port:3000', 'tel:5551234', 'sms:123', 'javascript:1', 'data:1', 'TODO:12', 'v1.2:3'])('reads %s as none: a scheme, a host or a label, and no file’s name', (address) => {
      expect(readAddress(address, platform)).toBe('none');
    });

    it.each([
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,PHN2Zy8+', 'mailto:someone@example.com', 'app://fatg/index.html', 'smb://host/share/x', 'vbscript:msgbox(1)',
      'blob:https://example.com/1', 'ftp://example.com/x', 'unknown-scheme:thing', 'tel:5551234', 'http://', 'https:', '#heading', '#L12', '', '   ', '\n',
    ])('reads %j as none', (address) => {
      expect(readAddress(address, platform)).toBe('none');
    });
  });

  it.each(['C:\\Users\\a\\b.md', 'C:/Users/a/b.md', 'c:/x.md', 'D:\\x', '\\\\host\\share\\a.md', '//host/share/a.md', '/C:/a/b.md:12', '/etc/hosts'])('reads %s as local on Windows', (address) => {
    expect(readAddress(address, 'win32')).toBe('local');
  });

  it.each(POSIX)('reads a path rooted at / as local on %s, and a drive path as a one-letter scheme: none', (platform) => {
    for (const address of ['/etc/hosts', '/Users/a/b.md', '/home/a/b c.md', '//host/share/a.md']) expect(readAddress(address, platform)).toBe('local');
    for (const address of ['C:\\Users\\a\\b.md', 'C:/Users/a/b.md', 'd:/x.md']) expect(readAddress(address, platform)).toBe('none');
  });

  // The drive comes before the scheme: `C:/README.md` parses as a URL of scheme `c:` (K2).
  it('reads a drive path before it looks for a scheme', () => {
    expect(new URL('C:/README.md').protocol).toBe('c:');
    expect(readAddress('C:/README.md', 'win32')).toBe('local');
  });
});

describe('a target (V3; C22)', () => {
  const only = (address: string, platform: string) => readTarget(address, platform)?.tries[0];

  describe.each(PLATFORMS)('on %s', (platform) => {
    it.each([
      ['src/tides.js:12', 'src/tides.js', 12, null],
      ['src/tides.js:12:5', 'src/tides.js', 12, 5],
      ['docs/a.md#L3', 'docs/a.md', 3, null],
      ['docs/a.md#L3-L9', 'docs/a.md', 3, null],
      ['README.md', 'README.md', null, null],
      ['Makefile:7', 'Makefile', 7, null],
    ])('takes the line off %s before the path is resolved', (address, file, line, column) => {
      expect(only(address, platform)).toEqual({ path: file, line, column });
      expect(readTarget(address, platform)?.host).toBeNull();
    });

    it('tries another address as written and then percent-decoded, where the two differ', () => {
      expect(readTarget('field%20notes/harbour-log.md:4', platform)?.tries).toEqual([
        { path: 'field%20notes/harbour-log.md', line: 4, column: null },
        { path: 'field notes/harbour-log.md', line: 4, column: null },
      ]);
      expect(readTarget('field notes/harbour-log.md', platform)?.tries).toEqual([{ path: 'field notes/harbour-log.md', line: null, column: null }]);
      // A decoding that throws gives the first alone.
      expect(readTarget('100%/a.md', platform)?.tries).toEqual([{ path: '100%/a.md', line: null, column: null }]);
    });

    it('tries an address that ends in a heading’s fragment as written, and then without it, at no line', () => {
      expect(readTarget('docs/a.md#usage', platform)?.tries).toEqual([{ path: 'docs/a.md#usage', line: null, column: null }, { path: 'docs/a.md', line: null, column: null }]);
      expect(readTarget('C%23/notes.md', platform)?.tries.map((entry) => entry.path)).toEqual(['C%23/notes.md', 'C#/notes.md']);
    });

    it('leaves ~ and a variable as written', () => {
      expect(only('~/notes.md', platform)?.path).toBe('~/notes.md');
      expect(only('$HOME/notes.md', platform)?.path).toBe('$HOME/notes.md');
      expect(only('%USERPROFILE%/notes.md', platform)?.path).toBe('%USERPROFILE%/notes.md');
    });

    it('refuses a target that holds U+0000, one that decodes to one alone, an overlong one and an empty one', () => {
      expect(readTarget('a\0b.md', platform)).toBeNull();
      expect(readTarget(`${'a'.repeat(MAX_TARGET)}b`, platform)).toBeNull();
      expect(readTarget('a'.repeat(MAX_TARGET), platform)).not.toBeNull();
      expect(readTarget('', platform)).toBeNull();
      expect(readTarget(':12', platform)).toBeNull();
      // The decoded form holds a NUL: it is not tried, and the written one is.
      expect(readTarget('a%00b.md', platform)?.tries).toEqual([{ path: 'a%00b.md', line: null, column: null }]);
    });

    it('reads a line of zero as no line, the path still without it', () => {
      expect(only('a.md:0', platform)).toEqual({ path: 'a.md', line: null, column: null });
    });
  });

  it('never reads a Windows drive’s colon as a line', () => {
    expect(only('C:\\a\\b.md', 'win32')).toEqual({ path: 'C:\\a\\b.md', line: null, column: null });
    expect(only('C:\\a\\b.md:12', 'win32')).toEqual({ path: 'C:\\a\\b.md', line: 12, column: null });
    expect(only('C:/a/b.md:12:3', 'win32')).toEqual({ path: 'C:/a/b.md', line: 12, column: 3 });
    expect(only('C:12', 'win32')).toEqual({ path: 'C:12', line: null, column: null });
  });

  it('reads /C:/a/b.md:12 as the drive’s path and its line on Windows, and as a path as written elsewhere', () => {
    expect(only('/C:/a/b.md:12', 'win32')).toEqual({ path: 'C:/a/b.md', line: 12, column: null });
    for (const platform of POSIX) expect(only('/C:/a/b.md:12', platform)).toEqual({ path: '/C:/a/b.md', line: 12, column: null });
  });

  it('decodes a file: URL, its line from its fragment or from its path’s end', () => {
    expect(readTarget('file:///C:/a/b.md#L12', 'win32')).toEqual({ tries: [{ path: 'C:/a/b.md', line: 12, column: null }], host: '' });
    expect(readTarget('file:///C:/a/b.md:12', 'win32')).toEqual({ tries: [{ path: 'C:/a/b.md', line: 12, column: null }], host: '' });
    expect(readTarget('file:///C:/field%20notes/b.md', 'win32')).toEqual({ tries: [{ path: 'C:/field notes/b.md', line: null, column: null }], host: '' });
    expect(readTarget('file:///home/a/b.md#L3-L5', 'linux')).toEqual({ tries: [{ path: '/home/a/b.md', line: 3, column: null }], host: '' });
    expect(readTarget('file:///home/a/b.md:7:2', 'darwin')).toEqual({ tries: [{ path: '/home/a/b.md', line: 7, column: 2 }], host: '' });
  });

  it('answers a file: URL’s host, which main refuses unless it is empty or localhost', () => {
    expect(readTarget('file://server/share/a.md', 'win32')?.host).toBe('server');
    // The URL parser spells a file: URL's `localhost` as no host at all.
    expect(readTarget('file://localhost/home/a.md', 'linux')?.host).toBe('');
    expect(readTarget('file:///home/a.md', 'linux')?.host).toBe('');
  });

  it('bounds a target at the stored paths’ own bound', () => {
    expect(MAX_TARGET).toBe(MAX_PATH);
  });
});

describe('a code span (V10; C49)', () => {
  it.each([
    'src/server.ts:42', './x', 'C:\\p\\a.md', '/etc/hosts', 'conf.d/x.conf', 'Makefile:12', 'C:\\Users\\A B\\a.md', 'README.md', 'package.json', 'main.py:10', 'console.log',
    // And what K2's answers held, with more of their kind.
    'src/tides.js:12', 'harbour-log.md', '.gitignore', 'src/Makefile', '../docs/a.md', '~/notes/a b.md', 'docs/a.md#L3', 'index.d.ts', 'src\\main\\index.ts', 'a/b:12', 'README.MD', '/C:/a/b.md:12',
  ])('reads %s as a path', (text) => {
    expect(readCodeSpanPath(text)).not.toBeNull();
  });

  it.each([
    'process.env', 'module.exports', 'glm-5.3', 'example.com', 'example.com/x', '/chat/settings', 'localhost:3000', 'port:3000', 'TODO:12', 'a b.md', 'README',
    // And what K2's answers held that is no path, with more of their kind.
    'nextHighTide', 'field notes', '', ' ', 'error:1', '.md', '.env', 'https://example.com/a.html', 'file:///C:/a.md', 'src/**/*.ts', 'a/b', 'src/', '127.0.0.1/x.md',
    'example.com:8080/x.html', 'git@github.com:owner/repo.git', 'en.wikipedia.org/wiki/X.html', 'v1.2', 'lib/v2.1', 'a`b.md', 'a\tb/c.md', ' ./x.md', 'Array<string>', 'x | y', 'C:12',
  ])('reads %j as code', (text) => {
    expect(readCodeSpanPath(text)).toBeNull();
  });

  it('answers the path and the line it names', () => {
    expect(readCodeSpanPath('src/tides.js:12')).toEqual({ path: 'src/tides.js', line: 12, column: null });
    expect(readCodeSpanPath('src/tides.js:12:4')).toEqual({ path: 'src/tides.js', line: 12, column: 4 });
    expect(readCodeSpanPath('README.md')).toEqual({ path: 'README.md', line: null, column: null });
  });

  it('reads a first segment whose last label is a country’s as a path where that label is on the lists', () => {
    for (const text of ['notes.md/x.md', 'main.py:3', 'lib.rs:9', 'run.sh:1']) expect(readCodeSpanPath(text), text).not.toBeNull();
    for (const text of ['foo.me/x.md', 'a.io/b.md', 'my.app/x.md']) expect(readCodeSpanPath(text), text).toBeNull();
  });

  it('reads the same span the same on every system: it takes no platform', () => {
    expect(readCodeSpanPath.length).toBe(1);
  });
});

describe('the names shown as text (V21; C31, C52, C56)', () => {
  it('are one constant, with C52’s two lists as the sheet has them', () => {
    expect(TEXT_FILE_EXTENSIONS).toBe(TEXT_FILES.extensions);
    expect(TEXT_FILE_NAMES).toBe(TEXT_FILES.names);
    expect(Object.isFrozen(TEXT_FILES) && Object.isFrozen(TEXT_FILES.extensions) && Object.isFrozen(TEXT_FILES.names)).toBe(true);
    expect(TEXT_FILE_EXTENSIONS).toHaveLength(75);
    expect(TEXT_FILE_EXTENSIONS.slice(0, 3)).toEqual(['.txt', '.text', '.log']);
    expect(TEXT_FILE_EXTENSIONS.at(-1)).toBe('.nvmrc');
    expect(TEXT_FILE_NAMES).toEqual(['Makefile', 'Dockerfile', 'Containerfile', 'Justfile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'LICENCE', 'NOTICE', 'CHANGELOG', 'README', 'CODEOWNERS', 'AUTHORS']);
    expect(new Set(TEXT_FILE_EXTENSIONS).size).toBe(TEXT_FILE_EXTENSIONS.length);
    for (const extension of TEXT_FILE_EXTENSIONS) expect(extension).toMatch(/^\.[a-z0-9]+$/);
    expect(MARKDOWN_EXTENSIONS).toEqual(['.md', '.markdown']);
  });

  it('leave .env off, on purpose', () => {
    expect(TEXT_FILE_EXTENSIONS).not.toContain('.env');
    expect(viewOf('.env')).toBe('other');
    expect(viewOf('.env.local')).toBe('other');
  });

  it.each(['notes.md', 'NOTES.MD', 'a.markdown', 'A.MARKDOWN', 'README.md'])('name Markdown for %s', (name) => {
    expect(viewOf(name)).toBe('markdown');
  });

  it.each(['main.py', 'data.JSON', 'Makefile', 'MAKEFILE', 'readme', 'LICENSE', '.gitignore', 'a.tsx', 'x.C', 'app.log', 'notes.txt'])('name plain text for %s', (name) => {
    expect(viewOf(name)).toBe('plain');
  });

  it.each(['photo.png', 'a.xyz', 'archive.zip', 'program.exe', 'noextension', 'md', 'Makefile.bak', 'py', ''])('name the fallback for %j', (name) => {
    expect(viewOf(name)).toBe('other');
  });
});

describe('the bounds, and the helpers', () => {
  it('are the sheet’s: 2 MiB a file, 2,000 characters an address, and a request wide enough to count one over it', () => {
    expect(FILE_BYTES_BOUND).toBe(2 * 1024 * 1024);
    expect(MAX_ADDRESS).toBe(2000);
    expect(MAX_ADDRESS_REQUEST).toBeGreaterThan(MAX_ADDRESS);
  });

  it('take a path’s last part by either separator', () => {
    expect(lastPart('C:\\a\\b.md')).toBe('b.md');
    expect(lastPart('/a/b.md')).toBe('b.md');
    expect(lastPart('a\\b/c.md')).toBe('c.md');
    expect(lastPart('c.md')).toBe('c.md');
    expect([hasSeparator('a/b'), hasSeparator('a\\b'), hasSeparator('ab')]).toEqual([true, true, false]);
  });
});

describe('a line said in words (V24; C65)', () => {
  it.each([
    [' at line 12.', 12],
    [' at line 12', 12],
    [' on line 7, where it starts', 7],
    [', line 3', 3],
    [' (line 12)', 12],
    [' (lines 12–20)', 12],
    [' lines 12-20', 12],
    [': line 5', 5],
    [' — starting at line 40', 40],
    [' - line 8', 8],
    ['\nLine: 12', 12],
    [' Line 9', 9],
    [' around line 100', 100],
    [' from line 2 to line 30', 2],
    [' at line 999999999', 999_999_999],
  ])('reads %j right after a reference as line %i', (words, line) => {
    expect(readLineAfter(words)).toBe(line);
  });

  it.each([
    '', ' is where it is defined', ' and line 30 of ', ' at line 0', ' at line 1,024', ' at line 1234567890', ' has 12 lines', ' outline 12', ' inline 3',
    ' at line twelve', ' at the line 12', ' was changed. At line 12 it', ' at line', ' line: ', ':12', ' 12',
  ])('reads no line in %j after one', (words) => {
    expect(readLineAfter(words)).toBeNull();
  });

  it.each([
    ['It is on line 12 of ', 12],
    ['See lines 12–20 in ', 12],
    ['lines 4 to 8 of ', 4],
    ['lines 4 through 8 of ', 4],
    ['line 3 of the file ', 3],
    ['Line 9 in file ', 9],
    ['at line 12 within ', 12],
    ['defined at line 7 of\n', 7],
  ])('reads %j right before a reference as line %i', (words, line) => {
    expect(readLineBefore(words)).toBe(line);
  });

  it.each(['', 'the deadline 12 of ', 'line 12 is in ', 'line 12 of the old ', 'line 0 of ', 'line 1,024 of ', 'line 12 of', 'on line 12, in ', '12 of ', 'lines of '])('reads no line in %j before one', (words) => {
    expect(readLineBefore(words)).toBeNull();
  });

  it('reads the words that touch the reference and no sentence further', () => {
    expect(LINE_WORDS_SPAN).toBe(64);
    // After: anchored where the reference ends, so nothing further on is a line of its.
    expect(readLineAfter(' holds the helpers. Elsewhere, at line 12, something else')).toBeNull();
    // Before: only the end of what comes before, and a word the cut divided is no `line`.
    const padded = `line 12 of${' '.repeat(LINE_WORDS_SPAN - 'line 12 of'.length)}`;
    expect(padded).toHaveLength(LINE_WORDS_SPAN);
    expect(readLineBefore(padded)).toBe(12);
    expect(readLineBefore(`dead${padded}`)).toBeNull();
    expect(readLineBefore(`${'x'.repeat(200)} on line 12 of `)).toBe(12);
  });
});
