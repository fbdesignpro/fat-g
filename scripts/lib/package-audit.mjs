// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The rules of the package audit (scripts/verify-package.mjs, decision 0007). Pure: the script
// gathers paths, sizes and texts; these functions decide. Unit-tested in tests/packaging.

/** Files fat-g's own code may put in app.asar, besides the shipped node_modules closure. */
const APP_FILES = [/^package\.json$/, /^out\/main\/[^/]+\.js$/, /^out\/main\/assets\/icon(-attention)?\.(png|ico)$/, /^out\/preload\/index\.cjs$/, /^out\/renderer\/.+/];

/**
 * Anywhere, even inside a package: secrets, logs, preferences and records (M12, C84), a catalog
 * override or a provider's defaults file that escaped main's bundle (M13, C53), update and updater
 * leftovers. And a conversation store, with what SQLite keeps beside it and a copy set aside (M18,
 * C43): it holds what someone said to a provider.
 */
const FORBIDDEN_ANYWHERE = [
  /(^|\/)\.env(\.|$)/i, /\.log$/i, /(^|\/)preferences[^/]*\.json$/i, /(^|\/)records[^/]*\.json$/i, /(^|\/)catalog[^/]*\.json$/i,
  /(^|\/)conversations[^/]*\.sqlite(-wal|-shm)?$/i,
  /(^|\/)(app-update|dev-app-update|latest[^/]*)\.yml$/i, /\.blockmap$/i, /(^|\/)elevate\.exe$/i,
];
/** Outside node_modules (fat-g's files and the unpacked app): repo folders and source maps. */
const FORBIDDEN_SEGMENTS = new Set(['spikes', 'tests', 'test', 'fixtures', 'docs', 'src', '.claude', '.git', '.github', '.vscode', 'coverage']);
/** No Anthropic or MCP package, and no Agent SDK binary, may ever ship again (decision 0006). */
const FORBIDDEN_PACKAGES = [/(^|\/)node_modules\/@anthropic-ai\//, /(^|\/)node_modules\/@modelcontextprotocol\//, /claude-agent-sdk/i];

export const LIMITS = { archiveBytes: 20 * 1024 * 1024, fileBytes: 20 * 1024 * 1024 };

/** `node_modules/a/node_modules/@b/c/lib/x.js` → `node_modules/a/node_modules/@b/c`. */
export function packageKey(file) {
  const at = file.lastIndexOf('node_modules/');
  if (at === -1) return undefined;
  const rest = file.slice(at + 'node_modules/'.length).split('/');
  const name = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  return name.every(Boolean) ? file.slice(0, at) + ['node_modules', ...name].join('/') : undefined;
}

/**
 * app.asar against the allowlist. `files` are the archive's files (not directories), relative with
 * forward slashes; `expected` the lockfile keys of the shipped packages.
 */
export function auditArchive(files, expected) {
  const wanted = new Set(expected);
  const seen = new Set();
  const unexpected = [];
  for (const file of files) {
    if (file.startsWith('node_modules/')) {
      const key = packageKey(file);
      if (key !== undefined && wanted.has(key)) seen.add(key); else unexpected.push(file);
    } else if (!APP_FILES.some((pattern) => pattern.test(file))) {
      unexpected.push(file);
    }
  }
  return { unexpected, missing: [...wanted].filter((key) => !seen.has(key)).sort() };
}

/** Paths that must not ship. `inPackage` paths are judged by the anywhere/package rules only. */
export function forbiddenPaths(paths) {
  return paths.filter((file) => {
    if (FORBIDDEN_ANYWHERE.some((pattern) => pattern.test(file)) || FORBIDDEN_PACKAGES.some((pattern) => pattern.test(file))) return true;
    if (file.includes('node_modules/')) return false;
    return file.split('/').some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) || /\.map$/i.test(file);
  });
}

/**
 * Text that must never ship: the smoke fixtures' private strings, and the build machine's home and
 * checkout paths — a leaked absolute path would publish the builder's user name. Each path in every
 * spelling a bundle could contain it: native, forward slashes, and JSON/JS-escaped backslashes.
 */
export function privacyNeedles({ home, repo, fixtureStrings }) {
  const spellings = (value) => [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')];
  return [...new Set([...fixtureStrings, ...[home, repo].filter(Boolean).flatMap(spellings)])].filter((needle) => needle.length >= 6);
}

export function containsNeedle(text, needles, caseInsensitive) {
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  return needles.some((needle) => haystack.includes(caseInsensitive ? needle.toLowerCase() : needle));
}

/** Decision 0007's fuse table. `wire` is @electron/fuses' getCurrentFuseWire; `options` its FuseV1Options. */
export const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
};
const FUSE_ON = 49; // '1'
const FUSE_OFF = 48; // '0'

export function fuseMismatches(wire, options) {
  return Object.entries(EXPECTED_FUSES)
    .filter(([name, on]) => wire[options[name]] !== (on ? FUSE_ON : FUSE_OFF))
    .map(([name, on]) => `${name} should be ${on ? 'on' : 'off'}`);
}

/**
 * The release main bundle must contain no smoke code and no demo source (M14, C27, C67); the smoke
 * flavor must hold both (or the flag is broken).
 */
export function flavorProblems(flavor, mainFiles) {
  const smokeChunk = mainFiles.some(({ path }) => /^out\/main\/smoke/.test(path));
  const smokeText = mainFiles.some(({ text }) => text.includes('FATG_SMOKE'));
  const demoChunk = mainFiles.some(({ path }) => /^out\/main\/demo/.test(path));
  const demoText = mainFiles.some(({ text }) => text.includes('FATG_DEMO'));
  if (flavor === 'release') {
    return [
      ...(smokeChunk ? ['a smoke chunk is in the release bundle'] : []),
      ...(smokeText ? ['FATG_SMOKE is in the release bundle'] : []),
      ...(demoChunk ? ['a demo chunk is in the release bundle'] : []),
      ...(demoText ? ['FATG_DEMO is in the release bundle'] : []),
    ];
  }
  return [
    ...(smokeChunk && smokeText ? [] : ['the smoke flavor has no smoke code: the build flag is not working']),
    ...(demoChunk && demoText ? [] : ['the smoke flavor has no demo source: the build flag is not working']),
  ];
}

/** Packages (`{ name, version }`) whose line is absent from THIRD_PARTY_NOTICES.txt. */
export function noticesMissing(notices, packages) {
  return packages.filter(({ name, version }) => !notices.split('\n').some((line) => line.startsWith(`${name} ${version} — `))).map(({ name, version }) => `${name}@${version}`);
}

/** Asset lines (packages.mjs, PACKAGED_ASSETS) absent from THIRD_PARTY_NOTICES.txt. */
export function assetNoticesMissing(notices, lines) {
  const present = new Set(notices.split('\n'));
  return lines.filter((line) => !present.has(line));
}

/**
 * The packaged font (decision 0012): the vendor's files, under the vendor's names, byte-identical.
 * The one table of their SHA-256 values; docs/planning/_archive/M11.md records the same.
 */
export const FONT_DIRECTORY = 'out/renderer/fonts/inter';
export const FONT_FILES = {
  'Inter-Regular.woff2': '338239f6b590b8ced3bf857654d32da3fd3663294cd3003651ed57aa3abd7aa1',
  'Inter-Medium.woff2': '7e80d9f65861ee6836a0081d4e75d88fb8789e5651d05edbc49640442a9610ee',
  'Inter-SemiBold.woff2': '5013f48d77ab627b1db7c2415914284ef09abc3f60a8e0d0d8f3cd1bfebefb5e',
  'Inter-Bold.woff2': '98c66e49c299c5675426bf5562b1876c2b6b9bd8dc90a8922a49703ed4848813',
  'LICENSE.txt': '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a',
};
const FONT_FILE = /\.(woff2?|ttf|otf|eot)$/i;
/** Renderer images remain forbidden; the application icon ships in main's assets alone. */
const IMAGE_FILE = /\.(png|apng|jpe?g|gif|webp|avif|bmp|ico|cur|svg|tiff?)$/i;

/**
 * Fonts and images in app.asar. `files` are the archive's files as `{ path, sha256 }` (hashes are
 * needed only for the font's own files). Every expected font file present and unchanged; no other
 * font file outside node_modules; no image file in the renderer.
 */
export function assetProblems(files) {
  const hashes = new Map(files.map((file) => [file.path, file.sha256]));
  const expected = new Map(Object.entries(FONT_FILES).map(([name, hash]) => [`${FONT_DIRECTORY}/${name}`, hash]));
  const problems = [];
  for (const [file, hash] of expected) {
    if (!hashes.has(file)) problems.push(`packaged font file missing: ${file}`);
    else if (hashes.get(file) !== hash) problems.push(`packaged font file differs from the vendor's: ${file}`);
  }
  for (const { path } of files) {
    if (path.startsWith('node_modules/') || path.includes('/node_modules/')) continue;
    if (FONT_FILE.test(path) && !expected.has(path)) problems.push(`unexpected font file: ${path}`);
    if (path.startsWith('out/renderer/') && IMAGE_FILE.test(path)) problems.push(`image file in the renderer: ${path}`);
  }
  return problems;
}
