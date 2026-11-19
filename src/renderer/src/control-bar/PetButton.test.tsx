// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Pet window's toggle in the title strip, after the gear (decision 0010): pressed while the Pet is
// wanted, a press changing the preference main follows, and its name the same either way.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreferencesPatch } from '@shared/contracts/prefs';
import { usePrefs } from '../state/prefs-store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { ControlBar } from './ControlBar';

let bridge: FakeBridge;
let patches: PreferencesPatch[];
let rev: number;

beforeEach(() => {
  bridge = installFakeBridge();
  patches = [];
  rev = 1;
  bridge.setInvoke((channel, request) => {
    if (channel !== 'prefs:patch') return Promise.resolve({ ok: true, value: null });
    const patch = request as PreferencesPatch;
    patches.push(patch);
    const visible = patch.windows?.pet?.visible ?? true;
    rev += 1;
    return Promise.resolve({ ok: true, value: prefsSnapshot({ windows: { main: { bounds: null, maximized: false }, pet: { visible, autoHideOnMainFocus: true, bounds: null, size: 'capsule' } } }, { kind: 'ok' }, rev) });
  });
  usePrefs.setState({ snapshot: null, error: null, saving: false });
});
afterEach(cleanup);

const withPet = (visible: boolean, status: Parameters<typeof prefsSnapshot>[1] = { kind: 'ok' }) =>
  usePrefs.setState({ snapshot: prefsSnapshot({ windows: { main: { bounds: null, maximized: false }, pet: { visible, autoHideOnMainFocus: true, bounds: null, size: 'capsule' } } }, status) });
const button = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Mini window' });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('PetButton', () => {
  it('stands after the gear, pressed while the Pet is shown', () => {
    withPet(true);
    render(<ControlBar />);
    expect(screen.getAllByRole('button').map((element) => element.getAttribute('aria-label')).slice(0, 3)).toEqual(['Menu', 'Settings', 'Mini window']);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    act(() => withPet(false));
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the Pet, then shows it again, through the preference main follows, keeping its name', async () => {
    withPet(true);
    render(<ControlBar />);
    fireEvent.click(button());
    await settle();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button());
    await settle();
    expect(patches).toEqual([{ windows: { pet: { visible: false } } }, { windows: { pet: { visible: true } } }]);
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it('waits for the preferences, and is disabled while their file refuses writes', () => {
    render(<ControlBar />);
    expect(button().disabled).toBe(true);
    act(() => withPet(true, { kind: 'read-only', reason: 'corrupt' }));
    expect(button().disabled).toBe(true);
    act(() => withPet(true));
    expect(button().disabled).toBe(false);
  });
});
