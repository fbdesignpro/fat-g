// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { DEFAULT_SOUNDS } from '@shared/contracts/audio';

export interface AudioDecodeResult {
  readonly count: number;
  readonly decoded: boolean;
  readonly missing: readonly string[];
  readonly failed: readonly { readonly filename: string; readonly reason: 'error' | 'play' | 'duration' | 'timeout' }[];
}

/** Runs in Chromium, only in smoke builds. Diagnostics name bundled defaults alone. */
export const AUDIO_DECODE_PROBE = `(async () => {
  const defaults = ${JSON.stringify([...new Set(Object.values(DEFAULT_SOUNDS).filter((filename) => filename !== null))])};
  const listing = await window.fatg.invoke('audio:list', null);
  const files = listing.ok && !listing.value.unavailable ? listing.value.files : [];
  const missing = defaults.filter((filename) => !files.some((file) => file.filename === filename));
  // Smoke data survives runs; retained old defaults and added sounds are legitimate catalog entries.
  const selected = files.filter((file) => defaults.includes(file.filename));
  const results = await Promise.all(selected.map((file) => new Promise((resolve) => {
    const sound = new Audio();
    sound.muted = true;
    sound.preload = 'auto';
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sound.onended = null;
      sound.onerror = null;
      sound.pause();
      sound.removeAttribute('src');
      sound.load();
      resolve({ filename: file.filename, reason });
    };
    const timer = setTimeout(() => finish('timeout'), 10000);
    // The local streaming route may report Infinity at loadedmetadata (the imported Ready WAV
    // does). Completed playback proves decoding; its duration is final only once the stream ends.
    sound.onended = () => finish(Number.isFinite(sound.duration) && sound.duration > 0 ? null : 'duration');
    sound.onerror = () => finish('error');
    sound.src = 'app://media/audio/' + file.id;
    void sound.play().catch(() => finish('play'));
  })));
  const failed = results.filter((result) => result.reason !== null);
  return { count: selected.length, decoded: missing.length === 0 && failed.length === 0, missing, failed };
})()`;
