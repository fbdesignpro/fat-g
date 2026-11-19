// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V32, V3, V24 (docs/planning/_archive/M13.md, Design 3): the merge, one layer at a time.
import { describe, expect, it } from 'vitest';
import type { CatalogDefaults, CatalogModel, ModelReport, ReportedModel } from '@shared/contracts/catalog';
import { inOrder, mergeCatalog, type ModelOverride, type ProviderOverride } from './merge';

const AT = 1_578_924_800_000;
const fast = { id: 'priority', name: 'Fast', description: '1.5x speed' };
const defaults: CatalogDefaults = {
  presentation: { barColor: '#1991e2', icon: { viewBox: '0 0 24 24', path: 'M2 2H22V22H2Z' } },
  canRequestSpeedTier: true,
  efforts: [
    { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' }, { id: 'ultra', label: 'Ultra', caution: true },
  ],
};

const row = (key: string, extra: Partial<ReportedModel> = {}): ReportedModel => ({
  key, resolvedId: null, name: null, description: null, efforts: [], listedDefaultEffort: null, listedDefault: false, hidden: false, speedTiers: [], ...extra,
});
const reportOf = (models: ReportedModel[], extra: Partial<ModelReport> = {}) => ({ report: { models, speedTierReason: null, dropped: 0, ...extra }, at: AT });
/** What a CLI might report: a listed default with levels and a tier, a plain model, a hidden one. */
const REPORT = reportOf([
  row('astra', { resolvedId: 'astra-1', name: 'Astra', description: 'The CLI’s words.', efforts: ['low', 'medium', 'ultra'], listedDefaultEffort: 'medium', listedDefault: true, speedTiers: [fast] }),
  row('retired', { resolvedId: 'retired', name: 'Retired', efforts: ['low'] }),
  row('secret', { resolvedId: 'secret', name: 'Secret', hidden: true }),
]);
const merge = (report: ReturnType<typeof reportOf> | null = null, override: ProviderOverride | null = null) => mergeCatalog({ id: 'codex', defaults, report, override });
const keys = (models: readonly CatalogModel[]) => models.map((model) => model.key);
const model = (models: readonly CatalogModel[], key: string) => {
  const found = models.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no ${key}`);
  return found;
};
const overrideOf = (models: Record<string, ModelOverride>, efforts: Record<string, { label?: string; caution?: boolean }> = {}): ProviderOverride => ({
  efforts: new Map(Object.entries(efforts)), models: Object.entries(models),
});

describe('without a report (C19, C75, C94)', () => {
  it('lists no model, and still gives the provider its entry and its look', () => {
    const { provider } = merge();
    expect(provider).toEqual({ id: 'codex', instanceId: 'default', presentation: defaults.presentation, source: { kind: 'none' }, speedTierRequest: { possible: true, reason: null }, models: [] });
  });

  it('lists none of the override’s models either: it adjusts a reported list, and counts nothing here', () => {
    const { provider, counts } = merge(null, overrideOf({ local: { name: 'Local', efforts: ['low', 'high'] }, 'gpt-5.5': { hidden: true }, astra: { name: 'Astra' } }));
    expect(provider.source).toEqual({ kind: 'none' });
    expect(provider.models).toEqual([]);
    expect(counts).toEqual({ changed: 0, added: 0, hidden: 0 });
  });

  it('adds the same model once a report is there', () => {
    const { provider, counts } = merge(reportOf([row('astra')]), overrideOf({ local: { name: 'Local', efforts: ['low', 'high'] } }));
    expect(keys(provider.models)).toEqual(['astra', 'local']);
    expect(model(provider.models, 'local')).toMatchObject({ origin: 'override', efforts: [{ id: 'low', label: 'Low', place: 1 }, { id: 'high', label: 'High', place: 2 }] });
    expect(counts).toEqual({ changed: 0, added: 1, hidden: 0 });
  });
});

describe('with a report (C11, C15–C17, C77)', () => {
  it.each([
    ['takes the report’s models, in its order', [row('new'), row('astra')], (models: readonly CatalogModel[]) => expect(keys(models)).toEqual(['new', 'astra'])],
    ['marks every model as reported', [row('astra'), row('new')], (models: readonly CatalogModel[]) => expect(models.map((entry) => entry.origin)).toEqual(['reported', 'reported'])],
  ])('%s', (_name, rows, check) => {
    const { provider } = merge(reportOf(rows));
    expect(provider.source).toEqual({ kind: 'report', at: AT });
    check(provider.models);
  });

  it('leaves out a model a newer report no longer lists', () => {
    expect(keys(merge(reportOf([row('astra')])).provider.models)).toEqual(['astra']);
  });

  it('keeps the report’s own words, and shows a model with no name by its key (C77)', () => {
    const { provider } = merge(reportOf([row('gpt-9', { name: 'GPT-9', description: 'Nine.', resolvedId: 'gpt-9-x' }), row('bare')]));
    expect(model(provider.models, 'gpt-9')).toMatchObject({ name: 'GPT-9', description: 'Nine.', resolvedId: 'gpt-9-x' });
    expect(model(provider.models, 'bare')).toMatchObject({ name: 'bare', description: null, resolvedId: null });
  });

  it('labels each level from the defaults, cautions ultra, and counts places from 1', () => {
    expect(model(merge(REPORT).provider.models, 'astra').efforts).toEqual([
      { id: 'low', label: 'Low', place: 1, caution: false },
      { id: 'medium', label: 'Medium', place: 2, caution: false },
      { id: 'ultra', label: 'Ultra', place: 3, caution: true },
    ]);
  });

  it('gives a model with no levels no effort (C6)', () => {
    expect(model(merge(REPORT).provider.models, 'secret').efforts).toEqual([]);
  });

  it('takes the effort levels, listed defaults, hidden flag and speed tiers from the report (C7, C8, C17)', () => {
    const tiers = [{ id: 'priority', name: 'Fast', description: '2x speed' }, { id: 'flex', name: 'Flex', description: null }];
    const { provider } = merge(reportOf([row('astra', { efforts: ['low', 'high'], listedDefaultEffort: 'high', listedDefault: false, hidden: true, speedTiers: tiers })]));
    expect(model(provider.models, 'astra')).toMatchObject({
      efforts: [{ id: 'low', place: 1 }, { id: 'high', place: 2 }], listedDefaultEffort: 'high', listedDefault: false, hidden: true, speedTiers: tiers,
    });
  });

  it('labels a level the defaults do not know with its own id, without caution (C70)', () => {
    const { provider } = merge(reportOf([row('astra', { efforts: ['low', 'turbo'] })]));
    expect(model(provider.models, 'astra').efforts).toEqual([
      { id: 'low', label: 'Low', place: 1, caution: false },
      { id: 'turbo', label: 'turbo', place: 2, caution: false },
    ]);
  });

  it('carries the reason the CLI gives for refusing a speed tier (C67)', () => {
    expect(merge(reportOf([row('astra')], { speedTierReason: 'sdk_opt_in_required' })).provider.speedTierRequest).toEqual({ possible: true, reason: 'sdk_opt_in_required' });
  });

  it('counts a report with no model as none (C15)', () => {
    const { provider } = merge(reportOf([], { speedTierReason: 'sdk_opt_in_required' }));
    expect(provider.source).toEqual({ kind: 'none' });
    expect(provider.speedTierRequest.reason).toBeNull();
    expect(provider.models).toEqual([]);
  });
});

describe('the order of effort levels (V24, C70)', () => {
  const ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  it.each([
    ['ascending stays as it is', ['low', 'medium', 'high'], ['low', 'medium', 'high']],
    ['out of order comes out in the defaults’ order', ['high', 'low', 'ultra', 'medium'], ['low', 'medium', 'high', 'ultra']],
    ['an unknown level stays after the one it followed', ['low', 'turbo', 'high'], ['low', 'turbo', 'high']],
    ['an unknown level follows its predecessor when the known ones move', ['high', 'turbo', 'low'], ['low', 'high', 'turbo']],
    ['an unknown level with none before it goes first', ['turbo', 'high', 'low'], ['turbo', 'low', 'high']],
    ['unknown levels in a row stay together', ['low', 'a', 'b', 'medium'], ['low', 'a', 'b', 'medium']],
    ['only unknown levels keep the report’s order', ['b', 'a'], ['b', 'a']],
  ])('%s', (_name, reported, expected) => {
    expect(inOrder(reported, ORDER)).toEqual(expected);
  });

  it('counts places over the final list', () => {
    const { provider } = merge(reportOf([row('astra', { efforts: ['high', 'turbo', 'low'] })]));
    expect(model(provider.models, 'astra').efforts.map((effort) => [effort.id, effort.place])).toEqual([['low', 1], ['high', 2], ['turbo', 3]]);
  });
});

describe('the override, last (V3; C18, C37, C38)', () => {
  it.each<[string, ModelOverride, Partial<CatalogModel>]>([
    ['the name', { name: 'Astra, mine' }, { name: 'Astra, mine' }],
    ['the description', { description: 'My words.' }, { description: 'My words.' }],
    ['the description, cleared', { description: null }, { description: null }],
    ['the resolved id', { resolvedId: 'astra-2' }, { resolvedId: 'astra-2' }],
    ['the listed default effort', { listedDefaultEffort: 'low' }, { listedDefaultEffort: 'low' }],
    ['the effort list, in the file’s order', { efforts: ['ultra', 'low'] }, {
      efforts: [{ id: 'ultra', label: 'Ultra', place: 1, caution: true }, { id: 'low', label: 'Low', place: 2, caution: false }],
    }],
    ['the speed tiers, one named by id alone', { speedTiers: [{ id: 'priority' }, { id: 'flex', name: 'Flexible' }, { id: 'odd' }] }, {
      speedTiers: [fast, { id: 'flex', name: 'Flexible', description: null }, { id: 'odd', name: 'odd', description: null }],
    }],
  ])('adjusts %s and marks the model changed', (_name, change, expected) => {
    const { provider, counts } = merge(REPORT, overrideOf({ astra: change }));
    expect(model(provider.models, 'astra')).toMatchObject({ ...expected, origin: 'reported', overridden: true, hiddenByOverride: false });
    expect(counts).toEqual({ changed: 1, added: 0, hidden: 0 });
  });

  it('names a tier by id alone from another reported model when its own has none', () => {
    const { provider } = merge(REPORT, overrideOf({ retired: { speedTiers: [{ id: 'priority' }] } }));
    expect(model(provider.models, 'retired').speedTiers).toEqual([fast]);
  });

  it('keeps a known tier’s warning, the module’s, through the override: the file names none (decision 0013)', () => {
    const warned = { id: 'fast', name: 'Fast', description: null, warning: 'Billed as extra usage.' };
    const report = reportOf([row('astra', { speedTiers: [warned] }), row('retired')]);
    expect(merge(report).provider.models[0]?.speedTiers).toEqual([warned]);
    const { provider } = merge(report, overrideOf({ retired: { speedTiers: [{ id: 'fast', name: 'Quick' }] } }));
    expect(model(provider.models, 'retired').speedTiers).toEqual([{ ...warned, name: 'Quick' }]);
  });

  it('adds models it does not find at the end, in the file’s order, marked as added', () => {
    const { provider, counts } = merge(REPORT, overrideOf({ 'my-local': { name: 'Local', efforts: ['low', 'high'] }, 'gpt-5.55': {} }));
    expect(keys(provider.models)).toEqual(['astra', 'retired', 'secret', 'my-local', 'gpt-5.55']);
    expect(model(provider.models, 'my-local')).toMatchObject({ name: 'Local', origin: 'override', overridden: false, efforts: [{ id: 'low', place: 1 }, { id: 'high', place: 2 }], speedTiers: [], resolvedId: null });
    // A mistyped key is a model of its own, marked as added (V3).
    expect(model(provider.models, 'gpt-5.55')).toMatchObject({ name: 'gpt-5.55', origin: 'override', efforts: [] });
    expect(counts).toEqual({ changed: 0, added: 2, hidden: 0 });
  });

  it('hides a model, and counts it as hidden, not changed', () => {
    const { provider, counts } = merge(REPORT, overrideOf({ retired: { hidden: true } }));
    expect(model(provider.models, 'retired')).toMatchObject({ hidden: true, hiddenByOverride: true, overridden: false, origin: 'reported' });
    expect(counts).toEqual({ changed: 0, added: 0, hidden: 1 });
  });

  it('shows a model the CLI marked hidden, which is a change', () => {
    const { provider, counts } = merge(REPORT, overrideOf({ secret: { hidden: false } }));
    expect(model(provider.models, 'secret')).toMatchObject({ hidden: false, hiddenByOverride: false, overridden: true });
    expect(counts).toEqual({ changed: 1, added: 0, hidden: 0 });
  });

  it('relabels a level and changes its caution flag for every model', () => {
    const { provider } = merge(reportOf([row('astra', { efforts: ['low', 'xhigh', 'ultra'] }), row('new', { efforts: ['xhigh'] })]), overrideOf({}, { xhigh: { label: 'Very high' }, ultra: { caution: false }, turbo: { label: 'Turbo' } }));
    expect(model(provider.models, 'astra').efforts).toEqual([
      { id: 'low', label: 'Low', place: 1, caution: false },
      { id: 'xhigh', label: 'Very high', place: 2, caution: false },
      { id: 'ultra', label: 'Ultra', place: 3, caution: false },
    ]);
    expect(model(provider.models, 'new').efforts[0]?.label).toBe('Very high');
  });

  // Decision 0013: a level's warning is its provider module's, and what the CLI says of it the CLI's;
  // the override's labels and flags change neither, and a model's levels the file lists keep them.
  it('gives each level its module’s warning and what the CLI says of it, through the override', () => {
    const warned: CatalogDefaults = { ...defaults, efforts: defaults.efforts.map((effort) => (effort.id === 'ultra' ? { ...effort, warning: 'Can cost more.' } : effort)) };
    const said = { low: 'Fast.', ultra: 'Delegates.', turbo: 'Not listed.' };
    const report = reportOf([row('astra', { efforts: ['low', 'ultra'], effortDescriptions: said })]);
    const plain = mergeCatalog({ id: 'codex', defaults: warned, report, override: null });
    expect(model(plain.provider.models, 'astra').efforts).toEqual([
      { id: 'low', label: 'Low', place: 1, caution: false, description: 'Fast.' },
      { id: 'ultra', label: 'Ultra', place: 2, caution: true, description: 'Delegates.', warning: 'Can cost more.' },
    ]);
    // Relabelled, uncautioned, and its levels listed again by the file: the warning and the CLI's words stay.
    const overridden = mergeCatalog({ id: 'codex', defaults: warned, report, override: overrideOf({ astra: { efforts: ['ultra', 'low', 'high'] } }, { ultra: { label: 'Max+', caution: false } }) });
    expect(model(overridden.provider.models, 'astra').efforts).toEqual([
      { id: 'ultra', label: 'Max+', place: 1, caution: false, description: 'Delegates.', warning: 'Can cost more.' },
      { id: 'low', label: 'Low', place: 2, caution: false, description: 'Fast.' },
      { id: 'high', label: 'High', place: 3, caution: false },
    ]);
  });

  it('counts the example of the milestone document: one changed, one added, one hidden', () => {
    const { counts } = merge(REPORT, overrideOf({ retired: { hidden: true }, astra: { name: 'A' }, local: { name: 'Local' } }, { xhigh: { label: 'Very high' } }));
    expect(counts).toEqual({ changed: 1, added: 1, hidden: 1 });
  });

  it('never reaches the provider’s presentation (C39)', () => {
    expect(merge(REPORT, overrideOf({ astra: { name: 'A' } })).provider.presentation).toBe(defaults.presentation);
  });

  it('stops adding at 200 models', () => {
    const many = Array.from({ length: 199 }, (_, index) => row(`m${index}`));
    const { provider, counts } = merge(reportOf(many), overrideOf({ a: {}, b: {} }));
    expect(provider.models).toHaveLength(200);
    expect(counts.added).toBe(1);
  });
});
