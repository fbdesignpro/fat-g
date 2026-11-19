// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Plan review's contract (docs/planning/_archive/M22e.md, Design 1; V3, V4; C4, C5, C29, C31, C34, C46, C48): the
// parser's verdicts, carrying a round's marks, and the prompts fat-g composes, exact. The answers K1
// and K2 captured, and the faults made of them, are read in tests/chat/review-answers.test.ts.
import { describe, expect, it } from 'vitest';
import { planBlock, PLAN_WORDS, readPlanPrompt } from './plans';
import {
  carryRound,
  checkFindings,
  type Finding,
  findingExcerpt,
  findingQuestion,
  findingsJsonSchema,
  integrationIds,
  integrationText,
  keepSetAside,
  readFindings,
  REVIEW_INSTRUCTION_VERSION,
  REVIEW_INSTRUCTIONS,
  REVIEW_WORDS,
  reviewerName,
  reviewPrompt,
  sendNotesPrompt,
  sentNoteIds,
  setAsideShown,
} from './review';

describe('the parser (C5, C48; V3)', () => {
  it('reads the last json block, a tilde fence and a block’s case included, and passes over other fences', () => {
    const block = JSON.stringify({ version: 2, appraisal: 'One line.', issues: [] });
    expect(readFindings(`Text.\n\n~~~JSON\n${block}\n~~~\n`, 2).verdict).toBe('findings');
    expect(readFindings(`\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`json\n${block}\n\`\`\``, 2)).toMatchObject({ verdict: 'findings', before: '```ts\nconst a = 1;\n```' });
    // A failed block before the last one does not count against it; the last decides.
    expect(readFindings(`\`\`\`json\n{"no": 1}\n\`\`\`\n\n\`\`\`json\n${block}\n\`\`\``, 2).verdict).toBe('findings');
    expect(readFindings(`\`\`\`json\n${block}\n\`\`\`\n\n\`\`\`json\n{"no": 1}\n\`\`\``, 2).verdict).toBe('invalid');
    // A fence inside a longer fence is its content, and a CRLF answer reads as an LF one.
    expect(readFindings(`\`\`\`\`md\n\`\`\`json\n${block}\n\`\`\`\n\`\`\`\``, 2).verdict).toBe('no-block');
    expect(readFindings(`A.\r\n\r\n\`\`\`json\r\n${block}\r\n\`\`\`\r\n`, 2).verdict).toBe('findings');
  });

  // The maintainer: what the prompt asks is no bound a block is refused for, and one
  // finding that does not read is set aside with why, the rest of its round standing.
  const issue = { id: 'T1.1', tier: 1, category: 'PROD', title: 'T', example: 'E', description: 'D', correction: 'C' };
  const block = (issues: readonly unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ version: 2, appraisal: 'A', issues, ...extra });

  it('reads a block past every length and count the prompt asks, the appraisal of any length', () => {
    const long = 'x'.repeat(5000);
    const many = Array.from({ length: 40 }, (_, n) => ({ ...issue, id: `T1.${n + 1}`, title: long, example: long, description: long, correction: long, anchor: { heading: long, quote: long } }));
    const checked = checkFindings(block(many, { appraisal: long }), 2);
    expect(checked.ok && checked.block.issues.length).toBe(40);
    expect(checked.ok && checked.block.appraisal).toBe(long);
    expect(checked.ok && checked.setAside).toEqual([]);
  });

  it.each([
    ['no object', 'not an issue', null, 'not-finding'],
    ['no id', { ...issue, id: undefined }, null, 'id'],
    ['an id that is no T<tier>.<n>', { ...issue, id: 'T6.1' }, null, 'id'],
    ['a tier its id does not name', { ...issue, tier: 2 }, 'T1.1', 'tier'],
    ['a tier that is text', { ...issue, tier: '1' }, 'T1.1', 'tier'],
    ['an unknown category', { ...issue, category: 'DOCS' }, 'T1.1', 'category'],
    ['no title', { ...issue, title: undefined }, 'T1.1', 'title'],
    ['an empty example', { ...issue, example: '' }, 'T1.1', 'example'],
    ['a description that is no text', { ...issue, description: 3 }, 'T1.1', 'description'],
    ['no correction', { ...issue, correction: undefined }, 'T1.1', 'correction'],
  ] as const)('sets aside a finding with %s, and reads the rest', (_, bad, id, problem) => {
    const checked = checkFindings(block([{ ...issue, id: 'T2.1', tier: 2 }, bad]), 2);
    expect(checked.ok && checked.block.issues.map((one) => one.id)).toEqual(['T2.1']);
    expect(checked.ok && checked.setAside).toEqual([{ position: 2, id, problem }]);
  });

  it('keeps the first of two findings that give one id, and sets the second aside', () => {
    const checked = checkFindings(block([{ ...issue, correction: undefined }, issue, { ...issue, title: 'Again' }]), 2);
    expect(checked.ok && checked.block.issues).toEqual([issue]);
    expect(checked.ok && checked.setAside).toEqual([{ position: 1, id: 'T1.1', problem: 'correction' }, { position: 3, id: 'T1.1', problem: 'repeated' }]);
  });

  it('drops a field the contract does not hold, an anchor or a `was` that does not read, and folds the appraisal onto one line', () => {
    const checked = checkFindings(block([{ ...issue, extra: 1, anchor: { heading: 'H' } }, { ...issue, id: 'T2.1', tier: 2, was: 'later', anchor: { heading: 'H', quote: 'Q', page: 3 } }], { appraisal: 'One.\r\n  Two.\n', extra: 1 }), 2);
    expect(checked.ok && checked.block).toEqual({ version: 2, appraisal: 'One. Two.', issues: [issue, { ...issue, id: 'T2.1', tier: 2, anchor: { heading: 'H', quote: 'Q' } }] });
    expect(checked.ok && checked.setAside).toEqual([]);
    // A block with no appraisal is a round all the same, with none.
    const bare = checkFindings(JSON.stringify({ version: 2, issues: [issue] }), 2);
    expect(bare.ok && bare.block.appraisal).toBe('');
  });

  it('brings no round for a block that is no JSON, no object, of another version or with no list, or whose findings none reads', () => {
    const problem = (content: string): string => { const checked = checkFindings(content, 2); return checked.ok ? 'ok' : `${checked.refusal} ${checked.problem}`; };
    expect(problem('{"version": 2, "issues": [')).toBe('invalid json');
    expect(problem('[1, 2]')).toBe('invalid shape');
    expect(problem(JSON.stringify({ version: 1, appraisal: 'A', issues: [issue] }))).toBe('invalid version');
    expect(problem(JSON.stringify({ version: 2, appraisal: 'A', issues: {} }))).toBe('invalid issues');
    expect(problem(block([{ ...issue, tier: 3 }, 'x']))).toBe('invalid none-read');
    const none = checkFindings(block([{ ...issue, tier: 3 }]), 2);
    expect(!none.ok && none.setAside).toEqual([{ position: 1, id: 'T1.1', problem: 'tier' }]);
    // An empty list is a round with no findings, as a review that finds nothing gives.
    expect(problem(block([]))).toBe('ok');
  });

  it('says in its reading what a round’s answer set aside, and why an answer brought none', () => {
    const fenced = (content: string): string => `Text.\n\n\`\`\`json\n${content}\n\`\`\``;
    expect(readFindings(fenced(block([issue, 'x'])), 2)).toMatchObject({ verdict: 'findings', setAside: [{ position: 2, id: null, problem: 'not-finding' }] });
    expect(readFindings(fenced('{'), 2)).toEqual({ verdict: 'invalid', problem: 'json', setAside: [] });
  });
});

const finding = (id: string, patch: Partial<Finding> = {}): Finding => ({ id, tier: Number(id.charAt(1)), category: 'PROD', title: `Title ${id}`, example: `Example ${id}.`, description: `Description ${id}.`, correction: `Correction ${id}.`, ...patch });

describe('carrying a round (C29, C46; V3)', () => {
  it('carries by id and by `was`, marks a revised finding, opens a new one and withdraws one left out', () => {
    const before = [finding('T1.1'), finding('T1.2'), finding('T2.1'), finding('T3.1')];
    const after = [finding('T1.1'), finding('T2.1', { title: 'Changed' }), finding('T2.2', { was: 'T1.2' }), finding('T4.1')];
    const { carried, withdrawn } = carryRound(before, after, { 'T1.1': 'accepted', 'T1.2': 'rejected', 'T2.1': 'accepted' }, { 'T1.2': 'a note' });
    expect(carried).toEqual([
      { id: 'T1.1', from: 'T1.1', mark: 'accepted', note: '', revised: false },
      { id: 'T2.1', from: 'T2.1', mark: 'accepted', note: '', revised: true },
      { id: 'T2.2', from: 'T1.2', mark: 'rejected', note: 'a note', revised: true },
      { id: 'T4.1', from: null, mark: 'open', note: '', revised: false },
    ]);
    expect(withdrawn).toEqual(['T3.1']);
  });

  it('lets a repeated `was`, naming an id the round before no longer holds, carry by id (K2)', () => {
    const before = [finding('T1.1'), finding('T2.2', { was: 'T1.2' })];
    const { carried } = carryRound(before, [finding('T1.1'), finding('T2.2', { was: 'T1.2' })], { 'T2.2': 'accepted' }, {});
    expect(carried[1]).toMatchObject({ from: 'T2.2', mark: 'accepted' });
  });

  it('carries nothing twice: a `was` two findings name, or one beside the id it names kept, counts for nothing (review-ambiguous)', () => {
    const before = [finding('T1.1'), finding('T1.2'), finding('T2.1')];
    const after = [finding('T2.2', { was: 'T1.1' }), finding('T2.3', { was: 'T1.1' }), finding('T1.2'), finding('T3.1', { was: 'T1.2' })];
    const { carried, withdrawn } = carryRound(before, after, { 'T1.1': 'accepted', 'T1.2': 'accepted' }, {});
    expect(carried.filter((one) => one.mark === 'accepted').map((one) => one.id)).toEqual(['T1.2']);
    expect(carried.find((one) => one.id === 'T3.1')?.from).toBeNull();
    expect(withdrawn).toEqual(['T1.1', 'T2.1']);
  });

  it('makes every finding new where a round renumbers silently (review-renumber), and withdraws one dropped (review-drop)', () => {
    const before = [finding('T1.1'), finding('T2.1')];
    expect(carryRound(before, [finding('T1.2', { title: 'Title T1.1' }), finding('T2.1')], { 'T1.1': 'accepted' }, {}).carried[0]).toMatchObject({ from: null, mark: 'open' });
    expect(carryRound(before, [finding('T2.1')], {}, {}).withdrawn).toEqual(['T1.1']);
  });

  // The maintainer: a finding sent again but unreadable stands as the round before had it.
  it('puts back a set-aside finding as the round before held it, with its mark and note, unrevised, carried by its own id', () => {
    const before = [finding('T1.1'), finding('T2.2', { was: 'T1.2' }), finding('T3.1')];
    const read = [finding('T1.1', { title: 'Changed' })];
    const setAside = [{ position: 2, id: 'T2.2', problem: 'correction' as const }, { position: 3, id: null, problem: 'id' as const }];
    const after = keepSetAside(before, read, setAside);
    expect(after).toEqual([finding('T1.1', { title: 'Changed' }), finding('T2.2')]);
    const { carried, withdrawn } = carryRound(before, after, { 'T2.2': 'accepted' }, { 'T2.2': 'a note' });
    expect(carried[1]).toEqual({ id: 'T2.2', from: 'T2.2', mark: 'accepted', note: 'a note', revised: false });
    expect(withdrawn).toEqual(['T3.1']);
  });

  it('puts back none that a finding of the round holds, or names in `was`, nor one the round before did not hold', () => {
    const before = [finding('T1.1'), finding('T1.2'), finding('T2.1')];
    const read = [finding('T1.1'), finding('T3.1', { was: 'T1.2' })];
    const setAside = [{ position: 3, id: 'T1.1', problem: 'repeated' as const }, { position: 4, id: 'T1.2', problem: 'title' as const }, { position: 5, id: 'T4.1', problem: 'title' as const }];
    expect(keepSetAside(before, read, setAside)).toEqual(read);
  });

  it('says which set-aside findings a round shows as before, and which it leaves out', () => {
    const setAside = [{ position: 1, id: 'T2.2', problem: 'correction' as const }, { position: 2, id: 'T1.1', problem: 'repeated' as const }, { position: 3, id: null, problem: 'id' as const }, { position: 4, id: 'T4.1', problem: 'title' as const }];
    expect(setAsideShown(setAside, [finding('T1.1')], [finding('T1.1'), finding('T2.2')])).toEqual({ leftOut: [setAside[1], setAside[2], setAside[3]], kept: ['T2.2'] });
  });
});

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const TOKEN = '0123456789ab';

describe('the prompts fat-g composes (C2, C10, C31, C34, C38; V4)', () => {
  it('opens the instruction with the sentence a history reads a review by, and asks version 2’s anchor', () => {
    const words = REVIEW_INSTRUCTIONS[2] ?? '';
    expect(words.startsWith(PLAN_WORDS.reviewOpening)).toBe(true);
    expect(words).toContain("Wherever an issue concerns one place in the plan, anchor it by the plan's heading there and a short phrase quoted from it.");
    expect(REVIEW_INSTRUCTION_VERSION).toBe(2);
  });

  it('composes the review’s prompt: the instruction, the plan, its block, the folder, the schema', () => {
    const prompt = reviewPrompt({ title: 'Tides', planId: ID, version: 3, text: '# Tides\n\n1. Do.', token: TOKEN, folder: 'C:\\work\\tides' });
    expect(prompt).toBe([
      REVIEW_INSTRUCTIONS[2],
      'Plan: Tides, version 3.',
      planBlock(ID, 3, '# Tides\n\n1. Do.', TOKEN),
      'Project folder: C:\\work\\tides',
      `Findings schema (JSON Schema):\n\n\`\`\`json\n${JSON.stringify(findingsJsonSchema(2), null, 2)}\n\`\`\``,
    ].join('\n\n'));
    // A history reads it back as a review's, naming the plan.
    expect(readPlanPrompt(prompt)).toEqual({ planId: ID, version: 3, intent: 'review' });
    expect(prompt).toContain('"const": 2');
  });

  it('composes Send notes: the words, each noted finding, every mark, the round’s rules and the schema', () => {
    const findings = [finding('T1.1'), finding('T2.1'), finding('T3.1')];
    const prompt = sendNotesPrompt({ findings, marks: { 'T1.1': 'accepted', 'T3.1': 'rejected' }, notes: { 'T2.1': 'Why T2?' } });
    expect(prompt.split('\n\n').slice(0, 4)).toEqual([
      REVIEW_WORDS.sendNotes,
      '- T2.1 (undecided), "Title T2.1": Why T2?',
      "The user's marks so far: T1.1 accepted; T2.1 undecided; T3.1 refused.",
      `If you send the review again: ${REVIEW_WORDS.roundRules}`,
    ]);
    expect(prompt.endsWith('```')).toBe(true);
  });

  it('reads back the ids a Send notes prompt sent notes on, a note’s own lines adding none past the marks', () => {
    const findings = [finding('T1.1'), finding('T2.1'), finding('T3.1')];
    const prompt = sendNotesPrompt({ findings, marks: { 'T1.1': 'accepted' }, notes: { 'T1.1': 'Shorter.\nAnd plainer.', 'T3.1': 'Why?' } });
    expect(sentNoteIds(prompt)).toEqual(['T1.1', 'T3.1']);
    expect(sentNoteIds(sendNotesPrompt({ findings, marks: {}, notes: {} }))).toEqual([]);
    expect(sentNoteIds('Why is T1.1 here?')).toBeNull();
  });

  it('composes the integration’s text: the accepted findings with their notes, then the refused ones that have one (C38)', () => {
    const findings = [finding('T1.1'), finding('T2.1'), finding('T3.1'), finding('T4.1')];
    const text = integrationText({ title: 'Tides', version: 2, findings, marks: { 'T1.1': 'accepted', 'T2.1': 'accepted', 'T3.1': 'rejected', 'T4.1': 'rejected' }, notes: { 'T2.1': 'Keep it short.', 'T3.1': 'Out of scope.' } });
    expect(text).toBe([
      REVIEW_WORDS.integration,
      'Plan: Tides, version 2.',
      `${REVIEW_WORDS.integrationAccepted}\n- T1.1 (T1 Critical): Title T1.1\n  Description: Description T1.1.\n  Correction: Correction T1.1.\n- T2.1 (T2 Serious): Title T2.1\n  Description: Description T2.1.\n  Correction: Correction T2.1.\n  The user's note: Keep it short.`,
      `${REVIEW_WORDS.integrationRefused}\n- T3.1: Title T3.1 — refused. The user's note: Out of scope.`,
    ].join('\n\n'));
  });

  // The maintainer: the page folds an integration's prompt to one line naming what it sent.
  it('reads back the findings an integration’s text sent, an earlier wording’s too, and nothing from another prompt', () => {
    const findings = [finding('T1.1'), finding('T2.1'), finding('T3.1'), finding('T4.1')];
    const text = integrationText({ title: 'Tides', version: 2, findings, marks: { 'T1.1': 'accepted', 'T2.1': 'accepted', 'T3.1': 'rejected', 'T4.1': 'rejected' }, notes: { 'T2.1': 'Keep it short.', 'T3.1': 'Out of scope.' } });
    expect(integrationIds(text)).toEqual({ accepted: ['T1.1', 'T2.1'], refused: ['T3.1'] });
    const earlier = text.replace(REVIEW_WORDS.integration, "Here are findings from a review of the plan in fat-g's plan block. Evaluate each one, write the next version of the plan with the findings you agree with integrated, and say which findings you did not take and why.");
    expect(integrationIds(earlier)).toEqual({ accepted: ['T1.1', 'T2.1'], refused: ['T3.1'] });
    expect(integrationIds(sendNotesPrompt({ findings, marks: {}, notes: { 'T1.1': 'Why?' } }))).toBeNull();
    expect(integrationIds('- T1.1 (T1 Critical): Title T1.1')).toBeNull();
  });

  it('composes Explain’s question in Explain this’s form, its excerpt’s first line the id and the title', () => {
    const one = finding('T2.1');
    expect(findingExcerpt(one)).toBe('T2.1 Title T2.1\nExample: Example T2.1.\nDescription: Description T2.1.\nCorrection: Correction T2.1.');
    expect(findingQuestion(one)).toBe('This is a question beside the conversation, about finding T2.1 of your review. Answer it briefly from what the conversation already holds, and take no action.\n\n> T2.1 Title T2.1\n> Example: Example T2.1.\n> Description: Description T2.1.\n> Correction: Correction T2.1.\n\nExplain this finding.');
  });

  it('names the reviewer by the plan’s title and version (C26)', () => {
    expect(reviewerName('Tides', 4)).toBe('Review of Plan: Tides v4');
  });
});
