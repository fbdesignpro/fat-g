// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { AUDIO_EVENTS, audioUrl, isNotificationAudio, type AudioEvent } from '@shared/contracts/audio';

export interface SoundElement {
  src: string; volume: number; currentTime: number; preload: string;
  onended: ((event: Event) => void) | null; onerror: ((event: Event) => void) | null;
  play: () => Promise<void>; pause: () => void; load: () => void;
}
interface Voice { readonly element: SoundElement; readonly id: string; event: AudioEvent | 'preview'; active: boolean; order: number }

const MAX_VOICES = 4;
const MAX_ELEMENTS = AUDIO_EVENTS.length + MAX_VOICES;
const priority = (event: AudioEvent | 'preview'): number => event === 'rollover' ? 0 : isNotificationAudio(event) ? 2 : 1;

/** One page owns sound. Idle preloads are bounded by the configurable event registry. */
export function createAudioPlayer(make: () => SoundElement = () => new Audio(), failed: () => void = () => undefined) {
  let voices: Voice[] = [];
  let order = 0;
  const stop = (voice: Voice): void => { voice.active = false; voice.element.pause(); voice.element.currentTime = 0; };
  const create = (id: string): Voice => {
    const element = make();
    element.src = audioUrl(id);
    element.preload = 'auto';
    const voice: Voice = { element, id, event: 'rollover', active: false, order: 0 };
    element.onended = () => { voice.active = false; };
    element.onerror = () => { const active = voice.active; stop(voice); if (active) failed(); };
    voices.push(voice);
    return voice;
  };
  const release = (voice: Voice): void => {
    stop(voice);
    voice.element.onended = null;
    voice.element.onerror = null;
    voice.element.src = '';
    voice.element.load();
  };
  return {
    preload(ids: readonly string[]): void {
      const wanted = new Set(ids.slice(0, AUDIO_EVENTS.length));
      voices = voices.filter((voice) => {
        if (voice.active || wanted.has(voice.id)) return true;
        release(voice);
        return false;
      });
      for (const id of wanted) if (!voices.some((voice) => voice.id === id)) create(id);
    },
    play(id: string, volume: number, event: AudioEvent | 'preview'): void {
      if (!/^[a-f0-9]{64}$/.test(id) || !Number.isFinite(volume) || volume <= 0) return;
      const active = voices.filter((voice) => voice.active).sort((a, b) => a.order - b.order);
      if (active.length >= MAX_VOICES) {
        const victim = active.filter((voice) => priority(voice.event) <= priority(event))
          .sort((a, b) => priority(a.event) - priority(b.event) || a.order - b.order)[0];
        if (victim === undefined) return;
        stop(victim);
      }
      let voice = voices.find((candidate) => candidate.id === id && !candidate.active);
      if (voice === undefined) {
        if (voices.length >= MAX_ELEMENTS) {
          const idle = voices.find((candidate) => !candidate.active);
          if (idle !== undefined) { release(idle); voices = voices.filter((candidate) => candidate !== idle); }
        }
        voice = create(id);
      }
      voice.event = event;
      voice.order = ++order;
      const generation = voice.order;
      voice.element.volume = Math.min(1, volume);
      voice.element.currentTime = 0;
      voice.active = true;
      const own = voice;
      void voice.element.play().catch(() => {
        if (own.order !== generation || !own.active) return;
        stop(own);
        failed();
      });
    },
    volume(volume: number): void { for (const voice of voices) voice.element.volume = volume; },
    stop(): void { for (const voice of voices) stop(voice); },
    dispose(): void { for (const voice of voices) release(voice); voices = []; },
  };
}
