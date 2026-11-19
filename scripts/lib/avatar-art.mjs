// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The built-in avatar art in a package (docs/planning/_archive/M102.md, Design 9; C42, C69, C70; decision 0007):
// `assets/avatars/` copied beside the archive as `resources/avatars/`. Shared by scripts/package.mjs,
// which credits each family whose manifest names a licence in THIRD_PARTY_NOTICES.txt, and by
// scripts/verify-package.mjs, which audits the folder. A new family is a new folder: no line here
// names one. Pure but for `avatarFamilyAssets`, which reads the families' manifests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Where the art is in the repository, relative to its root, and where it lands beside the archive. */
export const AVATAR_ART_SOURCE = 'assets/avatars';
export const AVATAR_ART_FOLDER = 'avatars';
/** The art folder's bound, in all (C70). */
export const AVATAR_ART_LIMIT = 4 * 1024 * 1024;

/** A family's line in the notices (C69). */
export function avatarNoticeLine(name, licence) {
  return `Avatar family ${name} — ${licence} — avatar art`;
}

/** What a manifest says of a family's credit: its name, else its folder's, and its licence, or null. */
export function familyCredit(folder, manifest) {
  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  const fields = typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest) ? manifest : {};
  return { name: text(fields.name) ?? folder, licence: text(fields.licence) };
}

/**
 * Each family under `root` whose manifest names a licence (C69): its notice line and its licence's
 * file, relative to the repository's root as `prefix` is, for the notices' assets. The placeholder
 * families name none, and give none (C42).
 */
export function avatarFamilyAssets(root, prefix = AVATAR_ART_SOURCE) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const manifestFile = path.join(root, entry.name, 'family.json');
      let manifest;
      try { manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null; } catch { manifest = null; }
      const { name, licence } = familyCredit(entry.name, manifest);
      return licence === null ? [] : [{ line: avatarNoticeLine(name, licence), licenseFile: `${prefix}/${entry.name}/LICENSE.txt` }];
    });
}

/** The names the art folder may hold (C70): a family's manifest and licence, and an avatar's role files. */
const FAMILY_FILE = /^[^/.][^/]*\/(family\.json|LICENSE\.txt)$/;
const ROLE_FILE = /^[^/.][^/]*\/[^/.][^/]*\/(portrait|small)\.(png|webp)$/i;

/**
 * The art folder's problems (C70). `files`: every file under it, `{ path, bytes }`, the path relative
 * to it with `/`. `manifests`: each family folder's parsed `family.json`, undefined where it has none
 * or it is no JSON. `notices`: THIRD_PARTY_NOTICES.txt's text.
 */
export function auditAvatarArt({ files, manifests, notices }) {
  const problems = [];
  const odd = files.filter((file) => !FAMILY_FILE.test(file.path) && !ROLE_FILE.test(file.path)).map((file) => file.path);
  if (odd.length > 0) problems.push(`files the avatar art may not hold: ${odd.join(', ')}`);
  const lines = new Set(notices.split('\n'));
  for (const [folder, manifest] of Object.entries(manifests)) {
    const { name, licence } = familyCredit(folder, manifest);
    if (licence === null) continue;
    if (!files.some((file) => file.path === `${folder}/LICENSE.txt`)) problems.push(`avatar family ${folder} names a licence but holds no LICENSE.txt`);
    if (!lines.has(avatarNoticeLine(name, licence))) problems.push(`avatar family ${folder} names a licence but THIRD_PARTY_NOTICES.txt does not credit it`);
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > AVATAR_ART_LIMIT) problems.push(`the avatar art is ${(total / 2 ** 20).toFixed(1)} MiB (limit ${AVATAR_ART_LIMIT / 2 ** 20} MiB)`);
  return problems;
}

/**
 * The art folder's files that hold private text (C70): every one of them read, images included, as
 * the archive's entries are. `files`: `{ path, text }`, the text read as latin1; `contains` the
 * audit's own test (package-audit.mjs, containsNeedle) with its needles bound.
 */
export function avatarArtLeaks(files, contains) {
  return files.filter((file) => contains(file.text)).map((file) => file.path);
}
