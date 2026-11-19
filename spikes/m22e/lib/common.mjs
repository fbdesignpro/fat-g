// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M22e's K1 shares between its two providers (docs/planning/_archive/M22e-spec-sheet.md; C2–C5, C19):
// its output folder, the plan it sends for review in M22b's block, a draft of C3's review
// instruction and C4's findings schema, the prompt C2 composes from them, and the reading of an
// answer by C5's rule. Plain Node; nothing here is application code.
//
// A note never holds a text of the model's: the captures hold the frames. Of an answer it says how
// its fenced blocks lie, whether the last `json` one checks against C4's draft and, where it does
// not, the kinds of what failed; its findings' counts and lengths; and the units around the block.
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SPIKES_DIR } from '../../m10/lib/paths.mjs';

export const M22E_DIR = path.join(SPIKES_DIR, 'output', 'm22e');

/** C3's instruction, its version kept with each review and asked back in the block (C4). A draft of fat-g's own words. */
export const INSTRUCTION_VERSION = 1;

export const INSTRUCTION = `Review the plan in the block below before anyone implements it. Read the plan, then read the files of the project in the current folder that it changes or depends on, so that each finding rests on the project as it is. Use your tools to read only, and change nothing.

Find what would go wrong if the plan were implemented exactly as written, and put each issue in one tier by that consequence:
- T1 Critical: the result would fail outright, lose data or break something that works now.
- T2 Serious: a main part would not work as intended, or a real risk is left open.
- T3 Moderate: a gap, an ambiguity or an omission an implementer would have to guess at.
- T4 Minor: a small inaccuracy or inconsistency that is easy to put right.
- T5 Cosmetic: wording or presentation alone.

Tag each issue PROD when it affects what ships, TEST-ONLY when it affects only tests or verification, and GENERAL otherwise. Give it a plain-English title, and one or two sentences each for an example of where it bites, a description and a correction. Number the issues within their tier: T1.1, T1.2, T2.1 and so on. Report only real issues: leave a tier empty rather than fill it, and merge issues that are one problem. Where an issue concerns one place in the plan, you may anchor it by the plan's heading there and a short phrase quoted from it.

Write your answer this way: at most two sentences of your own, then one fenced code block whose info string is json and whose content matches the schema below. Put every finding in the block and none in prose, and write nothing after the block.`;

/** Version 2 (C3, K2): an anchor asked for wherever an issue concerns one place, which C33's links need. */
const ANCHOR_V1 = "Where an issue concerns one place in the plan, you may anchor it by the plan's heading there and a short phrase quoted from it.";
const ANCHOR_V2 = "Wherever an issue concerns one place in the plan, anchor it by the plan's heading there and a short phrase quoted from it.";
if (!INSTRUCTION.includes(ANCHOR_V1)) throw new Error('the instruction lost its anchor sentence');
export const INSTRUCTIONS = Object.freeze({ 1: INSTRUCTION, 2: INSTRUCTION.replace(ANCHOR_V1, ANCHOR_V2) });

/** C4's findings contract, drafted as a JSON Schema for the prompt; `checkFindings` holds a block to it. */
export const BOUNDS = Object.freeze({ appraisal: 300, issues: 32, title: 200, field: 600, anchor: 200 });
export const CATEGORIES = Object.freeze(['PROD', 'TEST-ONLY', 'GENERAL']);
const ID_PATTERN = '^T[1-5]\\.[1-9][0-9]*$';

/** The schema for an instruction's version: from version 2, a finding may name `was`, its id in the round before (C4, C29). */
export function schemaFor(version) {
  const issue = SCHEMA.properties.issues.items;
  const was = version >= 2 ? { was: { type: 'string', pattern: ID_PATTERN, description: 'In a review sent again: the id this finding had before, where it moved to another tier.' } } : {};
  return { ...SCHEMA, properties: { ...SCHEMA.properties, version: { ...SCHEMA.properties.version, const: version }, issues: { ...SCHEMA.properties.issues, items: { ...issue, properties: { ...issue.properties, ...was } } } } };
}

export const SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'appraisal', 'issues'],
  properties: {
    version: { const: INSTRUCTION_VERSION, description: "The review instruction's version." },
    appraisal: { type: 'string', minLength: 1, maxLength: BOUNDS.appraisal, description: 'One line on the plan as a whole.' },
    issues: {
      type: 'array',
      maxItems: BOUNDS.issues,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'tier', 'category', 'title', 'example', 'description', 'correction'],
        properties: {
          id: { type: 'string', pattern: '^T[1-5]\\.[1-9][0-9]*$', description: 'T<tier>.<n>, numbered within the tier.' },
          tier: { type: 'integer', minimum: 1, maximum: 5 },
          category: { enum: CATEGORIES },
          title: { type: 'string', minLength: 1, maxLength: BOUNDS.title },
          example: { type: 'string', minLength: 1, maxLength: BOUNDS.field },
          description: { type: 'string', minLength: 1, maxLength: BOUNDS.field },
          correction: { type: 'string', minLength: 1, maxLength: BOUNDS.field },
          anchor: {
            type: 'object',
            additionalProperties: false,
            required: ['heading', 'quote'],
            properties: { heading: { type: 'string', maxLength: BOUNDS.anchor }, quote: { type: 'string', maxLength: BOUNDS.anchor } },
          },
        },
      },
    },
  },
});

// ── The plan under review: made up, about the scratch project's own files ───────────────────────

export const PLAN_TITLE = 'Add a next low tide helper';

/** Version 1: grounded in tests/fixtures/project-files.mjs, with faults a review should find. */
export const PLAN_V1 = `# Add a next low tide helper

## Goal

The harbour office's noticeboard should show the next low tide beside the next high tide.

## Steps

1. In \`src/tides.js\`, add \`nextLowTide(times, now)\`, a copy of \`nextHighTide\` that returns the first low tide at or after \`now\`. It takes the same list of times the noticeboard already passes to \`nextHighTide\`.
2. Change \`parseTime\` so that it also reads times written as "H:MM", such as "7:05".
3. Change \`formatHeight\` to print feet instead of metres, since the ferry company works in feet.
4. In \`src/noticeboard.js\`, print the next low tide under the next high tide.

## Done when

The noticeboard shows both tides each morning.
`;

/** Version 2: the first's faults mostly put right, a few left for the second review. */
export const PLAN_V2 = `# Add a next low tide helper

## Goal

The harbour office's noticeboard should show the next low tide beside the next high tide.

## Steps

1. In \`src/tides.js\`, add and export \`nextLowTide(lowTimes, now)\`, which returns the first of the day's low-tide times at or after \`now\`, or the first one of the next day. The caller passes the low tides as a list of their own, read from the tide table's low-water column.
2. Leave \`parseTime\` and \`formatHeight\` as they are: heights stay in metres.
3. The noticeboard script is not part of this project: the office's script calls \`nextLowTide\` once this change is released.
4. Add \`test/tides.test.js\`, run with \`node --test\`, covering a low tide later in the day, one at exactly \`now\`, and the wrap to the next day.

## Done when

\`node --test\` passes, and \`nextLowTide\` is exported beside \`nextHighTide\`.
`;

/** M22b's block (src/shared/contracts/plans.ts, planBlock): fat-g's opening line, the text, its closing line. */
export function planBlock(planId, version, text, token) {
  if (!/^[0-9a-f]{12}$/.test(token) || text.includes(`token="${token}"`)) throw new TypeError('the token is not the text’s own');
  return `<fat-g-plan id="${planId}" version="${version}" token="${token}">\n${text}\n</fat-g-plan token="${token}">`;
}

/** One plan id per run, as the registry makes one, and a token per prompt (C68). */
export const newPlanId = () => randomUUID();
export const newToken = () => randomBytes(6).toString('hex');

/** C2's first prompt: the instruction, the plan's title and version, its block, the project's folder and the schema. */
export function reviewPrompt({ planId, version, text, folder, instruction = INSTRUCTION_VERSION }) {
  return [
    INSTRUCTIONS[instruction],
    `Plan: ${PLAN_TITLE}, version ${version}.`,
    planBlock(planId, version, text, newToken()),
    `Project folder: ${folder}`,
    schemaBlock(instruction),
  ].join('\n\n');
}

const schemaBlock = (instruction) => `Findings schema (JSON Schema):\n\n\`\`\`json\n${JSON.stringify(instruction === 1 ? SCHEMA : schemaFor(instruction), null, 2)}\n\`\`\``;

// ── A review's later rounds (C29, C31, C32): drafts of fat-g's words ──────────────────────────────

export const SEND_NOTES_WORDS = "Here is the user's feedback on the following findings of your review. Where a note asks a question, answer it. Where a note settles a point, send the review again, whole, in the same form as before.";
export const SHOW_UPDATED_WORDS = 'Send the review again, whole, in the same form as before, updated with what we have discussed since.';
export const ROUND_RULES = 'keep each finding\'s id where it is the same point; number a new finding after the highest id in its tier; where a finding moves to another tier, give it the next id in that tier and name its earlier id in "was"; send every finding again, refused ones included, leaving out only a finding the discussion showed to be wrong; and close your answer with one fenced code block whose info string is json, matching the schema below, with nothing after it.';

const MARK_WORDS = Object.freeze({ open: 'undecided', accepted: 'accepted', rejected: 'refused' });
const markOf = (marks, id) => MARK_WORDS[marks[id] ?? 'open'];

/** Every finding's mark, by its id (C29). */
const marksLine = (findings, marks) => `The user's marks so far: ${findings.map((f) => `${f.id} ${markOf(marks, f.id)}`).join('; ')}.`;

/** Send notes (C31): the words, each finding with a note by its id, its mark and its title, every finding's mark, the rules of a round and the schema. */
export function sendNotesPrompt({ findings, marks, notes, instruction = 2 }) {
  const noted = findings.filter((f) => notes[f.id]).map((f) => `- ${f.id} (${markOf(marks, f.id)}), "${f.title}": ${notes[f.id]}`);
  return [SEND_NOTES_WORDS, noted.join('\n'), marksLine(findings, marks), `If you send the review again: ${ROUND_RULES}`, schemaBlock(instruction)].join('\n\n');
}

/** Show updated review (C32): the words, every finding's mark, any note not yet sent, the rules of a round and the schema. */
export function showUpdatedPrompt({ findings, marks, notes = {}, instruction = 2 }) {
  const unsent = findings.filter((f) => notes[f.id]).map((f) => `- ${f.id} (${markOf(marks, f.id)}), "${f.title}": ${notes[f.id]}`);
  return [SHOW_UPDATED_WORDS, marksLine(findings, marks), ...(unsent.length ? [`Notes not sent yet:\n${unsent.join('\n')}`] : []), `In it: ${ROUND_RULES}`, schemaBlock(instruction)].join('\n\n');
}

// ── Reading an answer by C5's rule ───────────────────────────────────────────────────────────────

/** The fenced blocks of a Markdown text, by CommonMark's fences: each one's info string, its content, where it lies. */
export function fencedBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let open = null;
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    if (open === null) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (match && !(match[1][0] === '`' && match[2].includes('`'))) open = { fence: match[1], info: match[2].trim().split(/\s+/)[0] ?? '', start, contentStart: offset, lines: [] };
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      blocks.push({ info: open.info, content: open.lines.join('\n'), start: open.start, end: Math.min(offset, text.length), closed: true });
      open = null;
    } else open.lines.push(line);
  }
  if (open !== null) blocks.push({ info: open.info, content: open.lines.join('\n'), start: open.start, end: text.length, closed: false });
  return blocks;
}

const isString = (value) => typeof value === 'string';
const units = (value) => (isString(value) ? value.length : 0);

/** A block's content held to C4's draft: the problems by kind — never a text — and the findings' counts and lengths. */
export function checkFindings(content, { version = INSTRUCTION_VERSION } = {}) {
  let value;
  try { value = JSON.parse(content); } catch { return { parsed: false, checks: false, problems: ['not JSON'] }; }
  const problems = [];
  const add = (kind) => { if (!problems.includes(kind)) problems.push(kind); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { parsed: true, checks: false, problems: ['not an object'] };
  for (const key of Object.keys(value)) if (!['version', 'appraisal', 'issues'].includes(key)) add(`unknown field ${key}`);
  if (value.version !== version) add('version');
  const issueKeys = ['id', 'tier', 'category', 'title', 'example', 'description', 'correction', 'anchor', ...(version >= 2 ? ['was'] : [])];
  let named = 0;
  if (!isString(value.appraisal) || value.appraisal.trim() === '') add('appraisal missing');
  else if (units(value.appraisal) > BOUNDS.appraisal) add('bound: appraisal');
  if (isString(value.appraisal) && value.appraisal.includes('\n')) add('appraisal not one line');
  const issues = Array.isArray(value.issues) ? value.issues : null;
  if (issues === null) add('issues missing');
  else if (issues.length > BOUNDS.issues) add('bound: issues');
  const ids = new Set();
  const perTier = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const longest = { title: 0, example: 0, description: 0, correction: 0 };
  let anchors = 0;
  for (const issue of issues ?? []) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) { add('issue not an object'); continue; }
    for (const key of Object.keys(issue)) if (!issueKeys.includes(key)) add(`unknown issue field ${key}`);
    if (issue.was !== undefined) { named += 1; if (!new RegExp(ID_PATTERN).test(String(issue.was))) add('was'); }
    const id = /^T([1-5])\.([1-9][0-9]*)$/.exec(String(issue.id ?? ''));
    if (!id) add('id');
    else if (Number(id[1]) !== issue.tier) add('id names another tier');
    if (isString(issue.id) && ids.has(issue.id)) add('id repeated');
    if (isString(issue.id)) ids.add(issue.id);
    if (!Number.isInteger(issue.tier) || issue.tier < 1 || issue.tier > 5) add('tier'); else perTier[issue.tier] += 1;
    if (!CATEGORIES.includes(issue.category)) add('category'); else categories[issue.category] += 1;
    for (const field of ['title', 'example', 'description', 'correction']) {
      if (!isString(issue[field]) || issue[field].trim() === '') { add(`${field} missing`); continue; }
      longest[field] = Math.max(longest[field], units(issue[field]));
      if (units(issue[field]) > (field === 'title' ? BOUNDS.title : BOUNDS.field)) add(`bound: ${field}`);
    }
    if (issue.anchor !== undefined) {
      const anchor = issue.anchor;
      if (!anchor || typeof anchor !== 'object' || !isString(anchor.heading) || !isString(anchor.quote) || Object.keys(anchor).some((key) => !['heading', 'quote'].includes(key))) add('anchor');
      else { anchors += 1; if (units(anchor.heading) > BOUNDS.anchor || units(anchor.quote) > BOUNDS.anchor) add('bound: anchor'); }
    }
  }
  return {
    parsed: true, checks: problems.length === 0, problems,
    issues: issues?.length ?? null, perTier, categories, anchors, ...(version >= 2 ? { wasNamed: named } : {}), appraisalUnits: units(value.appraisal), longest,
    sentences: sentenceCounts(issues ?? []),
  };
}

/** How many sentences each field holds, at most and on average: C3 asks one or two. */
function sentenceCounts(issues) {
  const count = (text) => (isString(text) ? text.split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(])/).filter((part) => part.trim() !== '').length : 0);
  const out = {};
  for (const field of ['example', 'description', 'correction']) {
    const counts = issues.map((issue) => count(issue?.[field]));
    out[field] = counts.length === 0 ? null : { max: Math.max(...counts), overTwo: counts.filter((n) => n > 2).length };
  }
  return out;
}

/** C5's verdict on a final message, with how its fenced blocks lie. Never its text. */
export function readAnswer(text, { version = INSTRUCTION_VERSION } = {}) {
  if (!isString(text)) return { verdict: 'no message', units: 0 };
  const blocks = fencedBlocks(text);
  const json = blocks.filter((block) => block.info.toLowerCase() === 'json');
  const checked = json.map((block) => ({ block, check: checkFindings(block.content, { version }) }));
  const passing = checked.filter((one) => one.check.checks);
  const last = checked.at(-1) ?? null;
  let verdict;
  if (json.length === 0) verdict = 'failed: no block';
  else if (passing.length > 1) verdict = 'failed: more than one';
  else if (last.check.checks) verdict = 'findings';
  else verdict = last.check.problems.every((kind) => kind.startsWith('bound:')) ? 'failed: over a bound' : 'failed: invalid';
  return {
    verdict, units: text.length,
    fencedBlocks: blocks.map((block) => ({ info: block.info || null, units: block.content.length, closed: block.closed })),
    jsonBlocks: json.length, jsonBlocksThatCheck: passing.length,
    last: last ? {
      units: last.block.content.length, closed: last.block.closed,
      unitsBefore: text.slice(0, last.block.start).trim().length,
      sentencesBefore: text.slice(0, last.block.start).trim().split(/(?<=[.!?:])\s+/).filter((part) => part.trim() !== '').length,
      unitsAfter: text.slice(last.block.end).trim().length,
      ...last.check,
    } : null,
  };
}

/** The findings C5 accepts from an answer, in memory only — a round's ids, tiers, `was` and texts — or null. Never written down. */
export function findingsOf(text, { version = INSTRUCTION_VERSION } = {}) {
  if (readAnswer(text, { version }).verdict !== 'findings') return null;
  const json = fencedBlocks(text).filter((block) => block.info.toLowerCase() === 'json');
  return JSON.parse(json.at(-1).content).issues;
}

const sameText = (a, b) => ['title', 'example', 'description', 'correction'].every((field) => a[field] === b[field]);

/**
 * A round against the one before (C29): which ids it kept, which findings it moved by `was`, which
 * are new, which of the earlier ones it left out, which it revised; and the marks carried by id or
 * by `was`. Ids only.
 */
export function compareRounds(before, after, marks) {
  const earlier = new Map(before.map((f) => [f.id, f]));
  const kept = [];
  const moved = [];
  const added = [];
  const revised = [];
  const carried = {};
  const reached = new Set();
  for (const f of after) {
    // `was` where it names another finding of the round before; else the id itself. A `was` the model
    // repeats from an older round names nothing there, and the id decides.
    const from = typeof f.was === 'string' && f.was !== f.id && earlier.has(f.was) ? f.was : earlier.has(f.id) ? f.id : null;
    if (from === null) { added.push(f.id); carried[f.id] = 'open'; continue; }
    reached.add(from);
    if (from === f.id) kept.push(f.id); else moved.push({ from, to: f.id });
    if (!sameText(earlier.get(from), f)) revised.push(f.id);
    carried[f.id] = marks[from] ?? 'open';
  }
  return { kept, moved, added, revised, leftOut: before.map((f) => f.id).filter((id) => !reached.has(id)), carried };
}
