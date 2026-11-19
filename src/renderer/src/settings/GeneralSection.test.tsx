// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPatch, type PreferencesPatch } from '@shared/contracts/prefs';
import { usePrefs } from '../state/prefs-store';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { GeneralSection } from './GeneralSection';

let patches: PreferencesPatch[];
beforeEach(() => {
  patches = [];
  let saved = prefsSnapshot();
  usePrefs.setState({ snapshot: saved, error: null, saving: false });
  installFakeBridge().setInvoke((channel, request) => {
    if (channel === 'prefs:patch') {
      const patch = request as PreferencesPatch;
      patches.push(patch);
      saved = { ...saved, rev: saved.rev + 1, values: applyPatch(saved.values, patch) };
    }
    return Promise.resolve({ ok: true, value: saved });
  });
});
afterEach(cleanup);

describe('mini window auto-hide', () => {
  const autoHide = () => screen.getByRole<HTMLInputElement>('checkbox', { name: /Automatically hide when the main window is in focus/ });

  it('starts enabled and saves the child option independently of showing the mini window', async () => {
    render(<GeneralSection />);
    expect(autoHide().checked).toBe(true);
    await act(async () => { fireEvent.click(autoHide()); await Promise.resolve(); });
    expect(patches).toEqual([{ windows: { pet: { autoHideOnMainFocus: false } } }]);
    expect(autoHide().checked).toBe(false);
    expect(usePrefs.getState().snapshot?.values.windows.pet.visible).toBe(true);
  });

  it('lets automatic hiding change while the mini window is off and keeps the choice when shown again', async () => {
    render(<GeneralSection />);
    await act(async () => { fireEvent.click(autoHide()); await Promise.resolve(); });
    const parent = screen.getByRole<HTMLInputElement>('checkbox', { name: /Show the mini window/ });
    await act(async () => { fireEvent.click(parent); await Promise.resolve(); });
    expect(autoHide().disabled).toBe(false);
    expect(autoHide().checked).toBe(false);
    await act(async () => { fireEvent.click(autoHide()); await Promise.resolve(); });
    expect(autoHide().checked).toBe(true);
    expect(usePrefs.getState().snapshot?.values.windows.pet).toMatchObject({ visible: false, autoHideOnMainFocus: true });
    await act(async () => { fireEvent.click(parent); await Promise.resolve(); });
    expect(autoHide().disabled).toBe(false);
    expect(autoHide().checked).toBe(true);
  });

  it.each(['read-only', 'saving'] as const)('disables changes while preferences are %s', (state) => {
    if (state === 'saving') usePrefs.setState({ saving: true });
    else usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible' }) });
    render(<GeneralSection />);
    expect(autoHide().disabled).toBe(true);
  });
});

describe('the optional chat username', () => {
  it('saves on Enter and blur, normalizes the name, and clears to the You fallback', async () => {
    render(<GeneralSection />);
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Your name' });
    expect(field.placeholder).toBe('You');
    fireEvent.change(field, { target: { value: '  Robin   Taylor ' } });
    expect(patches).toEqual([]);
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); await Promise.resolve(); });
    expect(patches).toEqual([{ chat: { username: 'Robin Taylor' } }]);
    expect(field.value).toBe('Robin Taylor');
    await act(async () => { fireEvent.change(field, { target: { value: '' } }); fireEvent.blur(field); await Promise.resolve(); });
    expect(patches.at(-1)).toEqual({ chat: { username: null } });
    expect(usePrefs.getState().snapshot?.values.chat.username).toBeNull();
  });
});
