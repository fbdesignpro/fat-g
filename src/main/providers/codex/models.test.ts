// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7, V29 (docs/planning/_archive/M13.md; C4, C8, C15, C16, C26, C29, C68): Codex's models, mapped from the
// `model/list` reply of M10's discovery capture, checked again.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexModelLabel, codexSmallModelVersion, mapCodexModels } from './models';

it('recognizes only Luna as the small family, with numeric versions and dated revisions', () => {
  expect(codexSmallModelVersion('gpt-6-luna')).toEqual([6, 0, 0]);
  expect(codexSmallModelVersion('gpt-6.10-luna')).toEqual([6, 10, 0]);
  expect(codexSmallModelVersion('gpt-6.1-luna-20261001')).toEqual([6, 1, 20261001]);
  expect(codexSmallModelVersion('gpt-7-sol')).toBeNull();
  expect(codexSmallModelVersion('custom-luna')).toBeNull();
});

interface Page { data: Record<string, unknown>[]; nextCursor: string | null }
const FIXTURE = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/model-list.json'), 'utf8')) as Page;
const mapped = (rows: readonly unknown[] = FIXTURE.data) => {
  const report = mapCodexModels(rows);
  if (report === null) throw new Error('no report');
  return report;
};
const astra = FIXTURE.data[0] ?? {};

describe('Codex’s models (V7)', () => {
  it('maps the nine rows, two of them hidden, each with its one tier (C4, C8, C17)', () => {
    const report = mapped();
    expect(report.models.map((model) => model.key)).toEqual([
      'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-reserve', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'codex-auto-review',
    ]);
    expect(report.models.filter((model) => model.hidden).map((model) => model.key)).toEqual(['gpt-reserve', 'codex-auto-review']);
    expect(report.models.every((model) => model.speedTiers.length === 1 && model.speedTiers[0]?.id === 'priority' && model.speedTiers[0].name === 'Fast')).toBe(true);
    expect(report).toMatchObject({ speedTierReason: null, dropped: 0 });
  });

  it('keeps the key and the resolved id apart, and the listed defaults as listed (C4, C7)', () => {
    expect(mapped().models[0]).toMatchObject({
      key: 'gpt-6-astra', resolvedId: 'gpt-6-astra', name: 'GPT-6-Astra', listedDefault: true, listedDefaultEffort: 'medium',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    });
    expect(mapped().models.filter((model) => model.listedDefault)).toHaveLength(1);
    expect(mapped().models.find((model) => model.key === 'gpt-5.6-sol')?.listedDefaultEffort).toBe('low');
  });

  // Decision 0013: what the CLI says of each level is kept, by its id, for the level's explanation.
  it('keeps what the CLI says of each level, by its id', () => {
    expect(mapped().models[0]?.effortDescriptions).toEqual({
      low: 'Fast responses with lighter reasoning',
      medium: 'Balances speed and reasoning depth for everyday tasks',
      high: 'Greater reasoning depth for complex problems',
      xhigh: 'Extra high reasoning depth for complex problems',
      max: 'Maximum reasoning depth for the hardest problems',
      ultra: 'Maximum reasoning with automatic task delegation',
    });
  });

  it('keeps no description it cannot show, and none for a level it does not list', () => {
    const levels = [
      { reasoningEffort: 'low', description: '  Quick\u0000  ' },
      { reasoningEffort: 'medium', description: '' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'max', description: null },
    ];
    expect(mapped([{ ...astra, supportedReasoningEfforts: levels }]).models[0]).toMatchObject({ efforts: ['low', 'medium', 'high', 'max'], effortDescriptions: { low: 'Quick' } });
    const none = mapped([{ ...astra, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }]).models[0];
    expect(none).not.toHaveProperty('effortDescriptions');
  });

  it('lists ultra on four of the nine models, as the capture does (C66)', () => {
    expect(mapped().models.filter((model) => model.efforts.includes('ultra')).map((model) => model.key)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  });

  it('keeps two tiers of one model, in the CLI’s order (C8)', () => {
    const tiers = [{ id: 'flex', name: 'Flex', description: 'Cheaper, slower' }, { id: 'priority', name: 'Fast', description: null }];
    expect(mapped([{ ...astra, serviceTiers: tiers }]).models[0]?.speedTiers).toEqual(tiers);
  });

  it('forwards the fields the catalog holds, and nothing else of the reply (C26)', () => {
    expect(JSON.stringify(mapped())).not.toMatch(/upgradeInfo|migrationMarkdown|inputModalities|multiAgentVersion|additionalSpeedTiers|availabilityNux/);
  });

  it.each([
    ['a row with no id', { displayName: 'Nameless' }],
    ['an id outside the bounds', { ...astra, id: 'gpt 6' }],
    ['a model outside the bounds', { ...astra, id: 'odd', model: 'gpt/../6 x' }],
    ['a default effort outside the bounds', { ...astra, id: 'odd', defaultReasoningEffort: 'very high' }],
    ['a tier id outside the bounds', { ...astra, id: 'odd', serviceTiers: [{ id: 'fast mode', name: 'Fast' }] }],
    ['nine tiers', { ...astra, id: 'odd', serviceTiers: Array.from({ length: 9 }, (_, index) => ({ id: `t${index}`, name: 'T' })) }],
    ['a field of the wrong type', { ...astra, id: 'odd', hidden: 'no' }],
    ['a key seen before', { ...astra }],
  ])('drops %s and counts it, while the others apply (C16)', (_name, row) => {
    const report = mapCodexModels([...FIXTURE.data, row]);
    expect(report?.models).toHaveLength(9);
    expect(report?.dropped).toBe(1);
  });

  it.each([['no rows', []], ['no readable row', [{ id: 'bad id' }, null, 'gpt-6-astra']]])('sends nothing for %s (C15)', (_name, rows) => {
    expect(mapCodexModels(rows)).toBeNull();
  });

  it('reads at most 200 rows and counts the rest as left out', () => {
    const many = Array.from({ length: 205 }, (_, index) => ({ ...astra, id: `m${index}`, model: `m${index}` }));
    expect(mapped(many)).toMatchObject({ dropped: 5 });
    expect(mapped(many).models).toHaveLength(200);
  });
});

describe('the fixture (V29)', () => {
  it('holds the reply of the discovery capture', () => {
    const capture = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/discovery.json'), 'utf8')) as { frames: { frame?: { result?: { data?: unknown } } }[] };
    expect(FIXTURE).toEqual(capture.frames.map((entry) => entry.frame?.result).find((result) => Array.isArray(result?.data)));
  });
});

// Decision 0032: the overlay's default texts, read from each id the fixture lists.
describe('a model’s version and short name', () => {
  it('are the id’s version and its word, the word capitalised', () => {
    expect(FIXTURE.data.map((row) => [row['id'], codexModelLabel(String(row['id']))])).toEqual([
      ['gpt-6-astra', { version: '6', name: 'Astra' }],
      ['gpt-6-sol', { version: '6', name: 'Sol' }],
      ['gpt-6-luna', { version: '6', name: 'Luna' }],
      ['gpt-reserve', { version: null, name: null }],
      ['gpt-5.6-sol', { version: '5.6', name: 'Sol' }],
      ['gpt-5.6-terra', { version: '5.6', name: 'Terra' }],
      ['gpt-5.6-luna', { version: '5.6', name: 'Luna' }],
      ['gpt-5.5', { version: '5.5', name: null }],
      ['codex-auto-review', { version: null, name: null }],
    ]);
    expect(codexModelLabel('gpt-6.1-sol')).toEqual({ version: '6.1', name: 'Sol' });
  });
});
