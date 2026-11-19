// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M23's two traces share (docs/planning/_archive/M23-spec-sheet.md; C70, C71): their output folder, the
// state one invocation leaves for the next, the prompts, the marker words the spike itself dictates,
// the fixture images the harness makes, and the reductions both use. Plain Node; nothing here is
// application code.
//
// Nothing a scenario notes is a text of the model's, and no image is anyone's: each is drawn here
// from a formula — two colours, or noise — and measured (its bytes, its pixels, its hash). A note
// says whether an answer holds a marker word the spike dictated, never what else it says.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';

export const M23_DIR = path.join(SPIKES_DIR, 'output', 'm23');

/** What one invocation leaves for the next (raw; ignored folder): ids and a model, never a text. */
const STATE = () => path.join(M23_DIR, 'state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

/** The words the spike dictates, which an answer either holds or does not. */
export const MARKERS = Object.freeze({
  steerCodex: 'STEER-TAKEN-5519',
  steerClaudeText: 'STEER-TAKEN-8841',
  steerClaudeTool: 'STEER-TAKEN-2290',
  held: 'HELD-3306',
  skill: 'MARIGOLD-7731',
});

/** The prompts: each of its own words, so that no earlier capture's prompt chooses it (tests/fakes/replay.test.ts). */
export const PROMPTS = Object.freeze({
  image: 'An image is attached. Say in one short sentence which colour fills its left half and which fills its right half. Use no tools.',
  twoImages: 'Two images are attached. For each one, in its order, say in one short sentence which colour fills its left half and which fills its right half. Use no tools.',
  bigImage: 'A large image is attached. Say in one short sentence whether it looks like random noise or like a drawing. Use no tools.',
  countCodex: 'Count from 1 to 150, one number per line, each followed by the word tick. Use no tools.',
  countClaude: 'Count from 1 to 150, one number per line, each followed by the word tock. Use no tools.',
  countHeld: 'Count from 1 to 150, one number per line, each followed by the word tack. Use no tools.',
  readThree: 'Read notes-1.txt, then notes-2.txt, then notes-3.txt, one file at a time with your Read tool, and after each file say in one sentence what it says. Use no other tool.',
  steerCodex: `Stop counting now and reply with only the word ${MARKERS.steerCodex}.`,
  steerClaudeText: `Stop counting now and reply with only the word ${MARKERS.steerClaudeText}.`,
  steerClaudeTool: `Skip the files you have not read yet and reply with only the word ${MARKERS.steerClaudeTool}.`,
  heldSecond: `Reply with only the word ${MARKERS.held}.`,
  /** A question asked in a message while the turn goes on (M21's async question, in a turn long enough to answer into). */
  asyncCodex: 'Ask me which of notes-3.txt and notes-4.txt you should summarise, offering those two as the options, and do not wait for my answer: keep working while I decide, by counting from 1 to 60 one number per line, and only after the count, or after you have acted on my answer, end your turn.',
  compact: '/compact',
  review: '/review',
  skillCodex: 'Use the m23-marker skill now.',
  skillClaude: '/m23-marker',
});

/** The skill both spikes put where their CLI reads skills: one instruction, one marker word. */
export const SKILL_NAME = 'm23-marker';
export const SKILL_MD = `---\nname: ${SKILL_NAME}\ndescription: Replies with a fixed marker word when it is used.\n---\n\nWhen this skill is used, reply with exactly the word ${MARKERS.skill} and nothing else. Read no file and run nothing.\n`;

// ── Fixture images (C70): drawn from a formula, never anyone's picture ─────────────────────────

const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
const chunk = (name, bytes) => { const n = Buffer.from(name); const b = Buffer.alloc(12 + bytes.length); b.writeUInt32BE(bytes.length); n.copy(b, 4); bytes.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([n, bytes])), b.length - 4); return b; };

/** An 8-bit RGB PNG of `width` × `height`, each row's pixels from `rowOf(y)` (width × 3 bytes), deflated at `level`. */
function png(width, height, rowOf, { level = 6 } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(Buffer.concat([Buffer.from([0]), rowOf(y)]));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows), { level })), chunk('IEND', Buffer.alloc(0))]);
}

/** A square split down the middle: `left` on the left half, `right` on the right (each an RGB triple). */
export function twoColourPng(left, right, size = 64) {
  const row = Buffer.alloc(size * 3);
  for (let x = 0; x < size; x += 1) { const colour = x < size / 2 ? left : right; row[x * 3] = colour[0]; row[x * 3 + 1] = colour[1]; row[x * 3 + 2] = colour[2]; }
  return png(size, size, () => row);
}

export const BOUND_BYTES = 5 * 1024 * 1024;

/** Random pixels stored uncompressed, as large as fits under `bound`: the image at the sheet's bound (C2). */
export function noisePng(bound = BOUND_BYTES, width = 1320) {
  const rowBytes = width * 3 + 1;
  let height = Math.floor((bound - 2048) / (rowBytes * (1 + 5 / 65_535)));
  for (;;) {
    const bytes = png(width, height, () => randomBytes(width * 3), { level: 0 });
    if (bytes.length <= bound) return bytes;
    height -= 1;
  }
}

/** The three images each spike sends, by name. Made once per process: the same bytes go to every scenario of a run. */
let made = null;
export function images() {
  made ??= {
    'two-colours-red-blue.png': twoColourPng([255, 0, 0], [0, 0, 255]),
    'two-colours-green-yellow.png': twoColourPng([0, 160, 0], [255, 220, 0]),
    'noise-at-the-bound.png': noisePng(),
  };
  return made;
}

/** An image's measurements, never its bytes: its name, bytes, pixels, hash and how long its base64 is. */
export function imageFacts(name, bytes) {
  return { name, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16), base64Units: Buffer.byteLength(bytes.toString('base64')) };
}

/** Whether a text holds one of the spike's own marker words, or a colour the fixture image shows. */
export const holds = (text, word) => typeof text === 'string' && new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text);
export const COLOUR_WORDS = Object.freeze({ red: /\bred\b/i, blue: /\bblue\b/i, green: /\bgreen\b/i, yellow: /\byellow\b/i, noise: /\bnoise|static|random\b/i });
export const coloursIn = (text) => Object.fromEntries(Object.entries(COLOUR_WORDS).map(([name, pattern]) => [name, typeof text === 'string' && pattern.test(text)]));
