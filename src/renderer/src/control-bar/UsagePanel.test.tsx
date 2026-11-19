// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { SAMPLE_EMAIL, sampleProvider, sampleWindow } from '../../../../tests/support/app-state';
import { closeSettings } from '../settings/settings-store';
import { usePrefs } from '../state/prefs-store';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { UsageBlock } from './UsageBlock';

beforeEach(() => {
  installFakeBridge();
  usePrefs.setState({ snapshot: null, error: null, saving: false });
  closeSettings();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderBlock = (provider: ProviderSnapshot = sampleProvider()) => {
  const view = render(<UsageBlock provider={provider} />);
  const element = view.container.querySelector<HTMLElement>('[data-usage-block]');
  if (element === null) throw new Error('no usage block');
  return { ...view, block: element, button: screen.getByRole('button', { name: provider.displayName }) };
};
const panel = () => screen.queryByRole('tooltip');

describe('opening and closing (C45, C57)', () => {
  it('opens on rollover, below its block, and closes when the pointer leaves', () => {
    const { block, button } = renderBlock();
    expect(panel()).toBeNull();
    fireEvent.pointerEnter(block);
    expect(panel()).not.toBeNull();
    expect(button.getAttribute('aria-describedby')).toBe(panel()?.id);
    fireEvent.pointerLeave(block);
    expect(panel()).toBeNull();
  });

  it('opens when the block takes keyboard focus, and closes on blur', () => {
    const { button } = renderBlock();
    fireEvent.focus(button);
    expect(panel()).not.toBeNull();
    fireEvent.blur(button);
    expect(panel()).toBeNull();
  });

  it('closes on Escape, until the pointer comes back', () => {
    const { block } = renderBlock();
    fireEvent.pointerEnter(block);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel()).toBeNull();
    fireEvent.pointerLeave(block);
    fireEvent.pointerEnter(block);
    expect(panel()).not.toBeNull();
  });

  it('closes when the block opens Settings', () => {
    const { block } = renderBlock();
    fireEvent.pointerEnter(block);
    fireEvent.click(block);
    expect(panel()).toBeNull();
  });

  it('holds nothing that can take the focus, and lets the pointer through', () => {
    const { block } = renderBlock(sampleProvider({ status: { kind: 'not-logged-in' }, usage: null }));
    fireEvent.pointerEnter(block);
    expect(panel()?.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
    expect(panel()?.parentElement).toBe(document.body);
  });

  it('runs its clock only while open', () => {
    vi.useFakeTimers();
    const { block } = renderBlock();
    // The block's countdowns tick on the page's one session clock (M100, C85); the panel's own interval comes and goes with it.
    const before = vi.getTimerCount();
    expect(before).toBeLessThanOrEqual(1);
    fireEvent.pointerEnter(block);
    expect(vi.getTimerCount()).toBe(before + 1);
    fireEvent.pointerLeave(block);
    expect(vi.getTimerCount()).toBe(before);
  });
});

// M14b, V11 (C42): the heading with an account's label, and without.
describe('the heading (M14b, C42)', () => {
  const heading = () => panel()?.firstElementChild?.textContent;

  it('is the provider’s name alone for a block that shows no label', () => {
    const { block } = renderBlock();
    fireEvent.pointerEnter(block);
    expect(heading()).toBe('Claude');
  });

  it('adds the account’s label when its block shows one', () => {
    const view = render(<UsageBlock provider={sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Work' })} label="Work" />);
    fireEvent.pointerEnter(view.container.querySelector('[data-usage-block]') as HTMLElement);
    expect(heading()).toBe('Codex · Work');
  });
});

describe('what it shows (C45)', () => {
  const open = (provider: ProviderSnapshot): HTMLElement => {
    const { block } = renderBlock(provider);
    fireEvent.pointerEnter(block);
    const element = panel();
    if (element === null) throw new Error('the panel did not open');
    return element;
  };

  it('shows the provider, plan, account, CLI version, status, every window with its reset, and the refresh times', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-20T12:00:00Z'));
    const now = Date.now();
    const provider = sampleProvider({
      installation: { source: 'path', version: '2.1.268' },
      usage: { windows: [
        sampleWindow({ id: 'five-hour', label: '5-hour', usedPercent: 62, resetsAt: now + 2 * 3600_000 + 3 * 60_000 }),
        sampleWindow({ id: 'weekly', label: 'Weekly', usedPercent: 14 }),
        sampleWindow({ id: 'weekly-model:fable', label: 'Weekly', scope: 'Fable', usedPercent: null, resetsAt: null }),
        sampleWindow({ id: 'other', label: 'Monthly', usedPercent: 5 }),
      ] },
      asOf: now - 60_000,
      nextRefreshAt: now + 4 * 60_000,
    });
    const text = open(provider).textContent;
    for (const expected of ['Claude', 'Plan', 'max', 'Account', 'u•••@example.com', 'CLI', '2.1.268', 'Status', 'Up to date',
      '5-hour', '38% remaining', 'Resets in 2h 3m', 'Weekly · Fable', 'No data', 'Reset time unknown', 'Monthly', 'Last refresh', 'Next check', 'in 4m']) {
      expect(text).toContain(expected);
    }
  });

  it.each([
    [{ kind: 'not-logged-in' }, 'Sign-in needed', 'Sign-in is the CLI'],
    [{ kind: 'not-installed', overrideInvalid: false }, 'CLI not found', 'Install the CLI.'],
    [{ kind: 'not-applicable', reason: 'api-key' }, 'Usage not applicable', 'uses an API key'],
    [{ kind: 'blocked', reason: 'preferences-unavailable' }, 'Preferences unavailable', 'Settings says why'],
    [{ kind: 'error', message: 'The CLI version check failed.' }, 'Usage error', 'The CLI version check failed.'],
  ] as const)('says what $kind means and what to do, without a button', (status, label, guidance) => {
    const element = open(sampleProvider({ status, usage: null, asOf: null }));
    expect(element.textContent).toContain(label);
    expect(element.textContent).toContain(guidance);
    expect(element.textContent).toContain('Never');
  });

  it('marks stale readings as historical', () => {
    const element = open(sampleProvider({ status: { kind: 'stale' }, usage: { windows: [sampleWindow({ usedPercent: 30 })] } }));
    expect(element.textContent).toContain('Historical reading');
    expect(element.textContent).toContain('These readings are historical');
  });

  it('marks the readings a wake has not confirmed yet, and says why (0001)', () => {
    const element = open(sampleProvider({ status: { kind: 'waking' }, usage: { windows: [sampleWindow({ usedPercent: 30 })] } }));
    expect(element.textContent).toContain('Updating after machine sleep');
    expect(element.textContent).toContain('Historical reading');
    expect(element.textContent).toContain('These readings are from before it slept');
  });

  it('masks the email before the preferences have loaded, and while the preference is on', () => {
    expect(open(sampleProvider()).textContent).not.toContain(SAMPLE_EMAIL);
    cleanup();
    usePrefs.setState({ snapshot: prefsSnapshot({ privacy: { maskEmail: true } }) });
    expect(open(sampleProvider()).textContent).not.toContain(SAMPLE_EMAIL);
  });

  it('shows the email in full when the preference is off, and masks it again the moment it goes back on', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ privacy: { maskEmail: false } }) });
    const element = open(sampleProvider());
    expect(element.textContent).toContain(SAMPLE_EMAIL);
    act(() => usePrefs.setState({ snapshot: prefsSnapshot({ privacy: { maskEmail: true } }, { kind: 'ok' }, 2) }));
    expect(panel()?.textContent).not.toContain(SAMPLE_EMAIL);
  });

  it('leaves out what the provider does not report', () => {
    const element = open(sampleProvider({ account: null, installation: null, usage: null, status: { kind: 'detecting' } }));
    expect([...element.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Status', 'Last refresh']);
    expect(element.querySelector('ul')).toBeNull();
  });
});
