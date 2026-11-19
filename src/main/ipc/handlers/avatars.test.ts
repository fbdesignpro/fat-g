// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M102 (C40, C63; V18): the Avatars tab's two channels, from the Main window alone with a null request;
// and the family editor's (decisions 0031, 0036), which name a family and its avatars, never a path.
import { describe, expect, it, vi } from 'vitest';
import type { AddAvatarAnswer, ChooseImageAnswer, CopyFamilyAnswer, CreateFamilyAnswer, FamilySource, ReplaceImageAnswer, SaveFamilyAnswer } from '@shared/contracts/avatar-family';
import type { AvatarListing, FamilyRef } from '@shared/contracts/avatars';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { BYTE_FIELDS, byteField, bytesWithin, MAX_STAGE_BYTES, PRELOAD_ONLY_CHANNELS } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { avatarHandlers } from './avatars';

const deps: DispatchDeps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: { warn: vi.fn(), error: vi.fn() }, detail: 'kinds' };
const LISTING: AvatarListing = { roots: [{ origin: 'built-in', families: [], problems: [] }, { origin: 'user', families: [], problems: [] }] };
const FAMILY: FamilyRef = { origin: 'user', family: 'Planets' };
const SOURCE: FamilySource = { ref: FAMILY, lock: null, revision: null, draft: { provider: 'any', overlay: {}, avatars: [{ folder: 'Sun', matches: [], overlay: {} }] }, missing: [] };
const DRAFT = { provider: 'any', overlay: { version: { preset: 'glow' }, effort: { position: 'top' } }, avatars: [{ folder: 'Sun', matches: ['*-sol*', { provider: 'codex', key: 'gpt-6-sol' }], overlay: {} }] };
const REVISION = 'a'.repeat(64);

type Channel = 'avatars:list' | 'avatars:rescan' | 'avatars:family' | 'avatars:saveFamily' | 'avatars:copyFamily' | 'avatars:createFamily' | 'avatars:addAvatar' | 'avatars:replaceImage' | 'avatars:chooseImage' | 'avatars:noteDropped' | 'avatars:openFamilyFolder';

function setup() {
  const order: string[] = [];
  let settle: () => void = () => undefined;
  const service = {
    idle: vi.fn(() => new Promise<void>((resolve) => { settle = () => { order.push('settled'); resolve(); }; })),
    listing: vi.fn(() => { order.push('listing'); return LISTING; }),
    scan: vi.fn(() => { order.push('scan'); return Promise.resolve(); }),
    openFamily: vi.fn((ref: FamilyRef) => { order.push(`open ${ref.family}`); return Promise.resolve(ref.family === 'Planets' ? SOURCE : null); }),
    saveFamily: vi.fn((): Promise<SaveFamilyAnswer> => { order.push('save'); return Promise.resolve({ kind: 'saved' }); }),
    copyFamily: vi.fn((): Promise<CopyFamilyAnswer> => Promise.resolve({ kind: 'copied', ref: FAMILY, listing: LISTING })),
    createFamily: vi.fn((): Promise<CreateFamilyAnswer> => Promise.resolve({ kind: 'created', ref: FAMILY, listing: LISTING })),
    addAvatar: vi.fn((): Promise<AddAvatarAnswer> => Promise.resolve({ kind: 'added', folder: 'Moon', source: SOURCE, listing: LISTING })),
    replaceImage: vi.fn((_request: unknown): Promise<ReplaceImageAnswer> => Promise.resolve({ kind: 'replaced', listing: LISTING })),
    familyFolder: vi.fn((ref: FamilyRef) => Promise.resolve(ref.family === 'Planets' ? '/avatars/Planets' : null)),
  };
  const openFolder = vi.fn(() => Promise.resolve(''));
  const images = {
    choose: vi.fn((): Promise<ChooseImageAnswer> => Promise.resolve({ kind: 'chosen', name: 'sun.png', bytes: new Uint8Array([1]) })),
    noteDropped: vi.fn(),
  };
  const handlers = avatarHandlers(service, openFolder, images);
  const call = (channel: Channel, request: unknown, windowKind: 'main' | 'pet' = 'main') => {
    const sender = { frameUrl: windowKind === 'main' ? 'app://fatg/index.html' : 'app://fatg/pet.html', isTopFrame: true };
    return dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as (request: unknown) => Promise<unknown>, { windowKind, sender, request }, deps);
  };
  return { service, images, openFolder, call, order, settle: () => settle() };
}

describe('avatars:list (V18; C63)', () => {
  it('answers the listing once any scan under way has landed', async () => {
    const h = setup();
    const answer = h.call('avatars:list', null);
    await Promise.resolve();
    expect(h.order).toEqual([]);
    h.settle();
    await expect(answer).resolves.toEqual({ ok: true, value: LISTING });
    expect(h.order).toEqual(['settled', 'listing']);
  });
});

describe('avatars:rescan (V18; C40, C63)', () => {
  it('scans both roots and answers null once the scan has landed', async () => {
    const h = setup();
    await expect(h.call('avatars:rescan', null)).resolves.toEqual({ ok: true, value: null });
    expect(h.service.scan).toHaveBeenCalledOnce();
  });
});

describe('both channels (V18; C63)', () => {
  it.each(['avatars:list', 'avatars:rescan'] as const)('%s takes nothing but null, and is refused to the Pet', async (channel) => {
    const h = setup();
    for (const request of [{}, { root: 'C:\\elsewhere' }, 'Orange', undefined]) await expect(h.call(channel, request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    await expect(h.call(channel, null, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.scan).not.toHaveBeenCalled();
    expect(h.service.listing).not.toHaveBeenCalled();
  });
});

describe('avatars:family (decision 0031)', () => {
  it('answers a family as its file holds it once any scan under way has landed, and null for one not listed', async () => {
    const h = setup();
    const answer = h.call('avatars:family', FAMILY);
    await Promise.resolve();
    expect(h.order).toEqual([]);
    h.settle();
    await expect(answer).resolves.toEqual({ ok: true, value: SOURCE });
    expect(h.order).toEqual(['settled', 'open Planets']);
    const other = h.call('avatars:family', { origin: 'built-in', family: 'Gone' });
    h.settle();
    await expect(other).resolves.toEqual({ ok: true, value: null });
  });

  it('takes a family reference alone: no path, no avatar, no root it does not know', async () => {
    const h = setup();
    for (const request of [null, 'Planets', { ...FAMILY, path: 'C:\\art\\Planets' }, { ...FAMILY, avatar: 'Sun' }, { origin: 'elsewhere', family: 'Planets' }, { origin: 'user', family: '' }, { origin: 'user', family: 'x'.repeat(256) }]) {
      await expect(h.call('avatars:family', request), JSON.stringify(request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    }
    expect(h.service.openFamily).not.toHaveBeenCalled();
  });
});

describe('avatars:saveFamily (decision 0031)', () => {
  it('hands main the family, the revision and the draft, and answers what the save answered', async () => {
    const h = setup();
    await expect(h.call('avatars:saveFamily', { ref: FAMILY, revision: REVISION, draft: DRAFT })).resolves.toEqual({ ok: true, value: { kind: 'saved' } });
    expect(h.service.saveFamily).toHaveBeenCalledWith({ ref: FAMILY, revision: REVISION, draft: DRAFT });
    await expect(h.call('avatars:saveFamily', { ref: FAMILY, revision: null, draft: DRAFT })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['a path beside the family', { ref: { ...FAMILY, path: 'C:\\art' }, revision: REVISION, draft: DRAFT }],
    ['a path beside the request', { ref: FAMILY, revision: REVISION, draft: DRAFT, path: 'C:\\art\\family.json' }],
    ['a revision of another form', { ref: FAMILY, revision: 'abc', draft: DRAFT }],
    ['an upper-case revision', { ref: FAMILY, revision: 'A'.repeat(64), draft: DRAFT }],
    ['no revision', { ref: FAMILY, draft: DRAFT }],
    ['an empty provider', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, provider: '' } }],
    ['a missing provider', { ref: FAMILY, revision: REVISION, draft: { overlay: {}, avatars: [] } }],
    ['a field a draft does not hold', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, name: 'Planets' } }],
    ['faces, which a family no longer names: its first avatar is its fallback', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, defaultFaces: { codex: 'Sun' } } }],
    ['the providers whose starting family it is, which the editor does not edit', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, defaultFor: ['codex'] } }],
    ['an avatar entry with a path', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, avatars: [{ folder: 'Sun', matches: [], overlay: {}, path: 'C:\\x' }] } }],
    ['a match that is no key or pattern', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, avatars: [{ folder: 'Sun', matches: ['gpt 6'], overlay: {} }] } }],
    ['a style value out of its bounds', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, overlay: { effort: { size: 40 } } } }],
    ['a colour that is not hex', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, overlay: { version: { textColor: 'red' } } } }],
    ['an empty folder name', { ref: FAMILY, revision: REVISION, draft: { ...DRAFT, avatars: [{ folder: '', matches: [], overlay: {} }] } }],
  ])('refuses %s', async (_name, request) => {
    const h = setup();
    await expect(h.call('avatars:saveFamily', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.service.saveFamily).not.toHaveBeenCalled();
  });

  it.each(['avatars:family', 'avatars:saveFamily'] as const)('%s is refused to the Pet', async (channel) => {
    const h = setup();
    const request = channel === 'avatars:family' ? FAMILY : { ref: FAMILY, revision: REVISION, draft: DRAFT };
    await expect(h.call(channel, request, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.openFamily).not.toHaveBeenCalled();
    expect(h.service.saveFamily).not.toHaveBeenCalled();
  });
});

describe('avatars:copyFamily', () => {
  const source = { origin: 'built-in', family: 'Planets' };
  it('accepts only a family reference from Main, with no destination supplied by the renderer', async () => {
    const h = setup();
    await expect(h.call('avatars:copyFamily', source)).resolves.toEqual({ ok: true, value: { kind: 'copied', ref: FAMILY, listing: LISTING } });
    expect(h.service.copyFamily).toHaveBeenCalledExactlyOnceWith(source);
    for (const request of [null, { ...source, destination: 'C:\\elsewhere' }, { ...source, path: '../elsewhere' }, { ...source, family: '' }]) {
      await expect(h.call('avatars:copyFamily', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    }
    await expect(h.call('avatars:copyFamily', source, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.copyFamily).toHaveBeenCalledOnce();
  });
});

describe('avatars:addAvatar (decision 0036)', () => {
  const ADD = { ref: FAMILY, revision: REVISION, name: 'Moon', matches: ['*-luna*', { provider: 'codex', key: 'gpt-6-luna' }], portrait: new Uint8Array([1, 2]), small: new Uint8Array([3]) };

  it('hands main the family, the revision, the name, the matches and both images, and answers what the add answered', async () => {
    const h = setup();
    await expect(h.call('avatars:addAvatar', ADD)).resolves.toEqual({ ok: true, value: { kind: 'added', folder: 'Moon', source: SOURCE, listing: LISTING } });
    expect(h.service.addAvatar).toHaveBeenCalledExactlyOnceWith(ADD);
    await expect(h.call('avatars:addAvatar', { ...ADD, revision: null })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ['a path beside the request', { ...ADD, path: 'C:\\art\\Moon' }],
    ['a name with a separator', { ...ADD, name: 'Moon/Phobos' }],
    ['a name that climbs out', { ...ADD, name: '..' }],
    ['the family default', { ...ADD, name: 'default' }],
    ['a device name', { ...ADD, name: 'CON' }],
    ['an empty name', { ...ADD, name: '' }],
    ['a match that is no key or pattern', { ...ADD, matches: ['gpt 6'] }],
    ['a revision of another form', { ...ADD, revision: 'abc' }],
    ['images that are not bytes', { ...ADD, portrait: [1, 2] }],
    ['an empty image', { ...ADD, small: new Uint8Array(0) }],
    ['an image past the one bound', { ...ADD, portrait: new Uint8Array(MAX_IMAGE_BYTES + 1) }],
  ])('refuses %s', async (_name, request) => {
    const h = setup();
    await expect(h.call('avatars:addAvatar', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.service.addAvatar).not.toHaveBeenCalled();
  });

  it('is refused to the mini window', async () => {
    const h = setup();
    await expect(h.call('avatars:addAvatar', ADD, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.addAvatar).not.toHaveBeenCalled();
  });

  it('has both images measured by the preload, each as its own view', () => {
    const fields = BYTE_FIELDS['avatars:addAvatar'] ?? [];
    expect(fields).toEqual(['portrait', 'small']);
    expect(bytesWithin(ADD, fields)).toBe(true);
    expect(bytesWithin({ ...ADD, small: new Uint8Array(MAX_STAGE_BYTES + 1) }, fields)).toBe(false);
    expect(bytesWithin({ ...ADD, portrait: undefined }, fields)).toBe(false);
    expect(bytesWithin({ ...ADD, portrait: new Uint8Array(new ArrayBuffer(MAX_STAGE_BYTES * 2), 0, 10) }, fields)).toBe(true);
  });
});

describe('an avatar’s image replaced, and Browse (decision 0036)', () => {
  const REPLACE = { ref: FAMILY, avatar: 'Sun', portrait: new Uint8Array([1, 2]), small: new Uint8Array([3]) };

  it('hands main the avatar and its images, a small alone too, and answers what the replace answered', async () => {
    const h = setup();
    await expect(h.call('avatars:replaceImage', REPLACE)).resolves.toEqual({ ok: true, value: { kind: 'replaced', listing: LISTING } });
    await expect(h.call('avatars:replaceImage', { ...REPLACE, portrait: null })).resolves.toMatchObject({ ok: true });
    expect(h.service.replaceImage).toHaveBeenNthCalledWith(1, REPLACE);
    expect(h.service.replaceImage).toHaveBeenNthCalledWith(2, { ...REPLACE, portrait: null });
  });

  it.each([
    ['a path beside the request', { ...REPLACE, path: 'C:\\art\\Sun' }],
    ['no small', { ...REPLACE, small: null }],
    ['an empty avatar name', { ...REPLACE, avatar: '' }],
    ['an image past the one bound', { ...REPLACE, portrait: new Uint8Array(MAX_IMAGE_BYTES + 1) }],
    ['images that are not bytes', { ...REPLACE, small: [3] }],
  ])('refuses %s', async (_name, request) => {
    const h = setup();
    await expect(h.call('avatars:replaceImage', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.service.replaceImage).not.toHaveBeenCalled();
  });

  it('answers Browse with the image’s name and bytes, and takes nothing but null', async () => {
    const h = setup();
    await expect(h.call('avatars:chooseImage', null)).resolves.toEqual({ ok: true, value: { kind: 'chosen', name: 'sun.png', bytes: new Uint8Array([1]) } });
    await expect(h.call('avatars:chooseImage', { folder: 'C:\\Pictures' })).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.images.choose).toHaveBeenCalledOnce();
  });

  it('remembers the folder of a dropped file’s path, as the preload tells it', async () => {
    const h = setup();
    await expect(h.call('avatars:noteDropped', { path: 'C:\\Pictures\\sun.png' })).resolves.toEqual({ ok: true, value: null });
    expect(h.images.noteDropped).toHaveBeenCalledExactlyOnceWith('C:\\Pictures\\sun.png');
    for (const request of [null, { path: '' }, { path: 'x'.repeat(5000) }, { path: 'C:\\a.png', name: 'a' }]) {
      await expect(h.call('avatars:noteDropped', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    }
  });

  it.each(['avatars:replaceImage', 'avatars:chooseImage', 'avatars:noteDropped'] as const)('%s is refused to the mini window', async (channel) => {
    const h = setup();
    const request = channel === 'avatars:replaceImage' ? REPLACE : channel === 'avatars:chooseImage' ? null : { path: 'C:\\Pictures\\sun.png' };
    await expect(h.call(channel, request, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.replaceImage).not.toHaveBeenCalled();
    expect(h.images.choose).not.toHaveBeenCalled();
    expect(h.images.noteDropped).not.toHaveBeenCalled();
  });

  it('has a replaced main image measured when it comes, and a small always', () => {
    const fields = BYTE_FIELDS['avatars:replaceImage'] ?? [];
    expect(fields.map(byteField)).toEqual(['portrait', 'small']);
    expect(bytesWithin(REPLACE, fields)).toBe(true);
    expect(bytesWithin({ ...REPLACE, portrait: null }, fields)).toBe(true);
    expect(bytesWithin({ ...REPLACE, small: null }, fields)).toBe(false);
    expect(bytesWithin({ ...REPLACE, portrait: new Uint8Array(MAX_STAGE_BYTES + 1) }, fields)).toBe(false);
  });

  it('is a channel the page may not name: the preload alone tells a dropped file’s path', () => {
    expect(PRELOAD_ONLY_CHANNELS.has('avatars:noteDropped')).toBe(true);
    expect(PRELOAD_ONLY_CHANNELS.has('avatars:chooseImage')).toBe(false);
  });
});

describe('avatars:openFamilyFolder', () => {
  it('waits for the catalog, then opens only the folder checked by the avatar service', async () => {
    const h = setup();
    const answer = h.call('avatars:openFamilyFolder', FAMILY);
    expect(h.openFolder).not.toHaveBeenCalled();
    h.settle();
    await expect(answer).resolves.toEqual({ ok: true, value: null });
    expect(h.service.familyFolder).toHaveBeenCalledExactlyOnceWith(FAMILY);
    expect(h.openFolder).toHaveBeenCalledExactlyOnceWith('/avatars/Planets');
  });

  it('refuses paths, unknown origins and the mini window before consulting the service', async () => {
    const h = setup();
    for (const request of [null, { ...FAMILY, path: '/elsewhere' }, { origin: 'elsewhere', family: 'Planets' }]) {
      await expect(h.call('avatars:openFamilyFolder', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    }
    await expect(h.call('avatars:openFamilyFolder', FAMILY, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.familyFolder).not.toHaveBeenCalled();
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it('does not open an unavailable family, and keeps file-manager errors out of the reply', async () => {
    const h = setup();
    const missing = h.call('avatars:openFamilyFolder', { ...FAMILY, family: 'Gone' });
    h.settle();
    await expect(missing).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.openFolder).not.toHaveBeenCalled();
    h.openFolder.mockResolvedValue('Private path: /avatars/Planets');
    const failed = h.call('avatars:openFamilyFolder', FAMILY);
    h.settle();
    await expect(failed).resolves.toEqual({ ok: false, error: 'internal' });
    h.openFolder.mockRejectedValue(new Error('Private path: /avatars/Planets'));
    const rejected = h.call('avatars:openFamilyFolder', FAMILY);
    h.settle();
    await expect(rejected).resolves.toEqual({ ok: false, error: 'internal' });
  });
});


describe('avatars:createFamily', () => {
  const CREATE = { name: 'Planets', avatar: null, portrait: new Uint8Array([1, 2]), small: new Uint8Array([3]) };
  it('passes prepared images and names to the service, from Main alone', async () => {
    const h = setup();
    await expect(h.call('avatars:createFamily', CREATE)).resolves.toEqual({ ok: true, value: { kind: 'created', ref: FAMILY, listing: LISTING } });
    expect(h.service.createFamily).toHaveBeenCalledExactlyOnceWith(CREATE);
    await expect(h.call('avatars:createFamily', CREATE, 'pet')).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.service.createFamily).toHaveBeenCalledOnce();
  });
  it.each([
    { ...CREATE, name: '../escape' },
    { ...CREATE, name: 'NUL' },
    { ...CREATE, path: '/elsewhere' },
    { ...CREATE, portrait: [] },
    { ...CREATE, small: new Uint8Array(MAX_IMAGE_BYTES + 1) },
    { ...CREATE, avatar: { name: 'Default', matches: ['*'] } },
    { ...CREATE, avatar: { name: 'Sun', matches: [] } },
    { ...CREATE, avatar: { name: 'Sun', matches: ['not a pattern'] } },
  ])('refuses malformed requests', async (request) => {
    const h = setup();
    await expect(h.call('avatars:createFamily', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.service.createFamily).not.toHaveBeenCalled();
  });
  it('bounds both PNGs in the preload', () => {
    const fields = BYTE_FIELDS['avatars:createFamily'] ?? [];
    expect(fields).toEqual(['portrait', 'small']);
    expect(bytesWithin(CREATE, fields)).toBe(true);
    expect(bytesWithin({ ...CREATE, small: new Uint8Array(MAX_STAGE_BYTES + 1) }, fields)).toBe(false);
  });
});
