// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Tokens to elements (docs/planning/_archive/M19.md, Design 6; C28–C35, C61, C65, C67; decision 0021): fat-g's
// own renderer for what the lexer gives. Every element is made here, by name, from a fixed list;
// no HTML string exists, and nothing a text says becomes an attribute that is loaded or a handler.
//
//   headings, paragraphs, lists, quotes, rules, tables, emphasis, strikethrough, code    elements
//   a link, a code span, a bare address, a file's name in bold or in italics              controls.tsx: a control with an opener (M19b), as M19 drew it without
//   an image, a task's box, a note's mark                                                 inert.tsx
//   raw HTML, block or inline                                                             the text it is (C31)
//   a definition                                                                          nothing
//
// Drawn block by block (C65, C67): a block is drawn again only when its signature changes, and a
// table's row only when its own does — its cells' text, and what they name.
import { Fragment, memo, type ReactNode, useState, useSyncExternalStore } from 'react';
import type { Tokens } from 'marked';
import { type CodeSpanPath, LINE_WORDS_SPAN, readCodeSpanPath, readLineAfter, readLineBefore } from '@shared/contracts/files';
import { type Named, sameSource, signatureOf } from '@shared/markdown/blocks';
import { decodeReferences } from '@shared/markdown/entities';
import { CopyButton } from '../ui/CopyButton';
import { BareReference, CodeSpan, EmphasisReference, LinkReference } from './controls';
import { Image, NoteMark, TaskBox, useSidewaysScroll, useTabStop } from './inert';
import { type MarkdownToken, NOTE_DEFINITION_TOKEN, NOTE_REFERENCE_TOKEN, type ParsedBlock, type ParsedNote } from './parse';
import { BLOCK_ATTRIBUTE, LINE_OFFSETS_ATTRIBUTE, selectionTouches, subscribeSelection } from './selection';
import styles from './Markdown.module.css';

/** How deep quotes and lists are drawn as such: past it, what is nested is drawn as the text it is. */
export const MAX_DEPTH = 64;

export const COPY_CODE = 'Copy code';
export const CODE_LABEL = 'Code';
export const TABLE_LABEL = 'Table';
export const NOTES_LABEL = 'Notes';

/** The elements a text can make: nothing outside this list is ever created for one (V13). */
export const MARKDOWN_ELEMENTS = [
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'em', 'del', 'br', 'span', 'sup',
  // fat-g's own: a code block's Copy button, and with an opener a reference's control (M19b, C17).
  'button',
] as const;

type Draw = { readonly named: Named };

/** A leaf of text: its character references decoded, but inside raw HTML, which is drawn as it was written. */
function leafText(token: Tokens.Text | Tokens.Generic): string {
  const raw = typeof token.raw === 'string' ? token.raw : '';
  return (token as Tokens.Text).escaped === true ? raw : decodeReferences(raw);
}

/**
 * The words on each side of a run of inline tokens (M19b, C65): what a reference at the run's edge
 * has beside it, outside the emphasis that holds it. Asked only for a reference that names no line.
 */
interface Beside {
  readonly before: () => string;
  readonly after: () => string;
}
const NOTHING_BESIDE: Beside = { before: () => '', after: () => '' };

/** A token as the words it shows, through emphasis and a line's break; null for anything that is not words: code, a link, an image. */
function wordsOf(token: MarkdownToken): string | null {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      return text.tokens === undefined ? leafText(text) : wordsOfAll(text.tokens);
    }
    case 'escape': return (token as Tokens.Escape).text;
    case 'strong':
    case 'em':
    case 'del': return wordsOfAll(token.tokens);
    case 'br': return '\n';
    default: return null;
  }
}

function wordsOfAll(tokens: readonly MarkdownToken[] | undefined): string | null {
  let words = '';
  for (const token of tokens ?? []) {
    const own = wordsOf(token);
    if (own === null) return null;
    words += own;
  }
  return words;
}

/** The words that follow the token at `index`, as far as they are words and no further than is read for a line. */
function wordsAfter(tokens: readonly MarkdownToken[], index: number, outer: Beside): string {
  let words = '';
  for (let at = index + 1; at < tokens.length; at += 1) {
    const own = wordsOf(tokens[at] as MarkdownToken);
    if (own === null) return words;
    words += own;
    if (words.length > LINE_WORDS_SPAN) return words;
  }
  // The run ended in words: what follows the emphasis that holds it follows them.
  return words + outer.after();
}

/** The words that come before the token at `index`, gathered the same way. */
function wordsBefore(tokens: readonly MarkdownToken[], index: number, outer: Beside): string {
  let words = '';
  for (let at = index - 1; at >= 0; at -= 1) {
    const own = wordsOf(tokens[at] as MarkdownToken);
    if (own === null) return words;
    words = own + words;
    if (words.length > LINE_WORDS_SPAN) return words;
  }
  return outer.before() + words;
}

const besideOf = (tokens: readonly MarkdownToken[], index: number, outer: Beside): Beside => ({
  before: () => wordsBefore(tokens, index, outer),
  after: () => wordsAfter(tokens, index, outer),
});

/**
 * The line the words beside a reference say (C65): `at line 12` after it, or `line 12 of` before it
 * where nothing after it says one.
 */
const wordsLine = (tokens: readonly MarkdownToken[], index: number, outer: Beside): number | null =>
  readLineAfter(wordsAfter(tokens, index, outer)) ?? readLineBefore(wordsBefore(tokens, index, outer));

/** The same, for a text read as a path: none for one that is no path, or that names its line itself. */
const saidLine = (path: CodeSpanPath | null, tokens: readonly MarkdownToken[], index: number, outer: Beside): number | null =>
  (path === null || path.line !== null ? null : wordsLine(tokens, index, outer));

/** What emphasis holds, where it is text alone: a name that may read as a path (C64). Null where it holds anything else. */
function textAlone(tokens: readonly MarkdownToken[] | undefined): string | null {
  let text = '';
  for (const token of tokens ?? []) {
    if (token.type === 'escape') text += (token as Tokens.Escape).text;
    else if (token.type === 'text' && (token as Tokens.Text).tokens === undefined) text += leafText(token);
    else return null;
  }
  return text === '' ? null : text;
}

function inlines(tokens: readonly MarkdownToken[] | undefined, draw: Draw, beside: Beside = NOTHING_BESIDE): ReactNode[] | null {
  if (tokens === undefined) return null;
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens === undefined ? leafText(text) : <Fragment key={index}>{inlines(text.tokens, draw, besideOf(tokens, index, beside))}</Fragment>;
      }
      case 'escape': return (token as Tokens.Escape).text;
      case 'strong':
      case 'em': {
        const Tag = token.type;
        const held = (token as Tokens.Strong | Tokens.Em).tokens;
        const children = inlines(held, draw, besideOf(tokens, index, beside));
        // A file's name in bold or in italics (M19b, C64): a control where it reads as a path, as a code span's does.
        const name = textAlone(held);
        const path = name === null ? null : readCodeSpanPath(name);
        if (name === null || path === null) return <Tag key={index}>{children}</Tag>;
        return <EmphasisReference key={index} tag={Tag} text={name} line={saidLine(path, tokens, index, beside)}>{children}</EmphasisReference>;
      }
      case 'del': return <del key={index}>{inlines((token as Tokens.Del).tokens, draw, besideOf(tokens, index, beside))}</del>;
      case 'codespan': {
        const text = (token as Tokens.Codespan).text;
        return <CodeSpan key={index} text={text} line={saidLine(readCodeSpanPath(text), tokens, index, beside)} />;
      }
      case 'br': return <br key={index} />;
      case 'link': {
        const link = token as Tokens.Link;
        // A bare URL, an address in angle brackets and an email (C61): the lexer made a link of
        // each, and a link that was written as one starts with its bracket. Text with no opener;
        // with one, an address that opens in the browser is a control (M19b, C50).
        if (!link.raw.startsWith('[')) return <BareReference key={index} address={link.href} text={decodeReferences(link.text)} />;
        // Its line where the words beside it say one (M19b, C65): main's reading of its address comes first.
        return <LinkReference key={index} address={link.href} text={link.text} line={wordsLine(tokens, index, beside)}>{inlines(link.tokens, draw)}</LinkReference>;
      }
      case 'image': {
        const image = token as Tokens.Image;
        return <Image key={index} alt={decodeReferences(image.text)} address={image.href} />;
      }
      case 'checkbox': return <TaskBox key={index} checked={(token as Tokens.Checkbox).checked} />;
      case NOTE_REFERENCE_TOKEN: {
        const number = draw.named.notes.get(String((token)['label']));
        return number === undefined ? token.raw : <NoteMark key={index} number={number} />;
      }
      // Raw HTML, and whatever the lexer may give that this does not know: the text it is (C31).
      default: return typeof token.raw === 'string' ? token.raw : null;
    }
  });
}

/**
 * Hard breaks separate passages within one Markdown paragraph, as in a spec sheet's numbered
 * items. Give each passage its source offsets so a reference marks only that passage. Soft wraps
 * stay together, and the original inline run is drawn whole so references keep their surrounding
 * words. The spans change neither the text nor its line breaks, selection or copy behaviour.
 */
function paragraphParts(tokens: readonly MarkdownToken[], draw: Draw, offset: number): ReactNode {
  const drawn = inlines(tokens, draw);
  if (drawn === null || !tokens.some((token) => token.type === 'br')) return drawn;
  const parts: ReactNode[] = [];
  let first = offset;
  let line = offset;
  let start = 0;
  const append = (end: number): void => {
    parts.push(<span key={start} {...{ [LINE_OFFSETS_ATTRIBUTE]: `${first}-${line}` }}>{drawn.slice(start, end)}</span>);
  };
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'br') {
      append(index);
      parts.push(<Fragment key={`br${index}`}>{drawn[index]}</Fragment>);
    }
    line += token.raw.split('\n').length - 1;
    if (token.type === 'br') { first = line; start = index + 1; }
  }
  if (start < tokens.length) append(tokens.length);
  return parts;
}

/** A code block (C34, C35, C38): its language's name where the fence gave one, its Copy button, and its text, in the monospace font. */
function CodeBlock({ text, language, block }: { readonly text: string; readonly language: string; readonly block: string | undefined }) {
  const [scroller, scrollStop] = useSidewaysScroll<HTMLPreElement>();
  const stop = useTabStop();
  return (
    <div className={styles.code} {...(block === undefined ? {} : { [BLOCK_ATTRIBUTE]: block })}>
      <div className={styles.codeHead}>
        <span className={styles.language}>{language}</span>
        <CopyButton label={COPY_CODE} text={() => text} tabIndex={stop} />
      </div>
      <pre ref={scroller} className={styles.pre} tabIndex={scrollStop} aria-label={language === '' ? CODE_LABEL : `${CODE_LABEL}: ${language}`}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

const alignment = (side: Tokens.TableCell['align']) => (side === null ? undefined : { textAlign: side });

/** A table's row, drawn once for its cells' text, the sides its columns are aligned to and what its cells name (C67). */
const Row = memo(function Row({ cells, header, draw }: { readonly cells: readonly Tokens.TableCell[]; readonly header: boolean; readonly signature: string; readonly draw: Draw }) {
  const Cell = header ? 'th' : 'td';
  return <tr>{cells.map((cell, index) => <Cell key={index} style={alignment(cell.align)}>{inlines(cell.tokens, draw)}</Cell>)}</tr>;
}, (before, after) => before.header === after.header && before.signature === after.signature);

const CELL = '\u0005';
const ALIGNED = '\u0006';
/**
 * What a row is cached by: each cell's text and the side its column is aligned to — which a table's
 * second line settles only once it is all there — and what each label in the row is at this reading.
 */
const rowSignature = (cells: readonly Tokens.TableCell[], named: Named): string => signatureOf(cells.map((cell) => `${cell.align ?? ''}${ALIGNED}${cell.text}`).join(CELL), named);

function Table({ table, draw, block }: { readonly table: Tokens.Table; readonly draw: Draw; readonly block: string | undefined }) {
  const [scroller, scrollStop] = useSidewaysScroll<HTMLDivElement>();
  return (
    <div ref={scroller} className={styles.tableScroll} tabIndex={scrollStop} aria-label={TABLE_LABEL} {...(block === undefined ? {} : { [BLOCK_ATTRIBUTE]: block })}>
      <table className={styles.table}>
        <thead><Row cells={table.header} header signature={rowSignature(table.header, draw.named)} draw={draw} /></thead>
        <tbody>{table.rows.map((row, index) => <Row key={index} cells={row} header={false} signature={rowSignature(row, draw.named)} draw={draw} />)}</tbody>
      </table>
    </div>
  );
}

/** One block token as its element. `block`: the id its element carries, for a top-level one. */
function blockElement(token: MarkdownToken, draw: Draw, depth: number, key: number, block?: string, lineOffset = 0): ReactNode {
  const mark = block === undefined ? {} : { [BLOCK_ATTRIBUTE]: block };
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      const Tag = `h${Math.min(6, Math.max(1, heading.depth))}` as 'h1';
      return <Tag key={key} className={styles.heading} {...mark}>{inlines(heading.tokens, draw)}</Tag>;
    }
    case 'paragraph': {
      const tokens = (token as Tokens.Paragraph).tokens;
      return <p key={key} {...mark}>{block === undefined ? inlines(tokens, draw) : paragraphParts(tokens, draw, lineOffset)}</p>;
    }
    case 'text': {
      const text = token as Tokens.Text;
      const content = text.tokens === undefined ? leafText(text) : inlines(text.tokens, draw);
      // Inside a list's item it is the item's own line; at the top it is a paragraph.
      return block === undefined ? <Fragment key={key}>{content}</Fragment> : <p key={key} {...mark}>{content}</p>;
    }
    case 'code': {
      const code = token as Tokens.Code;
      return <CodeBlock key={key} text={code.text} language={(code.lang ?? '').trim().split(/\s+/)[0] ?? ''} block={block} />;
    }
    case 'blockquote':
      if (depth >= MAX_DEPTH) return <p key={key} className={styles.raw} {...mark}>{token.raw}</p>;
      return <blockquote key={key} {...mark}>{blocks((token as Tokens.Blockquote).tokens, draw, depth + 1)}</blockquote>;
    case 'list': {
      const list = token as Tokens.List;
      if (depth >= MAX_DEPTH) return <p key={key} className={styles.raw} {...mark}>{token.raw}</p>;
      const items = list.items.map((item, index) => <li key={index} className={item.task ? styles.taskItem : undefined}>{blocks(item.tokens, draw, depth + 1)}</li>);
      if (!list.ordered) return <ul key={key} {...mark}>{items}</ul>;
      return <ol key={key} start={typeof list.start === 'number' && list.start !== 1 ? list.start : undefined} {...mark}>{items}</ol>;
    }
    case 'table': return <Table key={key} table={token as Tokens.Table} draw={draw} block={block} />;
    case 'hr': return <hr key={key} className={styles.rule} {...mark} />;
    case 'checkbox': return <TaskBox key={key} checked={(token as Tokens.Checkbox).checked} />;
    // Raw HTML is the text it is (C31): never an element of its own making.
    case 'html': return <p key={key} className={styles.raw} {...mark}>{token.raw}</p>;
    // A definition draws nothing where it stands: a link's is its references' address, a note's is in the list of notes.
    case 'space':
    case 'def':
    case NOTE_DEFINITION_TOKEN:
      return null;
    default: return typeof token.raw === 'string' && token.raw.trim() !== '' ? <p key={key} className={styles.raw} {...mark}>{token.raw}</p> : null;
  }
}

function blocks(tokens: readonly MarkdownToken[] | undefined, draw: Draw, depth: number): ReactNode {
  return tokens === undefined ? null : tokens.map((token, index) => blockElement(token, draw, depth, index));
}

/**
 * One top-level block (C65). It is drawn again only when its signature changes. A change that is a
 * late definition's alone waits while the reader's selection touches the block (C61); a change of
 * its own text never waits.
 */
export const Block = memo(function Block({ id, block }: { readonly id: string; readonly block: ParsedBlock }) {
  const touched = useSyncExternalStore(subscribeSelection, () => selectionTouches(id), () => false);
  const [held, setHeld] = useState(block);
  let shown = held;
  if (held !== block) {
    const waits = touched && held.signature !== block.signature && sameSource(held.signature, block.signature);
    if (!waits) {
      setHeld(block);
      shown = block;
    }
  }
  const leading = shown.source.slice(0, shown.source.indexOf(shown.token.raw));
  return blockElement(shown.token, { named: shown.named }, 0, shown.index, id, leading.split('\n').length - 1);
}, (before, after) => before.id === after.id && before.block.signature === after.block.signature);

/** The notes, after the text (C61): a numbered list, in the order of their numbers, with no link and no way back. */
export const Notes = memo(function Notes({ notes, named }: { readonly notes: readonly ParsedNote[]; readonly signature: string; readonly named: Named }) {
  return (
    <ol className={styles.notes} aria-label={NOTES_LABEL}>
      {notes.map((note) => <li key={note.label} value={note.number}>{inlines(note.tokens, { named })}</li>)}
    </ol>
  );
}, (before, after) => before.signature === after.signature);
