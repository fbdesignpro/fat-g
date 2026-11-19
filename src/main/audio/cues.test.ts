// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { defaultPreferences, type PreferencesSnapshot } from '@shared/contracts/prefs';
import { AUDIO_EVENTS } from '@shared/contracts/audio';
import { createAudioCues } from './cues';

describe('audio cue admission', () => {
  it('resolves all configured events, throttles rollover, and respects Off, missing, mute and refused preferences', () => {
    let now = 0;
    const snapshot: PreferencesSnapshot = { rev: 0, values: defaultPreferences(), status: { kind: 'ok' }, instances: {}, providerIssues: {} };
    const push = vi.fn();
    const cue = createAudioCues({ prefs: () => snapshot, idFor: (filename) => filename === 'missing.wav' ? null : 'a'.repeat(64), push, now: () => now });
    for (const event of AUDIO_EVENTS) cue(event);
    expect(push.mock.calls.map(([play]) => (play as { event: string }).event)).toEqual(AUDIO_EVENTS.filter((event) => event !== 'rollover'));
    snapshot.values.audio.sounds.rollover = 'button.wav';
    cue('rollover'); cue('rollover'); expect(push).toHaveBeenCalledTimes(AUDIO_EVENTS.length);
    now = 101; cue('rollover'); expect(push).toHaveBeenCalledTimes(AUDIO_EVENTS.length + 1);
    snapshot.values.audio.sounds.click = null; cue('click');
    snapshot.values.audio.sounds.done = 'missing.wav'; cue('done');
    snapshot.values.audio.muted = true; cue('turnFinished');
    snapshot.values.audio.muted = false; snapshot.values.audio.volume = 0; cue('restore');
    expect(push).toHaveBeenCalledTimes(AUDIO_EVENTS.length + 1);
    snapshot.values.audio.volume = 0.6;
    const refused = { ...snapshot, status: { kind: 'read-only', reason: 'corrupt' } } as PreferencesSnapshot;
    createAudioCues({ prefs: () => refused, idFor: () => 'a'.repeat(64), push })('restore');
    expect(push).toHaveBeenCalledTimes(AUDIO_EVENTS.length + 1);
  });
});
