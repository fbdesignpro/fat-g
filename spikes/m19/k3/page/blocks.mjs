// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A growing text split into its top-level blocks without reading all of it again at every update
// (M19, C47, C51): both parsers of the spike draw "block by block" through this.
//
// `parse(input)` gives the input's top-level blocks in order, `[{ start, definition, payload }]`,
// offsets into `input`. Every block but the last is closed: no text that follows changes where it
// ends, so its source is kept and never parsed for its bounds again. Only the text from the open
// block's start on is parsed at an update.
//
// What can still change a closed block is a definition that arrives later (C61). Each block is
// given the source of the definitions its own text names, and of no other: a block that names none
// is drawn from what its bounds were found with, and a definition that arrives changes what is
// handed to the blocks that name it alone.
const labelOf = (source) => /^\s*\[([^\]]+)\]:/.exec(source)?.[1].trim().toLowerCase() ?? null;

export function createSplitter(parse) {
  let text = '';
  let closed = [];
  let closedEnd = 0;
  /** The closed definitions, in order: `{ label, source }`. */
  let definitions = [];
  const make = (key, source, found) => ({ key, source, definition: found.definition, payload: found.payload, lower: source.includes('[') ? source.toLowerCase() : null, needs: '', seen: 0 });
  return {
    /** `{ drawn: [{ block, definitions }], notes }` for `next`, the text so far: the last block is the open one. */
    update(next) {
      if (!next.startsWith(text)) { closed = []; closedEnd = 0; definitions = []; }
      text = next;
      const tail = text.slice(closedEnd);
      const found = parse(tail);
      for (let index = 0; index < found.length - 1; index += 1) {
        const block = make(closed.length, tail.slice(found[index].start, found[index + 1].start), found[index]);
        closed.push(block);
        const label = block.definition ? labelOf(block.source) : null;
        if (label !== null) definitions.push({ label, source: block.source.trimEnd() });
      }
      const last = found.at(-1);
      let open = null;
      if (last !== undefined) {
        if (found.length > 1) closedEnd += last.start;
        open = make(closed.length, text.slice(closedEnd), last);
      }
      const openLabel = open?.definition ? labelOf(open.source) : null;
      const openDefinition = openLabel === null ? null : { label: openLabel, source: open.source.trimEnd() };
      const drawn = (open === null ? closed : [...closed, open]).map((block) => {
        if (block.lower === null) return { block, definitions: '' };
        // Each closed definition is looked for once in each block.
        for (; block.seen < definitions.length; block.seen += 1) {
          const definition = definitions[block.seen];
          if (block.lower.includes(`[${definition.label}]`)) block.needs += `${definition.source}\n\n`;
        }
        const growing = openDefinition !== null && block !== open && block.lower.includes(`[${openDefinition.label}]`) ? `${openDefinition.source}\n\n` : '';
        return { block, definitions: block.needs + growing };
      });
      const notes = [...definitions, ...(openDefinition === null ? [] : [openDefinition])].filter((definition) => definition.label.startsWith('^')).map((definition) => definition.source).join('\n\n');
      return { drawn, notes };
    },
  };
}

const SEPARATOR = '\u0000';

/**
 * The footnotes a text refers to, in the order of their first reference, joined: what numbers them
 * across blocks. Only a note that `notes`, the notes' own source, defines is one.
 */
export function noteOrder(text, notes) {
  if (notes === '') return '';
  const defined = new Set();
  for (const match of notes.matchAll(/^\[\^([^\]\s]+)\]:/gm)) defined.add(match[1].toLowerCase());
  const order = [];
  for (const match of text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
    const id = match[1].toLowerCase();
    if (defined.has(id) && !order.includes(id)) order.push(id);
  }
  return order.join(SEPARATOR);
}

export const noteNumber = (order, id) => order.split(SEPARATOR).indexOf(String(id).toLowerCase()) + 1;
export const noteIds = (order) => (order === '' ? [] : order.split(SEPARATOR));
