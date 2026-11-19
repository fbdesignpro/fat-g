// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDiscoveryState } from '@shared/contracts/provider-discovery';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { closeSettings, useSettings } from '../settings/settings-store';
import { useAppState } from '../state/store';
import { installDialogStandIn } from '../test/dialog';
import { installFakeBridge } from '../test/fake-bridge';
import { ProviderDiscoveryDialog } from './ProviderDiscoveryDialog';
import { ProviderDiscoveryControls } from './ProviderDiscoveryControls';

const providers: ProviderDiscoveryState['providers'] = [
  { id: 'codex', displayName: 'Codex', presence: 'present', enabled: true, overrideInvalid: false, checkFailed: false },
  { id: 'claude', displayName: 'Claude', presence: 'missing', enabled: true, overrideInvalid: false, checkFailed: false },
  { id: 'third', displayName: 'Third', presence: 'present', enabled: false, overrideInvalid: false, checkFailed: false },
];
const state = (initial = true): ProviderDiscoveryState => ({ checking: false, providers, historyIssue: null, notice: { revision: 1, initial, providers } });
const show = (discovery: ProviderDiscoveryState) => useAppState.setState({ snapshot: { ...sampleSnapshot(), providerDiscovery: discovery } });
let invoke = vi.fn(async (_channel: string, _request: unknown) => ({ ok: true, value: true }));
beforeEach(() => {
  installDialogStandIn(); closeSettings();
  invoke = vi.fn(async () => ({ ok: true, value: true }));
  installFakeBridge().setInvoke(invoke);
  show(state());
});
afterEach(cleanup);

describe('discovery dialog', () => {
  it('summarizes initial results, focuses Got it and returns focus after acknowledgment', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { container } = render(<ProviderDiscoveryDialog />);
    const dialog = await screen.findByRole('dialog', { name: 'Providers detected' });
    expect(dialog.textContent).toContain('Detected and enabled.');
    expect(dialog.textContent).toContain('CLI not found.');
    expect(dialog.textContent).toContain('Kept off by your choice.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Got it' })));
    expect(invoke).toHaveBeenCalledWith('providers:acknowledgeDiscovery', { revision: 1 });
    expect(container.querySelector('dialog[open]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it('offers Accounts settings after dismissing the notice', async () => {
    render(<ProviderDiscoveryDialog />);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Accounts settings' })));
    expect(useSettings.getState()).toMatchObject({ open: true, tab: 'accounts' });
  });
  it('defers to other dialogs and uses changed-provider wording later', async () => {
    const other = document.createElement('dialog');
    document.body.append(other); other.showModal();
    show(state(false));
    const { container } = render(<ProviderDiscoveryDialog />);
    expect(container.querySelector('dialog[open]')).toBeNull();
    await act(async () => other.close());
    expect(await screen.findByRole('dialog', { name: 'Provider availability changed' })).toBeTruthy();
    expect(screen.getByText('Running work can finish. Your sessions and account settings are kept.')).toBeTruthy();
    other.remove();
  });
  it('handles Escape as acknowledgment and keeps a failed IPC retryable', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    render(<ProviderDiscoveryDialog />);
    const dialog = await screen.findByRole('dialog', { name: 'Providers detected' });
    await act(async () => fireEvent(dialog, new Event('cancel', { cancelable: true })));
    expect(screen.getByRole('status').textContent).toContain('Try again');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Got it' })));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps Accounts discovery available with history errors and invokes a manual rescan', async () => {
    show({ ...state(), notice: null, historyIssue: 'unavailable' });
    render(<ProviderDiscoveryControls />);
    expect(screen.getByRole('status').textContent).toContain('left unchanged');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Check for providers' })));
    expect(invoke).toHaveBeenCalledWith('providers:discover', null);
    act(() => show({ ...state(), notice: null, checking: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check for providers' }).hasAttribute('disabled')).toBe(true));
  });
});
