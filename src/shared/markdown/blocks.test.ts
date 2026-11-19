// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12, V28 (docs/planning/_archive/M19.md; C61, C62, C65–C67): a parsed text as blocks, and what a block's
// drawing is cached by — its source and what it names. Pure: no parser and no DOM here; the same
// rules on the real lexer's tokens are in src/renderer/src/markdown/.
import { describe, expect, it } from 'vitest';
import { namedLabels, type Named, normalizeLabel, sameSource, signatureOf, type SourceToken, toBlocks } from './blocks';
import { nextNoteReference, NOTE_DEFINITION, NOTE_REFERENCE, noteLabel, noteText, numberNotes } from './notes';

const token = (type: string, raw: string): SourceToken => ({ type, raw });
const named = (links: Named['links'] = {}, notes: [string, number][] = []): Named => ({ links, notes: new Map(notes) });

describe('a text’s blocks (C65)', () => {
  it('are its top-level tokens in order, each with its place and its source', () => {
    const blocks = toBlocks([token('heading', '# Title\n'), token('paragraph', 'One.'), token('code', '```\nx\n```')]);
    expect(blocks.map((block) => [block.index, block.token.type, block.source])).toEqual([[0, 'heading', '# Title\n'], [1, 'paragraph', 'One.'], [2, 'code', '```\nx\n```']]);
  });

  it('give blank lines to the block before them, and those before the first block to it', () => {
    const blocks = toBlocks([token('space', '\n\n'), token('paragraph', 'One.'), token('space', '\n\n'), token('space', '\n'), token('paragraph', 'Two.'), token('space', '\n')]);
    expect(blocks.map((block) => block.source)).toEqual(['\n\nOne.\n\n\n', 'Two.\n']);
    // Put together, the sources are the text: nothing of it is in no block.
    expect(blocks.map((block) => block.source).join('')).toBe('\n\nOne.\n\n\nTwo.\n');
    expect(toBlocks([token('space', '\n')])).toEqual([]);
    expect(toBlocks([])).toEqual([]);
  });

  it('keep a definition as a block of its own: it draws nothing, and its source is still the text’s', () => {
    const blocks = toBlocks([token('paragraph', 'See [guide].'), token('space', '\n\n'), token('def', '[guide]: /docs')]);
    expect(blocks.map((block) => block.token.type)).toEqual(['paragraph', 'def']);
  });
});

describe('what a block names (C61, C67)', () => {
  it('is what its square brackets hold, normalized, each once, in order', () => {
    expect(namedLabels('See [the Guide][guide] and [Guide], and ![a  cat][Cat Pic]; a note[^why].')).toEqual(['the guide', 'guide', 'a cat', 'cat pic', '^why']);
    expect(namedLabels('[text](https://example.test) and [x][]')).toEqual(['text', 'x']);
  });

  it('is nothing for a source with no bracket, an empty pair, or a label past 999 characters', () => {
    expect(namedLabels('Plain text, with (parentheses) and {braces}.')).toEqual([]);
    expect(namedLabels('[] and [   ]')).toEqual([]);
    expect(namedLabels(`[${'x'.repeat(1000)}]`)).toEqual([]);
    expect(namedLabels(`[${'x'.repeat(999)}]`)).toHaveLength(1);
  });

  it('reads the innermost pair of nested brackets, and an escaped bracket as part of a label', () => {
    expect(namedLabels('[![alt](a.png)][target]')).toEqual(['alt', 'target']);
    expect(namedLabels('[a \\] b]')).toEqual(['a \\] b']);
  });

  it('matches labels without case and with their white space collapsed', () => {
    expect(normalizeLabel('  The\n  GUIDE ')).toBe('the guide');
    expect(noteLabel('Why')).toBe('why');
  });
});

describe('a block’s signature (C65–C67)', () => {
  it('is its source alone while it names nothing that is defined', () => {
    const source = 'See [guide] and a note[^why].';
    expect(signatureOf(source, named())).toBe(source);
    expect(signatureOf('No brackets here.', named({ guide: { href: '/docs' } }))).toBe('No brackets here.');
  });

  it('changes when a definition it names arrives, changes again when that definition changes, and for no other', () => {
    const source = '| a | [guide] |';
    const before = signatureOf(source, named());
    const defined = signatureOf(source, named({ guide: { href: '/docs' } }));
    expect(defined).not.toBe(before);
    expect(signatureOf(source, named({ guide: { href: '/docs', title: 'Title' } }))).not.toBe(defined);
    expect(signatureOf(source, named({ guide: { href: '/other' } }))).not.toBe(defined);
    // A definition of a label it does not name leaves it as it was.
    expect(signatureOf(source, named({ other: { href: '/x' } }))).toBe(before);
    expect(signatureOf(source, named({ guide: { href: '/docs' }, other: { href: '/x' } }))).toBe(defined);
  });

  it('changes with a note’s number, so a note numbered again draws its marks again', () => {
    const source = 'The tide varies[^why].';
    const one = signatureOf(source, named({}, [['why', 1]]));
    expect(one).not.toBe(source);
    expect(signatureOf(source, named({}, [['why', 2]]))).not.toBe(one);
    expect(signatureOf(source, named({}, [['other', 1]]))).toBe(source);
  });

  it('never takes a property every object has for a definition', () => {
    for (const source of ['[constructor]', '[toString]', '[__proto__]', '[hasOwnProperty]']) expect(signatureOf(source, named()), source).toBe(source);
  });

  it('tells a change of what is named from a change of the source itself', () => {
    const source = 'See [guide].';
    const before = signatureOf(source, named());
    const after = signatureOf(source, named({ guide: { href: '/docs' } }));
    expect(sameSource(before, after)).toBe(true);
    expect(sameSource(after, signatureOf(`${source} More.`, named({ guide: { href: '/docs' } })))).toBe(false);
    expect(sameSource(before, before)).toBe(true);
  });
});

describe('notes (C61)', () => {
  it('reads a definition at the start of a block: its label, and its text to the next blank line or the next definition', () => {
    const one = NOTE_DEFINITION.exec('[^why]: Because it is so.\n\nNext paragraph.');
    expect([one?.[0], one?.[1], one?.[2]]).toEqual(['[^why]: Because it is so.\n\n', 'why', 'Because it is so.']);
    const lines = NOTE_DEFINITION.exec('[^a]: First line\n    and a second.\n[^b]: Another.');
    expect([lines?.[1], lines?.[2]]).toEqual(['a', 'First line\n    and a second.']);
    expect(noteText(lines?.[2] ?? '')).toBe('First line and a second.');
    // A one-word note, which a link reference definition would otherwise claim.
    expect(NOTE_DEFINITION.exec('[^a]: Done')?.[2]).toBe('Done');
  });

  it('reads no definition in what is none: a link’s definition, a reference, a label with a space, a line in the middle of a paragraph', () => {
    for (const source of ['[a]: /url', '[^a] is a reference', '[^a b]: text', 'text [^a]: text', '    [^a]: indented as code']) expect(NOTE_DEFINITION.exec(source), source).toBeNull();
  });

  it('reads a reference where a line stands at one, and says where the next could start', () => {
    expect(NOTE_REFERENCE.exec('[^why] and more')?.[1]).toBe('why');
    expect(NOTE_REFERENCE.exec('text [^why]')).toBeNull();
    expect(NOTE_REFERENCE.exec('[^]')).toBeNull();
    expect(nextNoteReference('The tide varies[^why].')).toBe(15);
    expect(nextNoteReference('No note here.')).toBe(-1);
  });

  it('numbers the notes in the order they are first referred to, and only those that are defined', () => {
    const numbers = numberNotes(['b', 'a', 'b', 'missing', 'c', 'a'], new Set(['a', 'b', 'c', 'unreferenced']));
    expect([...numbers]).toEqual([['b', 1], ['a', 2], ['c', 3]]);
    expect(numberNotes([], new Set(['a'])).size).toBe(0);
  });

  it('numbers a note again when an earlier reference gains its definition', () => {
    const before = numberNotes(['x', 'a'], new Set(['a']));
    const after = numberNotes(['x', 'a'], new Set(['a', 'x']));
    expect(before.get('a')).toBe(1);
    expect([after.get('x'), after.get('a')]).toEqual([1, 2]);
  });
});

// M19b (V10; C41): each block's first and last line, counted over the sources.
describe('a block’s lines (M19b, C41)', () => {
  const lines = (tokens: SourceToken[]) => toBlocks(tokens).map((block) => [block.firstLine, block.lastLine]);

  it('are the lines its source starts and ends on, from 1, its blank lines its own', () => {
    // # A / (blank) / Para / (blank) / (blank) / - one / - two
    expect(lines([token('heading', '# A\n\n'), token('paragraph', 'Para\n'), token('space', '\n\n'), token('list', '- one\n- two')])).toEqual([[1, 2], [3, 5], [6, 7]]);
  });

  it('give the blank lines before the first block to it', () => {
    expect(lines([token('space', '\n\n'), token('paragraph', 'One.'), token('space', '\n\n'), token('paragraph', 'Two.\n')])).toEqual([[1, 4], [5, 5]]);
  });

  it('count a block of several lines, and one with no line break at its end', () => {
    expect(lines([token('code', '```\na\nb\n```\n'), token('paragraph', 'last')])).toEqual([[1, 4], [5, 5]]);
    expect(lines([token('paragraph', 'only')])).toEqual([[1, 1]]);
  });

  it('shift every later block when an earlier one gains a line, each source as it was', () => {
    const before = toBlocks([token('paragraph', 'one\n\n'), token('paragraph', 'two\n\n'), token('paragraph', 'three')]);
    const after = toBlocks([token('paragraph', 'one\nand more\n\n'), token('paragraph', 'two\n\n'), token('paragraph', 'three')]);
    expect(before.map((block) => block.firstLine)).toEqual([1, 3, 5]);
    expect(after.map((block) => block.firstLine)).toEqual([1, 4, 6]);
    expect(after.slice(1).map((block) => block.source)).toEqual(before.slice(1).map((block) => block.source));
  });
});
