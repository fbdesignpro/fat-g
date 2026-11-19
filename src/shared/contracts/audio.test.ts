// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { AudioFilenameSchema, DEFAULT_SOUNDS, NOTIFICATION_AUDIO_EVENTS } from './audio';
import { applyPatch, defaultPreferences, PreferencesPatchSchema } from './prefs';
import { INVOKE_SPECS } from '../ipc/contract';

describe('audio preferences and IPC boundaries', () => {
  it('patches individual events without resetting neighbours', () => {
    expect(DEFAULT_SOUNDS.rollover).toBeNull();
    expect(DEFAULT_SOUNDS.click).toBe('button.wav');
    expect(DEFAULT_SOUNDS.turnStart).toBe('Launch-1.mp3');
    expect(DEFAULT_SOUNDS.turnFinished).toBe('notification-done.wav');
    expect(DEFAULT_SOUNDS.shelve).toBe('BagOpen.mp3');
    expect(DEFAULT_SOUNDS.restore).toBe('BagClose.mp3');
    const values = applyPatch(defaultPreferences(), { audio: { sounds: { click: null, done: 'custom.mp3' } } });
    expect(values.audio.sounds).toEqual({ ...DEFAULT_SOUNDS, click: null, done: 'custom.mp3' });
    expect(values.audio.volume).toBe(0.1);
  });
  it.each(['../secret.wav', 'C:\\account\\click.wav', '.hidden.wav', 'a/b.ogg', 'CON.wav', 'sound.txt', 'sound.wav '])('refuses filenames that are not local audio names: %s', (filename) => {
    expect(AudioFilenameSchema.safeParse(filename).success).toBe(false);
    expect(PreferencesPatchSchema.safeParse({ audio: { sounds: { click: filename } } }).success).toBe(false);
  });
  it('limits mini-window requests to UI events and gives it no catalog permission', () => {
    expect(INVOKE_SPECS['audio:ui'].from).toEqual(['main', 'pet']);
    for (const event of ['done', ...NOTIFICATION_AUDIO_EVENTS]) expect(INVOKE_SPECS['audio:ui'].request.safeParse({ event }).success).toBe(false);
    expect(INVOKE_SPECS['audio:ui'].request.safeParse({ event: 'click', path: '/private.wav' }).success).toBe(false);
    expect(INVOKE_SPECS['audio:list'].from).toEqual(['main']);
    expect(INVOKE_SPECS['audio:rescan'].from).toEqual(['main']);
  });
});
