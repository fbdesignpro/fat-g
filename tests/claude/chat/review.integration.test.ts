// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, Claude's part (docs/planning/_archive/M22e.md, Design 9; C42, C46, C48): a review on the real Claude adapter
// and process layer against the replay fake, which replays K2's review and its rounds for fat-g's
// prompts, known by their words, between T1's lifecycle frames, and each named fault. The answer is
// the one the turn's end names, which fat-g's store labels `final` (C43). No test here uses the real CLI.
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import { type Finding, readFindings, reviewPrompt, sendNotesPrompt } from '@shared/contracts/review';
import { claudeHarness, type Harness, under, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
const TEXT = '# Add a next low tide helper\n\n## Steps\n\n1. Add it.';
const open = async (): Promise<Harness> => (harness = await claudeHarness());
const start = (h: Harness): Watched => watch(h.facet.start(under(h, 'read-only')));
const review = (h: Harness): string => reviewPrompt({ title: 'Add a next low tide helper', planId: PLAN, version: 1, text: TEXT, token: '0123456789ab', folder: h.project });
const of = <T extends AgentEvent['type']>(s: Watched, type: T): Extract<AgentEvent, { type: T }>[] => s.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
/** The turn's answer: the message its end names, by the provider's id. */
function answerOf(s: Watched, turnId: string): string {
  const ended = of(s, 'turn-ended').find((event) => event.turnId === turnId);
  const named = ended?.answerItemId ?? null;
  return of(s, 'message').filter((event) => event.turnId === turnId && event.role === 'assistant' && (named === null || event.itemId === named)).at(-1)?.text ?? '';
}
const issuesOf = (text: string): readonly Finding[] => { const read = readFindings(text, 2); if (read.verdict !== 'findings') throw new Error(read.verdict); return read.block.issues; };
const valid = (s: Watched): void => { for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 160)).toBe(true); };

describe('a review on the Claude fake (V5; C42, C43)', () => {
  it('answers fat-g’s review prompt with K2’s review, its end naming the answer, then each Send notes with the next of K2’s rounds', async () => {
    const h = await open();
    const s = start(h);
    s.send(review(h), 1, 'medium');
    expect(await s.ended('turn-1', 60_000)).toMatchObject({ outcome: 'completed' });
    expect(of(s, 'turn-ended')[0]?.answerItemId).not.toBeNull();
    const first = issuesOf(answerOf(s, 'turn-1'));
    expect(first.length).toBeGreaterThan(2);
    const marks = Object.fromEntries(first.map((finding) => [finding.id, 'open' as const]));
    s.send(sendNotesPrompt({ findings: first, marks, notes: { [first[1]?.id ?? '']: 'This is minor.' } }), 2, 'medium');
    await s.ended('turn-2', 60_000);
    const settled = issuesOf(answerOf(s, 'turn-2'));
    expect(settled.filter((finding) => finding.was !== undefined && finding.was !== finding.id)).toHaveLength(1);
    s.send(sendNotesPrompt({ findings: settled, marks, notes: { [settled[0]?.id ?? '']: 'Why this tier?' } }), 3, 'medium');
    await s.ended('turn-3', 60_000);
    const asked = readFindings(answerOf(s, 'turn-3'), 2);
    expect(asked.verdict === 'findings' && asked.before.length).toBeGreaterThan(40);
    expect(h.only().entry.turns).toEqual(['m22e-claude-rounds', 'm22e-claude-rounds#2', 'm22e-claude-rounds#3']);
    valid(s);
  }, 120_000);

  it.each([
    ['review-no-block', 'no-block'], ['review-invalid', 'invalid'], ['review-set-aside', 'findings'], ['review-two-blocks', 'several'], ['review-long', 'findings'], ['review-unclosed', 'findings'], ['review-v1', 'invalid'],
  ] as const)('sends the review’s answer with %s, which reads %s', async (fault, verdict) => {
    const h = await open();
    h.control({ [fault]: 1 });
    const s = start(h);
    s.send(review(h), 1, 'medium');
    await s.ended('turn-1', 60_000);
    expect(readFindings(answerOf(s, 'turn-1'), 2).verdict).toBe(verdict);
  }, 90_000);

  it.each([['review-prose-only', 'no-block'], ['review-drop', 'findings'], ['review-renumber', 'findings'], ['review-ambiguous', 'findings']] as const)('sends a Send notes answer with %s, which reads %s', async (fault, verdict) => {
    const h = await open();
    const s = start(h);
    s.send(review(h), 1, 'medium');
    await s.ended('turn-1', 60_000);
    const first = issuesOf(answerOf(s, 'turn-1'));
    h.control({ [fault]: 1 });
    s.send(sendNotesPrompt({ findings: first, marks: {}, notes: { [first[0]?.id ?? '']: 'A note.' } }), 2, 'medium');
    await s.ended('turn-2', 60_000);
    expect(readFindings(answerOf(s, 'turn-2'), 2).verdict).toBe(verdict);
  }, 90_000);

  it('answers a plain prompt in a reviewed session with a block that checks, under review-plain-block (C25)', async () => {
    const h = await open();
    const s = start(h);
    s.send(review(h), 1, 'medium');
    await s.ended('turn-1', 60_000);
    h.control({ 'review-plain-block': 1 });
    s.send('Why is the first finding critical?', 2, 'medium');
    await s.ended('turn-2', 60_000);
    expect(readFindings(answerOf(s, 'turn-2'), 2).verdict).toBe('findings');
  }, 90_000);

  it('loses its process after the review’s first text delta, under review-lost', async () => {
    const h = await open();
    h.control({ 'review-lost': 1 });
    const s = start(h);
    s.send(review(h), 1, 'medium');
    expect(await s.ended('turn-1', 60_000)).toMatchObject({ outcome: 'failed' });
  }, 90_000);
});
