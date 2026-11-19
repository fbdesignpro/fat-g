// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V24 (docs/planning/_archive/M102.md, Design 9; C42, C69, C70): the built-in avatar art's packaging — the names
// the art folder may hold, its one bound, a family naming a licence without its file or its notice
// line refused and one naming none admitted, the image rule of the renderer standing, and a private
// path in any of its files, an image's included, failing the privacy scan. Without building a package.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_ART_LIMIT, AVATAR_ART_SOURCE, auditAvatarArt, avatarArtLeaks, avatarFamilyAssets, avatarNoticeLine } from '../../scripts/lib/avatar-art.mjs';
import { assetProblems, containsNeedle, privacyNeedles } from '../../scripts/lib/package-audit.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SHIPPED = ['Codex/family.json', 'Codex/Default/portrait.webp', 'Codex/Default/small.webp', 'Claude/family.json', 'Claude/Op 5.5/portrait.webp'];
const files = (paths: readonly string[], bytes = 1000) => paths.map((file) => ({ path: file, bytes }));

describe('the names the art folder holds (V24; C70)', () => {
  it('admits family folders of a manifest, a licence and avatar folders of role files, in any case of the role', () => {
    expect(auditAvatarArt({ files: files([...SHIPPED, 'Claude/LICENSE.txt', 'Claude/Fa 5/PORTRAIT.PNG', 'Claude/Fa 5/Small.webp']), manifests: { Claude: {}, Codex: {} }, notices: '' })).toEqual([]);
  });

  it.each([
    ['a file at its root', 'notes.txt'],
    ['another file in a family', 'Claude/notes.txt'],
    ['a file that is no role', 'Claude/Op 5.5/sketch.psd'],
    ['a JPEG under a role’s name', 'Claude/Op 5.5/portrait.jpg'],
    ['a folder inside an avatar', 'Claude/Op 5.5/old/portrait.png'],
    ['a dot name', 'Claude/.drafts/portrait.png'],
    ['a dot family', '.git/HEAD'],
  ])('refuses %s', (_name, file) => {
    expect(auditAvatarArt({ files: files([...SHIPPED, file]), manifests: {}, notices: '' })).toEqual([`files the avatar art may not hold: ${file}`]);
  });

  it('holds the folder to 4 MiB in all', () => {
    const at = AVATAR_ART_LIMIT / SHIPPED.length;
    expect(auditAvatarArt({ files: files(SHIPPED, at), manifests: {}, notices: '' })).toEqual([]);
    expect(auditAvatarArt({ files: files(SHIPPED, at + 1), manifests: {}, notices: '' })).toEqual(['the avatar art is 4.0 MiB (limit 4 MiB)']);
  });
});

describe('the families’ credits (V24; C42, C69, C70)', () => {
  const line = avatarNoticeLine('Starry', 'CC-BY-4.0');

  it('admits a family naming no licence, with no file and no line: the two it ships', () => {
    expect(auditAvatarArt({ files: files(SHIPPED), manifests: { Claude: { name: 'Claude' }, Codex: { name: 'Codex' } }, notices: 'nothing about avatars' })).toEqual([]);
  });

  it('refuses a family naming a licence without its LICENSE.txt, or without its notice line, and admits one with both', () => {
    const manifests = { Claude: { name: 'Starry', licence: 'CC-BY-4.0' } };
    expect(auditAvatarArt({ files: files(SHIPPED), manifests, notices: line })).toEqual(['avatar family Claude names a licence but holds no LICENSE.txt']);
    expect(auditAvatarArt({ files: files([...SHIPPED, 'Claude/LICENSE.txt']), manifests, notices: 'another line' })).toEqual(['avatar family Claude names a licence but THIRD_PARTY_NOTICES.txt does not credit it']);
    expect(auditAvatarArt({ files: files([...SHIPPED, 'Claude/LICENSE.txt']), manifests, notices: `before\n${line}\nafter` })).toEqual([]);
  });

  it('gives the packager each licensed family’s line and licence file, and none for one naming no licence', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fatg-avatar-art-'));
    try {
      mkdirSync(path.join(dir, 'Claude'));
      writeFileSync(path.join(dir, 'Claude', 'family.json'), JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, name: 'Starry', licence: 'CC-BY-4.0' }));
      mkdirSync(path.join(dir, 'Codex'));
      writeFileSync(path.join(dir, 'Codex', 'family.json'), JSON.stringify({ schemaVersion: 1, minReaderVersion: 1 }));
      expect(avatarFamilyAssets(dir, 'art')).toEqual([{ line, licenseFile: 'art/Claude/LICENSE.txt' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('credits none of the families fat-g ships (V25; C42, C71)', () => {
    expect(avatarFamilyAssets(path.join(ROOT, AVATAR_ART_SOURCE))).toEqual([]);
  });
});

describe('what else the audit holds (V24; C70)', () => {
  it('still refuses any image in the renderer', () => {
    expect(assetProblems([{ path: 'out/renderer/assets/face.webp' }]).filter((problem) => problem.includes('image'))).toEqual(['image file in the renderer: out/renderer/assets/face.webp']);
  });

  it('finds a private path in any file of the art, a manifest, a licence or an image', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone';
    const needles = privacyNeedles({ home, fixtureStrings: [] });
    const contains = (text: string) => containsNeedle(text, needles, process.platform === 'win32');
    const image = Buffer.concat([Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'), Buffer.from(`${home.replaceAll('\\', '/')}/Pictures/face.png`, 'latin1')]).toString('latin1');
    const art = [
      { path: 'avatars/Claude/family.json', text: JSON.stringify({ name: 'Claude', author: home }) },
      { path: 'avatars/Claude/LICENSE.txt', text: `Drawn in ${home}\\Art` },
      { path: 'avatars/Claude/Op 5.5/portrait.webp', text: image },
      { path: 'avatars/Codex/Default/portrait.webp', text: 'RIFF....WEBPVP8 clean' },
    ];
    expect(avatarArtLeaks(art, contains)).toEqual(['avatars/Claude/family.json', 'avatars/Claude/LICENSE.txt', 'avatars/Claude/Op 5.5/portrait.webp']);
  });
});
