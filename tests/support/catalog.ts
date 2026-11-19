// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sample catalog data for tests in both Vitest projects (node and jsdom). Pure data and no Node APIs:
// tsconfig.web.json compiles this file too.
import type { CatalogDefaults, CatalogModel, CatalogProvider, CatalogState, ProviderPresentation } from '@shared/contracts/catalog';

export const SAMPLE_PRESENTATION: ProviderPresentation = {
  barColor: '#ff9933',
  icon: { viewBox: '0 0 24 24', path: 'M2 2H22V22H2Z' },
  stream: { ground: '#541704', lights: ['#791e08', '#8c260b', '#982c0e', '#a4300c', '#b73d12', '#c24714'] },
};
export const SAMPLE_CATALOG_PATH = 'C:\\Users\\someone\\AppData\\Roaming\\fat-g\\catalog.json';

/** A provider module's defaults: its look and two levels. No model: those come from the CLI (C75). */
export function sampleCatalogDefaults(overrides: Partial<CatalogDefaults> = {}): CatalogDefaults {
  return {
    presentation: SAMPLE_PRESENTATION,
    canRequestSpeedTier: true,
    efforts: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
    ...overrides,
  };
}

export function sampleModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    key: 'sample-1', resolvedId: 'sample-1', name: 'Sample One', description: 'A model for tests.',
    efforts: [{ id: 'low', label: 'Low', place: 1, caution: false }, { id: 'high', label: 'High', place: 2, caution: false }],
    listedDefaultEffort: 'low', listedDefault: true, hidden: false,
    speedTiers: [{ id: 'priority', name: 'Fast', description: null }],
    origin: 'reported', overridden: false, hiddenByOverride: false, avatar: null,
    ...overrides,
  };
}

export function sampleCatalogProvider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: 'claude',
    instanceId: 'default',
    presentation: SAMPLE_PRESENTATION,
    source: { kind: 'report', at: 1_578_851_400_000 },
    speedTierRequest: { possible: true, reason: null },
    models: [sampleModel()],
    ...overrides,
  };
}

/** The built-in colours for their ids; any other id gets a grey of its own, so tests can tell them apart. */
export function sampleBarColor(id: string, index = 0): string {
  if (id === 'claude') return '#ff9933';
  if (id === 'codex') return '#1991e2';
  return `#${(0x40 + index * 8).toString(16).repeat(3)}`;
}

/** One entry per provider id, in that order. */
export function sampleCatalog(providerIds: readonly string[], overrides: Partial<CatalogState> = {}): CatalogState {
  return {
    providers: providerIds.map((id, index) => sampleCatalogProvider({ id, presentation: { ...SAMPLE_PRESENTATION, barColor: sampleBarColor(id, index) } })),
    override: { kind: 'none', path: SAMPLE_CATALOG_PATH },
    ...overrides,
  };
}
