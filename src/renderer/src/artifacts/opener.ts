// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The page's one opener (docs/planning/_archive/M19b.md, Design 6; C20, C23, C24, C65; decision 0022): given a
// session and an address, an external address goes to main's channel for the system's browser, and
// a local one opens or selects a file's tab, or has main open the folder it names in the file
// manager. The chat calls it for a reference in a message, the `file` kind for one in a shown file,
// and an activity's file the same way (M20a, C38). A reference's menu shows where one leads in the
// file manager, and copies its full path, through it too.
//
// It resolves nothing and reads nothing itself: the address goes to main as it was written, and what
// comes back is what main checked. It names no kind's module: a tab is opened by a kind's id.
//
// A sub-agent's thread is opened here too (docs/planning/_archive/M106.md, Design 6; C4, C24), in the session's
// Sub-agents tab with that sub-agent chosen: from a worker row in the chat, from one in another
// sub-agent's thread, and from an aside asked about a sub-agent's message. The worker's own tab of
// M20a (C40, C47) retired with it.
//
// And an aside's (docs/planning/_archive/M20b.md, Design 6; C36, C41), by the aside's id: from Explain this,
// from a marker, a highlighted passage, and the toolbar's new-question action.
//
// And a plan's (docs/planning/_archive/M22b.md, Design 7; C25), by the plan's id: from its line, from a
// prompt's folded block, from the decision panel and by the kind's watcher.
//
// And an image's (docs/planning/_archive/M23.md, Design 4; C26, C27), by its hash: from a user's message's
// thumbnail, its name and size handed beside it for its title and its fallback. An image file's
// (decision 0022, item 15), by its real path: from a reference main read as an image, and from the
// thumbnail of one an agent read or a message names, drawn by the id main gave it for the run.
import { type FileImage, lastPart, readAddress } from '@shared/contracts/files';
import { invoke } from '../ipc/client';
import type { OpenFailure, Opener } from '../markdown/inert';
import { openTab } from './tabs-store';

/** The kind a local reference opens as. */
export const FILE_KIND = 'file';
/** The kind a session's sub-agents open as (M100, round 8; C78): one tab a session, its reference null (M106, C4). */
export const AGENTS_KIND = 'agents';
/** The kind a question beside the session opens as (M20b, C36). */
export const ASIDE_KIND = 'aside';
/** The kind a plan opens as (M22b, C25). */
export const PLAN_KIND = 'plan';
/** The kind an image of the chat opens as (M23, C27). */
export const IMAGE_KIND = 'image';

/** What an image's tab is drawn with beside its hash (M23, C8, C27): its name and size, whether fat-g holds its file, and its place among its message's images. */
export interface ImageShown {
  readonly name: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly available: boolean;
  readonly ordinal: number;
  /** An image file's (decision 0022, item 15): the id main gave it for the run, which its address names. */
  readonly file?: string;
}

/** Each explicit opening retries the media load, including an earlier failed load of the same id. */
let imageOpenings = 0;

/**
 * Opens an image file's tab in its session, or selects the one that is open for it (decision 0022,
 * item 15): its identity is its real path, and it is drawn by the id main's read gave it, which a new
 * read replaces. Nothing is read here, and neither the focus nor the chat's place moves (M19b, C12).
 */
export function openImageFile(sessionId: string, image: FileImage): boolean {
  return openTab(sessionId, IMAGE_KIND, { path: image.path }, { viewState: { serial: ++imageOpenings, display: { name: lastPart(image.path), width: image.width, height: image.height, available: true, ordinal: 1, file: image.id } } });
}

/**
 * Opens an image's tab in its session, or selects the one that is open for it (M23, C27; M19b, C8):
 * its identity is its hash, whatever name it was dropped under. Nothing is read here, and neither the
 * focus nor the chat's place moves (M19b, C12).
 */
export function openImage(sessionId: string, hash: string, shown: ImageShown): boolean {
  return openTab(sessionId, IMAGE_KIND, hash, { viewState: { serial: ++imageOpenings, display: shown } });
}

/**
 * Opens a plan's tab in its session, or selects the one that is open for it (M22b, C25; M19b, C8).
 * `title`: the plan's, as whoever opens it knows it, which titles the tab until its own read says it.
 * `version`: the version to show, where one is named; else the tab shows its latest. Nothing is read
 * here, and neither the focus nor the chat's place moves (M19b, C12).
 */
export function openPlan(sessionId: string, planId: string, title: string | null, version: number | null = null, select = true): boolean {
  // A version named drops a passage an anchor marked in another (M22e, C33).
  return openTab(sessionId, PLAN_KIND, planId, { handed: title, select, ...(version === null ? {} : { viewState: { version, serial: (namings += 1), line: undefined, missing: undefined } }) });
}

/**
 * Opens a plan's tab at a passage of a version (M22e, C33, C41): a finding's anchor, its line found by
 * main, which the tab marks and comes to; a line not found opens the version at its start, saying so.
 */
export function openPlanAt(sessionId: string, planId: string, title: string | null, version: number, line: number | null): boolean {
  return openTab(sessionId, PLAN_KIND, planId, { handed: title, viewState: { version, serial: (namings += 1), ...(line === null ? { missing: true } : { line }) } });
}

/** An aside's tab asks for the keyboard at each naming of it: a new side question's field (M20b, C41). */
let focusings = 0;

/**
 * Opens an aside's tab in its session, or selects the one that is open for it (M20b, C36, C41; M19b,
 * C8). `title`: the aside's, as whoever opens it knows it, which titles the tab until its own read
 * says it; null for one that has no question yet. Nothing is read here, and neither the focus nor
 * the chat's place moves (M19b, C12) — but for a new side question, whose field asks for the focus.
 * An optional draft prepopulates that field without sending a question.
 */
export function openAside(sessionId: string, asideId: string, title: string | null, focus = false, draft?: string): boolean {
  const viewState = {
    ...(focus ? { focus: (focusings += 1) } : {}),
    ...(draft === undefined ? {} : { draft }),
  };
  return openTab(sessionId, ASIDE_KIND, asideId, { handed: title, ...(focus || draft !== undefined ? { viewState } : {}) });
}

/**
 * Opens a session's Sub-agents tab, or selects it, with a sub-agent chosen (M106, C4, C23, C24): its
 * thread unfolds under its row. `label`: the sub-agent's, as whoever opens it shows it, which heads a
 * thread opened for one the list no longer holds; null where none is known. Nothing is read here, and
 * neither the focus nor the chat's place moves (M19b, C12).
 */
export function openAgent(sessionId: string, workerId: string, label: string | null): boolean {
  return openTab(sessionId, AGENTS_KIND, null, { first: true, viewState: { chosen: { id: workerId, label: label === '' ? null : label } } });
}

export interface OpenOptions {
  /** For a reference found in a shown file, that file's real path: main resolves a relative target against its folder (C25). */
  readonly from?: string | undefined;
  /** The address is a path whatever it reads as: a code span that reads as one (C19, C49). */
  readonly local?: boolean;
  /** The line the words beside the reference said (C65): come to where the address itself names none. */
  readonly line?: number | undefined;
}

/** A reference's line as the tab's view state: each naming of one is a new one to come to, the same line included. */
let namings = 0;
const lineState = (line: number, column: number | null): { line: number; column: number | null; serial: number } => ({ line, column, serial: (namings += 1) });

/**
 * Opens a reference. Resolves with why it did not open (C24), or null when it did: for an external
 * address, once main has handed it to the browser; for a local one, once its tab is open, or once
 * main has had the file manager open the folder it names (decision 0022).
 */
export async function openReference(sessionId: string, address: string, { from, local = false, line }: OpenOptions = {}): Promise<OpenFailure | null> {
  const kind = local ? 'local' : readAddress(address, window.fatg.platform);
  // No control is made for an address that reads `none`.
  if (kind === 'none') return 'failed';
  try {
    if (kind === 'external') {
      // At once, with no question asked: its address is in sight beside its text (C18, C23).
      await invoke('shell:openAddress', { address });
      return null;
    }
    const claim = { sessionId, target: address, ...(from === undefined ? {} : { from }) };
    const answer = await invoke('files:read', claim);
    // An image (decision 0022, item 15): its own tab, which draws it by its id.
    if (answer.outcome === 'image') {
      openImageFile(sessionId, answer);
      return null;
    }
    // A folder: main places it again, and the file manager opens it.
    if (answer.outcome === 'refused' && answer.why === 'folder') {
      await invoke('files:openFolder', claim);
      return null;
    }
    if (answer.outcome === 'refused') return answer.why;
    // The line the address named, which main read; where it named none, the one the words beside it said (C65).
    const at = answer.line === null ? (line === undefined ? null : { line, column: null }) : { line: answer.line, column: answer.column };
    // The answer goes with the tab, so that the opening reads once (C32).
    openTab(sessionId, FILE_KIND, answer.path, { handed: answer, ...(at === null ? {} : { viewState: lineState(at.line, at.column) }) });
    return null;
  } catch {
    return 'failed';
  }
}

/** Where a local reference leads, as main placed it: its real path, or why it leads nowhere. */
async function locateReference(sessionId: string, address: string, from: string | undefined): Promise<{ readonly path: string } | { readonly failure: OpenFailure }> {
  try {
    const answer = await invoke('files:locate', { sessionId, target: address, ...(from === undefined ? {} : { from }) });
    return answer.outcome === 'refused' ? { failure: answer.why } : { path: answer.path };
  } catch {
    return { failure: 'failed' };
  }
}

/**
 * Shows the file or folder a local reference leads to selected in the file manager: a reference's
 * menu. Main places it, and checks the path it answered again before it shows it.
 */
export async function showReference(sessionId: string, address: string, from?: string): Promise<OpenFailure | null> {
  const placed = await locateReference(sessionId, address, from);
  if ('failure' in placed) return placed.failure;
  try {
    await invoke('files:showInFolder', { sessionId, path: placed.path });
    return null;
  } catch {
    return 'failed';
  }
}

/** Copies the full path of the file or folder a local reference leads to, as main placed it: a reference's menu. */
export async function copyReferencePath(sessionId: string, address: string, from?: string): Promise<OpenFailure | null> {
  const placed = await locateReference(sessionId, address, from);
  if ('failure' in placed) return placed.failure;
  return navigator.clipboard.writeText(placed.path).then(() => null, (): OpenFailure => 'failed');
}

/**
 * The opener a text is drawn with (C16): one value for a session — and, in a shown file, for that
 * file — made once where it is provided, so that a re-render gives every block the same one.
 */
export function createOpener(sessionId: string, from?: string): Opener {
  return {
    platform: window.fatg.platform,
    open: (address, kind, line) => openReference(sessionId, address, { from, local: kind === 'local', line }),
    show: (address) => showReference(sessionId, address, from),
    copyPath: (address) => copyReferencePath(sessionId, address, from),
  };
}
