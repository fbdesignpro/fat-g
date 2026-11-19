// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Chat timestamp preferences in Appearance: each applies independently through main's store;
// hover and answer times default on, inline times off. A restart uses what main saved.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { applyPatch, type PreferencesPatch, type PreferencesSnapshot } from '@shared/contracts/prefs';
import type { ZoomChangeRequest } from '@shared/contracts/zoom';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { AppearanceSection } from './AppearanceSection';

let bridge: FakeBridge;
let patches: PreferencesPatch[];
let zooms: ZoomChangeRequest[];
/** What main holds: each patch is applied to it, and answered with the next revision. */
let saved: PreferencesSnapshot;

beforeEach(() => {
  bridge = installFakeBridge();
  patches = [];
  zooms = [];
  saved = prefsSnapshot();
  useAppState.setState({ snapshot: null, error: null });
  usePrefs.setState({ snapshot: saved, error: null, saving: false });
  bridge.setInvoke((channel, request) => {
    if (channel === 'zoom:change') {
      zooms.push(request as ZoomChangeRequest);
      return Promise.resolve({ ok: true, value: null });
    }
    if (channel !== 'prefs:patch') return Promise.resolve({ ok: true, value: saved });
    patches.push(request as PreferencesPatch);
    saved = { ...saved, rev: saved.rev + 1, values: applyPatch(saved.values, request as PreferencesPatch) };
    return Promise.resolve({ ok: true, value: saved });
  });
});
afterEach(cleanup);

const times = () => screen.getByLabelText<HTMLInputElement>(/Show message times/);
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('the chat preferences in Appearance (V15; C41)', () => {
  it('defaults hover times on, saves false independently of inline and answer times, and restores it', async () => {
    const view = render(<AppearanceSection />);
    const hover = () => screen.getByLabelText<HTMLInputElement>(/Show message time on hover/);
    expect(hover().checked).toBe(true);
    fireEvent.click(hover());
    await settle();
    expect(patches.at(-1)).toEqual({ chat: { hoverMessageTimes: false } });
    expect(times().checked).toBe(false);
    expect(usePrefs.getState().snapshot?.values.chat.answerTimes).toBe(true);
    view.unmount();
    render(<AppearanceSection />);
    expect(hover().checked).toBe(false);
  });

  it.each(['read-only', 'saving'] as const)('disables hover times while %s', (reason) => {
    if (reason === 'read-only') usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible' }) });
    else usePrefs.setState({ saving: true });
    render(<AppearanceSection />);
    expect(screen.getByLabelText<HTMLInputElement>(/Show message time on hover/).disabled).toBe(true);
  });
  it('saves the Done animation choice', async () => {
    render(<AppearanceSection />);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Animation and flash' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Animation only' }));
    await settle();
    expect(patches.at(-1)).toEqual({ appearance: { doneAnimation: 'animation-only' } });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Animation only' }).checked).toBe(true);
    fireEvent.click(within(screen.getByRole('group', { name: 'Done animation' })).getByRole('radio', { name: 'None' }));
    await settle();
    expect(patches.at(-1)).toEqual({ appearance: { doneAnimation: 'none' } });
  });

  it('saves the creation animation independently of Done', async () => {
    render(<AppearanceSection />);
    const creation = within(screen.getByRole('group', { name: 'Creation animation' }));
    expect(creation.getByRole<HTMLInputElement>('radio', { name: 'Wipe' }).checked).toBe(true);
    fireEvent.click(creation.getByRole('radio', { name: 'None' }));
    await settle();
    expect(patches.at(-1)).toEqual({ appearance: { creationAnimation: 'none' } });
    expect(creation.getByRole<HTMLInputElement>('radio', { name: 'None' }).checked).toBe(true);
    expect(usePrefs.getState().snapshot?.values.appearance.doneAnimation).toBe('animation-flash');
    fireEvent.click(creation.getByRole('radio', { name: 'Wipe' }));
    await settle();
    expect(patches.at(-1)).toEqual({ appearance: { creationAnimation: 'wipe' } });
  });

  it.each(['read-only', 'saving'] as const)('disables the creation choice while %s', (reason) => {
    if (reason === 'read-only') usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible' }) });
    else usePrefs.setState({ saving: true });
    render(<AppearanceSection />);
    expect(screen.getByRole<HTMLFieldSetElement>('group', { name: 'Creation animation' }).disabled).toBe(true);
  });
  it('shows an optional message-times checkbox and no elapsed-time toggle', () => {
    render(<AppearanceSection />);
    expect(times().checked).toBe(false);
    expect(screen.queryByLabelText(/Show each turn?s elapsed time/)).toBeNull();
    expect(times().type).toBe('checkbox');
  });

  it('apply at once, each by its own key, and show what main saved', async () => {
    render(<AppearanceSection />);
    fireEvent.click(times());
    await settle();
    expect(patches).toEqual([{ chat: { messageTimes: true } }]);
    expect(times().checked).toBe(true);
    // And off again.
    fireEvent.click(times());
    await settle();
    expect(patches.at(-1)).toEqual({ chat: { messageTimes: false } });
    expect(usePrefs.getState().snapshot?.values.chat).toEqual({ messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null });
  });

  it('toggles model answer times independently and saves the choice', async () => {
    render(<AppearanceSection />);
    const answerTimes = screen.getByLabelText<HTMLInputElement>(/Show model answer times/);
    expect(answerTimes.checked).toBe(true);
    fireEvent.click(answerTimes);
    await settle();
    expect(patches.at(-1)).toEqual({ chat: { answerTimes: false } });
    expect(answerTimes.checked).toBe(false);
    expect(times().checked).toBe(false);
  });

  it('show after a restart what was saved: the window reads them from main, and keeps nothing of its own', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: 'Robin' } }) });
    render(<AppearanceSection />);
    expect(times().checked).toBe(true);
  });

  it('cannot be changed while the preferences file is read-only', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible' }) });
    render(<AppearanceSection />);
    expect(times().disabled).toBe(true);
  });

  it('leave the theme and the project list where they were in the section', () => {
    render(<AppearanceSection />);
    expect(screen.getByRole('radio', { name: 'Light' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Right' })).toBeDefined();
  });
});

// The Main window's zoom: − and + a step at a time and Reset, sent to main as pressed; the percent
// is the app state's, and an end keeps the focus while it refuses.
describe('the zoom in Appearance', () => {
  const zoomOut = () => screen.getByRole('button', { name: 'Zoom out' });
  const zoomIn = () => screen.getByRole('button', { name: 'Zoom in' });
  const reset = () => screen.getByRole('button', { name: 'Reset' });
  const at = (zoom: number) => useAppState.setState({ snapshot: { ...sampleSnapshot(2), zoom } });

  it('shows the zoom main reports, 100% until it has', () => {
    render(<AppearanceSection />);
    expect(screen.getByRole('group', { name: 'Zoom' }).textContent).toContain('100%');
    act(() => at(90));
    expect(screen.getByRole('group', { name: 'Zoom' }).textContent).toContain('90%');
  });

  it('sends each press to main at once', async () => {
    at(90);
    render(<AppearanceSection />);
    fireEvent.click(zoomIn());
    fireEvent.click(zoomOut());
    fireEvent.click(reset());
    await settle();
    expect(zooms).toEqual([{ to: 'in' }, { to: 'out' }, { to: 'reset' }]);
  });

  it('refuses past an end, and Reset at 100%, keeping the focus where it is', async () => {
    at(200);
    render(<AppearanceSection />);
    zoomIn().focus();
    fireEvent.click(zoomIn());
    await settle();
    expect(zooms).toEqual([]);
    expect(zoomIn().getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(zoomIn());
    act(() => at(50));
    expect(zoomIn().getAttribute('aria-disabled')).toBeNull();
    expect(zoomOut().getAttribute('aria-disabled')).toBe('true');
    act(() => at(100));
    expect(reset().getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(reset());
    await settle();
    expect(zooms).toEqual([]);
  });

  it('stays usable while the preferences file is read-only: the zoom is not a preference', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible' }) });
    at(110);
    render(<AppearanceSection />);
    fireEvent.click(zoomOut());
    await settle();
    expect(zooms).toEqual([{ to: 'out' }]);
  });
});
