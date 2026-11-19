// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDialogStandIn } from '../test/dialog';
import { installFakeBridge } from '../test/fake-bridge';
import { ResetDataSection } from './ResetDataSection';

const folder = 'C:/Users/example/AppData/Roaming/fat-g-dev';
let invoke = vi.fn(async (_channel: string, _request: unknown): Promise<unknown> => ({ ok: true, value: { folder, available: true } }));
beforeEach(() => {
  installDialogStandIn();
  invoke = vi.fn(async (channel: string): Promise<unknown> => ({ ok: true, value: channel === 'diagnostics:dataResetInfo' ? { folder, available: true } : { status: 'scheduled' } }));
  installFakeBridge().setInvoke(invoke);
});
afterEach(cleanup);
const begin = async (): Promise<void> => {
  render(<ResetDataSection />);
  await screen.findByText(folder, { selector: 'code' });
  const button = screen.getByRole('button', { name: 'Reset all data...' });
  button.focus();
  fireEvent.click(button);
};
const resetCalls = () => invoke.mock.calls.filter(([channel]) => channel === 'diagnostics:resetAllData');

describe('full-data reset controls', () => {
  it('shows the real data folder and can open it through the existing Main-only route', async () => {
    render(<ResetDataSection />);
    expect(await screen.findByText(folder, { selector: 'code' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open data folder' })));
    expect(invoke).toHaveBeenCalledWith('shell:showDataFolder', null);
  });
  it('requires both confirmations, discloses what is removed and defaults each to Cancel', async () => {
    await begin();
    let dialog = screen.getByRole('dialog', { name: 'Reset all fat-g data?' });
    expect(dialog.textContent).toContain('chats, plans, attachments, custom avatars, sounds');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(resetCalls()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    dialog = screen.getByRole('dialog', { name: 'Permanently reset and quit?' });
    expect(dialog.textContent).toContain('fat-g will quit now');
    expect(dialog.textContent).toContain('Project folders and CLI logins are not removed.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(resetCalls()).toHaveLength(0);
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Reset on next start and quit' })));
    expect(resetCalls()).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('fat-g is quitting');
  });
  it.each(['first', 'second'])('cancels the %s confirmation without scheduling anything', async (stage) => {
    await begin();
    if (stage === 'second') fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(resetCalls()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reset all data...' }));
  });
  it('keeps failures retryable without closing the app or repeating the first question', async () => {
    invoke.mockImplementation(async (channel) => ({ ok: true, value: channel === 'diagnostics:dataResetInfo' ? { folder, available: true } : { status: 'failed' } }));
    await begin(); fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reset on next start and quit' })));
    expect(screen.getByRole('status').textContent).toContain('Nothing was deleted');
    expect(screen.getByRole('button', { name: 'Reset on next start and quit' }).hasAttribute('disabled')).toBe(false);
  });
});
