// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15 (docs/planning/_archive/M102.md, Design 3; C1, C2, C5, C8, C10, C17, C20, C21, C53, C54, C58): one root's
// scan on a stand-in file system that records every call — the layout and role names in any case,
// two files for one role, links and dot names passed over, the one count stopping the scan, an
// unreadable root, an avatar with no portrait, files not used, each problem of a role file, nothing
// written, and no more of an image read than its header but for the one PNG case.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVATAR_HEADER_BYTES, AVATAR_SCAN_LIMIT } from '@shared/contracts/avatars';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { apngBytes, jpegBytes, pngBytes, pngWithChunks, webpBytes } from '../images/test-support';
import { buildCatalog } from './catalog';
import { type ScannedRoot, scanRoot } from './scan';
import { avatarStandIn, type StandInNode } from './test-support';

const ROOT = path.resolve('/avatars-root');
const at = (relative: string): string => path.join(ROOT, ...relative.split('/'));
const tree = (files: Readonly<Record<string, StandInNode>>): Record<string, StandInNode> => Object.fromEntries(Object.entries(files).map(([relative, node]) => [at(relative), node]));
const SQUARE = pngBytes(8, 8);
const SMALL = webpBytes('VP8L', 4, 4);

/** One root's scan, and its listing as the tab would get it. */
async function scan(files: Readonly<Record<string, StandInNode>>, origin: 'built-in' | 'user' = 'user') {
  const standIn = avatarStandIn(tree(files));
  const root = await scanRoot(origin, ROOT, standIn.fs);
  const listing = buildCatalog([root], new Set(['claude', 'codex'])).listing.roots[0];
  return { standIn, root, listing };
}
const avatar = (root: ScannedRoot, family: string, folder: string) => root.families.find((candidate) => candidate.folder === family)?.avatars.find((candidate) => candidate.folder === folder);

describe('the layout and the role names (V15; C1, C2, C5)', () => {
  it('reads a family of avatars, each by its folder’s names, its files by role in any ASCII case', async () => {
    const { root, listing } = await scan({ 'Orange/Op 5.5/PORTRAIT.PNG': SQUARE, 'Orange/Op 5.5/Small.WebP': SMALL, 'Orange/Fa 5/portrait.webp': webpBytes('VP8 ', 16, 16) });
    expect(root.families.map((family) => family.folder)).toEqual(['Orange']);
    expect(avatar(root, 'Orange', 'Op 5.5')?.files.map((file) => [file.role, file.format, file.width, file.relative])).toEqual([['portrait', 'png', 8, 'Orange/Op 5.5/PORTRAIT.PNG'], ['small', 'webp', 4, 'Orange/Op 5.5/Small.WebP']]);
    expect(listing?.families[0]?.avatars.map((view) => view.folder)).toEqual(['Fa 5', 'Op 5.5']);
    expect(listing?.families[0]?.avatars[1]?.problems).toEqual([]);
  });

  it('names a file that is no role as not used, and passes over a family’s other files', async () => {
    const { root, listing } = await scan({ 'Orange/notes.txt': new Uint8Array(3), 'Orange/LICENSE.txt': new Uint8Array(3), 'Orange/Default/portrait.png': SQUARE, 'Orange/Op/portrait.png': SQUARE, 'Orange/Op/sketch.psd': new Uint8Array(3), 'Orange/Op/portrait.jpg': jpegBytes(8, 8) });
    expect(avatar(root, 'Orange', 'Op')?.unused).toEqual(['portrait.jpg', 'sketch.psd']);
    expect(listing?.families[0]?.problems).toEqual([]);
    expect(listing?.families[0]?.avatars.map((view) => view.folder)).toEqual(['Default', 'Op']);
  });

  it('passes over links and dot names, at the root, in a family and in an avatar, entering no folder in an avatar', async () => {
    const { root, standIn } = await scan({
      '.git/objects/portrait.png': SQUARE,
      'Linked': { link: '/elsewhere' },
      'Orange/.drafts/portrait.png': SQUARE,
      'Orange/Elsewhere': { link: '/elsewhere' },
      'Orange/Op/.portrait.png': SQUARE,
      'Orange/Op/old/portrait.png': SQUARE,
      'Orange/Op/portrait.png': SQUARE,
    });
    expect(root.families.map((family) => family.folder)).toEqual(['Orange']);
    expect(root.families[0]?.avatars.map((entry) => entry.folder)).toEqual(['Op']);
    expect(avatar(root, 'Orange', 'Op')?.unused).toEqual([]);
    // Nothing under a dot folder, a link or an avatar's own folder was asked about.
    const asked = standIn.calls.map((call) => path.relative(ROOT, call.path).split(path.sep).join('/'));
    expect(asked.filter((relative) => /^\.git|^Linked|\.drafts|Elsewhere|\/old|\.portrait/.test(relative))).toEqual([]);
  });

  it('reports a link under a role’s name, and follows it nowhere', async () => {
    const { root, standIn } = await scan({ 'Orange/Op/portrait.png': { link: '/elsewhere/portrait.png' } });
    expect(avatar(root, 'Orange', 'Op')?.problems).toEqual([{ kind: 'link', path: 'Orange/Op/portrait.png' }, { kind: 'no-portrait', path: 'Orange/Op' }]);
    expect(standIn.calls.some((call) => call.path.includes('elsewhere'))).toBe(false);
  });
});

describe('two files for one role, and an avatar with no portrait (V15; C8, C10)', () => {
  it('uses neither of two files for one role, and says so of each', async () => {
    const { root } = await scan({ 'Orange/Op/portrait.png': SQUARE, 'Orange/Op/portrait.webp': SMALL, 'Orange/Op/small.png': SQUARE });
    expect(avatar(root, 'Orange', 'Op')?.files.map((file) => file.role)).toEqual(['small']);
    expect(avatar(root, 'Orange', 'Op')?.problems).toEqual([
      { kind: 'duplicate-role', path: 'Orange/Op/portrait.png' },
      { kind: 'duplicate-role', path: 'Orange/Op/portrait.webp' },
      { kind: 'no-portrait', path: 'Orange/Op' },
    ]);
  });

  it('takes two names differing by case alone, on a system that lists both, as two files for one role', async () => {
    // The stand-in lists both, as a case-sensitive file system does.
    const standIn = avatarStandIn();
    standIn.set(at('Orange/Op/portrait.png'), SQUARE);
    standIn.set(at('Orange/Op/Portrait.png'), SQUARE);
    const root = await scanRoot('user', ROOT, standIn.fs);
    expect(avatar(root, 'Orange', 'Op')?.problems.map((problem) => problem.kind)).toEqual(['duplicate-role', 'duplicate-role', 'no-portrait']);
  });

  it('lists an avatar with a small alone, and draws it nowhere', async () => {
    const { listing } = await scan({ 'Orange/Op/small.webp': SMALL });
    const view = listing?.families[0]?.avatars[0];
    expect(view?.files.map((file) => file.role)).toEqual(['small']);
    expect(view?.problems).toEqual([{ kind: 'no-portrait', path: 'Orange/Op' }]);
  });
});

describe('each problem of a role file, and nothing used of it (V15; C51, C53, C54)', () => {
  it.each([
    ['wrong-type', 'a PNG named as a WebP', 'portrait.webp', SQUARE],
    ['wrong-type', 'a JPEG named as a PNG', 'portrait.png', jpegBytes(8, 8)],
    ['wrong-type', 'text named as a PNG', 'portrait.png', new TextEncoder().encode('not an image at all')],
    ['not-square', 'a wide portrait', 'portrait.png', pngBytes(16, 8)],
    ['too-large-pixels', 'a portrait past 8000 pixels a side', 'portrait.png', (() => { const big = Buffer.from(SQUARE); big.writeUInt32BE(9000, 16); big.writeUInt32BE(9000, 20); return big; })()],
    ['animated', 'an APNG', 'portrait.png', apngBytes(8, 8)],
    ['animated', 'an animated WebP', 'portrait.webp', webpBytes('VP8X', 8, 8, 0x02)],
    ['damaged', 'a PNG cut short', 'portrait.png', SQUARE.subarray(0, 41)],
    ['damaged', 'a WebP cut short', 'portrait.webp', SMALL.subarray(0, 22)],
  ] as const)('reports %s for %s', async (kind, _what, name, bytes) => {
    const { root } = await scan({ [`Orange/Op/${name}`]: bytes });
    expect(avatar(root, 'Orange', 'Op')?.problems).toEqual([{ kind, path: `Orange/Op/${name}` }, { kind: 'no-portrait', path: 'Orange/Op' }]);
    expect(avatar(root, 'Orange', 'Op')?.files).toEqual([]);
  });

  it('reports a file past 5 MiB as too large, reading none of it', async () => {
    const { root, standIn } = await scan({ 'Orange/Op/portrait.png': new Uint8Array(MAX_IMAGE_BYTES + 1) });
    expect(avatar(root, 'Orange', 'Op')?.problems[0]).toEqual({ kind: 'too-large-bytes', path: 'Orange/Op/portrait.png' });
    expect(standIn.calls.filter((call) => call.op === 'readPrefix' || call.op === 'readWhole')).toEqual([]);
  });

  it('reports a file the system will not hand over as unreadable', async () => {
    const standIn = avatarStandIn(tree({ 'Orange/Op/portrait.png': SQUARE }));
    standIn.failing.set(at('Orange/Op/portrait.png'), 'EACCES');
    const root = await scanRoot('user', ROOT, standIn.fs);
    expect(avatar(root, 'Orange', 'Op')?.problems[0]).toEqual({ kind: 'unreadable', path: 'Orange/Op/portrait.png' });
  });
});

describe('what is read, and that nothing is written (V15; C21, C53)', () => {
  const reads = (calls: readonly { readonly op: string; readonly bytes?: number }[]) => calls.filter((call) => call.op === 'readPrefix' || call.op === 'readWhole');

  it('reads an image’s first 64 KiB alone where they decide it: a still PNG, a WebP', async () => {
    // A still PNG of 100 KiB, its IDAT within its first 64 KiB; a WebP of 100 KiB.
    const png = Buffer.concat([SQUARE, Buffer.alloc(100 * 1024)]);
    const webp = Buffer.concat([webpBytes('VP8X', 8, 8), Buffer.alloc(100 * 1024)]);
    const { root, standIn } = await scan({ 'Orange/A/portrait.png': png, 'Orange/B/portrait.webp': webp });
    expect(avatar(root, 'Orange', 'A')?.files).toHaveLength(1);
    expect(avatar(root, 'Orange', 'B')?.files).toHaveLength(1);
    expect(reads(standIn.calls).map((call) => [call.op, call.bytes])).toEqual([['readPrefix', AVATAR_HEADER_BYTES], ['readPrefix', AVATAR_HEADER_BYTES]]);
  });

  it('reads a PNG whole, within the bound, where its first 64 KiB reach no IDAT: still, or moving', async () => {
    const still = pngWithChunks(8, 8, [{ name: 'iCCP', bytes: 70 * 1024 }]);
    const moving = apngBytes(8, 8, 70 * 1024);
    const { root, standIn } = await scan({ 'Orange/A/portrait.png': still, 'Orange/B/portrait.png': moving });
    expect(avatar(root, 'Orange', 'A')?.files.map((file) => file.role)).toEqual(['portrait']);
    expect(avatar(root, 'Orange', 'B')?.problems[0]).toEqual({ kind: 'animated', path: 'Orange/B/portrait.png' });
    expect(reads(standIn.calls).map((call) => [call.op, call.bytes])).toEqual([['readPrefix', AVATAR_HEADER_BYTES], ['readWhole', still.length], ['readPrefix', AVATAR_HEADER_BYTES], ['readWhole', moving.length]]);
  });

  it('writes nothing, in either root: no call but a list, a stat, a real path and a read', async () => {
    const { standIn } = await scan({ 'Orange/family.json': new TextEncoder().encode('{"schemaVersion":1,"minReaderVersion":1}'), 'Orange/Op/portrait.png': SQUARE, 'Orange/Op/small.webp': SMALL, 'Orange/Op/notes.txt': new Uint8Array(1) });
    const before = standIn.paths();
    expect(new Set(standIn.calls.map((call) => call.op))).toEqual(new Set(['list', 'realpath', 'lstat', 'readPrefix', 'readWhole']));
    expect(standIn.paths()).toEqual(before);
  });
});

describe('the roots (V15; C17, C20, C58)', () => {
  it('reads an absent user root as no family and no problem', async () => {
    const standIn = avatarStandIn();
    expect(await scanRoot('user', ROOT, standIn.fs)).toEqual({ origin: 'user', realRoot: null, families: [], problems: [] });
  });

  it('reports a root that cannot be read, and an absent built-in root', async () => {
    const standIn = avatarStandIn(tree({ 'Orange/Op/portrait.png': SQUARE }));
    standIn.failing.set(ROOT, 'EACCES');
    expect(await scanRoot('user', ROOT, standIn.fs)).toEqual({ origin: 'user', realRoot: null, families: [], problems: [{ kind: 'root-unreadable', path: '' }] });
    expect(await scanRoot('built-in', path.resolve('/nowhere'), avatarStandIn().fs)).toMatchObject({ problems: [{ kind: 'root-unreadable', path: '' }] });
  });

  it('reports a family or an avatar folder that cannot be listed, and scans the rest', async () => {
    const standIn = avatarStandIn(tree({ 'Blue/Lu/portrait.png': SQUARE, 'Orange/Op/portrait.png': SQUARE, 'Orange/Fa/portrait.png': SQUARE }));
    standIn.failing.set(at('Blue'), 'EACCES');
    standIn.failing.set(at('Orange/Fa'), 'EPERM');
    const root = await scanRoot('user', ROOT, standIn.fs);
    expect(root.families.map((family) => [family.folder, family.problems, family.avatars.map((entry) => entry.folder)])).toEqual([
      ['Blue', [{ kind: 'unreadable', path: 'Blue' }], []],
      ['Orange', [{ kind: 'unreadable', path: 'Orange/Fa' }], ['Op']],
    ]);
  });

  it('stops at the one count of entries listed in a root, says the folder it was listing, and reads no further', async () => {
    // A family of photos dropped by mistake: more files than the count, before a family after it.
    const files: Record<string, StandInNode> = { 'Zed/Op/portrait.png': SQUARE };
    for (let index = 0; index < AVATAR_SCAN_LIMIT + 10; index += 1) files[`Photos/IMG_${String(index).padStart(5, '0')}.jpg`] = new Uint8Array(1);
    const { root, standIn } = await scan(files);
    expect(root.problems).toEqual([{ kind: 'stopped', path: 'Photos' }]);
    expect(root.families.map((family) => family.folder)).toEqual(['Photos']);
    expect(standIn.calls.filter((call) => call.op !== 'list' && call.op !== 'realpath')).toEqual([]);
    expect(standIn.calls.some((call) => call.path.includes('Zed'))).toBe(false);
  });

  it('keeps the avatars it completed and the one it was in as far as it got', async () => {
    const files: Record<string, StandInNode> = { 'Orange/A/portrait.png': SQUARE };
    // The root (1), the family (2), A's file (1), then B's files run past the count.
    for (let index = 0; index < AVATAR_SCAN_LIMIT; index += 1) files[`Orange/B/x${String(index).padStart(5, '0')}.txt`] = new Uint8Array(1);
    files['Orange/B/portrait.png'] = SQUARE;
    const { root } = await scan(files);
    expect(root.problems).toEqual([{ kind: 'stopped', path: 'Orange/B' }]);
    expect(root.families[0]?.avatars.map((entry) => [entry.folder, entry.files.length])).toEqual([['A', 1], ['B', 1]]);
  });
});
