// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Plan review (docs/planning/_archive/M22e.md, Design 1, 8; C3–C5, C10, C29, C31, C34, C44, C46, C48; decision
// 0029): a plan's version sent to a reviewer session under fat-g's fixed instruction, its findings
// read back from the answer's last `json` block as a round of the review, each finding marked by the
// user, annotated and sent again, and the accepted ones integrated into the plan's next version.
//
// Renderer-safe and provider-neutral: the findings' contract, its JSON Schema for the prompt, the
// parser of an answer, how a round's marks carry to the next, the instruction and every prompt fat-g
// composes for a review, the views main answers and the channels' shapes. No CLI's word is here, and
// no frame: a review's prompts are prompts, and its answers messages.
//
// It imports `zod`, the plans' contract, the asides' bounds and the model preset, and nothing of Node, the page or main.
import { z } from 'zod';
import { MAX_EXCERPT } from './aside';
import type { AskRefusal, SendRefusal } from './chat';
import { cutTo } from './cut';
import { PLAN_WORDS, PlanIdSchema, planBlock, planNamed, PlanVersionSchema } from './plans';
import { ModelPresetSchema, type PresetRefusal } from './presets';
import type { SendBlock } from './sessions';

// ── Ids and bounds (C4, C10, C30) ─────────────────────────────────────────────────────────────

/** The folder of a plan's folder that holds its reviews (C6): one file per review. */
export const REVIEWS_FOLDER = 'reviews';

/** A review's id, and an integration's, as main makes them: what a file, a record and every channel name them by. */
export const ReviewIdSchema = PlanIdSchema;
export const isReviewId = (value: unknown): value is string => ReviewIdSchema.safeParse(value).success;

/** A finding's id: its tier, then its number within the tier (C4). */
export const FINDING_ID = /^T[1-5]\.[1-9][0-9]{0,2}$/;
export const FindingIdSchema = z.string().regex(FINDING_ID);
export const isFindingId = (value: unknown): value is string => typeof value === 'string' && FINDING_ID.test(value);
/** The tier a finding's id names: its first digit. */
export const tierOf = (id: string): number => Number(id.charAt(1));

/**
 * What the prompt's schema asks of a findings block (C4): the lengths and the count a reviewer aims
 * at, and nothing fat-g refuses a block for (the maintainer). A block is read past every
 * one of them; what bounds it is the cut every message of a chat has (`MAX_MESSAGE_TEXT`). The
 * appraisal is asked for no length.
 */
export const REVIEW_ASKED = Object.freeze({
  issues: 32,
  title: 200,
  /** An example, a description, a correction: one or two sentences asked (C3). */
  field: 600,
  /** An anchor's heading, and its quote. */
  anchor: 200,
});

/** What fat-g itself takes: the user's own words, and what one integration sends. */
export const REVIEW_BOUNDS = Object.freeze({
  /** A note on a finding (C30). */
  note: 2_000,
  /** What an integration sends of the findings and the notes (C10): the plan's text counts for nothing here. */
  integration: 100_000,
});

export const TIERS = [1, 2, 3, 4, 5] as const;
export type Tier = (typeof TIERS)[number];
/** Each tier's name (C3): by the consequence of implementing the plan as written. */
export const TIER_NAMES: Readonly<Record<Tier, string>> = { 1: 'Critical', 2: 'Serious', 3: 'Moderate', 4: 'Minor', 5: 'Cosmetic' };

export const FINDING_CATEGORIES = ['PROD', 'TEST-ONLY', 'GENERAL'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

// ── The findings contract (C4) ────────────────────────────────────────────────────────────────

/** The instruction this build sends (C3, K2): version 2, which asks for an anchor wherever an issue concerns one place. */
export const REVIEW_INSTRUCTION_VERSION = 2;

const AnchorSchema = z.strictObject({ heading: z.string(), quote: z.string() });

/** A finding as a round holds it, and as the plan store reads it back: of any length (the maintainer). */
export const FindingSchema = z.strictObject({
  id: FindingIdSchema,
  tier: z.number().int().min(1).max(5),
  category: z.enum(FINDING_CATEGORIES),
  title: z.string().min(1),
  example: z.string().min(1),
  description: z.string().min(1),
  correction: z.string().min(1),
  /** A heading of the plan and a phrase quoted from it, never a line number (C4). */
  anchor: AnchorSchema.optional(),
  /** In a later round: the id the finding had in the round before, where it moved to another tier (C29). */
  was: FindingIdSchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export interface FindingsBlock {
  readonly version: number;
  /** On one line; empty where the block gave none. */
  readonly appraisal: string;
  readonly issues: readonly Finding[];
}

/** A finding's four texts, each required and not empty. */
const FINDING_TEXTS = ['title', 'example', 'description', 'correction'] as const;

/**
 * Why a finding of a block was set aside, the rest of its round standing (the maintainer):
 * it is no object, its id is no `T<tier>.<n>`, its tier is not the one its id names, its
 * category is none of the three, one of its texts is missing or empty, or a finding read before it
 * has its id.
 */
export const SET_ASIDE_PROBLEMS = ['not-finding', 'id', 'tier', 'category', ...FINDING_TEXTS, 'repeated'] as const;
export type SetAsideProblem = (typeof SET_ASIDE_PROBLEMS)[number];

export interface SetAside {
  /** Its place in the block's list, from 1. */
  readonly position: number;
  /** Its id, where it gave one of the form `T<tier>.<n>`; null otherwise. */
  readonly id: string | null;
  readonly problem: SetAsideProblem;
}

/**
 * Why a block brought no round: it is no JSON, no object, of another version than the instruction's,
 * or holds no list of findings — or a list of which no finding could be read (`none-read`).
 */
export const BLOCK_PROBLEMS = ['json', 'shape', 'version', 'issues', 'none-read'] as const;
export type BlockProblem = (typeof BLOCK_PROBLEMS)[number];

export type BlockCheck =
  | { readonly ok: true; readonly block: FindingsBlock; readonly setAside: readonly SetAside[] }
  | { readonly ok: false; readonly refusal: 'invalid'; readonly problem: BlockProblem; readonly setAside: readonly SetAside[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One finding of a block, or why it is set aside. What it holds beyond its fields is dropped, and so
 * is an anchor or a `was` that does not read: the finding stands without it.
 */
function readFinding(raw: unknown, position: number, taken: ReadonlySet<string>): { readonly finding: Finding } | { readonly setAside: SetAside } {
  const aside = (id: string | null, problem: SetAsideProblem) => ({ setAside: { position, id, problem } });
  if (!isRecord(raw)) return aside(null, 'not-finding');
  const id = raw['id'];
  if (!isFindingId(id)) return aside(null, 'id');
  if (taken.has(id)) return aside(id, 'repeated');
  const tier = raw['tier'];
  if (tier !== tierOf(id)) return aside(id, 'tier');
  const category = raw['category'];
  if (!(FINDING_CATEGORIES as readonly unknown[]).includes(category)) return aside(id, 'category');
  const texts: Partial<Record<(typeof FINDING_TEXTS)[number], string>> = {};
  for (const field of FINDING_TEXTS) {
    const text = raw[field];
    if (typeof text !== 'string' || text === '') return aside(id, field);
    texts[field] = text;
  }
  const anchor = isRecord(raw['anchor']) && typeof raw['anchor']['heading'] === 'string' && typeof raw['anchor']['quote'] === 'string' ? { heading: raw['anchor']['heading'], quote: raw['anchor']['quote'] } : undefined;
  const was = isFindingId(raw['was']) ? raw['was'] : undefined;
  const finding = FindingSchema.safeParse({ id, tier, category, ...texts, ...(anchor === undefined ? {} : { anchor }), ...(was === undefined ? {} : { was }) });
  return finding.success ? { finding: finding.data } : aside(id, 'not-finding');
}

/**
 * A block's content as a round (C4; the maintainer): every finding that reads, of any
 * length and however many, each one that does not set aside with why, and the appraisal on one line.
 * A field it holds beyond the contract's is dropped. It brings no round only where it is no JSON, no
 * object, of another version, holds no list, or holds findings none of which reads.
 */
export function checkFindings(content: string, version: number): BlockCheck {
  const refused = (problem: BlockProblem, setAside: readonly SetAside[] = []): BlockCheck => ({ ok: false, refusal: 'invalid', problem, setAside });
  let value: unknown;
  try { value = JSON.parse(content); } catch { return refused('json'); }
  if (!isRecord(value)) return refused('shape');
  if (value['version'] !== version) return refused('version');
  const listed = value['issues'];
  if (!Array.isArray(listed)) return refused('issues');
  const appraisal = typeof value['appraisal'] === 'string' ? value['appraisal'].replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  const taken = new Set<string>();
  const issues: Finding[] = [];
  const setAside: SetAside[] = [];
  listed.forEach((raw: unknown, index) => {
    const read = readFinding(raw, index + 1, taken);
    if ('setAside' in read) { setAside.push(read.setAside); return; }
    taken.add(read.finding.id);
    issues.push(read.finding);
  });
  if (issues.length === 0 && setAside.length > 0) return refused('none-read', setAside);
  return { ok: true, block: { version, appraisal, issues }, setAside };
}

const ID_PATTERN = FINDING_ID.source;

/**
 * The JSON Schema the prompt carries (C4, K2): K2's version 2, with the lengths and the count asked
 * (`REVIEW_ASKED`). What it allows, `checkFindings` reads as a round, and it reads more: a test holds
 * the one inside the other over the captures and the fakes' faults.
 */
export function findingsJsonSchema(version: number = REVIEW_INSTRUCTION_VERSION): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'appraisal', 'issues'],
    properties: {
      version: { const: version, description: "The review instruction's version." },
      appraisal: { type: 'string', minLength: 1, description: 'One line on the plan as a whole.' },
      issues: {
        type: 'array',
        maxItems: REVIEW_ASKED.issues,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'tier', 'category', 'title', 'example', 'description', 'correction'],
          properties: {
            id: { type: 'string', pattern: ID_PATTERN, description: 'T<tier>.<n>, numbered within the tier.' },
            tier: { type: 'integer', minimum: 1, maximum: 5 },
            category: { enum: [...FINDING_CATEGORIES] },
            title: { type: 'string', minLength: 1, maxLength: REVIEW_ASKED.title },
            example: { type: 'string', minLength: 1, maxLength: REVIEW_ASKED.field },
            description: { type: 'string', minLength: 1, maxLength: REVIEW_ASKED.field },
            correction: { type: 'string', minLength: 1, maxLength: REVIEW_ASKED.field },
            anchor: {
              type: 'object',
              additionalProperties: false,
              required: ['heading', 'quote'],
              properties: { heading: { type: 'string', maxLength: REVIEW_ASKED.anchor }, quote: { type: 'string', maxLength: REVIEW_ASKED.anchor } },
            },
            was: { type: 'string', pattern: ID_PATTERN, description: 'In a review sent again: the id this finding had before, where it moved to another tier.' },
          },
        },
      },
    },
  };
}

// ── The parser (C5, C48) ──────────────────────────────────────────────────────────────────────

/** A fenced block of a Markdown text, by CommonMark's fences: its info string's first word, its content, where it lies. */
export interface FencedBlock {
  readonly info: string;
  readonly content: string;
  /** The opening fence's first unit, and the unit after the closing fence's line — the text's end for one never closed. */
  readonly start: number;
  readonly end: number;
  readonly closed: boolean;
}

/**
 * Every fenced block of a text, backtick and tilde, as CommonMark reads a document's top level: a
 * fence of three or more, indented three spaces at most, a backtick fence's info string holding no
 * backtick; closed by a fence of the same character, as long at least, with nothing after it but
 * spaces. A block never closed runs to the text's end (C48).
 */
export function fencedBlocks(text: string): readonly FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { fence: string; indent: number; info: string; start: number; lines: string[] } | null = null;
  let offset = 0;
  for (const raw of text.split('\n')) {
    const start = offset;
    offset += raw.length + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (open === null) {
      const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (match === null) continue;
      const [, indent = '', fence = '', rest = ''] = match;
      if (fence.startsWith('`') && rest.includes('`')) continue;
      open = { fence, indent: indent.length, info: rest.trim().split(/\s+/)[0] ?? '', start, lines: [] };
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close !== null && close[1] !== undefined && close[1].charAt(0) === open.fence.charAt(0) && close[1].length >= open.fence.length) {
      blocks.push({ info: open.info, content: open.lines.join('\n'), start: open.start, end: Math.min(offset, text.length), closed: true });
      open = null;
      continue;
    }
    // A content line loses as much of its indentation as the opening fence had.
    let cut = 0;
    while (cut < open.indent && line.charAt(cut) === ' ') cut += 1;
    open.lines.push(line.slice(cut));
  }
  if (open !== null) blocks.push({ info: open.info, content: open.lines.join('\n'), start: open.start, end: text.length, closed: false });
  return blocks;
}

/** Why an answer brought no round (C5): no `json` block, two that check, or a last one refused. */
export const ROUND_FAILURES = ['no-block', 'several', 'invalid'] as const;
export type RoundFailure = (typeof ROUND_FAILURES)[number];

export type FindingsReading =
  | {
    readonly verdict: 'findings';
    readonly block: FindingsBlock;
    /** The block's findings that did not read, each with why. */
    readonly setAside: readonly SetAside[];
    /** Where the block lies in the text, its fences included. */
    readonly start: number;
    readonly end: number;
    /** The text before the block and after it, without the line breaks that join them. */
    readonly before: string;
    readonly after: string;
  }
  | { readonly verdict: 'invalid'; readonly problem: BlockProblem; readonly setAside: readonly SetAside[] }
  | { readonly verdict: 'no-block' | 'several' };

/**
 * An answer read by C5: the `json` blocks — the info string's first word, case aside — each held to
 * the contract. None gives `no-block`; two or more that check give `several`; otherwise the last one
 * decides, a round where it checks. An unclosed last block is read on its content to the end (C48).
 * Pure and shared: main records a round from it, and the page splits a round's answer with it.
 */
export function readFindings(text: string, version: number): FindingsReading {
  const json = fencedBlocks(text).filter((block) => block.info.toLowerCase() === 'json');
  if (json.length === 0) return { verdict: 'no-block' };
  const checked = json.map((block) => ({ block, check: checkFindings(block.content, version) }));
  if (checked.filter((one) => one.check.ok).length > 1) return { verdict: 'several' };
  const last = checked.at(-1);
  if (last === undefined) return { verdict: 'no-block' };
  if (!last.check.ok) return { verdict: last.check.refusal, problem: last.check.problem, setAside: last.check.setAside };
  return {
    verdict: 'findings',
    block: last.check.block,
    setAside: last.check.setAside,
    start: last.block.start,
    end: last.block.end,
    before: text.slice(0, last.block.start).replace(/\s+$/, ''),
    after: text.slice(last.block.end).replace(/^\s+/, ''),
  };
}

// ── Marks and carrying (C16, C28, C29, C46) ───────────────────────────────────────────────────

/** A finding's mark: every one is the user's own, a carried one included (C16). */
export const REVIEW_MARKS = ['open', 'accepted', 'rejected'] as const;
export type ReviewMark = (typeof REVIEW_MARKS)[number];
export const MARK_WORDS: Readonly<Record<ReviewMark, string>> = { open: 'undecided', accepted: 'accepted', rejected: 'refused' };

/** A finding of the new round, and what it carries of the one it came from. */
export interface Carried {
  readonly id: string;
  /** The earlier finding it came from, by `was` or by id; null for a new one. */
  readonly from: string | null;
  readonly mark: ReviewMark;
  readonly note: string;
  /** Its title, example, description or correction differ from the one it came from. */
  readonly revised: boolean;
}

const sameText = (a: Finding, b: Finding): boolean => a.title === b.title && a.example === b.example && a.description === b.description && a.correction === b.correction;

/**
 * A round against the one before (C29, C46). A finding comes from the one its `was` names, where
 * that is another id the round before holds, kept as its own id by no finding of the new round and
 * named in `was` by no other; else from the finding with its own id, where the round before holds
 * one; else from none, and is new. Each earlier finding is so claimed once at most, and one
 * acceptance never becomes two. Those no new finding came from are withdrawn.
 */
export function carryRound(before: readonly Finding[], after: readonly Finding[], marks: Readonly<Record<string, ReviewMark>>, notes: Readonly<Record<string, string>>): { readonly carried: readonly Carried[]; readonly withdrawn: readonly string[] } {
  const earlier = new Map(before.map((finding) => [finding.id, finding]));
  const own = new Set(after.map((finding) => finding.id));
  const named = new Map<string, number>();
  for (const finding of after) if (finding.was !== undefined && finding.was !== finding.id) named.set(finding.was, (named.get(finding.was) ?? 0) + 1);
  const reached = new Set<string>();
  const carried = after.map((finding): Carried => {
    const was = finding.was;
    const from = was !== undefined && was !== finding.id && earlier.has(was) && !own.has(was) && named.get(was) === 1 ? was : earlier.has(finding.id) ? finding.id : null;
    const source = from === null ? undefined : earlier.get(from);
    if (from === null || source === undefined) return { id: finding.id, from: null, mark: 'open', note: '', revised: false };
    reached.add(from);
    return { id: finding.id, from, mark: marks[from] ?? 'open', note: notes[from] ?? '', revised: !sameText(source, finding) };
  });
  return { carried, withdrawn: before.map((finding) => finding.id).filter((id) => !reached.has(id)) };
}

/**
 * A later round's findings, with each one it set aside put back as the round before held it (the
 * maintainer): a finding sent again but unreadable keeps its earlier words, and through
 * `carryRound` its mark and note, unrevised. Only where no finding the round could read holds its id
 * or names it in `was`. It is put back with no `was`, so that it carries by its own id.
 */
export function keepSetAside(before: readonly Finding[], after: readonly Finding[], setAside: readonly SetAside[]): readonly Finding[] {
  const earlier = new Map(before.map((finding) => [finding.id, finding]));
  const claimed = new Set(after.flatMap((finding) => (finding.was === undefined ? [finding.id] : [finding.id, finding.was])));
  const kept: Finding[] = [];
  for (const one of setAside) {
    const source = one.id === null || claimed.has(one.id) ? undefined : earlier.get(one.id);
    if (source === undefined) continue;
    claimed.add(source.id);
    const { was: _was, ...rest } = source;
    kept.push(rest);
  }
  return [...after, ...kept];
}

/**
 * What a round's list says of its answer's set-aside findings: those left out, and the ids of those
 * the round holds as the round before had them (`keepSetAside`) — which the answer did not give in
 * a finding that read, and the round holds all the same.
 */
export function setAsideShown(setAside: readonly SetAside[], read: readonly Finding[], shown: readonly Finding[]): { readonly leftOut: readonly SetAside[]; readonly kept: readonly string[] } {
  const readIds = new Set(read.map((finding) => finding.id));
  const shownIds = new Set(shown.map((finding) => finding.id));
  const isKept = (one: SetAside): boolean => one.id !== null && !readIds.has(one.id) && shownIds.has(one.id);
  return { leftOut: setAside.filter((one) => !isKept(one)), kept: [...new Set(setAside.filter(isKept).map((one) => one.id ?? ''))] };
}

// ── fat-g's words (C3, C10, C31, C34) ─────────────────────────────────────────────────────────

/** The instruction (C3), by its version: K2's version 2. A later wording is version 3, and 2's text stays for the record. */
export const REVIEW_INSTRUCTIONS: Readonly<Record<number, string>> = Object.freeze({
  2: `${PLAN_WORDS.reviewOpening} Read the plan, then read the files of the project in the current folder that it changes or depends on, so that each finding rests on the project as it is. Use your tools to read only, and change nothing.

Find what would go wrong if the plan were implemented exactly as written, and put each issue in one tier by that consequence:
- T1 Critical: the result would fail outright, lose data or break something that works now.
- T2 Serious: a main part would not work as intended, or a real risk is left open.
- T3 Moderate: a gap, an ambiguity or an omission an implementer would have to guess at.
- T4 Minor: a small inaccuracy or inconsistency that is easy to put right.
- T5 Cosmetic: wording or presentation alone.

Tag each issue PROD when it affects what ships, TEST-ONLY when it affects only tests or verification, and GENERAL otherwise. Give it a plain-English title, and one or two sentences each for an example of where it bites, a description and a correction. Number the issues within their tier: T1.1, T1.2, T2.1 and so on. Report only real issues: leave a tier empty rather than fill it, and merge issues that are one problem. Wherever an issue concerns one place in the plan, anchor it by the plan's heading there and a short phrase quoted from it.

Write your answer this way: at most two sentences of your own, then one fenced code block whose info string is json and whose content matches the schema below. Put every finding in the block and none in prose, and write nothing after the block.`,
});

/** An integration's first sentence (C10): what its text is known as one by, an earlier wording's too. */
const INTEGRATION_OPENING = "Here are findings from a review of the plan in fat-g's plan block.";

export const REVIEW_WORDS = Object.freeze({
  /** Send notes' opening (C31). */
  sendNotes: "Here is the user's feedback on the following findings of your review. Where a note asks a question, answer it. Where a note settles a point, send the review again, whole, in the same form as before.",
  /** What a round must be (C29). */
  roundRules: 'keep each finding\'s id where it is the same point; number a new finding after the highest id in its tier; where a finding moves to another tier, give it the next id in that tier and name its earlier id in "was"; send every finding again, refused ones included, leaving out only a finding the discussion showed to be wrong; and close your answer with one fenced code block whose info string is json, matching the schema below, with nothing after it.',
  /**
   * An integration's opening (C10): the block is the route's to place, before it or after it. It asks,
   * as a feedback's request does, a word first and a summary before the revised plan (the maintainer).
   */
  integration: `${INTEGRATION_OPENING} Evaluate each one and write the next version of the plan with the findings you agree with integrated. Before you revise the plan, say in a sentence or two what you take from the findings and how you will go about it. Just before you propose the revised plan, sum up in a few sentences what you changed and why, and which findings you did not take and why, without listing the findings again.`,
  integrationAccepted: 'Findings the user accepted:',
  integrationRefused: 'Findings the user refused, with their note:',
  /** Explain's ask (C34). */
  explain: 'Explain this finding.',
});

/** The schema as a prompt carries it: a fenced `json` block under one line. */
const schemaBlock = (version: number): string => `Findings schema (JSON Schema):\n\n\`\`\`json\n${JSON.stringify(findingsJsonSchema(version), null, 2)}\n\`\`\``;

/** The plan as a review names it (C2). */
const planLine = (title: string, version: number): string => `Plan: ${title}, version ${version}.`;

/**
 * The review's first prompt (C2): the instruction, the plan's title and version, its block with the
 * version's whole text (M22b, C68), the project's folder, and the schema.
 */
export function reviewPrompt(parts: { readonly title: string; readonly planId: string; readonly version: number; readonly text: string; readonly token: string; readonly folder: string; readonly instruction?: number }): string {
  const instruction = parts.instruction ?? REVIEW_INSTRUCTION_VERSION;
  const words = REVIEW_INSTRUCTIONS[instruction];
  if (words === undefined) throw new TypeError('no such instruction');
  return [words, planLine(parts.title, parts.version), planBlock(parts.planId, parts.version, parts.text, parts.token), `Project folder: ${parts.folder}`, schemaBlock(instruction)].join('\n\n');
}

const markOf = (marks: Readonly<Record<string, ReviewMark>>, id: string): string => MARK_WORDS[marks[id] ?? 'open'];
const MARKS_OPENING = "The user's marks so far: ";

/**
 * Send notes (C29, C31): the fixed words; each finding with a note, by its id, its mark and its
 * title, with the note; every finding's mark; the rules of a round; the schema.
 */
export function sendNotesPrompt(parts: { readonly findings: readonly Finding[]; readonly marks: Readonly<Record<string, ReviewMark>>; readonly notes: Readonly<Record<string, string>>; readonly instruction?: number }): string {
  const instruction = parts.instruction ?? REVIEW_INSTRUCTION_VERSION;
  const noted = parts.findings.filter((finding) => (parts.notes[finding.id] ?? '') !== '').map((finding) => `- ${finding.id} (${markOf(parts.marks, finding.id)}), "${finding.title}": ${parts.notes[finding.id] ?? ''}`);
  const marks = `${MARKS_OPENING}${parts.findings.map((finding) => `${finding.id} ${markOf(parts.marks, finding.id)}`).join('; ')}.`;
  return [REVIEW_WORDS.sendNotes, noted.join('\n'), marks, `If you send the review again: ${REVIEW_WORDS.roundRules}`, schemaBlock(instruction)].join('\n\n');
}

const NOTED_LINE = new RegExp(`^- (${ID_PATTERN.slice(1, -1)}) \\((?:${Object.values(MARK_WORDS).join('|')})\\), "`);

/**
 * The ids of the findings a Send notes prompt sent notes on, in its order, as the page names it;
 * null for a prompt that is not one. Read up to the marks' line, so a note's own lines cannot add
 * one past it; a note's line written as a noted line's would only add its id to the name.
 */
export function sentNoteIds(prompt: string): readonly string[] | null {
  if (!prompt.startsWith(`${REVIEW_WORDS.sendNotes}\n\n`)) return null;
  const ids: string[] = [];
  for (const line of prompt.slice(REVIEW_WORDS.sendNotes.length + 2).split('\n')) {
    if (line.startsWith(MARKS_OPENING)) break;
    const id = NOTED_LINE.exec(line)?.[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** A finding as an integration sends it (C10, C38): its id, tier, title, description and correction, and the note in its field. */
function integrated(finding: Finding, note: string): string {
  const tier = finding.tier as Tier;
  const lines = [`- ${finding.id} (T${tier} ${TIER_NAMES[tier]}): ${finding.title}`, `  Description: ${finding.description}`, `  Correction: ${finding.correction}`];
  if (note !== '') lines.push(`  The user's note: ${note}`);
  return lines.join('\n');
}

/**
 * What an integration's target receives beside the block (C10, C38): the fixed instruction, the
 * plan's title and version, the accepted findings each with the note standing in its field, then
 * each refused finding that has one, said refused. The route puts the block before it or after it.
 */
export function integrationText(parts: { readonly title: string; readonly version: number; readonly findings: readonly Finding[]; readonly marks: Readonly<Record<string, ReviewMark>>; readonly notes: Readonly<Record<string, string>> }): string {
  const accepted = parts.findings.filter((finding) => parts.marks[finding.id] === 'accepted').map((finding) => integrated(finding, parts.notes[finding.id] ?? ''));
  const refused = parts.findings.filter((finding) => parts.marks[finding.id] === 'rejected' && (parts.notes[finding.id] ?? '') !== '').map((finding) => `- ${finding.id}: ${finding.title} — refused. The user's note: ${parts.notes[finding.id] ?? ''}`);
  return [REVIEW_WORDS.integration, planLine(parts.title, parts.version), `${REVIEW_WORDS.integrationAccepted}\n${accepted.join('\n')}`, ...(refused.length === 0 ? [] : [`${REVIEW_WORDS.integrationRefused}\n${refused.join('\n')}`])].join('\n\n');
}

const ACCEPTED_LINE = new RegExp(`^- (${ID_PATTERN.slice(1, -1)}) \\(T[1-5] `);
const REFUSED_LINE = new RegExp(`^- (${ID_PATTERN.slice(1, -1)}): .* — refused\\. The user's note: `);

/**
 * The findings an integration's text sent, by their ids in its order, as the page names it: those
 * accepted and those refused with a note; null for a text that is not one. Known by its first
 * sentence, so an earlier wording's reads too; a note's line written as a finding's would only add its
 * id to the name.
 */
export function integrationIds(text: string): { readonly accepted: readonly string[]; readonly refused: readonly string[] } | null {
  if (!text.startsWith(INTEGRATION_OPENING)) return null;
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const line of text.split('\n')) {
    const taken = ACCEPTED_LINE.exec(line)?.[1];
    if (taken !== undefined && !accepted.includes(taken)) accepted.push(taken);
    const left = REFUSED_LINE.exec(line)?.[1];
    if (left !== undefined && !refused.includes(left)) refused.push(left);
  }
  return { accepted, refused };
}

/** A finding as Explain's aside keeps it (C34, C54): its id and title on the first line, which the aside's title is made of, then its fields. */
export function findingExcerpt(finding: Finding): string {
  return cutTo(`${finding.id} ${finding.title}\nExample: ${finding.example}\nDescription: ${finding.description}\nCorrection: ${finding.correction}`, MAX_EXCERPT).text;
}

/** Explain's question (C34), in Explain this's form: the finding named, quoted whole, and the ask. */
export function findingQuestion(finding: Finding): string {
  const quoted = findingExcerpt(finding).split(/\r?\n/).map((part) => (part === '' ? '>' : `> ${part}`)).join('\n');
  return `This is a question beside the conversation, about finding ${finding.id} of your review. Answer it briefly from what the conversation already holds, and take no action.\n\n${quoted}\n\n${REVIEW_WORDS.explain}`;
}

/** The reviewer's name (C26), saying it reviews a plan as the plan's own buttons do: normalized and cut as every name is, by the records' write. */
export const reviewerName = (title: string, version: number): string => `Review of ${planNamed(title)} v${version}`;

// ── A review as main answers it (C6, C7, C12, C24, C33, C41) ──────────────────────────────────

/**
 * `closed` (decision 0029, the shared workflow): a review is a hard stop on its plan until it is
 * cancelled, concluded with no change, or handed to an integration — each of which closes it for
 * good. A later review of the plan is a record of its own.
 */
export const REVIEW_STATES = ['running', 'findings', 'failed', 'closed'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** How a review closed: cancelled from either side, concluded with no change, or handed to an integration. */
export const REVIEW_CLOSURES = ['cancelled', 'concluded', 'handed'] as const;
export type ReviewClosure = (typeof REVIEW_CLOSURES)[number];

/** Why a review failed, or why a later turn brought no round (C5, C25, C27). */
export const REVIEW_REASONS = [
  ...ROUND_FAILURES,
  /** A finding past a length an earlier build took: what its records may hold, and no build gives now (the maintainer). */
  'over-bound',
  'no-answer', 'turn-failed', 'stopped', 'interrupted', 'refused',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

export const REVIEW_TURN_KINDS = ['review', 'notes'] as const;
export type ReviewTurnKind = (typeof REVIEW_TURN_KINDS)[number];
/** What became of a turn started for a review (C25, C49). */
export const REVIEW_TURN_OUTCOMES = ['waiting', 'asked', 'round', 'no-round', 'failed'] as const;
export type ReviewTurnOutcome = (typeof REVIEW_TURN_OUTCOMES)[number];

/** How an integration reaches its target (C11): the feedback of a decision that waits, or a plan turn. */
export const INTEGRATION_ROUTES = ['decision', 'plan-turn'] as const;
export type IntegrationRoute = (typeof INTEGRATION_ROUTES)[number];
export const INTEGRATION_STATES = ['sent', 'integrated', 'ended'] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];
/** Why an integration ended without a version (C27, C45). `removed`: its target session was removed meanwhile. */
export const INTEGRATION_REASONS = ['no-plan', 'withdrawn', 'dropped', 'refused', 'interrupted', 'removed'] as const;
export type IntegrationReason = (typeof INTEGRATION_REASONS)[number];

export interface ReviewTurnView {
  readonly turnId: string;
  /** Its prompt's item id, under which a turn that ended with no answer says so (C55); null for a card's answer's turn. */
  readonly promptId: string | null;
  readonly kind: ReviewTurnKind;
  readonly outcome: ReviewTurnOutcome;
  readonly reason: ReviewReason | null;
  /** The answer's item id, fat-g's own (C43): where its round, or its notice, stands. */
  readonly answerId: string | null;
  /** The asked turn this one carries on, for a turn a card's answer started (C49). */
  readonly continues: string | null;
}

export interface ReviewRoundView {
  /** The turn whose answer brought it, and that answer's item. */
  readonly turnId: string;
  readonly answerId: string;
  readonly appraisal: string;
  readonly findings: readonly Finding[];
  /** The marks it stands with: the live ones for the latest round, frozen as the next came for an earlier one. */
  readonly marks: Readonly<Record<string, ReviewMark>>;
  /** Its notes: those standing for the latest round, those sent on it for an earlier one. */
  readonly notes: Readonly<Record<string, string>>;
  /** The findings this round revised (C29). */
  readonly revised: readonly string[];
  readonly live: boolean;
}

export interface IntegrationView {
  readonly integrationId: string;
  readonly sessionId: string;
  /** The target's name, where it is listed; null once it is removed. */
  readonly chat: string | null;
  readonly route: IntegrationRoute;
  readonly state: IntegrationState;
  readonly reason: IntegrationReason | null;
  readonly accepted: readonly string[];
  readonly produced: number | null;
  readonly at: number;
}

/** A target of Integrate (C9, C50): by the route its delivery takes, or unavailable with its reason in words. */
export interface IntegrationOffer {
  readonly target: { readonly sessionId: string } | 'new';
  readonly name: string | null;
  /** The plan's own session, the chat that started the review, another chat taking part in the plan (decision 0029), the reviewer's, a new one. */
  readonly roles: readonly ('own' | 'started' | 'participant' | 'reviewer' | 'new')[];
  readonly route: IntegrationRoute | null;
  readonly reason: string | null;
}

/** A finding's anchor found in the reviewed version's text (C41): the line it stands at, from 1, or null where it was not found. */
export type AnchorPlace = { readonly line: number } | null;

export interface ReviewView {
  readonly reviewId: string;
  readonly planId: string;
  readonly version: number;
  readonly reviewer: { readonly sessionId: string; readonly providerId: string; readonly instanceId: string; readonly model: string; readonly effort: string | null; readonly chat: string | null };
  readonly startedFrom: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly state: ReviewState;
  readonly failure: ReviewReason | null;
  readonly staleBy: number | null;
  /** How it closed, for a `closed` review. */
  readonly closed: ReviewClosure | null;
  /** The instruction's version the answers are read under. */
  readonly instruction: number;
  readonly turns: readonly ReviewTurnView[];
  readonly rounds: readonly ReviewRoundView[];
  readonly integrations: readonly IntegrationView[];
  /** Not closed, not stale, and no integration of it `sent`: the review's marks, notes and rounds can still change. */
  readonly live: boolean;
  /** Concluding it returns the plan unchanged (the maintainer): its latest round found nothing, or every finding is refused. */
  readonly concludable: boolean;
  /** Integrate's targets, worked out at this read and again at the press (C9); empty where the review is not live. */
  readonly offers: readonly IntegrationOffer[];
  /** The latest round's anchors, by finding (C41). */
  readonly anchors: Readonly<Record<string, AnchorPlace>>;
  /** What Integrate would send of the findings and notes now, in UTF-16 units (C10). */
  readonly integrationUnits: number;
}

/** A plan's review as its line and tab name it (C12). */
export interface ReviewSummary {
  readonly reviewId: string;
  readonly version: number;
  readonly state: ReviewState;
  readonly staleBy: number | null;
  /** How it closed, for a `closed` review (0029). */
  readonly closed: ReviewClosure | null;
  readonly accepted: number;
  readonly waiting: number;
  /** The latest round's findings; 0 before a round, and for a review that found nothing. */
  readonly findings: number;
  readonly integrating: boolean;
  readonly reviewer: { readonly sessionId: string; readonly chat: string | null };
  readonly startedAt: number;
}

/** A review's push (C44): ids alone, and the page reads again. */
export interface ReviewPush {
  readonly reviewId: string;
  readonly planId: string;
  readonly sessionId: string;
}

// ── The channels (C44) ────────────────────────────────────────────────────────────────────────

const sessionId = z.guid();
const reviewId = ReviewIdSchema;
const mark = z.enum(REVIEW_MARKS);
const offset = z.number().int().min(0).max(100_000_000);

/**
 * A start names the workflow's revision the page drew its panel from (decision 0029): a stale one starts
 * nothing. The reviewer runs on the preset the user chose, of any account the project is offered to.
 */
export const ReviewStartRequestSchema = z.strictObject({ sessionId, planId: PlanIdSchema, version: PlanVersionSchema, revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), preset: ModelPresetSchema });
export const ReviewMarkRequestSchema = z.union([
  z.strictObject({ reviewId, findingId: FindingIdSchema, mark }),
  z.strictObject({ reviewId, tier: z.number().int().min(1).max(5), mark }),
]);
export const ReviewNoteRequestSchema = z.strictObject({ reviewId, findingId: FindingIdSchema, note: z.string().max(REVIEW_BOUNDS.note) });
export const ReviewSendRequestSchema = z.strictObject({ reviewId });
export const ReviewExplainRequestSchema = z.strictObject({
  reviewId,
  findingId: FindingIdSchema,
  /** Where the finding's row lies in the answer's drawing, and the digest of its text there (C54). */
  place: z.strictObject({ range: z.strictObject({ start: offset, end: offset }).refine((value) => value.end >= value.start, 'end before start'), digest: z.string().regex(/^[0-9a-f]{8}$/) }),
});
/** A listed chat, or a new session on the preset the user chose for it. */
export const ReviewIntegrateRequestSchema = z.strictObject({ reviewId, target: z.union([z.strictObject({ sessionId }), z.strictObject({ preset: ModelPresetSchema })]) });
/** Cancel review, from the reviewer or a chat of the plan; or conclude it with no change (decision 0029). */
export const ReviewCloseRequestSchema = z.strictObject({ reviewId, as: z.enum(['cancel', 'conclude']) });
export const ReviewReadRequestSchema = z.union([z.strictObject({ reviewId }), z.strictObject({ planId: PlanIdSchema }), z.strictObject({ sessionId })]);

export type ReviewStartRequest = z.infer<typeof ReviewStartRequestSchema>;
export type ReviewMarkRequest = z.infer<typeof ReviewMarkRequestSchema>;
export type ReviewNoteRequest = z.infer<typeof ReviewNoteRequestSchema>;
export type ReviewSendRequest = z.infer<typeof ReviewSendRequestSchema>;
export type ReviewExplainRequest = z.infer<typeof ReviewExplainRequestSchema>;
export type ReviewIntegrateRequest = z.infer<typeof ReviewIntegrateRequestSchema>;
export type ReviewCloseRequest = z.infer<typeof ReviewCloseRequestSchema>;
export type ReviewReadRequest = z.infer<typeof ReviewReadRequestSchema>;

/** The preset refusals, as a start of a reviewer or of a new integration target says them. */
const PRESET_REFUSALS = ['provider-not-offered', 'provider-unavailable', 'instance-unavailable', 'model-not-listed', 'effort-not-listed', 'speed-not-listed', 'speed-unavailable'] as const satisfies readonly PresetRefusal[];

/** Why a review did not start (C1, C52), besides the send's own. */
export const REVIEW_START_REFUSALS = [
  'unknown-session',
  /** The chat takes no part in that plan, or its workflow is not ready on that version. */
  'not-pending',
  /** The workflow changed since the page drew it, or another operation holds the plan (decision 0029). */
  'locked',
  'not-complete',
  /** The plan has a newer complete version (C52). */
  'stale',
  'not-connected',
  /** The provider lists no reading mode, or the account cannot use it. */
  'mode-unavailable',
  'records-refused',
  'storage-failed',
  /** fat-g is quitting, or a start is already under way. */
  'busy',
  /** The chosen preset, which a start would refuse as `sessions:create` does (decision 0016). */
  ...PRESET_REFUSALS,
] as const;
/** Why a mark, a note or the panel was not written. `not-live`: the review is stale, integrating, or has no round. */
export const REVIEW_WRITE_REFUSALS = ['unknown-review', 'unknown-finding', 'not-live', 'storage-failed'] as const;
/** Why Send notes was not sent (C31, C49), besides the send's own. */
export const REVIEW_SEND_REFUSALS = ['unknown-review', 'not-live', 'all-decided', 'no-note', 'turn-waiting', 'storage-failed'] as const;
/** Why an integration was not sent (C24, C47, C49, C50), besides the send's own. */
export const REVIEW_INTEGRATE_REFUSALS = ['unknown-review', 'not-live', 'undecided', 'none-accepted', 'integrating', 'stale', 'too-long', 'unavailable', 'turn-waiting', 'busy', 'records-refused', 'storage-failed', ...PRESET_REFUSALS] as const;
export const REVIEW_EXPLAIN_REFUSALS = ['unknown-review', 'unknown-finding'] as const;

export type ReviewStartRefusal = (typeof REVIEW_START_REFUSALS)[number];
export type ReviewWriteRefusal = (typeof REVIEW_WRITE_REFUSALS)[number];
export type ReviewSendRefusal = (typeof REVIEW_SEND_REFUSALS)[number];
export type ReviewIntegrateRefusal = (typeof REVIEW_INTEGRATE_REFUSALS)[number];
export type ReviewExplainRefusal = (typeof REVIEW_EXPLAIN_REFUSALS)[number];

type Refused<Reason extends string> = { readonly status: 'refused'; readonly reason: Reason };

export type ReviewStartResult = { readonly status: 'started'; readonly reviewId: string; readonly sessionId: string } | Refused<ReviewStartRefusal | SendRefusal | SendBlock>;
export type ReviewMarkResult = { readonly status: 'saved'; readonly marks: Readonly<Record<string, ReviewMark>> } | Refused<ReviewWriteRefusal>;
export type ReviewNoteResult = { readonly status: 'saved' } | Refused<ReviewWriteRefusal>;
export type ReviewSendResult = { readonly status: 'sent' } | Refused<ReviewSendRefusal | SendRefusal | SendBlock>;
export type ReviewExplainResult = { readonly status: 'accepted'; readonly asideId: string } | Refused<ReviewExplainRefusal | AskRefusal | SendBlock>;
/** `too-long` says by how much (C10); `unavailable`, the target's reason in words (C9, C50). */
export type ReviewIntegrateResult =
  | { readonly status: 'sent'; readonly integrationId: string; readonly sessionId: string }
  | (Refused<ReviewIntegrateRefusal | SendRefusal | SendBlock> & { readonly excess?: number; readonly words?: string });
/**
 * Why a review was not closed: `not-open` — it closed already, failed, or no longer holds its plan;
 * `not-concludable` — a finding is open or accepted; `busy` — fat-g is quitting, or the review is being closed.
 */
export const REVIEW_CLOSE_REFUSALS = ['unknown-review', 'not-open', 'not-concludable', 'busy', 'storage-failed'] as const;
export type ReviewCloseRefusal = (typeof REVIEW_CLOSE_REFUSALS)[number];
export type ReviewCloseResult = { readonly status: 'closed' } | Refused<ReviewCloseRefusal>;
export type ReviewReadResult =
  | { readonly status: 'read'; readonly review: ReviewView }
  | { readonly status: 'listed'; readonly reviews: readonly ReviewSummary[] }
  | { readonly status: 'session'; readonly review: ReviewView | null }
  | Refused<'unknown-review' | 'storage-failed'>;
