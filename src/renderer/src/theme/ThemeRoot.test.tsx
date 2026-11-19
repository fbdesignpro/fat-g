// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import bootScript from '../../public/theme-boot.js?raw';
import tokens from '../styles/tokens.css?raw';
import { useAppState } from '../state/store';
import { installFakeBridge } from '../test/fake-bridge';
import { ThemeRoot } from './ThemeRoot';

const root = document.documentElement;
let sheet: HTMLStyleElement;

beforeEach(() => {
  installFakeBridge();
  useAppState.setState({ snapshot: null, error: null });
  root.removeAttribute('data-theme');
  // The real tokens, so `color-scheme` is computed from them rather than assumed.
  sheet = document.createElement('style');
  sheet.textContent = tokens;
  document.head.append(sheet);
});
afterEach(() => {
  cleanup();
  sheet.remove();
  root.removeAttribute('data-theme');
  window.history.replaceState(null, '', '/');
});

const colorScheme = () => getComputedStyle(root).getPropertyValue('color-scheme').trim();

describe('ThemeRoot', () => {
  // The maintainer: the attention flash's speed and duration, from Settings → Appearance,
  // as the variables a capsule's status bar animates by (Sessions.module.css).
  it('sets the attention flash’s timing on the root: six a second for three seconds unless changed', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1) });
    render(<ThemeRoot />);
    const timing = () => ['--attention-flash-cycle', '--attention-flash-count', '--attention-flash-duration'].map((name) => root.style.getPropertyValue(name));
    expect(timing()).toEqual(['167ms', '18', '3s']);
    act(() => useAppState.setState({ snapshot: { ...sampleSnapshot(2), appearance: { theme: 'light', flash: { enabled: true, speed: 'slow', seconds: 5 } } } }));
    expect(timing()).toEqual(['500ms', '10', '5s']);
  });

  it('sets the root attribute from the snapshot, and color-scheme follows', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, undefined, 'dark') });
    render(<ThemeRoot />);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(colorScheme()).toBe('dark');
  });

  it('follows a change pushed from main, without a reload', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, undefined, 'light') });
    render(<ThemeRoot />);
    expect(colorScheme()).toBe('light');

    act(() => useAppState.setState({ snapshot: sampleSnapshot(2, undefined, 'dark') }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(colorScheme()).toBe('dark');

    act(() => useAppState.setState({ snapshot: sampleSnapshot(3, undefined, 'light') }));
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(colorScheme()).toBe('light');
  });

  it('leaves the first frame’s theme alone until the first snapshot arrives', () => {
    root.setAttribute('data-theme', 'dark');
    render(<ThemeRoot />);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('is light when the page carries no theme at all', () => {
    render(<ThemeRoot />);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(colorScheme()).toBe('light');
  });

  it('renders nothing', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1) });
    const { container } = render(<ThemeRoot />);
    expect(container.innerHTML).toBe('');
  });
});

// public/theme-boot.js: the classic script both pages run in <head>, before the first paint (C7).
describe('the boot script', () => {
  const runAt = (search: string): void => {
    window.history.replaceState(null, '', `/index.html${search}`);
    // Indirect eval runs it as the page would: a classic script in the global scope.
    (0, eval)(bootScript);
  };

  it.each(['light', 'dark'])('applies ?theme=%s from the page URL', (theme) => {
    runAt(`?theme=${theme}`);
    expect(root.getAttribute('data-theme')).toBe(theme);
  });

  it.each(['?theme=purple', '?theme=', '?theme=Dark', '?other=dark', ''])('ignores %j, leaving the page light', (search) => {
    runAt(search);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(colorScheme()).toBe('light');
  });
});
