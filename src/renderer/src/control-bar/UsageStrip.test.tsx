// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { closeSettings, useSettings } from '../settings/settings-store';
import { useAppState } from '../state/store';
import { installFakeBridge } from '../test/fake-bridge';
import { ARROW_WIDTH, revealBlock, revealNext, revealPrevious, type StripLayout, stripView } from './strip-scroll';
import { UsageStrip } from './UsageStrip';

beforeEach(() => {
  installFakeBridge();
  closeSettings();
});
afterEach(cleanup);

const BLOCK = 260;
const GAP = 16;
/** `count` blocks of 260 with 16 between them, in a strip `outer` wide. */
const layoutOf = (count: number, outer: number): StripLayout => ({
  outer,
  blocks: Array.from({ length: count }, (_, index) => ({ start: index * (BLOCK + GAP), width: BLOCK })),
});
const providers = (count: number): ProviderSnapshot[] =>
  Array.from({ length: count }, (_, index) => sampleProvider({ id: `p${index}`, displayName: `Provider ${index}` }));

const track = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('[data-usage-block]')?.parentElement;
  if (element === null || element === undefined) throw new Error('no track');
  return element;
};
const offset = (container: HTMLElement): number => Number(/translateX\((-?[\d.]+)px\)/.exec(track(container).style.transform)?.[1]);
const left = () => screen.queryByRole('button', { name: 'Show the providers on the left' });
const right = () => screen.queryByRole('button', { name: 'Show the providers on the right' });

describe('UsageStrip', () => {
  it('shows one block per enabled provider, in registry order, and none for a disabled one (C34, C40)', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, [
      sampleProvider({ id: 'claude', displayName: 'Claude' }),
      sampleProvider({ id: 'off', displayName: 'Off', status: { kind: 'disabled' }, usage: null }),
      sampleProvider({ id: 'codex', displayName: 'Codex' }),
    ]) });
    const { container } = render(<UsageStrip measure={() => layoutOf(2, 1000)} />);
    expect([...container.querySelectorAll('[data-usage-block]')].map((block) => block.getAttribute('data-usage-block'))).toEqual(['claude', 'codex']);
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
  });

  it('gives each block the colour and mark of its provider’s catalog entry (M13, C21, V5)', () => {
    const snapshot = sampleSnapshot(1, [sampleProvider({ id: 'claude', displayName: 'Claude' }), sampleProvider({ id: 'codex', displayName: 'Codex' })]);
    const [claude, codex] = snapshot.catalog?.providers ?? [];
    if (claude === undefined || codex === undefined) throw new Error('no catalog');
    const catalog = { ...snapshot.catalog, override: snapshot.catalog?.override ?? { kind: 'none', path: '' }, providers: [
      claude,
      { ...codex, presentation: { barColor: '#123456', icon: { viewBox: '0 0 10 10', path: 'M1 1H9V9H1Z' } } },
    ] } as const;
    useAppState.setState({ snapshot: { ...snapshot, catalog } });
    const { container } = render(<UsageStrip measure={() => layoutOf(2, 1000)} />);
    const blocks = [...container.querySelectorAll<HTMLElement>('[data-usage-block]')];
    expect(blocks.map((block) => block.style.getPropertyValue('--bar-color'))).toEqual(['#ff9933', '#123456']);
    expect(blocks[1]?.querySelector('path')?.getAttribute('d')).toBe('M1 1H9V9H1Z');
  });

  it('is empty before the first snapshot, and with no providers', () => {
    useAppState.setState({ snapshot: null });
    const { container } = render(<UsageStrip measure={() => layoutOf(0, 1000)} />);
    expect(container.querySelectorAll('[data-usage-block]')).toHaveLength(0);
  });

  it('shows no arrow when every block fits (C56)', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, providers(2)) });
    const { container } = render(<UsageStrip measure={() => layoutOf(2, 700)} />);
    expect(left()).toBeNull();
    expect(right()).toBeNull();
    expect(offset(container)).toBe(0);
  });

  it('shows an arrow on the side with hidden blocks — the left, as the strip is aligned right', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, providers(4)) });
    render(<UsageStrip measure={() => layoutOf(4, 700)} />);
    expect(left()).not.toBeNull();
    expect(right()).toBeNull();
  });

  it('brings the next hidden block into view with a click, and walks back the other way', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, providers(4)) });
    const layout = layoutOf(4, 700);
    const { container } = render(<UsageStrip measure={() => layout} />);

    fireEvent.click(left() as HTMLElement);
    expect(offset(container)).toBe(revealPrevious(layout, 0));
    expect(offset(container)).toBeGreaterThan(0);
    expect(right()).not.toBeNull();

    // All the way to the first block, then back to the last.
    while (left() !== null) fireEvent.click(left() as HTMLElement);
    expect(stripView(layout, offset(container)).hiddenBefore).toBe(false);
    while (right() !== null) fireEvent.click(right() as HTMLElement);
    expect(offset(container)).toBe(0);
  });

  it('follows a new measurement, as when the window is resized', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, providers(3)) });
    let outer = 1200;
    const { rerender } = render(<UsageStrip measure={() => layoutOf(3, outer)} />);
    expect(left()).toBeNull();
    outer = 600;
    // A new measure function stands for the observer firing: the strip measures again.
    act(() => rerender(<UsageStrip measure={() => layoutOf(3, outer)} />));
    expect(left()).not.toBeNull();
  });

  it('brings a block into view when it takes the focus', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, providers(4)) });
    const layout = layoutOf(4, 700);
    const { container } = render(<UsageStrip measure={() => layout} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Provider 0' }));
    expect(offset(container)).toBe(revealBlock(layout, 0, 0));
    expect(stripView(layout, offset(container)).hiddenBefore).toBe(false);
  });
});

describe('strip-scroll', () => {
  const layout = layoutOf(4, 700); // row 1088 wide; 662 visible between the arrows

  it('knows when the blocks fit', () => {
    expect(stripView(layoutOf(2, 536), 0)).toEqual({ overflowing: false, scroll: 0, hiddenBefore: false, hiddenAfter: false });
    expect(stripView(layoutOf(2, 535), 0).overflowing).toBe(true);
  });

  it('keeps room for both arrows once they are needed, so they never change the scroll range', () => {
    const view = stripView(layout, 10_000);
    expect(view.scroll).toBe(1088 - (700 - 2 * ARROW_WIDTH));
    expect(view).toMatchObject({ hiddenBefore: false, hiddenAfter: true });
  });

  it('never scrolls past either end', () => {
    expect(stripView(layout, -50).scroll).toBe(0);
    expect(revealNext(layout, 0)).toBe(0);
    expect(revealPrevious(layout, 426)).toBe(426);
  });

  it('reveals a partly hidden block fully, moving as little as possible', () => {
    // Visible at first: 426–1088. Block 1 (276–536) is partly hidden, so it is the next one to show.
    expect(revealPrevious(layout, 0)).toBe(1088 - 662 - 276);
    // From there, block 0 (0–260).
    expect(revealPrevious(layout, 150)).toBe(426);
    // Back the other way: at 426 the visible part ends at 662, so block 2 (552–812) comes next, then 3.
    expect(revealNext(layout, 426)).toBe(1088 - 812);
    expect(revealNext(layout, 1088 - 812)).toBe(0);
    expect(revealBlock(layout, 0, 3)).toBe(0);
  });
});

// M14b, V11 (C39–C43): a provider's accounts in the control bar.
describe('a provider’s accounts (M14b; C39–C43)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const OFF = '11111111-2222-4333-8444-555555555555';
  const claude = (overrides: Partial<ProviderSnapshot> = {}) => sampleProvider({ id: 'claude', displayName: 'Claude', ...overrides });
  const codex = (overrides: Partial<ProviderSnapshot> = {}) => sampleProvider({ id: 'codex', displayName: 'Codex', ...overrides });
  const show = (providers: ProviderSnapshot[], measure = () => layoutOf(providers.length, 2000)) => {
    useAppState.setState({ snapshot: sampleSnapshot(1, providers) });
    return render(<UsageStrip measure={measure} />);
  };
  const blocks = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-usage-block]')];
  const labels = (container: HTMLElement) => blocks(container).map((block) => block.querySelector('[data-account-label]')?.textContent ?? null);

  it('shows a block per account that is switched on, in the app state’s order, and none for one that is off (C39)', () => {
    const { container } = show([
      claude(),
      codex({ label: 'Personal' }),
      codex({ instanceId: WORK, label: 'Work' }),
      codex({ instanceId: OFF, label: 'Spare', status: { kind: 'disabled' }, usage: null }),
    ]);
    expect(blocks(container).map((block) => [block.getAttribute('data-usage-block'), block.getAttribute('data-instance')])).toEqual([['claude', 'default'], ['codex', 'default'], ['codex', WORK]]);
  });

  it('shows no label for a provider with one account configured, and one under the bars of each account of a provider with two (C40)', () => {
    const { container } = show([claude(), codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]);
    expect(labels(container)).toEqual([null, 'Personal', 'Work']);
    // Under the bars: after them in the block.
    const work = blocks(container)[2];
    const label = work?.querySelector('[data-account-label]');
    const lastBar = [...(work?.querySelectorAll('[role="meter"]') ?? [])].at(-1);
    expect(label !== null && label !== undefined && lastBar !== undefined && (lastBar.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  it('shows the first account as Default when it has no label of its own, and keeps the label of the one left on when the other is off', () => {
    const { container } = show([codex({ label: 'Default' }), codex({ instanceId: WORK, label: 'Work', status: { kind: 'disabled' }, usage: null })]);
    // Two are configured, so the one block that shows is still named.
    expect(labels(container)).toEqual(['Default']);
  });

  it('shows a long label whole in the DOM: the style cuts it with an ellipsis', () => {
    const long = 'A label of twenty-four ch';
    const { container } = show([codex({ label: 'Personal' }), codex({ instanceId: WORK, label: long })]);
    expect(labels(container)).toEqual(['Personal', long]);
  });

  it('names a block’s button by the provider, then the label when one shows (C41)', () => {
    show([claude(), codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Claude', 'Codex · Personal', 'Codex · Work']);
  });

  it('heads a block’s panel the same way (C42)', () => {
    show([claude(), codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]);
    fireEvent.focus(screen.getByRole('button', { name: 'Codex · Work' }));
    expect(screen.getByRole('tooltip').firstElementChild?.textContent).toBe('Codex · Work');
    fireEvent.blur(screen.getByRole('button', { name: 'Codex · Work' }));
    fireEvent.focus(screen.getByRole('button', { name: 'Claude' }));
    expect(screen.getByRole('tooltip').firstElementChild?.textContent).toBe('Claude');
  });

  it('gives every account of a provider that provider’s colour and mark: an account has none of its own (C43)', () => {
    const { container } = show([codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]);
    const [first, second] = blocks(container);
    expect(first?.style.getPropertyValue('--bar-color')).not.toBe('');
    expect(second?.style.getPropertyValue('--bar-color')).toBe(first?.style.getPropertyValue('--bar-color'));
    expect(second?.querySelector('path')?.getAttribute('d')).toBe(first?.querySelector('path')?.getAttribute('d'));
    expect(second?.querySelector<HTMLElement>('[data-account-label]')?.style.color).toBe('');
  });

  it('opens Settings at the account whose block was pressed (C38)', () => {
    show([codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Codex · Work' }));
    expect(useSettings.getState()).toEqual({ open: true, target: { provider: 'codex', instanceId: WORK }, tab: 'accounts' });
  });

  it('slides four blocks, two accounts of each of two providers, with the arrows as before (C56)', () => {
    const four = [claude({ label: 'Personal' }), claude({ instanceId: WORK, label: 'Work' }), codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })];
    const { container } = show(four, () => layoutOf(4, 700));
    expect(blocks(container)).toHaveLength(4);
    // Aligned right: the first blocks are the hidden ones.
    expect(left()).not.toBeNull();
    expect(right()).toBeNull();
    const start = offset(container);
    fireEvent.click(left() as HTMLElement);
    expect(offset(container)).toBeGreaterThan(start);
    // To the first block: one press a hidden block, three at most.
    for (let presses = 0; presses < 3 && left() !== null; presses += 1) fireEvent.click(left() as HTMLElement);
    expect(left()).toBeNull();
    expect(right()).not.toBeNull();
    fireEvent.click(right() as HTMLElement);
    expect(left()).not.toBeNull();
  });

  it('measures again when an account is added or removed: the geometry is keyed by the pair', () => {
    let calls = 0;
    const measure = () => { calls += 1; return layoutOf(2, 2000); };
    useAppState.setState({ snapshot: sampleSnapshot(1, [codex({ label: 'Personal' })]) });
    render(<UsageStrip measure={measure} />);
    const before = calls;
    act(() => useAppState.setState({ snapshot: sampleSnapshot(2, [codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]) }));
    expect(calls).toBeGreaterThan(before);
  });
});

it('hides missing and initially checking CLIs, while retaining detected sign-in and usage failures', () => {
  useAppState.setState({ snapshot: sampleSnapshot(1, [
    sampleProvider({ id: 'missing', presence: 'missing' }), sampleProvider({ id: 'checking', presence: 'checking' }),
    sampleProvider({ id: 'signed-out', presence: 'present', status: { kind: 'not-logged-in' }, usage: null }),
    sampleProvider({ id: 'usage-error', presence: 'present', status: { kind: 'error', message: 'Usage failed.' }, usage: null }),
  ]) });
  const { container } = render(<UsageStrip measure={() => layoutOf(2, 1000)} />);
  expect([...container.querySelectorAll('[data-usage-block]')].map((element) => element.getAttribute('data-usage-block'))).toEqual(['signed-out', 'usage-error']);
});
