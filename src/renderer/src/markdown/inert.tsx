// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a text can name and fat-g does not act on (docs/planning/_archive/M19.md, Design 6; C31–C33, C35, C61):
// a link, an image, a task's box and a note's mark are drawn as text and glyphs. None of them is a
// control, none carries an address that is loaded, and no `a`, `img` or `input` is ever made.
// Images are M23's and M25's.
//
// Where a text is given an opener (docs/planning/_archive/M19b.md, Design 5; C16), a link, a code span that
// reads as a path and a bare address are controls that hand their address to it: controls.tsx. The
// context is here, beside the tab-stop rule the chat hands the same way.
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from 'react';
import type { FileRefusal } from '@shared/contracts/files';
import styles from './Markdown.module.css';

/** How much of an address is drawn: the rest is in the message's source, which Copy takes whole. */
export const MAX_ADDRESS_SHOWN = 200;

const shownAddress = (address: string): string => (address.length > MAX_ADDRESS_SHOWN ? `${address.slice(0, MAX_ADDRESS_SHOWN)}…` : address);

/** An address, as muted text in brackets: never an attribute, so nothing follows or loads it. */
export function Address({ address }: { readonly address: string }) {
  return <span className={styles.address}> ({shownAddress(address)})</span>;
}

/** A link with no opener (C33): its text, then its address where the two differ. Nothing opens, by a click or by a key. */
export function Link({ address, text, children }: { readonly address: string; readonly text: string; readonly children: ReactNode }) {
  return (
    <span className={styles.link}>
      {children}
      {address !== '' && address !== text && <Address address={address} />}
    </span>
  );
}

/** An image (C32): its alternative text and its address, as text. Nothing is fetched or decoded, a `data:` image included. */
export function Image({ alt, address }: { readonly alt: string; readonly address: string }) {
  return (
    <span className={styles.image}>
      {alt === '' ? 'Image' : alt}
      {address !== '' && <Address address={address} />}
    </span>
  );
}

export const TASK_WORDS = { done: 'Done', open: 'To do' } as const;

/** A task's box (C29): a glyph that says whether it is ticked, and no control. */
export function TaskBox({ checked }: { readonly checked: boolean }) {
  return <span className={styles.task} role="img" aria-label={checked ? TASK_WORDS.done : TASK_WORDS.open}>{checked ? '☑' : '☐'}</span>;
}

/** A note's mark in the text (C61): its number alone, with no link and no fragment address. */
export function NoteMark({ number }: { readonly number: number }) {
  return <sup className={styles.noteMark}>{number}</sup>;
}

/**
 * Whether what a text draws that can take the keyboard's focus is a stop in the tab order (C50). A
 * text drawn by itself is; a chat's list says so for its current message alone, so that the code
 * blocks and tables of five hundred messages are not five hundred stops.
 */
export const TabStopContext = createContext(true);

/** Why a reference did not open (M19b, C24): a file's refusal, or `failed` for one that could not be opened at all. */
export type OpenFailure = FileRefusal | 'failed';

/**
 * What a control hands its address to (M19b, C16, C20). It knows no file and no tab: the page's one
 * opener is behind it (src/renderer/src/artifacts/opener.ts).
 */
export interface Opener {
  /** The host's platform: what an address is read with, as main reads it (C15). */
  readonly platform: string;
  /**
   * Opens an address: `external` in the system's browser, `local` as a file's tab, or a folder in the
   * system's file manager. A code span that reads as a path is `local` by that reading (C19, C49),
   * whatever its text would read as an address. Resolves with why it did not open, or null when it
   * did. `line`: the line the words beside a reference said (C65), which a file is come to at where
   * its address names none.
   */
  open(address: string, kind: 'external' | 'local', line?: number): Promise<OpenFailure | null>;
  /** Shows the file or folder a local address leads to selected in the system's file manager: a reference's menu. */
  show(address: string): Promise<OpenFailure | null>;
  /** Copies the full path of the file or folder a local address leads to, as main found it: a reference's menu. */
  copyPath(address: string): Promise<OpenFailure | null>;
}

/**
 * The opener of the text being drawn, or none (M19b, C16): with none a link, a code span and a bare
 * address are drawn as M19 has them. One value for a session, so that a re-render of the chat gives
 * every block the same one and no block is drawn again for it (M19, C65, C67).
 */
export const OpenerContext = createContext<Opener | null>(null);

/**
 * What a message gathers the local addresses its text names into (decision 0022, item 15): each local
 * reference gives its address while it is drawn and takes it back when it goes, and the message draws
 * a thumbnail of each that main reads as an image. None outside a finished message.
 */
export interface ReferenceGatherer {
  add(address: string): () => void;
}
export const ReferenceGathererContext = createContext<ReferenceGatherer | null>(null);

/**
 * A part that scrolls sideways within itself (C35): a stop for the keyboard, so the arrow keys
 * scroll it, only while it is wider than its place and its text's controls are stops at all.
 */
export function useSidewaysScroll<T extends HTMLElement>(given?: RefObject<T | null>): readonly [ref: RefObject<T | null>, tabIndex: number] {
  const stop = useContext(TabStopContext);
  const own = useRef<T>(null);
  // Whoever draws the part may hold its element too: one ref then, and the same one at every drawing.
  const ref = given ?? own;
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!stop || element === null || typeof ResizeObserver === 'undefined') return;
    // Its own size, and its content's, which grows while the text is written.
    const observer = new ResizeObserver(() => setWide(element.scrollWidth > element.clientWidth));
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [stop, ref]);
  return [ref, stop && wide ? 0 : -1];
}

/** A top-level block of a text, as whoever draws something beside it is told of it: its place, its element's id, and the lines of its source. */
export interface BlockInfo {
  readonly index: number;
  /** The id its element carries, in `data-md-block`. */
  readonly id: string;
  readonly firstLine: number;
  readonly lastLine: number;
  /** Whether it is the first of the text's blocks that has something beside it: where a text's one stop for the keyboard is. */
  readonly first: boolean;
}

/**
 * What is drawn beside each top-level block of the text being drawn, or none (M20b, C46). The
 * Markdown module knows nothing of what it is: it is handed a function, and draws what the function
 * gives in the block's margin, directly before the block's element — so the block is the element
 * after it, and the text's own elements are as they are without it. One value for a text, so that
 * no block is drawn again for it.
 */
export const BlockControlContext = createContext<((block: BlockInfo) => ReactNode) | null>(null);

/** The attribute the element that holds a block's control carries: the id of the block it stands beside. */
export const CONTROL_ATTRIBUTE = 'data-md-control';

/** A control's place in the tab order, by the same word. */
export function useTabStop(): number {
  return useContext(TabStopContext) ? 0 : -1;
}
