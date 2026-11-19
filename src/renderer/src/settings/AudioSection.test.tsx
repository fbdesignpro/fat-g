// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_EVENTS, AUDIO_LABELS } from '@shared/contracts/audio';
import { useAudio } from '../audio/store';
import { usePrefs } from '../state/prefs-store';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { AudioSection } from './AudioSection';

const actAndFlush = async (work: () => void): Promise<void> => { await act(async () => { work(); await Promise.resolve(); }); };

let bridge: ReturnType<typeof installFakeBridge>;
const request = vi.fn();
beforeEach(() => {
  bridge = installFakeBridge(); request.mockClear();
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  useAudio.setState({ listing: null, problem: null });
  bridge.setInvoke((channel, payload) => {
    request(channel, payload);
    if (channel === 'audio:list' || channel === 'audio:rescan') return Promise.resolve({ files: [{ filename: 'button.wav', id: 'a'.repeat(64) }], problems: 0, unavailable: false });
    if (channel === 'prefs:patch') return Promise.resolve(prefsSnapshot());
    return Promise.resolve(null);
  });
});
afterEach(cleanup);

describe('Audio preferences', () => {
  it('offers all thirteen selectors, Off, master mute, volume and previews', async () => {
    await actAndFlush(() => { render(<AudioSection />); });
    for (const event of AUDIO_EVENTS) {
      const select = screen.getByLabelText<HTMLSelectElement>(AUDIO_LABELS[event]);
      expect(select.options[0]?.text).toBe('Off');
      expect(screen.getByRole('button', { name: `Preview ${AUDIO_LABELS[event]}` })).toBeTruthy();
    }
    expect(screen.getByRole('group', { name: 'Actions' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('slider', { name: 'Audio volume' }).value).toBe('32');
    expect(screen.getByText('Volume — 32%')).toBeTruthy();
    expect(screen.getByLabelText('Mute all sounds')).toBeTruthy();
    expect(screen.getByLabelText<HTMLSelectElement>('Button rollover').value).toBe('');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview Button rollover' }).disabled).toBe(true);
    expect(screen.getByText('done.wav (missing)')).toBeTruthy();
  });
  it('patches one sound, mute and volume, and opens only the audio data folder', async () => {
    await actAndFlush(() => { render(<AudioSection />); });
    await actAndFlush(() => { fireEvent.change(screen.getByLabelText('Click'), { target: { value: '' } }); });
    expect(request).toHaveBeenCalledWith('prefs:patch', { audio: { sounds: { click: null } } });
    await actAndFlush(() => { fireEvent.click(screen.getByLabelText('Mute all sounds')); });
    expect(request).toHaveBeenCalledWith('prefs:patch', { audio: { muted: true } });
    for (const [percent, gain] of [[25, 0.0625], [50, 0.25], [0, 0], [100, 1]]) {
      await actAndFlush(() => { fireEvent.change(screen.getByLabelText('Audio volume'), { target: { value: String(percent) } }); });
      expect(request).toHaveBeenLastCalledWith('prefs:patch', { audio: { volume: gain } });
    }
    await actAndFlush(() => { fireEvent.click(screen.getByText('Open audio data folder')); fireEvent.click(screen.getByText('Rescan')); });
    expect(request).toHaveBeenCalledWith('shell:showDataFolder', { folder: 'audio' });
    expect(request).toHaveBeenCalledWith('audio:rescan', null);
  });
  it('shows a saved volume on the new scale without rewriting its playback gain', async () => {
    const snapshot = prefsSnapshot(); snapshot.values.audio.volume = 0.6;
    usePrefs.setState({ snapshot });
    await actAndFlush(() => { render(<AudioSection />); });
    expect(screen.getByLabelText<HTMLInputElement>('Audio volume').value).toBe('77');
    expect(screen.getByText('Volume — 77%')).toBeTruthy();
    expect(usePrefs.getState().snapshot?.values.audio.volume).toBe(0.6);
    expect(request).not.toHaveBeenCalledWith('prefs:patch', expect.anything());
  });
  it('disables previews while muted and never edits refused preferences', async () => {
    const snapshot = prefsSnapshot(); snapshot.values.audio.muted = true;
    usePrefs.setState({ snapshot });
    await actAndFlush(() => { render(<AudioSection />); });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Preview Click' }).disabled).toBe(true);
    act(() => usePrefs.setState({ snapshot: { ...snapshot, status: { kind: 'read-only', reason: 'corrupt' } } }));
    expect(screen.getByLabelText<HTMLSelectElement>('Click').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Mute all sounds').disabled).toBe(true);
  });
});
