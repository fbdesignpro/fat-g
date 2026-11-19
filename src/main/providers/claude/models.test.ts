// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V29 (docs/planning/_archive/M13.md; C4, C8, C15, C16, C26, C27, C67, C68): Claude's models, mapped from
// the `initialize` reply of M10's idle discovery session.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelReportSchema } from '@shared/contracts/catalog';
import { claudeModelKey, claudeModelLabel, claudeSmallModelVersion, FAST_TIER, mapClaudeModels } from './models';

it('recognizes only Haiku as the small family, with numeric versions and dated revisions', () => {
  expect(claudeSmallModelVersion('haiku')).toEqual([0]);
  expect(claudeSmallModelVersion('claude-haiku-4-5-20251001')).toEqual([4, 5, 20251001]);
  expect(claudeSmallModelVersion('claude-haiku-5-10')).toEqual([5, 10, 0]);
  expect(claudeSmallModelVersion('claude-opus-6-1')).toBeNull();
  expect(claudeSmallModelVersion('custom-haiku-model')).toBeNull();
});

interface Fixture { models: Record<string, unknown>[]; fast_mode_state: string; fast_mode_disabled_reason: string }
const FIXTURE = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/models.json'), 'utf8')) as Fixture;
const reply = (models: unknown = FIXTURE.models, fastModeState: unknown = FIXTURE.fast_mode_state, fastModeDisabledReason: unknown = FIXTURE.fast_mode_disabled_reason) =>
  ({ models, fastModeState, fastModeDisabledReason });
const mapped = () => {
  const report = mapClaudeModels(reply());
  if (report === null) throw new Error('no report');
  return report;
};

describe('Claude’s models (V6)', () => {
  it('keys each row of the reply by the exact version it names, with resolved ids, names and effort levels (C4; decision 0016)', () => {
    // `default` and `opus[1m]` name one version: one model, in the first row's place, in the words of the row that names it.
    expect(mapped().models.map((model) => [model.key, model.resolvedId, model.name, model.efforts.length])).toEqual([
      ['claude-opus-5[1m]', 'claude-opus-5[1m]', 'Opus (1M context)', 5],
      ['claude-fable-5-1[1m]', 'claude-fable-5-1', 'Fable', 5],
      ['claude-sonnet-5', 'claude-sonnet-5', 'Sonnet', 5],
      ['claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'Haiku', 0],
    ]);
    expect(mapped().models[0]?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(mapped().dropped).toBe(0);
  });

  it('keeps a value’s context mark the resolved id leaves out, and adds none it already has', () => {
    expect(claudeModelKey('claude-fable-5-1[1m]', 'claude-fable-5-1')).toBe('claude-fable-5-1[1m]');
    expect(claudeModelKey('opus[1m]', 'claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(claudeModelKey('default', 'claude-opus-5[1m]')).toBe('claude-opus-5[1m]');
    expect(claudeModelKey('fable', 'claude-fable-5-2')).toBe('claude-fable-5-2');
    // Nothing to pin: the value stays.
    expect(claudeModelKey('fable', null)).toBe('fable');
  });

  it('makes one model of rows naming one version, whichever comes first, the listed default if either was', () => {
    const rows = [
      { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable', supportedEffortLevels: ['low', 'high'] },
      { value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default (recommended)', supportedEffortLevels: ['low'] },
      { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
    ];
    const report = mapClaudeModels(reply(rows));
    expect(report?.models.map((model) => [model.key, model.name, model.efforts, model.listedDefault])).toEqual([
      ['claude-fable-5-2', 'Fable', ['low', 'high'], true],
      ['claude-fable-5-1', 'Fable 5.1', [], false],
    ]);
    expect(report?.dropped).toBe(0);
    // A row the CLI resolves to nothing keeps its value, and is no other row's.
    expect(mapClaudeModels(reply([{ value: 'default', displayName: 'Default' }]))?.models.map((model) => [model.key, model.listedDefault])).toEqual([['default', true]]);
  });

  it('gives the tier fast to the rows that support fast mode, and none to the others (C68)', () => {
    expect(mapped().models.map((model) => model.speedTiers)).toEqual([[FAST_TIER], [], [], []]);
    // What choosing it costs, in the module's words (decision 0013), and a report the catalog takes with it.
    expect(FAST_TIER).toEqual({ id: 'fast', name: 'Fast', description: null, warning: 'Billed as extra usage, at a higher rate; with none left, replies run at standard speed.' });
    expect(ModelReportSchema.safeParse(mapped()).success).toBe(true);
  });

  it('carries the CLI’s reason while fast mode is not on, and none once it is (C67)', () => {
    expect(mapped().speedTierReason).toBe('sdk_opt_in_required');
    expect(mapClaudeModels(reply(FIXTURE.models, 'on'))?.speedTierReason).toBeNull();
    expect(mapClaudeModels(reply(FIXTURE.models, undefined))?.speedTierReason).toBe('sdk_opt_in_required');
    expect(mapClaudeModels(reply(FIXTURE.models, 'off', 'not an id'))?.speedTierReason).toBeNull();
  });

  it('lists no default effort and hides nothing; the model the default row names is the listed default (C7)', () => {
    expect(mapped().models.map((model) => [model.listedDefault, model.listedDefaultEffort, model.hidden])).toEqual([
      [true, null, false], [false, null, false], [false, null, false], [false, null, false],
    ]);
  });

  it('forwards the fields the catalog holds, and nothing else of the reply (C26)', () => {
    expect(JSON.stringify(mapped())).not.toMatch(/supportsAutoMode|supportsAdaptiveThinking|supportsEffort"|value/);
    for (const model of mapped().models) expect(Object.keys(model).sort()).toEqual(['description', 'efforts', 'hidden', 'key', 'listedDefault', 'listedDefaultEffort', 'name', 'resolvedId', 'speedTiers']);
  });

  it.each([
    ['a row with no value', { displayName: 'Nameless' }],
    ['a value outside the bounds', { value: 'claude opus' }],
    ['a resolved model outside the bounds', { value: 'odd', resolvedModel: '<script>' }],
    ['an effort level outside the bounds', { value: 'odd', supportedEffortLevels: ['very high'] }],
    ['17 effort levels', { value: 'odd', supportedEffortLevels: Array.from({ length: 17 }, (_, index) => `e${index}`) }],
    ['a field of the wrong type', { value: 'odd', supportsFastMode: 'yes' }],
    ['a row that is not an object', 'sonnet'],
    ['a resolved model whose context mark makes the key too long', { value: 'odd[1m]', resolvedModel: 'x'.repeat(126) }],
  ])('drops %s and counts it, while the others apply (C16)', (_name, row) => {
    const report = mapClaudeModels(reply([...FIXTURE.models, row]));
    expect(report?.models).toHaveLength(4);
    expect(report?.dropped).toBe(1);
  });

  it('takes a row naming a version seen before into that model, uncounted', () => {
    const report = mapClaudeModels(reply([...FIXTURE.models, { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Other' }]));
    expect(report?.models).toHaveLength(4);
    expect(report?.models[3]?.name).toBe('Haiku');
    expect(report?.dropped).toBe(0);
  });

  it('cleans and clamps what the CLI names and describes (C9)', () => {
    const report = mapClaudeModels(reply([{ value: 'x', displayName: `  ${'n'.repeat(70)}\n`, description: '' }]));
    expect(report?.models[0]).toMatchObject({ name: `${'n'.repeat(59)}…`, description: null, resolvedId: null });
  });

  it.each([
    ['no models field', undefined],
    ['models that are not a list', { value: 'sonnet' }],
    ['an empty list', []],
    ['a list with no readable row', [{ displayName: 'x' }, 3]],
  ])('sends nothing for %s (C15)', (_name, models) => {
    expect(mapClaudeModels({ models, fastModeState: 'off', fastModeDisabledReason: 'sdk_opt_in_required' })).toBeNull();
  });
});

describe('the fixture (V29)', () => {
  it('holds the rows and fast-mode fields of the discovery capture', () => {
    const capture = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures/discovery-idle.json'), 'utf8')) as { frames: { frame?: { response?: { response?: Record<string, unknown> } } }[] };
    const initialize = capture.frames.map((entry) => entry.frame?.response?.response).find((value) => value?.['models'] !== undefined);
    expect(FIXTURE).toEqual({ models: initialize?.['models'], fast_mode_state: initialize?.['fast_mode_state'], fast_mode_disabled_reason: initialize?.['fast_mode_disabled_reason'] });
  });
});

// Decision 0032: the overlay's default texts, read from each resolved model the fixture lists.
describe('a model’s version and short name', () => {
  it('are the family, capitalised, and its major and minor version, a date and a context mark aside', () => {
    expect(FIXTURE.models.map((row) => [row['resolvedModel'], claudeModelLabel(String(row['resolvedModel']))])).toEqual([
      ['claude-opus-5[1m]', { version: '5', name: 'Opus' }],
      ['claude-opus-5[1m]', { version: '5', name: 'Opus' }],
      ['claude-fable-5-1', { version: '5.1', name: 'Fable' }],
      ['claude-sonnet-5', { version: '5', name: 'Sonnet' }],
      ['claude-haiku-4-5-20251001', { version: '4.5', name: 'Haiku' }],
    ]);
    expect(claudeModelLabel('claude-opus-5-5')).toEqual({ version: '5.5', name: 'Opus' });
    // An alias says nothing: its resolved id is read instead.
    expect(claudeModelLabel('opus[1m]')).toEqual({ version: null, name: null });
  });
});
