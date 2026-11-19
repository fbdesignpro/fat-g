// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Model presets (docs/planning/_archive/M14.md, V23; M14b.md, V9): every row of Design 8's table of helpers,
// on a table. Since M14b a preset names an instance, and every helper works on an instance's own entry.
import { describe, expect, it } from 'vitest';
import { sampleProvider } from '../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../tests/support/catalog';
import type { CatalogEffort, CatalogModel, CatalogProvider, CatalogState } from './catalog';
import type { InstanceRef } from './instances';
import { catalogEntry, checkPreset, defaultPreset, effortFor, ModelPresetSchema, offeredInstances, preselectPreset, presetOffer, type PresetOffer, presetTiles, providerTiles, resolveTileKey, speedFor } from './presets';
import { modelSelectionKey } from './recent-models';

const level = (id: string, place: number, caution = false): CatalogEffort => ({ id, label: id.toUpperCase(), place, caution });
const LEVELS = [level('low', 1), level('medium', 2), level('high', 3), level('ultra', 4, true)];
const model = (key: string, overrides: Partial<CatalogModel> = {}): CatalogModel =>
  sampleModel({ key, resolvedId: key, name: key, efforts: LEVELS, listedDefaultEffort: 'medium', listedDefault: false, ...overrides });

// Claude as its CLI lists it: a "Default" row that is the same model as the row naming it.
const claude: CatalogProvider = sampleCatalogProvider({
  id: 'claude',
  models: [
    model('default', { resolvedId: 'claude-opus-5-5[1m]', listedDefault: true, listedDefaultEffort: null }),
    model('opus[1m]', { resolvedId: 'claude-opus-5-5[1m]', listedDefaultEffort: null }),
    model('sonnet', { listedDefaultEffort: null }),
    model('haiku', { efforts: [], listedDefaultEffort: null }),
    model('retired', { hidden: true }),
  ],
});
const codex: CatalogProvider = sampleCatalogProvider({
  id: 'codex',
  models: [model('gpt-6-sol', { listedDefault: true }), model('gpt-5.6', { listedDefaultEffort: 'high' }), model('gpt-hidden', { hidden: true })],
});
const silent: CatalogProvider = sampleCatalogProvider({ id: 'gemini', source: { kind: 'none' }, models: [] });
// A second Codex account, on another plan: it lists one model the first lacks, lacks one the first
// lists, and gives the model they share fewer levels (M14b, C20, C25).
const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const codexWork: CatalogProvider = sampleCatalogProvider({
  id: 'codex',
  instanceId: WORK,
  models: [model('gpt-6-sol', { listedDefault: true, efforts: [level('low', 1), level('medium', 2)] }), model('gpt-6-team')],
});
const catalog: CatalogState = { ...sampleCatalog([]), providers: [claude, codex, codexWork, silent] };
const keys = (models: readonly CatalogModel[]) => models.map((entry) => entry.key);
const first = (providerId: string): InstanceRef => ({ providerId, instanceId: 'default' });
const work: InstanceRef = { providerId: 'codex', instanceId: WORK };
const offer = (offered: string[], enabled: string[], instances: InstanceRef[] = [first('claude'), first('codex'), work, first('gemini')]): PresetOffer => ({ offered, enabled, instances });
const both = offer(['claude', 'codex'], ['claude', 'codex']);
/** A preset on a provider's first instance. */
const on = (providerId: string, modelKey: string, effort: string | null, instanceId = 'default', speed: string | null = null) => ({ providerId, instanceId, model: modelKey, effort, speed });

describe('the tiles (C118)', () => {
  it('leave out hidden models, and a listed-default row another offered row repeats', () => {
    expect(keys(providerTiles(claude))).toEqual(['opus[1m]', 'sonnet', 'haiku']);
    expect(keys(providerTiles(codex))).toEqual(['gpt-6-sol', 'gpt-5.6']);
  });

  it.each<[string, CatalogModel[], string[]]>([
    ['keep a listed-default row no other row repeats', [model('default', { resolvedId: 'x', listedDefault: true }), model('other')], ['default', 'other']],
    ['keep it when the row repeating it is hidden', [model('default', { resolvedId: 'x', listedDefault: true }), model('x', { hidden: true })], ['default']],
    ['keep it when it resolves to nothing', [model('default', { resolvedId: null, listedDefault: true }), model('x', { resolvedId: null })], ['default', 'x']],
    ['keep two rows of one model when neither is the listed default', [model('a', { resolvedId: 'x' }), model('b', { resolvedId: 'x' })], ['a', 'b']],
  ])('%s', (_name, models, expected) => {
    expect(keys(providerTiles(sampleCatalogProvider({ models })))).toEqual(expected);
  });

  it('group by instance in the catalog’s order, for the instances asked for, and give one that has not reported no group', () => {
    expect(presetTiles(catalog, [work, first('codex'), first('claude'), first('gemini')]).map((group) => [group.provider.id, group.provider.instanceId, keys(group.tiles)])).toEqual([
      ['claude', 'default', ['opus[1m]', 'sonnet', 'haiku']],
      ['codex', 'default', ['gpt-6-sol', 'gpt-5.6']],
      ['codex', WORK, ['gpt-6-sol', 'gpt-6-team']],
    ]);
    expect(presetTiles(catalog, [first('codex')]).map((group) => group.provider.instanceId)).toEqual(['default']);
    // An added instance alone, and its id in another letter case: one id.
    expect(presetTiles(catalog, [{ providerId: 'codex', instanceId: WORK.toUpperCase() }]).map((group) => group.provider.instanceId)).toEqual([WORK]);
    // Another provider's instance of the same id is not it.
    expect(presetTiles(catalog, [{ providerId: 'claude', instanceId: WORK }])).toEqual([]);
    expect(presetTiles(catalog, [first('gemini')])).toEqual([]);
    expect(presetTiles(undefined, [first('claude')])).toEqual([]);
  });

  it('finds an instance’s own catalog entry', () => {
    expect(catalogEntry(catalog, first('codex'))).toBe(codex);
    expect(catalogEntry(catalog, work)).toBe(codexWork);
    expect(catalogEntry(catalog, { providerId: 'codex', instanceId: '11111111-2222-4333-8444-555555555555' })).toBeUndefined();
    expect(catalogEntry(undefined, work)).toBeUndefined();
  });
});

describe('resolveTileKey (C94)', () => {
  it.each([
    ['a tile’s own key', claude, 'sonnet', 'sonnet'],
    ['the key of the row left out, to the tile of the same model', claude, 'default', 'opus[1m]'],
    ['a hidden key', claude, 'retired', null],
    ['an unknown key', claude, 'gpt-6-sol', null],
    ['any key of a provider that lists nothing', silent, 'gemini-3', null],
  ])('resolves %s', (_name, provider, key, expected) => {
    expect(resolveTileKey(provider, key)?.key ?? null).toBe(expected);
  });

  it('resolves nothing without a provider', () => {
    expect(resolveTileKey(undefined, 'sonnet')).toBeNull();
  });
});

describe('effortFor (C85, C94, C95)', () => {
  it.each<[string, Partial<CatalogModel>, string | null, string | null]>([
    ['the wanted level, when the model lists it', {}, 'high', 'high'],
    ['a wanted caution level, when the model lists it', {}, 'ultra', 'ultra'],
    ['the listed default effort, when the wanted one is not listed', {}, 'max', 'medium'],
    ['the listed default effort, with nothing wanted', {}, null, 'medium'],
    ['the middle level without caution, with no listed default effort', { listedDefaultEffort: null }, null, 'medium'],
    ['the middle level without caution, when the listed default is not one of its levels', { listedDefaultEffort: 'max' }, 'gone', 'medium'],
    ['the upper middle of an even count of levels', { efforts: [level('low', 1), level('medium', 2), level('high', 3), level('xhigh', 4), level('ultra', 5, true)], listedDefaultEffort: null }, null, 'high'],
    ['High of Claude’s five levels, never Max', { efforts: [level('low', 1), level('medium', 2), level('high', 3), level('xhigh', 4), level('max', 5)], listedDefaultEffort: null }, null, 'high'],
    ['the first level, for a model with only caution levels', { efforts: [level('ultra', 1, true), level('hyper', 2, true)], listedDefaultEffort: null }, null, 'ultra'],
    ['the listed default, for a model with only caution levels that lists one of them', { efforts: [level('ultra', 1, true), level('hyper', 2, true)], listedDefaultEffort: 'hyper' }, null, 'hyper'],
    ['nothing, for a model with no levels', { efforts: [], listedDefaultEffort: null }, 'high', null],
    ['nothing, for a model with no levels whose listed default names one', { efforts: [], listedDefaultEffort: 'high' }, null, null],
  ])('gives %s', (_name, overrides, wanted, expected) => {
    expect(effortFor(model('m', overrides), wanted)).toBe(expected);
  });
});

describe('defaultPreset (C84; M14b, C27)', () => {
  it('takes the first group’s listed default model, through the tiles, at the level effortFor gives, and names its instance', () => {
    // Claude lists no default effort: the middle of its levels without caution.
    expect(defaultPreset(presetTiles(catalog, [first('claude'), first('codex')]))).toEqual(on('claude', 'opus[1m]', 'medium'));
    // Codex lists one per model.
    expect(defaultPreset(presetTiles(catalog, [first('codex'), work]))).toEqual(on('codex', 'gpt-6-sol', 'medium'));
  });

  it('names the first switched-on instance that lists a model: an added one, when the first is not among them', () => {
    expect(defaultPreset(presetTiles(catalog, [work]))).toEqual(on('codex', 'gpt-6-sol', 'medium', WORK));
    // The first instance has not reported: the next one that has.
    const quiet = { ...catalog, providers: [{ ...codex, models: [] }, codexWork] };
    expect(defaultPreset(presetTiles(quiet, [first('codex'), work]))).toEqual(on('codex', 'gpt-6-sol', 'medium', WORK));
  });

  it.each<[string, CatalogModel[], { model: string; effort: string | null }]>([
    ['the first tile, without a listed default model', [model('a', { listedDefaultEffort: 'high' }), model('b')], { model: 'a', effort: 'high' }],
    ['the first tile, when the listed default model is hidden', [model('a', { listedDefault: true, hidden: true }), model('b')], { model: 'b', effort: 'medium' }],
    ['a model with no levels at no effort', [model('a', { listedDefault: true, efforts: [], listedDefaultEffort: null })], { model: 'a', effort: null }],
    ['a model with only caution levels at its first', [model('a', { listedDefault: true, efforts: [level('ultra', 1, true)], listedDefaultEffort: null })], { model: 'a', effort: 'ultra' }],
  ])('takes %s', (_name, models, expected) => {
    const provider = sampleCatalogProvider({ id: 'codex', models });
    expect(defaultPreset(presetTiles({ ...catalog, providers: [provider] }, [first('codex')]))).toEqual({ providerId: 'codex', instanceId: 'default', ...expected, speed: null });
  });

  it('is nothing with no tile at all', () => {
    expect(defaultPreset([])).toBeNull();
    expect(defaultPreset(presetTiles(catalog, [first('gemini')]))).toBeNull();
  });
});

describe('checkPreset (C32; M14b, C25)', () => {
  it.each([
    ['a listed model at one of its levels', on('codex', 'gpt-6-sol', 'high'), both, { ok: true, preset: on('codex', 'gpt-6-sol', 'high') }],
    ['a caution level', on('codex', 'gpt-6-sol', 'ultra'), both, { ok: true, preset: on('codex', 'gpt-6-sol', 'ultra') }],
    ['a model with no levels, at no effort', on('claude', 'haiku', null), both, { ok: true, preset: on('claude', 'haiku', null) }],
    ['the key of a row left out, as the tile’s key (C94)', on('claude', 'default', 'high'), both, { ok: true, preset: on('claude', 'opus[1m]', 'high') }],
    ['a provider the project does not offer', on('codex', 'gpt-6-sol', 'high'), offer(['claude'], ['claude', 'codex']), { ok: false, reason: 'provider-not-offered' }],
    ['a provider that is switched off', on('codex', 'gpt-6-sol', 'high'), offer(['claude', 'codex'], ['claude']), { ok: false, reason: 'provider-unavailable' }],
    ['a hidden model', on('codex', 'gpt-hidden', 'high'), both, { ok: false, reason: 'model-not-listed' }],
    ['a model the catalog does not list', on('codex', 'gpt-9', 'high'), both, { ok: false, reason: 'model-not-listed' }],
    ['another provider’s model', on('codex', 'sonnet', 'high'), both, { ok: false, reason: 'model-not-listed' }],
    ['a model of a provider that has not reported', on('gemini', 'gemini-3', null), offer(['gemini'], ['gemini']), { ok: false, reason: 'model-not-listed' }],
    ['a level the model lacks', on('codex', 'gpt-6-sol', 'max'), both, { ok: false, reason: 'effort-not-listed' }],
    ['no level for a model that has levels', on('codex', 'gpt-6-sol', null), both, { ok: false, reason: 'effort-not-listed' }],
    ['a level for a model that has none', on('claude', 'haiku', 'high'), both, { ok: false, reason: 'effort-not-listed' }],
    // M14b: the instance, and what its own entry lists.
    ['an added instance’s own model, which the first lacks', on('codex', 'gpt-6-team', 'high', WORK), both, { ok: true, preset: on('codex', 'gpt-6-team', 'high', WORK) }],
    ['an added instance named in another letter case', on('codex', 'gpt-6-sol', 'low', WORK.toUpperCase()), both, { ok: true, preset: on('codex', 'gpt-6-sol', 'low', WORK.toUpperCase()) }],
    ['an instance that is not configured', on('codex', 'gpt-6-sol', 'high', '11111111-2222-4333-8444-555555555555'), both, { ok: false, reason: 'instance-unavailable' }],
    ['an instance that is switched off', on('codex', 'gpt-6-sol', 'low', WORK), offer(['claude', 'codex'], ['claude', 'codex'], [first('claude'), first('codex')]), { ok: false, reason: 'instance-unavailable' }],
    ['another provider’s instance', on('claude', 'sonnet', 'high', WORK), both, { ok: false, reason: 'instance-unavailable' }],
    ['a switched-off provider, before its instance is asked about', on('codex', 'gpt-6-sol', 'low', WORK), offer(['claude', 'codex'], ['claude'], [first('claude')]), { ok: false, reason: 'provider-unavailable' }],
    ['a model the named instance lacks, though the first lists it', on('codex', 'gpt-5.6', 'high', WORK), both, { ok: false, reason: 'model-not-listed' }],
    ['a model the first instance lacks, though an added one lists it', on('codex', 'gpt-6-team', 'high'), both, { ok: false, reason: 'model-not-listed' }],
    ['a level the named instance’s model lacks, though the first’s has it', on('codex', 'gpt-6-sol', 'high', WORK), both, { ok: false, reason: 'effort-not-listed' }],
  ] as const)('answers for %s', (_name, preset, given, expected) => {
    expect(checkPreset(catalog, given, preset)).toEqual(expected);
  });

  it('refuses every model before the catalog arrives', () => {
    expect(checkPreset(undefined, both, on('codex', 'gpt-6-sol', 'high'))).toEqual({ ok: false, reason: 'model-not-listed' });
  });

  // Decision 0016: the fifth field, a speed tier the model lists, asked of an account that can ask.
  it('takes a speed tier the model lists, and carries it in the accepted preset', () => {
    expect(checkPreset(catalog, both, on('codex', 'gpt-6-sol', 'high', 'default', 'priority'))).toEqual({ ok: true, preset: on('codex', 'gpt-6-sol', 'high', 'default', 'priority') });
    expect(checkPreset(catalog, both, on('claude', 'default', 'high', 'default', 'priority'))).toEqual({ ok: true, preset: on('claude', 'opus[1m]', 'high', 'default', 'priority') });
  });

  it('refuses a speed tier the model does not list, and any tier where the account cannot ask for one', () => {
    expect(checkPreset(catalog, both, on('codex', 'gpt-6-sol', 'high', 'default', 'fast'))).toEqual({ ok: false, reason: 'speed-not-listed' });
    const plain = { ...catalog, providers: [claude, { ...codex, models: [model('gpt-6-sol', { listedDefault: true, speedTiers: [] })] }, codexWork, silent] };
    expect(checkPreset(plain, both, on('codex', 'gpt-6-sol', 'high', 'default', 'priority'))).toEqual({ ok: false, reason: 'speed-not-listed' });
    const unable = { ...catalog, providers: [claude, { ...codex, speedTierRequest: { possible: false, reason: 'sdk_opt_in_required' } }, codexWork, silent] };
    expect(checkPreset(unable, both, on('codex', 'gpt-6-sol', 'high', 'default', 'priority'))).toEqual({ ok: false, reason: 'speed-unavailable' });
    // Standard speed is always asked for: the account's word on tiers does not stop it.
    expect(checkPreset(unable, both, on('codex', 'gpt-6-sol', 'high')).ok).toBe(true);
    // An instance's own entry says so, not the provider's first instance's.
    expect(checkPreset(unable, both, on('codex', 'gpt-6-sol', 'low', WORK, 'priority')).ok).toBe(true);
  });
});

describe('speedFor (decision 0016)', () => {
  const tiered = model('m', { speedTiers: [{ id: 'priority', name: 'Fast', description: null }, { id: 'flex', name: 'Flex', description: null }] });
  it('keeps the wanted tier when the model lists it, else standard speed', () => {
    expect(speedFor(tiered, 'priority')).toBe('priority');
    expect(speedFor(tiered, 'flex')).toBe('flex');
    expect(speedFor(tiered, 'fast')).toBeNull();
    expect(speedFor(tiered, null)).toBeNull();
    expect(speedFor(model('n', { speedTiers: [] }), 'priority')).toBeNull();
  });
});

describe('a selection’s key (decision 0016)', () => {
  it('tells a Fast selection from a standard one, and from another tier', () => {
    const standard = on('codex', 'gpt-6-sol', 'high');
    expect(modelSelectionKey(on('codex', 'gpt-6-sol', 'high', 'default', 'priority'))).not.toBe(modelSelectionKey(standard));
    expect(modelSelectionKey(on('codex', 'gpt-6-sol', 'high', 'default', 'priority'))).not.toBe(modelSelectionKey(on('codex', 'gpt-6-sol', 'high', 'default', 'flex')));
    expect(modelSelectionKey({ ...standard })).toBe(modelSelectionKey(standard));
  });
});

describe('the offer, from the provider snapshots (C94; M14b, C25, C30)', () => {
  const snapshot = (id: string, instanceId: string, status: ReturnType<typeof sampleProvider>['status'] = { kind: 'ok' }) => sampleProvider({ id, instanceId, status });
  const OTHER = '11111111-2222-4333-8444-555555555555';

  it('offers the project’s providers, and every switched-on instance of them', () => {
    const given = presetOffer(['codex', 'claude'], [snapshot('claude', 'default'), snapshot('codex', 'default'), snapshot('codex', WORK), snapshot('codex', OTHER, { kind: 'disabled' })]);
    expect(given).toEqual({ offered: ['codex', 'claude'], enabled: ['codex', 'claude'], instances: [first('claude'), first('codex'), work] });
    expect(offeredInstances(given)).toEqual([first('claude'), first('codex'), work]);
    // Every switched-on instance of an offered provider is accepted for the project (C30).
    expect(checkPreset(catalog, given, on('codex', 'gpt-6-team', 'high', WORK)).ok).toBe(true);
    expect(checkPreset(catalog, given, on('codex', 'gpt-6-sol', 'high', OTHER))).toEqual({ ok: false, reason: 'instance-unavailable' });
  });

  // M16 (C42, V14): the popup reads one capability and no provider's name. Once Claude's descriptor
  // says it has sessions, its tiles are offered as Codex's are, whatever else its capabilities say.
  it('offers a provider’s tiles once its descriptor says it has sessions: with no history and with other folders, as Claude’s says', () => {
    const base = sampleProvider({ id: 'claude', instanceId: 'default' });
    const claudeSnapshot = { ...base, descriptor: { ...base.descriptor, capabilities: { ...base.descriptor.capabilities, sessions: true, history: false, otherFolders: true } } };
    const given = presetOffer(['claude'], [claudeSnapshot, snapshot('codex', 'default')]);
    expect(given).toMatchObject({ offered: ['claude'], enabled: ['claude'] });
    expect(presetTiles(catalog, offeredInstances(given)).map((group) => [group.provider.id, keys(group.tiles)])).toEqual([['claude', ['opus[1m]', 'sonnet', 'haiku']]]);
    expect(checkPreset(catalog, given, on('claude', 'sonnet', 'low')).ok).toBe(true);
    expect(preselectPreset({ catalog, offer: given, projectId: 'p', sessions: [] })).toMatchObject({ providerId: 'claude' });
  });

  // M15 (C6, V3): a provider whose descriptor says it has no sessions has no tile, and create refuses it.
  it('offers no provider without sessions, whatever the project lists: its preset is refused as not offered', () => {
    const without = (id: string, instanceId: string) => {
      const base = sampleProvider({ id, instanceId });
      return { ...base, descriptor: { ...base.descriptor, capabilities: { ...base.descriptor.capabilities, sessions: false } } };
    };
    const given = presetOffer(['claude', 'codex'], [without('claude', 'default'), snapshot('codex', 'default'), snapshot('codex', WORK)]);
    expect(given.offered).toEqual(['codex']);
    expect(given.enabled).toEqual(['codex']);
    expect(offeredInstances(given)).toEqual([first('codex'), work]);
    expect(presetTiles(catalog, offeredInstances(given)).map((group) => group.provider.id)).toEqual(['codex', 'codex']);
    expect(checkPreset(catalog, given, on('claude', 'sonnet', 'low'))).toEqual({ ok: false, reason: 'provider-not-offered' });
    expect(checkPreset(catalog, given, on('codex', 'gpt-6-sol', 'low')).ok).toBe(true);
    // With no provider that has sessions, nothing is offered and nothing is preselected.
    const none = presetOffer(['claude'], [without('claude', 'default')]);
    expect(offeredInstances(none)).toEqual([]);
    expect(preselectPreset({ catalog, offer: none, projectId: 'p', sessions: [] })).toBeNull();
  });

  it('leaves out the instances of a provider the project is not offered to', () => {
    const given = presetOffer(['claude'], [snapshot('claude', 'default'), snapshot('codex', 'default'), snapshot('codex', WORK)]);
    expect(offeredInstances(given)).toEqual([first('claude')]);
    expect(checkPreset(catalog, given, on('codex', 'gpt-6-sol', 'low', WORK))).toEqual({ ok: false, reason: 'provider-not-offered' });
  });

  it('reads a provider as switched off from its first instance, which has no switch of its own', () => {
    const given = presetOffer(['claude', 'codex'], [snapshot('claude', 'default'), snapshot('codex', 'default', { kind: 'disabled' }), snapshot('codex', WORK, { kind: 'disabled' })]);
    expect(given.enabled).toEqual(['claude']);
    expect(checkPreset(catalog, given, on('codex', 'gpt-6-sol', 'low', WORK))).toEqual({ ok: false, reason: 'provider-unavailable' });
    // A provider this build does not have reads the same.
    expect(presetOffer(['gemini'], [snapshot('claude', 'default')]).enabled).toEqual([]);
  });

  it.each([
    ['an entry that cannot be used', { kind: 'blocked', reason: 'invalid-instance', issue: 'invalid-label' }],
    ['one whose folder is gone', { kind: 'blocked', reason: 'folder-missing' }],
    ['one whose folder is refused', { kind: 'blocked', reason: 'folder-refused', rule: 'project' }],
  ] as const)('leaves out %s', (_name, status) => {
    const given = presetOffer(['codex'], [snapshot('codex', 'default'), snapshot('codex', WORK, status)]);
    expect(given.instances).toEqual([first('codex')]);
  });

  it.each([{ kind: 'not-logged-in' }, { kind: 'detecting' }, { kind: 'error', message: 'x' }, { kind: 'not-installed', overrideInvalid: false }, { kind: 'stale' }] as const)(
    'keeps an instance that reads $kind: its models, if it lists any, say whether a session can start',
    (status) => {
      expect(presetOffer(['codex'], [snapshot('codex', 'default'), snapshot('codex', WORK, status)]).instances).toEqual([first('codex'), work]);
    },
  );
});

describe('preselectPreset (C83; M14b, C27)', () => {
  const A = 'project-a';
  const B = 'project-b';
  const session = (projectId: string, providerId: string, modelKey: string, effort: string | null, createdAt: number, instanceId = 'default', speed: string | null = null) => ({ projectId, providerId, instanceId, model: modelKey, effort, speed, createdAt });
  const pick = (sessions: ReturnType<typeof session>[], given = both) => preselectPreset({ catalog, offer: given, projectId: A, sessions });

  it('is the preset of the project’s newest session by its created time', () => {
    expect(pick([session(A, 'codex', 'gpt-5.6', 'low', 100), session(A, 'claude', 'sonnet', 'high', 300), session(B, 'codex', 'gpt-6-sol', 'ultra', 900)])).toEqual(on('claude', 'sonnet', 'high'));
  });

  it('carries the instance of the session it takes its preset from', () => {
    expect(pick([session(A, 'codex', 'gpt-5.6', 'low', 100), session(A, 'codex', 'gpt-6-team', 'high', 300, WORK)])).toEqual(on('codex', 'gpt-6-team', 'high', WORK));
  });

  it('else that of the newest session in any project', () => {
    expect(pick([session(B, 'codex', 'gpt-5.6', 'low', 100), session(B, 'codex', 'gpt-6-sol', 'ultra', 900)])).toEqual(on('codex', 'gpt-6-sol', 'ultra'));
  });

  it('else the default preset, on the first offered provider’s first switched-on instance', () => {
    expect(pick([])).toEqual(on('claude', 'opus[1m]', 'medium'));
    expect(pick([], offer(['codex'], ['claude', 'codex']))).toEqual(on('codex', 'gpt-6-sol', 'medium'));
    // A provider switched off offers no default either.
    expect(pick([], offer(['claude', 'codex'], ['codex']))).toEqual(on('codex', 'gpt-6-sol', 'medium'));
    // Nor does an instance that is: the provider's next one.
    expect(pick([], offer(['codex'], ['codex'], [work]))).toEqual(on('codex', 'gpt-6-sol', 'medium', WORK));
  });

  it.each([
    ['whose provider the project does not offer', session(A, 'codex', 'gpt-6-sol', 'high', 300), offer(['claude'], ['claude', 'codex'])],
    ['whose model is hidden now', session(A, 'codex', 'gpt-hidden', 'high', 300), both],
    ['whose level the model lacks now', session(A, 'codex', 'gpt-6-sol', 'max', 300), both],
    ['whose instance is no longer configured', session(A, 'codex', 'gpt-6-sol', 'high', 300, '11111111-2222-4333-8444-555555555555'), both],
    ['whose instance is switched off', session(A, 'codex', 'gpt-6-sol', 'low', 300, WORK), offer(['claude', 'codex'], ['claude', 'codex'], [first('claude'), first('codex')])],
    ['whose model its own instance lacks, though another lists it', session(A, 'codex', 'gpt-5.6', 'high', 300, WORK), both],
  ])('skips a preset create would refuse: one %s', (_name, newest, given) => {
    const fallback = session(B, 'claude', 'sonnet', 'low', 100);
    expect(pick([newest, fallback], given)).toEqual(on('claude', 'sonnet', 'low'));
  });

  it('carries the speed tier of the session it takes its preset from, or standard speed where that tier cannot be asked now (decision 0016)', () => {
    expect(pick([session(A, 'codex', 'gpt-6-sol', 'high', 300, 'default', 'priority')])).toEqual(on('codex', 'gpt-6-sol', 'high', 'default', 'priority'));
    // A tier its model no longer lists: the same session's preset, at standard speed, and not an older session's.
    const older = session(A, 'claude', 'sonnet', 'low', 100);
    expect(pick([session(A, 'codex', 'gpt-6-sol', 'high', 300, 'default', 'fast'), older])).toEqual(on('codex', 'gpt-6-sol', 'high'));
  });

  it('carries the surviving tile’s key for a session stored under the row left out (C94)', () => {
    expect(pick([session(A, 'claude', 'default', 'medium', 300)])).toEqual(on('claude', 'opus[1m]', 'medium'));
  });

  it('is nothing when no provider lists a model', () => {
    expect(preselectPreset({ catalog, offer: offer(['gemini'], ['gemini']), projectId: A, sessions: [] })).toBeNull();
  });
});

describe('the preset’s schema (C78; M14b, C25)', () => {
  it('is a provider, an instance, a model key, an effort id or null and a speed tier id or null, and nothing else', () => {
    expect(ModelPresetSchema.safeParse(on('codex', 'gpt-6-sol', 'high')).success).toBe(true);
    expect(ModelPresetSchema.safeParse(on('claude', 'opus[1m]', null)).success).toBe(true);
    expect(ModelPresetSchema.safeParse(on('codex', 'gpt-6-sol', 'high', WORK)).success).toBe(true);
    expect(ModelPresetSchema.safeParse({ providerId: 'claude', instanceId: 'default', model: 'opus[1m]' }).success).toBe(false);
    // The speed tier (decision 0016): an id or null, and never left out.
    expect(ModelPresetSchema.safeParse(on('codex', 'gpt-6-sol', 'high', 'default', 'priority')).success).toBe(true);
    expect(ModelPresetSchema.safeParse({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high' }).success).toBe(false);
    expect(ModelPresetSchema.safeParse(on('codex', 'gpt-6-sol', 'high', 'default', 'very fast')).success).toBe(false);
    expect(ModelPresetSchema.safeParse(on('', 'opus[1m]', null)).success).toBe(false);
    expect(ModelPresetSchema.safeParse({ ...on('claude', 'opus[1m]', null), type: 'plan' }).success).toBe(false);
    // The instance: the first one's id or a UUID, never a label or a folder.
    expect(ModelPresetSchema.safeParse({ providerId: 'claude', model: 'opus[1m]', effort: null }).success).toBe(false);
    for (const instanceId of ['', 'Work', 'D:\\accounts\\work', 7, null]) {
      expect(ModelPresetSchema.safeParse({ providerId: 'codex', instanceId, model: 'gpt-6-sol', effort: 'high' }).success).toBe(false);
    }
  });
});
