// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSavedPreset, type SavedPreset } from '@shared/contracts/saved-presets';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { prefsSnapshot } from '../test/prefs';
import { showState } from '../test/sessions';
import { PresetsCarousel } from './PresetsCarousel';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const preset = (n: number): SavedPreset => ({ name: `Preset ${n}`, providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null });
const names = () => within(screen.getByRole('region', { name: 'Presets' })).getAllByRole('button').filter((button) => button.hasAttribute('data-preset-id')).map((button) => button.textContent);
const choose = vi.fn<(preset: SavedPreset, id: string) => Promise<boolean>>();
const seed = (count: number, presetRecency: string[] = []) => usePrefs.setState({ snapshot: prefsSnapshot({ presets: Object.fromEntries(Array.from({ length: count }, (_, i) => [id(i), preset(i)])), presetRecency }) });

beforeEach(() => {
  choose.mockReset().mockResolvedValue(true);
  showState({ providers: [sampleProvider({ id: 'codex' }), sampleProvider({ id: 'claude' })], catalog: sampleCatalog(['codex', 'claude']) });
  seed(0);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('saved presets on the start screen', () => {
  it.each([0, 1, 6, 8])('shows at most six of %i presets, with no empty section or unnecessary arrows', (count) => {
    seed(count);
    render(<PresetsCarousel providers={['codex']} busy={false} onChoose={choose} />);
    if (count === 0) expect(screen.queryByRole('region', { name: 'Presets' })).toBeNull();
    else expect(names()).toHaveLength(Math.min(6, count));
    expect(screen.queryByRole('button', { name: 'Show more presets' }) !== null).toBe(count > 6);
  });

  it('keeps the order and page on selection, adopting recency on the next visit', async () => {
    seed(8);
    choose.mockImplementation((_preset, used) => {
      const values = usePrefs.getState().snapshot!.values;
      usePrefs.setState({ snapshot: prefsSnapshot({ presets: values.presets, presetRecency: useSavedPreset(values.presets, values.presetRecency, used) }) });
      return Promise.resolve(true);
    });
    const view = render(<PresetsCarousel providers={['codex']} busy={false} onChoose={choose} />);
    expect(names().map((name) => name?.slice(0, 8))).toEqual(Array.from({ length: 6 }, (_, i) => `Preset ${i}`));
    fireEvent.click(screen.getByRole('button', { name: 'Show more presets' }));
    expect(names()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show previous presets' }));
    expect(names()).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Show more presets' }));
    const before = names();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Preset 7:/ })); await Promise.resolve(); });
    expect(choose).toHaveBeenCalledWith(preset(7), id(7));
    expect(names()).toEqual(before);
    expect(screen.getByRole('button', { name: 'Show previous presets' })).toBeTruthy();
    view.unmount();
    render(<PresetsCarousel providers={['codex']} busy={false} onChoose={choose} />);
    expect(names()[0]).toContain('Preset 7');
    expect(screen.queryByRole('button', { name: 'Show previous presets' })).toBeNull();
  });

  it('keeps unavailable and project-restricted combinations visible and explains why', () => {
    const gone = { ...preset(1), model: 'gone' };
    const restricted = { ...preset(2), providerId: 'claude' };
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [id(1)]: gone, [id(2)]: restricted } }) });
    render(<PresetsCarousel providers={['codex']} busy={false} onChoose={choose} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) { expect(button.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(button); }
    expect(buttons[0]?.title).toContain('hidden or not listed');
    expect(buttons[1]?.title).toContain('This project is not set up');
    expect(choose).not.toHaveBeenCalled();
  });

  it('reduces columns at narrow widths, retains two rows, and clamps after deletion', () => {
    seed(8);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300 } as DOMRect);
    render(<PresetsCarousel providers={['codex']} busy={false} onChoose={choose} />);
    expect(names()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show more presets' }));
    expect(names()[0]).toContain('Preset 2');
    act(() => seed(1));
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain('Preset 0');
  });
});
