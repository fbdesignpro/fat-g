// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, the adapter's part (docs/planning/_archive/M22e.md, Design 9; C42, C46, C48, C49): a review on the real Codex
// adapter and process layer against the replay fake, which replays K2's review and its rounds for
// fat-g's prompts, known by their words, and each named fault. No test here uses the real CLI.
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import { type Finding, readFindings, reviewPrompt, sendNotesPrompt } from '@shared/contracts/review';
import { codexHarness, type Harness, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

const MODEL = 'gpt-6-luna';
const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
const TEXT = '# Add a next low tide helper\n\n## Steps\n\n1. Add it.';
const start = (h: Harness): Watched => watch(h.facet.start({ folder: h.project, model: MODEL, effort: 'medium', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));
const review = (h: Harness): string => reviewPrompt({ title: 'Add a next low tide helper', planId: PLAN, version: 1, text: TEXT, token: '0123456789ab', folder: h.project });
const of = <T extends AgentEvent['type']>(session: Watched, type: T) => session.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
/** The turn's final answer, as the adapter told it. */
const answerOf = (session: Watched, turnId: string): string => of(session, 'message').filter((event) => event.turnId === turnId && event.role === 'assistant' && event.phase === 'final').at(-1)?.text ?? '';
const issuesOf = (text: string): readonly Finding[] => { const read = readFindings(text, 2); if (read.verdict !== 'findings') throw new Error(read.verdict); return read.block.issues; };
const valid = (session: Watched): void => { for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true); };

describe('a review on the Codex fake (V5; C42)', () => {
  it('answers fat-g’s review prompt with K2’s review, then each Send notes with the next of K2’s rounds', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(review(h), 1, 'medium');
    expect(await session.ended('turn-1', 60_000)).toMatchObject({ outcome: 'completed' });
    const first = issuesOf(answerOf(session, 'turn-1'));
    expect(first.length).toBeGreaterThan(2);
    // A commentary came before the reads; the answer is the final message (C43).
    expect(of(session, 'message').some((event) => event.turnId === 'turn-1' && event.phase === 'commentary')).toBe(true);
    const marks = Object.fromEntries(first.map((finding) => [finding.id, 'open' as const]));
    session.send(sendNotesPrompt({ findings: first, marks, notes: { [first[1]?.id ?? '']: 'This is minor.' } }), 2, 'medium');
    await session.ended('turn-2', 60_000);
    const settled = issuesOf(answerOf(session, 'turn-2'));
    expect(settled.filter((finding) => finding.was !== undefined && finding.was !== finding.id)).toHaveLength(1);
    session.send(sendNotesPrompt({ findings: settled, marks, notes: { [settled[0]?.id ?? '']: 'Why this tier?' } }), 3, 'medium');
    await session.ended('turn-3', 60_000);
    const asked = readFindings(answerOf(session, 'turn-3'), 2);
    expect(asked.verdict === 'findings' && asked.before.length).toBeGreaterThan(40);
    valid(session);
  }, 120_000);

  it.each([
    ['review-no-block', 'no-block'], ['review-invalid', 'invalid'], ['review-set-aside', 'findings'], ['review-two-blocks', 'several'], ['review-long', 'findings'], ['review-unclosed', 'findings'], ['review-v1', 'invalid'],
  ] as const)('sends the review’s answer with %s, which reads %s', async (fault, verdict) => {
    const h = harness = await codexHarness();
    h.control({ [fault]: 1 });
    const session = start(h);
    session.send(review(h), 1, 'medium');
    await session.ended('turn-1', 60_000);
    expect(readFindings(answerOf(session, 'turn-1'), 2).verdict).toBe(verdict);
  }, 90_000);

  it.each([['review-prose-only', 'no-block'], ['review-drop', 'findings'], ['review-renumber', 'findings'], ['review-ambiguous', 'findings']] as const)('sends a Send notes answer with %s, which reads %s', async (fault, verdict) => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(review(h), 1, 'medium');
    await session.ended('turn-1', 60_000);
    const first = issuesOf(answerOf(session, 'turn-1'));
    h.control({ [fault]: 1 });
    session.send(sendNotesPrompt({ findings: first, marks: {}, notes: { [first[0]?.id ?? '']: 'A note.' } }), 2, 'medium');
    await session.ended('turn-2', 60_000);
    expect(readFindings(answerOf(session, 'turn-2'), 2).verdict).toBe(verdict);
  }, 90_000);

  it('answers a plain prompt on a reviewed thread with a block that checks, under review-plain-block (C25)', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(review(h), 1, 'medium');
    await session.ended('turn-1', 60_000);
    h.control({ 'review-plain-block': 1 });
    session.send('Why is the first finding critical?', 2, 'medium');
    await session.ended('turn-2', 60_000);
    expect(readFindings(answerOf(session, 'turn-2'), 2).verdict).toBe('findings');
  }, 90_000);

  it('asks first under review-asks: a message with questions ends the turn, and the next turn plays the review (C49)', async () => {
    const h = harness = await codexHarness();
    h.control({ 'review-asks': 1 });
    const session = start(h);
    session.send(review(h), 1, 'medium');
    await session.ended('turn-1', 60_000);
    // M21's capture closes that turn with an empty final message after the one that asks: the card is what waits (C49).
    const asking = of(session, 'message').find((event) => event.turnId === 'turn-1' && (event.questions?.length ?? 0) > 0);
    expect(asking?.phase).toBe('final');
    session.send('My answer to your question.', 2, 'medium');
    await session.ended('turn-2', 60_000);
    expect(readFindings(answerOf(session, 'turn-2'), 2).verdict).toBe('findings');
  }, 90_000);

  it('loses its process after the review’s first text delta, under review-lost', async () => {
    const h = harness = await codexHarness();
    h.control({ 'review-lost': 1 });
    const session = start(h);
    session.send(review(h), 1, 'medium');
    const ended = await session.until((event) => event.type === 'turn-ended', 60_000);
    expect(ended).toMatchObject({ outcome: 'failed' });
  }, 90_000);
});
