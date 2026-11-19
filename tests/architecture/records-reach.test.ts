// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V14 (docs/planning/_archive/M12.md; S8, C34; decision 0015): fat-g writes its own files in its own data
// folder, and nothing into a project's folders or the CLIs' own trust stores.
import { lstat, rename } from 'node:fs/promises';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECORDS_FILE } from '../../src/main/records/format';
import { createRecordsStore } from '../../src/main/records/store';
import { type AtomicWriteIo, nodeIo, writeFileAtomic } from '../../src/main/storage/atomic-write';
import type { SetAsideIo } from '../../src/main/storage/set-aside';

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
let projectDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'fatg-reach-data-'));
  projectDir = mkdtempSync(path.join(tmpdir(), 'fatg-reach-project-'));
  writeFileSync(path.join(projectDir, 'AGENTS.md'), 'the user’s own file');
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('what the records store writes (V14)', () => {
  it('is records.json, its temp file and set-aside copies — all in the data folder', async () => {
    const touched: string[] = [];
    const io: AtomicWriteIo = {
      ...nodeIo,
      writeAndSync: (file, data) => { touched.push(file); return nodeIo.writeAndSync(file, data); },
      rename: (from, to) => { touched.push(from, to); return nodeIo.rename(from, to); },
    };
    const setAsideIo: SetAsideIo = { lstat, rename: (from, to) => { touched.push(from, to); return rename(from, to); } };
    const open = () => createRecordsStore({ dir: dataDir, providerIds: ['codex'], log: { info: () => undefined, warn: () => undefined, error: () => undefined }, write: (file, data) => writeFileAtomic(file, data, io), setAsideIo });

    // Every kind of change, with a project whose root is a real folder.
    const store = open();
    const added = await store.add({ name: 'p', color: 'teal', roots: [{ path: projectDir, trust: 'trusted' }], providers: ['codex'] }, () => true);
    if (added.status !== 'saved') throw new Error('not saved');
    await store.update(added.id, { name: 'q', roots: [{ path: projectDir, trust: 'not-trusted' }], providers: ['codex'] }, () => true);
    await store.setHidden(added.id, true);
    await store.move(added.id, false, null);
    await store.remove(added.id);
    // And Start fresh, from a refused file.
    writeFileSync(path.join(dataDir, RECORDS_FILE), '{');
    await open().startFresh();

    expect(touched.length).toBeGreaterThan(0);
    for (const file of touched) {
      expect(path.dirname(file)).toBe(dataDir);
      expect(path.basename(file)).toMatch(/^records(\.json|\.json\.tmp|\.set-aside\.[\dT-]+Z(-\d+)?\.json)$/);
    }
    // The project's folder is exactly as it was.
    expect(readdirSync(projectDir)).toEqual(['AGENTS.md']);
    expect(readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toBe('the user’s own file');
  });
});

describe('the source (V14)', () => {
  it('never names the CLIs’ own trust stores (C34)', () => {
    const naming = sources().filter((file) => /\.claude\.json|config\.toml/.test(read(file)));
    expect(naming).toEqual([]);
  });

  it('writes files only from the stores, their shared storage module and the smoke checks', () => {
    const CALL = String.raw`\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|truncate)\s*\(`;
    const WRITES = new RegExp(CALL, 'g');
    const writers = sources().filter((file) => file.startsWith('src/main/') && new RegExp(CALL).test(read(file)));
    expect(writers.sort()).toEqual([
      // A confirmed reset clears only this app's data folder at the next start (decision 0038).
      'src/main/app/data-reset.ts',
      // Development and smoke builds only (M19, C69): the stream form's own throwaway data folder, made
      // anew at each start. It refuses any other folder, and a release bundle does not hold it.
      'src/main/app/demo-stream-data.ts',
      // Smoke builds only: their notes beside the records in the throwaway data folder (M15: the live launches').
      // Avatar-family smoke can also save explicitly requested visual captures.
      'src/main/app/smoke-avatar-family.ts',
      'src/main/app/smoke-data-reset.ts',
      'src/main/app/smoke-live.ts',
      'src/main/app/smoke-new-chat.ts',
      'src/main/app/smoke.ts',
      // The active images' folder (M23, C6, C85): an image written once under its hash, and unlinked
      // when the store says its last use went. The store itself names images, and writes no file.
      'src/main/attachments/files.ts',
      // The avatars' folder in the data folder (M102, C40): made, empty, where it is missing, when the
      // user presses Show avatars folder; manifests saved, and built-in families copied only into new
      // user folders at Make a copy; a new avatar's folder and its two PNGs, made by the page from an
      // image the user dropped, at Add avatar, and an avatar's image replaced, the old one sent to the
      // system's trash (decision 0036). Installed built-in artwork is never written.
      'src/main/audio/fs.ts',
      'src/main/avatars/fs.ts',
      // The conversation store's folder, and the removal of a store set aside (M18, C41): the one
      // file of the store that touches the file system. The store itself is written through SQLite.
      'src/main/conversations/files.ts',
      // Its tests' own scratch folder, removed after each test: no part of the app.
      'src/main/conversations/test-support.ts',
      // The plan store (M22b, C16, C59, C62): the one writer of `plans/`, in fat-g's data folder.
      'src/main/plans/store.ts',
      'src/main/prefs/store.ts',
      'src/main/process/index.ts',
      'src/main/records/store.ts',
      'src/main/storage/atomic-write.ts',
      // Installation booleans and acknowledgment in the app's data folder (decision 0037).
      'src/main/storage/provider-discovery-history.ts',
      'src/main/storage/set-aside.ts',
    ]);
    // The process layer only makes the empty folder its PATH probe runs in, inside the data folder.
    expect(read('src/main/process/index.ts').match(WRITES)).toEqual(['mkdir(']);
    expect(read('src/main/process/index.ts')).toMatch(/const probeDirectory = path\.join\(userData, 'probe-cwd'\);/);
  });

  // C69, V21: a native drag is the operating system's, and any program may receive what it carries.
  // M23 (C15): the page receives two native drags — files dropped on the chat column, by the hook made
  // for it, and an image dropped in the family editor, on its Add avatar zone or an avatar's own image
  // (decision 0036), by the hook made for those — and starts
  // none: an image it draws is marked undraggable, so none carries an address out.
  it('starts no native drag in the renderer: projects are reordered with pointer events', () => {
    const native = sources('src/renderer').filter((file) => /\bdraggable\b(?!=\{false\})|\bonDragStart\b/.test(read(file)));
    expect(native).toEqual([]);
    const receiving = sources('src/renderer').filter((file) => /\bdataTransfer\b/.test(read(file)));
    expect(receiving).toEqual(['src/renderer/src/chat/composer/useFileDrop.ts', 'src/renderer/src/settings/useImageDrop.ts']);
  });

  // M14 (S9, C77, V21): only sessions fat-g created appear. It never lists the CLIs' own session
  // stores — Claude's transcripts, Codex's `thread/list` — and learns what changed there at resume.
  it('never reads the CLIs’ own session stores', () => {
    const naming = sources().filter((file) => /thread\/list|\.claude[\\/]+projects|\.codex[\\/]+sessions|\.jsonl\b|session\/list|listSessions/.test(read(file)));
    expect(naming).toEqual([]);
  });

  // M14 (C51, V12): the usage panel's clock, one interval per component, stays that panel's alone;
  // every running time of a session comes from the one session clock.
  it('keeps useClock the usage panel’s alone, and one interval for the session clock', () => {
    const renderer = sources('src/renderer');
    expect(renderer.filter((file) => /\buseClock\(/.test(read(file))).sort()).toEqual(['src/renderer/src/control-bar/UsagePanel.tsx', 'src/renderer/src/ui/useClock.ts']);
    const ticking = renderer.filter((file) => /^src\/renderer\/src\/(sessions|session-area|new-session)\//.test(file) && /setInterval\(/.test(read(file)));
    expect(ticking).toEqual(['src/renderer/src/sessions/session-clock.ts']);
  });

  // M14 (S7, V21): the session code starts no process and writes no file of its own. Since M18 it
  // writes a conversation too, through the store it is handed: it never names the driver.
  it('lets the session service, its summaries and its sources write only through the records store and the conversation store', () => {
    for (const file of sources('src/main/sessions')) {
      if (file.endsWith('test-support.ts')) continue;
      expect(read(file), file).not.toMatch(/node:fs|node:sqlite|node:child_process|\bspawn\(|writeFile|electron/);
    }
  });

  // M18 (C7, Design "Boundaries"): one module opens the database, and one touches the file system.
  it('names the SQLite driver in the conversation store alone, and opens a database in one module', () => {
    const naming = sources().filter((file) => /from 'node:sqlite'/.test(read(file)));
    expect(naming.sort()).toEqual(['src/main/conversations/composer-rows.ts', 'src/main/conversations/open.ts', 'src/main/conversations/store.ts', 'src/main/conversations/test-support.ts']);
    // The store and its composer rows take the driver's types alone; open.ts is the one that makes a connection.
    expect(read('src/main/conversations/store.ts')).toMatch(/^import type \{[^}]*\} from 'node:sqlite';$/m);
    expect(read('src/main/conversations/composer-rows.ts')).toMatch(/^import type \{[^}]*\} from 'node:sqlite';$/m);
    expect(sources().filter((file) => !file.endsWith('test-support.ts') && /new DatabaseSync\(/.test(read(file)))).toEqual(['src/main/conversations/open.ts']);
  });

  it('keeps the conversation store free of Electron, of any provider’s name and of the session code', () => {
    for (const file of sources('src/main/conversations')) {
      const source = read(file);
      expect(source, file).not.toMatch(/from 'electron'|\.\.\/sessions\/|\.\.\/providers\//);
      expect(source, file).not.toMatch(/\b(codex|claude|thread\/|app-server)\b/i);
    }
  });

  it('looks at a root only to read: real paths and a stat, through the limiter', () => {
    const lookup = read('src/main/records/lookup.ts');
    expect(lookup).toMatch(/realpath/);
    expect(lookup).not.toMatch(/\b(writeFile|open|mkdir|rename|rm|unlink)\s*\(/);
  });
});
