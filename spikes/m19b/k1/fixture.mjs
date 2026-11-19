// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The files K1 shows (M19b's sheet; C29, C38): Markdown texts of 100,000, 250,000, 500,000 and
// 1,000,000 units made of the kinds M19's fixture has (spikes/m19/k3/fixture.mjs; M19, C52), and
// plain texts of 1 and 2 MiB with long lines. Generated identically each time: nothing here is
// random. Plain JavaScript, so the page and Node both run it.
import { BOUND, largeMessage, mixed } from '../../m19/k3/fixture.mjs';

export const MARKDOWN_UNITS = [100_000, 250_000, 500_000, 1_000_000];
export const MIB = 1024 * 1024;
/** The lengths of a text that is one line, to the bound. */
export const ONE_LINE_UNITS = [50_000, 100_000, 250_000, 500_000, MIB, 2 * MIB];

/** A Markdown file of `units` units. The 100,000-unit one is M19's static message, so its numbers stand beside K3's. */
export function markdown(units) {
  return units === BOUND ? largeMessage() : mixed(19_000_000 + units, units);
}

/** mulberry32, as M19's fixture has it: the same numbers for the same seed, on every engine. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'tide table door kettle logbook drawer bulbs shelf lighthouse keeper lamp harbour master gate ferry island bell bakery bread quay value count index result buffer offset length handler reader writer session record'.split(' ');

/** How long a long line is, how often one comes, and the one line that is longer than any other. */
export const LONG_LINE = 2_000;
export const LONG_EVERY = 40;
export const LONGEST_LINE = 20_000;

/**
 * A plain text of `bytes` bytes (ASCII, so as many units): lines as a source file has them, 20 to
 * 160 units, every fortieth one 2,000 units long — a line of data, a minified line — and one line
 * of 20,000 units a third of the way down.
 */
export function plain(bytes) {
  const next = generator(29_000_000 + bytes);
  const pick = () => WORDS[Math.floor(next() * WORDS.length)];
  const fill = (length) => { let line = ''; while (line.length < length) line += `${pick()} `; return line.slice(0, length); };
  const lines = [];
  let length = 0;
  let longest = false;
  for (let n = 1; length < bytes; n += 1) {
    let line;
    if (!longest && length > bytes / 3) { line = `const table${n} = "${fill(LONGEST_LINE - 20)}";`; longest = true; }
    else if (n % LONG_EVERY === 0) line = `const data${n} = [${fill(LONG_LINE - 20)}];`;
    else if (n % 7 === 0) line = '';
    else line = `${'  '.repeat(Math.floor(next() * 4))}${n % 5 === 0 ? '// ' : ''}const ${pick()}${n} = ${pick()}(${Math.floor(next() * 9999)}, '${fill(Math.floor(next() * 110))}');`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n').slice(0, bytes);
}

/** The same size with no line break at all: a minified file, the worst a text within the bound can be. */
export function oneLine(bytes) {
  const next = generator(39_000_000 + bytes);
  const pick = () => WORDS[Math.floor(next() * WORDS.length)];
  const parts = [];
  let length = 1;
  for (let n = 1; length < bytes; n += 1) {
    const part = `"${pick()}${n}":{"${pick()}":${Math.floor(next() * 99999)},"${pick()}":"${pick()} ${pick()}"}`;
    parts.push(part);
    length += part.length + 1;
  }
  return `{${parts.join(',')}`.slice(0, bytes - 1) + '}';
}

/** The cases, by name: what each shows and how it is drawn. */
export const CASES = {
  ...Object.fromEntries(MARKDOWN_UNITS.map((units) => [`md-${units}`, { kind: 'markdown', ways: ['markdown'], text: () => markdown(units) }])),
  'plain-1mib': { kind: 'plain', ways: ['pre', 'lines'], text: () => plain(MIB) },
  'plain-2mib': { kind: 'plain', ways: ['pre', 'lines'], text: () => plain(2 * MIB) },
};

/**
 * Beyond what the sheet's K1 names: a minified file is a text within the bound too. One line of
 * each length, drawn unwrapped (C53) and, beside it, wrapped; the sideways scroll is cut short, a
 * line of 2 MiB being millions of pixels wide. Run by name (`--cases`), never with the sheet's.
 */
export const ONE_LINE_CASES = Object.fromEntries(ONE_LINE_UNITS.map((units) => [`line-${units}`, { kind: 'plain', ways: ['pre', 'wrapped'], scrollFrames: 240, text: () => oneLine(units) }]));

/**
 * For C54 as the maintainer settled it: the sheet's two plain texts, which have lines past its
 * 1,000 units, drawn with every line wrapped. Run by name, as the one-line texts are.
 */
export const WRAPPED_CASES = {
  'wrapped-1mib': { kind: 'plain', ways: ['wrapped', 'lines-wrapped'], text: () => plain(MIB) },
  'wrapped-2mib': { kind: 'plain', ways: ['wrapped', 'lines-wrapped'], text: () => plain(2 * MIB) },
};

/**
 * C54 as it stands: a line wraps at 2,000 px. The sheet's two plain texts and the two longest
 * one-line texts, drawn so. Run by name.
 */
export const CAPPED_CASES = {
  'capped-1mib': { kind: 'plain', ways: ['capped', 'lines-capped'], text: () => plain(MIB) },
  'capped-2mib': { kind: 'plain', ways: ['capped', 'lines-capped'], text: () => plain(2 * MIB) },
  'capped-line-1mib': { kind: 'plain', ways: ['capped'], text: () => oneLine(MIB) },
  'capped-line-2mib': { kind: 'plain', ways: ['capped'], text: () => oneLine(2 * MIB) },
};

export const ALL_CASES = { ...CASES, ...ONE_LINE_CASES, ...WRAPPED_CASES, ...CAPPED_CASES };
