// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6 (docs/planning/_archive/M14b.md; S6, C48): an account's folder is the CLI's. fat-g asks whether it is
// there and what its real path is, through the lookups' limiter, and nothing else: it never opens,
// lists or writes anything in it. Checked three ways: what `src/main/instances/` imports, which
// files of `src/main/` reach the file system at all, and a run of the production adapters and the
// real process layer against the fakes, with an account's folder that holds files of its own.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider, ProviderDefinition } from '@shared/provider-kit/provider';
import { createProcessServices } from '../../src/main/process';
import { createClaudeDefinition } from '../../src/main/providers/claude';
import { createCodexDefinition } from '../../src/main/providers/codex';
import { removeFolder } from '../process/remove-folder';

const ROOT = path.resolve(import.meta.dirname, '../..');

function sources(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
/** Every module a file imports, with whether the import is erased at build time. */
const imports = (file: string) => [...read(file).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)].map((match) => ({ module: match[2] ?? '', typeOnly: match[1] !== undefined }));
const FILE_SYSTEM = /^(?:node:)?fs(?:\/promises)?$/;

describe('what src/main/instances reaches (V6)', () => {
  const files = sources('src/main/instances');

  it('holds the modules this checks', () => {
    expect(files.sort()).toEqual(['admission.ts', 'binding.ts', 'folders.ts', 'variables.ts'].map((name) => `src/main/instances/${name}`));
  });

  it('imports no file-system module, no process module and no Electron', () => {
    for (const file of files) {
      const reached = imports(file).map((entry) => entry.module).filter((module) => FILE_SYSTEM.test(module) || /^(?:node:)?child_process$/.test(module) || module === 'electron');
      expect(reached, file).toEqual([]);
    }
  });

  it('reaches a folder only through the lookups: their type alone is imported, and only their two questions are asked', () => {
    for (const file of files) {
      const lookup = imports(file).filter((entry) => entry.module.endsWith('/records/lookup'));
      // The limiter is made once, in main; here it is a parameter.
      expect(lookup.every((entry) => entry.typeOnly), file).toBe(true);
      const source = read(file);
      expect(source, file).not.toMatch(/createLookups|nodeLookupFs/);
      // Every call on a lookups value is one of its two questions: the real path, and whether it is there.
      const asked = [...source.matchAll(/\blookups\.(\w+)\(/g)].map((match) => match[1]);
      expect(asked.every((name) => name === 'realpath' || name === 'folder'), file).toBe(true);
      // And no reading or writing function is named at all.
      expect(source, file).not.toMatch(/\b(?:readFile|readFileSync|readdir|readdirSync|opendir|writeFile|writeFileSync|appendFile|mkdir|mkdirSync|rm|rmSync|unlink|rename|copyFile|createReadStream|createWriteStream|open|openSync|watch)\(/);
    }
  });

  it('asks for a real path or a folder’s presence somewhere, so the checks above are of something', () => {
    const asked = files.flatMap((file) => [...read(file).matchAll(/\blookups\.(\w+)\(/g)].map((match) => match[1]));
    expect(new Set(asked)).toEqual(new Set(['realpath', 'folder']));
  });
});

describe('which files of src/main reach the file system (V6)', () => {
  it('are a pinned list: a new one is a decision, made here', () => {
    const reaching = sources('src/main').filter((file) => imports(file).some((entry) => !entry.typeOnly && FILE_SYSTEM.test(entry.module)));
    expect(reaching.sort()).toEqual([
      // Explicit, twice-confirmed reset of this app's own data before stores open (decision 0038).
      'src/main/app/data-reset.ts',
      // Development and smoke builds only (M19, C69): the stream form's own throwaway data folder under
      // the temporary folder, made anew at each start; it refuses any other folder.
      'src/main/app/demo-stream-data.ts',
      // The app:// protocol serves the renderer's own files.
      'src/main/app/protocol.ts',
      // Smoke builds only (decision 0007): the checks read fat-g's own files and the fixtures' ledgers.
      // Avatar-family smoke can also save explicitly requested visual captures.
      'src/main/app/smoke-avatar-family.ts',
      'src/main/app/smoke-data-reset.ts',
      'src/main/app/smoke-live.ts',
      'src/main/app/smoke-new-chat.ts',
      'src/main/app/smoke.ts',
      // The active images' folder (M23, C6, C85): images written under their hash, read for the media
      // route, unlinked with their last use. Never a path a page or a provider gave.
      'src/main/attachments/files.ts',
      // The avatars' two roots (M102, C21, C40, C58): names, stats and image headers read at a scan, a
      // file read whole when it is drawn, manifests saved, new user families at Make a copy, a new
      // avatar's folder and its two PNGs at Add avatar, an avatar's image replaced, and an image the
      // user chose at Browse read whole (decision 0036).
      'src/main/audio/fs.ts',
      'src/main/avatars/fs.ts',
      // fat-g's own files, in its data folder.
      'src/main/catalog/override.ts',
      // The conversation store's folder, sizes and set-aside copies (M18): the store's one such file.
      'src/main/conversations/files.ts',
      // Its tests' own scratch folder: no part of the app.
      'src/main/conversations/test-support.ts',
      // A project's file, read to show it when the user opens it from the chat (M19b; decision 0022):
      // the reader's three questions, and nothing written.
      'src/main/files/fs.ts',
      // The plan store (M22b, C16, C62): a plan's folder in fat-g's data folder, its record and its versions' text.
      'src/main/plans/store.ts',
      'src/main/prefs/store.ts',
      // The process layer's own ledger of what it started, in the data folder.
      'src/main/process/index.ts',
      // Bounded metadata-only enumeration of declared CLI runtime folders, never account files (decision 0003).
      'src/main/process/install-children.ts',
      // The one place a folder is asked about: its real path, and whether it is there.
      'src/main/records/lookup.ts',
      'src/main/records/store.ts',
      'src/main/storage/atomic-write.ts',
      'src/main/storage/json-file.ts',
      'src/main/storage/owned-file.ts',
      // Versioned installation booleans in fat-g's data folder, never account files (decision 0037).
      'src/main/storage/provider-discovery-history.ts',
      'src/main/storage/set-aside.ts',
    ]);
  });

  it('asks a folder two things only, in the lookups: its real path and its stat', () => {
    const source = read('src/main/records/lookup.ts');
    const fromFs = [...source.matchAll(/^import\s+\{([^}]*)\}\s+from\s+'(?:node:)?fs(?:\/promises)?';/gm)].flatMap((match) => (match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean));
    expect(fromFs.sort()).toEqual(['realpath', 'stat']);
  });

  it('keeps the provider modules, the services and the session code off the file system', () => {
    for (const directory of ['src/main/providers', 'src/main/services', 'src/main/sessions', 'src/main/ipc', 'src/main/state']) {
      const reaching = sources(directory).filter((file) => imports(file).some((entry) => !entry.typeOnly && FILE_SYSTEM.test(entry.module)));
      expect(reaching, directory).toEqual([]);
    }
  });
});

// ── A run against the fakes ───────────────────────────────────────────────────────────────────

/** A folder as it is: every file under it, with its bytes and its times. */
function snapshot(root: string): [name: string, bytes: string, mtimeMs: number][] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry): [string, string, number] => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), readFileSync(file).toString('base64'), statSync(file).mtimeMs];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}
/** Every folder under it, the empty ones too: a CLI's home has some. */
const folders = (root: string): string[] => readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const signal = () => new AbortController().signal;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * A scratch account folder holding what a CLI's home might, and the services that run against it.
 * `inherited` is set in this process's environment first: the services take theirs when they are made.
 */
function scratch(inherited: (dir: string, account: string) => Record<string, string> = () => ({})) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fatg-instance-reach-'));
  const account = path.join(dir, 'an account');
  mkdirSync(path.join(account, 'sessions', 'empty'), { recursive: true });
  writeFileSync(path.join(account, 'auth.json'), '{"token":"the account’s own, which fat-g must never open"}\n');
  writeFileSync(path.join(account, 'config.toml'), 'model = "kept"\n');
  writeFileSync(path.join(account, 'sessions', 'one.jsonl'), Buffer.from([0, 1, 2, 255, 10]));
  const extra = inherited(dir, account);
  const saved = Object.fromEntries(Object.keys(extra).map((name) => [name, process.env[name]]));
  Object.assign(process.env, extra);
  // Every process the layer starts, by its own trace: what the cleanup below may have to end.
  const started: number[] = [];
  const services = createProcessServices(path.join(dir, 'user-data'), { trace: (event) => { if (event.phase === 'spawn' && event.pid !== undefined) started.push(event.pid); } });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  cleanups.push(async () => {
    // On a loaded machine the layer's end of a tree can pass its own deadline and come back
    // unconfirmed, with the fake still running: its working folder is under `dir`, and Windows
    // refuses to remove a folder a process runs in. What is left is ended here, and the folder is
    // removed once it lets go.
    if (!(await services.killAll()).ok) {
      for (const pid of started) { if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } }
    }
    await removeFolder(dir);
  });
  return { dir, account, services };
}

/** An added account's provider: the production adapter, in a scope of its own (C7, C8). */
function added(definition: ProviderDefinition, services: ReturnType<typeof createProcessServices>, folder: string): AgentProvider {
  const support = definition.instances;
  if (support === undefined) throw new Error('no declaration');
  const provider = definition.factory(services.createContext(definition.environment, { variable: support.variable, folder, withhold: support.withhold }));
  cleanups.unshift(() => provider.dispose().catch(() => undefined));
  return provider;
}

describe('a run of the real process layer against the fakes (V6)', () => {
  const node = { override: process.execPath, knownDirs: [] };

  it('leaves a Codex account’s folder byte for byte as it was', async () => {
    // The fake's accounts file is named in the environment the children inherit.
    const { account, services } = scratch((dir, folder) => {
      const accounts = path.join(dir, 'codex-accounts.json');
      writeFileSync(accounts, JSON.stringify({ [folder]: { email: 'reach@example.test', plan: 'pro', usage: { primary: 12, secondary: 3 } } }));
      return { FATG_SMOKE_CODEX_ACCOUNTS: accounts };
    });
    const before = { files: snapshot(account), folders: folders(account) };
    const definition = createCodexDefinition({ applicationVersion: '0.0.0', argsPrefix: [path.resolve('tests/fixtures/fake-codex-cli.mjs')], executableNames: [path.basename(process.execPath)] });
    const provider = added(definition, services, account);

    expect((await provider.detect(node, signal())).kind).toBe('found');
    // The account is this folder's own: the fake chose it by the variable the scope set.
    expect(await provider.getAccount(signal())).toMatchObject({ kind: 'account', account: { email: 'reach@example.test' } });
    expect(await provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
    await provider.dispose();
    await services.killAll();

    expect({ files: snapshot(account), folders: folders(account) }).toEqual(before);
  }, 30_000);

  it('leaves a Claude account’s folder byte for byte as it was', async () => {
    const { dir, account, services } = scratch();
    const fixtureDir = path.join(dir, 'fixture');
    mkdirSync(fixtureDir);
    writeFileSync(path.join(fixtureDir, 'accounts.json'), JSON.stringify({ [account]: { email: 'reach@example.test', plan: 'pro', usage: { session: 9 } } }));
    const before = { files: snapshot(account), folders: folders(account) };
    const definition = createClaudeDefinition({
      argsPrefix: [path.resolve('tests/fixtures/fake-claude-cli.mjs'), '--fixture-dir', fixtureDir], executableNames: [path.basename(process.execPath)], startupTimeoutMs: 3000, usageTimeoutMs: 3000,
    });
    const provider = added(definition, services, account);

    expect((await provider.detect(node, signal())).kind).toBe('found');
    expect(await provider.getAccount(signal())).toMatchObject({ kind: 'account', account: { email: 'reach@example.test' } });
    expect(await provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
    await provider.dispose();
    await services.killAll();

    expect({ files: snapshot(account), folders: folders(account) }).toEqual(before);
  }, 30_000);
});
