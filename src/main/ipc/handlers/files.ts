// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The file channels (docs/planning/_archive/M19b.md, Design 7, 9; C25, C35, C43; decision 0022). The
// reader decides everything (src/main/files/reader.ts); here its answer is counted by kind and
// passed on, a file the checks let through is shown in the system's file manager, and a folder they
// let through is opened in it. An image file's bytes are read again for Copy by the id its read gave it
// (decision 0022, item 15), never by a path from the page.
//
// What main says of a read is its outcome's kind (C35): one log line for a refused read, with the
// kind alone — never a path, a target or a text. The dispatcher's own logs hold the channel and an
// error's kind, as before (M12, C54, C77).
import { lastPart } from '@shared/contracts/files';
import type { ImageFiles } from '../../files/images';
import type { FileReader } from '../../files/reader';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';
import type { KindCounts } from './counts';

export interface FileHandlerDeps {
  readonly reader: FileReader;
  /** An image file's bytes by its id, checked again (decision 0022, item 15). */
  readonly images: Pick<ImageFiles, 'serve' | 'refresh'>;
  /**
   * `shell.showItemInFolder`: the system's file manager shows the file selected. The one fallback
   * (C43): fat-g never opens a file with the system's application, which would run whatever a
   * model's text names at a click.
   */
  readonly showInFolder: (path: string) => void;
  /**
   * `shell.openPath` for a folder the reader placed: the file manager opens it. Resolves with its
   * answer: empty on success, else a message — which may hold the path, so it goes no further.
   */
  readonly openFolder: (path: string) => Promise<string>;
  readonly counts: KindCounts;
  readonly log: Pick<Console, 'warn'>;
  readonly platform?: string;
}

/**
 * Whether a folder is opened by being shown in its own folder instead: on macOS, one whose name has
 * an extension. An application, an installer or a workflow there is a folder, a bundle, which the
 * system would run rather than open; a plain folder seldom has a dot in its name.
 */
export function shownNotOpened(path: string, platform: string): boolean {
  return platform === 'darwin' && /.\.[^.]+$/.test(lastPart(path));
}

export function fileHandlers(deps: FileHandlerDeps): Pick<InvokeHandlers, 'files:read' | 'files:refresh' | 'files:refreshImage' | 'files:showInFolder' | 'files:locate' | 'files:openFolder' | 'files:readImageForCopy'> {
  const platform = deps.platform ?? process.platform;
  return {
    async 'files:refreshImage'(request) {
      const answer = await deps.images.refresh(request);
      if (answer === null) throw new InvalidIpcRequest();
      deps.counts.add(answer.outcome === 'refused' ? `refresh-image:refused:${answer.why}` : `refresh-image:${answer.outcome}`);
      return answer;
    },
    async 'files:refresh'(request) {
      const answer = await deps.reader.refresh(request);
      if (answer === null) throw new InvalidIpcRequest();
      // Best-effort polling is quiet, including repeated failures. Only fixed kinds are counted.
      deps.counts.add(answer.outcome === 'refused' || answer.outcome === 'unshown' ? `refresh:${answer.outcome}:${answer.why}` : `refresh:${answer.outcome}`);
      return answer;
    },
    async 'files:read'(request) {
      const answer = await deps.reader.read(request);
      // A session that is not listed is a bad request, as in sessions.ts.
      if (answer === null) {
        deps.counts.add('read:bad-request');
        throw new InvalidIpcRequest();
      }
      deps.counts.add(answer.outcome === 'text' || answer.outcome === 'image' ? `read:${answer.outcome}` : `read:${answer.outcome}:${answer.why}`);
      if (answer.outcome === 'refused') deps.log.warn(`[files] read refused (${answer.why})`);
      return answer;
    },
    async 'files:showInFolder'(request) {
      const located = await deps.reader.locate(request);
      if (located === null || !located.ok) {
        const why = located === null ? 'bad-request' : located.why;
        deps.counts.add(`show:refused:${why}`);
        deps.log.warn(`[files] show in folder refused (${why})`);
        throw new InvalidIpcRequest();
      }
      deps.counts.add('show:shown');
      deps.showInFolder(located.path);
      return null;
    },
    async 'files:locate'(request) {
      const placed = await deps.reader.place(request);
      if (placed === null) {
        deps.counts.add('locate:bad-request');
        throw new InvalidIpcRequest();
      }
      deps.counts.add(placed.ok ? `locate:${placed.kind}` : `locate:refused:${placed.why}`);
      return placed.ok ? { outcome: placed.kind, path: placed.path } : { outcome: 'refused', why: placed.why };
    },
    // A folder a reference names, as a press on it opens it (decision 0022): only what the reader
    // placed as a folder, never a file.
    async 'files:openFolder'(request) {
      const placed = await deps.reader.place(request);
      if (placed === null || !placed.ok || placed.kind !== 'folder') {
        const why = placed === null ? 'bad-request' : placed.ok ? 'not-folder' : placed.why;
        deps.counts.add(`open:refused:${why}`);
        deps.log.warn(`[files] open folder refused (${why})`);
        throw new InvalidIpcRequest();
      }
      if (shownNotOpened(placed.path, platform)) {
        deps.counts.add('open:shown');
        deps.showInFolder(placed.path);
        return null;
      }
      deps.counts.add('open:opened');
      // The page gets `internal` and its fixed sentence; the dispatcher logs this error's kind.
      if ((await deps.openFolder(placed.path)) !== '') throw new Error('the folder could not be opened');
      return null;
    },
    // Copy, at the user's press: the bytes cross once, for the clipboard alone, and are kept nowhere.
    async 'files:readImageForCopy'({ sessionId, id }) {
      const answer = await deps.images.serve(id, sessionId);
      deps.counts.add(answer.ok ? 'copy:image' : `copy:refused:${answer.kind}`);
      return answer.ok ? { bytes: answer.bytes, mediaType: answer.mediaType } : null;
    },
  };
}
