// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V1 (docs/planning/_archive/M13.md; C1, C2, C4–C6, C8, C9, C67, C75, C78): the catalog contract's schemas and
// bounds. V13, the lookup on the models the M10 captures report, is tests/catalog/lookup.test.ts.
import { describe, expect, it } from 'vitest';
import {
  type CatalogDefaults,
  CatalogDefaultsSchema,
  catalogDescription,
  catalogId,
  catalogName,
  type CatalogState,
  findModel,
  genericModel,
  type ModelReport,
  ModelReportSchema,
  type ReportedModel,
} from './catalog';

const stream = { ground: '#043454', lights: ['#04263d', '#052c46', '#07304c', '#063452', '#093b5c', '#0a3e61'] } as const;
const presentation = { barColor: '#1991e2', icon: { viewBox: '0 0 24 24', path: 'M2 2H22V22H2Z' }, stream };
const tier = { id: 'priority', name: 'Fast', description: '2x speed, increased usage' };
const model = {
  key: 'gpt-6-astra', resolvedId: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence.',
  efforts: ['low', 'medium', 'ultra'], listedDefaultEffort: 'medium', listedDefault: true, hidden: false, speedTiers: [tier],
};
const defaults: CatalogDefaults = {
  presentation,
  canRequestSpeedTier: true,
  efforts: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'ultra', label: 'Ultra', caution: true }],
};
const reported: ReportedModel = model;
const report: ModelReport = { models: [reported], speedTierReason: null, dropped: 0 };

const withReported = (patch: Record<string, unknown>) => ({ ...report, models: [{ ...reported, ...patch }] });

describe('the defaults schema (C21, C67, C75)', () => {
  it('accepts a provider’s look, whether it can ask for a tier, and its effort labels', () => {
    expect(CatalogDefaultsSchema.safeParse(defaults).success).toBe(true);
  });

  it('accepts a provider that cannot ask for a speed tier (C67)', () => {
    expect(CatalogDefaultsSchema.safeParse({ ...defaults, canRequestSpeedTier: false }).success).toBe(true);
  });

  // Decision 0013: what choosing a level costs, in the module's words, beside its caution flag.
  it('accepts a level’s warning, with or without its caution', () => {
    expect(CatalogDefaultsSchema.safeParse({ ...defaults, efforts: [{ id: 'max', label: 'Max', warning: 'Can use more tokens.' }, { id: 'ultra', label: 'Ultra', caution: true, warning: 'Delegates tasks.' }] }).success).toBe(true);
  });

  it.each([
    ['a colour that is not #rrggbb', { presentation: { ...presentation, barColor: 'orange' } }],
    ['a mark that is not path data', { presentation: { ...presentation, icon: { viewBox: '0 0 24 24', path: 'M0 0"/><script>' } } }],
    ['a stream of five tones', { presentation: { ...presentation, stream: { ...stream, lights: stream.lights.slice(1) } } }],
    ['a stream tone that is not #rrggbb', { presentation: { ...presentation, stream: { ...stream, lights: ['blue', ...stream.lights.slice(1)] } } }],
    ['an unknown field in the stream', { presentation: { ...presentation, stream: { ...stream, glow: '#000000' } } }],
    ['an unknown field', { extra: true }],
    ['a duplicate effort id', { efforts: [...defaults.efforts, { id: 'low', label: 'Again' }] }],
    ['a label that is not clean', { efforts: [{ id: 'low', label: ' Low ' }, ...defaults.efforts.slice(1)] }],
    ['an empty warning', { efforts: [{ id: 'low', label: 'Low', warning: '' }] }],
    ['a warning that is not clean', { efforts: [{ id: 'low', label: 'Low', warning: 'Costs\nmore' }] }],
    // No model list ships: the models come from the user's own CLI (C75).
    ['a model list', { models: [model] }],
    ['an empty model list', { models: [] }],
  ])('refuses %s', (_name, patch) => {
    expect(CatalogDefaultsSchema.safeParse({ ...defaults, ...patch }).success).toBe(false);
  });
});

describe('the report schema (C9, C26)', () => {
  it('accepts a mapped report, with nulls for what the CLI did not say', () => {
    expect(ModelReportSchema.safeParse(report).success).toBe(true);
    expect(ModelReportSchema.safeParse(withReported({ name: null, description: null, resolvedId: null })).success).toBe(true);
    expect(ModelReportSchema.safeParse({ ...report, speedTierReason: 'sdk_opt_in_required', dropped: 2 }).success).toBe(true);
  });

  it.each([
    ['a key of 129 characters', { key: 'k'.repeat(129) }],
    ['a key with a space', { key: 'gpt 6' }],
    ['a key with a character outside the set', { key: 'gpt<6>' }],
    ['an empty key', { key: '' }],
    ['a resolved id outside the set', { resolvedId: 'claude opus' }],
    ['an effort id outside the set', { efforts: ['low', 'very high'] }],
    ['17 effort levels', { efforts: Array.from({ length: 17 }, (_, index) => `e${index}`) }],
    ['a duplicate effort level', { efforts: ['low', 'low'] }],
    ['9 speed tiers', { speedTiers: Array.from({ length: 9 }, (_, index) => ({ ...tier, id: `t${index}` })) }],
    ['a tier id outside the set', { speedTiers: [{ ...tier, id: 'fast mode' }] }],
    ['a name of 61 characters', { name: 'n'.repeat(61) }],
    ['a name that is not clean', { name: 'GPT\n6' }],
    ['a description of 201 characters', { description: 'd'.repeat(201) }],
    ['an unknown field', { accountId: 'x' }],
    ['a level’s description under an id outside the set', { effortDescriptions: { 'very high': 'Deep.' } }],
    ['a level’s description that is not clean', { effortDescriptions: { low: ' Fast ' } }],
  ])('refuses %s', (_name, patch) => {
    expect(ModelReportSchema.safeParse(withReported(patch)).success).toBe(false);
  });

  // Decision 0013: what the CLI says of each level, by its id.
  it('accepts what the CLI says of each level, or nothing', () => {
    expect(ModelReportSchema.safeParse(withReported({ effortDescriptions: { low: 'Fast responses.', ultra: 'Delegates.' } })).success).toBe(true);
    expect(ModelReportSchema.safeParse(withReported({ effortDescriptions: {} })).success).toBe(true);
  });

  it.each([
    ['no speed tier', []],
    ['one', [tier]],
    ['several, in order', [tier, { id: 'flex', name: 'Flex', description: null }]],
  ])('accepts a model with %s (C8)', (_name, speedTiers) => {
    expect(ModelReportSchema.safeParse(withReported({ speedTiers })).success).toBe(true);
  });

  it('accepts a model with no effort (C6)', () => {
    expect(ModelReportSchema.safeParse(withReported({ efforts: [], listedDefaultEffort: null })).success).toBe(true);
  });

  it('keeps a key of exactly 128 characters, from every character the set allows', () => {
    expect(ModelReportSchema.safeParse(withReported({ key: 'k'.repeat(128) })).success).toBe(true);
    expect(ModelReportSchema.safeParse(withReported({ key: 'Az09._-:/@[1m]' })).success).toBe(true);
  });

  it('refuses 201 models, two with one key, and a reason outside the set', () => {
    const many = Array.from({ length: 201 }, (_, index) => ({ ...reported, key: `m${index}` }));
    expect(ModelReportSchema.safeParse({ ...report, models: many }).success).toBe(false);
    expect(ModelReportSchema.safeParse({ ...report, models: many.slice(0, 200) }).success).toBe(true);
    expect(ModelReportSchema.safeParse({ ...report, models: [reported, reported] }).success).toBe(false);
    expect(ModelReportSchema.safeParse({ ...report, speedTierReason: 'not opted in' }).success).toBe(false);
  });
});

describe('the bounding helpers (C9)', () => {
  it('pass an id through, or refuse it', () => {
    expect(catalogId('claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    for (const value of ['', 'a b', 'x'.repeat(129), 'é', 'a\u0000']) expect(catalogId(value)).toBeNull();
  });

  it('clean and clamp names at 60 and descriptions at 200, and make empty text none', () => {
    expect(catalogName('  Opus\t(1M context) ')).toBe('Opus (1M context)');
    expect(catalogName('n'.repeat(70))).toBe(`${'n'.repeat(59)}…`);
    expect(catalogDescription('d'.repeat(250))).toBe(`${'d'.repeat(199)}…`);
    expect(catalogName(' \u0000 ')).toBeNull();
    expect(catalogDescription('')).toBeNull();
  });
});

describe('findModel on a hand-built catalog (C46–C48)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const entry = (key: string, resolvedId: string | null, extra: Partial<ReturnType<typeof genericModel>> = {}) => ({
    ...genericModel(key), resolvedId, origin: 'reported' as const, ...extra,
  });
  const catalog: CatalogState = {
    override: { kind: 'none', path: 'C:\\data\\catalog.json' },
    providers: [{
      id: 'claude', instanceId: 'default', presentation, source: { kind: 'report', at: 1 }, speedTierRequest: { possible: false, reason: null },
      models: [entry('default', 'opus-x', { listedDefault: true }), entry('opus', 'opus-x'), entry('secret', 'secret-x', { hidden: true })],
    }, {
      // A second account of the same provider, which lists a model of its own (M14b, C20, C28).
      id: 'claude', instanceId: WORK, presentation, source: { kind: 'report', at: 1 }, speedTierRequest: { possible: false, reason: null },
      models: [entry('opus', 'opus-y'), entry('team', 'team-x')],
    }],
  };
  const claude = { providerId: 'claude', instanceId: 'default' };
  const work = { providerId: 'claude', instanceId: WORK };

  it('finds by key, then by resolved id with the listed default losing, hidden ones included', () => {
    expect(findModel(catalog, claude, 'default').key).toBe('default');
    expect(findModel(catalog, claude, 'opus-x').key).toBe('opus');
    expect(findModel(catalog, claude, 'secret-x').key).toBe('secret');
  });

  it('looks in the named instance’s own entry, never in another instance’s (M14b, C28)', () => {
    expect(findModel(catalog, work, 'team').origin).toBe('reported');
    expect(findModel(catalog, work, 'opus').resolvedId).toBe('opus-y');
    expect(findModel(catalog, claude, 'opus').resolvedId).toBe('opus-x');
    // What only the other account lists is unknown here.
    expect(findModel(catalog, claude, 'team').origin).toBe('generic');
    expect(findModel(catalog, work, 'secret').origin).toBe('generic');
    // One UUID in another letter case is the same instance; an instance that is not configured has no entry.
    expect(findModel(catalog, { providerId: 'claude', instanceId: WORK.toUpperCase() }, 'team').origin).toBe('reported');
    expect(findModel(catalog, { providerId: 'claude', instanceId: '11111111-2222-4333-8444-555555555555' }, 'opus').origin).toBe('generic');
  });

  it('answers a generic entry for an unknown id or provider, and leaves the catalog as it was', () => {
    const before = JSON.stringify(catalog);
    expect(findModel(catalog, claude, 'm10-no-such-model')).toEqual(genericModel('m10-no-such-model'));
    expect(findModel(catalog, { providerId: 'nobody', instanceId: 'default' }, 'opus').origin).toBe('generic');
    expect(findModel(undefined, claude, 'opus').origin).toBe('generic');
    expect(JSON.stringify(catalog)).toBe(before);
  });

  it('makes the generic entry from the id alone: no effort, no speed tier', () => {
    expect(genericModel('gpt-9')).toMatchObject({ key: 'gpt-9', name: 'gpt-9', efforts: [], speedTiers: [], origin: 'generic', hidden: false });
    expect(genericModel('   ').name).toBe('Unknown model');
  });
});
