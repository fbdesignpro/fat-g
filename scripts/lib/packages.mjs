// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a package ships and credits, computed from package-lock.json (lockfile v3). Shared by
// scripts/package.mjs (third-party notices) and scripts/verify-package.mjs (the audit), so both agree.
// Pure except for `licenseText`, which reads one package folder.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Name of the package installed at a lockfile key such as `node_modules/a/node_modules/@b/c`. */
export function nameAt(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/**
 * Every installed package the app ships under node_modules: reachable from `dependencies` at runtime.
 * npm flags packages reachable only as dev, optional or peer dependencies; none of those ship.
 * @returns {{ key: string, name: string, version: string, license: string | null }[]}
 */
export function shippedPackages(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([key, entry]) => key.includes('node_modules/') && !entry.dev && !entry.devOptional && !entry.optional && !entry.peer && !entry.link)
    .map(([key, entry]) => ({ key, name: entry.name ?? nameAt(key), version: entry.version, license: typeof entry.license === 'string' ? entry.license : null }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The top-level installed package of that name, as the bundler resolved it. */
export function installed(lock, name) {
  const entry = lock.packages?.[`node_modules/${name}`];
  return entry === undefined ? undefined : { key: `node_modules/${name}`, name, version: entry.version, license: typeof entry.license === 'string' ? entry.license : null };
}

/** All root license texts and notices; a NOTICE alone does not establish a license. */
export function licenseText(packageDirectory) {
  if (!existsSync(packageDirectory)) return null;
  const files = readdirSync(packageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(\b|[.-]|$)/i.test(entry.name))
    .map((entry) => entry.name).sort();
  const texts = files.map((file) => ({ file, text: readFileSync(path.join(packageDirectory, file), 'utf8').replace(/\r\n/g, '\n').trim() }));
  if (!texts.some(({ file, text }) => /^(licen[cs]e|copying)(\b|[.-]|$)/i.test(file) && text.length > 0)) return null;
  if (texts.some(({ text }) => text.length === 0)) throw new Error(`Empty license or notice file in ${path.basename(packageDirectory)}`);
  return texts.map(({ file, text }) => `${file}\n\n${text}`).join('\n\n');
}

/** Local packaging checks only: missing metadata/text or text lost from generated notices. */
export function packageNoticeProblems(entries, notices) {
  return entries.flatMap((entry) => {
    const label = `${entry.name}@${entry.version}`;
    const problems = [];
    if (!entry.license?.trim()) problems.push(`${label}: no declared license`);
    if (!entry.text?.trim()) problems.push(`${label}: no license text`);
    else if (notices !== undefined && !notices.replace(/\r\n/g, '\n').includes(entry.text.replace(/\r\n/g, '\n').trim())) problems.push(`${label}: license or notice text missing from THIRD_PARTY_NOTICES.txt`);
    return problems;
  });
}

/**
 * What ships besides code (M11): each asset's line in the notices, which the package audit requires,
 * and where its licence text comes from — a file in the build output, or the text itself.
 * @type {readonly { line: string, licenseFile?: string, text?: string }[]}
 */
export const PACKAGED_ASSETS = [
  { line: 'Inter 4.1 — OFL-1.1 — packaged font', licenseFile: 'out/renderer/fonts/inter/LICENSE.txt' },
  {
    line: 'Provider marks — original work of the fat-g contributors — MIT',
    text: "The provider marks in the control bar were drawn for fat-g; they are not the vendors' logos. They ship\nas images and vector data inside fat-g's own code, under its MIT licence (LICENSE.fat-g.txt).",
  },
  { line: 'Audio effects — original and imported sounds — see asset notices', licenseFile: 'assets/audio/LICENSE.txt' },
];

/**
 * THIRD_PARTY_NOTICES.txt: every package shipped under node_modules and every package bundled into
 * the preload or renderer, each with its declared license and its own license text, verbatim; then
 * the packaged assets, each with its licence.
 * @param {{ name: string, version: string, license: string | null, text: string | null, how: string }[]} entries
 * @param {{ line: string, text: string }[]} [assets]
 */
export function renderNotices(entries, assets = []) {
  const rule = '='.repeat(78);
  const head = [
    'fat-g — third-party notices',
    '',
    'fat-g is MIT-licensed (LICENSE.fat-g.txt). It runs on Electron, whose notices are in',
    'LICENSE.electron.txt and LICENSES.chromium.html alongside the application. The packages below',
    'retain their own licenses, whether shipped as runtime modules or bundled into the interface.',
    'fat-g contains no agent CLI: it launches the ones you installed yourself.',
  ].join('\n');
  const body = [...entries].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)).map((entry) => [
    rule,
    `${entry.name} ${entry.version} — ${entry.license ?? 'no declared license'} — ${entry.how}`,
    '-'.repeat(78),
    entry.text ?? `(The package contains no license file. Its declared license is: ${entry.license ?? 'none'}.)`,
  ].join('\n'));
  const assetPart = assets.length === 0 ? [] : [
    rule,
    'Assets: files fat-g ships that are not code.',
    ...assets.map((asset) => [rule, asset.line, '-'.repeat(78), asset.text].join('\n')),
  ];
  return `${[head, ...body, ...assetPart, rule].join('\n\n')}\n`;
}
