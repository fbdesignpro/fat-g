// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPatch, type PreferencesPatch } from '@shared/contracts/prefs';
import type { SavedPreset } from '@shared/contracts/saved-presets';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import { sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { PresetsSection } from './PresetsSection';

const ID = '11111111-2222-4333-8444-555555555555';
const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const preset: SavedPreset = { name: 'Careful', providerId: 'claude', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null };
let patches: PreferencesPatch[];
let channels: string[];
let fail: boolean;

beforeEach(() => {
  patches = []; channels = []; fail = false;
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  useAppState.setState({ snapshot: { ...sampleSnapshot(1, [sampleProvider(), sampleProvider({ instanceId: WORK, label: 'Work' })]), catalog: sampleCatalog(['claude'], {
    providers: [sampleCatalogProvider({ models: [sampleModel(), sampleModel({ key: 'simple', name: 'Simple', efforts: [], listedDefaultEffort: null })] }), sampleCatalogProvider({ instanceId: WORK, models: [sampleModel({ efforts: [{ id: 'low', label: 'Low', place: 1, caution: false }] })] })],
  }) }, error: null });
  installFakeBridge().setInvoke((channel, request) => {
    channels.push(channel);
    if (fail) return Promise.resolve({ ok: false, error: { code: 'unavailable' } });
    const saved = usePrefs.getState().snapshot!;
    if (channel === 'prefs:patch') {
      const patch = request as PreferencesPatch;
      patches.push(patch);
      return Promise.resolve({ ok: true, value: { ...saved, rev: saved.rev + 1, values: applyPatch(saved.values, patch) } });
    }
    throw new Error(`Unexpected call: ${channel}`);
  });
});
afterEach(cleanup);

const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); await Promise.resolve(); }); };
const change = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const seed = (value: SavedPreset = preset) => usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [ID]: value } }) });

describe('the Presets tab', () => {
  it('names accounts in parentheses only for providers with multiple configured accounts, including in the editor', async () => {
    seed();
    const app = useAppState.getState().snapshot!;
    const codex = sampleProvider({ id: 'codex', displayName: 'Codex' });
    useAppState.setState({ snapshot: { ...app, providers: [...app.providers, codex] } });
    render(<PresetsSection />);
    const row = screen.getByRole('article', { name: 'Careful' });
    expect(row.querySelector('[data-preset-preview]')?.getAttribute('title')).toContain('Claude (Default)');
    await click('Edit');
    const accounts = screen.getByLabelText('Account');
    expect(within(accounts).getAllByRole('option').map((option) => option.textContent)).toEqual(['Claude (Default)', 'Claude (Work)', 'Codex']);
    // Another provider's account does not make Claude's single remaining account need a label.
    act(() => useAppState.setState({ snapshot: { ...app, providers: [app.providers[0]!, codex] } }));
    expect(row.querySelector('[data-preset-preview]')?.getAttribute('title')).toMatch(/^Claude —/);
    expect(within(accounts).getAllByRole('option').map((option) => option.textContent)).toEqual(['Claude', 'Codex']);
    expect(patches).toEqual([]);
  });

  it('shows the model’s current avatar in the row and editor, following selection and catalog updates', async () => {
    const face = (portrait: string, small: string | null): ResolvedAvatar => ({ ref: { origin: 'user', family: 'Mine', avatar: portrait }, portrait: portrait.repeat(32), small: small?.repeat(32) ?? null });
    const app = useAppState.getState().snapshot!;
    const catalog = sampleCatalog(['claude'], { providers: [sampleCatalogProvider({ models: [sampleModel({ avatar: face('a', 'b') }), sampleModel({ key: 'simple', name: 'Simple', efforts: [], avatar: face('c', null) })] })] });
    useAppState.setState({ snapshot: { ...app, catalog } });
    seed();
    render(<PresetsSection />);
    const row = screen.getByRole('article', { name: 'Careful' });
    expect(row.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${'a'.repeat(32)}`);
    await click('Edit');
    const editor = screen.getByRole('form', { name: 'Preset editor' });
    expect(editor.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${'b'.repeat(32)}`);
    change('Model', 'simple');
    expect(editor.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${'c'.repeat(32)}`);
    await click('Save preset');
    expect(row.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${'c'.repeat(32)}`);
    expect(patches).toEqual([{ presets: { [ID]: { ...preset, model: 'simple', effort: null } } }]);
    act(() => useAppState.setState({ snapshot: { ...app, catalog: sampleCatalog(['claude'], { providers: [sampleCatalogProvider({ models: [sampleModel({ key: 'simple', avatar: face('d', null) })] })] }) } }));
    expect(row.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${'d'.repeat(32)}`);
    expect(patches).toHaveLength(1);
  });

  it('creates, edits and deletes a named selection through preferences alone', async () => {
    render(<PresetsSection />);
    await click('New preset');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save preset' }).disabled).toBe(true);
    change('Preset name', '  Review\n carefully ');
    change('Effort', 'high');
    await click('Save preset');
    const saved = Object.entries(usePrefs.getState().snapshot!.values.presets);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.[1]).toEqual({ ...preset, name: 'Review carefully' });
    expect(screen.queryByRole('form', { name: 'Preset editor' })).toBeNull();
    await click('Edit');
    change('Preset name', 'Quick'); change('Effort', 'low');
    await click('Save preset');
    expect(screen.getByRole('heading', { name: 'Quick' })).toBeTruthy();
    await click('Delete');
    expect(usePrefs.getState().snapshot?.values.presets).toEqual({});
    expect(patches).toHaveLength(3);
    expect(channels).toEqual(['prefs:patch', 'prefs:patch', 'prefs:patch']);
  });

  it('caps names at 18 visible characters when creating and editing presets', async () => {
    render(<PresetsSection />);
    await click('New preset');
    change('Preset name', 'abcdefghijklmnopqrs');
    expect(screen.getByLabelText<HTMLInputElement>('Preset name').value).toBe('abcdefghijklmnopqr');
    await click('Save preset');
    expect(Object.values(usePrefs.getState().snapshot!.values.presets)[0]?.name).toBe('abcdefghijklmnopqr');
    await click('Edit');
    change('Preset name', '👩‍💻'.repeat(19));
    expect(screen.getByLabelText<HTMLInputElement>('Preset name').value).toBe('👩‍💻'.repeat(18));
    await click('Save preset');
    expect(screen.getByRole('heading', { name: '👩‍💻'.repeat(18) })).toBeTruthy();
  });

  it('keeps a missing model and effort when renaming and reports unavailability until the catalog returns', async () => {
    seed({ ...preset, model: 'retired', effort: 'ultra' });
    render(<PresetsSection />);
    expect(screen.getByText('Unavailable').getAttribute('title')).toContain('Model');
    await click('Edit');
    expect(screen.getByLabelText<HTMLSelectElement>('Model').value).toBe('retired');
    expect(screen.getByLabelText<HTMLSelectElement>('Effort').value).toBe('ultra');
    change('Preset name', 'Still saved');
    await click('Save preset');
    expect(patches[0]).toEqual({ presets: { [ID]: { ...preset, name: 'Still saved', model: 'retired', effort: 'ultra' } } });
    const app = useAppState.getState().snapshot!;
    act(() => useAppState.setState({ snapshot: { ...app, catalog: sampleCatalog(['claude'], { providers: [sampleCatalogProvider({ models: [sampleModel({ key: 'retired', efforts: [{ id: 'ultra', label: 'Ultra', place: 1, caution: true }] })] })] }) } }));
    expect(screen.queryByText('Unavailable')).toBeNull();
    expect(patches).toHaveLength(1);
  });

  it('marks a level that warns in the effort select, and says the chosen one’s warning under it', async () => {
    seed();
    const app = useAppState.getState().snapshot!;
    const warned = sampleModel({ efforts: [{ id: 'high', label: 'High', place: 1, caution: false }, { id: 'max', label: 'Max', place: 2, caution: false, warning: 'Can use substantially more tokens and take longer.' }] });
    act(() => useAppState.setState({ snapshot: { ...app, catalog: sampleCatalog(['claude'], { providers: [sampleCatalogProvider({ models: [warned] })] }) } }));
    render(<PresetsSection />);
    await click('Edit');
    const effort = screen.getByLabelText<HTMLSelectElement>('Effort');
    expect(within(effort).getAllByRole('option').map((option) => option.textContent)).toEqual(['High', 'Max ⚠']);
    expect(document.querySelector('[data-effort-warning]')).toBeNull();
    change('Effort', 'max');
    const note = document.querySelector<HTMLElement>('[data-effort-warning]') as HTMLElement;
    expect(note.textContent).toBe('⚠ Max: Can use substantially more tokens and take longer.');
    // The select is described by it, for assistive technology.
    expect(effort.getAttribute('aria-describedby')).toBe(note.id);
  });

  it('offers the chosen account’s own effort list, and null effort for a model with no levels', async () => {
    render(<PresetsSection />);
    await click('New preset');
    change('Preset name', 'Work'); change('Account', '1');
    expect(within(screen.getByLabelText('Effort')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Low']);
    await click('Save preset');
    expect(Object.values(usePrefs.getState().snapshot!.values.presets)[0]).toMatchObject({ instanceId: WORK, effort: 'low' });
    await click('Edit');
    change('Account', '0'); change('Model', 'simple');
    await click('Save preset');
    expect(Object.values(usePrefs.getState().snapshot!.values.presets)[0]).toMatchObject({ model: 'simple', effort: null });
  });

  it('allows a removed account’s preset to be renamed or deleted without substituting an account', async () => {
    seed({ ...preset, instanceId: ID });
    render(<PresetsSection />);
    await click('Edit');
    expect(screen.getByLabelText<HTMLSelectElement>('Account').selectedOptions[0]?.textContent).toContain('(unavailable)');
    change('Preset name', 'Missing account');
    await click('Save preset');
    expect(usePrefs.getState().snapshot?.values.presets[ID]?.instanceId).toBe(ID);
    await click('Delete');
    expect(screen.getByText('No presets saved yet.')).toBeTruthy();
  });

  it('cancels drafts without saving and keeps the editor and draft when saving fails', async () => {
    render(<PresetsSection />);
    await click('New preset'); change('Preset name', 'Draft');
    await click('Cancel');
    expect(patches).toEqual([]);
    await click('New preset'); change('Preset name', 'Try again'); fail = true;
    await click('Save preset');
    expect(screen.getByRole('alert').textContent).toContain('could not save');
    expect(screen.getByLabelText<HTMLInputElement>('Preset name').value).toBe('Try again');
    fail = false;
    await click('Save preset');
    expect(screen.getByRole('heading', { name: 'Try again' })).toBeTruthy();
  });

  it('disables mutations when preferences are read-only, and offers no creation without models', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [ID]: preset } }, { kind: 'read-only', reason: 'incompatible' }) });
    useAppState.setState({ snapshot: sampleSnapshot(1, []) });
    render(<PresetsSection />);
    for (const name of ['New preset', 'Edit', 'Delete']) expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
    expect(screen.getByText(/No account lists a model/)).toBeTruthy();
    expect(patches).toEqual([]);
  });
});
