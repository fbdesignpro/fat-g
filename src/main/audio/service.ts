// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import path from 'node:path';
import { AudioFilenameSchema, DEFAULT_SOUNDS, type AudioListing, MAX_AUDIO_BYTES } from '@shared/contracts/audio';
import type { MediaSource, SourceAnswer } from '../media/route';
import type { AudioFs } from './fs';

/** Signatures alone admit a candidate; Chromium's decoder still checks the audio itself. */
export function audioType(bytes: Uint8Array): string | null {
  const text = (start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 44 && text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 36 && text(0, 4) === 'OggS') {
    const payload = 27 + (bytes[26] ?? 0);
    if (text(payload, 8) === 'OpusHead' || text(payload, 7) === '\u0001vorbis') return 'audio/ogg';
  }
  let offset = 0;
  if (bytes.length >= 10 && text(0, 3) === 'ID3') {
    const size = [...bytes.subarray(6, 10)];
    if (size.some((n) => n > 127)) return null;
    offset = 10 + size.reduce((n, part) => n * 128 + part, 0) + (((bytes[5] ?? 0) & 16) ? 10 : 0);
  }
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  const third = bytes[offset + 2] ?? 0;
  if (offset + 4 <= bytes.length && first === 255 && (second & 224) === 224 && (second & 6) !== 0 && (second & 24) !== 8
    && (third & 240) !== 0 && (third & 240) !== 240 && (third & 12) !== 12) return 'audio/mpeg';
  return null;
}
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
interface HeldFile { readonly filename: string; readonly id: string; readonly contentType: string }

export interface AudioService {
  initialize(): Promise<void>;
  scan(): Promise<AudioListing>;
  listing(): AudioListing;
  idFor(filename: string): string | null;
  readonly source: MediaSource;
  /** Checks the root again before the file manager opens it. */
  folder(): Promise<string>;
}

/** Local files only, injected I/O, no Electron and no provider knowledge. */
export function createAudioService({ root, defaults, fs }: { root: string; defaults: string; fs: AudioFs }): AudioService {
  let realRoot: string | null = null;
  let listing: AudioListing = { files: [], problems: 0, unavailable: true };
  let held = new Map<string, HeldFile>();
  let pending = Promise.resolve();
  async function checkedRoot(): Promise<string> {
    if (!await fs.directory(root)) throw new Error('audio folder unavailable');
    const real = await fs.realpath(root);
    if (realRoot !== null && real !== realRoot) throw new Error('audio folder changed');
    realRoot = real;
    return real;
  }
  async function read(filename: string): Promise<Uint8Array | null> {
    const real = await checkedRoot();
    const file = path.join(root, filename);
    const relative = path.relative(real, await fs.realpath(file));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return fs.read(file);
  }
  async function scan(): Promise<void> {
    try {
      await checkedRoot();
      const files: HeldFile[] = [];
      let problems = 0;
      for (const filename of [...await fs.names(root)].sort()) {
        if (!AudioFilenameSchema.safeParse(filename).success) continue;
        try {
          const bytes = await read(filename);
          const contentType = bytes === null ? null : audioType(bytes);
          if (bytes === null || bytes.length > MAX_AUDIO_BYTES || contentType === null) { problems++; continue; }
          files.push({ filename, id: hash(bytes), contentType });
        } catch { problems++; }
      }
      held = new Map(files.map((file) => [file.filename, file]));
      listing = { files: files.map(({ filename, id }) => ({ filename, id })), problems, unavailable: false };
    } catch {
      held.clear();
      listing = { files: [], problems: 0, unavailable: true };
    }
  }
  const service: AudioService = {
    async initialize() {
      try {
        await fs.create(root);
        await checkedRoot();
        for (const filename of [...Object.values(DEFAULT_SOUNDS), 'LICENSE.txt']) {
          if (filename === null) continue;
          await checkedRoot();
          await fs.copyMissing(path.join(defaults, filename), path.join(root, filename));
        }
      } catch { /* The listing reports failure; sound setup never blocks the application. */ }
      await service.scan();
    },
    async scan() {
      pending = pending.then(scan, scan);
      await pending;
      return listing;
    },
    listing: () => listing,
    idFor: (filename) => held.get(filename)?.id ?? null,
    async folder() { await checkedRoot(); return root; },
    source: {
      name: 'audio', cache: 'no-store',
      async serve(id): Promise<SourceAnswer> {
        const files = [...held.values()].filter((entry) => entry.id === id);
        if (files.length === 0) return { status: 404, kind: 'id' };
        for (const file of files) {
          try {
            const bytes = await read(file.filename);
            if (bytes === null || hash(bytes) !== id || audioType(bytes) !== file.contentType) continue;
            return { status: 200, body: bytes, contentType: file.contentType };
          } catch { /* Identical files share an id; another copy may still be available. */ }
        }
        return { status: 404, kind: 'changed' };
      },
    },
  };
  return service;
}
