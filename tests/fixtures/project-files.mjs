// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The files K2's answers name (docs/planning/_archive/M19b.md, Design 10; C2, C46): a README, a source file
// and a Markdown file in a folder whose name has a space. The trace wrote them into its scratch
// folder (spikes/m19b), the smoke run writes them into its live project folder, and the fakes'
// tests into theirs, so that what a replayed answer names is there to open. One copy, plain
// JavaScript with no import, so that Node, the spike and the tests all read it.
//
// The files are made up, and say nothing of where they are: no path is written in any of them, so
// an answer's way of naming a file is the CLI's own and not a copy of the file's.
//
// Each ends in one marker sentence, added after the captures were taken: no captured answer quotes
// it, so the smoke run's scan can look for it everywhere. A file's text is shown and never kept,
// and none of it may reach fat-g's output or any file of its data folder (C33).

const MARKERS = Object.freeze({
  'README.md': 'marker-readme-4c1d',
  'src/tides.js': 'marker-source-9e2b',
  'field notes/harbour-log.md': 'marker-log-6a7f',
});

const README = `# Tide tools

Small helpers the harbour office uses to read its tide table: they parse the times of the day's tides, find the next high tide and print a height in metres.

## How it is used

The office's noticeboard script loads the helpers each morning, asks for the next high tide after the present time and prints it beside the ferry's departures.

## Notes

The keeper writes down unusual tides by hand; those notes are kept with the project and are no part of the code.

The spare key to the tide gauge hangs behind ${MARKERS['README.md']}.
`;

const SOURCE = `// Tide helpers for the harbour office.

const MINUTES_IN_DAY = 24 * 60;

/** Parses "HH:MM" into minutes after midnight. */
export function parseTime(text) {
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

/** The first high tide at or after \`now\`, both in minutes after midnight. */
export function nextHighTide(times, now) {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted.find((time) => time >= now) ?? sorted[0] + MINUTES_IN_DAY;
}

/** A height in metres, with one decimal. */
export function formatHeight(metres) {
  return \`\${metres.toFixed(1)} m\`;
}

// ${MARKERS['src/tides.js']}: nothing follows this line.
`;

const LOG = `# Harbour log

Unusual tides, as the keeper wrote them down.

- **3 March**: the morning tide came forty minutes early and reached the second step of the east stair.
- **19 April**: no high tide was seen before noon; the ferry left from the outer quay.

## To check

The gauge by the green bell reads ten centimetres low since the storm.

The chalk mark ${MARKERS['field notes/harbour-log.md']} is on the east stair.
`;

/** Relative path, with \`/\`, to text: a README, a source file, and a Markdown file in a folder whose name has a space. */
export const FILES = Object.freeze({ 'README.md': README, 'src/tides.js': SOURCE, 'field notes/harbour-log.md': LOG });

/** The line \`nextHighTide\` is defined on: what a right answer to the first prompt names. */
export const FUNCTION_LINE = SOURCE.split('\n').findIndex((line) => line.includes('function nextHighTide')) + 1;

/** Each Markdown file's own first heading: what its tab shows once it is open. */
export const HEADINGS = Object.freeze({ 'README.md': 'Tide tools', 'field notes/harbour-log.md': 'Harbour log' });

/** One word of each file that no captured answer holds: what a scan looks for. */
export const FILE_MARKERS = Object.freeze(Object.values(MARKERS));
