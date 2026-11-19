// K3's second parser: `marked` 18, its lexer alone, with a renderer of the spike's own that turns its
// tokens into React elements (M19, C28's note). No HTML string is made and none is set.
//
// What the renderer leaves out, and a renderer of fat-g's own would have to add: footnotes, which
// marked does not read; the decoding of character references (`&amp;`), which marked leaves to its
// own HTML renderer; and every corner of CommonMark its tokens do not settle.
import { Fragment, memo, useRef } from 'react';
import { Lexer } from 'marked';
import { createSplitter } from './blocks.mjs';
import { Image, Link, Table, TaskBox } from './inert.jsx';

const OPTIONS = { gfm: true, breaks: false };
const lex = (text) => new Lexer(OPTIONS).lex(text);

/** The lexer's top-level tokens as blocks: blank lines belong to the block before them. */
function parseBlocks(input) {
  const out = [];
  let offset = 0;
  for (const token of lex(input)) {
    const start = offset;
    offset += token.raw.length;
    if (token.type !== 'space') out.push({ start, definition: token.type === 'def', payload: token });
  }
  return out;
}

const align = (side) => (side ? { textAlign: side } : undefined);

/** A table's row drawn once for its cells' text (the `rows` mode): a row the lexer gives again unchanged keeps its elements. */
const rowKey = (cells) => cells.map((cell) => cell.text).join('');
const Row = memo(function Row({ cells, header }) {
  const Cell = header ? 'th' : 'td';
  return <tr>{cells.map((cell, index) => <Cell key={index} style={align(cell.align)}>{inlines(cell.tokens)}</Cell>)}</tr>;
}, (before, after) => before.header === after.header && before.keyText === after.keyText);

function inlines(tokens) {
  if (!tokens) return null;
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'text': return token.tokens ? <Fragment key={index}>{inlines(token.tokens)}</Fragment> : token.text;
      case 'escape': return token.text;
      case 'strong': return <strong key={index}>{inlines(token.tokens)}</strong>;
      case 'em': return <em key={index}>{inlines(token.tokens)}</em>;
      case 'del': return <del key={index}>{inlines(token.tokens)}</del>;
      case 'codespan': return <code key={index}>{token.text}</code>;
      case 'br': return <br key={index} />;
      case 'link': return <Link key={index} href={token.href}>{inlines(token.tokens)}</Link>;
      case 'image': return <Image key={index} alt={token.text} src={token.href} />;
      case 'checkbox': return <TaskBox key={index} checked={token.checked} />;
      // Raw HTML is the text it is (C31).
      default: return token.raw ?? null;
    }
  });
}

function blocks(tokens, memoRows = false) {
  if (!tokens) return null;
  return tokens.map((token, key) => {
    switch (token.type) {
      case 'heading': { const Tag = `h${token.depth}`; return <Tag key={key}>{inlines(token.tokens)}</Tag>; }
      case 'paragraph': return <p key={key}>{inlines(token.tokens)}</p>;
      case 'text': return token.tokens ? <Fragment key={key}>{inlines(token.tokens)}</Fragment> : token.text;
      case 'code': return <pre key={key} data-lang={token.lang || undefined}><code>{token.text}</code></pre>;
      case 'blockquote': return <blockquote key={key}>{blocks(token.tokens, memoRows)}</blockquote>;
      case 'list': {
        const Tag = token.ordered ? 'ol' : 'ul';
        return (
          <Tag key={key} start={token.ordered && token.start !== 1 && token.start !== '' ? token.start : undefined}>
            {token.items.map((item, index) => <li key={index}>{item.task && !item.tokens?.some((inner) => inner.type === 'checkbox' || inner.tokens?.some((deep) => deep.type === 'checkbox')) ? <TaskBox checked={item.checked} /> : null}{blocks(item.tokens, memoRows)}</li>)}
          </Tag>
        );
      }
      case 'table':
        if (memoRows) {
          return (
            <Table key={key}>
              <thead><Row cells={token.header} keyText={rowKey(token.header)} header /></thead>
              <tbody>{token.rows.map((row, r) => <Row key={r} cells={row} keyText={rowKey(row)} />)}</tbody>
            </Table>
          );
        }
        return (
          <Table key={key}>
            <thead><tr>{token.header.map((cell, index) => <th key={index} style={align(cell.align)}>{inlines(cell.tokens)}</th>)}</tr></thead>
            <tbody>{token.rows.map((row, r) => <tr key={r}>{row.map((cell, index) => <td key={index} style={align(cell.align)}>{inlines(cell.tokens)}</td>)}</tr>)}</tbody>
          </Table>
        );
      case 'hr': return <hr key={key} />;
      case 'checkbox': return <TaskBox key={key} checked={token.checked} />;
      case 'html': return <p key={key} className="md-html">{token.raw}</p>;
      case 'space':
      case 'def': return null;
      default: return token.raw ? <p key={key}>{token.raw}</p> : null;
    }
  });
}

/** One block. With definitions to read by, it is lexed again behind them, and what they are is dropped. */
const Block = memo(function Block({ block, definitions, memoRows }) {
  if (definitions === '') return blocks([block.payload], memoRows);
  const kept = [];
  let offset = 0;
  for (const token of lex(`${definitions}${block.source}`)) {
    if (offset >= definitions.length) kept.push(token);
    offset += token.raw.length;
  }
  return blocks(kept, memoRows);
});

const makeBlocks = (memoRows) => memo(function Blocks({ text }) {
  const splitter = useRef(null);
  splitter.current ??= createSplitter(parseBlocks);
  return splitter.current.update(text).drawn.map(({ block, definitions }) => <Block key={block.key} block={block} definitions={definitions} memoRows={memoRows} />);
});
const Blocks = makeBlocks(false);
/** Block by block, and a table's rows each for their own text. */
const BlocksRows = makeBlocks(true);

/** The lexer over the whole text at every update: the simplest use of it. */
const Whole = memo(function Whole({ text }) {
  return blocks(lex(text));
});

export const MODES = { whole: Whole, blocks: Blocks, rows: BlocksRows };
export const parseOnly = (text) => lex(text);
