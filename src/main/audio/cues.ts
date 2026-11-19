// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AudioEvent, AudioPlay } from '@shared/contracts/audio';
import type { PreferencesSnapshot } from '@shared/contracts/prefs';

/** Selection and mute are resolved in main for UI requests from either window alike. */
export function createAudioCues(options: {
  readonly prefs: () => PreferencesSnapshot;
  readonly idFor: (filename: string) => string | null;
  readonly push: (play: AudioPlay) => void;
  readonly now?: () => number;
}): (event: AudioEvent) => void {
  let lastRollover = -Infinity;
  return (event) => {
    const { values, status } = options.prefs();
    if (status.kind !== 'ok' || values.audio.muted || values.audio.volume === 0) return;
    const filename = values.audio.sounds[event];
    if (filename === null) return;
    const id = options.idFor(filename);
    if (id === null) return;
    if (event === 'rollover') {
      const now = (options.now ?? Date.now)();
      if (now - lastRollover < 100) return;
      lastRollover = now;
    }
    options.push({ event, id, volume: values.audio.volume });
  };
}
