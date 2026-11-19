// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, V21 (docs/planning/_archive/M19b.md; C4, C56; docs/adding-a-tab-kind.md): a kind of tab is a folder of
// its own under the pane's and one line in kinds.ts. The pane, its tab list, its store and the
// opener name no kind, so M20's plans, M20b's asides and M25's media each add a folder and a line
// and change nothing of the pane. And a kind holds no list of the files it shows: main names a
// file's view from the lists in the shared contracts.
//
// M20a (docs/planning/_archive/M20a.md, V13; C47–C50) added a `worker` kind, a worker's items drawn with the
// chat's own list, read by one channel; M106 (docs/planning/_archive/M106.md, V6; C4) retired it, its thread
// unfolding in the Sub-agents tab, whose folder took its hook and its words.
//
// M100 (docs/planning/_archive/M100.md, round 8; C78): the `agents` kind, a session's sub-agents and grants,
// the first whose tab opens by itself — by a watcher the kind gives, which the always-mounted session
// window draws — and since M106 (C2) the first whose tab cannot be closed.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXT_FILE_EXTENSIONS, TEXT_FILE_NAMES } from '@shared/contracts/files';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PANE = 'src/renderer/src/artifacts';
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
/** Comments say what is not done; only code can do it. */
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const isSource = (name: string): boolean => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name);
const entries = readdirSync(path.join(ROOT, PANE), { withFileTypes: true });
/** The pane's own files, and the folders under it: each folder is a kind. */
const own = entries.filter((entry) => entry.isFile() && isSource(entry.name)).map((entry) => entry.name).sort();
const kinds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const specifiers = (file: string): string[] => [...code(file).matchAll(/(?:from|import)\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1] ?? match[2] ?? '');
function sources(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return isSource(entry.name) ? [relative] : [];
  });
}

/** The page's own files: what its tests stand on (`test/`) is no part of what ships. */
const pageSources = (): string[] => sources('src/renderer/src').filter((file) => !file.startsWith('src/renderer/src/test/'));

describe('the pane’s folder (V8; C4)', () => {
  it('holds the pane’s own files, and one folder a kind', () => {
    // M100 (C59): the pane's housekeeping, which the always-mounted session window does, is its own file.
    expect(own).toEqual(['ArtifactBar.tsx', 'ArtifactPane.tsx', 'FileRefreshStatus.tsx', 'TabList.tsx', 'kinds.ts', 'opener.ts', 'tab-kind.ts', 'tabs-store.ts', 'useArtifactKinds.ts']);
    // M20b (C36): an aside's is the third. M100 (round 8; C78): the session's sub-agents the fourth. M22b (C25): a plan's the fifth.
    // M23 (C27): an image of the chat the sixth. M106 (C4): a worker's retired.
    expect(kinds).toEqual(['agents', 'aside', 'file', 'image', 'plan']);
  });

  it('names a kind in one file: kinds.ts, a line a kind', () => {
    const importing = own.filter((name) => specifiers(`${PANE}/${name}`).some((specifier) => kinds.some((kind) => specifier === `./${kind}` || specifier.startsWith(`./${kind}/`))));
    expect(importing).toEqual(['kinds.ts']);
    const list = code(`${PANE}/kinds.ts`);
    // One import for each kind's folder, and the list of them.
    expect([...list.matchAll(/^import\s+\{[^}]*\}\s+from\s+'\.\/([\w-]+)';$/gm)].map((match) => match[1])).toEqual(kinds);
    expect(list).toMatch(/export const BUILT_IN_KINDS: readonly TabKind\[\] = \[fileKind, asideKind, agentsKind, planKind, imageKind\];/);
  });

  it('draws no kind by name: the pane, its tab list and its store hold no word of a file, a worker, a plan or an aside', () => {
    for (const name of ['ArtifactPane.tsx', 'TabList.tsx', 'tabs-store.ts', 'tab-kind.ts', 'useArtifactKinds.ts']) {
      const source = code(`${PANE}/${name}`);
      expect(source, name).not.toMatch(/['"`]file['"`]|FILE_KIND|fileKind|FileBody|files:read|files:showInFolder|\bplan\b|\baside\b/i);
      expect(source, name).not.toMatch(/['"`]worker['"`]|WORKER_KIND|workerKind|WorkerBody|chat:readWorker|\bworker\b|\bactivit/i);
      // Nor of an aside (M20b, C36): no kind's id, no channel of its own, no word of a question or a passage.
      expect(source, name).not.toMatch(/ASIDE_KIND|asideKind|AsideBody|chat:(ask|readAside|stopAside|removeAside)|\bexcerpt\b|\bquestion/i);
      // And nothing of a path, a line or a view: a reference is a value its kind alone reads.
      expect(source, name).not.toMatch(/\bpath\b|\.line\b|markdown|plain/);
    }
  });

  it('opens a tab from the opener by a kind’s id alone: the opener imports no kind’s module', () => {
    expect(specifiers(`${PANE}/opener.ts`).filter((specifier) => specifier.startsWith('./')).sort()).toEqual(['./tabs-store']);
    expect(code(`${PANE}/opener.ts`)).toMatch(/export const FILE_KIND = 'file';/);
    expect(code(`${PANE}/opener.ts`)).toMatch(/openTab\(sessionId, FILE_KIND, answer\.path,/);
    // A sub-agent's thread the same way (M106, C4): the Sub-agents tab by its kind's id, the sub-agent chosen in its view state, nothing read for it.
    expect(code(`${PANE}/opener.ts`)).toMatch(/export const AGENTS_KIND = 'agents';/);
    expect(code(`${PANE}/opener.ts`)).toMatch(/openTab\(sessionId, AGENTS_KIND, null, \{ first: true, viewState: \{ chosen: \{ id: workerId, label: /);
    expect(code(`${PANE}/opener.ts`)).not.toMatch(/WORKER_KIND|openWorker/);
    // And an aside's (M20b, C36, C41): by its kind's id and the aside's, its title handed, its field focused where asked.
    expect(code(`${PANE}/opener.ts`)).toMatch(/export const ASIDE_KIND = 'aside';/);
    expect(code(`${PANE}/opener.ts`)).toMatch(/openTab\(sessionId, ASIDE_KIND, asideId, \{ handed: title, /);
  });

  it('chooses a sub-agent from the chat’s row, an aside’s source and a thread’s own row through the opener alone: none imports the kind (M106, C4)', () => {
    const openers = sources('src/renderer/src').filter((file) => /\bopenAgent\(/.test(code(file)) && !file.startsWith(`${PANE}/opener`)).sort();
    expect(openers).toEqual([`${PANE}/agents/AgentThread.tsx`, `${PANE}/aside/AsideBody.tsx`, 'src/renderer/src/chat/ChatArea.tsx']);
    for (const file of sources('src/renderer/src').filter((name) => !name.startsWith(`${PANE}/`))) {
      expect(specifiers(file).filter((specifier) => /artifacts\/(file|aside|agents)(\/|$)/.test(specifier)), file).toEqual([]);
    }
  });

  it('opens an aside’s tab through the opener alone, from the chat’s controls, its menu, its toolbar and a finding’s Explain: none imports the kind (M20b, C36, C41, C53; M22e, C34)', () => {
    const openers = sources('src/renderer/src').filter((file) => /\bopenAside\(/.test(code(file)) && !file.startsWith(`${PANE}/opener`)).sort();
    expect(openers).toEqual([`${PANE}/file/FileBody.tsx`, 'src/renderer/src/chat/ExplainControl.tsx', 'src/renderer/src/chat/FindingsList.tsx', 'src/renderer/src/chat/aside-actions.ts']);
    // The channels belong to the chat's actions, its copy helper and the kind's own folder.
    const callers = pageSources().filter((file) => /'chat:(ask|readAside|stopAside|removeAside)'/.test(code(file))).sort();
    expect(callers).toEqual([`${PANE}/aside/AsideBody.tsx`, `${PANE}/aside/ask.ts`, `${PANE}/aside/index.ts`, `${PANE}/aside/useAsideChat.ts`, 'src/renderer/src/chat/aside-actions.ts', 'src/renderer/src/chat/copy-conversation.ts']);
  });

  it('is rendered by the artifact region with the built-in kinds, in one line, which the session window registers whatever the pane shows (M100, C59)', () => {
    expect(code('src/renderer/src/shell/ArtifactRegion.tsx')).toMatch(/<ArtifactPane kinds=\{BUILT_IN_KINDS\} \/>/);
    expect(code('src/renderer/src/shell/ArtifactRegion.tsx')).toMatch(/useArtifactKinds\(BUILT_IN_KINDS\);/);
    expect(code('src/renderer/src/shell/SessionWindow.tsx')).toMatch(/useArtifactRegion\(\)/);
    // And the watchers of the kinds whose tabs open by themselves, drawn by the always-mounted window (M100, round 8; C78).
    expect(code('src/renderer/src/shell/ArtifactRegion.tsx')).toMatch(/BUILT_IN_KINDS\.flatMap\(\(kind\) => \(kind\.Watcher === undefined/);
    expect(code('src/renderer/src/shell/SessionWindow.tsx')).toMatch(/<ArtifactWatchers \/>/);
    // Registered in a layout effect, before any watcher's passive one can open a tab.
    expect(code(`${PANE}/useArtifactKinds.ts`)).toMatch(/useLayoutEffect\(\(\) => \{ registerKinds\(kinds\); \}, \[kinds\]\);/);
    // Nothing else in the page names the list: a kind reaches the pane through it alone.
    const users = pageSources().filter((file) => /\bBUILT_IN_KINDS\b/.test(code(file))).sort();
    expect(users).toEqual(['src/renderer/src/artifacts/kinds.ts', 'src/renderer/src/shell/ArtifactRegion.tsx']);
  });

  it('lets a kind use the pane’s own: its interface, its store and the opener, and never another kind', () => {
    for (const kind of kinds) {
      for (const file of sources(`${PANE}/${kind}`)) {
        const reached = specifiers(file).filter((specifier) => specifier.startsWith('../') && !specifier.startsWith('../../'));
        expect(reached.every((specifier) => ['../opener', '../tab-kind', '../tabs-store', '../ArtifactBar', '../ArtifactBar.module.css', '../FileRefreshStatus'].includes(specifier)), `${file}: ${reached.join(', ')}`).toBe(true);
      }
    }
  });
});

describe('the `image` kind (M23: V6; C27)', () => {
  const files = sources(`${PANE}/image`);
  const all = files.map((file) => code(file)).join('\n');

  it('is a folder of its definition, its body and its words, its reference the image’s hash or an image file’s real path (decision 0022, item 15)', () => {
    expect(files.sort()).toEqual(['ImageBody.tsx', 'copy-image.ts', 'index.ts', 'useImageRefresh.ts', 'words.ts'].map((name) => `${PANE}/image/${name}`));
    expect(code(`${PANE}/image/index.ts`)).toMatch(/tabKind<ImageReference, ImageViewState>\(\{ id: IMAGE_KIND,/);
    expect(code(`${PANE}/image/ImageBody.tsx`)).toMatch(/export type ImageReference = string \| \{ readonly path: string \};/);
  });

  it('draws by hash or by id through the media route, and asks main for explicit copy and reveal or a checked reread after a failed load', () => {
    expect(all).toMatch(/attachmentAddress\(hash\)/);
    expect(all).toMatch(/imageFileAddress\(file\)/);
    expect(all).toMatch(/<img key=\{failureKey\} src=\{address\}/);
    expect(all).not.toMatch(/\bsubscribe\(/);
    // Paths reach only the checked reader and Show in folder; never the image's address.
    expect([...all.matchAll(/reference\.path\b/g)]).toHaveLength(1);
    expect(all).toMatch(/invoke\('files:showInFolder', \{ sessionId, path \}\)/);
    expect(all).toMatch(/if \(path === null \|\| address === null \|\| failed !== failureKey\) return;/);
    expect(all).toMatch(/invoke\('files:read', \{ sessionId, target: path \}\)/);
    expect([...all.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]).sort()).toEqual(['attachments:readForCopy', 'attachments:showInFolder', 'files:read', 'files:readImageForCopy', 'files:refreshImage', 'files:showInFolder']);
  });

  it('is opened through the opener alone, by the image’s hash, from a user’s message’s images', () => {
    const openers = sources('src/renderer/src').filter((file) => /\bopenImage\(/.test(code(file)) && !file.startsWith(`${PANE}/opener`)).sort();
    expect(openers).toEqual(['src/renderer/src/chat/MessageAttachments.tsx']);
    expect(code(`${PANE}/opener.ts`)).toMatch(/openTab\(sessionId, IMAGE_KIND, hash, \{ viewState: \{ serial: \+\+imageOpenings, display: shown \} \}\)/);
    // An image file (decision 0022, item 15): by its real path, from a thumbnail of one, and from a file's tab that reads as one.
    const fileOpeners = sources('src/renderer/src').filter((file) => /\bopenImageFile\(/.test(code(file)) && !file.startsWith(`${PANE}/opener`)).sort();
    expect(fileOpeners).toEqual([`${PANE}/file/FileBody.tsx`, 'src/renderer/src/chat/ImageFileStrip.tsx']);
    expect(code(`${PANE}/opener.ts`)).toMatch(/openTab\(sessionId, IMAGE_KIND, \{ path: image\.path \},/);
    for (const file of sources('src/renderer/src').filter((name) => !name.startsWith(`${PANE}/`))) {
      expect(specifiers(file).filter((specifier) => /artifacts\/image(\/|$)/.test(specifier)), file).toEqual([]);
    }
  });
});

describe('the `agents` kind (M100, round 8; C78; M106, V6; C2, C4, C22)', () => {
  const files = sources(`${PANE}/agents`);
  const all = files.map((file) => code(file)).join('\n');
  const hook = code(`${PANE}/agents/useWorkerChat.ts`);

  it('is a folder of its definition, its body, its stack, its thread and the thread’s hook, its two lists’ watcher and grants, and its words; a tab that does not close', () => {
    expect(files.sort()).toEqual(['AgentStack.tsx', 'AgentThread.tsx', 'AgentsBody.tsx', 'AgentsWatcher.tsx', 'GrantsList.tsx', 'index.ts', 'useWorkerChat.ts', 'words.ts'].map((name) => `${PANE}/agents/${name}`));
    expect(code(`${PANE}/agents/index.ts`)).toMatch(/tabKind<null, AgentsViewState>\(\{ id: AGENTS_KIND, title: \(\) => AGENTS_WORDS\.title, Body: AgentsBody, Watcher: AgentsWatcher, closable: false \}\)/);
  });

  it('reads the app state and the page’s grants; its thread alone asks main, by one channel and one push, through its hook, and sends nothing (M20a, C49; M106, C22)', () => {
    expect(all).toMatch(/useAppState\(/);
    expect(all).toMatch(/useGrantsStore\(\)/);
    expect([...all.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1])).toEqual(['chat:readWorker', 'chat:readWorker']);
    expect([...all.matchAll(/subscribe\('([^']+)'/g)].map((match) => match[1])).toEqual(['chat:message']);
    for (const file of files.filter((name) => !name.endsWith('/useWorkerChat.ts'))) expect(code(file), file).not.toMatch(/\binvoke\(|\bsubscribe\(/);
    expect(hook).toMatch(/invoke\('chat:readWorker'/);
    expect(all).not.toMatch(/Composer|chat:send|chat:stop|<textarea/);
  });

  it('draws a thread with the chat’s own list and its own group, as tall as it holds, and posts nothing when a question is raised (M20a, C43, C48; M21, C74; M106, C40)', () => {
    expect(specifiers(`${PANE}/agents/AgentThread.tsx`)).toEqual(expect.arrayContaining(['../../chat/MessageList', '../../chat/ActivityGroup']));
    expect(code(`${PANE}/agents/AgentThread.tsx`)).toMatch(/<MessageList view=\{view\}.*turnLines=\{false\} announceQuestions=\{false\} fit=\{!full\} onFull=\{onFull\} \/>/);
  });

  it('opens its one tab a session by its watcher, first in the row and taking the view from no other tab, or by the opener; never closes one', () => {
    const opens = files.filter((file) => /\bopenTab\(/.test(code(file)));
    expect(opens).toEqual([`${PANE}/agents/AgentsWatcher.tsx`]);
    expect(code(`${PANE}/agents/AgentsWatcher.tsx`)).toMatch(/openTab\(sessionId, AGENTS_KIND, null, \{ select: false, first: true \}\)/);
    expect(all).not.toMatch(/\bcloseTab\(/);
  });
});

describe('the lists of files shown as text (V21; C56)', () => {
  it('are in the shared contracts, and nowhere in the `file` kind’s folder', () => {
    const files = sources(`${PANE}/file`);
    expect(files.sort()).toEqual(['FileBody.tsx', 'PlainTextView.tsx', 'index.ts', 'useFileRefresh.ts', 'words.ts'].map((name) => `${PANE}/file/${name}`));
    for (const file of files) {
      const source = code(file);
      // No list of its own: neither the constant, nor a run of the endings it holds.
      expect(source, file).not.toMatch(/TEXT_FILE|MARKDOWN_EXTENSIONS|viewOf\(/);
      const named = [...TEXT_FILE_EXTENSIONS, ...TEXT_FILE_NAMES].filter((entry) => new RegExp(`['"\`]${entry.replace('.', '\\.')}['"\`]`).test(source));
      expect(named, file).toEqual([]);
    }
  });

  it('are read by main to name a file’s view, and by no other part of main', () => {
    const readers = sources('src/main').filter((file) => /\bviewOf\(/.test(code(file))).sort();
    expect(readers).toEqual(['src/main/files/reader.ts']);
  });

  it('are drawn from by what main answered: the `file` kind reads the answer’s view', () => {
    expect(code(`${PANE}/file/FileBody.tsx`)).toMatch(/shown\.view === 'markdown'/);
  });
});
