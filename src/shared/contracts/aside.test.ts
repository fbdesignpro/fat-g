// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V21 (docs/planning/_archive/M20b.md; C8, C24, C29, C36, C50–C52, C75): an aside's shapes, its bounds
// and fat-g's own words — the source a selection reports, what makes two selections the same, the
// title, the seed question, and what a provider's side thread is told.
import { describe, expect, it } from 'vitest';
import {
  ASIDE_INSTRUCTIONS, ASIDE_SOURCE_KINDS, type AsideCapability, type AsideSource, AsideSourceRefSchema, AsideSourceSchema, asideTitle, capabilityWords, cutExcerpt, DIGEST, drawnDigest,
  MAX_ASIDE_TITLE, MAX_EXCERPT, NEW_ASIDE_TITLE, samePlace, sameSelection, seedQuestion, sourcePhrase, sourceRef, withEarlier,
} from './aside';

const MESSAGE: AsideSource = { kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 12, end: 40 }, digest: '0badc0de', excerpt: 'The tide table lists high water.', cut: false };
const ACTIVITY: AsideSource = { ...MESSAGE, kind: 'activity', role: null, part: 'output', lines: null };
const FILE: AsideSource = { ...MESSAGE, kind: 'file', itemId: null, role: null, path: 'C:\\work\\tide-tools\\README.md', lines: { first: 3, last: 3 } };
/** A passage of a plan's tab (M22b, C26): the plan by its id, and the version it was drawn from. */
const PLAN = { ...FILE, kind: 'plan' as const, itemId: 'a1b2c3d4-0000-4000-8000-000000000001', path: null, version: 2 };

describe('the capability (C24)', () => {
  it('has three forms: none, an answer from the conversation alone, and one that may read — streamed or whole', () => {
    const forms: AsideCapability[] = ['none', { followUp: true, streamed: false, tools: 'none' }, { followUp: true, streamed: true, tools: 'read-only' }];
    expect(forms.map(capabilityWords)).toEqual(['', 'Answers from the conversation and reads nothing.', 'May read files and run listings; changes nothing.']);
    // Each provider's own form is its descriptor's: tests/sessions/facet-contract.test.ts holds them.
  });
});

describe('a source (C29, C45, C75)', () => {
  it('is one of four kinds, each with the fields that are its own: a plan’s since M22b (C26)', () => {
    expect([...ASIDE_SOURCE_KINDS]).toEqual(['message', 'activity', 'file', 'plan']);
    for (const source of [MESSAGE, { ...MESSAGE, role: 'user' as const, lines: null }, { ...MESSAGE, workerId: 'worker-1' }, ACTIVITY, { ...ACTIVITY, part: 'input' as const }, FILE, { ...FILE, lines: null }, PLAN]) {
      expect(AsideSourceSchema.safeParse(source).success, JSON.stringify(source).slice(0, 90)).toBe(true);
      expect(AsideSourceRefSchema.safeParse(sourceRef(source)).success).toBe(true);
    }
  });

  it('refuses a kind with another’s fields, an unknown kind, and an unknown field', () => {
    const refused: unknown[] = [
      { ...MESSAGE, role: null }, { ...MESSAGE, itemId: null }, { ...MESSAGE, part: 'output' }, { ...MESSAGE, path: 'C:\\a.txt' },
      { ...ACTIVITY, part: null }, { ...ACTIVITY, role: 'assistant' }, { ...ACTIVITY, itemId: null },
      { ...FILE, path: null }, { ...FILE, itemId: 'item-1' }, { ...FILE, role: 'assistant' }, { ...FILE, workerId: 'worker-1' },
      { ...MESSAGE, kind: 'plan' }, { ...MESSAGE, frame: {} }, { ...MESSAGE, sessionId: 'x' },
      { ...PLAN, version: null }, { ...PLAN, itemId: null }, { ...PLAN, path: 'C:\\a.md' }, { ...PLAN, role: 'assistant' }, { ...MESSAGE, version: 2 }, { ...FILE, version: 1 },
    ];
    for (const source of refused) expect(AsideSourceSchema.safeParse(source).success, JSON.stringify(source).slice(0, 110)).toBe(false);
  });

  it('bounds its excerpt, its lines, its offsets and its digest', () => {
    const ok = (patch: object): boolean => AsideSourceSchema.safeParse({ ...MESSAGE, ...patch }).success;
    expect(ok({ excerpt: 'x'.repeat(MAX_EXCERPT) })).toBe(true);
    expect(ok({ excerpt: 'x'.repeat(MAX_EXCERPT + 1) })).toBe(false);
    expect(ok({ excerpt: '' })).toBe(false);
    expect(ok({ lines: { first: 5, last: 3 } })).toBe(false);
    expect(ok({ lines: { first: 0, last: 3 } })).toBe(false);
    expect(ok({ lines: { first: 1.5, last: 3 } })).toBe(false);
    expect(ok({ range: { start: 40, end: 12 } })).toBe(false);
    expect(ok({ range: { start: -1, end: 12 } })).toBe(false);
    expect(ok({ range: { start: 0, end: 0 } })).toBe(true);
    for (const digest of ['0BADC0DE', '0badc0d', '0badc0dee', 'zzzzzzzz', '']) expect(ok({ digest }), digest).toBe(false);
    expect(ok({ itemId: 'a\nb' })).toBe(false);
    expect(ok({ itemId: 'x'.repeat(129) })).toBe(false);
    // A place is required: the highlight is painted from it and from nothing else (C75).
    const { range: _range, ...noRange } = MESSAGE;
    const { digest: _digest, ...noDigest } = MESSAGE;
    expect(AsideSourceSchema.safeParse(noRange).success).toBe(false);
    expect(AsideSourceSchema.safeParse(noDigest).success).toBe(false);
  });

  it('is cut at 20,000 units with its flag, never between the halves of a pair', () => {
    expect(MAX_EXCERPT).toBe(20_000);
    expect(cutExcerpt('short')).toEqual({ excerpt: 'short', cut: false });
    expect(cutExcerpt('x'.repeat(MAX_EXCERPT))).toEqual({ excerpt: 'x'.repeat(MAX_EXCERPT), cut: false });
    const long = cutExcerpt('x'.repeat(MAX_EXCERPT + 1));
    expect([long.excerpt.length, long.cut]).toEqual([MAX_EXCERPT, true]);
    // A pair that straddles the bound is left out whole.
    const paired = cutExcerpt(`${'x'.repeat(MAX_EXCERPT - 1)}😀 more`);
    expect(paired.cut).toBe(true);
    expect(paired.excerpt).toBe('x'.repeat(MAX_EXCERPT - 1));
  });

  it('is carried without its text as a marker’s: the place, the offsets and the digest, and no excerpt (C30, C75)', () => {
    const ref = sourceRef(MESSAGE);
    expect(ref).toEqual({ kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 12, end: 40 }, digest: '0badc0de' });
    expect(JSON.stringify(ref)).not.toContain('tide table');
    // The marker's schema takes no text at all.
    expect(AsideSourceRefSchema.safeParse(MESSAGE).success).toBe(false);
  });
});

describe('the digest of a drawn text (C75)', () => {
  it('is FNV-1a over the text’s UTF-16 units, as eight hex digits', () => {
    // The published test vectors of the 32-bit FNV-1a, for one-byte units.
    expect(drawnDigest('')).toBe('811c9dc5');
    expect(drawnDigest('a')).toBe('e40c292c');
    expect(drawnDigest('foobar')).toBe('bf9cf968');
    for (const text of ['', 'a', 'The tide table.', '😀', 'x'.repeat(5000)]) expect(drawnDigest(text)).toMatch(DIGEST);
  });

  it('differs for a text that changed by one unit, and for the same units in another order', () => {
    const digests = ['The tide turns at noon.', 'The tide turns at noon', 'The tide turned at noon.', 'the tide turns at noon.', 'noon at turns tide The.'].map(drawnDigest);
    expect(new Set(digests).size).toBe(digests.length);
    expect(drawnDigest('The tide turns at noon.')).toBe(digests[0]);
  });
});

describe('the same selection again (C50, C75)', () => {
  const again = (patch: Partial<AsideSource>): AsideSource => ({ ...MESSAGE, ...patch });

  it.each([
    ['the same source, lines and text', again({}), true],
    ['the same, drawn at another place: its offsets and digest are no part of it', again({ range: { start: 400, end: 428 }, digest: 'ffffffff' }), true],
    ['the same, with its cut flag otherwise', again({ cut: true }), true],
    ['another range of the same lines: another sentence of the paragraph', again({ excerpt: 'It is read each morning.' }), false],
    ['the same lines whose text has changed since', again({ excerpt: 'The tide table lists low water.' }), false],
    ['other lines with the same text', again({ lines: { first: 9, last: 11 } }), false],
    ['no lines where there were some', again({ lines: null }), false],
    ['another item', again({ itemId: 'item-2' }), false],
    ['an activity’s output with the same text', { ...ACTIVITY, excerpt: MESSAGE.excerpt }, false],
    ['a file with the same text and lines', { ...FILE, lines: MESSAGE.lines }, false],
  ] as const)('%s', (_name, other, same) => {
    expect(sameSelection(MESSAGE, other)).toBe(same);
    expect(sameSelection(other, MESSAGE)).toBe(same);
  });

  it('tells an activity’s input from its output, one file from another, and the same place by its place alone', () => {
    expect(sameSelection(ACTIVITY, { ...ACTIVITY, part: 'input' })).toBe(false);
    expect(sameSelection(FILE, { ...FILE, path: 'C:\\work\\tide-tools\\NOTES.md' })).toBe(false);
    expect(sameSelection(FILE, { ...FILE })).toBe(true);
    const reworded: AsideSource = { ...MESSAGE, excerpt: 'anything else' };
    expect(samePlace(MESSAGE, reworded)).toBe(true);
    expect(samePlace(MESSAGE, { ...MESSAGE, lines: { first: 3, last: 6 } })).toBe(false);
  });
});

describe('a title (C36)', () => {
  it('is "Explained: " and the first line that holds anything of the excerpt, or the first such line of a free question, cut to 60 units', () => {
    expect(MAX_ASIDE_TITLE).toBe(60);
    expect(asideTitle(MESSAGE, 'ignored')).toBe('Explained: The tide table lists high water.');
    expect(asideTitle({ excerpt: '\n\n   \n  The second line holds it.  \nAnd a third.' }, '')).toBe('Explained: The second line holds it.');
    // A question asked freely is titled by itself: nothing was explained.
    expect(asideTitle(null, 'Why is the sea salty?\nIn one line.')).toBe('Why is the sea salty?');
    // The bound holds the whole title, the word before the excerpt with it.
    const explained = asideTitle({ excerpt: 'x'.repeat(200) }, '');
    expect(explained).toHaveLength(MAX_ASIDE_TITLE);
    expect(explained.startsWith('Explained: x')).toBe(true);
    const long = asideTitle(null, 'x'.repeat(200));
    expect(long).toHaveLength(MAX_ASIDE_TITLE);
    // Cut between words, it ends in no space.
    expect(asideTitle(null, `${'word '.repeat(11)}word and more`)).toBe(`${'word '.repeat(11)}word`.trimEnd());
    expect(asideTitle(null, `${'word '.repeat(12)}and more`).endsWith(' ')).toBe(false);
  });

  it('is "New aside" where neither holds anything', () => {
    expect(NEW_ASIDE_TITLE).toBe('New aside');
    expect(asideTitle(null, '')).toBe(NEW_ASIDE_TITLE);
    expect(asideTitle(null, '  \n \t ')).toBe(NEW_ASIDE_TITLE);
    expect(asideTitle({ excerpt: ' \n ' }, 'ignored')).toBe(NEW_ASIDE_TITLE);
  });
});

describe('fat-g’s words (C51, C52)', () => {
  it('names where a passage came from in the words the sheet has', () => {
    expect(sourcePhrase(MESSAGE, null)).toBe('your earlier answer');
    expect(sourcePhrase({ ...MESSAGE, role: 'user' }, null)).toBe('my earlier message');
    expect(sourcePhrase(ACTIVITY, null)).toBe('the output of an action in this conversation');
    expect(sourcePhrase({ ...ACTIVITY, part: 'input' }, null)).toBe('the input of an action in this conversation');
    expect(sourcePhrase(FILE, 'README.md')).toBe('the file README.md, lines 3–3');
    expect(sourcePhrase({ ...FILE, lines: { first: 12, last: 20 } }, 'src/tides.js')).toBe('the file src/tides.js, lines 12–20');
    expect(sourcePhrase({ ...FILE, lines: null }, 'README.md')).toBe('the file README.md');
  });

  it('writes the seed question exactly: where the passage came from, the passage with each line quoted between blank lines, and the ask', () => {
    expect(seedQuestion('your earlier answer', 'One line.')).toBe(
      'This is a question beside the conversation, about a passage in your earlier answer. Answer it briefly from what the conversation already holds, and take no action.\n\n> One line.\n\nExplain this passage.',
    );
    // Several lines, an empty one among them, each quoted; a line break of either kind ends a line.
    expect(seedQuestion('the file README.md, lines 3–6', 'first\n\nthird\r\nfourth')).toBe(
      'This is a question beside the conversation, about a passage in the file README.md, lines 3–6. Answer it briefly from what the conversation already holds, and take no action.\n\n> first\n>\n> third\n> fourth\n\nExplain this passage.',
    );
  });

  it('tells a provider’s side thread to answer briefly and act on nothing, in the words the sheet has', () => {
    expect(ASIDE_INSTRUCTIONS).toBe('You are answering a question asked beside a conversation, not continuing it. Answer briefly from what the conversation already holds. Take no action: run no command and change no file. Reading a file to answer is acceptable.');
  });

  it('puts an aside’s earlier exchanges before a follow-up, each pair in order, and nothing before a first question', () => {
    expect(withEarlier([], 'A first question?')).toBe('A first question?');
    expect(withEarlier([{ question: 'One?', response: 'First.' }, { question: 'Two?', response: 'Second.' }], 'Three?')).toBe(
      'Earlier in this side conversation, I asked:\n\nOne?\n\nAnd you answered:\n\nFirst.\n\nEarlier in this side conversation, I asked:\n\nTwo?\n\nAnd you answered:\n\nSecond.\n\nThree?',
    );
  });
});
