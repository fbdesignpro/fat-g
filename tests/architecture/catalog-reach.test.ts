// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9 (docs/planning/_archive/M13.md; C33, C35): the catalog reads the user's catalog.json and nothing else,
// and writes nothing at all — the reports stay in memory, and the file is the user's.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_FILE, type ModelReport } from '@shared/contracts/catalog';
import type { AgentProvider, ProviderEvent } from '@shared/provider-kit/provider';
import { nodeOverrideIo, type OverrideIo } from '../../src/main/catalog/override';
import { builtInProviders } from '../../src/main/providers';
import { createCatalogService } from '../../src/main/services/catalog-service';
import { createAppStateStore } from '../../src/main/state/app-state-store';

const ROOT = path.resolve(import.meta.dirname, '../..');

function sources(directory = 'src'): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), 'fatg-catalog-reach-')); });
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

describe('what the catalog reads and writes (V9)', () => {
  it('reads catalog.json alone, at start and on Reload, and leaves the folder byte-identical', () => {
    const file = path.join(dataDir, CATALOG_FILE);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, providers: { codex: { models: { 'gpt-5.5': { hidden: true } } } } }));
    writeFileSync(file, bytes);
    writeFileSync(path.join(dataDir, 'preferences.json'), '{"untouched":true}');
    const touched: string[] = [];
    const io: OverrideIo = {
      size: (name) => { touched.push(name); return nodeOverrideIo.size(name); },
      readText: (name) => { touched.push(name); return nodeOverrideIo.readText(name); },
    };
    let listener: ((event: ProviderEvent) => void) | undefined;
    const provider = { subscribe: (next: (event: ProviderEvent) => void) => { listener = next; return () => undefined; } } as unknown as AgentProvider;
    const service = createCatalogService({ definitions: builtInProviders('0.0.0'), store: createAppStateStore(), dir: dataDir, io, log: { info: () => undefined, warn: () => undefined } });
    // A report, taken and dropped, and the file read again: memory only (C33).
    service.attach({ id: 'codex', generation: 1, provider });
    const report: ModelReport = { models: [{ key: 'm', resolvedId: null, name: null, description: null, efforts: [], listedDefaultEffort: null, listedDefault: false, hidden: false, speedTiers: [] }], speedTierReason: null, dropped: 0 };
    listener?.({ type: 'models', report });
    service.readEnded({ providerId: 'codex', instanceId: 'default' }, { byRefresh: false, outcome: 'signed-out', startedAt: 0 });
    service.reload();
    service.detach({ providerId: 'codex', instanceId: 'default' });
    service.stop();

    expect(touched.length).toBeGreaterThan(0);
    expect(new Set(touched)).toEqual(new Set([file]));
    expect(readdirSync(dataDir).sort()).toEqual([CATALOG_FILE, 'preferences.json']);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readFileSync(path.join(dataDir, 'preferences.json'), 'utf8')).toBe('{"untouched":true}');
  });
});

describe('the source (V9)', () => {
  const CATALOG_SOURCES = [
    ...sources('src/main/catalog'),
    'src/main/services/catalog-service.ts',
    'src/main/ipc/handlers/catalog.ts',
    'src/shared/contracts/catalog.ts',
  ];

  it('calls no writing function anywhere in the catalog’s code', () => {
    const CALL = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|truncate|writeFileAtomic|setAside)\s*\(/;
    expect(CATALOG_SOURCES.length).toBeGreaterThan(5);
    expect(CATALOG_SOURCES.filter((file) => CALL.test(read(file)))).toEqual([]);
    // Nor does it reach the stores' writers.
    expect(CATALOG_SOURCES.filter((file) => /atomic-write|set-aside/.test(read(file)))).toEqual([]);
  });

  it('spells the file’s name once, in the contract: every other use goes through CATALOG_FILE', () => {
    const literal = /(['"`])catalog\.json\1/;
    expect(sources('src').filter((file) => literal.test(read(file)))).toEqual(['src/shared/contracts/catalog.ts']);
  });
});
