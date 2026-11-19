// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Release packages contain no smoke code (decision 0007). That holds only while every path to the
// smoke modules goes through the `__FATG_SMOKE_HOOKS__` guard: one static import anywhere would pull
// them back into the release bundle. The package audit then checks the built result.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
// smoke-dialogs (M12) holds the native dialogs' stand-ins: a smoke run never opens a real one (C55).
// smoke-live (M15) holds the live launches: a Codex session on the replay fake.
const SMOKE_MODULES = ['src/main/app/smoke.ts', 'src/main/app/smoke-audio.ts', 'src/main/app/smoke-providers.ts', 'src/main/app/smoke-dialogs.ts', 'src/main/app/process-smoke.ts', 'src/main/app/smoke-live.ts', 'src/main/app/smoke-new-chat.ts', 'src/main/app/smoke-avatar-family.ts', 'src/main/app/smoke-data-reset.ts', 'src/main/app/smoke-provider-discovery.ts'];
// The demo source (M14, C27): a summary source for development and smoke runs, behind the same flag.
const DEMO_MODULE = 'src/main/sessions/demo-source.ts';
// Its stream form (M19, C63, C69): the recorded performance runs' harness, behind the same flag. Its
// session side, and the module the bootstrap loads, which makes its data folder ready and is the one
// place that imports the session side.
const STREAM_MODULE = 'src/main/sessions/demo-stream.ts';
const STREAM_ENTRY = 'src/main/app/demo-stream-data.ts';

function sources(directory = 'src'): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('smoke code is gated out of release builds', () => {
  it('is imported by value only among the smoke modules themselves', () => {
    const offenders = sources().filter((file) => !SMOKE_MODULES.includes(file)).filter((file) =>
      /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+['"][./]*(?:app\/)?(?:smoke|smoke-audio|smoke-providers|smoke-dialogs|process-smoke|smoke-live|smoke-new-chat|smoke-avatar-family|smoke-data-reset|smoke-provider-discovery)['"]/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('loads only dynamically from the bootstrap, behind the build flag', () => {
    const index = read('src/main/index.ts');
    expect(index).toMatch(/if \(__FATG_SMOKE_HOOKS__ && isSmokeRun\) \{[^}]*Promise\.all\(\[import\('\.\/app\/smoke'\), import\('\.\/app\/smoke-providers'\), import\('\.\/app\/smoke-dialogs'\), import\('\.\/app\/smoke-live'\)\]\)/);
    expect(index.match(/import\('\.\/app\/smoke(?:-providers|-dialogs|-live)?'\)/g)).toHaveLength(4);
  });

  // M14 (V5; C27): one static import of the demo source anywhere would pull it into the release bundle.
  it('imports the demo source by value nowhere', () => {
    const offenders = sources().filter((file) => file !== DEMO_MODULE).filter((file) =>
      /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+['"][./]*(?:sessions\/)?demo-source['"]/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('loads the demo source only dynamically from the bootstrap, behind the build flag and its own switch', () => {
    const index = read('src/main/index.ts');
    expect(index).toMatch(/if \(__FATG_SMOKE_HOOKS__ && demoSessions !== 'off'\) \{\s*import\('\.\/sessions\/demo-source'\)/);
    const dynamic = sources().flatMap((file) => read(file).match(/import\(['"][./]*(?:sessions\/)?demo-source['"]\)/g) ?? []);
    expect(dynamic).toHaveLength(1);
  });

  // M19 (V29; C63, C69): the stream form is the demo switch's third value, and as gated as the demo source.
  it('imports the stream form by value nowhere, and loads it only dynamically from the bootstrap, behind the build flag and its own switch', () => {
    const VALUE_IMPORT = /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+['"][./]*(?:sessions\/|app\/)?demo-stream(?:-data)?['"]/;
    const importers = sources().filter((file) => file !== STREAM_MODULE && file !== STREAM_ENTRY).filter((file) => VALUE_IMPORT.test(read(file)));
    expect(importers).toEqual([]);
    // The session side is imported by the entry alone, and the entry by no one: it is loaded.
    expect(read(STREAM_ENTRY)).toMatch(/from '\.\.\/sessions\/demo-stream';/);
    expect(VALUE_IMPORT.test(read(STREAM_MODULE))).toBe(false);
    const index = read('src/main/index.ts');
    expect(index).toMatch(/else if \(__FATG_SMOKE_HOOKS__ && isStreamForm\) \{[^}]*import\('\.\/app\/demo-stream-data'\)/);
    const dynamic = sources().flatMap((file) => read(file).match(/import\(['"][./]*(?:sessions\/|app\/)?demo-stream(?:-data)?['"]\)/g) ?? []);
    expect(dynamic).toHaveLength(1);
    // Its chunk is named as the demo source's is, so the package audit's one rule refuses both in a release.
    expect(STREAM_ENTRY.split('/').at(-1)?.startsWith('demo')).toBe(true);
  });

  it('reads the stream form’s switch and its fixture’s path only in the flavor switch, behind the build flag, and never in a smoke run', () => {
    const flavor = read('src/main/app/flavor.ts');
    expect(flavor).toMatch(/export const isStreamForm: boolean = !isSmokeRun && demoValue === 'stream';/);
    expect(flavor).toMatch(/export const demoFixture: string \| undefined = __FATG_SMOKE_HOOKS__ \? process\.env\['FATG_DEMO_FIXTURE'\] : undefined;/);
    // The script of the demo source stays off in it: `stream` is none of its two values.
    expect(flavor).toMatch(/demoSessions: 'off' \| 'on' \| 'seed' = demoValue === 'seed' \? 'seed' : demoValue === '1' \? 'on' : 'off';/);
    // The form reads no variable itself: its folder and its fixture are handed in.
    for (const file of [STREAM_MODULE, STREAM_ENTRY]) expect(read(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''), file).not.toMatch(/process\.env/);
    // And the built-in providers are not defined in it: it starts no CLI.
    expect(read('src/main/index.ts')).toMatch(/const definitions = stream \? \[stream\.definition\] : builtInProviders\(/);
  });

  it('reads FATG_DEMO_SESSIONS only in the flavor switch, behind the build flag', () => {
    const readers = sources().filter((file) => /FATG_DEMO/.test(read(file).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')));
    expect(readers).toEqual(['src/main/app/flavor.ts']);
    expect(read('src/main/app/flavor.ts')).toMatch(/const demoValue: string \| undefined = __FATG_SMOKE_HOOKS__ \? process\.env\['FATG_DEMO_SESSIONS'\] : undefined;/);
    // The smoke check holds the script still through the object it is handed, never the variable.
    expect(read('src/main/app/smoke.ts')).not.toMatch(/process\.env\[['"]FATG_DEMO/);
  });

  it('reads FATG_SMOKE variables only in smoke code and the flavor switch', () => {
    // `env[…]` too: smoke-dialogs reads the environment it is handed.
    const readers = sources().filter((file) => /(?:process\.)?env\[['"]FATG_SMOKE/.test(read(file)));
    expect(readers.sort()).toEqual(['src/main/app/flavor.ts', ...SMOKE_MODULES].filter((file) => readers.includes(file)).sort());
    expect(read('src/main/app/flavor.ts')).toMatch(/isSmokeRun: boolean = __FATG_SMOKE_HOOKS__ && process\.env\['FATG_SMOKE'\] === '1'/);
    // M15: the live launches' switch is behind the flag too, so a release build folds it away.
    expect(read('src/main/app/flavor.ts')).toMatch(/isLiveSmokeRun: boolean = __FATG_SMOKE_HOOKS__ && isSmokeRun && process\.env\['FATG_SMOKE_LIVE'\] === '1'/);
  });
});
