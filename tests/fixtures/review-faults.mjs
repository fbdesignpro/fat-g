// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The faults of a review's answer (docs/planning/_archive/M22e.md, Design 9; C42, C46, C48): each a captured
// answer of K2's with one named change to its text, which both replay fakes send in place of the
// captured text — the first delta bringing all of it, and the completing frame the same, as their
// `answerText` control does. Plain Node; nothing here is application code.
//
// How a review prompt and a Send notes prompt are known, too: by the first sentence of fat-g's
// instruction and `"const": 2` in its schema, and by Send notes' first sentence — never by the
// whole prompt, which holds a plan id, a token and a folder of the run's own (C42).
//
// And what the captures' own reads held: K1 and K2 ran in a scratch folder written from
// project-files.mjs, its marker sentences included, so the files their agents read carry the
// markers into the captures. The fakes replay those reads with each marker made neutral, so that a
// marker anywhere in fat-g's data folder is still a file's text that fat-g showed and kept (M19b,
// C33): what the reviewer read is the capture's, and is kept in the conversation store.
import { FILE_MARKERS } from './project-files.mjs';

/** The first sentence of a review's instruction (src/shared/contracts/plans.ts, PLAN_WORDS.reviewOpening). */
export const REVIEW_OPENING = 'Review the plan in the block below before anyone implements it.';
/** Send notes' first sentence (src/shared/contracts/review.ts, REVIEW_WORDS.sendNotes). */
export const SEND_NOTES_OPENING = "Here is the user's feedback on the following findings of your review.";
/** An integration's first sentence (REVIEW_WORDS.integration): before the block in a plan turn, after it in a brought plan's feedback. */
export const INTEGRATION_OPENING = "Here are findings from a review of the plan in fat-g's plan block.";

/** A review capture's text with each file marker made neutral, as the fakes replay it. */
export const unmarked = (text) => FILE_MARKERS.reduce((held, marker) => held.replaceAll(marker, 'the spike folder’s marker'), text);

/** A review prompt of fat-g's, asked under version 2 of its instruction. */
export const isReviewPrompt = (text) => typeof text === 'string' && text.startsWith(REVIEW_OPENING) && text.includes('"const": 2');
export const isSendNotes = (text) => typeof text === 'string' && text.startsWith(SEND_NOTES_OPENING);
export const isIntegration = (text) => typeof text === 'string' && text.includes(INTEGRATION_OPENING);

/** The faults that change the review's first answer, and those that change a later one. */
export const FIRST_ANSWER_FAULTS = ['review-no-block', 'review-invalid', 'review-set-aside', 'review-two-blocks', 'review-long', 'review-unclosed'];
export const LATER_ANSWER_FAULTS = ['review-prose-only', 'review-drop', 'review-renumber', 'review-ambiguous'];

/** The answer's last `json` block, where it lies, and its content parsed. */
function lastBlock(text) {
  const opening = text.lastIndexOf('```json');
  if (opening === -1) return null;
  const contentAt = text.indexOf('\n', opening) + 1;
  const closing = text.indexOf('\n```', contentAt);
  if (closing === -1) return null;
  return { before: text.slice(0, opening), content: JSON.parse(text.slice(contentAt, closing)), after: text.slice(closing + 4), fence: text.slice(opening, closing + 4) };
}
const fenced = (value) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/** The highest number of a tier's ids in a round. */
const highest = (issues, tier) => issues.filter((issue) => issue.tier === tier).reduce((most, issue) => Math.max(most, Number(issue.id.split('.')[1])), 0);

/** A captured answer, one named change made to it; the answer as it was where the fault does not apply to it. */
export function faulted(name, text) {
  const block = lastBlock(text);
  if (block === null) return text;
  const { before, content, after, fence } = block;
  const issues = content.issues ?? [];
  const withIssues = (changed) => `${before}${fenced({ ...content, issues: changed })}${after}`;
  switch (name) {
    // Its prose alone: the block taken out.
    case 'review-no-block':
    case 'review-prose-only':
      return `${before.trimEnd()}${after}`.trim() === '' ? 'The review is above, in prose.' : `${before.trimEnd()}${after}`;
    // The block's JSON broken: its last brace taken out. No round.
    case 'review-invalid':
      return `${before}${fence.replace(/\}\s*\n```$/, '\n```')}${after}`;
    // One field removed from its first finding: that finding set aside, the rest a round (the maintainer).
    case 'review-set-aside': {
      const [first, ...rest] = issues;
      if (first === undefined) return text;
      const { correction: _removed, ...kept } = first;
      return withIssues([kept, ...rest]);
    }
    case 'review-two-blocks':
      return `${text.trimEnd()}\n\n${fence}`;
    // Past every length and count the prompt asks: one correction of 601 units, and findings up to 33 in tier 5. A round all the same.
    case 'review-long': {
      const [first, ...rest] = issues;
      if (first === undefined) return text;
      const more = Array.from({ length: Math.max(0, 33 - issues.length) }, (_, n) => ({ ...first, id: `T5.${highest(issues, 5) + n + 1}`, tier: 5, was: undefined }));
      return withIssues([{ ...first, correction: 'x'.repeat(601) }, ...rest, ...more]);
    }
    // Its closing fence removed: CommonMark reads the block to the message's end (C48).
    case 'review-unclosed':
      return `${before}${fence.slice(0, -4)}${after}`.replace(/\s+$/, '');
    // A later round that leaves a finding out.
    case 'review-drop':
      return issues.length === 0 ? text : withIssues(issues.slice(1));
    // A kept finding given a new id with no `was`: one no round before it held either.
    case 'review-renumber': {
      const [first, ...rest] = issues;
      if (first === undefined) return text;
      const { was: _was, ...kept } = first;
      return withIssues([{ ...kept, id: `T${first.tier}.${highest(issues, first.tier) + 90}` }, ...rest]);
    }
    // Two findings naming one `was`, and a third naming in `was` an id the round also keeps (C46).
    case 'review-ambiguous': {
      if (issues.length < 3) return text;
      const named = issues.find((issue) => typeof issue.was === 'string')?.was ?? issues[0].id;
      const changed = issues.map((issue, n) => {
        if (n === 0 && issue.id !== named) return { ...issue, was: named };
        if (n === 1 && issue.id !== named) return { ...issue, was: named };
        if (n === 2) return { ...issue, was: issues[0].id === issue.id ? issues[1].id : issues[0].id };
        return issue;
      });
      return withIssues(changed);
    }
    default:
      return text;
  }
}
