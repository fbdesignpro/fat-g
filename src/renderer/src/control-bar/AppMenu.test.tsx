// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeProjectDialog, useProjectDialog } from '../projects/project-dialog-store';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { AppMenu } from './AppMenu';

let bridge: FakeBridge;
let requests: unknown[];

beforeEach(() => {
  bridge = installFakeBridge();
  useAppState.setState({ snapshot: { ...sampleSnapshot(1), records: { status: { kind: 'ok', keptAs: null }, projects: [] } }, error: null });
  closeProjectDialog();
  requests = [];
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: null });
  });
});
afterEach(cleanup);

const menuButton = () => screen.getByRole('button', { name: 'Menu' });
const openMenu = () => {
  fireEvent.click(menuButton());
  return screen.getByRole('menu');
};

describe('the application menu (C31–C33)', () => {
  it('is a named button that says it opens a menu, closed at first', () => {
    render(<AppMenu />);
    expect(menuButton().getAttribute('aria-haspopup')).toBe('menu');
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens with Add project above Exit (M12, C35), and moves the focus to the first', () => {
    render(<AppMenu />);
    const menu = openMenu();
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(menuButton().getAttribute('aria-controls')).toBe(menu.id);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Add project', 'Exit']);
    expect(document.activeElement).toBe(items[0]);
  });

  it('opens from the keyboard with the arrow keys', () => {
    render(<AppMenu />);
    fireEvent.keyDown(menuButton(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Add project' }));
  });

  it('does not open on Alt+Down, which moves a project elsewhere', () => {
    render(<AppMenu />);
    fireEvent.keyDown(menuButton(), { key: 'ArrowDown', altKey: true });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the focus on its items with the arrow keys, Home and End', () => {
    render(<AppMenu />);
    const menu = openMenu();
    const add = screen.getByRole('menuitem', { name: 'Add project' });
    const exit = screen.getByRole('menuitem', { name: 'Exit' });
    for (const [key, expected] of [['ArrowDown', exit], ['ArrowDown', add], ['ArrowUp', exit], ['Home', add], ['End', exit]] as const) {
      fireEvent.keyDown(menu, { key });
      expect(document.activeElement).toBe(expected);
    }
  });

  it('opens the project dialog empty from Add project', () => {
    render(<AppMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add project' }));
    expect(useProjectDialog.getState()).toMatchObject({ open: true, projectId: null });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('disables Add project while the records file is refused (C50)', () => {
    useAppState.setState({ snapshot: { ...sampleSnapshot(2), records: { status: { kind: 'refused', cause: 'damaged' }, projects: [] } } });
    render(<AppMenu />);
    openMenu();
    const add = screen.getByRole('menuitem', { name: 'Add project' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(useProjectDialog.getState().open).toBe(false);
  });

  it('closes on Escape and hands the focus back to its button', () => {
    render(<AppMenu />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
    expect(requests).toEqual([]);
  });

  it('closes on a click anywhere outside it, and not on one inside it', () => {
    render(
      <>
        <AppMenu />
        <p>elsewhere</p>
      </>,
    );
    const menu = openMenu();
    fireEvent.pointerDown(menu);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toggles closed from its own button', () => {
    render(<AppMenu />);
    openMenu();
    fireEvent.pointerDown(menuButton());
    fireEvent.click(menuButton());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the focus tabs away', () => {
    render(<AppMenu />);
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('asks main to quit on Exit, with nothing else', () => {
    render(<AppMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exit' }));
    expect(requests).toEqual([['app:quit', null]]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows nothing if main cannot be reached, the window being on its way out', async () => {
    bridge.setInvoke(() => Promise.reject(new Error('gone')));
    render(<AppMenu />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Exit' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).not.toMatch(/error|gone/i);
  });
});
