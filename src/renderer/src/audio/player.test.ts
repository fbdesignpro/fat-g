// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { AUDIO_EVENTS } from '@shared/contracts/audio';
import { describe, expect, it, vi } from 'vitest';
import { createAudioPlayer, type SoundElement } from './player';

function setup() {
  const elements: SoundElement[] = [];
  const failed = vi.fn();
  const player = createAudioPlayer(() => {
    const element: SoundElement = { src: '', volume: 1, currentTime: 0, preload: '', onended: null, onerror: null,
      play: vi.fn(() => Promise.resolve()), pause: vi.fn(), load: vi.fn() };
    elements.push(element); return element;
  }, failed);
  return { player, elements, failed };
}
const id = (n: number): string => n.toString(16).padStart(64, '0');

describe('the single audio player', () => {
  it('preloads and reuses selected elements, updates volume and stops on mute', () => {
    const { player, elements } = setup();
    player.preload([id(1), id(2)]);
    expect(elements).toHaveLength(2);
    player.play(id(1), 0.3, 'click');
    expect(elements[0]?.src).toBe(`app://media/audio/${id(1)}`);
    expect(elements[0]?.play).toHaveBeenCalledOnce();
    expect(elements[0]?.volume).toBe(0.3);
    player.volume(0.2); expect(elements[0]?.volume).toBe(0.2);
    player.stop(); expect(elements[0]?.pause).toHaveBeenCalledOnce();
    player.play(id(1), 0.2, 'done'); expect(elements).toHaveLength(2);
    player.dispose(); expect(elements.every((element) => element.src === '')).toBe(true);
  });
  it('caps simultaneous sounds at four, giving session cues priority over rollover', () => {
    const { player, elements } = setup();
    player.play(id(1), 0.6, 'rollover');
    for (let n = 2; n <= 4; n++) player.play(id(n), 0.6, 'click');
    player.play(id(5), 0.6, 'done');
    expect(elements[0]?.pause).toHaveBeenCalledOnce();
    player.play(id(6), 0.6, 'rollover');
    expect(elements).toHaveLength(5);
    player.stop();
  });
  it('retains a bounded number of elements under a burst of different sounds', () => {
    const { player, elements } = setup();
    player.preload(Array.from({ length: AUDIO_EVENTS.length }, (_, n) => id(n + 1)));
    for (let n = AUDIO_EVENTS.length + 1; n < 40; n++) player.play(id(n), 0.6, 'done');
    expect(elements.filter((element) => element.src !== '')).toHaveLength(AUDIO_EVENTS.length + 4);
  });
  it('handles decoder and play failures without an unhandled rejection', async () => {
    const { player, elements, failed } = setup();
    player.preload([id(1)]);
    const element = elements[0]; if (element === undefined) throw new Error('no element');
    element.play = vi.fn(() => Promise.reject(new Error('decode')));
    player.play(id(1), 0.6, 'preview');
    await Promise.resolve(); expect(failed).toHaveBeenCalledOnce();
    element.play = vi.fn(() => Promise.resolve());
    player.play(id(1), 0.6, 'click'); element.onerror?.(new Event('error'));
    expect(failed).toHaveBeenCalledTimes(2);
  });
  it('never plays arbitrary addresses or zero volume', () => {
    const { player, elements } = setup();
    player.play('https://example.test/audio', 1, 'click'); player.play(id(1), 0, 'click');
    expect(elements).toHaveLength(0);
  });
  it('lets notifications displace UI effects, while UI effects cannot displace notifications', () => {
    const { player, elements } = setup();
    for (let n = 1; n <= 4; n++) player.play(id(n), 0.6, 'question');
    player.play(id(5), 0.6, 'click'); player.play(id(6), 0.6, 'rollover');
    expect(elements).toHaveLength(4);
    player.play(id(7), 0.6, 'error');
    expect(elements[0]?.pause).toHaveBeenCalledOnce();
    player.stop();
    for (let n = 1; n <= 4; n++) player.play(id(n), 0.6, 'click');
    player.play(id(8), 0.6, 'planReady');
    expect(elements[0]?.pause).toHaveBeenCalledTimes(3);
  });
});
