// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a file's tab says (docs/planning/_archive/M19b.md, Design 8; C36, C38, C42): its title, the path above
// its text, and fat-g's words for each state that shows no text. Words and names only: which files
// are shown as what is main's to say, from the lists in the shared contracts (C56).
import { type FileUnshown, lastPart } from '@shared/contracts/files';

export const FILE_WORDS = {
  reload: 'Reload',
  refreshFailed: 'auto refresh failed',
  refreshFailedTip: 'Could not refresh this file. The last displayed version is still shown. Retrying automatically; Reload is also available.',
  refreshed: 'File automatically refreshed at',
  showInFolder: 'Show in folder',
  showFailed: 'Could not be shown.',
  /** A read that main could not be asked for, or that failed there. */
  failed: 'fat-g could not read this file.',
  /** A file that reads as an image (decision 0022, item 15): the image's own tab draws it. */
  image: 'This file is an image: it opens in a tab of its own.',
  /** Over a Markdown file past its bound, which is shown as plain text (C38). */
  pastBound: 'This Markdown file is longer than 500,000 characters, so it is shown as plain text.',
  /** The row of the asides that were asked about this file (M20b, C74): what assistive technology names it by. */
  asides: 'Side questions about this file',
} as const;

/** Why a file that was found shows no text (C42). */
export const UNSHOWN_WORDS: Readonly<Record<FileUnshown, string>> = {
  'other-kind': 'This kind of file is not shown here yet.',
  'too-large': 'This file is larger than 2 MiB and is not shown.',
  'not-text': 'This file is not text.',
};

/** The name of the text's scroller: what a test and a probe find it by. */
export const contentsLabel = (name: string): string => `Contents of ${name}`;

/** A path's parts, by either separator. */
const parts = (path: string): string[] => path.split(/[\\/]/).filter((part) => part !== '');

/**
 * A file tab's title (C36): the file's name, and where another file tab of the session has the same
 * name, its folder's after it — `harbour-log.md — field notes`.
 */
export function fileTitle(reference: string, others: readonly string[]): string {
  const name = lastPart(reference);
  if (!others.some((other) => lastPart(other) === name)) return name;
  const folder = parts(reference).at(-2);
  return folder === undefined ? name : `${name} — ${folder}`;
}

/**
 * A file's path from its root's own name (C36, C59): `fat-g/docs/roadmap/M19b.md`. Both are real
 * paths, as main answered them, so the one lies under the other; where it does not, the file's name.
 */
export function pathFromRoot(path: string, root: string): string {
  const under = path.length > root.length && path.startsWith(root) && (/[\\/]$/.test(root) || /[\\/]/.test(path.charAt(root.length)));
  if (!under) return lastPart(path);
  // A drive or the file system's root has no name of its own: it is shown as it is written.
  const rootName = parts(root).at(-1) ?? root;
  return [rootName.replace(/[\\/]+$/, ''), ...parts(path.slice(root.length))].join('/');
}
