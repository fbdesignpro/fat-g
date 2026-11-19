// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOUNDS, type AudioFile } from '@shared/contracts/audio';
import { AUDIO_DECODE_PROBE, type AudioDecodeResult } from './smoke-audio';

const defaults = [...new Set(Object.values(DEFAULT_SOUNDS).filter((filename) => filename !== null))];
const files = defaults.map((filename, index) => ({ filename, id: index.toString(16).repeat(64) }));

class Sound {
  src = '';
  muted = false;
  preload = '';
  duration = Infinity;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn(() => { this.src = ''; });
  end(duration = 3.111625): void { this.duration = duration; this.onended?.(); }
}

async function probe(catalog: readonly AudioFile[] = files, options: { unavailable?: boolean; refused?: boolean; rejectPlay?: boolean } = {}) {
  const sounds: Sound[] = [];
  class Audio extends Sound {
    constructor() {
      super();
      if (options.rejectPlay) this.play.mockRejectedValue(new Error('blocked'));
      sounds.push(this);
    }
  }
  const result = runInNewContext(AUDIO_DECODE_PROBE, {
    window: { fatg: { invoke: () => Promise.resolve(options.refused ? { ok: false } : { ok: true, value: { files: catalog, unavailable: options.unavailable } }) } },
    Audio, setTimeout, clearTimeout,
  }) as Promise<AudioDecodeResult>;
  await vi.advanceTimersByTimeAsync(0);
  return { result, sounds };
}

function expectReleased(sounds: readonly Sound[]) {
  for (const sound of sounds) {
    expect(sound.pause).toHaveBeenCalledOnce();
    expect(sound.removeAttribute).toHaveBeenCalledWith('src');
    expect(sound.load).toHaveBeenCalledOnce();
    expect(sound.onended).toBeNull();
    expect(sound.onerror).toBeNull();
  }
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the Chromium audio smoke probe', () => {
  it('waits for muted playback to finish when metadata duration is initially infinite', async () => {
    const { result, sounds } = await probe([...files, { filename: 'retained-old.wav', id: 'f'.repeat(64) }]);
    expect(sounds).toHaveLength(defaults.length);
    let finished = false;
    void result.then(() => { finished = true; });
    for (const sound of sounds) {
      expect(sound.muted).toBe(true);
      expect(sound.preload).toBe('auto');
      expect(sound.src).toMatch(/^app:\/\/media\/audio\//);
      expect(sound.play).toHaveBeenCalledOnce();
    }
    await Promise.resolve();
    expect(finished).toBe(false);
    for (const sound of sounds) sound.end();
    expect(await result).toEqual({ count: defaults.length, decoded: true, missing: [], failed: [] });
    expectReleased(sounds);
  });

  it('identifies missing defaults even when an unrelated catalog entry keeps the total count unchanged', async () => {
    const { result, sounds } = await probe([...files.slice(1), { filename: 'private-user-sound.wav', id: 'f'.repeat(64) }]);
    for (const sound of sounds) sound.end();
    const found = await result;
    expect(found).toEqual({ count: defaults.length - 1, decoded: false, missing: [defaults[0]], failed: [] });
    expect(JSON.stringify(found)).not.toContain('private-user-sound');
    expectReleased(sounds);
  });

  it('reports decode errors by bundled filename and releases each element once', async () => {
    const { result, sounds } = await probe();
    const failed = sounds[0]!;
    const error = failed.onerror;
    error?.();
    error?.();
    for (const sound of sounds.slice(1)) sound.end();
    expect(await result).toMatchObject({ decoded: false, failed: [{ filename: defaults[0], reason: 'error' }] });
    expectReleased(sounds);
  });

  it('reports rejected playback instead of leaving elements pending', async () => {
    const { result, sounds } = await probe(files, { rejectPlay: true });
    expect((await result).failed).toEqual(defaults.map((filename) => ({ filename, reason: 'play' })));
    expectReleased(sounds);
  });

  it('times out and releases sounds whose metadata loaded but playback never ended', async () => {
    const { result, sounds } = await probe();
    for (const sound of sounds) sound.duration = 1;
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result).failed).toEqual(defaults.map((filename) => ({ filename, reason: 'timeout' })));
    expectReleased(sounds);
  });

  it('still rejects an invalid final duration', async () => {
    const { result, sounds } = await probe();
    for (const sound of sounds) sound.end(0);
    expect((await result).failed).toEqual(defaults.map((filename) => ({ filename, reason: 'duration' })));
    expectReleased(sounds);
  });

  it.each([{ unavailable: true }, { refused: true }])('reports missing defaults when the catalog cannot be read: %j', async (options) => {
    const { result, sounds } = await probe(files, options);
    expect(await result).toEqual({ count: 0, decoded: false, missing: defaults, failed: [] });
    expect(sounds).toHaveLength(0);
  });
});
