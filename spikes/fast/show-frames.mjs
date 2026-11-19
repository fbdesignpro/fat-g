// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Prints the frames of a raw fast-mode capture whose method or type is named, with the user's home
// folder replaced. A reading aid for the spike's author; it launches nothing.
//
//   node spikes/fast/show-frames.mjs <capture.json> <method-or-type> [...]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const [file, ...names] = process.argv.slice(2);
const capture = JSON.parse(readFileSync(file, 'utf8'));
const frames = capture.frames ?? [];
const home = homedir();
const scrub = (text) => text.split(home).join('<home>').split(home.split('\\').join('\\\\')).join('<home>').split(home.split('\\').join('/')).join('<home>');
const keyOf = (frame) => frame?.method ?? (frame?.type ? [frame.type, frame.subtype ?? frame.request?.subtype].filter(Boolean).join('/') : 'response');
if (!frames.length) console.log('capture keys:', Object.keys(capture));
for (const entry of frames) {
  const frame = entry.frame ?? entry.json ?? entry;
  if (names.length === 0 || names.includes(keyOf(frame))) console.log(entry.index, entry.dir ?? '', scrub(JSON.stringify(frame)).slice(0, 1500));
}
