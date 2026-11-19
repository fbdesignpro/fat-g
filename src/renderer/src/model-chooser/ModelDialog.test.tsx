// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelPreset } from '@shared/contracts/presets';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { installDialogStandIn } from '../test/dialog';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { ModelDialog, type ModelDialogProps } from './ModelDialog';

const PROJECT = project('Review', { providers: ['codex'] });
const choice = (n = 0, effort = 'high', speed: string | null = null): ModelPreset => ({ providerId: 'codex', instanceId: 'default', model: `model-${n}`, effort, speed });
const savedId = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const saved = (n: number) => ({ ...choice(n), name: `Preset ${n}` });
const confirm = vi.fn<(preset: ModelPreset) => Promise<string | null>>();
const patched = vi.fn();

function Harness({ check }: { readonly check?: ModelDialogProps['check'] }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Review by model</button>{open && <ModelDialog projectId={PROJECT.id} title="Choose reviewer" initial={choice()} confirmLabel="Start review" check={check} onConfirm={confirm} onClose={() => setOpen(false)} />}</>;
}
const dialog = () => screen.getByRole('dialog', { name: 'Choose reviewer' });
const button = (name: string) => within(dialog()).getByRole('button', { name });
const selected = () => dialog().querySelector('[data-model-dialog-selection]')?.textContent;
const column = (name: string) => within(dialog()).getByRole('region', { name });
const entries = (name: string) => column(name).querySelectorAll('[data-preset-id], [data-recent-model]');
const cancelWithEscape = () => fireEvent(dialog(), new Event('cancel', { cancelable: true }));
const open = (check?: ModelDialogProps['check']) => {
  render(<Harness check={check} />);
  const opener = screen.getByRole('button', { name: 'Review by model' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
};
const settle = async (action: () => void) => { await act(async () => { action(); await Promise.resolve(); }); };

beforeEach(() => {
  installDialogStandIn();
  const bridge = installFakeBridge();
  bridge.setInvoke((channel, request) => { patched(channel, request); return Promise.resolve({ ok: true, value: prefsSnapshot({}, undefined, 2) }); });
  confirm.mockReset().mockResolvedValue(null);
  patched.mockReset();
  usePrefs.setState({ snapshot: prefsSnapshot({}), error: null, saving: false });
  showState({ projects: [PROJECT], providers: [sampleProvider({ id: 'codex' })], catalog: { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'codex', models: Array.from({ length: 16 }, (_, n) => sampleModel({ key: `model-${n}`, resolvedId: `model-${n}`, name: `Model ${n}`, listedDefault: n === 0 })) })] } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('two-screen model selection', () => {
  it('shows empty columns and the current selection, then confirms without opening Custom', async () => {
    open();
    expect(column('Presets').textContent).toContain('No presets saved.');
    expect(column('Recent').textContent).toContain('No recent settings.');
    expect(within(column('Custom')).getByRole('button', { name: 'Custom model & effort' })).not.toBeNull();
    expect(within(dialog()).queryByRole('radiogroup', { name: 'Model' })).toBeNull();
    expect(selected()).toBe('Selected: Model 0 · High');
    await settle(() => fireEvent.click(button('Start review')));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(choice());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('expands each column six at a time, filters recents and retains expansion after Custom', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: Object.fromEntries(Array.from({ length: 14 }, (_, n) => [savedId(n), saved(n)])), presetRecency: [savedId(13)], recentModels: [choice(), ...Array.from({ length: 10 }, (_, n) => choice(n, 'low'))] }) });
    open();
    expect(entries('Presets')).toHaveLength(6);
    expect(entries('Recent')).toHaveLength(6);
    expect(entries('Presets')[0]?.textContent).toContain('Preset 13');
    expect([...entries('Recent')].every((entry) => entry.textContent?.includes('Low'))).toBe(true);
    fireEvent.click(button('Show more presets'));
    expect(entries('Presets')).toHaveLength(12);
    expect(entries('Recent')).toHaveLength(6);
    fireEvent.click(button('Show more recent settings'));
    expect(entries('Recent')).toHaveLength(10);
    fireEvent.click(button('Show more presets'));
    expect(entries('Presets')).toHaveLength(14);
    expect(within(column('Presets')).queryByRole('button', { name: 'Show more presets' })).toBeNull();
    fireEvent.click(button('Custom model & effort'));
    expect(within(dialog()).queryByRole('region', { name: 'Presets' })).toBeNull();
    fireEvent.click(button('Cancel'));
    expect(entries('Presets')).toHaveLength(14);
    expect(entries('Recent')).toHaveLength(10);
    expect(document.activeElement).toBe(button('Custom model & effort'));
  });

  it.each(['Cancel', 'Escape'])('discards Custom edits on %s, restoring the selected preset and its speed', (how) => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [savedId(1)]: { ...saved(1), speed: 'priority' } } }) });
    const opener = open();
    fireEvent.click(button('Preset 1: Model 1 · High - ⚡Fast'));
    fireEvent.click(button('Custom model & effort'));
    expect(document.activeElement?.getAttribute('data-model')).toBe('model-1');
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Model 2' }));
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Low' }));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /Fast/ }));
    expect(selected()).toBe('Selected: Model 2 · Low');
    if (how === 'Escape') cancelWithEscape(); else fireEvent.click(button('Cancel'));
    expect(selected()).toBe('Selected: Model 1 · High - ⚡Fast');
    expect(confirm).not.toHaveBeenCalled();
    expect(patched).not.toHaveBeenCalled();
    fireEvent.click(button('Custom model & effort'));
    expect(within(dialog()).getByRole('radio', { name: 'Model 1' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog()).getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog()).getByRole<HTMLInputElement>('checkbox', { name: /Fast/ }).checked).toBe(true);
    cancelWithEscape();
    cancelWithEscape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('confirms custom choices and does not credit a different saved preset', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [savedId(1)]: saved(1) } }) });
    open();
    fireEvent.click(button('Preset 1: Model 1 · High'));
    fireEvent.click(button('Custom model & effort'));
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Model 2' }));
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Low' }));
    await settle(() => fireEvent.click(button('Start review')));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(choice(2, 'low'));
    expect(patched).not.toHaveBeenCalled();
  });

  it('discards Custom provider and account changes, including the remembered account on reopening', () => {
    const work = savedId(99);
    showState({ projects: [{ ...PROJECT, providers: ['codex', 'claude'] }], providers: [sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Personal' }), sampleProvider({ id: 'codex', displayName: 'Codex', instanceId: work, label: 'Work' }), sampleProvider({ id: 'claude', displayName: 'Claude' })], catalog: { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'model-0', name: 'Model 0' })] }), sampleCatalogProvider({ id: 'codex', instanceId: work }), sampleCatalogProvider({ id: 'claude', models: [sampleModel({ name: 'Other provider' })] })] } });
    open();
    fireEvent.click(button('Custom model & effort'));
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Work' }));
    expect(within(dialog()).getByRole('radio', { name: 'Work' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Other provider' }));
    fireEvent.click(button('Cancel'));
    expect(selected()).toBe('Selected: Model 0 · High (Personal)');
    fireEvent.click(button('Custom model & effort'));
    expect(within(dialog()).getByRole('radio', { name: 'Personal' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog()).getByRole('radio', { name: 'Model 0' }).getAttribute('aria-checked')).toBe('true');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('touches preset recency only after a successful confirmation', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [savedId(1)]: saved(1) } }) });
    confirm.mockResolvedValueOnce('Try another account.');
    open();
    fireEvent.click(button('Preset 1: Model 1 · High'));
    expect(confirm).not.toHaveBeenCalled();
    expect(patched).not.toHaveBeenCalled();
    await settle(() => fireEvent.click(button('Start review')));
    expect(within(dialog()).getByRole('alert').textContent).toBe('Try another account.');
    expect(patched).not.toHaveBeenCalled();
    await settle(() => fireEvent.click(button('Start review')));
    expect(patched).toHaveBeenCalledExactlyOnceWith('prefs:patch', { usePreset: savedId(1) });
  });

  it('keeps unavailable presets visible and excludes unavailable recents', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [savedId(1)]: { ...saved(1), model: 'gone' } }, recentModels: [choice(2), { ...choice(3), model: 'gone' }] }) });
    open();
    const unavailable = within(column('Presets')).getByRole('button');
    expect(unavailable.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(unavailable);
    expect(selected()).toBe('Selected: Model 0 · High');
    expect(entries('Recent')).toHaveLength(1);
    fireEvent.click(within(column('Recent')).getByRole('button'));
    expect(selected()).toBe('Selected: Model 2 · High');
  });

  it('blocks confirmation in both screens and rechecks the custom selection', async () => {
    open((preset) => preset.model === 'model-0' ? 'Reading mode unavailable.' : null);
    expect(button('Start review').getAttribute('aria-disabled')).toBe('true');
    await settle(() => fireEvent.click(button('Start review')));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(button('Custom model & effort'));
    expect(within(dialog()).getByRole('status').textContent).toBe('Reading mode unavailable.');
    await settle(() => fireEvent.click(button('Start review')));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Model 1' }));
    await settle(() => fireEvent.click(button('Start review')));
    expect(confirm).toHaveBeenCalledExactlyOnceWith(choice(1));
  });

  it.each([false, true])('prevents duplicate confirmation and closing while pending (custom: %s)', async (custom) => {
    let finish!: (value: string | null) => void;
    confirm.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    open();
    if (custom) fireEvent.click(button('Custom model & effort'));
    const start = button('Start review');
    fireEvent.click(start);
    fireEvent.click(start);
    cancelWithEscape();
    expect(button('Cancel').hasAttribute('disabled')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(dialog()).not.toBeNull();
    await act(async () => { finish('Still here.'); await Promise.resolve(); });
    expect(within(dialog()).getByRole('alert').textContent).toBe('Still here.');
    expect(button('Cancel').hasAttribute('disabled')).toBe(false);
  });
});
