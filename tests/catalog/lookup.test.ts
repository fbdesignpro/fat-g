// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13 (docs/planning/_archive/M13.md, Design 7; C17, C46–C49): findModel on the catalog M10's captures give,
// built as the app builds it: each adapter's mapping of the captured reply, merged with the defaults.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CatalogState, findModel, genericModel, type ModelReport, modelListed } from '@shared/contracts/catalog';
import { parseDefaults } from '../../src/main/catalog/defaults';
import { mergeCatalog } from '../../src/main/catalog/merge';
import { builtInProviders } from '../../src/main/providers';
import { mapClaudeModels } from '../../src/main/providers/claude/models';
import { mapCodexModels } from '../../src/main/providers/codex/models';

const json = (file: string): unknown => JSON.parse(readFileSync(path.resolve('tests/fixtures', file), 'utf8'));
const claudeReply = json('claude/models.json') as { models: unknown; fast_mode_state: unknown; fast_mode_disabled_reason: unknown };
const codexPage = json('codex/model-list.json') as { data: unknown[] };
const reports: Record<string, ModelReport | null> = {
  claude: mapClaudeModels({ models: claudeReply.models, fastModeState: claudeReply.fast_mode_state, fastModeDisabledReason: claudeReply.fast_mode_disabled_reason }),
  codex: mapCodexModels(codexPage.data),
};
const catalog: CatalogState = {
  override: { kind: 'none', path: 'catalog.json' },
  providers: builtInProviders('0.0.0').map((definition) => {
    const report = reports[definition.descriptor.id] ?? null;
    return mergeCatalog({ id: definition.descriptor.id, defaults: parseDefaults(definition), report: report === null ? null : { report, at: 1 }, override: null }).provider;
  }),
};
const CLAUDE = { providerId: 'claude', instanceId: 'default' };
const CODEX = { providerId: 'codex', instanceId: 'default' };
/** What the Claude sessions of the M10 captures reported as applied (models research §1). */
const APPLIED = { idle: 'claude-opus-5[1m]', launched: 'claude-fable-5-1', unknown: 'm10-no-such-model' };

describe('findModel on the captured catalog (V13)', () => {
  it('is built from the reports', () => {
    // Claude's `default` and `opus[1m]` name one version: one model (decision 0016).
    expect(catalog.providers.map((entry) => [entry.id, entry.source.kind, entry.models.length])).toEqual([['claude', 'report', 4], ['codex', 'report', 9]]);
  });

  it('finds a model by its key, the exact version it names', () => {
    expect(findModel(catalog, CLAUDE, 'claude-sonnet-5')).toMatchObject({ key: 'claude-sonnet-5', name: 'Sonnet', origin: 'reported' });
    expect(findModel(catalog, CODEX, 'gpt-6-astra')).toMatchObject({ key: 'gpt-6-astra', listedDefault: true });
  });

  it('finds a model by the resolved id a session reports', () => {
    expect(findModel(catalog, CLAUDE, APPLIED.launched)).toMatchObject({ key: 'claude-fable-5-1[1m]', name: 'Fable' });
    expect(findModel(catalog, CLAUDE, 'claude-haiku-4-5-20251001')).toMatchObject({ key: 'claude-haiku-4-5-20251001', efforts: [] });
  });

  it('names the model the default row means by the row that names it (C47)', () => {
    expect(findModel(catalog, CLAUDE, APPLIED.idle)).toMatchObject({ key: 'claude-opus-5[1m]', name: 'Opus (1M context)', listedDefault: true });
  });

  it('finds no model by an alias, which the CLI may point at another version (decision 0016)', () => {
    for (const alias of ['default', 'opus[1m]', 'sonnet', 'haiku']) expect(findModel(catalog, CLAUDE, alias)).toEqual(genericModel(alias));
  });

  it('finds a hidden model like the others (C17, C46)', () => {
    expect(findModel(catalog, CODEX, 'codex-auto-review')).toMatchObject({ key: 'codex-auto-review', hidden: true });
  });

  it('answers the generic entry for a model the CLI accepted but the catalog does not know (C48)', () => {
    expect(findModel(catalog, CLAUDE, APPLIED.unknown)).toEqual(genericModel(APPLIED.unknown));
    expect(findModel(catalog, CLAUDE, APPLIED.unknown)).toMatchObject({ name: 'm10-no-such-model', efforts: [], speedTiers: [], origin: 'generic' });
  });

  it('leaves the catalog as it was', () => {
    const before = JSON.stringify(catalog);
    for (const id of [...Object.values(APPLIED), 'claude-sonnet-5', 'gpt-reserve']) findModel(catalog, CLAUDE, id);
    expect(JSON.stringify(catalog)).toBe(before);
    expect(catalog.providers[0]?.models.map((model) => model.key)).not.toContain(APPLIED.unknown);
  });
});

describe('whether an account lists a session’s model (decision 0016)', () => {
  it('answers by the key alone, a hidden model counting', () => {
    expect(modelListed(catalog, CLAUDE, 'claude-fable-5-1[1m]')).toBe(true);
    expect(modelListed(catalog, CODEX, 'codex-auto-review')).toBe(true);
    // An alias, a resolved id that is not a key, and an unknown id are not listed.
    expect(modelListed(catalog, CLAUDE, 'sonnet')).toBe(false);
    expect(modelListed(catalog, CLAUDE, APPLIED.launched)).toBe(false);
    expect(modelListed(catalog, CLAUDE, APPLIED.unknown)).toBe(false);
  });

  it('decides nothing for an instance whose CLI has not reported, or that the catalog does not hold', () => {
    const unreported: CatalogState = { ...catalog, providers: catalog.providers.map((entry) => ({ ...entry, source: { kind: 'none' } as const })) };
    expect(modelListed(unreported, CLAUDE, 'claude-sonnet-5')).toBeNull();
    expect(modelListed(catalog, { providerId: 'claude', instanceId: '11111111-2222-4333-8444-555555555555' }, 'claude-sonnet-5')).toBeNull();
    expect(modelListed(undefined, CLAUDE, 'claude-sonnet-5')).toBeNull();
  });
});
