// K3's first parser: `react-markdown` 10 with `remark-gfm` 4 (M19, C28).
//
// Two ways of drawing with it. `whole` is the component as it is documented: the message's whole
// text is read again at every update. `blocks` reads only the open block again (blocks.mjs), and
// for that uses the packages the component is itself made of — micromark's parser, mdast to hast,
// hast to React elements — since the component takes a text and nothing smaller.
//
// Neither sets `innerHTML`: both build React elements.
import { memo, useRef } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toHast } from 'mdast-util-to-hast';
import { gfm } from 'micromark-extension-gfm';
import { createSplitter, noteIds, noteNumber, noteOrder } from './blocks.mjs';
import { COMPONENTS } from './inert.jsx';

// ── whole ──────────────────────────────────────────────────────────────────────────────────────
const PLUGINS = [remarkGfm];
const Whole = memo(function Whole({ text }) {
  return <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>{text}</Markdown>;
});

// ── blocks ─────────────────────────────────────────────────────────────────────────────────────
const OPTIONS = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };
const mdast = (text) => fromMarkdown(text, OPTIONS).children;
const isDefinition = (node) => node.type === 'definition' || node.type === 'footnoteDefinition';
const parseBlocks = (input) => mdast(input).map((node) => ({ start: node.position.start.offset, definition: isDefinition(node), payload: node }));

/** mdast to hast, with raw HTML as the text it is (C31) and a note's mark as its number alone (C61). */
function hastOf(nodes, order) {
  return toHast({ type: 'root', children: nodes }, {
    handlers: {
      html: (_state, node) => ({ type: 'text', value: node.value }),
      footnoteReference: (_state, node) => ({ type: 'element', tagName: 'sup', properties: { className: ['md-note-mark'] }, children: [{ type: 'text', value: String(noteNumber(order, node.identifier)) }] }),
    },
  });
}
const elements = (hast, components = COMPONENTS) => toJsxRuntime(hast, { Fragment, jsx, jsxs, components, ignoreInvalidStyle: true, passNode: true });

/** A table's row drawn once for its text (the `rows` mode): the hast node is new at every parse, its text is not. */
const textOf = (node) => (node.type === 'text' ? node.value : (node.children ?? []).map(textOf).join(''));
const Tr = memo(function Tr({ node, children, ...rest }) { return <tr {...rest}>{children}</tr>; }, (before, after) => textOf(before.node) === textOf(after.node));
const ROW_COMPONENTS = { ...COMPONENTS, tr: Tr };

/** One block. With no definition to read by, the node its bounds were found with is drawn as it is. */
const Block = memo(function Block({ block, definitions, order, memoRows }) {
  const nodes = definitions === '' ? [block.payload] : mdast(`${definitions}${block.source}`);
  return elements(hastOf(nodes, order), memoRows ? ROW_COMPONENTS : COMPONENTS);
});

/** The notes, once, after the blocks: numbered as their marks are, with no way back. */
const Notes = memo(function Notes({ notes, order }) {
  if (order === '') return null;
  const byId = new Map(mdast(notes).filter((node) => node.type === 'footnoteDefinition').map((node) => [node.identifier.toLowerCase(), node]));
  return (
    <ol className="md-notes">
      {noteIds(order).map((id) => {
        const note = byId.get(id);
        return note === undefined ? null : <li key={id}>{elements(hastOf(note.children, order))}</li>;
      })}
    </ol>
  );
});

const makeBlocks = (memoRows) => memo(function Blocks({ text }) {
  const splitter = useRef(null);
  splitter.current ??= createSplitter(parseBlocks);
  const { drawn, notes } = splitter.current.update(text);
  const order = noteOrder(text, notes);
  return (
    <>
      {drawn.map(({ block, definitions }) => <Block key={block.key} block={block} definitions={definitions} order={block.lower?.includes('[^') ? order : ''} memoRows={memoRows} />)}
      <Notes notes={notes} order={order} />
    </>
  );
});
const Blocks = makeBlocks(false);
/** Block by block, and a table's rows each for their own text. */
const BlocksRows = makeBlocks(true);

export const MODES = { whole: Whole, blocks: Blocks, rows: BlocksRows };
/** Text to a tree that can be drawn, with no React in it. */
export const parseOnly = (text) => hastOf(mdast(text), '');
