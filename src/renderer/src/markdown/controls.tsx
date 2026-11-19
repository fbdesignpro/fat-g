// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A reference as a control (docs/planning/_archive/M19b.md, Design 5; C16–C19, C24, C49, C50, C57, C58, C64,
// C65; decisions 0021, 0022): with an opener, a link whose address names a file or a site, a code
// span or a name in bold or in italics that reads as a path, and a bare address are buttons that
// hand their address to it.
//
// A control carries no address of its own (C17): it is a `button`, never an anchor, so nothing can
// be navigated to, dragged out or opened in a window from it. Its address is text the message gave,
// kept in a closure and shown in its tooltip; no element of the page is made from it. What an
// address is, the page reads with the function main checks it with (C15), and main checks it again.
//
// With no opener each of them is drawn as M19 has it: the same elements, and nothing pressed.
import { type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { readAddress, readCodeSpanPath } from '@shared/contracts/files';
import announcer from '../ui/Announcer.module.css';
import { COPY_SAID_MS } from '../ui/CopyButton';
import { menuStyles, PointPopup } from '../ui/Popup';
import { focusOpened, followPointer, nextItem } from '../ui/useMenu';
import { Address, Link, type OpenFailure, OpenerContext, ReferenceGathererContext, useTabStop } from './inert';
import styles from './Markdown.module.css';

/** Why a reference did not open, in fat-g's words (C24): said beside it for a moment, and announced. */
export const REFERENCE_WORDS: Readonly<Record<OpenFailure, string>> = {
  outside: 'Outside the project’s folders.',
  'not-found': 'Not found.',
  several: 'Several files have this name.',
  folder: 'This is a folder.',
  'not-regular': 'Not a file.',
  'no-answer': 'No answer from the drive.',
  'not-image': 'Too large, or no image fat-g shows.',
  failed: 'Could not be opened.',
};
/** How long a control says why it did not open: as long as a Copy button says what became of a copy. */
export const REFERENCE_SAID_MS = COPY_SAID_MS;

/** A reference's menu, in fat-g's words: a local one's three items, and an external one's two. */
export const REFERENCE_MENU = {
  label: 'Reference', open: 'Open', show: 'Show in folder', copyPath: 'Copy path', openLink: 'Open link', copyLink: 'Copy link',
} as const;

/** An external address with the host as the URL parser spells it, where that is not what is written (C18). */
function externalTitle(address: string): string {
  let host = '';
  try {
    host = new URL(address).host;
  } catch {
    // Drawn only for an address that parses: the address alone.
  }
  return host !== '' && !address.includes(host) ? `${address} (${host})` : address;
}

interface ControlProps {
  readonly address: string;
  readonly kind: 'external' | 'local';
  /** The whole address, for the tooltip: what is drawn of one is cut. */
  readonly title: string;
  /** The line the words beside it said (C65), for a file whose address names none. */
  readonly line?: number | null;
  readonly children: ReactNode;
}

interface MenuOpen {
  /** Whether the right button opened it: no item is marked then until the pointer is over one. */
  readonly byPointer: boolean;
  readonly at: { readonly x: number; readonly y: number };
}

const MENU_ITEMS = '[role="menuitem"]';
/** What the menu does with an event of its own: nothing of it reaches what holds the reference, a message or an activity's row. */
const keep = (event: SyntheticEvent): void => event.stopPropagation();

/**
 * The control (C17, C24, C57, C58). A click, Enter or Space gives its address to the opener: a
 * file's opens in a tab, a folder's in the file manager. It is a stop in the tab order by the rule
 * its text is drawn under, as a code block's Copy button is: in a chat, only in the current message.
 * What it holds draws no control of its own: a code span that reads as a path inside a link's text
 * is code, and a press gives the link's one address.
 *
 * The right button, Shift+F10 and the Menu key open its menu, drawn as fat-g's selection menu is: a
 * local reference's Open, Show in folder and Copy path, an external one's Open link and Copy link.
 * Main places the file or the folder for the first two of a local one, as for a press. On a
 * selection the control lies in, the selection's own menu opens instead.
 */
function ReferenceControl({ address, kind, title, line = null, children }: ControlProps) {
  const opener = useContext(OpenerContext);
  const stop = useTabStop();
  const [said, setSaid] = useState<OpenFailure | null>(null);
  const [menu, setMenu] = useState<MenuOpen | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<HTMLDivElement>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A finished message gathers its local addresses, for the thumbnails of those that are images (decision 0022, item 15).
  const gatherer = useContext(ReferenceGathererContext);
  useEffect(() => (gatherer === null || kind !== 'local' ? undefined : gatherer.add(address)), [gatherer, kind, address]);

  const act = async (run: () => Promise<OpenFailure | null>): Promise<void> => {
    const failure = await run().catch((): OpenFailure => 'failed');
    setSaid(failure);
    window.clearTimeout(timer.current);
    if (failure !== null) timer.current = window.setTimeout(() => setSaid(null), REFERENCE_SAID_MS);
  };
  const press = (): void => {
    if (opener !== null) void act(() => opener.open(address, kind, line ?? undefined));
  };

  const close = useCallback((returnFocus: boolean): void => {
    setMenu(null);
    if (returnFocus) button.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (menu === null) return;
    focusOpened(items.current, menu.byPointer);
    const onPointerDown = (event: PointerEvent): void => {
      if (items.current?.contains(event.target instanceof Node ? event.target : null) === true) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menu, close]);

  const onContextMenu = (event: MouseEvent<HTMLButtonElement>): void => {
    if (opener === null) return;
    // A selection the control lies in is the selection's: its menu has Copy and Explain this.
    const selection = document.getSelection();
    if (selection !== null && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) return;
    event.preventDefault();
    event.stopPropagation();
    // From the keyboard the event is no right button's: the menu goes under the control.
    const byPointer = event.button === 2;
    const box = event.currentTarget.getBoundingClientRect();
    setMenu({ byPointer, at: byPointer ? { x: event.clientX, y: event.clientY } : { x: box.left, y: box.bottom } });
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    event.stopPropagation();
    const to = nextItem([...(items.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])], event.key);
    if (to !== undefined) {
      event.preventDefault();
      to.focus({ preventScroll: true });
      return;
    }
    switch (event.key) {
      case 'Escape': event.preventDefault(); close(true); break;
      case 'Tab': close(false); break;
    }
  };

  /** A choice: the menu closes, the focus goes back to the control, and what did not happen is said beside it. */
  const choose = (run: () => Promise<OpenFailure | null>): void => {
    close(true);
    void act(run);
  };
  const choices: readonly (readonly [string, () => Promise<OpenFailure | null>])[] = opener === null ? [] : kind === 'local'
    ? [
        [REFERENCE_MENU.open, () => opener.open(address, kind, line ?? undefined)],
        [REFERENCE_MENU.show, () => opener.show(address)],
        [REFERENCE_MENU.copyPath, () => opener.copyPath(address)],
      ]
    : [
        [REFERENCE_MENU.openLink, () => opener.open(address, kind)],
        [REFERENCE_MENU.copyLink, () => navigator.clipboard.writeText(address).then(() => null)],
      ];

  return (
    <span data-reference={kind}>
      <button ref={button} type="button" className={styles.control} title={title} tabIndex={stop} onClick={press} onContextMenu={onContextMenu}>
        <OpenerContext value={null}>{children}</OpenerContext>
      </button>
      {said !== null && <span className={styles.said} aria-hidden="true"> {REFERENCE_WORDS[said]}</span>}
      <span className={announcer.announcer} role="status">{said !== null && REFERENCE_WORDS[said]}</span>
      {menu !== null && (
        <PointPopup at={menu.at}>
          <div
            ref={items} role="menu" tabIndex={-1} aria-label={REFERENCE_MENU.label} className={menuStyles.menu}
            onKeyDown={onMenuKeyDown} onPointerMove={(event) => followPointer(items.current, event.target)}
            onClick={keep} onMouseDown={keep} onPointerDown={keep} onContextMenu={(event) => { event.preventDefault(); keep(event); }}
          >
            {choices.map(([label, run]) => (
              <button key={label} type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={() => choose(run)}>{label}</button>
            ))}
          </div>
        </PointPopup>
      )}
    </span>
  );
}

/**
 * A link that was written as one (C16, C18): a control where its address reads `external` or
 * `local`, and the text it was where it reads `none`. An external one keeps its address after its
 * text where the two differ, so the reader sees where a press leads before it opens. `line`: the
 * line the words beside it said (C65), which a file is come to at where its address names none.
 */
export function LinkReference({ address, text, line = null, children }: { readonly address: string; readonly text: string; readonly line?: number | null; readonly children: ReactNode }) {
  const opener = useContext(OpenerContext);
  const kind = opener === null ? 'none' : readAddress(address, opener.platform);
  if (kind === 'none') return <Link address={address} text={text}>{children}</Link>;
  return (
    <ReferenceControl address={address} kind={kind} title={kind === 'external' ? externalTitle(address) : address} line={kind === 'local' ? line : null}>
      <span className={styles.link}>
        {children}
        {kind === 'external' && address !== text && <Address address={address} />}
      </span>
    </ReferenceControl>
  );
}

/**
 * A bare URL or an address in angle brackets (C50): a control where its address reads `external`,
 * opened in the browser as a written link is. Anything else the lexer made a link of, an email's
 * `mailto:` among them, is the text it was.
 */
export function BareReference({ address, text }: { readonly address: string; readonly text: string }) {
  const opener = useContext(OpenerContext);
  if (opener === null || readAddress(address, opener.platform) !== 'external') return text;
  return (
    <ReferenceControl address={address} kind="external" title={externalTitle(address)}>
      <span className={styles.link}>{text}</span>
    </ReferenceControl>
  );
}

/** A path's tooltip: the path, with the line a press comes to where the words beside it said one. */
const pathTitle = (text: string, line: number | null): string => (line === null ? text : `${text}:${line}`);

/**
 * A code span (C19, C49): one whose whole text reads as a path is a control, still drawn as code.
 * The file system is not asked before a press, so one that names no file says so when it is pressed.
 * `line`: the line the words beside it said (C65), for a path that names none itself.
 */
export function CodeSpan({ text, line = null }: { readonly text: string; readonly line?: number | null }) {
  const opener = useContext(OpenerContext);
  const code = <code className={styles.inlineCode}>{text}</code>;
  if (opener === null || readCodeSpanPath(text) === null) return code;
  return <ReferenceControl address={text} kind="local" title={pathTitle(text, line)} line={line}>{code}</ReferenceControl>;
}

/**
 * A file an activity names (M20a, C8, C38): a control given the path and its line as the provider
 * wrote them. Nothing is read to see whether it is a path, as a text's code span is: the item said
 * it is one. With no opener — a chat without a session — it is the text it holds.
 */
export function PathReference({ path, line = null, children }: { readonly path: string; readonly line?: number | null; readonly children: ReactNode }) {
  const opener = useContext(OpenerContext);
  if (opener === null) return <span>{children}</span>;
  return <ReferenceControl address={path} kind="local" title={pathTitle(path, line)} line={line}>{children}</ReferenceControl>;
}

/**
 * A file's name in bold or in italics (C64): one whose whole text reads as a path, by the code
 * span's own rule, is a control, still drawn as it was written. Some models name a file so and in
 * no other way. As with a code span the file system is not asked before a press: a product's name
 * that ends as a file's does, `Node.js`, says "Not found." when it is pressed.
 */
export function EmphasisReference({ tag: Tag, text, line = null, children }: { readonly tag: 'strong' | 'em'; readonly text: string; readonly line?: number | null; readonly children: ReactNode }) {
  const opener = useContext(OpenerContext);
  if (opener === null || readCodeSpanPath(text) === null) return <Tag>{children}</Tag>;
  return <ReferenceControl address={text} kind="local" title={pathTitle(text, line)} line={line}><Tag className={styles.name}>{children}</Tag></ReferenceControl>;
}
