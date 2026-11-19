// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDiscoveryHistory } from '../storage/provider-discovery-history';

const folders: string[] = [];
function file(): string { const folder = mkdtempSync(path.join(os.tmpdir(), 'fatg-discovery-')); folders.push(folder); return path.join(folder, 'provider-detection.json'); }
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('discovery history', () => {
  it('saves only acknowledged installation booleans and reads them after restart', async () => {
    const target = file();
    const history = createDiscoveryHistory(target);
    expect(history).toMatchObject({ acknowledged: false, providers: {}, unavailable: false });
    expect(await history.save({ third: true, codex: false })).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ schemaVersion: 1, minReaderVersion: 1, acknowledged: true, providers: { third: true, codex: false } });
    expect(createDiscoveryHistory(target)).toMatchObject({ acknowledged: true, providers: { third: true, codex: false } });
  });
  it('preserves unknown fields, providers and compatible future version metadata', async () => {
    const target = file();
    writeFileSync(target, JSON.stringify({ schemaVersion: 2, minReaderVersion: 1, acknowledged: true, providers: { future: true, codex: false }, future: { keep: 1 } }));
    await createDiscoveryHistory(target).save({ codex: true });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ schemaVersion: 2, minReaderVersion: 1, acknowledged: true, providers: { future: true, codex: true }, future: { keep: 1 } });
  });
  it.each(['not-json', '{}', '{"schemaVersion":2,"minReaderVersion":2}', '{"schemaVersion":1,"minReaderVersion":1,"acknowledged":true,"providers":{"codex":"true"}}'])('leaves invalid or incompatible history unchanged', async (text) => {
    const target = file();
    writeFileSync(target, text);
    const history = createDiscoveryHistory(target);
    expect(history.unavailable).toBe(true);
    expect(await history.save({ codex: true })).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(text);
  });
  it('refuses an unreadable target rather than treating it as a fresh installation', async () => {
    const target = file();
    mkdirSync(target);
    const history = createDiscoveryHistory(target);
    expect(history.unavailable).toBe(true);
    expect(await history.save({ codex: true })).toBe(false);
  });
});
