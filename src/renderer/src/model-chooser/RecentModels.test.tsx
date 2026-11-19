// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelPreset } from '@shared/contracts/presets';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { prefsSnapshot } from '../test/prefs';
import { showState } from '../test/sessions';
import { RecentModels } from './RecentModels';

const choice = (effort: string | null = 'high', speed: string | null = null): ModelPreset => ({ providerId: 'codex', instanceId: 'default', model: 'sample-1', effort, speed });
const choices = () => within(screen.getByRole('region', { name: 'Recent' })).getAllByRole('button');
const choose = vi.fn<(preset: ModelPreset) => Promise<boolean>>();
const seed = (recentModels: ModelPreset[]) => usePrefs.setState({ snapshot: prefsSnapshot({ recentModels }) });
beforeEach(() => {
  choose.mockReset().mockResolvedValue(true);
  showState({ providers: [sampleProvider({ id: 'codex' }), sampleProvider({ id: 'claude' })], catalog: sampleCatalog(['codex', 'claude']) });
  seed([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('recent model capsules', () => {
  it('hides an empty or wholly unavailable section', () => {
    render(<RecentModels providers={['codex']} busy={false} selection={null} onChoose={choose} />);
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
    act(() => seed([{ ...choice(), model: 'gone' }, { ...choice(), providerId: 'claude' }]));
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
  });

  it('filters unavailable choices before taking the newest three, without arrows', async () => {
    const valid = [choice('low'), choice('high'), { ...choice('low'), providerId: 'claude' }, { ...choice(), providerId: 'claude' }];
    seed([{ ...choice(), model: 'gone' }, { ...choice(), instanceId: '11111111-2222-4333-8444-555555555555' }, { ...choice(), effort: 'gone' }, ...valid]);
    render(<RecentModels providers={['codex', 'claude']} busy={false} selection={valid[1]!} onChoose={choose} />);
    expect(choices()).toHaveLength(3);
    expect(choices()[0]?.parentElement?.style.maxWidth).toBe('696px');
    expect(choices().map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    expect(choices().map((button) => button.textContent)).toEqual(['Sample OneLow', 'Sample OneHigh', 'Sample OneLow']);
    await act(async () => { fireEvent.click(choices()[0]!); await Promise.resolve(); });
    expect(choose).toHaveBeenCalledWith(valid[0]);
    expect(usePrefs.getState().snapshot?.values.recentModels).toHaveLength(7);
  });

  it('responds to width changes without wrapping or exposing older choices', () => {
    seed([choice('low'), choice('high'), { ...choice(), providerId: 'claude' }]);
    let width = 900;
    let resize = () => {};
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    render(<RecentModels providers={['codex', 'claude']} busy={false} selection={null} onChoose={choose} />);
    expect(choices()).toHaveLength(3);
    act(() => { width = 600; resize(); });
    expect(choices()).toHaveLength(2);
    act(() => { width = 300; resize(); });
    expect(choices()).toHaveLength(1);
    act(() => { width = 900; resize(); });
    expect(choices()).toHaveLength(3);
  });

  it('fills the row with non-presets and updates when presets change, retaining history', () => {
    const saved = choice();
    const recentModels = [saved, choice('low'), choice('high', 'priority'), { ...choice(), providerId: 'claude' }];
    const id = '11111111-2222-4333-8444-555555555555';
    usePrefs.setState({ snapshot: prefsSnapshot({ recentModels, presets: { [id]: { ...saved, name: 'Careful' } } }) });
    render(<RecentModels providers={['codex', 'claude']} busy={false} selection={saved} onChoose={choose} />);
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeTruthy();
    expect(choices()).toHaveLength(3);
    expect(choices().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(choices()[0]?.textContent).toBe('Sample OneLow');
    expect(choices()[2]?.textContent).toBe('Sample OneHigh');
    act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ recentModels,
      presets: Object.fromEntries(recentModels.map((preset, i) => [`11111111-2222-4333-8444-${String(i).padStart(12, '0')}`, { ...preset, name: `Saved ${i}` }])) }) }); });
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
    expect(usePrefs.getState().snapshot?.values.recentModels).toEqual(recentModels);
    act(() => seed(recentModels));
    expect(choices()).toHaveLength(3);
    expect(choices()[0]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not apply while a selection is being saved', () => {
    seed([choice()]);
    render(<RecentModels providers={['codex']} busy selection={null} onChoose={choose} />);
    fireEvent.click(choices()[0]!);
    expect(choose).not.toHaveBeenCalled();
  });

  it('updates availability live without deleting unavailable choices from history', () => {
    seed([choice(), { ...choice('low'), providerId: 'claude' }]);
    render(<RecentModels providers={['codex', 'claude']} busy={false} selection={null} onChoose={choose} />);
    expect(choices()).toHaveLength(2);
    act(() => { showState({ providers: [sampleProvider({ id: 'codex', status: { kind: 'disabled' } }), sampleProvider({ id: 'claude' })], catalog: sampleCatalog(['codex', 'claude']) }); });
    expect(choices()).toHaveLength(1);
    expect(choices()[0]?.textContent).toBe('Sample OneLow');
    expect(usePrefs.getState().snapshot?.values.recentModels).toHaveLength(2);
    act(() => { showState({ providers: [sampleProvider({ id: 'codex' }), sampleProvider({ id: 'claude' })], catalog: sampleCatalog(['codex', 'claude']) }); });
    expect(choices()).toHaveLength(2);
  });

  it('visibly distinguishes accounts when a provider has more than one', () => {
    const work = '11111111-2222-4333-8444-555555555555';
    const catalog = sampleCatalog(['codex']);
    showState({ providers: [sampleProvider({ id: 'codex', label: 'Personal' }), sampleProvider({ id: 'codex', instanceId: work, label: 'Work' })],
      catalog: { ...catalog, providers: [...catalog.providers, { ...catalog.providers[0]!, instanceId: work }] } });
    seed([choice(), { ...choice(), instanceId: work }]);
    render(<RecentModels providers={['codex']} busy={false} selection={null} onChoose={choose} />);
    expect(choices().map((button) => button.textContent)).toEqual(['Sample OneHigh (Personal)', 'Sample OneHigh (Work)']);
  });
});
