// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, the reading's part (docs/planning/_archive/M21.md, Design 4; C23, C25, C59): what the adapter takes of
// a question asked as a request, on the request K2's capture holds. The request is read for whose
// it is, the item that carries it, its questions and `isBlocking`, and nothing more; its texts are
// taken whole, since the answer is encoded from them. The rest of this module is tested through the
// mapper and the history read (turn-mapper.test.ts, history.test.ts).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundQuestions, canShow, InteractionQuestionsSchema } from '@shared/contracts/interaction';
import { rawQuestions, takeQuestionRequest, takeRequestId, takeResolvedFrame, takeStartReply, takeTokenUsage } from './session-schemas';

interface Captured { readonly dir: string; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown> } }
const K2 = (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m21-codex-plan.json'), 'utf8')) as { frames: Captured[] }).frames;
const REQUEST = K2.find((f) => f.dir === 'recv' && f.frame.method === 'item/tool/requestUserInput') as Captured;
const PARAMS = REQUEST.frame.params as Record<string, unknown> & { questions: Record<string, unknown>[] };
const [QUESTION] = PARAMS.questions as [Record<string, unknown>];

describe('K2’s request, as it is taken (C23, C25)', () => {
  it('reads its thread, its turn, its item, its questions and `isBlocking`, and nothing of `autoResolutionMs`', () => {
    expect(Object.keys(PARAMS).sort()).toEqual(['autoResolutionMs', 'isBlocking', 'itemId', 'questions', 'threadId', 'turnId']);
    const taken = takeQuestionRequest(PARAMS);
    expect(taken).toEqual({
      threadId: PARAMS['threadId'], turnId: PARAMS['turnId'], itemId: PARAMS['itemId'], isBlocking: true,
      questions: [{ id: 'notes_file', header: 'Choose file', question: 'Which file should the plan be about?', isOther: true, isSecret: false, options: [{ label: 'notes-1.txt', description: 'Plan to summarise notes-1.txt.' }, { label: 'notes-2.txt', description: 'Plan to summarise notes-2.txt.' }] }],
    });
    // The same whatever it holds: a clock is no part of what is taken (C9).
    expect(takeQuestionRequest({ ...PARAMS, autoResolutionMs: 30_000 })).toEqual(taken);
  });

  it('gives each question the shape every provider’s share: `isOther` as free text, `isSecret` as secret, one choice', () => {
    const taken = takeQuestionRequest(PARAMS);
    if (taken === null) throw new Error('not a request');
    const raw = rawQuestions(taken);
    expect(raw).toEqual([{ text: 'Which file should the plan be about?', header: 'Choose file', options: [{ label: 'notes-1.txt', description: 'Plan to summarise notes-1.txt.' }, { label: 'notes-2.txt', description: 'Plan to summarise notes-2.txt.' }], multiple: false, freeText: true, secret: false }]);
    expect(canShow(raw)).toBe(true);
    expect(InteractionQuestionsSchema.safeParse(boundQuestions(raw).questions).success).toBe(true);
  });

  it('reads the schema’s defaults where a field is left out: no free text, no secret, no options, no header, and `isBlocking` as not given', () => {
    const taken = takeQuestionRequest({ threadId: 't', turnId: 'u', itemId: 'i', questions: [{ id: 'q', question: 'Why?' }, { id: 'r', question: 'How?', header: null, options: null, isOther: null, isSecret: true }] });
    expect(taken).toEqual({
      threadId: 't', turnId: 'u', itemId: 'i', isBlocking: null,
      questions: [{ id: 'q', header: null, question: 'Why?', isOther: false, isSecret: false, options: [] }, { id: 'r', header: null, question: 'How?', isOther: false, isSecret: true, options: [] }],
    });
    if (taken === null) throw new Error('not a request');
    // The first is one nothing could answer; the second is a secret, whose field is all there is of it.
    expect(rawQuestions(taken).map((question) => [question.freeText, question.secret])).toEqual([[false, false], [false, true]]);
    expect(canShow(rawQuestions(taken))).toBe(false);
  });

  it('takes every text whole, whatever its length: the answer is encoded from the request as it came (C59)', () => {
    const long = 'x'.repeat(5_000);
    const taken = takeQuestionRequest({ ...PARAMS, questions: [{ ...QUESTION, question: long, header: long, options: Array.from({ length: 12 }, () => ({ label: long, description: long })) }] });
    expect(taken?.questions[0]).toMatchObject({ question: long, header: long });
    expect(taken?.questions[0]?.options).toHaveLength(12);
    expect(taken?.questions[0]?.options.every((option) => option.label === long && option.description === long)).toBe(true);
  });

  it.each([
    ['no thread', { ...PARAMS, threadId: undefined }],
    ['no turn', { ...PARAMS, turnId: null }],
    ['no item', { ...PARAMS, itemId: '' }],
    ['an id with a control character', { ...PARAMS, itemId: 'a\u0000b' }],
    ['an id over its bound', { ...PARAMS, threadId: 'x'.repeat(257) }],
    ['no questions', { ...PARAMS, questions: undefined }],
    ['a question with no id', { ...PARAMS, questions: [{ ...QUESTION, id: undefined }] }],
    ['a question with no text', { ...PARAMS, questions: [{ ...QUESTION, question: 7 }] }],
    ['an option with no label', { ...PARAMS, questions: [{ ...QUESTION, options: [{ description: 'x' }] }] }],
    ['nothing', null],
  ])('is no request with %s: it is refused', (_name, params) => {
    expect(takeQuestionRequest(params)).toBeNull();
  });
});

describe('a request’s id, and Codex’s word that one is over (C20, C23)', () => {
  // M22 (C10): the id is kept lossless, so a number and a string of one spelling are two requests.
  it('names a request by the id it came with, lossless: K2’s was the number 0, which is not the string "0"', () => {
    expect(REQUEST.frame.id).toBe(0);
    expect(takeRequestId(REQUEST.frame.id)).toBe('n:0');
    expect(takeRequestId('0')).toBe('s:0');
    expect(takeRequestId('req-7')).toBe('s:req-7');
    expect(takeRequestId(-3)).toBe('n:-3');
    expect(takeRequestId('n:0')).toBe('s:n:0');
    // What an event's id may be, the prefix counted: 256 units at most, and no control character.
    expect(takeRequestId('x'.repeat(254))).toBe(`s:${'x'.repeat(254)}`);
    for (const none of [null, undefined, '', 'x'.repeat(255), 'a\nb', { id: 1 }, true, Number.NaN, Number.POSITIVE_INFINITY]) expect(takeRequestId(none)).toBeNull();
  });

  it('reads `serverRequest/resolved` for the request it names, and nothing else of it', () => {
    const resolved = K2.find((f) => f.dir === 'recv' && f.frame.method === 'serverRequest/resolved') as Captured;
    expect(Object.keys(resolved.frame.params ?? {}).sort()).toEqual(['requestId', 'threadId']);
    expect(takeResolvedFrame(resolved.frame.params)).toBe('n:0');
    expect(takeResolvedFrame({ requestId: 'req-7' })).toBe('s:req-7');
    for (const none of [{ threadId: 't' }, { requestId: null }, { requestId: '' }, null, 'resolved']) expect(takeResolvedFrame(none)).toBeNull();
  });
});

// M22 (V2; C4, C7, C65, C70): a start reply's policy, taken whole on the replies K1, K4 and K6 captured.
describe('a start reply’s policy, as it is taken (M22; C4, C7, C65, C70)', () => {
  const replyOf = (name: string): Record<string, unknown> => {
    const frames = (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: { id?: number; method?: string; result?: Record<string, unknown> } }[] }).frames;
    const sent = frames.find((f) => f.dir === 'send' && (f.frame.method === 'thread/start' || f.frame.method === 'thread/resume'));
    return frames.find((f) => f.dir === 'recv' && f.frame.method === undefined && f.frame.id === sent?.frame.id)?.frame.result as Record<string, unknown>;
  };

  it('reads the thread’s id, the sandbox as it came, the approval policy, the reviewer and the speed tier taken, and nothing of the model or the effort', () => {
    const reply = replyOf('m22-codex-reviewer-turn-main');
    const taken = takeStartReply(reply);
    expect(taken).toEqual({
      threadId: (reply['thread'] as { id: string }).id,
      policy: {
        sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        sandboxType: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      },
      // The tier the thread took (decision 0018): the capture's, as the reply names it.
      serviceTier: typeof reply['serviceTier'] === 'string' ? reply['serviceTier'] : null,
    });
    expect(takeStartReply({ ...reply, serviceTier: 'priority' })?.serviceTier).toBe('priority');
    expect(takeStartReply({ ...reply, serviceTier: null })?.serviceTier).toBeNull();
    // The object itself, for a turn to name again unchanged (C7).
    expect(taken?.policy.sandbox).toBe(reply['sandbox']);
    expect(JSON.stringify(taken)).not.toContain(String(reply['model']));
  });

  it('reads each sandbox Codex reports: read-only, a workspace one, full access', () => {
    expect(takeStartReply(replyOf('m22-codex-read-only-turn'))?.policy).toMatchObject({ sandbox: { type: 'readOnly', networkAccess: false }, sandboxType: 'readOnly', networkAccess: false, approvalPolicy: 'never', approvalsReviewer: 'user' });
    expect(takeStartReply(replyOf('m22-codex-auto-review-main'))?.policy).toMatchObject({ sandboxType: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    // Full access says nothing of the network or of roots.
    expect(takeStartReply(replyOf('m22-codex-berserk-main'))?.policy).toEqual({ sandbox: { type: 'dangerFullAccess' }, sandboxType: 'dangerFullAccess', networkAccess: null, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false, approvalPolicy: 'never', approvalsReviewer: 'user' });
  });

  it('reads the roots and the exclusions a user’s own configuration adds, and keeps what it does not know of the sandbox for the turn (C65)', () => {
    const sandbox = { type: 'workspaceWrite', writableRoots: ['D:\\shared', 7, '/var/build'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true, somethingNew: { kept: true } };
    const taken = takeStartReply({ thread: { id: 't' }, sandbox, approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
    expect(taken?.policy).toMatchObject({ writableRoots: ['D:\\shared', '/var/build'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    expect(taken?.policy.sandbox).toBe(sandbox);
  });

  it('takes a reply with no sandbox, no reviewer or a policy that is no word as what it is, for the session to refuse; and none with no thread', () => {
    expect(takeStartReply({ thread: { id: 't' }, approvalPolicy: 'never' })?.policy).toMatchObject({ sandbox: null, sandboxType: null, networkAccess: null, approvalsReviewer: null });
    expect(takeStartReply({ thread: { id: 't' }, sandbox: null, approvalPolicy: { granular: {} }, approvalsReviewer: 7 })?.policy).toMatchObject({ sandbox: null, approvalPolicy: { granular: {} }, approvalsReviewer: null });
    for (const none of [null, {}, { thread: {} }, { thread: { id: '' } }, { thread: { id: 't' }, sandbox: { type: 7 } }, { thread: { id: 't' }, sandbox: 'readOnly' }]) expect(takeStartReply(none)).toBeNull();
  });
});

// Decision 0033: T1's two token reports, as Codex 0.155.1 sent them, taken as context readings.
describe('a token report, as it is taken (decision 0033)', () => {
  const t1 = (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/t1-basic.json'), 'utf8')) as { frames: { dir: string; frame: { method?: string; params?: unknown } }[] }).frames;
  const reports = t1.filter((entry) => entry.dir === 'recv' && entry.frame.method === 'thread/tokenUsage/updated').map((entry) => entry.frame.params);

  it('gives the last call’s whole count against the model’s window, the cache read set apart from the input, and every call so far', () => {
    const taken = reports.map(takeTokenUsage);
    expect(taken.map((one) => [one?.reading.used, one?.reading.window])).toEqual([[15_800, 258_400], [15_887, 258_400]]);
    expect(taken[0]?.reading.lastCall).toEqual({ input: 3_203, cacheRead: 12_544, cacheWrite: 0, output: 53, reasoning: 0 });
    expect(taken[0]?.reading).not.toHaveProperty('compactAt');
    expect(typeof taken[0]?.threadId).toBe('string');
  });

  it('is no reading without a window or a count, or with a count that is no count', () => {
    const [first] = reports as [{ threadId: string; tokenUsage: Record<string, unknown> }];
    for (const params of [{}, { threadId: first.threadId }, { ...first, tokenUsage: { ...first.tokenUsage, modelContextWindow: 0 } }, { ...first, tokenUsage: { ...first.tokenUsage, last: { totalTokens: -1 } } }]) {
      expect(takeTokenUsage(params), JSON.stringify(params).slice(0, 60)).toBeNull();
    }
  });
});
