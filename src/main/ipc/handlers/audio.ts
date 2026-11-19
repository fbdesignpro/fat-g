// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AudioEvent } from '@shared/contracts/audio';
import type { AudioService } from '../../audio/service';
import type { InvokeHandlers } from '../dispatch';

export function audioHandlers(audio: AudioService, cue: (event: AudioEvent) => void): Pick<InvokeHandlers, 'audio:list' | 'audio:rescan' | 'audio:ui'> {
  return {
    'audio:list': () => audio.listing(),
    'audio:rescan': () => audio.scan(),
    'audio:ui': ({ event }) => { cue(event); return null; },
  };
}
