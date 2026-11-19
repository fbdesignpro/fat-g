// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The package audit's rules (scripts/lib/package-audit.mjs, packages.mjs), without building a package.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assetNoticesMissing, assetProblems, auditArchive, containsNeedle, flavorProblems, FONT_DIRECTORY, FONT_FILES, forbiddenPaths, fuseMismatches, noticesMissing, packageKey,
  privacyNeedles,
} from '../../scripts/lib/package-audit.mjs';
import { installed, nameAt, PACKAGED_ASSETS, renderNotices, shippedPackages, type Lockfile } from '../../scripts/lib/packages.mjs';

describe('what ships, from the lockfile', () => {
  const lock: Lockfile = {
    packages: {
      '': { version: '0.1.0' },
      'node_modules/zod': { version: '4.6.5', license: 'MIT' },
      'node_modules/cross-spawn': { version: '7.0.6', license: 'MIT' },
      'node_modules/cross-spawn/node_modules/which': { version: '2.0.2', license: 'ISC' },
      'node_modules/react': { version: '19.3.0', license: 'MIT', dev: true },
      'node_modules/fsevents': { version: '2.3.3', optional: true },
      'node_modules/both': { version: '1.0.0', devOptional: true },
      'node_modules/@anthropic-ai/sdk': { version: '0.128.0', peer: true },
    },
  };

  it('keeps runtime packages, including nested ones, and drops dev, optional and peer-only ones', () => {
    expect(shippedPackages(lock).map(({ key }) => key)).toEqual(['node_modules/cross-spawn', 'node_modules/cross-spawn/node_modules/which', 'node_modules/zod']);
    expect(nameAt('node_modules/a/node_modules/@b/c')).toBe('@b/c');
    expect(installed(lock, 'react')).toMatchObject({ name: 'react', version: '19.3.0' });
    expect(installed(lock, 'absent')).toBeUndefined();
  });

  it('counts the real lockfile: cross-spawn’s closure, zod and the local search engine ship', () => {
    const real = JSON.parse(readFileSync(path.resolve('package-lock.json'), 'utf8')) as Lockfile;
    expect(shippedPackages(real).map(({ name }) => name).sort()).toEqual(['cross-spawn', 'isexe', 'minisearch', 'path-key', 'shebang-command', 'shebang-regex', 'which', 'zod']);
  });
});

describe('app.asar allowlist', () => {
  const expected = ['node_modules/zod', 'node_modules/cross-spawn', 'node_modules/cross-spawn/node_modules/which'];
  const good = ['package.json', 'out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html', 'out/renderer/assets/a.js',
    'node_modules/zod/index.js', 'node_modules/cross-spawn/index.js', 'node_modules/cross-spawn/node_modules/which/which.js'];

  it('accepts exactly the app files and the expected packages', () => {
    expect(auditArchive(good, expected)).toEqual({ unexpected: [], missing: [] });
  });

  it('allows the application icon in main alone, without widening the asset allowlist', () => {
    expect(auditArchive([...good, 'out/main/assets/icon.png', 'out/main/assets/icon-attention.png', 'out/main/assets/icon.ico', 'out/main/assets/icon-attention.ico'], expected)).toEqual({ unexpected: [], missing: [] });
    expect(auditArchive([...good, 'out/main/assets/other.png', 'build/icon.ico'], expected).unexpected)
      .toEqual(['out/main/assets/other.png', 'build/icon.ico']);
  });

  it('names anything else, a nested package that is not expected, and an expected package that is missing', () => {
    const result = auditArchive([...good.filter((file) => !file.startsWith('node_modules/zod/')), 'spikes/output/claude.json', 'out/preload/extra.cjs',
      'node_modules/react/index.js', 'node_modules/zod-evil/index.js', 'node_modules/cross-spawn/node_modules/evil/index.js', 'src/main/index.ts'], expected);
    expect(result.unexpected.sort()).toEqual(['node_modules/cross-spawn/node_modules/evil/index.js', 'node_modules/react/index.js', 'node_modules/zod-evil/index.js', 'out/preload/extra.cjs', 'spikes/output/claude.json', 'src/main/index.ts']);
    expect(result.missing).toEqual(['node_modules/zod']);
    expect(packageKey('node_modules/@scope/pkg/lib/x.js')).toBe('node_modules/@scope/pkg');
  });
});

describe('forbidden content', () => {
  it.each([
    'resources/app-update.yml', 'latest.yml', 'fat-g-setup.exe.blockmap', 'resources/elevate.exe', 'out/main/index.js.map',
    '.env', 'out/.env.local', 'debug.log', 'preferences.json', 'preferences.corrupt-1.json',
    // M12 (C84, V28): a user's projects hold their folders' paths.
    'records.json', 'out/renderer/records.json', 'records.set-aside.2020-01-21T14-03-12Z.json', 'preferences.set-aside.2020-01-21T14-03-12Z.json',
    // M13 (C53, V16): a user's override, and a provider's defaults, which ship inside main's bundle only.
    'catalog.json', 'out/renderer/catalog.json', 'resources/app/catalog.json', 'out/main/catalog-defaults.json', 'node_modules/zod/catalog.json',
    // M18 (C43): a conversation store holds what someone said, in its main file, its log and a copy set aside.
    'conversations.sqlite', 'out/renderer/conversations.sqlite', 'resources/conversations.sqlite-wal', 'conversations.sqlite-shm',
    'conversations.set-aside.2020-01-25T14-03-12Z.sqlite', 'conversations.set-aside.2020-01-25T14-03-12Z-2.sqlite-wal', 'node_modules/zod/conversations.sqlite',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    'node_modules/@modelcontextprotocol/sdk/index.js', 'spikes/output/x.json', 'tests/fixtures/a.json', 'docs/planning/x.md', '.claude/settings.local.json',
  ])('rejects %s', (file) => { expect(forbiddenPaths([file])).toEqual([file]); });

  it.each(['out/main/index.js', 'node_modules/zod/src/index.ts', 'node_modules/zod/v4/index.d.cts.map', 'locales/en-US.pak', 'LICENSES.chromium.html'])('allows %s', (file) => {
    expect(forbiddenPaths([file])).toEqual([]);
  });
});

describe('privacy text', () => {
  it('looks for fixture text and every spelling of the builder’s home and checkout paths', () => {
    const needles = privacyNeedles({ home: 'C:\\Users\\builder', repo: 'D:\\work\\fat-g', fixtureStrings: ['FATG-PRIVATE-SENTINEL-7Q2', 'x'] });
    expect(needles).toEqual(expect.arrayContaining(['C:\\Users\\builder', 'C:/Users/builder', 'C:\\\\Users\\\\builder', 'D:/work/fat-g', 'FATG-PRIVATE-SENTINEL-7Q2']));
    expect(needles).not.toContain('x'); // too short to mean anything
    expect(containsNeedle('const p = "c:\\\\users\\\\BUILDER\\\\x"', needles, true)).toBe(true);
    expect(containsNeedle('const p = "c:/users/builder"', needles, false)).toBe(false);
    expect(containsNeedle('nothing here', needles, true)).toBe(false);
  });
});

describe('fuses', () => {
  const options = { RunAsNode: 0, EnableCookieEncryption: 1, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3, EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5, LoadBrowserProcessSpecificV8Snapshot: 6, GrantFileProtocolExtraPrivileges: 7 };
  const decided = { 0: 48, 1: 48, 2: 48, 3: 48, 4: 49, 5: 49, 6: 48, 7: 48, 8: 49 };

  it('accepts decision 0007’s table and names each difference', () => {
    expect(fuseMismatches(decided, options)).toEqual([]);
    expect(fuseMismatches({ ...decided, 0: 49, 4: 48 }, options)).toEqual(['RunAsNode should be off', 'EnableEmbeddedAsarIntegrityValidation should be on']);
    expect(fuseMismatches({ ...decided, 7: 114 }, options)).toEqual(['GrantFileProtocolExtraPrivileges should be off']);
  });
});

describe('flavor and notices', () => {
  const smokeOnly = [{ path: 'out/main/index.js', text: 'if (process.env.FATG_SMOKE)' }, { path: 'out/main/smoke-abc.js', text: '' }];
  const demoOnly = [{ path: 'out/main/index.js', text: 'process.env["FATG_DEMO_SESSIONS"]' }, { path: 'out/main/demo-source-abc.js', text: '' }];

  it('requires smoke code in the smoke flavor and none in a release', () => {
    const smoke = [...smokeOnly, ...demoOnly];
    expect(flavorProblems('smoke', smoke)).toEqual([]);
    expect(flavorProblems('release', smokeOnly)).toEqual(['a smoke chunk is in the release bundle', 'FATG_SMOKE is in the release bundle']);
    expect(flavorProblems('release', [{ path: 'out/main/index.js', text: 'clean' }])).toEqual([]);
    expect(flavorProblems('smoke', demoOnly)).toEqual(['the smoke flavor has no smoke code: the build flag is not working']);
  });

  // M14 (C27, C67, V16): the demo source is refused in a release like the smoke stand-ins.
  it('refuses a demo chunk and the demo switch’s name in a release, and requires both in the smoke flavor', () => {
    expect(flavorProblems('release', demoOnly)).toEqual(['a demo chunk is in the release bundle', 'FATG_DEMO is in the release bundle']);
    expect(flavorProblems('release', [{ path: 'out/main/demo-source-abc.js', text: 'clean' }])).toEqual(['a demo chunk is in the release bundle']);
    expect(flavorProblems('release', [{ path: 'out/main/index.js', text: 'x = process.env.FATG_DEMO_SESSIONS' }])).toEqual(['FATG_DEMO is in the release bundle']);
    expect(flavorProblems('smoke', smokeOnly)).toEqual(['the smoke flavor has no demo source: the build flag is not working']);
    expect(flavorProblems('smoke', [...smokeOnly, { path: 'out/main/demo-source-abc.js', text: '' }])).toEqual(['the smoke flavor has no demo source: the build flag is not working']);
    // A file that only happens to hold the word, elsewhere, is not a chunk of main's.
    expect(flavorProblems('release', [{ path: 'out/renderer/assets/demo.js', text: 'clean' }])).toEqual([]);
    // M19 (C63, C69; V29): the stream form is a chunk of the same family, refused by the same rule.
    expect(flavorProblems('release', [{ path: 'out/main/demo-stream-abc.js', text: 'clean' }])).toEqual(['a demo chunk is in the release bundle']);
    expect(flavorProblems('smoke', [...smokeOnly, ...demoOnly, { path: 'out/main/demo-stream-abc.js', text: '' }])).toEqual([]);
  });

  it('checks every package has its notice line', () => {
    const notices = renderNotices([{ name: 'zod', version: '4.6.5', license: 'MIT', text: 'MIT License', how: 'shipped' }, { name: 'bare', version: '1.0.0', license: null, text: null, how: 'bundled' }]);
    expect(notices).toContain('zod 4.6.5 — MIT — shipped\n');
    expect(notices).toContain('The package contains no license file');
    expect(noticesMissing(notices, [{ name: 'zod', version: '4.6.5' }, { name: 'react', version: '19.3.0' }, { name: 'zod', version: '3.0.0' }])).toEqual(['react@19.3.0', 'zod@3.0.0']);
  });

  it('puts the assets after the packages, each line with its licence, and requires both lines (M11)', () => {
    const lines = PACKAGED_ASSETS.map((asset) => asset.line);
    expect(lines).toEqual(['Inter 4.1 — OFL-1.1 — packaged font', 'Provider marks — original work of the fat-g contributors — MIT', 'Audio effects — original and imported sounds — see asset notices']);
    const notices = renderNotices([{ name: 'zod', version: '4.6.5', license: 'MIT', text: 'MIT License', how: 'shipped' }], lines.map((line) => ({ line, text: `licence of ${line}` })));
    expect(notices.indexOf('zod 4.6.5')).toBeLessThan(notices.indexOf(lines[0] ?? '?'));
    for (const line of lines) expect(notices).toContain(`${line}\n${'-'.repeat(78)}\nlicence of ${line}`);
    expect(assetNoticesMissing(notices, lines)).toEqual([]);
    expect(assetNoticesMissing(renderNotices([]), lines)).toEqual(lines);
    // A line must stand on its own: a mention inside another line does not count.
    expect(assetNoticesMissing(`see ${lines[0] ?? ''} below\n`, lines)).toEqual(lines);
  });

  it('reads the font’s licence from the build output, and carries the marks’ text inline', () => {
    expect(PACKAGED_ASSETS[0]?.licenseFile).toBe(`${FONT_DIRECTORY}/LICENSE.txt`);
    expect(PACKAGED_ASSETS[1]?.text).toMatch(/not the vendors' logos/);
  });
});

describe('fonts and images (decision 0012, M11)', () => {
  const shipped = Object.entries(FONT_FILES).map(([name, sha256]) => ({ path: `${FONT_DIRECTORY}/${name}`, sha256 }));
  const code = [{ path: 'out/renderer/index.html' }, { path: 'out/renderer/theme-boot.js' }, { path: 'out/main/index.js' }];

  it('ships exactly the four weights and the licence, as the vendor named them', () => {
    expect(Object.keys(FONT_FILES).sort()).toEqual(['Inter-Bold.woff2', 'Inter-Medium.woff2', 'Inter-Regular.woff2', 'Inter-SemiBold.woff2', 'LICENSE.txt']);
    expect(FONT_DIRECTORY).toBe('out/renderer/fonts/inter');
  });

  it('matches the committed files byte for byte, and they are all there is', () => {
    const source = path.resolve('src/renderer/public/fonts/inter');
    expect(readdirSync(source).sort()).toEqual(Object.keys(FONT_FILES).sort());
    for (const [name, sha256] of Object.entries(FONT_FILES)) expect(createHash('sha256').update(readFileSync(path.join(source, name))).digest('hex')).toBe(sha256);
  });

  it('passes the real set', () => {
    expect(assetProblems([...shipped, ...code])).toEqual([]);
  });

  it('names an altered, a missing and an added font file', () => {
    const [regular, medium, ...rest] = shipped;
    expect(assetProblems([{ path: regular?.path ?? '', sha256: '0'.repeat(64) }, ...rest, ...code, { path: 'out/renderer/fonts/inter/Inter-Italic.woff2' }, { path: 'out/renderer/assets/other.ttf' }])).toEqual([
      `packaged font file differs from the vendor's: ${regular?.path ?? ''}`,
      `packaged font file missing: ${medium?.path ?? ''}`,
      'unexpected font file: out/renderer/fonts/inter/Inter-Italic.woff2',
      'unexpected font file: out/renderer/assets/other.ttf',
    ]);
  });

  it.each(['out/renderer/assets/logo.png', 'out/renderer/icon.svg', 'out/renderer/marks/claude.webp', 'out/renderer/favicon.ico'])('refuses an image in the renderer: %s', (file) => {
    expect(assetProblems([...shipped, { path: file }])).toEqual([`image file in the renderer: ${file}`]);
  });

  it('leaves packages’ own files to the allowlist', () => {
    expect(assetProblems([...shipped, { path: 'node_modules/zod/logo.svg' }, { path: 'node_modules/some/font.woff2' }])).toEqual([]);
  });
});
