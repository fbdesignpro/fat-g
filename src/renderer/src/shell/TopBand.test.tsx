// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { useAppState } from '../state/store';
import { installFakeBridge } from '../test/fake-bridge';
import { TopBand } from './TopBand';

let bandWidth: number;
let resizeBand: (() => void) | undefined;

beforeEach(() => {
  installFakeBridge();
  bandWidth = 1600;
  resizeBand = undefined;
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = computedStyle(element);
    if (element.getAttribute('aria-label') === 'Usage') Object.defineProperties(style, {
      paddingLeft: { value: '6px' }, paddingRight: { value: '6px' },
      borderLeftWidth: { value: '1px' }, borderRightWidth: { value: '1px' },
    });
    if (element.firstElementChild?.hasAttribute('data-usage-block')) Object.defineProperty(style, 'columnGap', { value: '19px' });
    return style;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(291);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, bandWidth, 62));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(element: Element): void {
      if (element.querySelector('[aria-label="Usage"]') !== null) resizeBand = this.callback;
    }
    disconnect(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const accounts = (count: number) => Array.from({ length: count }, (_, index) =>
  sampleProvider({ id: `provider-${index}`, displayName: `Provider ${index}` }));
const sizing = () => {
  const band = screen.getByRole('region', { name: 'Usage' }).parentElement;
  return [band?.style.getPropertyValue('--usage-account-count'), band?.style.getPropertyValue('--usage-arrow-space')];
};

it('snaps to three, two, then one whole account within 60%, including room for both arrows, and grows again', () => {
  useAppState.setState({ snapshot: sampleSnapshot(1, accounts(3)) });
  render(<TopBand />);
  expect(sizing()).toEqual(['3', '0px']);
  // Three accounts without arrows need 925px; just below that bound, show two with arrows.
  bandWidth = 1541;
  act(() => resizeBand?.());
  expect(sizing()).toEqual(['2', '38px']);
  // Two accounts with arrows need 653px; reserving only the blocks' width would exceed 60%.
  bandWidth = 1088;
  act(() => resizeBand?.());
  expect(sizing()).toEqual(['1', '38px']);
  bandWidth = 1600;
  act(() => resizeBand?.());
  expect(sizing()).toEqual(['3', '0px']);
});

it('remeasures when enabled accounts change, reserving arrows only for accounts outside the box', () => {
  useAppState.setState({ snapshot: sampleSnapshot(1, accounts(4)) });
  render(<TopBand />);
  // 60% of 1600 is 960: three blocks with arrows need 963, so only two fit.
  expect(sizing()).toEqual(['2', '38px']);
  act(() => useAppState.setState({ snapshot: sampleSnapshot(2, [
    ...accounts(2), sampleProvider({ id: 'disabled', status: { kind: 'disabled' } }),
  ]) }));
  expect(sizing()).toEqual(['2', '0px']);
  act(() => useAppState.setState({ snapshot: sampleSnapshot(3, accounts(1)) }));
  expect(sizing()).toEqual(['1', '0px']);
});

it.each(['missing', 'checking'] as const)('keeps one visible account one block wide alongside a %s provider, including after widening', (presence) => {
  bandWidth = 600;
  useAppState.setState({ snapshot: sampleSnapshot(1, [
    ...accounts(1), sampleProvider({ id: 'hidden', presence }),
  ]) });
  const { container } = render(<TopBand />);
  expect(container.querySelectorAll('[data-usage-block]')).toHaveLength(1);
  expect(sizing()).toEqual(['1', '0px']);
  bandWidth = 2400;
  act(() => resizeBand?.());
  expect(sizing()).toEqual(['1', '0px']);

  act(() => useAppState.setState({ snapshot: sampleSnapshot(2, [
    ...accounts(1), sampleProvider({ id: 'hidden', presence: 'present' }),
  ]) }));
  expect(sizing()).toEqual(['2', '0px']);
});
