// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CreateFamilyRequest } from '@shared/contracts/avatar-family';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { apngBytes, pngBytes } from '../images/test-support';
import { nodeAvatarFs } from './fs';
import { createAvatarService } from './service';
import { avatarStandIn } from './test-support';

const USER = path.resolve('/user');
const BUILT_IN = path.resolve('/built-in');
const portrait = new Uint8Array(pngBytes(512, 512));
const small = new Uint8Array(pngBytes(64, 64));
const request: CreateFamilyRequest = { name: 'Planets', avatar: null, portrait, small };
const at = (...parts: string[]) => path.join(USER, 'Planets', ...parts);

function setup(writable = true) {
  const standIn = avatarStandIn();
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createAvatarService({ roots: { builtIn: BUILT_IN, user: USER }, fs: standIn.fs, writable: { user: writable }, providers: ['codex', 'claude'], log });
  const writes = () => standIn.calls.filter((call) => ['createFolder', 'createExclusiveFolder', 'writeNewFile', 'writeText', 'removeCopy'].includes(call.op));
  return { service, standIn, log, writes };
}

describe('Create family from an image', () => {
  it('creates a usable Default alone without matches, publishes the catalog and logs no names', async () => {
    const { service, standIn, log } = setup();
    const answer = await service.createFamily(request);
    expect(answer).toMatchObject({ kind: 'created', ref: { origin: 'user', family: 'Planets' } });
    if (answer.kind !== 'created') throw new Error('not created');
    const family = answer.listing.roots[1]?.families[0];
    expect(family).toMatchObject({ folder: 'Planets', provider: 'any', problems: [] });
    expect(family?.avatars.map((avatar) => avatar.folder)).toEqual(['Default']);
    expect(family?.avatars[0]?.files.map((file) => [file.role, file.width])).toEqual([['portrait', 512], ['small', 64]]);
    expect(service.family(answer.ref)?.usableFor('codex')).toBe(true);
    expect(service.family(answer.ref)?.face('claude')?.portrait).toBeTruthy();
    const opened = await service.openFamily(answer.ref);
    expect(opened).toMatchObject({ lock: null, draft: { provider: 'any', avatars: [] }, missing: [] });
    expect(opened?.revision).not.toBeNull();
    expect(JSON.parse(standIn.text(at('family.json')) ?? '')).toMatchObject({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, avatars: [] });
    expect(log.info.mock.calls.flat().join(' ')).not.toMatch(/Planets|Default/);
  });

  it('uses the image for Default and a named matched avatar, preserving provider-specific matches', async () => {
    const { service, standIn } = setup();
    const avatar = { name: 'Sun', matches: ['*-sol*', { provider: 'claude', key: '*opus*' }] };
    expect(await service.createFamily({ ...request, avatar })).toMatchObject({ kind: 'created' });
    expect(await standIn.fs.readWhole(at('Sun', 'portrait.png'), 1e6)).toEqual(portrait);
    expect(await standIn.fs.readWhole(at('Default', 'portrait.png'), 1e6)).toEqual(portrait);
    expect(await standIn.fs.readWhole(at('Sun', 'small.png'), 1e6)).toEqual(small);
    expect(JSON.parse(standIn.text(at('family.json')) ?? '')).toMatchObject({ avatars: [{ folder: 'Sun', matches: avatar.matches }] });
  });

  it('refuses duplicate names across case, including a concurrent create, without overwriting anything', async () => {
    const { service, standIn } = setup();
    const answers = await Promise.all([service.createFamily(request), service.createFamily({ ...request, name: 'PLANETS' })]);
    expect(answers.map((answer) => answer.kind)).toEqual(['created', 'taken']);
    const before = standIn.text(at('family.json'));
    expect(await service.createFamily(request)).toEqual({ kind: 'taken' });
    expect(standIn.text(at('family.json'))).toBe(before);
  });

  it.each(['../escape', 'bad/name', 'bad\\name', 'CON', 'Name.', '', '.hidden', 'x'.repeat(65)])('refuses an invalid family name %s before writing', async (name) => {
    const { service, writes } = setup();
    expect(await service.createFamily({ ...request, name })).toEqual({ kind: 'invalid' });
    expect(writes()).toEqual([]);
  });

  it.each([
    { small: new Uint8Array(pngBytes(32, 32)) },
    { portrait: new Uint8Array(pngBytes(513, 513)) },
    { portrait: new Uint8Array(apngBytes(512, 512)) },
    { avatar: { name: 'Default', matches: ['*'] } },
    { avatar: { name: 'Sun', matches: [] } },
    { avatar: { name: 'Sun', matches: ['not a pattern'] } },
  ])('refuses invalid images or matched avatars before writing: %j', async (change) => {
    const { service, writes } = setup();
    expect(await service.createFamily({ ...request, ...change })).toEqual({ kind: 'invalid' });
    expect(writes()).toEqual([]);
  });

  it('refuses a read-only user root or a linked root without writing', async () => {
    const locked = setup(false);
    expect(await locked.service.createFamily(request)).toEqual({ kind: 'unavailable' });
    expect(locked.writes()).toEqual([]);
    const linked = setup();
    linked.standIn.set(USER, { link: path.resolve('/elsewhere') });
    expect(await linked.service.createFamily(request)).toEqual({ kind: 'unavailable' });
    expect(linked.writes()).toEqual([]);
  });

  it('leaves a folder that appeared at reservation alone', async () => {
    const { service, standIn } = setup();
    const reserve = standIn.fs.createExclusiveFolder.bind(standIn.fs);
    standIn.fs.createExclusiveFolder = async (folder) => {
      standIn.set(path.join(folder, 'theirs.txt'), new TextEncoder().encode('theirs'));
      return reserve(folder);
    };
    expect(await service.createFamily(request)).toEqual({ kind: 'taken' });
    expect(standIn.text(at('theirs.txt'))).toBe('theirs');
    expect(standIn.calls.some((call) => call.op === 'removeCopy')).toBe(false);
  });

  it.each(['Default/small.png', 'Sun/portrait.png', 'family.json'])('cleans up only its reserved folder when %s fails', async (file) => {
    const { service, standIn } = setup();
    standIn.set(path.join(USER, 'Keep', 'note.txt'), new TextEncoder().encode('keep'));
    standIn.failing.set(at(...file.split('/')), 'ENOSPC');
    expect(await service.createFamily({ ...request, avatar: { name: 'Sun', matches: ['*sol*'] } })).toEqual({ kind: 'failed' });
    expect(standIn.paths().some((file) => file === at() || file.startsWith(`${at()}${path.sep}`))).toBe(false);
    expect(standIn.text(path.join(USER, 'Keep', 'note.txt'))).toBe('keep');
  });

  it('never cleans up a reserved folder whose real location has changed', async () => {
    const { service, standIn } = setup();
    standIn.fs.writeNewFile = () => {
      standIn.real.set(at(), path.resolve('/elsewhere'));
      return Promise.reject(new Error('changed'));
    };
    expect(await service.createFamily(request)).toEqual({ kind: 'failed' });
    expect(standIn.calls.some((call) => call.op === 'removeCopy')).toBe(false);
  });

  it('creates through the real file adapter in an initially absent user root', async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'fatg-create-family-'));
    try {
      const user = path.join(temporary, 'avatars');
      const service = createAvatarService({ roots: { user, builtIn: path.join(temporary, 'built-in') }, fs: nodeAvatarFs, providers: [], log: { info: vi.fn(), warn: vi.fn() } });
      expect(await service.createFamily(request)).toMatchObject({ kind: 'created' });
      expect(await readFile(path.join(user, 'Planets', 'Default', 'small.png'))).toEqual(Buffer.from(small));
      expect(await service.createFamily(request)).toEqual({ kind: 'taken' });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
