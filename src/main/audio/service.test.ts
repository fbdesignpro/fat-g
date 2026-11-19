// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile, unlink, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SOUNDS, MAX_AUDIO_BYTES } from '@shared/contracts/audio';
import { nodeAudioFs } from './fs';
import { audioType, createAudioService } from './service';

let dir: string;
const defaults = path.resolve('assets/audio');
const defaultFiles = Object.values(DEFAULT_SOUNDS).filter((filename) => filename !== null);
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'fatg-audio-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function service(root = path.join(dir, 'audio')) { return createAudioService({ root, defaults, fs: nodeAudioFs }); }

describe('the local audio folder', () => {
  it('copies enabled defaults once and never replaces a changed or invalid file', async () => {
    const audio = service();
    await audio.initialize();
    expect(audio.listing().files.map((file) => file.filename).sort()).toEqual([...defaultFiles].sort());
    const file = path.join(dir, 'audio', 'button.wav');
    await writeFile(file, 'my edited file');
    await audio.initialize();
    expect(await readFile(file, 'utf8')).toBe('my edited file');
    expect(audio.listing().problems).toBe(1);
    await unlink(file);
    await audio.initialize();
    expect(audio.idFor('button.wav')).not.toBeNull();
  });
  it('rescans additions, edits and removals; old media ids never serve changed bytes', async () => {
    const audio = service(); await audio.initialize();
    const original = audio.idFor('button.wav') ?? '';
    expect((await audio.source.serve(original)).status).toBe(200);
    await writeFile(path.join(dir, 'audio', 'button.wav'), await readFile(path.join(defaults, 'done.wav')));
    expect(await audio.source.serve(original)).toEqual({ status: 404, kind: 'changed' });
    await writeFile(path.join(dir, 'audio', 'mine.wav'), await readFile(path.join(defaults, 'done.wav')));
    await audio.scan();
    expect(audio.idFor('button.wav')).not.toBe(original);
    expect(audio.idFor('mine.wav')).not.toBeNull();
    await unlink(path.join(dir, 'audio', 'mine.wav')); await audio.scan();
    expect(audio.idFor('mine.wav')).toBeNull();
    expect(await audio.source.serve('../button.wav')).toEqual({ status: 404, kind: 'id' });
    expect(audio.source.cache).toBe('no-store');
  });
  it('rejects large files, invalid signatures, folders and nested files', async () => {
    const audio = service(); await audio.initialize();
    await writeFile(path.join(dir, 'audio', 'large.wav'), Buffer.alloc(MAX_AUDIO_BYTES + 1));
    await writeFile(path.join(dir, 'audio', 'fake.mp3'), 'ID3 not audio');
    await mkdir(path.join(dir, 'audio', 'nested.wav'));
    await writeFile(path.join(dir, 'audio', 'nested.wav', 'inside.wav'), await readFile(path.join(defaults, 'button.wav')));
    await audio.scan();
    expect(audio.listing().problems).toBe(3);
    expect(audio.listing().files).toHaveLength(defaultFiles.length);
  });
  it('does not seed, scan or open a root replaced by a junction', async () => {
    const outside = path.join(dir, 'outside'); await mkdir(outside);
    await writeFile(path.join(outside, 'button.wav'), 'untouched');
    const root = path.join(dir, 'linked');
    await symlink(outside, root, 'junction');
    const audio = service(root); await audio.initialize();
    expect(audio.listing().unavailable).toBe(true);
    await expect(audio.folder()).rejects.toThrow();
    expect(await readFile(path.join(outside, 'button.wav'), 'utf8')).toBe('untouched');
  });
  it('refuses a nested junction and survives a missing folder', async () => {
    const audio = service(); await audio.initialize();
    const outside = path.join(dir, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(dir, 'audio', 'linked.wav'), 'junction');
    await audio.scan(); expect(audio.listing().problems).toBe(1);
    await rm(path.join(dir, 'audio'), { recursive: true });
    await audio.scan(); expect(audio.listing().unavailable).toBe(true);
    expect(audio.idFor('button.wav')).toBeNull();
  });
  it('recognizes the supported codec signatures', async () => {
    expect(audioType(await readFile(path.join(defaults, 'button.wav')))).toBe('audio/wav');
    expect(audioType(await readFile(path.join(defaults, 'Launch-1.mp3')))).toBe('audio/mpeg');
    expect(audioType(Uint8Array.of(255, 251, 144, 0))).toBe('audio/mpeg');
    const ogg = Buffer.alloc(48); ogg.write('OggS'); ogg[26] = 1; ogg[27] = 16; ogg.write('OpusHead', 28);
    expect(audioType(ogg)).toBe('audio/ogg');
    expect(audioType(Buffer.from('ID3'))).toBeNull();
  });
});
