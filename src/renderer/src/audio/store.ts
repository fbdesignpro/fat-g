// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { create } from 'zustand';
import type { AudioListing } from '@shared/contracts/audio';
import { invoke, subscribe } from '../ipc/client';
import { usePrefs } from '../state/prefs-store';
import { createAudioPlayer } from './player';

export const useAudio = create<{ listing: AudioListing | null; problem: string | null }>()(() => ({ listing: null, problem: null }));
const player = createAudioPlayer(undefined, () => useAudio.setState({ problem: 'This sound could not be played. Try another audio file.' }));

export async function readAudio(rescan = false): Promise<void> {
  try {
    const listing = await invoke(rescan ? 'audio:rescan' : 'audio:list', null);
    useAudio.setState({ listing, problem: null });
    preload();
  } catch { useAudio.setState({ problem: 'The audio folder could not be read.' }); }
}
function preload(): void {
  const snapshot = usePrefs.getState().snapshot;
  const listing = useAudio.getState().listing;
  if (snapshot?.status.kind !== 'ok' || snapshot.values.audio.muted || snapshot.values.audio.volume === 0) {
    player.stop();
    player.preload([]);
    return;
  }
  const selected = new Set(Object.values(snapshot.values.audio.sounds));
  player.preload(listing?.files.filter((file) => selected.has(file.filename)).map((file) => file.id) ?? []);
  player.volume(snapshot.values.audio.volume);
}
export function previewAudio(id: string): void {
  const snapshot = usePrefs.getState().snapshot;
  if (snapshot?.status.kind !== 'ok' || snapshot.values.audio.muted) return;
  useAudio.setState({ problem: null });
  player.play(id, snapshot.values.audio.volume, 'preview');
}

/** Installed once outside React StrictMode. No snapshot comparison can manufacture a cue. */
export function connectAudio(): () => void {
  const unsubscribe = subscribe('audio:play', (play) => {
    const snapshot = usePrefs.getState().snapshot;
    if (snapshot?.status.kind !== 'ok' || snapshot.values.audio.muted || snapshot.values.audio.sounds[play.event] === null) return;
    player.play(play.id, snapshot.values.audio.volume, play.event);
  });
  const prefs = usePrefs.subscribe(preload);
  void readAudio();
  return () => { unsubscribe(); prefs(); player.dispose(); };
}
