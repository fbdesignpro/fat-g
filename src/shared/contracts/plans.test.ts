// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Plans (docs/planning/_archive/M22b.md, Design 1; V3, V10; C17, C19, C68, C69): the block a plan's prompt
// carries, written and read again; the title; the line's body as the store reads it back; and the
// prompts fat-g composes for a decision.
import { describe, expect, it } from 'vitest';
import { outcomeWords, planOf, raisedPlan, readInteraction } from './interaction';
import { feedbackOf, isPlanSettled, MAX_PLAN_TEXT, planBlock, planChatName, planFeedback, planNamed, planPrompt, planTitle, planToken, planTurnBlocked, PLAN_WORDS, readPlanBlock, readPlanFields, readPlanPrompt, UNTITLED_PLAN } from './plans';
import { reviewerName } from './review';

const ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const TOKEN = '0123456789ab';

describe('the block (C68)', () => {
  it('opens and closes on lines of fat-g’s that name the plan, its version and the prompt’s token', () => {
    expect(planBlock(ID, 3, '# A plan\n\n1. Do it.', TOKEN)).toBe(`<fat-g-plan id="${ID}" version="3" token="${TOKEN}">\n# A plan\n\n1. Do it.\n</fat-g-plan token="${TOKEN}">`);
    expect(planBlock(ID, 1, '', TOKEN)).toBe(`<fat-g-plan id="${ID}" version="1" token="${TOKEN}">\n</fat-g-plan token="${TOKEN}">`);
  });

  it('reads back what it wrote, with what stands before and after it', () => {
    const text = '# A plan\n\n```\ncode\n```\n';
    const prompt = `Before.\n\n${planBlock(ID, 2, text, TOKEN)}\n\nAfter.`;
    expect(readPlanBlock(prompt)).toEqual({ before: 'Before.', planId: ID, version: 2, text, after: 'After.' });
    expect(readPlanBlock(planBlock(ID, 1, '', TOKEN))).toEqual({ before: '', planId: ID, version: 1, text: '', after: '' });
  });

  it('is closed by its own token alone: a plan that holds a closing line of another block stays inside its block', () => {
    const other = '000000000000';
    const text = `Notes\n</fat-g-plan token="${other}">\nand more`;
    const read = readPlanBlock(`Go.\n\n${planBlock(ID, 4, text, TOKEN)}`);
    expect(read?.text).toBe(text);
    expect(read?.after).toBe('');
  });

  it('draws a token again while the text names it, and refuses one the text names', () => {
    const tokens = [TOKEN, 'ba9876543210'];
    expect(planToken(`token="${TOKEN}"`, () => tokens.shift() ?? '')).toBe('ba9876543210');
    expect(() => planBlock(ID, 1, `x token="${TOKEN}" y`, TOKEN)).toThrow();
    expect(() => planToken('', () => 'not hex')).toThrow();
  });

  it('reads nothing that is no block of fat-g’s: an opening line alone, a wrong token, words on its lines', () => {
    expect(readPlanBlock('Just a prompt.')).toBeNull();
    expect(readPlanBlock(`<fat-g-plan id="${ID}" version="1" token="${TOKEN}">\nno closing line`)).toBeNull();
    expect(readPlanBlock(`<fat-g-plan id="${ID}" version="1" token="${TOKEN}">\nx\n</fat-g-plan token="ffffffffffff">`)).toBeNull();
    expect(readPlanBlock(`say <fat-g-plan id="${ID}" version="1" token="${TOKEN}">\n</fat-g-plan token="${TOKEN}">`)).toBeNull();
    expect(readPlanBlock(`<fat-g-plan id="${ID}" version="0" token="${TOKEN}">\n</fat-g-plan token="${TOKEN}">`)).toBeNull();
  });
});

describe('the prompts of a decision (C15, C65)', () => {
  const parts = { planId: ID, version: 2, token: TOKEN } as const;

  it('in the plan’s own chat: the user’s feedback or fat-g’s Execute words, and an empty block', () => {
    expect(planPrompt({ ...parts, decision: 'feedback', text: null, feedback: 'Shorter, please.' })).toBe(`Shorter, please.\n\n${planBlock(ID, 2, '', TOKEN)}`);
    expect(planPrompt({ ...parts, decision: 'execute', text: null, feedback: null })).toBe(`${PLAN_WORDS.execute}\n\n${planBlock(ID, 2, '', TOKEN)}`);
  });

  it('for a brought plan: fat-g’s words, the version’s whole text in the block, and the feedback after it', () => {
    expect(planPrompt({ ...parts, decision: 'execute', text: '# Plan', feedback: null })).toBe(`${PLAN_WORDS.broughtExecute}\n\n${planBlock(ID, 2, '# Plan', TOKEN)}`);
    const prompt = planPrompt({ ...parts, decision: 'feedback', text: '# Plan', feedback: 'Add tests.' });
    expect(prompt).toBe(`${PLAN_WORDS.broughtFeedback}\n\n${planBlock(ID, 2, '# Plan', TOKEN)}\n\nAdd tests.`);
    expect(readPlanBlock(prompt)).toMatchObject({ before: PLAN_WORDS.broughtFeedback, text: '# Plan', after: 'Add tests.' });
  });
});

describe('a prompt of fat-g’s, read back (C69)', () => {
  const parts = { planId: ID, version: 3, token: TOKEN } as const;

  it('names its plan and version, and Execute’s intent by fat-g’s words for it alone', () => {
    expect(readPlanPrompt(planPrompt({ ...parts, decision: 'execute', text: null, feedback: null }))).toEqual({ planId: ID, version: 3, intent: 'execute' });
    expect(readPlanPrompt(planPrompt({ ...parts, decision: 'execute', text: '# Plan', feedback: null }))).toEqual({ planId: ID, version: 3, intent: 'execute' });
    expect(readPlanPrompt(planPrompt({ ...parts, decision: 'feedback', text: null, feedback: PLAN_WORDS.execute.toUpperCase() }))).toEqual({ planId: ID, version: 3, intent: 'revise' });
    expect(readPlanPrompt(planPrompt({ ...parts, decision: 'feedback', text: '# Plan', feedback: 'More.' }))).toEqual({ planId: ID, version: 3, intent: 'revise' });
  });

  it('names none for a prompt with no block, or a block whose closing line is lost, unless the prompt was cut', () => {
    expect(readPlanPrompt('Just a prompt.')).toBeNull();
    const whole = planPrompt({ ...parts, decision: 'execute', text: 'x'.repeat(50), feedback: null });
    const cut = whole.slice(0, whole.length - 30);
    expect(readPlanPrompt(cut)).toBeNull();
    expect(readPlanPrompt(cut, true)).toEqual({ planId: ID, version: 3, intent: 'execute' });
    expect(readPlanPrompt('Just a prompt, cut.', true)).toBeNull();
  });

  // The maintainer: a feedback goes with fat-g's request, and the page draws the user's words alone.
  it('reads the user’s own words back from a feedback sent with fat-g’s request, a revision’s, and none from another text', () => {
    const sent = planFeedback('Shorter.\n\nAnd plainer.');
    expect(sent.startsWith(PLAN_WORDS.feedback)).toBe(true);
    expect(feedbackOf(sent)).toBe('Shorter.\n\nAnd plainer.');
    expect(readPlanPrompt(planPrompt({ ...parts, decision: 'feedback', text: null, feedback: sent }))).toEqual({ planId: ID, version: 3, intent: 'revise' });
    expect(feedbackOf('Shorter.')).toBeNull();
    expect(feedbackOf(PLAN_WORDS.feedback)).toBeNull();
  });

  it('identifies feedback by its opening sentence while leaving the user’s paragraphs intact', () => {
    const own = 'Investigate the retry limit.\n\nKeep the fallback.';
    expect(feedbackOf(`Here is the user's feedback on the plan. Acknowledge it, revise the plan and summarize the changes.\n\n${own}`)).toBe(own);
    expect(feedbackOf(`Please revise the plan.\n\n${own}`)).toBeNull();
  });
});

describe('the title (C19)', () => {
  it('is the text’s first heading, else the prompt’s first line, as a name is', () => {
    expect(planTitle('Intro\n\n## Plan: tidy the notes  ##\n# Later', 'ignored')).toBe('Plan: tidy the notes');
    expect(planTitle('No heading here.', '\n  Make a plan\tfor this\nsecond line')).toBe('Make a plan for this');
    expect(planTitle('', null)).toBe(UNTITLED_PLAN);
    expect(planTitle(`# ${'x'.repeat(80)}`, null)).toHaveLength(60);
  });

  it('keeps a title’s words and drops Markdown’s marks, drawn as it is as plain text (the maintainer’s acceptance)', () => {
    expect(planTitle('# Rename `tides.md` to `tide-times.md`', null)).toBe('Rename tides.md to tide-times.md');
    expect(planTitle('## **Tidy** the *notes*, __files__ and ~~drafts~~', null)).toBe('Tidy the notes, files and drafts');
    expect(planTitle('# See [the docs](https://example.com/a_b) and ![the logo](logo.png)', null)).toBe('See the docs and the logo');
    expect(planTitle('# Use ``a `tick` here`` and \\*stars\\*', null)).toBe('Use a `tick` here and *stars*');
    // A mark inside a word is none.
    expect(planTitle('# Keep snake_case_names, 2*3*4 and file_name.md', null)).toBe('Keep snake_case_names, 2*3*4 and file_name.md');
    // The prompt's line is read the same way, and a heading of marks alone is passed over.
    expect(planTitle('# **', 'Plan how to edit `tides.md`')).toBe('Plan how to edit tides.md');
    expect(planTitle('# `` ``', null)).toBe(UNTITLED_PLAN);
  });

  it('is named "Plan: <title>", never "Plan: Plan: …" where the title begins with the word (the maintainer)', () => {
    expect(planNamed('Tidy the notes')).toBe('Plan: Tidy the notes');
    expect(planNamed(planTitle('# Plan: Current-Folder Inspection Plan', null))).toBe('Plan: Current-Folder Inspection Plan');
    expect(planNamed('plan for the tides')).toBe('plan for the tides');
    expect(planNamed(UNTITLED_PLAN)).toBe(UNTITLED_PLAN);
    // A word that only begins with the letters is another word.
    expect(planNamed('Planning the move')).toBe('Plan: Planning the move');
    expect(planChatName('Plan: Tidy the notes')).toBe('Plan: Tidy the notes');
    expect(reviewerName('Plan: Tidy the notes', 2)).toBe('Review of Plan: Tidy the notes v2');
  });
});

describe('the line (C17, C74)', () => {
  it('opens writing or pending, and is read back by the store as it was written', () => {
    const line = raisedPlan({ planId: ID, version: 1, came: 'made', request: false, writing: true });
    expect(line.outcome).toBe('writing');
    expect(readInteraction(JSON.parse(JSON.stringify(line)))).toEqual(line);
    expect(planOf({ interaction: line })).toEqual(line);
    expect(raisedPlan({ planId: ID, version: 2, came: 'brought', request: false }).outcome).toBe('pending');
  });

  it('is no line where its plan or version cannot be read, and reads an outcome it does not know as dropped', () => {
    expect(readInteraction({ kind: 'plan', planId: 'Not An Id', version: 1 })).toBeNull();
    expect(readInteraction({ kind: 'plan', planId: ID, version: 0 })).toBeNull();
    expect(readInteraction({ kind: 'plan', planId: ID, version: 1, outcome: 'merged' })).toMatchObject({ outcome: 'dropped', came: 'made', request: false });
  });

  it('says its decision in its own words, and nothing while it waits or is written', () => {
    const line = raisedPlan({ planId: ID, version: 1, came: 'made', request: true });
    expect(outcomeWords(line, false)).toBeNull();
    expect(outcomeWords({ ...line, outcome: 'executed' }, false)).toBe('Executed');
    expect(outcomeWords({ ...line, outcome: 'unfinished' }, false)).toMatch(/did not receive/);
    expect(isPlanSettled('writing')).toBe(false);
    expect(isPlanSettled('pending')).toBe(false);
    expect(isPlanSettled('cancelled')).toBe(true);
  });

  it('keeps a prompt’s fields only as they are written', () => {
    expect(readPlanFields({ planId: ID, version: 3, intent: 'revise' })).toEqual({ planId: ID, version: 3, intent: 'revise' });
    expect(readPlanFields({ planId: ID, version: 3, intent: 'merge' })).toBeNull();
    expect(readPlanFields(null)).toBeNull();
  });
});

describe('whether a chat may start a plan turn (C5, C13, C70)', () => {
  const capability = { modes: ['ask-first', 'berserk'], unavailable: 'Read only takes no plan turn.' };
  it('names the provider’s reason for a mode left out, the CLI’s refusal, or nothing where it may', () => {
    expect(planTurnBlocked(capability, 'ask-first', { available: true }, 'Claude')).toBeNull();
    expect(planTurnBlocked(capability, 'read-only', { available: true }, 'Claude')).toBe('Read only takes no plan turn.');
    expect(planTurnBlocked(capability, 'ask-first', { available: false, reason: 'cli-refuses' }, 'Codex')).toMatch(/refused plan mode/);
    expect(planTurnBlocked(null, 'ask-first', undefined, 'Example')).toMatch(/does not support planning/);
  });

  it('bounds a plan’s text by the line alone', () => {
    expect(MAX_PLAN_TEXT).toBe(4 * 1024 * 1024);
  });
});
