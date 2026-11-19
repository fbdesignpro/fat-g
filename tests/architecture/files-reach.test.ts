// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13, V6 (docs/planning/_archive/M19b.md; C25, C33, C43–C45; decision 0022): where main reaches a project's
// files and the system's own programs, held on the source. The reader's folder asks the file system
// through one file and three questions, and writes nothing; main shows a file in the file manager,
// opens the data folder and hands an address to the browser at one call site each — and opens no
// file with the system's application anywhere.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

function sources(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
/** Comments say what is not done; only code can do it. */
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const imports = (file: string) => [...read(file).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gms)].map((match) => ({ module: match[2] ?? '', typeOnly: match[1] !== undefined }));
const FILE_SYSTEM = /^(?:node:)?fs(?:\/promises)?$/;

describe('the reader’s folder (V4, V6; C25–C35)', () => {
  const files = sources('src/main/files');

  it('holds the modules this checks', () => {
    expect(files.sort()).toEqual(['confine.ts', 'decode.ts', 'fs.ts', 'images.ts', 'limiter.ts', 'reader.ts', 'test-support.ts', 'walk.ts'].map((name) => `src/main/files/${name}`));
  });

  it('reaches the file system in one file, by three questions, and writes nothing', () => {
    const reaching = files.filter((file) => imports(file).some((entry) => !entry.typeOnly && FILE_SYSTEM.test(entry.module)));
    expect(reaching).toEqual(['src/main/files/fs.ts']);
    const named = [...read('src/main/files/fs.ts').matchAll(/^import\s+\{([^}]*)\}\s+from\s+'(?:node:)?fs(?:\/promises)?';/gm)].flatMap((match) => (match[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean));
    expect(named.sort()).toEqual(['open', 'opendir', 'stat']);
    // The one `open` is for reading.
    expect(code('src/main/files/fs.ts').match(/\bopen\([^)]*\)/g)).toEqual(["open(path, 'r')"]);
    for (const file of files) {
      expect(code(file), file).not.toMatch(/\b(?:writeFile|writeFileSync|appendFile|mkdir|mkdirSync|rm|rmSync|rmdir|unlink|rename|copyFile|cp|truncate|chmod|utimes|symlink|link|createWriteStream|watch|watchFile)\(/);
    }
  });

  it('imports no Electron and starts no process: main hands it what it reads through', () => {
    for (const file of files) {
      const reached = imports(file).map((entry) => entry.module).filter((module) => module === 'electron' || /^(?:node:)?child_process$/.test(module) || /^(?:node:)?(?:http|https|net|dns)$/.test(module));
      expect(reached, file).toEqual([]);
    }
  });

  it('keeps nothing between two reads: the reader and its handlers hold no file’s text (C33)', () => {
    for (const file of ['src/main/files/reader.ts', 'src/main/ipc/handlers/files.ts', 'src/main/files/decode.ts', 'src/main/files/walk.ts']) {
      const source = code(file);
      // No variable outside a function that could hold one, and no cache by any name.
      expect(source, file).not.toMatch(/^(?:export\s+)?let\s/m);
      expect(source, file).not.toMatch(/cache|memo|WeakMap|new Map\(/i);
    }
  });

  it('holds an image file’s id, real path, type and size between two reads, and never a byte of it (decision 0022, item 15)', () => {
    const source = code('src/main/files/images.ts');
    expect(source).not.toMatch(/^(?:export\s+)?let\s/m);
    const kept = [...source.matchAll(/held\.set\(([^;]*)\);/g)].map((match) => match[1] ?? '');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/sessionId, key, path: checked\.path, mediaType: checked\.mediaType, width: checked\.width, height: checked\.height/);
    expect(kept[0]).not.toMatch(/bytes/);
  });

  it('is the one place under src/main that reads a project’s files: sessions and records are as they were', () => {
    for (const directory of ['src/main/sessions', 'src/main/records', 'src/main/state', 'src/main/ipc', 'src/main/media']) {
      const reaching = sources(directory).filter((file) => imports(file).some((entry) => !entry.typeOnly && /\/files\/(?:fs|reader|walk|decode|limiter|images)$/.test(entry.module)));
      expect(reaching, directory).toEqual([]);
    }
  });
});

describe('the shared readers (V2; C15, C56)', () => {
  it('import nothing, so one function reads an address in main, the preload and the page', () => {
    const source = read('src/shared/contracts/files.ts');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(code('src/shared/contracts/files.ts')).not.toMatch(/\brequire\(|\bprocess\.|\bwindow\.|\bdocument\./);
  });
});

describe('where main reaches the system’s programs (V13; C43–C45)', () => {
  const main = sources('src/main');
  /** Each call of `shell.<call>` under src/main, with its arguments: one level of brackets inside them. */
  const callSites = (call: string) => main.flatMap((file) => [...code(file).matchAll(new RegExp(`\\bshell\\.${call}\\((?:[^()]|\\([^()]*\\))*\\)`, 'g'))].map((match) => `${file}: ${match[0]}`));

  it('opens a path with the system’s application at two places: fat-g’s own data folder, its plans’ folder or its avatars’ (M13, C71; M22b, C75; M102, C40), and a folder the reader placed (decision 0022)', () => {
    expect(callSites('openPath')).toEqual(['src/main/index.ts: shell.openPath(folder)', "src/main/index.ts: shell.openPath(folder === 'audio' ? await audio.folder() : dataFolder(folder))"]);
    // The four app-owned folders, and no other: named in main, never by the page.
    expect(code('src/main/index.ts')).toContain("const dataFolder = (folder: 'plans' | 'avatars' | 'audio' | null): string => (folder === null ? app.getPath('userData') : path.join(app.getPath('userData'), folder === 'plans' ? PLANS_FOLDER : folder === 'audio' ? AUDIO_FOLDER : AVATARS_FOLDER));");
    // The avatars' is made, empty, before it is opened, and only by the avatars' adapter.
    expect(code('src/main/index.ts')).toContain("createAvatarsFolder: () => nodeAvatarFs.createFolder(dataFolder('avatars')),");
    // A project's folder is opened behind files:openFolder alone, and only what the reader placed as a folder: never a file.
    expect(code('src/main/index.ts')).toContain('openFolder: smoke ? smoke.dialogs.smokeOpenFolder() : (folder) => shell.openPath(folder),');
    const files = code('src/main/ipc/handlers/files.ts');
    expect(files.match(/deps\.openFolder\([^)]*\)/g)).toEqual(['deps.openFolder(placed.path)']);
    expect(files).toContain("if (placed === null || !placed.ok || placed.kind !== 'folder') {");
  });

  it('shows a file in the file manager at one place, behind files:showInFolder and files:openFolder', () => {
    expect(callSites('showItemInFolder')).toEqual(['src/main/index.ts: shell.showItemInFolder(file)']);
    const index = code('src/main/index.ts');
    expect(index).toMatch(/showInFolder: smoke \? smoke\.dialogs\.smokeShowInFolder\(\) : \(file\) => \{ shell\.showItemInFolder\(file\); \}/);
    // And the handlers show only what the reader located or placed.
    expect(code('src/main/ipc/handlers/files.ts').match(/\S*showInFolder\([^)]*\)/g)).toEqual(['deps.showInFolder(located.path)', 'deps.showInFolder(placed.path)']);
  });

  it('hands an address to the browser at one place, behind shell:openLink and shell:openAddress', () => {
    expect(callSites('openExternal')).toEqual(['src/main/index.ts: shell.openExternal(url)']);
    const shell = code('src/main/ipc/handlers/shell.ts');
    // The two callers: a registered provider's guide, and an address the check let through, as parsed.
    expect(shell.match(/deps\.openExternal\([^)]*\)/g)).toEqual(['deps.openExternal(guide)', 'deps.openExternal(checked.href)']);
    const users = main.filter((file) => /\bopenExternal\(/.test(code(file))).sort();
    expect(users).toEqual(['src/main/app/smoke-dialogs.ts', 'src/main/index.ts', 'src/main/ipc/handlers/shell.ts'].filter((file) => users.includes(file)));
  });

  it('names `shell` from Electron in the bootstrap alone, and asks nothing else of it', () => {
    const importing = main.filter((file) => /import\s+\{[^}]*\bshell\b[^}]*\}\s+from\s+'electron'/.test(read(file)));
    expect(importing).toEqual(['src/main/index.ts']);
    const asked = [...code('src/main/index.ts').matchAll(/\bshell\.(\w+)\(/g)].map((match) => match[1]).sort();
    // trashItem: an avatar's replaced image goes to the system's trash, where the user can restore it (decision 0036).
    expect(asked).toEqual(['openExternal', 'openPath', 'openPath', 'showItemInFolder', 'trashItem']);
  });

  it('makes no request of its own for an address: the handler parses it and hands it over (C45)', () => {
    const shell = code('src/main/ipc/handlers/shell.ts');
    expect(shell).not.toMatch(/\bfetch\(|net\.|https?\.(?:get|request)\(|resolve4|lookup\(/);
  });
});
