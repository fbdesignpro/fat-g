// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The zoom in the title strip: after the gear while the Main window's zoom is not 100%, a press back
// to 100%, and a tooltip with the keys that zoom on this platform.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import type { ZoomChangeRequest } from '@shared/contracts/zoom';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { ControlBar } from './ControlBar';

let bridge: FakeBridge;
let zooms: ZoomChangeRequest[];

function install(platform: string): void {
  bridge = installFakeBridge(platform);
  zooms = [];
  bridge.setInvoke((channel, request) => {
    if (channel === 'zoom:change') zooms.push(request as ZoomChangeRequest);
    return Promise.resolve({ ok: true, value: null });
  });
}

beforeEach(() => {
  install('win32');
  useAppState.setState({ snapshot: null, error: null });
});
afterEach(cleanup);

const at = (zoom: number | undefined) => useAppState.setState({ snapshot: { ...sampleSnapshot(2), ...(zoom === undefined ? {} : { zoom }) } });
const names = () => within(screen.getByRole('toolbar', { name: 'Controls' })).getAllByRole('button').map((button) => button.getAttribute('aria-label'));
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('ZoomButton', () => {
  it('is not there before main reports a zoom, nor at 100%', () => {
    at(undefined);
    render(<ControlBar />);
    expect(names()).toEqual(['Menu', 'Settings', 'Mini window']);
    act(() => at(100));
    expect(names()).toEqual(['Menu', 'Settings', 'Mini window']);
  });

  it('shows the zoom after the gear while it is not 100%', () => {
    at(90);
    render(<ControlBar />);
    expect(names()).toEqual(['Menu', 'Settings', 'Mini window', 'Zoom 90%, back to 100%']);
    expect(screen.getByRole('button', { name: 'Zoom 90%, back to 100%' }).textContent).toBe('90%');
    act(() => at(125));
    expect(screen.getByRole('button', { name: 'Zoom 125%, back to 100%' }).textContent).toBe('125%');
  });

  it('goes back to 100% on a press, and gives the focus it held to the gear', async () => {
    at(90);
    render(<ControlBar />);
    const button = screen.getByRole('button', { name: /^Zoom 90%/ });
    button.focus();
    fireEvent.click(button);
    await settle();
    expect(zooms).toEqual([{ to: 'reset' }]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Settings' }));
    act(() => at(100));
    expect(names()).toEqual(['Menu', 'Settings', 'Mini window']);
  });

  it('is described by the keys that zoom, with Ctrl and the wheel off macOS', () => {
    at(90);
    render(<ControlBar />);
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(screen.getByRole('button', { name: /^Zoom 90%/ }).getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.textContent).toBe('Click for 100%Ctrl+=Zoom inCtrl+-Zoom outCtrl+0Back to 100%Ctrl+wheelZoom in or out');
  });

  it('says Cmd on macOS, where Chromium does not zoom with the wheel', () => {
    install('darwin');
    at(90);
    render(<ControlBar />);
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe('Click for 100%Cmd+=Zoom inCmd+-Zoom outCmd+0Back to 100%');
  });
});
