// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The model picker (docs/planning/_archive/M14.md, V24, and V34's component part), opened from the new-chat screen's model button.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRef, useState } from 'react';
import type { CatalogEffort, CatalogModel, CatalogState } from '@shared/contracts/catalog';
import type { ModelPreset } from '@shared/contracts/presets';
import { applyPatch, type PreferencesPatch } from '@shared/contracts/prefs';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { columnLeft, LEVELS_GAP, LEVELS_WIDTH, spanWidth, TILE_HEIGHT, TILE_WIDTH } from '../model-chooser/chooser-shape';
import { installFakeBridge, type FakeBridge } from '../test/fake-bridge';
import { installDialogStandIn } from '../test/dialog';
import { prefsSnapshot } from '../test/prefs';
import { usePrefs } from '../state/prefs-store';
import { project } from '../test/records';
import { showState, type ShownState } from '../test/sessions';
import { ModelPickerPopup, type MeasurePopup, type PopupSpace } from './ModelPickerPopup';

let applied: ModelPreset[];
let answer: () => Promise<boolean>;
let bridge: FakeBridge;
let patches: PreferencesPatch[];
let failSave: boolean;

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  patches = [];
  failSave = false;
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  bridge.setInvoke((channel, request) => {
    if (channel !== 'prefs:patch') throw new Error(`Unexpected call: ${channel}`);
    const patch = request as PreferencesPatch;
    patches.push(patch);
    if (failSave) return Promise.resolve({ ok: false, error: { code: 'unavailable' } });
    const current = usePrefs.getState().snapshot!;
    return Promise.resolve({ ok: true, value: { ...current, rev: current.rev + 1, values: applyPatch(current.values, patch) } });
  });
  applied = [];
  answer = async () => true;
});
afterEach(cleanup);

const level = (id: string, label: string, place: number, caution = false, warning?: string): CatalogEffort => ({ id, label, place, caution, ...(warning === undefined ? {} : { warning }) });
/** Ultra's warning, as Codex's module gives it. */
const ULTRA_WARNING = 'Automatically delegates tasks; can increase usage.';
const LEVELS = [level('low', 'Low', 1), level('medium', 'Medium', 2), level('high', 'High', 3), level('ultra', 'Ultra', 4, true, ULTRA_WARNING)];
const model = (key: string, name: string, overrides: Partial<CatalogModel> = {}): CatalogModel =>
  sampleModel({ key, resolvedId: key, name, efforts: LEVELS, listedDefaultEffort: 'medium', listedDefault: false, ...overrides });

const claude = sampleCatalogProvider({
  id: 'claude',
  models: [
    model('default', 'Default (recommended)', { resolvedId: 'claude-opus[1m]', listedDefault: true, listedDefaultEffort: null }),
    model('opus[1m]', 'Opus (1M context)', { resolvedId: 'claude-opus[1m]', listedDefaultEffort: null }),
    model('sonnet', 'Sonnet', { listedDefaultEffort: null }),
    model('haiku', 'Haiku', { efforts: [], listedDefaultEffort: null, description: null }),
    model('retired', 'Retired', { hidden: true }),
  ],
});
const codex = sampleCatalogProvider({
  id: 'codex',
  models: [
    model('gpt-6-sol', 'GPT-6 Sol', { listedDefault: true }),
    model('gpt-5.6', 'GPT-5.6 with a name far too long for one tile to hold', { efforts: [level('low', 'Low', 1), level('medium', 'Medium', 2)] }),
    // It lists no speed tier: a choice of it leaves standard speed (decision 0016).
    model('gpt-risky', 'GPT Risky', { efforts: [level('ultra', 'Ultra', 1, true, ULTRA_WARNING), level('hyper', 'Hyper', 2, true)], listedDefaultEffort: null, speedTiers: [] }),
  ],
});
const CATALOG: CatalogState = { ...sampleCatalog([]), providers: [claude, codex] };
const PROVIDERS = [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex' })];

const A = project('Calamari', { providers: ['claude', 'codex'] });
const B = project('website', { providers: ['codex'] });

const SPACE: PopupSpace = { anchor: { top: 120, left: 1060, right: 1090 }, column: { left: 800, right: 1120 }, window: { width: 1120, height: 640 }, top: 42 };
let space = SPACE;
const measure: MeasurePopup = () => space;
/** The popup's width for so many columns of full-size capsules: its padding and border, the capsules, then the levels. */
const popupWidth = (columns: number, tileWidth = TILE_WIDTH) => 26 + spanWidth(columns, tileWidth) + LEVELS_GAP + LEVELS_WIDTH;

function PickerButton({ project, value = null }: { readonly project: typeof A; readonly value?: ModelPreset | null }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <><button ref={button} aria-label={`Choose model in ${project.name}`} aria-expanded={open} onClick={() => setOpen((was) => !was)}>+</button>
    {open && <ModelPickerPopup project={project} anchor={button} measure={measure} value={value} onClose={() => setOpen(false)}
      onApply={async (preset) => { applied.push(preset); return answer(); }} />}</>;
}

function Harness({ value = null }: { readonly value?: ModelPreset | null }) {
  return (
    <aside aria-label="Projects">
      <PickerButton project={A} value={value} />
      <PickerButton project={B} />
    </aside>
  );
}

const show = (extra: Partial<ShownState> = {}) => showState({ projects: [A, B], catalog: CATALOG, providers: PROVIDERS, ...extra });
const opener = (name = 'Calamari') => screen.getByRole('button', { name: `Choose model in ${name}` });
const open = (name = 'Calamari', value: ModelPreset | null = null) => {
  space = SPACE;
  render(<Harness value={value} />);
  fireEvent.click(opener(name));
  return screen.getByRole('dialog', { name: 'Choose model' });
};
const popup = () => screen.getByRole('dialog', { name: 'Choose model' });
const models = () => within(popup()).getByRole('radiogroup', { name: 'Model' });
const efforts = () => within(popup()).getByRole('radiogroup', { name: 'Effort' });
const tile = (name: string) => within(models()).getByRole('radio', { name });
/** A model's capsule is named by its model; a level by its words. */
const label = (radio: Element) => radio.getAttribute('aria-label') ?? radio.textContent;
const chosen = (group: HTMLElement) => within(group).getAllByRole('radio').filter((radio) => radio.getAttribute('aria-checked') === 'true').map(label);
const applyButton = () => within(popup()).getByRole('button', { name: 'Apply' });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (action: () => void) => {
  await act(async () => {
    action();
    await flush();
  });
};

describe('the popup (V24; C79)', () => {
  it('is titled Choose model and belongs to the project it chooses for', () => {
    show();
    open();
    expect(within(popup()).getByRole('heading', { name: 'Choose model' })).toBeTruthy();
    expect(popup().getAttribute('data-model-picker')).toBe(A.id);
    expect(opener().getAttribute('aria-expanded')).toBe('true');
  });

  /** Opens it in a space of its own, instead of the minimum window. */
  const openIn = (where: PopupSpace) => {
    render(<Harness />);
    space = where;
    fireEvent.click(opener());
    return popup();
  };

  it('opens beside its button, toward the work area, inside the window below the title strip', () => {
    show();
    const dialog = openIn({ anchor: { top: 120, left: 1540, right: 1570 }, column: { left: 1280, right: 1600 }, window: { width: 1600, height: 900 }, top: 42 });
    // The column is on the right: the popup's right edge is 4 px left of it. Two columns and the levels.
    const width = popupWidth(2);
    expect(dialog.style.width).toBe(`${width}px`);
    expect(dialog.style.left).toBe(`${1280 - 4 - width}px`);
    expect(dialog.style.top).toBe('120px');
  });

  it('opens to the right of a column on the left, and stays inside the window', () => {
    show();
    const dialog = openIn({ anchor: { top: 630, left: 280, right: 310 }, column: { left: 0, right: 320 }, window: { width: 1280, height: 640 }, top: 42 });
    expect(dialog.style.left).toBe('324px');
    // Its button is near the window's bottom edge: the popup moves up to fit.
    expect(Number.parseFloat(dialog.style.top)).toBeLessThan(630);
    expect(Number.parseFloat(dialog.style.top)).toBeGreaterThanOrEqual(42 + 8);
  });

  it('keeps inside the window where the space beside the column is too narrow, over the column if it must', () => {
    show();
    const dialog = openIn({ anchor: { top: 120, left: 700, right: 730 }, column: { left: 600, right: 920 }, window: { width: 920, height: 640 }, top: 42 });
    // A narrow window: the column is on the right, and the popup is wider than what lies left of it.
    expect(dialog.style.width).toBe(`${popupWidth(2)}px`);
    expect(dialog.style.left).toBe('8px');
    cleanup();
    const right = openIn({ anchor: { top: 120, left: 280, right: 310 }, column: { left: 0, right: 320 }, window: { width: 920, height: 640 }, top: 42 });
    expect(right.style.left).toBe(`${920 - 8 - popupWidth(2)}px`);
  });

  it('holds the chooser’s two groups, Apply, and Save as preset', () => {
    show();
    open();
    expect(within(popup()).queryByRole('combobox')).toBeNull();
    expect(within(popup()).getAllByRole('radiogroup')).toHaveLength(2);
    expect(within(popup()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Apply', 'Save as preset']);
    expect(efforts().parentElement?.contains(applyButton())).toBe(true);
    expect(applyButton().compareDocumentPosition(efforts()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('saving the custom selection as a preset', () => {
  const selection: ModelPreset = { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'medium', speed: null };
  const savedId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const saveButton = () => within(popup()).getByRole<HTMLButtonElement>('button', { name: 'Save as preset' });
  const naming = () => screen.getByRole('dialog', { name: 'Save as preset' });
  const nameInput = () => within(naming()).getByRole<HTMLInputElement>('textbox', { name: 'Preset name' });
  const startNaming = () => { const button = saveButton(); button.focus(); fireEvent.click(button); return naming(); };
  const saveName = (name = 'Review carefully') => {
    fireEvent.change(nameInput(), { target: { value: name } });
    fireEvent.submit(within(naming()).getByRole('form', { name: 'Name preset' }));
  };

  it('keeps the save button and layout stable, enabling it only for an unsaved combination', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ presets: { [savedId]: { ...selection, name: 'Already saved' } } }) });
    show(); open('Calamari', selection);
    const button = saveButton();
    const position = popup().getAttribute('style');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: 'Save as preset' })).toBeNull();
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'High' }));
    expect(saveButton()).toBe(button);
    expect(button.disabled).toBe(false);
    expect(popup().getAttribute('style')).toBe(position);
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Medium' }));
    expect(button.disabled).toBe(true);
    expect(popup().getAttribute('style')).toBe(position);
    fireEvent.click(within(popup()).getByRole('checkbox', { name: /Fast/ }));
    expect(button.disabled).toBe(false);
    expect(popup().getAttribute('style')).toBe(position);
  });

  it('names the preview capsule in place, then saves and automatically applies exactly that selection', async () => {
    show(); open('Calamari', selection);
    startNaming();
    expect(document.activeElement).toBe(nameInput());
    expect(nameInput().closest('[data-preset-preview]')).not.toBeNull();
    expect(nameInput().parentElement?.tagName).toBe('STRONG');
    expect(naming().textContent).toContain('GPT-6 Sol · Medium');
    fireEvent.pointerDown(nameInput());
    expect(popup()).not.toBeNull();
    await settle(() => saveName('  Review   carefully  '));
    const [id, saved] = Object.entries(usePrefs.getState().snapshot!.values.presets)[0]!;
    expect(saved).toEqual({ ...selection, name: 'Review carefully' });
    expect(applied).toEqual([selection]);
    expect(patches).toEqual([{ presets: { [id]: saved } }, { usePreset: id }]);
    expect(usePrefs.getState().snapshot?.values.presetRecency).toEqual([id]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['a', '👩‍💻'])('limits the naming field to 18 visible characters before saving (%s)', async (cluster) => {
    show(); open('Calamari', selection); startNaming();
    fireEvent.change(nameInput(), { target: { value: cluster.repeat(19) } });
    expect(nameInput().value).toBe(cluster.repeat(18));
    await settle(() => fireEvent.submit(within(naming()).getByRole('form', { name: 'Name preset' })));
    expect(Object.values(usePrefs.getState().snapshot!.values.presets)[0]?.name).toBe(cluster.repeat(18));
    expect(applied).toEqual([selection]);
  });

  it.each(['Cancel', 'Escape'])('returns to the unchanged chooser without saving on %s', (how) => {
    show(); open('Calamari', selection);
    startNaming();
    fireEvent.change(nameInput(), { target: { value: 'Do not save' } });
    if (how === 'Escape') fireEvent(naming(), new Event('cancel', { cancelable: true }));
    else fireEvent.click(within(naming()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Save as preset' })).toBeNull();
    expect(chosen(efforts())).toEqual(['Medium']);
    expect(tile('GPT-6 Sol').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(saveButton());
    expect(patches).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('keeps the name and selection when saving fails, and retries the same preset id', async () => {
    show(); open('Calamari', selection); startNaming(); failSave = true;
    await settle(() => saveName());
    expect(within(naming()).getByRole('alert').textContent).toContain('could not save');
    expect(nameInput().value).toBe('Review carefully');
    expect(applied).toEqual([]);
    const firstId = Object.keys(patches[0]!.presets!)[0];
    failSave = false;
    await settle(() => fireEvent.submit(within(naming()).getByRole('form', { name: 'Name preset' })));
    expect(Object.keys(patches[1]!.presets!)).toEqual([firstId]);
    expect(applied).toEqual([selection]);
    expect(Object.keys(usePrefs.getState().snapshot!.values.presets)).toEqual([firstId]);
  });

  it('keeps a saved preset and returns to the chooser if applying fails', async () => {
    show(); open('Calamari', selection); startNaming(); answer = async () => false;
    await settle(() => saveName());
    expect(screen.queryByRole('dialog', { name: 'Save as preset' })).toBeNull();
    expect(within(popup()).getByRole('alert').textContent).toContain('could not apply');
    expect(saveButton().disabled).toBe(true);
    expect(Object.values(usePrefs.getState().snapshot!.values.presets)).toHaveLength(1);
    expect(patches).toHaveLength(1);
    answer = async () => true;
    await settle(() => fireEvent.click(applyButton()));
    expect(patches).toHaveLength(2);
    expect(patches[1]?.usePreset).toBe(Object.keys(usePrefs.getState().snapshot!.values.presets)[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('rejects an empty name and never applies through the Save button’s Enter key', () => {
    show(); open('Calamari', selection);
    fireEvent.keyDown(saveButton(), { key: 'Enter' });
    expect(applied).toEqual([]);
    startNaming();
    expect(within(naming()).getByRole<HTMLButtonElement>('button', { name: 'Save and apply' }).disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: '   ' } });
    fireEvent.submit(within(naming()).getByRole('form', { name: 'Name preset' }));
    expect(patches).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('disables saving for read-only preferences', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible' }) });
    show(); open('Calamari', selection);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(screen.queryByRole('dialog', { name: 'Save as preset' })).toBeNull();
    expect(patches).toEqual([]);
  });

  it('saves once and cannot cancel or submit twice while the preference write is pending', async () => {
    let finish!: () => void;
    bridge.setInvoke((channel, request) => {
      if (channel !== 'prefs:patch') throw new Error(`Unexpected call: ${channel}`);
      const patch = request as PreferencesPatch;
      patches.push(patch);
      const current = usePrefs.getState().snapshot!;
      const value = { ...current, rev: current.rev + 1, values: applyPatch(current.values, patch) };
      if (patch.presets !== undefined) return new Promise(resolve => { finish = () => resolve({ ok: true, value }); });
      return Promise.resolve({ ok: true, value });
    });
    show(); open('Calamari', selection); startNaming();
    saveName();
    fireEvent.submit(within(naming()).getByRole('form', { name: 'Name preset' }));
    fireEvent(naming(), new Event('cancel', { cancelable: true }));
    expect(patches).toHaveLength(1);
    expect(nameInput().disabled).toBe(true);
    expect(applied).toEqual([]);
    await act(async () => { finish(); await flush(); });
    expect(applied).toEqual([selection]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not credit the saved preset if a refused application is followed by a different choice', async () => {
    show(); open('Calamari', selection); startNaming(); answer = async () => false;
    await settle(() => saveName());
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'High' }));
    answer = async () => true;
    await settle(() => fireEvent.click(applyButton()));
    expect(patches).toHaveLength(1);
    expect(applied.at(-1)).toEqual({ ...selection, effort: 'high' });
    expect(usePrefs.getState().snapshot?.values.presetRecency).toEqual([]);
  });
});

describe('the model capsules (V24, V34; C118)', () => {
  it('groups them by provider in registry order, each under its name, without hidden models or a repeated listed default', () => {
    show();
    open();
    const columns = [...models().querySelectorAll('[data-column]')].map((column) => [column.getAttribute('data-column'), column.firstElementChild?.textContent, within(column as HTMLElement).getAllByRole('radio').map(label)]);
    expect(columns).toEqual([
      ['claude', 'Claude', ['Opus (1M context)', 'Sonnet', 'Haiku']],
      ['codex', 'Codex', ['GPT-6 Sol', 'GPT-5.6 with a name far too long for one tile to hold', 'GPT Risky']],
    ]);
  });

  it('keeps a saved selection visible when it is beyond the first column', () => {
    const many = sampleCatalogProvider({ id: 'codex', models: Array.from({ length: 20 }, (_unused, index) => model(`m${index + 1}`, `Model ${index + 1}`, { listedDefault: index === 0 })) });
    show({ catalog: { ...CATALOG, providers: [many] } });
    open('Calamari', { providerId: 'codex', instanceId: 'default', model: 'm14', effort: 'medium', speed: null });
    expect(tile('Model 14').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(tile('Model 14'));
    expect(applied).toEqual([]);
  });

  it('draws a model as a capsule: the avatar at its capsule size, the name, and the CLI’s description, whole in the DOM', () => {
    show();
    open();
    const long = tile('GPT-5.6 with a name far too long for one tile to hold');
    expect(long.style.height).toBe(`${TILE_HEIGHT}px`);
    expect(long.querySelector('[data-avatar]')?.getAttribute('data-size')).toBe('capsule');
    expect(long.querySelector('[data-avatar]')?.getAttribute('data-avatar')).toBe('codex');
    expect([long.querySelector('strong')?.textContent, long.querySelector('small')?.textContent]).toEqual(['GPT-5.6 with a name far too long for one tile to hold', 'A model for tests.']);
    expect([long.getAttribute('aria-description'), long.getAttribute('title')]).toEqual(['A model for tests.', 'GPT-5.6 with a name far too long for one tile to hold — A model for tests.']);
    expect((long.closest('[data-column]') as HTMLElement).style.width).toBe(`${TILE_WIDTH}px`);
    // A model the CLI does not describe has its name alone.
    expect([tile('Haiku').querySelector('small'), tile('Haiku').hasAttribute('aria-description')]).toEqual([null, false]);
  });

  // M102 (V7; C4, C31): a capsule draws its catalog model's avatar, at 60 px: its portrait.
  it('draws each capsule’s model’s avatar over the placeholder', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    show({ catalog: { ...CATALOG, providers: CATALOG.providers.map((provider) => ({ ...provider, models: provider.models.map((entry) => ({ ...entry, avatar: face })) })) } });
    open();
    expect(tile('GPT Risky').querySelector('[data-avatar] img')?.getAttribute('src')).toBe(`app://media/avatars/${face.portrait}`);
  });

  // M103 (V6; C10, C13, C14): each capsule draws its own model's, the one assigned beside the default face.
  it('draws on each capsule its own model’s avatar, an assigned one beside the default face', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    const assigned = { ref: { origin: 'user' as const, family: 'Mine', avatar: 'Sol' }, portrait: 'c'.repeat(32), small: null };
    show({ catalog: { ...CATALOG, providers: CATALOG.providers.map((provider) => ({ ...provider, models: provider.models.map((entry) => ({ ...entry, avatar: entry.key === 'gpt-6-sol' ? assigned : face })) })) } });
    open();
    expect(tile('GPT-6 Sol').querySelector('[data-avatar] img')?.getAttribute('src')).toBe(`app://media/avatars/${assigned.portrait}`);
    expect(tile('GPT Risky').querySelector('[data-avatar] img')?.getAttribute('src')).toBe(`app://media/avatars/${face.portrait}`);
  });

  it('starts each provider in one column and reveals the next column only with Show more', () => {
    const many = sampleCatalogProvider({ id: 'codex', models: Array.from({ length: 12 }, (_unused, index) => model(`m${index + 1}`, `Model ${index + 1}`, { listedDefault: index === 0 })) });
    show({ catalog: { ...CATALOG, providers: [claude, many] } });
    open();
    const columns = () => [...models().querySelectorAll('[data-column]')].map((column) => [column.getAttribute('data-column'), column.firstElementChild?.textContent?.trim(), within(column as HTMLElement).getAllByRole('radio').length]);
    expect(columns()).toEqual([['claude', 'Claude', 3], ['codex', 'Codex', 5]]);
    expect(popup().style.width).toBe(`${popupWidth(2)}px`);
    const more = within(popup()).getByRole('button', { name: 'Show more Codex models' });
    // Enter on Show more must not apply the current selection through the popup's shortcut.
    fireEvent.keyDown(more, { key: 'Enter' });
    expect(applied).toEqual([]);
    fireEvent.click(more);
    expect(columns()).toEqual([['claude', 'Claude', 3], ['codex', 'Codex', 6], ['codex', '', 6]]);
    expect(popup().style.width).toBe(`${popupWidth(3)}px`);
    expect(screen.queryByRole('button', { name: 'Show more Codex models' })).toBeNull();
    expect(document.activeElement).toBe(tile('Model 6'));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowRight' });
    expect(tile('Model 12').getAttribute('aria-checked')).toBe('true');
  });

  it('offers only the project’s providers, and only those switched on in Settings', () => {
    show({ providers: [sampleProvider({ status: { kind: 'disabled' } }), sampleProvider({ id: 'codex', displayName: 'Codex' })] });
    open();
    expect([...models().querySelectorAll('[data-column]')].map((column) => column.getAttribute('data-column'))).toEqual(['codex']);
    cleanup();
    show();
    open('website');
    expect([...models().querySelectorAll('[data-column]')].map((column) => column.getAttribute('data-column'))).toEqual(['codex']);
  });

  // M15 (V3; C6): a provider whose module has no sessions is offered none.
  it('gives a provider without sessions no capsule', () => {
    const plain = sampleProvider();
    show({ providers: [{ ...plain, descriptor: { ...plain.descriptor, capabilities: { ...plain.descriptor.capabilities, sessions: false } } }, sampleProvider({ id: 'codex', displayName: 'Codex' })] });
    open();
    expect([...models().querySelectorAll('[data-column]')].map((column) => column.getAttribute('data-column'))).toEqual(['codex']);
  });

  it('gives a provider that has not reported no capsule', () => {
    show({ catalog: { ...CATALOG, providers: [{ ...claude, source: { kind: 'none' }, models: [] }, codex] } });
    open();
    expect([...models().querySelectorAll('[data-column]')].map((column) => column.getAttribute('data-column'))).toEqual(['codex']);
  });

  it('says that models are listed once a CLI reports them, with Apply disabled, when there is no capsule at all', async () => {
    show({ catalog: { ...CATALOG, providers: CATALOG.providers.map((provider) => ({ ...provider, source: { kind: 'none' as const }, models: [] })) } });
    open();
    expect(popup().textContent).toContain('Models are listed once a provider’s CLI reports them.');
    expect(within(popup()).queryAllByRole('radio')).toEqual([]);
    expect((applyButton() as HTMLButtonElement).disabled).toBe(true);
    await settle(() => fireEvent.keyDown(popup(), { key: 'Enter' }));
    expect(applied).toEqual([]);
    // The capsules arrive with the report.
    act(() => void show());
    expect(within(models()).getAllByRole('radio').length).toBeGreaterThan(0);
    expect((applyButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the selection it opens on (V24; C83, C84, C94)', () => {
  it('is the value it is given, where a start would take it', () => {
    show();
    open('Calamari', { providerId: 'codex', instanceId: 'default', model: 'gpt-risky', effort: 'hyper', speed: null });
    expect(chosen(models())).toEqual(['GPT Risky']);
    expect(chosen(efforts())).toEqual(['Hyper']);
  });

  it('is the default preset with no session yet: the first provider’s listed default model, through the capsule that holds it', () => {
    show();
    open();
    // Claude's listed default is the row the capsules leave out; it lists no default effort: the middle of its levels without caution.
    expect(chosen(models())).toEqual(['Opus (1M context)']);
    expect(chosen(efforts())).toEqual(['Medium']);
  });

  it('is the preset of the project’s newest session, also in place of a value a start would refuse', () => {
    show({ sessions: [
      sessionEntry('older', SUMMARIES.idle, { projectId: A.id, providerId: 'claude', model: 'sonnet', effort: 'low', createdAt: 100 }),
      sessionEntry('newest', SUMMARIES.idle, { projectId: A.id, providerId: 'codex', model: 'gpt-6-sol', effort: 'ultra', createdAt: 300 }),
      sessionEntry('elsewhere', SUMMARIES.idle, { projectId: B.id, providerId: 'codex', model: 'gpt-5.6', effort: 'low', createdAt: 900 }),
    ] });
    open('Calamari', { providerId: 'codex', instanceId: 'default', model: 'gone', effort: 'low', speed: null });
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    expect(chosen(efforts())).toEqual(['Ultra ⚠']);
  });

  it('else that of the newest session in any project', () => {
    show({ sessions: [sessionEntry('elsewhere', SUMMARIES.idle, { projectId: B.id, providerId: 'codex', model: 'gpt-5.6', effort: 'low', createdAt: 900 })] });
    open();
    expect(chosen(models())).toEqual(['GPT-5.6 with a name far too long for one tile to hold']);
    expect(chosen(efforts())).toEqual(['Low']);
  });

  it('puts the focus on the chosen capsule, the one tab stop of its group', () => {
    show();
    open();
    expect(document.activeElement).toBe(tile('Opus (1M context)'));
    expect(within(models()).getAllByRole('radio').filter((radio) => radio.tabIndex === 0).map(label)).toEqual(['Opus (1M context)']);
    expect(within(efforts()).getAllByRole('radio').filter((radio) => radio.tabIndex === 0).map(label)).toEqual(['Medium']);
  });
});

describe('the effort grid (V24; C82, C85, C95)', () => {
  it('lists the chosen model’s levels by label in the catalog’s order, a level that warns marked, saying why on hover and to assistive technology', () => {
    show();
    open();
    expect(within(efforts()).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'Medium', 'High', 'Ultra ⚠']);
    const ultra = within(efforts()).getByRole('radio', { name: 'Ultra ⚠' });
    expect([ultra.getAttribute('data-caution'), ultra.hasAttribute('data-warning'), ultra.getAttribute('title'), ultra.getAttribute('aria-description')]).toEqual(['true', true, ULTRA_WARNING, ULTRA_WARNING]);
    expect(within(efforts()).getByRole('radio', { name: 'High' }).hasAttribute('title')).toBe(false);
  });

  it('says the chosen level’s warning in words under the levels, and nothing for one with none', () => {
    show();
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    expect(popup().querySelector('[data-effort-warning]')).toBeNull();
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Ultra ⚠' }));
    expect(popup().querySelector('[data-effort-warning]')?.textContent).toBe(`⚠ Ultra: ${ULTRA_WARNING}`);
  });

  it('follows the chosen model: its own levels, the level kept when it lists it, its listed default otherwise', () => {
    show();
    open();
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'High' }));
    fireEvent.click(tile('GPT-6 Sol'));
    expect(chosen(efforts())).toEqual(['High']);
    // GPT-5.6 lists Low and Medium only: its listed default effort, Medium.
    fireEvent.click(tile('GPT-5.6 with a name far too long for one tile to hold'));
    expect(within(efforts()).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'Medium']);
    expect(chosen(efforts())).toEqual(['Medium']);
    fireEvent.click(tile('GPT-6 Sol'));
    expect(chosen(efforts())).toEqual(['Medium']);
  });

  it('says No effort levels for a model with none, and applies a null effort', async () => {
    show();
    open();
    fireEvent.click(tile('Haiku'));
    expect(within(popup()).queryByRole('radiogroup', { name: 'Effort' })).toBeNull();
    expect(popup().textContent).toContain('No effort levels');
    await settle(() => fireEvent.click(applyButton()));
    expect(applied).toEqual([{ providerId: 'claude', instanceId: 'default', model: 'haiku', effort: null, speed: null }]);
  });

  it('chooses the first level for a model with only caution levels (C95)', () => {
    show();
    open();
    fireEvent.click(tile('GPT Risky'));
    // A caution level with no warning of its own carries no mark.
    expect(within(efforts()).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Ultra ⚠', 'Hyper']);
    expect(chosen(efforts())).toEqual(['Ultra ⚠']);
  });
});

describe('the keys (V24; C86)', () => {
  it('moves and chooses among the capsules: up and down within a column, sideways between columns', () => {
    show();
    open();
    const press = (key: string) => fireEvent.keyDown(models(), { key });
    press('ArrowDown');
    expect(chosen(models())).toEqual(['Sonnet']);
    expect(document.activeElement).toBe(tile('Sonnet'));
    press('ArrowRight');
    expect(chosen(models())).toEqual(['GPT-5.6 with a name far too long for one tile to hold']);
    press('ArrowUp');
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    // The ends of a column and of the grid stop.
    press('ArrowUp');
    press('ArrowRight');
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    press('ArrowLeft');
    expect(chosen(models())).toEqual(['Opus (1M context)']);
    expect(within(models()).getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  });

  it('moves and chooses among the levels, round the ends', () => {
    show();
    open();
    const press = (key: string) => fireEvent.keyDown(efforts(), { key });
    press('ArrowDown');
    expect(chosen(efforts())).toEqual(['High']);
    press('ArrowDown');
    expect(chosen(efforts())).toEqual(['Ultra ⚠']);
    expect(document.activeElement).toBe(within(efforts()).getByRole('radio', { name: 'Ultra ⚠' }));
    press('ArrowDown');
    expect(chosen(efforts())).toEqual(['Low']);
    press('ArrowUp');
    expect(chosen(efforts())).toEqual(['Ultra ⚠']);
    expect(within(efforts()).getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  });

  it('marks the chosen ones with aria-checked, never by colour alone', () => {
    show();
    open();
    fireEvent.click(tile('Sonnet'));
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Low' }));
    expect(tile('Sonnet').getAttribute('aria-checked')).toBe('true');
    expect(tile('Opus (1M context)').getAttribute('aria-checked')).toBe('false');
    expect(chosen(efforts())).toEqual(['Low']);
  });
});

describe('the speed tier (decision 0016)', () => {
  const tiered = (overrides: Partial<CatalogModel>[]) => ({ ...CATALOG, providers: [claude, { ...codex, models: codex.models.map((entry, index) => ({ ...entry, ...overrides[index] })) }] });
  const check = () => within(popup()).queryByRole<HTMLInputElement>('checkbox', { name: /Fast/ });

  it('offers a model’s one tier as a check under the levels, applied with the selection, kept with a model that lists it and dropped with one that does not', async () => {
    show({ catalog: tiered([{}, { speedTiers: [] }, { speedTiers: [{ id: 'priority', name: 'Fast', description: null }] }]) });
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    expect(check()?.checked).toBe(false);
    fireEvent.click(check()!);
    expect(check()?.checked).toBe(true);
    // GPT-5.6 lists no tier: no check, and the speed goes; GPT Risky lists it, but nothing carries it back.
    fireEvent.click(tile('GPT-5.6 with a name far too long for one tile to hold'));
    expect(check()).toBeNull();
    fireEvent.click(tile('GPT-6 Sol'));
    expect(check()?.checked).toBe(false);
    fireEvent.click(check()!);
    fireEvent.click(tile('GPT Risky'));
    expect(check()?.checked).toBe(true);
    await settle(() => fireEvent.click(applyButton()));
    expect(applied).toEqual([{ providerId: 'codex', instanceId: 'default', model: 'gpt-risky', effort: 'ultra', speed: 'priority' }]);
  });

  it('says what a chosen tier costs under it, and disables it, saying why, where the account cannot ask for one', () => {
    show({ catalog: tiered([{ speedTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] }]) });
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    fireEvent.click(check()!);
    expect(popup().querySelector('[data-speed-warning]')?.textContent).toBe('⚡Fast: 1.5x speed, increased usage');
    cleanup();
    show({ catalog: { ...CATALOG, providers: [claude, { ...codex, speedTierRequest: { possible: false, reason: 'preference' } }] } });
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    expect(check()?.disabled).toBe(true);
    expect(check()?.getAttribute('aria-description')).toBe('fat-g cannot ask this account for a faster tier (preference).');
  });

  it('offers several tiers as a choice, Standard first, each by its short name', () => {
    show({ catalog: tiered([{ speedTiers: [{ id: 'priority', name: 'Fast', description: null }, { id: 'ultra', name: 'Ultra fast', description: null }] }]) });
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    const speed = within(popup()).getByRole('radiogroup', { name: 'Speed' });
    expect(within(speed).getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)).toEqual(['Standard', '⚡Fast', '⚡Ultra']);
    expect((within(speed).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true);
  });
});

describe('Apply (V24; C87)', () => {
  it('applies the selection once from the button, and closes', async () => {
    show();
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Ultra ⚠' }));
    await settle(() => fireEvent.click(applyButton()));
    expect(applied).toEqual([{ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'ultra', speed: null }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Decision 0016: the speed tier goes with the selection, kept through a change of model that lists it, as the level is.
  it('keeps the speed tier through a change of model that lists it, and leaves it for one that does not', async () => {
    show();
    open('Calamari', { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: 'priority' });
    fireEvent.click(tile('GPT-5.6 with a name far too long for one tile to hold'));
    await settle(() => fireEvent.click(applyButton()));
    expect(applied).toEqual([{ providerId: 'codex', instanceId: 'default', model: 'gpt-5.6', effort: 'medium', speed: 'priority' }]);
    cleanup();
    applied = [];
    show();
    open('Calamari', { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: 'priority' });
    fireEvent.click(tile('GPT Risky'));
    await settle(() => fireEvent.click(applyButton()));
    expect(applied).toEqual([{ providerId: 'codex', instanceId: 'default', model: 'gpt-risky', effort: 'ultra', speed: null }]);
  });

  it('applies once from Enter, anywhere in the popup, with the preselection as it stands', async () => {
    show();
    open();
    await settle(() => fireEvent.keyDown(tile('Opus (1M context)'), { key: 'Enter' }));
    // The selection carries the surviving capsule's key, never the key of the row left out (C94).
    expect(applied).toEqual([{ providerId: 'claude', instanceId: 'default', model: 'opus[1m]', effort: 'medium', speed: null }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('applies once however often it is pressed while the selection is taken', async () => {
    let release: (value: boolean) => void = () => undefined;
    answer = () => new Promise((resolve) => { release = resolve; });
    show();
    open();
    fireEvent.click(applyButton());
    fireEvent.click(applyButton());
    fireEvent.keyDown(popup(), { key: 'Enter' });
    expect(applied).toHaveLength(1);
    await settle(() => release(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['not taken', async () => false],
    ['failed', async () => { throw new Error('internal'); }],
  ])('says a selection %s in the popup, which stays open, until another choice', async (_name, outcome) => {
    answer = outcome;
    show();
    open();
    await settle(() => fireEvent.click(applyButton()));
    expect(within(popup()).getByRole('alert').textContent).toBe('fat-g could not apply this selection. Your draft is still here.');
    expect((applyButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(tile('Sonnet'));
    expect(within(popup()).queryByRole('alert')).toBeNull();
  });

  it('applies nothing on Escape, and hands the focus back to its button', () => {
    show();
    open();
    fireEvent.keyDown(tile('Opus (1M context)'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applied).toEqual([]);
    expect(document.activeElement).toBe(opener());
  });

  it('applies nothing on a press outside, and hands the focus back to its button', () => {
    show();
    open();
    fireEvent.pointerDown(popup());
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applied).toEqual([]);
    expect(document.activeElement).toBe(opener());
  });
});

// ── M14b: a provider's accounts (docs/planning/_archive/M14b.md, V12 and V23; C44–C46, C70) ─────────────
describe('a provider’s accounts (M14b; C44–C46, C70)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const QUIET = '11111111-2222-4333-8444-555555555555';
  // The second Codex account: it shares GPT-6 Sol with fewer levels, lacks GPT-5.6 and GPT Risky,
  // and lists a model of its own, which is its listed default.
  const codexWork = sampleCatalogProvider({
    id: 'codex',
    instanceId: WORK,
    models: [
      model('gpt-6-team', 'GPT-6 Team', { listedDefault: true, listedDefaultEffort: 'low' }),
      model('gpt-6-sol', 'GPT-6 Sol', { efforts: [level('low', 'Low', 1), level('medium', 'Medium', 2)] }),
    ],
  });
  const codexQuiet = sampleCatalogProvider({ id: 'codex', instanceId: QUIET, source: { kind: 'none' }, models: [] });
  const two = {
    catalog: { ...CATALOG, providers: [claude, codex, codexWork] },
    providers: [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Personal' }), sampleProvider({ id: 'codex', displayName: 'Codex', instanceId: WORK, label: 'Work' })],
  };
  const three = {
    catalog: { ...CATALOG, providers: [claude, codex, codexWork, codexQuiet] },
    providers: [...two.providers, sampleProvider({ id: 'codex', displayName: 'Codex', instanceId: QUIET, label: 'Quiet', status: { kind: 'detecting' }, usage: null })],
  };
  const accounts = () => within(popup()).getByRole('radiogroup', { name: 'Codex account' });
  const account = (label: string) => within(accounts()).getByRole('radio', { name: label });
  const tilesOf = (provider: string) => [...models().querySelectorAll(`[data-column="${provider}"] [role="radio"]`)].map(label);

  it('shows no account control with one switched-on account for each provider (C44)', () => {
    show();
    open();
    expect(within(popup()).getAllByRole('radiogroup').map((group) => group.getAttribute('aria-label') ?? group.getAttribute('aria-labelledby'))).toHaveLength(2);
    expect(popup().querySelector('[data-accounts]')).toBeNull();
    expect(popup().querySelector('[data-account-band]')).toBeNull();
    // Two accounts configured, one switched off: still one to choose, so still no control.
    cleanup();
    show({ ...two, providers: [two.providers[0]!, two.providers[1]!, { ...two.providers[2]!, status: { kind: 'disabled' } }] });
    open();
    expect(popup().querySelector('[data-accounts]')).toBeNull();
  });

  it('shows a radio group of the accounts by label under the provider’s name, with one tab stop (C45)', () => {
    show(two);
    open();
    expect(within(accounts()).getAllByRole('radio').map((radio) => [radio.textContent, radio.getAttribute('aria-checked'), radio.tabIndex])).toEqual([['Personal', 'true', 0], ['Work', 'false', -1]]);
    // Only the provider with more than one: Claude has none.
    expect(within(popup()).queryByRole('radiogroup', { name: 'Claude account' })).toBeNull();
    // Under the name: placed below the heading row, across its provider's columns.
    expect(accounts().style.top).toBe('24px');
    expect(accounts().style.left).toBe(`${columnLeft(1, TILE_WIDTH)}px`);
    expect(accounts().style.width).toBe(`${TILE_WIDTH}px`);
    // Before the tiles in the page, so the keyboard reaches them first.
    expect((accounts().compareDocumentPosition(models()) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    // The model capsules' own group holds no account.
    expect(within(models()).queryByRole('radio', { name: 'Work' })).toBeNull();
  });

  it('keeps a band in every column, as tall as the buttons need, so the capsules start level', () => {
    show(two);
    open();
    const bands = [...models().querySelectorAll<HTMLElement>('[data-account-band]')];
    expect(bands).toHaveLength(2);
    expect(bands.map((band) => band.style.height)).toEqual(['24px', '24px']);
    expect(accounts().style.height).toBe('24px');
  });

  it('opens with the first account that lists a model chosen for a provider the preset does not name, and lists its models', () => {
    show(two);
    open();
    // The default preset is Claude's; Codex's column shows its first account.
    expect(chosen(models())).toEqual(['Opus (1M context)']);
    expect(tilesOf('codex')).toEqual(['GPT-6 Sol', 'GPT-5.6 with a name far too long for one tile to hold', 'GPT Risky']);
  });

  it('opens with the instance of the preselected preset chosen, and its own models and levels (C27)', () => {
    show({ ...two, sessions: [sessionEntry('newest', SUMMARIES.idle, { projectId: A.id, providerId: 'codex', instanceId: WORK, model: 'gpt-6-sol', effort: 'medium', createdAt: 300 })] });
    open();
    expect(account('Work').getAttribute('aria-checked')).toBe('true');
    expect(tilesOf('codex')).toEqual(['GPT-6 Team', 'GPT-6 Sol']);
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    // The Work account's GPT-6 Sol has two levels, not the first account's four.
    expect(within(efforts()).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'Medium']);
    expect(chosen(efforts())).toEqual(['Medium']);
  });

  it('lists the chosen account’s models and levels once another is chosen, and names it in the selection applied (C45, C46)', async () => {
    show(two);
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Low' }));
    fireEvent.click(account('Work'));
    expect(account('Work').getAttribute('aria-checked')).toBe('true');
    expect(account('Work').tabIndex).toBe(0);
    expect(tilesOf('codex')).toEqual(['GPT-6 Team', 'GPT-6 Sol']);
    // The model is kept, since the account lists it; so is the level, which it has.
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    expect(within(efforts()).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'Medium']);
    expect(chosen(efforts())).toEqual(['Low']);
    await settle(() => fireEvent.click(applyButton()));
    expect(applied).toEqual([{ providerId: 'codex', instanceId: WORK, model: 'gpt-6-sol', effort: 'low', speed: null }]);
  });

  it('keeps the model and moves the level as for a change of model when the account’s model lacks it (C46, C85)', () => {
    show(two);
    open();
    fireEvent.click(tile('GPT-6 Sol'));
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'High' }));
    fireEvent.click(account('Work'));
    // Work's GPT-6 Sol has no High: its listed default effort.
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    expect(chosen(efforts())).toEqual(['Medium']);
  });

  it('takes the account’s default model when it does not list the chosen one, and when the preset was another provider’s (C46)', () => {
    show(two);
    open();
    fireEvent.click(tile('GPT-5.6 with a name far too long for one tile to hold'));
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Medium' }));
    fireEvent.click(account('Work'));
    // GPT-5.6 is not Work's: its listed default model. The level stays, since that model lists it (C85).
    expect(chosen(models())).toEqual(['GPT-6 Team']);
    expect(chosen(efforts())).toEqual(['Medium']);
    // A level the default model lacks gives way to its listed default effort.
    fireEvent.click(account('Personal'));
    fireEvent.click(tile('GPT Risky'));
    fireEvent.click(within(efforts()).getByRole('radio', { name: 'Hyper' }));
    fireEvent.click(account('Work'));
    expect(chosen(models())).toEqual(['GPT-6 Team']);
    expect(chosen(efforts())).toEqual(['Low']);
    // From another provider's model: choosing an account makes the preset name it.
    fireEvent.click(tile('Sonnet'));
    fireEvent.click(account('Personal'));
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    expect(account('Personal').getAttribute('aria-checked')).toBe('true');
  });

  it('remembers the account chosen for a provider while a model of another provider is chosen', () => {
    show(two);
    open();
    fireEvent.click(account('Work'));
    fireEvent.click(tile('Sonnet'));
    expect(chosen(models())).toEqual(['Sonnet']);
    expect(account('Work').getAttribute('aria-checked')).toBe('true');
    expect(tilesOf('codex')).toEqual(['GPT-6 Team', 'GPT-6 Sol']);
  });

  it('chooses with the arrow keys, round the ends, the focus following (C45)', () => {
    show(two);
    open();
    account('Personal').focus();
    fireEvent.keyDown(account('Personal'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(account('Work'));
    expect(account('Work').getAttribute('aria-checked')).toBe('true');
    expect(chosen(models())).toEqual(['GPT-6 Team']);
    fireEvent.keyDown(account('Work'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(account('Personal'));
    expect(account('Personal').getAttribute('aria-checked')).toBe('true');
    // Personal does not list GPT-6 Team: its own default.
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    fireEvent.keyDown(account('Personal'), { key: 'ArrowLeft' });
    expect(account('Work').getAttribute('aria-checked')).toBe('true');
    // Work lists GPT-6 Sol, so it is kept; the capsules' own arrows did not move with the accounts'.
    expect(chosen(models())).toEqual(['GPT-6 Sol']);
    expect(document.activeElement).toBe(account('Work'));
  });

  it('applies the chosen account’s model from the keyboard: Enter applies its selection', async () => {
    show(two);
    open();
    account('Personal').focus();
    fireEvent.keyDown(account('Personal'), { key: 'ArrowRight' });
    await settle(() => fireEvent.keyDown(account('Work'), { key: 'Enter' }));
    // Work's listed default model, at the level in force, which it lists.
    expect(applied).toEqual([{ providerId: 'codex', instanceId: WORK, model: 'gpt-6-team', effort: 'medium', speed: null }]);
  });

  // V23 (C70): an account whose CLI has reported no model.
  describe('an account that lists no model (C70)', () => {
    it('keeps its button, dimmed, described by the reason', () => {
      show(three);
      open();
      const quiet = account('Quiet');
      expect(quiet.getAttribute('aria-disabled')).toBe('true');
      expect(quiet.getAttribute('aria-checked')).toBe('false');
      const description = document.getElementById(quiet.getAttribute('aria-describedby') ?? '');
      expect(description?.getAttribute('role')).toBe('tooltip');
      expect(description?.textContent).toBe('This account’s CLI has not reported its models yet, so no session can start on it.');
      // The others carry no such description.
      expect(account('Work').hasAttribute('aria-describedby')).toBe(false);
      expect(account('Work').hasAttribute('aria-disabled')).toBe(false);
    });

    it('is not chosen by a press', () => {
      show(three);
      open();
      fireEvent.click(tile('GPT-6 Sol'));
      fireEvent.click(account('Quiet'));
      expect(account('Quiet').getAttribute('aria-checked')).toBe('false');
      expect(account('Personal').getAttribute('aria-checked')).toBe('true');
      expect(chosen(models())).toEqual(['GPT-6 Sol']);
    });

    it('is not chosen by an arrow: the focus reaches it, so its reason is heard, and the choice stays', () => {
      show(three);
      open();
      fireEvent.click(account('Work'));
      account('Work').focus();
      fireEvent.keyDown(account('Work'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe(account('Quiet'));
      expect(account('Quiet').getAttribute('aria-checked')).toBe('false');
      expect(account('Work').getAttribute('aria-checked')).toBe('true');
      expect(chosen(models())).toEqual(['GPT-6 Team']);
      // On to the next, which is chosen.
      fireEvent.keyDown(account('Quiet'), { key: 'ArrowRight' });
      expect(account('Personal').getAttribute('aria-checked')).toBe('true');
    });

    it('shows its reason while the pointer is over it or it holds the focus', () => {
      show(three);
      open();
      const tip = () => document.getElementById(account('Quiet').getAttribute('aria-describedby') ?? '');
      expect(tip()?.hasAttribute('data-open')).toBe(false);
      fireEvent.pointerEnter(account('Quiet'));
      expect(tip()?.hasAttribute('data-open')).toBe(true);
      fireEvent.pointerLeave(account('Quiet'));
      expect(tip()?.hasAttribute('data-open')).toBe(false);
    });

    it('becomes choosable once its CLI reports', () => {
      show(three);
      open();
      act(() => void show({ ...three, catalog: { ...three.catalog, providers: [claude, codex, codexWork, { ...codexWork, instanceId: QUIET }] } }));
      expect(account('Quiet').hasAttribute('aria-disabled')).toBe(false);
      fireEvent.click(account('Quiet'));
      expect(account('Quiet').getAttribute('aria-checked')).toBe('true');
    });

    it('leaves a provider out when none of its accounts lists a model, as before', () => {
      show({ ...two, catalog: { ...CATALOG, providers: [claude, { ...codex, source: { kind: 'none' }, models: [] }, { ...codexWork, source: { kind: 'none' }, models: [] }] } });
      open();
      expect([...models().querySelectorAll('[data-column]')].map((column) => column.getAttribute('data-column'))).toEqual(['claude']);
      expect(popup().querySelector('[data-accounts]')).toBeNull();
    });
  });

  it('wraps eight accounts within their provider’s column, and makes the popup taller by their lines', () => {
    const ids = Array.from({ length: 7 }, (_unused, index) => `0000000${index}-2222-4333-8444-555555555555`);
    const eight = {
      catalog: { ...CATALOG, providers: [claude, codex, ...ids.map((instanceId) => ({ ...codexWork, instanceId }))] },
      providers: [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Personal' }), ...ids.map((instanceId, index) => sampleProvider({ id: 'codex', displayName: 'Codex', instanceId, label: `Account ${index}` }))],
    };
    show(eight);
    open();
    expect(within(accounts()).getAllByRole('radio')).toHaveLength(8);
    // One column of 240 holds two buttons of 96: four lines of 24.
    expect(accounts().style.height).toBe('96px');
    expect(popup().style.width).toBe(`${popupWidth(2)}px`);
    expect(within(accounts()).getAllByRole('radio').every((radio) => radio.style.width === '96px' && radio.style.height === '24px')).toBe(true);
  });
});
