// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// V30, V34, V43 (docs/planning/_archive/M13.md, Design 9; C7, C58–C61, C83–C85, C96): each provider's models, in its part
// of the Providers section, and the user's catalog.json noted once above them.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModel, CatalogState, OverrideStatus } from '@shared/contracts/catalog';
import { sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { SAMPLE_CATALOG_PATH, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { EXAMPLE_ENTRY, EXAMPLE_ID, EXAMPLE_REPORTED_ENTRY } from '../../../../tests/support/example-provider';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { ProvidersSection } from './ProvidersSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { ProviderModels } from './ProviderModels';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  useAppState.setState({ snapshot: null, error: null });
});
afterEach(cleanup);

const AT = Date.UTC(2020, 0, 21, 12, 3);
const claudeModels: CatalogModel[] = [
  sampleModel({ key: 'default', name: 'Default (recommended)', listedDefault: true, listedDefaultEffort: null, speedTiers: [{ id: 'fast', name: 'Fast', description: null }] }),
  sampleModel({ key: 'haiku', name: 'Haiku', listedDefault: false, listedDefaultEffort: null, efforts: [], speedTiers: [] }),
];
const codexModels: CatalogModel[] = [
  sampleModel({
    key: 'gpt-6-astra', name: 'Astra', listedDefault: true, listedDefaultEffort: 'medium', overridden: true,
    efforts: [
      { id: 'low', label: 'Low', place: 1, caution: false }, { id: 'medium', label: 'Medium', place: 2, caution: false },
      { id: 'ultra', label: 'Ultra', place: 3, caution: true, warning: 'Automatically delegates tasks; can increase usage.', description: 'Maximum reasoning with automatic task delegation' },
    ],
  }),
  sampleModel({ key: 'gpt-5.5', name: 'GPT-5.5', listedDefault: false, hidden: true, hiddenByOverride: true }),
  sampleModel({ key: 'gpt-reserve', name: 'GPT-Reserve', listedDefault: false, hidden: true }),
  sampleModel({ key: 'my-local-model', name: 'Local', listedDefault: false, origin: 'override', efforts: [], speedTiers: [] }),
];

function show(catalog: CatalogState, providers = [sampleProvider({ id: 'claude', displayName: 'Claude' }), sampleProvider({ id: 'codex', displayName: 'Codex' })]) {
  useAppState.setState({ snapshot: { ...sampleSnapshot(1, providers), catalog } });
  const rendered = render(<ProvidersSection />);
  for (const details of rendered.container.querySelectorAll('details')) details.open = true;
  return rendered;
}
function showDetails(catalog: CatalogState) {
  useAppState.setState({ snapshot: { ...sampleSnapshot(1), catalog } });
  return render(<DiagnosticsSection />);
}
const catalogWith = (override: OverrideStatus = { kind: 'none', path: SAMPLE_CATALOG_PATH }): CatalogState => ({
  override,
  providers: [
    sampleCatalogProvider({ id: 'claude', source: { kind: 'report', at: AT }, speedTierRequest: { possible: false, reason: 'sdk_opt_in_required' }, models: claudeModels }),
    sampleCatalogProvider({ id: 'codex', source: { kind: 'report', at: AT }, models: codexModels }),
  ],
});
/** Neither CLI has reported: what a provider that is starting, disabled or paused lists (C94, C95). */
const unreported: CatalogState = {
  override: { kind: 'none', path: SAMPLE_CATALOG_PATH },
  providers: [sampleCatalogProvider({ id: 'claude', source: { kind: 'none' }, models: [] }), sampleCatalogProvider({ id: 'codex', source: { kind: 'none' }, models: [] })],
};
/** A provider's part of the section, found by its heading. */
const part = (name: string): HTMLElement => {
  const section = screen.getByRole('heading', { name }).closest('section');
  if (section === null) throw new Error(`no ${name}`);
  return section;
};
const row = (section: HTMLElement, key: string): HTMLElement => {
  const item = [...section.querySelectorAll<HTMLElement>('tr[data-model-key]')].find((candidate) => candidate.dataset['modelKey'] === key);
  if (item == null) throw new Error(`no ${key}`);
  return item;
};
const cells = (item: HTMLElement) => within(item).getAllByRole('cell').map((cell) => cell.textContent);
const note = () => {
  const found = screen.getAllByRole('status')[0];
  if (found === undefined) throw new Error('no note');
  return found;
};

describe('each provider’s models (C83, C84, C96)', () => {
  it('starts collapsed and lets the user unfold and fold the models', () => {
    const { container } = render(<ProviderModels entry={sampleCatalogProvider({ models: claudeModels })} status="ok" />);
    const details = container.querySelector('details');
    const summary = screen.getByText('Models', { selector: 'summary' });
    expect(details?.open).toBe(false);
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(screen.getByRole('table')).toBeTruthy();
    fireEvent.click(summary);
    expect(details?.open).toBe(false);
  });

  it('shows the name and resolved version id without the alias, and says when no id was reported', () => {
    show({ ...catalogWith(), providers: [sampleCatalogProvider({ models: [
      sampleModel({ key: 'opus', name: 'Opus 5.5', resolvedId: 'claude-opus-5-5' }),
      sampleModel({ key: 'custom', resolvedId: null }),
    ] })] });
    expect(cells(row(part('Claude'), 'opus')).slice(0, 2)).toEqual(['Opus 5.5', 'claude-opus-5-5']);
    expect(within(row(part('Claude'), 'opus')).queryByText('opus')).toBeNull();
    expect(cells(row(part('Claude'), 'custom'))[1]).toBe('Not reported');
  });

  it('are in its part of the Providers section', () => {
    show(catalogWith());
    expect(within(part('Claude')).getByRole('table')).toBeTruthy();
    expect(within(part('Codex')).getByRole('table')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /models/i })).toBeNull();
  });

  it('say where they came from: the CLI’s report with its time', () => {
    show(catalogWith());
    expect(within(part('Claude')).getByText(/^Reported by the CLI on .*2020/)).toBeTruthy();
  });

  it.each([
    ['still starting', { kind: 'detecting' }, 'The CLI has not reported its models.'],
    ['disabled', { kind: 'disabled' }, 'Listed once it is enabled and its CLI reports them.'],
    ['paused', { kind: 'blocked', reason: 'preferences-unavailable' }, 'Listed once it runs again and its CLI reports them.'],
  ] as const)('say, for a provider %s, why there are none, with no table (V43)', (_name, status, line) => {
    show(unreported, [sampleProvider({ id: 'claude', displayName: 'Claude' }), sampleProvider({ id: 'codex', displayName: 'Codex', status })]);
    expect(within(part('Codex')).getByText(line)).toBeTruthy();
    expect(within(part('Codex')).queryByRole('table')).toBeNull();
  });

  it('are one row each: name, id, levels in order with the listed default, tiers, and marks', () => {
    show(catalogWith());
    expect(within(part('Codex')).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Model', 'ID', 'Effort', 'Speed', 'Notes']);
    const astra = row(part('Codex'), 'gpt-6-astra');
    expect(cells(astra)).toEqual([
      'Astra', 'sample-1', 'Low · Medium (listed default) · Ultra ⚠⚠ Ultra: Automatically delegates tasks; can increase usage.', 'Fast', 'Changed by your catalog.json · Listed default',
    ]);
    // A level that warns: its mark, why on hover with what the CLI says of it, and its warning in words under the levels.
    expect(within(astra).getByText('· Ultra ⚠').getAttribute('title')).toBe('Automatically delegates tasks; can increase usage. Maximum reasoning with automatic task delegation');
    expect(astra.querySelector('[data-effort-warning="ultra"]')?.textContent).toBe('⚠ Ultra: Automatically delegates tasks; can increase usage.');
    expect(within(astra).getByText('Low').hasAttribute('title')).toBe(false);
    expect(within(row(part('Codex'), 'gpt-6-astra')).getByText('sample-1').tagName).toBe('CODE');
    expect(within(part('Codex')).getAllByRole('row')).toHaveLength(1 + codexModels.length);
  });

  it('say “None” for a model with no effort and no tier', () => {
    show(catalogWith());
    expect(cells(row(part('Claude'), 'haiku')).slice(2, 4)).toEqual(['None', 'None']);
  });

  it('say once, for the provider, that fat-g cannot ask for a speed tier, with the CLI’s reason (C67)', () => {
    show(catalogWith());
    expect(within(part('Claude')).getByText('fat-g cannot ask for a speed tier (sdk_opt_in_required).')).toBeTruthy();
    expect(within(part('Codex')).queryByText(/cannot ask/)).toBeNull();
  });

  it.each([
    ['gpt-5.5', 'Hidden by your catalog.json'],
    ['gpt-reserve', 'Hidden'],
    ['my-local-model', 'Added by your catalog.json'],
  ])('mark %s in words: %s', (key, marks) => {
    show(catalogWith());
    expect(cells(row(part('Codex'), key))[4]).toBe(marks);
  });

  it('list a provider defined outside src/ as any other, before and after its CLI reports (V34)', () => {
    show({ ...catalogWith(), providers: [EXAMPLE_ENTRY] }, [sampleProvider({ id: EXAMPLE_ID, displayName: 'Example' })]);
    expect(within(part('Example')).getByText('The CLI has not reported its models.')).toBeTruthy();
    expect(within(part('Example')).queryByRole('table')).toBeNull();
    cleanup();
    show({ ...catalogWith(), providers: [EXAMPLE_REPORTED_ENTRY] }, [sampleProvider({ id: EXAMPLE_ID, displayName: 'Example' })]);
    // A caution level with no warning of its own carries no mark.
    expect(cells(row(part('Example'), 'example-large'))[2]).toBe('Quick (listed default) · Deep');
    expect(cells(row(part('Example'), 'example-small')).slice(2, 4)).toEqual(['None', 'None']);
  });

  it('hold no control that changes a model (C60)', () => {
    const { container } = show(catalogWith());
    for (const models of container.querySelectorAll('table')) {
      expect(models.querySelectorAll('input, select, textarea, button, [contenteditable]')).toHaveLength(0);
    }
  });
});

describe('the catalog.json note: warnings in Accounts, full details in Diagnostics', () => {
  it.each<OverrideStatus>([
    { kind: 'none', path: SAMPLE_CATALOG_PATH },
    { kind: 'applied', path: SAMPLE_CATALOG_PATH, changed: 0, added: 1, hidden: 0, unknownProviders: [] },
  ])('keeps routine $kind status out of Accounts', (status) => {
    show(catalogWith(status));
    expect(screen.queryByText(SAMPLE_CATALOG_PATH)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(within(part('Codex')).getByRole('table')).toBeTruthy();
  });

  it('warns in Accounts when the file skips an unrecognized provider', () => {
    show(catalogWith({ kind: 'applied', path: SAMPLE_CATALOG_PATH, changed: 0, added: 0, hidden: 0, unknownProviders: ['gemini'] }));
    expect(note().textContent).toContain('It skips providers this build does not have: gemini.');
    expect(note().compareDocumentPosition(part('Claude')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('removes the warning from Accounts once the file is applied successfully', () => {
    const { rerender } = show(catalogWith({ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'not-json', field: null }));
    expect(note().textContent).toContain('Your catalog.json is ignored');
    useAppState.setState({ snapshot: { ...sampleSnapshot(2), catalog: catalogWith({ kind: 'applied', path: SAMPLE_CATALOG_PATH, changed: 0, added: 1, hidden: 0, unknownProviders: [] }) } });
    rerender(<ProvidersSection />);
    expect(screen.queryByText(SAMPLE_CATALOG_PATH)).toBeNull();
  });

  it.each<[string, OverrideStatus, string]>([
    ['none', { kind: 'none', path: SAMPLE_CATALOG_PATH }, 'No catalog.json: a file at this path can rename, hide, show or add models.'],
    ['applied', { kind: 'applied', path: SAMPLE_CATALOG_PATH, changed: 1, added: 1, hidden: 1, unknownProviders: [] }, 'Your catalog.json is applied: 1 changed, 1 added, 1 hidden.'],
    ['applied, skipping a provider', { kind: 'applied', path: SAMPLE_CATALOG_PATH, changed: 0, added: 0, hidden: 0, unknownProviders: ['gemini'] }, 'It skips providers this build does not have: gemini.'],
  ])('keeps %s details available in Diagnostics', (_name, status, text) => {
    showDetails(catalogWith(status));
    expect(note().textContent).toContain(text);
    expect(within(note()).getByText(SAMPLE_CATALOG_PATH)).toBeTruthy();
    expect(screen.getAllByText(SAMPLE_CATALOG_PATH)).toHaveLength(1);
  });

  it.each<[OverrideStatus & { kind: 'ignored' }, string]>([
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'unreadable', field: null }, 'fat-g cannot open the file. Another program may be holding it.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'too-large', field: null }, 'The file is larger than 256 KB.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'not-json', field: null }, 'The file is not valid JSON. If you edited it by hand, undo the edit.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'damaged', field: null }, 'The file has no valid schemaVersion and minReaderVersion.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'newer', field: null }, 'A newer fat-g wrote this file. Update fat-g to use it.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'older', field: null }, 'An earlier development version of fat-g wrote this file.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'invalid', field: 'providers.codex.models.gpt-5.5.hidden' }, 'A value is not what fat-g expects, at providers.codex.models.gpt-5.5.hidden.'],
  ])('says the file is ignored, and why: $cause', (status, cause) => {
    show(catalogWith(status));
    expect(note().textContent).toContain('Your catalog.json is ignored: nothing in it applies.');
    expect(note().textContent).toContain(cause);
    // fat-g only reads the file: there is nothing to start over from (C45).
    expect(screen.queryByRole('button', { name: /Start fresh|Try again/ })).toBeNull();
  });

  it('sends nothing when Settings opens', () => {
    show(catalogWith());
    expect(bridge.calls.filter((call) => call.startsWith('invoke:'))).toEqual([]);
  });

  it.each<[OverrideStatus, string]>([
    [{ kind: 'none', path: SAMPLE_CATALOG_PATH }, 'No catalog.json was found.'],
    [{ kind: 'applied', path: SAMPLE_CATALOG_PATH, changed: 0, added: 1, hidden: 0, unknownProviders: [] }, 'catalog.json was read again and applied.'],
    [{ kind: 'ignored', path: SAMPLE_CATALOG_PATH, cause: 'not-json', field: null }, 'catalog.json was read again, and is ignored.'],
  ])('Reload sends one request, and says what it found (C58)', async (answer, text) => {
    const requests: unknown[] = [];
    bridge.setInvoke(async (channel, request) => { if (channel === 'diagnostics:dataResetInfo') return new Promise<never>(() => undefined); requests.push([channel, request]); return { ok: true, value: answer }; });
    showDetails(catalogWith());
    fireEvent.click(within(note()).getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(requests).toEqual([['catalog:reload', null]]);
  });

  it('Show data folder sends one request naming no folder, and says so (C59)', async () => {
    const requests: unknown[] = [];
    bridge.setInvoke(async (channel, request) => { if (channel === 'diagnostics:dataResetInfo') return new Promise<never>(() => undefined); requests.push([channel, request]); return { ok: true, value: null }; });
    showDetails(catalogWith());
    fireEvent.click(within(note()).getByRole('button', { name: 'Show data folder' }));
    expect(await screen.findByText('The data folder was opened.')).toBeTruthy();
    expect(requests).toEqual([['shell:showDataFolder', null]]);
  });

  it.each([['Reload', 'fat-g could not read the file again.'], ['Show data folder', 'The data folder could not be opened.']])('%s says a fixed sentence when the call fails, never the error', async (name, text) => {
    bridge.setInvoke(async () => { throw new Error('private-error-detail'); });
    showDetails(catalogWith());
    fireEvent.click(within(note()).getByRole('button', { name }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toContain('private-error-detail');
  });

  it('has two ordinary buttons, reachable from the keyboard, and nothing else to operate', () => {
    showDetails(catalogWith());
    expect(within(note()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Reload', 'Show data folder']);
    expect(note().querySelectorAll('input, select, textarea')).toHaveLength(0);
    for (const button of within(note()).getAllByRole('button')) {
      expect(button.getAttribute('tabindex')).toBeNull();
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('is not shown before the catalog arrives', () => {
    render(<ProvidersSection />);
    expect(screen.queryByText(/catalog\.json/)).toBeNull();
  });
});
