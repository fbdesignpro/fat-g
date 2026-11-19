// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SOUNDS, MAX_AUDIO_BYTES } from '../../src/shared/contracts/audio';
import { audioType } from '../../src/main/audio/service';

describe('the shipped default sound effects', () => {
  const root = path.resolve('assets/audio');
  const files = [...new Set(Object.values(DEFAULT_SOUNDS).filter((filename) => filename !== null))];
  const imported = new Set(['button.wav', 'notification-done.wav', 'Launch-1.mp3', 'BagOpen.mp3', 'BagClose.mp3']);
  it('contains every enabled default and its notices, with no unused files', () => {
    expect(readdirSync(root).sort()).toEqual([...files, 'LICENSE.txt'].sort());
    expect(readFileSync(path.join(root, 'LICENSE.txt'), 'utf8')).toContain(readFileSync('LICENSE', 'utf8'));
  });
  it('admits every shipped WAV and MP3 within the local media bounds', () => {
    for (const filename of files) {
      const bytes = readFileSync(path.join(root, filename));
      expect(bytes.length).toBeLessThanOrEqual(MAX_AUDIO_BYTES);
      expect(audioType(bytes)).toBe(filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
    }
  });
  it('keeps the generated originals short, quiet mono PCM with valid WAV sizes', () => {
    for (const filename of files.filter((name) => !imported.has(name))) {
      const bytes = readFileSync(path.join(root, filename));
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ');
      expect(bytes.readUInt16LE(20)).toBe(1);
      expect(bytes.readUInt16LE(22)).toBe(1);
      expect(bytes.readUInt32LE(24)).toBe(44100);
      expect(bytes.readUInt16LE(34)).toBe(16);
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44);
      expect((bytes.length - 44) / 88200).toBeLessThan(0.5);
      let peak = 0;
      for (let at = 44; at < bytes.length; at += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(at)) / 32767);
      expect(peak).toBeGreaterThan(0.01); expect(peak).toBeLessThan(0.14);
    }
  });
});
