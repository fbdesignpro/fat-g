// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The only filesystem capability in the audio module. Paths are supplied by its service.
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { MAX_AUDIO_BYTES } from '@shared/contracts/audio';

export interface AudioFs {
  directory(folder: string): Promise<boolean>;
  realpath(file: string): Promise<string>;
  names(folder: string): Promise<readonly string[]>;
  read(file: string): Promise<Uint8Array | null>;
  create(folder: string): Promise<void>;
  copyMissing(source: string, target: string): Promise<void>;
}
export const nodeAudioFs: AudioFs = {
  async directory(folder) { const stat = await lstat(folder); return stat.isDirectory() && !stat.isSymbolicLink(); },
  realpath,
  names: (folder) => readdir(folder),
  async read(file) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUDIO_BYTES) return null;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_AUDIO_BYTES) return null;
      const bytes = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
      return count > opened.size ? null : bytes.subarray(0, count);
    } finally { await handle.close(); }
  },
  async create(folder) { await mkdir(folder, { recursive: true }); },
  async copyMissing(source, target) {
    try { await copyFile(source, target, constants.COPYFILE_EXCL); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  },
};
