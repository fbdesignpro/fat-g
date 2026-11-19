// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { pngBytes, webpBytes } from '../images/test-support';
import { type AvatarFs, nodeAvatarFs } from './fs';
import { createAvatarService } from './service';
import { avatarStandIn } from './test-support';

const BUILT_IN = path.resolve('/built-in');
const USER = path.resolve('/user');
const source = { origin: 'built-in', family: 'Original' } as const;
const at = (...parts: string[]): string => path.join(BUILT_IN, 'Original', ...parts);
const target = (...parts: string[]): string => path.join(USER, 'Copy of Original', ...parts);
const portrait = pngBytes(8, 8);
const small = webpBytes('VP8L', 4, 4);
const manifest = JSON.stringify({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, provider: 'claude', author: 'Artist', licence: 'Example licence', defaultFor: ['claude'], future: { keep: true }, overlay: { version: { size: 19 } }, avatars: [{ folder: 'Face', matches: ['opus'], overlay: { effort: { size: 8 } } }] });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function setup(change?: (fs: AvatarFs) => AvatarFs) {
  const standIn = avatarStandIn({
    [at('family.json')]: encode(manifest),
    [at('LICENSE.txt')]: encode('The artwork licence'),
    [at('Default', 'portrait.png')]: portrait,
    [at('Default', 'small.webp')]: small,
    [at('Face', 'portrait.png')]: portrait,
    [at('Face', 'notes.txt')]: encode('Unrelated personal notes'),
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createAvatarService({ roots: { builtIn: BUILT_IN, user: USER }, fs: change?.(standIn.fs) ?? standIn.fs, providers: ['claude', 'codex'], log });
  return { standIn, service, log };
}

describe('Make a copy', () => {
  it('copies the original bytes, manifest and licence into an editable user family and returns its new listing', async () => {
    const { service, standIn, log } = setup();
    await service.scan();
    expect((await service.openFamily(source))?.lock).toEqual({ kind: 'packaged' });
    const answer = await service.copyFamily(source);
    expect(answer).toMatchObject({ kind: 'copied', ref: { origin: 'user', family: 'Copy of Original' } });
    if (answer.kind !== 'copied') throw new Error('copy failed');
    expect(answer.listing.roots[1]?.families.map((family) => [family.folder, family.provider])).toEqual([['Copy of Original', 'claude']]);
    expect(standIn.text(target('family.json'))).toBe(manifest);
    expect(standIn.text(target('LICENSE.txt'))).toBe('The artwork licence');
    expect(await standIn.fs.readWhole(target('Default', 'portrait.png'), 1000)).toEqual(portrait);
    expect(await standIn.fs.readWhole(target('Default', 'small.webp'), 1000)).toEqual(small);
    expect(standIn.paths()).not.toContain(target('Face', 'notes.txt'));
    expect(standIn.text(at('family.json'))).toBe(manifest);
    const opened = await service.openFamily(answer.ref);
    expect(opened?.lock).toBeNull();
    expect(opened?.draft).toMatchObject({ provider: 'claude', overlay: { version: { size: 19 } }, avatars: [{ folder: 'Face', matches: ['opus'], overlay: { effort: { size: 8 } } }] });
    if (opened === null) throw new Error('copy not listed');
    expect(await service.saveFamily({ ref: answer.ref, revision: opened.revision, draft: { ...opened.draft, provider: 'any' } })).toEqual({ kind: 'saved' });
    expect(standIn.text(at('family.json'))).toBe(manifest);
    expect(log.info.mock.calls.flat().join(' ')).not.toContain('Original');
  });

  it('numbers copies without overwriting existing families, ignoring case even on case-sensitive filesystems', async () => {
    const { service, standIn } = setup();
    standIn.set(path.join(USER, 'copy of original', 'keep.txt'), encode('keep'));
    await service.scan();
    const answers = await Promise.all([service.copyFamily(source), service.copyFamily(source)]);
    expect(answers.map((answer) => answer.kind === 'copied' ? answer.ref.family : answer.kind)).toEqual(['Copy of Original (2)', 'Copy of Original (3)']);
    expect(standIn.text(path.join(USER, 'copy of original', 'keep.txt'))).toBe('keep');
  });

  it('retries a name claimed after listing, without merging into it', async () => {
    const { service, standIn } = setup((fs) => ({ ...fs, createExclusiveFolder: async (folder) => folder === target() ? false : fs.createExclusiveFolder(folder) }));
    await service.scan();
    expect(await service.copyFamily(source)).toMatchObject({ kind: 'copied', ref: { family: 'Copy of Original (2)' } });
    expect(standIn.paths()).not.toContain(target('family.json'));
  });

  it('cleans up only its own new copy when a write fails', async () => {
    const { service, standIn } = setup();
    standIn.failing.set(target('Face', 'portrait.png'), 'ENOSPC');
    await service.scan();
    expect(await service.copyFamily(source)).toEqual({ kind: 'failed' });
    expect(standIn.paths().some((file) => file.startsWith(target()))).toBe(false);
    expect(standIn.text(at('family.json'))).toBe(manifest);
  });

  it.each(['source-folder', 'avatar-folder', 'role-file', 'licence', 'destination-root'] as const)('refuses a changed or linked %s', async (which) => {
    const { service, standIn } = setup();
    await service.scan();
    if (which === 'source-folder') standIn.real.set(at(), path.resolve('/elsewhere'));
    if (which === 'avatar-folder') standIn.real.set(at('Default'), path.resolve('/elsewhere'));
    if (which === 'role-file') standIn.set(at('Face', 'portrait.png'), { link: '/elsewhere/private.png' });
    if (which === 'licence') standIn.set(at('LICENSE.txt'), { link: '/elsewhere/private.txt' });
    if (which === 'destination-root') standIn.set(USER, { link: '/elsewhere' });
    expect(await service.copyFamily(source)).toEqual({ kind: 'failed' });
    expect(standIn.calls.filter((call) => call.op === 'writeNewFile')).toEqual([]);
  });

  it('rejects user-family and missing references, and refuses a manifest no longer compatible', async () => {
    const { service, standIn } = setup();
    await service.scan();
    expect(await service.copyFamily({ ...source, origin: 'user' })).toEqual({ kind: 'unavailable' });
    expect(await service.copyFamily({ ...source, family: '../elsewhere' })).toEqual({ kind: 'missing' });
    standIn.set(at('family.json'), encode('{"schemaVersion":1,"minReaderVersion":1}'));
    expect(await service.copyFamily(source)).toEqual({ kind: 'unavailable' });
    expect(standIn.calls.filter((call) => call.op === 'writeNewFile')).toEqual([]);
  });

  it('uses the real filesystem adapter to reserve copies and retain the image bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fatg-avatar-copy-'));
    try {
      const builtIn = path.join(root, 'built-in');
      const user = path.join(root, 'user');
      await mkdir(path.join(builtIn, 'Original', 'Default'), { recursive: true });
      await writeFile(path.join(builtIn, 'Original', 'Default', 'portrait.png'), portrait);
      await writeFile(path.join(builtIn, 'Original', 'family.json'), manifest);
      const service = createAvatarService({ roots: { builtIn, user }, fs: nodeAvatarFs, providers: ['claude'], log: { info: vi.fn(), warn: vi.fn() } });
      await service.scan();
      expect(await service.copyFamily(source)).toMatchObject({ kind: 'copied', ref: { family: 'Copy of Original' } });
      expect(await service.copyFamily(source)).toMatchObject({ kind: 'copied', ref: { family: 'Copy of Original (2)' } });
      expect(await readFile(path.join(user, 'Copy of Original', 'Default', 'portrait.png'))).toEqual(Buffer.from(portrait));
      expect(await readFile(path.join(builtIn, 'Original', 'family.json'), 'utf8')).toBe(manifest);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
