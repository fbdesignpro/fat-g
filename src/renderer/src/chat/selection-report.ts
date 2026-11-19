// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A selection's report (docs/planning/_archive/M20b.md, Design 7; C45, C75): what Explain this sends of a
// selection — where it came from, its text, its lines where the drawing carries them, and where it
// lies in the drawn text, with the digest of what is drawn there.
//
// What a selection may come from is marked in the DOM, on the element that holds the drawn text of
// one message, of one activity's input or output, of one file, or of one version of a plan (M22b, C26). A selection inside one such
// element has a report; one that touches two, or none, has none, and gets Copy alone (C45).
import { type AsideSource, type AsideSourceKind, type AsideSourceRef, cutExcerpt } from '@shared/contracts/aside';
import { BLOCK_ATTRIBUTE, blockLines } from '../markdown/selection';
import { placeOf } from './drawn-text';

export const SOURCE_KIND = 'data-source-kind';
/** The attribute the element that holds a plain text's lines carries, a line its child by its number: the plain view marks itself with it. */
export const LINES_HOLDER = 'data-file-lines';
const SOURCE_ITEM = 'data-source-item';
const SOURCE_ROLE = 'data-source-role';
const SOURCE_PART = 'data-source-part';
const SOURCE_WORKER = 'data-source-worker';
const SOURCE_PATH = 'data-source-path';
const SOURCE_VERSION = 'data-source-version';

/** What a drawn text was taken from: a source without the selection's own fields. */
export type SourceOf = Pick<AsideSourceRef, 'kind' | 'itemId' | 'role' | 'part' | 'workerId' | 'path'> & { readonly version?: number | null };

export const messageSource = (itemId: string, role: 'user' | 'assistant', workerId: string | null): SourceOf => ({ kind: 'message', itemId, role, part: null, workerId, path: null });
export const activitySource = (itemId: string, part: 'input' | 'output', workerId: string | null): SourceOf => ({ kind: 'activity', itemId, role: null, part, workerId, path: null });
export const fileSource = (path: string): SourceOf => ({ kind: 'file', itemId: null, role: null, part: null, workerId: null, path });
/** A plan's version, drawn in its tab (M22b, C26): its id stands where an item's would. */
export const planSource = (planId: string, version: number): SourceOf => ({ kind: 'plan', itemId: planId, role: null, part: null, workerId: null, path: null, version });

/** The attributes that mark an element as the drawn text of a source: spread on it. */
export function sourceAttributes(source: SourceOf): Record<string, string> {
  return {
    [SOURCE_KIND]: source.kind,
    ...(source.itemId === null ? {} : { [SOURCE_ITEM]: source.itemId }),
    ...(source.role === null ? {} : { [SOURCE_ROLE]: source.role }),
    ...(source.part === null ? {} : { [SOURCE_PART]: source.part }),
    ...(source.workerId === null ? {} : { [SOURCE_WORKER]: source.workerId }),
    ...(source.path === null ? {} : { [SOURCE_PATH]: source.path }),
    ...(source.version == null ? {} : { [SOURCE_VERSION]: String(source.version) }),
  };
}

const KINDS: readonly string[] = ['message', 'activity', 'file', 'plan'] satisfies readonly AsideSourceKind[];

/** What an element marks itself as the drawn text of, or null for one that marks nothing whole. */
export function readSource(element: Element): SourceOf | null {
  const kind = element.getAttribute(SOURCE_KIND);
  if (kind === null || !KINDS.includes(kind)) return null;
  const role = element.getAttribute(SOURCE_ROLE);
  const part = element.getAttribute(SOURCE_PART);
  const source: SourceOf = {
    kind: kind as AsideSourceKind,
    itemId: element.getAttribute(SOURCE_ITEM),
    role: role === 'user' || role === 'assistant' ? role : null,
    part: part === 'input' || part === 'output' ? part : null,
    workerId: element.getAttribute(SOURCE_WORKER),
    path: element.getAttribute(SOURCE_PATH),
  };
  if (source.kind === 'message') return source.itemId !== null && source.role !== null ? source : null;
  if (source.kind === 'activity') return source.itemId !== null && source.part !== null ? source : null;
  if (source.kind === 'plan') {
    const version = Number(element.getAttribute(SOURCE_VERSION));
    return source.itemId !== null && Number.isInteger(version) && version >= 1 ? { ...source, version } : null;
  }
  return source.path !== null ? source : null;
}

/** The source whose drawn text holds a node, or null. */
export function sourceRoot(node: Node | null): Element | null {
  const element = node === null ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest(`[${SOURCE_KIND}]`) ?? null;
}

/**
 * The source lines a range touches, where the drawing carries them (C45): from the first block it
 * touches to the last, by the Markdown drawing's line marks, in an assistant's message as in a
 * Markdown file; from the view's own lines in a plain text. A prompt and an activity's text carry
 * none.
 */
function linesOf(root: Element, range: Range): { readonly first: number; readonly last: number } | null {
  const plain = root.querySelector(`[${LINES_HOLDER}]`);
  if (plain !== null) {
    let first: number | null = null;
    let last: number | null = null;
    for (const [index, line] of [...plain.children].entries()) {
      if (!range.intersectsNode(line)) continue;
      // A range that ends at a line's very start does not touch that line.
      if (range.endContainer === line && range.endOffset === 0 && first !== null) continue;
      first ??= index + 1;
      last = index + 1;
    }
    return first === null || last === null ? null : { first, last };
  }
  const touched = [...root.querySelectorAll(`[${BLOCK_ATTRIBUTE}]`)].filter((block) => range.intersectsNode(block)).flatMap((block) => { const lines = blockLines(block); return lines === null ? [] : [lines]; });
  const [first] = touched;
  const last = touched.at(-1);
  return first === undefined || last === undefined ? null : { first: first.first, last: last.last };
}

/** A range of one source as a report: its place, its lines and its text. Null where it is empty, or its text is. */
export function reportRange(root: Element, range: Range, text: string): AsideSource | null {
  const source = readSource(root);
  const place = placeOf(root, range);
  if (source === null || place === null || text.trim() === '') return null;
  return { ...source, lines: linesOf(root, range), ...place, ...cutExcerpt(text) };
}

/** The selection's report (C45), or null for one that is empty, or is not inside one source. */
export function reportSelection(selection: Selection | null): AsideSource | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const root = sourceRoot(range.startContainer);
  if (root === null || root !== sourceRoot(range.endContainer)) return null;
  return reportRange(root, range, selection.toString());
}

/**
 * A whole block's report (C46): what the Explain this control beside it sends. Its text is the
 * block's source, by its lines, and its place the block's own span of the drawn text. A block's
 * lines are its marks', which give it the blank lines after it (M19b, C41): those are no part of
 * the text sent.
 */
export function reportBlock(block: Element, sourceText: string): AsideSource | null {
  const root = sourceRoot(block);
  const lines = blockLines(block);
  if (root === null || lines === null) return null;
  const source = readSource(root);
  const range = block.ownerDocument.createRange();
  range.selectNodeContents(block);
  const place = placeOf(root, range);
  const text = sourceText.split('\n').slice(lines.first - 1, lines.last).join('\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
  if (source === null || place === null || text.trim() === '') return null;
  return { ...source, lines, ...place, ...cutExcerpt(text) };
}
