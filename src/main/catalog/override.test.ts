// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V11 (docs/planning/_archive/M13.md, Design 6; C36–C45): the user's catalog.json, read with a real file
// system in a temp folder, so "byte-identical" means the bytes on disk.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_FILE } from '@shared/contracts/catalog';
import { sampleProvider } from '../../../tests/support/app-state';
import { builtInProviders } from '../providers';
import { createCatalogService } from '../services/catalog-service';
import { createAppStateStore } from '../state/app-state-store';
import { type OverrideIo, type OverrideReading, readOverride } from './override';

const KNOWN = new Set(['claude', 'codex']);
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-catalog-'));
  file = path.join(dir, CATALOG_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const envelope = { schemaVersion: 1, minReaderVersion: 1 };
const place = (content: string | object): Buffer => {
  const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  writeFileSync(file, bytes);
  return bytes;
};
const read = (reader = 1): OverrideReading => readOverride(file, KNOWN, undefined, reader);
const applied = (reading: OverrideReading) => {
  if (reading.kind !== 'applied') throw new Error(`not applied: ${JSON.stringify(reading)}`);
  return reading;
};
const codexModels = (reading: OverrideReading) => Object.fromEntries(applied(reading).providers.get('codex')?.models ?? []);

describe('a missing file (C40)', () => {
  it('is no override and no error', () => {
    expect(read()).toEqual({ kind: 'none' });
  });
});

describe('a file fat-g ignores whole (V10; C36, C41, C44, C45)', () => {
  it.each([
    ['too-large', () => place(`{"schemaVersion":1,"minReaderVersion":1,"pad":"${'x'.repeat(256 * 1024)}"}`), 1, null],
    ['not-json', () => place('{ "schemaVersion": 1, '), 1, null],
    ['damaged', () => place({ providers: {} }), 1, null],
    ['damaged', () => place({ schemaVersion: 1, minReaderVersion: 2 }), 1, null],
    ['damaged', () => place('[1, 2]'), 1, null],
    ['newer', () => place({ schemaVersion: 2, minReaderVersion: 2 }), 1, null],
    ['older', () => place({ ...envelope }), 2, null],
    ['invalid', () => place({ ...envelope, providers: { codex: { models: { 'gpt-5.5': { hidden: 'yes' } } } } }), 1, 'providers.codex.models.gpt-5.5.hidden'],
    ['invalid', () => place({ ...envelope, providers: { codex: { models: { 'gpt 5': {} } } } }), 1, 'providers.codex.models.gpt 5'],
    ['invalid', () => place({ ...envelope, providers: { codex: { models: { x: { efforts: Array.from({ length: 17 }, (_, index) => `e${index}`) } } } } }), 1, 'providers.codex.models.x.efforts'],
    ['invalid', () => place({ ...envelope, providers: { codex: { models: { x: { speedTiers: [{ id: 'fast mode' }] } } } } }), 1, 'providers.codex.models.x.speedTiers.0.id'],
    ['invalid', () => place({ ...envelope, providers: { codex: { efforts: { xhigh: { caution: 'yes' } } } } }), 1, 'providers.codex.efforts.xhigh.caution'],
    ['invalid', () => place({ ...envelope, providers: { codex: 'all' } }), 1, 'providers.codex'],
    ['invalid', () => place({ ...envelope, providers: [] }), 1, 'providers'],
  ] as const)('is ignored as %s, with the field at fault, and left byte-identical', (cause, write, reader, field) => {
    const bytes = write();
    expect(read(reader)).toMatchObject({ kind: 'ignored', cause, field });
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readdirSync(dir)).toEqual([CATALOG_FILE]);
  });

  it('is ignored as unreadable when the OS will not hand it over, with the error’s code and never its message', () => {
    const io: OverrideIo = {
      size: () => 10,
      readText: () => { throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' }); },
    };
    expect(readOverride(file, KNOWN, io)).toEqual({ kind: 'ignored', cause: 'unreadable', field: null, code: 'EBUSY' });
    const statFails: OverrideIo = { size: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, readText: () => '' };
    expect(readOverride(file, KNOWN, statFails)).toEqual({ kind: 'ignored', cause: 'unreadable', field: null, code: 'EACCES' });
  });

  it('checks the size before reading a byte', () => {
    const readText = vi.fn(() => '{}');
    expect(readOverride(file, KNOWN, { size: () => 256 * 1024 + 1, readText })).toMatchObject({ kind: 'ignored', cause: 'too-large' });
    expect(readText).not.toHaveBeenCalled();
  });

  it('leaves the defaults and the reports in use, offers nothing to start over from, and touches no provider, preference or record', () => {
    const bytes = place('not json at all');
    const store = createAppStateStore();
    const providers = [sampleProvider()];
    store.updateProviders(() => providers);
    const service = createCatalogService({ definitions: builtInProviders('0.0.0'), store, dir, log: { info: vi.fn(), warn: vi.fn() } });
    const catalog = store.getSnapshot().catalog;
    expect(catalog?.override).toEqual({ kind: 'ignored', path: file, cause: 'not-json', field: null });
    expect(catalog?.providers.map((entry) => [entry.id, entry.source.kind, entry.models.length])).toEqual([['claude', 'none', 0], ['codex', 'none', 0]]);
    expect(Object.keys(catalog?.override ?? {})).not.toContain('keptAs');
    expect(store.getSnapshot().providers).toBe(providers);
    expect(store.getSnapshot().records).toBeUndefined();
    service.reload();
    service.stop();
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(readdirSync(dir)).toEqual([CATALOG_FILE]);
  });
});

describe('what the file says (C37, C38)', () => {
  it('reads each model field, and the effort labels by id', () => {
    place({
      ...envelope,
      providers: {
        codex: {
          efforts: { xhigh: { label: 'Very high' }, ultra: { caution: false } },
          models: {
            'gpt-5.5': { hidden: true },
            'gpt-6-astra': { name: '  Astra ', description: null, resolvedId: 'gpt-6-astra-x', efforts: ['low', 'high', 'low'], listedDefaultEffort: 'high', speedTiers: ['priority', { id: 'flex', name: 'Flex', description: '' }, { id: 'priority' }] },
            'my-local-model': { name: 'Local' },
          },
        },
      },
    });
    const reading = applied(read());
    expect([...(reading.providers.get('codex')?.efforts ?? [])]).toEqual([['xhigh', { label: 'Very high' }], ['ultra', { caution: false }]]);
    expect(reading.providers.get('codex')?.models.map(([key]) => key)).toEqual(['gpt-5.5', 'gpt-6-astra', 'my-local-model']);
    expect(codexModels(reading)['gpt-6-astra']).toEqual({
      name: 'Astra', description: null, resolvedId: 'gpt-6-astra-x', efforts: ['low', 'high', 'low'], listedDefaultEffort: 'high',
      // One tier per id; an empty description is none.
      speedTiers: [{ id: 'priority' }, { id: 'flex', name: 'Flex', description: null }],
    });
    expect(codexModels(reading)['gpt-5.5']).toEqual({ hidden: true });
  });

  it('treats an empty name or label as none, so the other layers’ stays', () => {
    place({ ...envelope, providers: { codex: { efforts: { low: { label: ' ' } }, models: { x: { name: '\t' } } } } });
    const reading = applied(read());
    expect(codexModels(reading)['x']).toEqual({});
    expect(reading.providers.get('codex')?.efforts.get('low')).toEqual({});
  });

  it('cleans and clamps names and descriptions (C9)', () => {
    place({ ...envelope, providers: { codex: { models: { x: { name: 'n'.repeat(80), description: 'd'.repeat(300) } } } } });
    expect(codexModels(read())['x']).toEqual({ name: `${'n'.repeat(59)}…`, description: `${'d'.repeat(199)}…` });
  });

  it('refuses more than 200 models for a provider', () => {
    const models = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`m${index}`, {}]));
    place({ ...envelope, providers: { codex: { models } } });
    expect(read()).toMatchObject({ kind: 'ignored', cause: 'invalid', field: 'providers.codex.models' });
  });
});

describe('what the file says that this build does not know (V11; C39, C42)', () => {
  it('skips unknown fields at the top, in a provider, in a model and in an effort, and applies the known ones', () => {
    place({
      ...envelope,
      comment: 'mine',
      providers: { codex: { note: 1, efforts: { xhigh: { label: 'Very high', colour: 'red' } }, models: { x: { name: 'X', avatar: 'cat.png' } } } },
    });
    const reading = applied(read());
    expect(codexModels(reading)['x']).toEqual({ name: 'X' });
    expect(reading.providers.get('codex')?.efforts.get('xhigh')).toEqual({ label: 'Very high' });
  });

  it('skips presentation, so the colour and the mark stay the module’s', () => {
    place({ ...envelope, providers: { claude: { presentation: { barColor: '#000000', icon: { viewBox: '0 0 1 1', path: 'M0 0Z' } } } } });
    const store = createAppStateStore();
    const service = createCatalogService({ definitions: builtInProviders('0.0.0'), store, dir, log: { info: vi.fn(), warn: vi.fn() } });
    expect(store.getSnapshot().catalog?.providers[0]?.presentation.barColor).toBe('#ff9933');
    expect(store.getSnapshot().catalog?.override).toMatchObject({ kind: 'applied', changed: 0, added: 0, hidden: 0 });
    service.stop();
  });

  it('skips a provider this build does not have, and names it', () => {
    place({ ...envelope, providers: { gemini: { models: { 'gemini-9': 'anything' } }, 'not an id': {}, codex: { models: { x: {} } } } });
    expect(read()).toMatchObject({ kind: 'applied', unknownProviders: ['gemini'] });
  });
});
