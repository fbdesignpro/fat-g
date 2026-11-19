// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { ProviderPresentation } from '@shared/contracts/catalog';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { ProviderStatus } from '@shared/contracts/status';
import { SAMPLE_EMAIL, sampleProvider, sampleWindow } from '../../../../tests/support/app-state';
import { SAMPLE_PRESENTATION } from '../../../../tests/support/catalog';
import { closeSettings, useSettings } from '../settings/settings-store';
import { usePrefs } from '../state/prefs-store';
import { installFakeBridge } from '../test/fake-bridge';
import { ProviderMark } from './ProviderMark';
import { MAX_BARS, UsageBlock } from './UsageBlock';

beforeEach(() => {
  installFakeBridge();
  usePrefs.setState({ snapshot: null, error: null, saving: false });
  closeSettings();
});
afterEach(cleanup);

const block = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector<HTMLElement>('[data-usage-block]');
  if (element === null) throw new Error('no usage block');
  return element;
};
const fills = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="meter"] span span')];

describe('bars', () => {
  it('draws one bar per usage window, in the provider’s order, each a labelled meter', () => {
    render(<UsageBlock provider={sampleProvider({ usage: { windows: [
      sampleWindow({ id: 'five-hour', label: '5-hour', usedPercent: 62 }),
      sampleWindow({ id: 'weekly', label: 'Weekly', usedPercent: 14 }),
      sampleWindow({ id: 'weekly-model:fable', label: 'Weekly', scope: 'Fable', usedPercent: 23 }),
    ] } })} />);
    const meters = screen.getAllByRole('meter');
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual(['5-hour usage', 'Weekly usage', 'Weekly, Fable usage']);
    // A model's own limit is labelled with the model, as in the mockup.
    expect(screen.getByText('Fable')).toBeTruthy();
    // No percentage is written (M100, C55): the meter and the panel say it.
    expect(document.body.textContent).not.toMatch(/\d+%/);
    // Each bar is its label, its track and its countdown (C85).
    expect(meters.map((meter) => meter.parentElement?.children.length)).toEqual([3, 3, 3]);
  });

  // M100 (C85): after each track, how long until the window resets, tightly, counting from the clock.
  describe('the countdown', () => {
    const NOW = Date.UTC(2020, 1, 6, 12, 0, 0);
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());
    const countdowns = (container: HTMLElement) => [...container.querySelectorAll('[data-reset-countdown]')].map((element) => element.textContent);

    it('says how long until each window resets, in days and hours, hours and minutes with no "m", or minutes', () => {
      const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [
        sampleWindow({ id: 'five-hour', label: '5-hour', usedPercent: 62, resetsAt: NOW + (3 * 3600 + 32 * 60) * 1000 }),
        sampleWindow({ id: 'weekly', label: 'Weekly', usedPercent: 14, resetsAt: NOW + (5 * 86_400 + 5 * 3600 + 59 * 60) * 1000 }),
        sampleWindow({ id: 'weekly-model:fable', label: 'Weekly', scope: 'Fable', usedPercent: null, resetsAt: NOW + 32 * 60 * 1000 }),
      ] } })} />);
      expect(countdowns(container)).toEqual(['3h32', '5d5h', '32m']);
      // No percentage joins it (C55).
      expect(container.textContent).not.toMatch(/\d+%/);
    });

    it('leaves out a countdown that would repeat the bar’s above, and keeps one that repeats an earlier bar’s', () => {
      const weekly = NOW + (5 * 86_400 + 5 * 3600) * 1000;
      const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [
        sampleWindow({ id: 'weekly', label: 'Weekly', resetsAt: weekly }),
        sampleWindow({ id: 'weekly-model:fable', label: 'Weekly', scope: 'Fable', resetsAt: weekly + 40_000 }),
        sampleWindow({ id: 'five-hour', label: '5-hour', resetsAt: NOW + 3 * 3600 * 1000 }),
      ] } })} />);
      expect(countdowns(container)).toEqual(['5d5h', '', '3h00']);
      const { container: apart } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [
        sampleWindow({ id: 'weekly', label: 'Weekly', resetsAt: weekly }),
        sampleWindow({ id: 'five-hour', label: '5-hour', resetsAt: NOW + 3 * 3600 * 1000 }),
        sampleWindow({ id: 'weekly-model:fable', label: 'Weekly', scope: 'Fable', resetsAt: weekly }),
      ] } })} />);
      expect(countdowns(apart)).toEqual(['5d5h', '3h00', '5d5h']);
    });

    it('keeps the column and says nothing where the provider gives no reset time, and "now" once it has passed', () => {
      const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [
        sampleWindow({ id: 'a', label: 'Weekly', resetsAt: null }),
        sampleWindow({ id: 'b', label: '5-hour', resetsAt: NOW - 1000 }),
      ] } })} />);
      expect(countdowns(container)).toEqual(['', 'now']);
    });

    it('counts down as the clock runs', () => {
      const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [sampleWindow({ resetsAt: NOW + 2 * 60 * 1000 })] } })} />);
      expect(countdowns(container)).toEqual(['2m']);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(countdowns(container)).toEqual(['1m']);
    });
  });

  it(`shows ${MAX_BARS} bars at most, the first ones in the provider’s order (C34)`, () => {
    const windows = ['a', 'b', 'c', 'd', 'e'].map((id, index) => sampleWindow({ id, label: `Window ${id}`, usedPercent: index * 10 }));
    render(<UsageBlock provider={sampleProvider({ usage: { windows } })} />);
    expect(screen.getAllByRole('meter').map((meter) => meter.getAttribute('aria-label'))).toEqual(['Window a usage', 'Window b usage', 'Window c usage']);
  });

  // M100 (C55, V17): the bar, the meter and its words show the share that remains, as the note above the box says.
  it.each([
    [0, '100', '100 percent remaining'],
    [62, '38', '38 percent remaining'],
    [62.4, '37.6', '38 percent remaining'],
    [100, '0', '0 percent remaining'],
    [-5, '100', '100 percent remaining'],
    [130, '0', '0 percent remaining'],
  ])('keeps meter semantics for %s%% used, at the share that remains, clamped to 0–100 (C35, C60; M100, C55)', (used, now, valueText) => {
    const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [sampleWindow({ label: 'Weekly', usedPercent: used })] } })} />);
    const meter = screen.getByRole('meter', { name: 'Weekly usage' });
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    expect(meter.getAttribute('aria-valuenow')).toBe(now);
    expect(meter.getAttribute('aria-valuetext')).toBe(valueText);
    expect(container.textContent).not.toContain('%');
    // The fill starts at the 0 % mark and is as wide as what remains; both end marks are the track's own.
    expect(fills(container)[0]?.style.width).toBe(`${now}%`);
  });

  it('says "No data" between the marks for a window with no data, never 0 % (C62)', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [sampleWindow({ label: 'Weekly', usedPercent: null })] } })} />);
    const meter = screen.getByRole('meter', { name: 'Weekly usage' });
    expect(meter.hasAttribute('aria-valuenow')).toBe(false);
    expect(meter.getAttribute('aria-valuetext')).toBe('No data');
    expect(within(meter).getByText('No data')).toBeTruthy();
    expect(container.textContent).not.toContain('0%');
    expect(fills(container)).toHaveLength(0);
  });

  it('fills, and marks its ends, in the provider’s own colour, from its catalog entry (C36; M13, C21; M100, C55)', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ id: 'codex', displayName: 'Codex' })} presentation={{ barColor: '#1991e2', icon: { viewBox: '0 0 24 24', path: 'M2 2H22Z' } }} />);
    expect(block(container).style.getPropertyValue('--bar-color')).toBe('#1991e2');
  });

  // M100 (C69): the module's logo when it has one, decorative; otherwise its mark on its colour.
  it('draws the provider’s logo, or its mark on its colour without one', () => {
    const logo = 'data:image/png;base64,iVBORw0KGgo=';
    const { container, unmount } = render(<UsageBlock provider={sampleProvider()} presentation={{ ...SAMPLE_PRESENTATION, logo }} />);
    const image = container.querySelector('img') as HTMLImageElement;
    expect([image.getAttribute('src'), image.getAttribute('alt')]).toEqual([logo, '']);
    expect(container.querySelector('[data-logo-stand-in]')).toBeNull();
    unmount();
    const { container: bare } = render(<UsageBlock provider={sampleProvider()} presentation={SAMPLE_PRESENTATION} />);
    expect(bare.querySelector('img')).toBeNull();
    expect(bare.querySelector('[data-logo-stand-in] svg path')?.getAttribute('fill')).toBe('var(--color-on-avatar)');
  });

  it('draws no mark and sets no colour before the catalog arrives, and keeps its name', () => {
    const { container } = render(<UsageBlock provider={sampleProvider()} />);
    expect(block(container).style.getPropertyValue('--bar-color')).toBe('');
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'Claude' })).toBeTruthy();
  });
});

describe('historical readings (C66)', () => {
  it.each([
    ['stale', { kind: 'stale' }, 'Usage stale'],
    ['updating after a wake', { kind: 'waking' }, 'Updating after machine sleep'],
    ['error with readings', { kind: 'error', message: 'Usage query failed.' }, 'Usage query failed.'],
  ] as const)('draw the fill hollow when %s, and explain why beside the account label', (_name, status: ProviderStatus, caption) => {
    const { container } = render(<UsageBlock provider={sampleProvider({ status, usage: { windows: [sampleWindow({ label: 'Weekly', usedPercent: 40 })] } })} label="Work" />);
    expect(fills(container)[0]?.hasAttribute('data-hollow')).toBe(true);
    expect(screen.getByRole('meter', { name: 'Weekly usage' }).getAttribute('aria-valuetext')).toBe('60 percent remaining, historical reading');
    expect(container.querySelector('[data-usage-status]')?.textContent).toBe(caption);
    expect(block(container).hasAttribute('data-historical')).toBe(true);
    expect(container.querySelector('[data-account-label]')?.textContent).toBe('Work');
  });

  it('updates the reason under the bars when waking gives way to a failed usage query', () => {
    const usage = { windows: [sampleWindow({ label: 'Weekly', usedPercent: 40 })] };
    const { container, rerender } = render(<UsageBlock provider={sampleProvider({ status: { kind: 'waking' }, usage })} />);
    expect(container.querySelector('[data-usage-status]')?.textContent).toBe('Updating after machine sleep');
    // The bars stay: the caption is beside them, not in place of them.
    expect(screen.getByRole('meter', { name: 'Weekly usage' })).toBeTruthy();
    rerender(<UsageBlock provider={sampleProvider({ status: { kind: 'error', message: 'Usage query failed.' }, usage })} />);
    expect(container.querySelector('[data-usage-status]')?.textContent).toBe('Usage query failed.');
    expect(container.querySelector('[data-usage-status]')?.getAttribute('title')).toBe('Usage query failed.');
  });

  it('draw a fresh reading solid', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [sampleWindow({ usedPercent: 40 })] } })} />);
    expect(fills(container)[0]?.hasAttribute('data-hollow')).toBe(false);
    expect(container.querySelector('[data-usage-status]')).toBeNull();
  });
});

describe('a provider with no usage to show (C39)', () => {
  it.each([
    [{ kind: 'blocked', reason: 'preferences-unavailable' }, 'Preferences unavailable'],
    [{ kind: 'blocked', reason: 'invalid-preferences' }, 'Preferences need repair'],
    [{ kind: 'detecting' }, 'Checking usage'],
    [{ kind: 'not-installed', overrideInvalid: false }, 'CLI not found'],
    [{ kind: 'not-installed', overrideInvalid: true }, 'Selected CLI unavailable'],
    [{ kind: 'not-logged-in' }, 'Sign-in needed'],
    [{ kind: 'not-applicable', reason: 'api-key' }, 'Usage not applicable'],
    [{ kind: 'not-applicable', reason: 'cloud-provider' }, 'Usage not applicable'],
    [{ kind: 'not-applicable', reason: 'unsupported-cli-version' }, 'Usage not applicable'],
    [{ kind: 'not-applicable', reason: 'usage-unavailable' }, 'Usage not applicable'],
    [{ kind: 'ok' }, 'Usage unavailable'],
    [{ kind: 'stale' }, 'Usage stale'],
    [{ kind: 'waking' }, 'Updating after machine sleep'],
    [{ kind: 'error', message: 'The CLI could not be started.' }, 'Usage error'],
  ] as readonly (readonly [ProviderStatus, string])[])('shows one track with a short status for $kind', (status, label) => {
    const { container } = render(<UsageBlock provider={sampleProvider({ status, usage: null, asOf: null })} />);
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(block(container).textContent).toBe(label);
  });

  it('says it is detecting only until the CLI is found (M13, C89)', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ status: { kind: 'detecting' }, installation: null, usage: null, asOf: null })} />);
    expect(block(container).textContent).toBe('Detecting CLI');
  });

  it('treats a usage reading with no windows like no usage', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ usage: { windows: [] } })} />);
    expect(block(container).textContent).toBe('Usage unavailable');
  });
});

describe('the block', () => {
  it('is named after the provider, and shows its mark from the catalog (C54; M13, C21)', () => {
    const { container } = render(<UsageBlock provider={sampleProvider()} presentation={SAMPLE_PRESENTATION} />);
    const button = screen.getByRole('button', { name: 'Claude' });
    const mark = button.querySelector('svg');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.querySelector('path')?.getAttribute('d')).toBe(SAMPLE_PRESENTATION.icon.path);
    expect(block(container).style.getPropertyValue('--bar-color')).toBe(SAMPLE_PRESENTATION.barColor);
  });

  it('reads nothing of the look from the descriptor, which has none (V5)', () => {
    expectTypeOf<ProviderDescriptor>().not.toHaveProperty('presentation');
    expectTypeOf<ProviderDescriptor>().not.toHaveProperty('documentationLinkId');
  });

  // M14b, V11 (C40, C41): a block with its account's label, and one without.
  it('shows no label and keeps the provider’s name alone when it is given none', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Default' })} />);
    expect(container.querySelector('[data-account-label]')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Codex');
  });

  it('shows the label it is given on one line of its own, and adds it to the button’s name', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Work' })} label="Work" />);
    expect(container.querySelectorAll('[data-account-label]')).toHaveLength(1);
    expect(container.querySelector('[data-account-label]')?.textContent).toBe('Work');
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Codex · Work');
    // The label is not the account's identity: no email, no organization.
    expect(block(container).textContent).not.toContain(SAMPLE_EMAIL);
  });

  it('keeps its label line when it has no usage to show', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ id: 'codex', displayName: 'Codex', status: { kind: 'not-logged-in' }, usage: null })} label="Work" />);
    expect(container.querySelector('[data-account-label]')?.textContent).toBe('Work');
    expect(block(container).textContent).toContain('Sign-in needed');
  });

  it('never shows who the account belongs to (C42)', () => {
    const { container } = render(<UsageBlock provider={sampleProvider()} />);
    expect(block(container).textContent).not.toContain(SAMPLE_EMAIL);
    expect(block(container).textContent).not.toContain('@');
    expect(block(container).textContent).not.toContain('max');
  });

  it('opens Settings at its own account of its provider, from the pointer anywhere on it or from the keyboard (C41; M14b, C38)', () => {
    const { container } = render(<UsageBlock provider={sampleProvider({ id: 'codex', displayName: 'Codex' })} />);
    fireEvent.click(block(container));
    expect(useSettings.getState()).toEqual({ open: true, target: { provider: 'codex', instanceId: 'default' }, tab: 'accounts' });
    closeSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    expect(useSettings.getState()).toEqual({ open: true, target: { provider: 'codex', instanceId: 'default' }, tab: 'accounts' });
  });
});

describe('ProviderMark (C65)', () => {
  const presentation: ProviderPresentation = { barColor: '#ff9933', icon: { viewBox: '0 0 24 24', path: 'M5 3H19V17H5Z' } };

  it('draws the catalog’s path data inline, in the bar colour, as an image named after the provider', () => {
    const { container } = render(<ProviderMark name="Claude" presentation={presentation} />);
    const svg = screen.getByRole('img', { name: 'Claude' });
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    const path = svg.querySelector('path');
    expect(path?.getAttribute('d')).toBe('M5 3H19V17H5Z');
    expect(path?.getAttribute('fill')).toBe('#ff9933');
    expect(path?.getAttribute('fill-rule')).toBe('evenodd');
    expect(container.querySelector('img, image, use')).toBeNull();
  });

  it('can stay out of the accessibility tree where the name is written beside it', () => {
    const { container } = render(<ProviderMark name="Claude" presentation={presentation} decorative />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('never turns path data into markup', () => {
    const hostile: ProviderPresentation = { barColor: '#ff9933', icon: { viewBox: '0 0 24 24', path: '"/><script>alert(1)</script>' } };
    const { container } = render(<ProviderMark name="Claude" presentation={hostile} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('path')?.getAttribute('d')).toBe('"/><script>alert(1)</script>');
  });
});
