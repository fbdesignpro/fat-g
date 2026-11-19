// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sampleSnapshot } from '../../../tests/support/app-state';
import { App } from './App';
import { closeSettings, useSettings } from './settings/settings-store';
import { usePrefs } from './state/prefs-store';
import { useAppState } from './state/store';
import { installDialogStandIn } from './test/dialog';
import { installFakeBridge } from './test/fake-bridge';
import { prefsSnapshot } from './test/prefs';

beforeAll(installDialogStandIn);
beforeEach(() => {
  installFakeBridge('test-os');
  useAppState.setState({ snapshot: null, error: null });
  usePrefs.setState({ snapshot: null, error: null, saving: false });
  useSettings.setState({ open: false, target: null, tab: 'general' });
});
afterEach(cleanup);

describe('App', () => {
  it('shows the page grid, with the menu and the gear in the title strip and each provider’s usage in the usage box (M100, C19, C54)', () => {
    useAppState.setState({ snapshot: sampleSnapshot(2) });
    render(<App />);
    const strip = screen.getByRole('banner');
    const controls = within(strip).getByRole('toolbar', { name: 'Controls' });
    expect(within(controls).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Menu', 'Settings', 'Mini window']);
    const usage = screen.getByRole('region', { name: 'Usage' });
    expect(within(usage).getByRole('button', { name: 'Claude' })).toBeTruthy();
    expect(within(usage).getByRole('button', { name: 'Codex' })).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Chat' })).toBeTruthy();
  });

  it('opens Settings from the gear, as a modal dialog over the grid, and closes it', () => {
    useAppState.setState({ snapshot: sampleSnapshot(2) });
    render(<App />);
    const gear = screen.getByRole('button', { name: 'Settings' });
    gear.focus();
    fireEvent.click(gear);

    expect(useSettings.getState()).toEqual({ open: true, target: null, tab: 'general' });
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.hasAttribute('open')).toBe(true);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close settings' }));
    expect(useSettings.getState().open).toBe(false);
    expect(document.activeElement).toBe(gear);
  });

  it('opens a provider’s part of Settings from its usage block, in Accounts, and the gear then opens the tab last shown (M101, C7, C8)', () => {
    useAppState.setState({ snapshot: sampleSnapshot(2) });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(useSettings.getState()).toEqual({ open: true, target: { provider: 'codex', instanceId: 'default' }, tab: 'accounts' });
    expect(screen.getByRole('tab', { name: 'Accounts' }).getAttribute('aria-selected')).toBe('true');
    const provider = within(screen.getByRole('tabpanel', { name: 'Accounts' })).getByRole('heading', { name: 'Codex' }).closest('section') as HTMLElement;
    expect(document.activeElement).toBe(within(provider).getByRole('heading', { level: 5, name: 'Account: user@example.com' }));
    act(() => closeSettings());
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('tab', { name: 'Accounts' }).getAttribute('aria-selected')).toBe('true');
    act(() => closeSettings());
  });

  it('marks the page, its seq and whether identity reached it, for smoke mode, without adding visible text', () => {
    useAppState.setState({ snapshot: sampleSnapshot(8) });
    const { container } = render(<App />);
    const probe = container.querySelector('[data-smoke-page]');
    expect(probe?.getAttribute('data-smoke-page')).toBe('main');
    expect(probe?.getAttribute('data-smoke-seq')).toBe('8');
    expect(probe?.getAttribute('data-smoke-csp')).toBe('0');
    expect(probe?.getAttribute('data-smoke-identity')).toBe('yes');
    expect(probe?.textContent).toBe('');
  });
});
