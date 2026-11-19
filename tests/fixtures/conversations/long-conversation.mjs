// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The long-conversation fixture of M19's sheet (C52), generated identically each time: 2,000 turns
// with every kind of Markdown C29 names, a static message at the 100,000-unit bound, a deeply nested
// one, and three streams — a mixed answer of 20,000 units, one fenced code block growing to 100,000
// units, and one table growing to that bound. Plain JavaScript with no import, so the page and Node
// both run it. Nothing here is random: every choice comes from a counter-seeded generator.

/** A message's bound, in UTF-16 units (M15, C113). */
export const BOUND = 100_000;
export const TURNS = 2_000;
export const MIXED_UNITS = 20_000;
export const NESTING = 40;

/** mulberry32: the same numbers for the same seed, on every engine. */
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

const WORDS = 'the tide table is pinned by a door and kettle whistles twice before it boils while logbook stays in blue drawer with spare bulbs on top shelf where lighthouse keeper feeds cat near warm lamp housing as harbour master walks dog past east gate when ferry leaves island at seven under green bell so bakery sells rye bread until nine'.split(' ');

function tools(seed) {
  const next = generator(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const count = (low, high) => low + Math.floor(next() * (high - low + 1));
  const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const sentence = (n = count(6, 16)) => { const text = words(n); return `${text[0].toUpperCase()}${text.slice(1)}.`; };
  return { next, pick, count, words, sentence };
}

/** One block of each kind C29 names. `n` numbers what must be unique in a message: labels of definitions. */
const BLOCKS = [
  (t) => `${'#'.repeat(t.count(1, 4))} ${t.sentence(t.count(2, 6)).slice(0, -1)}`,
  (t) => `${t.sentence()} ${t.sentence()} This has *emphasis*, **strong text**, \`inline code\` and ~~struck words~~. ${t.sentence()}`,
  (t) => Array.from({ length: t.count(2, 6) }, () => `- ${t.sentence(t.count(3, 9))}`).join('\n'),
  (t) => Array.from({ length: t.count(2, 5) }, (_, i) => `${i + 1}. ${t.sentence(t.count(3, 9))}`).join('\n'),
  (t) => Array.from({ length: t.count(2, 4) }, (_, i) => `- [${i % 2 === 0 ? 'x' : ' '}] ${t.sentence(t.count(3, 7))}`).join('\n'),
  (t) => `> ${t.sentence()}\n> ${t.sentence()}`,
  () => '---',
  (t) => {
    const rows = t.count(2, 5);
    return ['| Name | Count | Note |', '| :--- | ---: | :---: |', ...Array.from({ length: rows }, (_, i) => `| ${t.words(2)} | ${t.count(1, 999)} | ${t.words(3)} ${i} |`)].join('\n');
  },
  (t) => ['```js', ...Array.from({ length: t.count(2, 8) }, (_, i) => `const value${i} = compute(${t.count(1, 99)}, '${t.words(2)}');`), '```'].join('\n'),
  (t) => Array.from({ length: t.count(2, 4) }, (_, i) => `    indented line ${i}: ${t.words(4)}`).join('\n'),
  (t) => `${t.sentence()} See [the ${t.words(2)}](https://example.com/${t.count(1, 999)}) or https://example.org/docs/${t.count(1, 999)} for more.`,
  (t, n) => `${t.sentence()} Read [the guide][ref-${n}] first.\n\n[ref-${n}]: https://example.com/guide/${n} "Guide ${n}"`,
  (t, n) => `${t.sentence()} The tide varies[^note-${n}] with the season.\n\n[^note-${n}]: ${t.sentence()}`,
  (t) => `- ${t.sentence(5)}\n  - ${t.sentence(5)}\n    - ${t.sentence(5)}\n  - ${t.sentence(5)}\n- ${t.sentence(5)}`,
  (t) => `${t.sentence()} An image: ![${t.words(2)}](https://example.com/${t.count(1, 99)}.png) and <b>raw html</b>.`,
];

/** A message of mixed Markdown, `units` long at least before it is cut to that length. */
function mixed(seed, units, { cut = true } = {}) {
  const t = tools(seed);
  const parts = [];
  let length = 0;
  for (let n = 1; length < units; n += 1) {
    // The first fifteen blocks are one of each kind, in order; after them, any.
    const block = (n <= BLOCKS.length ? BLOCKS[n - 1] : t.pick(BLOCKS))(t, n);
    parts.push(block);
    length += block.length + 2;
  }
  const text = parts.join('\n\n');
  return cut ? text.slice(0, units) : text;
}

/** One turn: a prompt as it was typed, and an answer of 300 to 3,000 units. */
export function turn(n) {
  const t = tools(1_000_003 * n + 17);
  const prompt = `Question ${n}: ${t.sentence(t.count(4, 14))} Look at src/notes_${n}.txt and tell me what *it* says about ${t.words(2)}.`;
  const size = t.count(300, 3_000);
  // Short answers are a few blocks of any kind; the kinds are all met many times over 2,000 turns.
  const u = tools(7_000_003 * n + 5);
  const parts = [];
  let length = 0;
  for (let k = 1; length < size; k += 1) {
    const block = u.pick(BLOCKS)(u, k);
    parts.push(block);
    length += block.length + 2;
  }
  return { prompt, answer: parts.join('\n\n') };
}

/** The items of the newest `turns` turns, oldest first: a prompt, then its answer. */
export function items(turns, total = TURNS) {
  const out = [];
  for (let n = total - turns + 1; n <= total; n += 1) {
    const { prompt, answer } = turn(n);
    out.push({ id: `u${n}`, role: 'user', text: prompt });
    out.push({ id: `a${n}`, role: 'assistant', text: answer });
  }
  return out;
}

/** The static message at the bound. */
export const largeMessage = () => mixed(424_243, BOUND);

/** Lists and quotes, each nested `NESTING` deep, and a list inside the innermost quote. */
export function nestedMessage(depth = NESTING) {
  const list = Array.from({ length: depth }, (_, i) => `${'  '.repeat(i)}- level ${i + 1} of the nested list`).join('\n');
  const quote = Array.from({ length: depth }, (_, i) => `${'> '.repeat(i + 1)}level ${i + 1} of the nested quote`).join('\n');
  const inner = `${'> '.repeat(depth)}- a list\n${'> '.repeat(depth)}- inside the innermost quote, with \`code\` and **strong text**`;
  return `# Deeply nested\n\n${list}\n\n${quote}\n${inner}\n\nA closing paragraph.`;
}

/** The three streams, each the whole text an answer grows to. */
export function streamText(kind) {
  if (kind === 'mixed') return mixed(909_091, MIXED_UNITS);
  if (kind === 'fence') {
    const t = tools(515_151);
    const lines = ['Here is the whole file:', '', '```js'];
    let length = lines.join('\n').length;
    for (let n = 1; length < BOUND; n += 1) {
      const line = n % 9 === 0 ? `  // ${t.sentence()}` : n % 4 === 0 ? `  if (value${n} > ${t.count(1, 999)}) { report('${t.words(3)}', value${n}); }` : `  const value${n} = compute(${t.count(1, 9999)}, '${t.words(2)}', { retry: ${n % 3 === 0}, label: \`row ${n}\` });`;
      lines.push(line);
      length += line.length + 1;
    }
    // The fence closes with the text's last units: until then it is a code block to the end (C36).
    return `${lines.join('\n').slice(0, BOUND - 4)}\n\`\`\``;
  }
  if (kind === 'table') {
    const t = tools(616_161);
    const lines = ['The measurements, row by row:', '', '| # | Station | Reading | Note |', '| ---: | :--- | ---: | :--- |'];
    let length = lines.join('\n').length;
    for (let n = 1; length < BOUND; n += 1) {
      const line = `| ${n} | ${t.words(2)} | ${t.count(1, 99999)} | ${t.words(t.count(2, 5))} with \`code ${n}\` |`;
      lines.push(line);
      length += line.length + 1;
    }
    return lines.join('\n').slice(0, BOUND);
  }
  throw new Error(`unknown stream ${kind}`);
}

export const STREAMS = ['mixed', 'fence', 'table'];

/** What C61 and C31 to C33 ask about: small texts whose drawing is recorded, not timed. */
export const PROBES = {
  bareUrl: 'See https://example.com/docs and www.example.org for more, or write to someone@example.com.',
  footnote: 'Tides vary[^a] and bells ring[^b]. Tides again[^a].\n\n[^a]: The first note.\n\n[^b]: The second note, with *emphasis*.',
  link: 'A [named link](https://example.com/page "Title"), an [address as its text](https://example.com/page), and [a script](javascript:alert(1)).',
  image: 'An image ![alt text](https://example.com/a.png) and a data image ![dot](data:image/png;base64,iVBORw0KGgo=).',
  rawHtml: 'Raw <b>bold</b> and <script>alert(1)</script> and <img src=x onerror=alert(1)> &amp; an entity.\n\n<div onclick="alert(1)">a block of HTML</div>',
  taskList: '- [x] done\n- [ ] not done',
  unclosedFence: 'Before.\n\n```js\nconst a = 1;\nconst b = 2;',
};

/** A late definition (C61): the text before it arrives, and what arrives. */
export const LATE = {
  before: 'Read [the guide][g] first, and note the tide[^t].\n\nA second paragraph that names nothing.\n\nA third paragraph.\n\n',
  after: '[g]: https://example.com/guide "Guide"\n\n[^t]: The tide note.\n',
};

// ── M20a (C44): what a turn did between its prompt and its answer, and a worker's answer ──────
// Added after M19's parts and drawing on generators of their own seeds, so every text above is the
// one K3 measured, byte for byte: tests/chat/perf/fixture.test.ts holds both hashes.

/** A turn's group of activity: this many items, one in ten with an output at the bound. */
export const ACTIVITIES = 20;
/** An output's bound, in UTF-16 units (M20a, C5). */
export const OUTPUT_BOUND = 20_000;

/** Lines of words, `units` long exactly. */
function output(t, units) {
  const lines = [];
  let length = 0;
  while (length < units) {
    const line = `${String(lines.length + 1).padStart(5, ' ')}  ${t.sentence()}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n').slice(0, units);
}

/**
 * The activities of one turn, in order: reads, searches and commands, each with what it was given
 * and what it returned. Every tenth has an output at the bound; the others a few lines.
 */
export function activities(n) {
  const t = tools(3_000_017 * n + 29);
  return Array.from({ length: ACTIVITIES }, (_, index) => {
    const type = ['read', 'search', 'command'][index % 3];
    const text = index % 10 === 9 ? output(t, OUTPUT_BOUND) : output(t, t.count(40, 400));
    const id = `${type[0]}${index + 1}`;
    if (type === 'read') {
      const file = `src/${t.words(1)}_${n}_${index + 1}.txt`;
      return { id, type, name: 'Read', summary: file.slice(4), input: JSON.stringify({ file_path: file }, null, 2), output: text, file, exitCode: null };
    }
    if (type === 'search') {
      const pattern = t.words(2);
      return { id, type, name: 'Grep', summary: pattern, input: JSON.stringify({ pattern, path: 'src' }, null, 2), output: text, file: null, exitCode: null };
    }
    const line = `rg -n '${t.words(1)}' src --glob '*_${n}_*.txt'`;
    return { id, type, name: 'commandExecution', summary: line, input: line, output: text, file: null, exitCode: 0 };
  });
}

/** What a worker's answer grows to: mixed Markdown of 20,000 units, of a seed of its own. */
export const workerText = () => mixed(717_171, MIXED_UNITS);

/**
 * The two streams that hold activity: a turn that runs its tools into a full window, and the same
 * with a worker whose answer streams beside it. Named apart from `STREAMS`: a prompt plays one only
 * by its name.
 */
export const ACTIVITY_STREAMS = ['tools', 'worker'];
