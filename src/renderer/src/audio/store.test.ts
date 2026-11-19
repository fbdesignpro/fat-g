// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { usePrefs } from '../state/prefs-store';
import { connectAudio, useAudio } from './store';

const played = vi.fn(() => Promise.resolve());
const paused = vi.fn();
let disconnect: (() => void) | undefined;
beforeEach(() => {
  useAudio.setState({ listing: null, problem: null });
  usePrefs.setState({ snapshot: prefsSnapshot(), saving: false, error: null });
  played.mockClear(); paused.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(played);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(paused);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { disconnect?.(); disconnect = undefined; vi.restoreAllMocks(); });

describe('the Main window playback connection', () => {
  it('preloads silently, plays each push once, stops on mute and disconnects without replay', async () => {
    const bridge = installFakeBridge();
    const id = 'a'.repeat(64);
    bridge.setInvoke(() => Promise.resolve({ files: [{ filename: 'button.wav', id }], problems: 0, unavailable: false }));
    disconnect = connectAudio();
    await Promise.resolve(); await Promise.resolve();
    expect(played).not.toHaveBeenCalled();
    expect(bridge.listenerCount('audio:play')).toBe(1);
    bridge.push('audio:play', { event: 'click', id, volume: 0.6 });
    expect(played).toHaveBeenCalledOnce();
    const snapshot = prefsSnapshot(); snapshot.values.audio.muted = true;
    usePrefs.setState({ snapshot });
    expect(paused).toHaveBeenCalled();
    bridge.push('audio:play', { event: 'click', id, volume: 0.6 });
    expect(played).toHaveBeenCalledOnce();
    disconnect(); disconnect = undefined;
    expect(bridge.listenerCount('audio:play')).toBe(0);
  });
  it('drops disabled events and all cues when preferences are refused', () => {
    const bridge = installFakeBridge();
    disconnect = connectAudio();
    const snapshot = prefsSnapshot(); snapshot.values.audio.sounds.click = null;
    usePrefs.setState({ snapshot });
    bridge.push('audio:play', { event: 'click', id: 'a'.repeat(64), volume: 0.6 });
    usePrefs.setState({ snapshot: { ...snapshot, status: { kind: 'read-only', reason: 'corrupt' } } });
    bridge.push('audio:play', { event: 'done', id: 'a'.repeat(64), volume: 0.6 });
    expect(played).not.toHaveBeenCalled();
  });
});
