// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V22 (docs/planning/_archive/M15.md; C54, C76), V9, V11 (M18.md; C20, C24, C60), V7 (M20a.md; C32,
// C34), V7 (M20b.md; C4, C33, C73) and V8, V33 (M21.md; C31, C34, C44): the chat channels,
// through the real contract — the sender policy, the strict requests, and the handlers on a runtime
// in the test's hands.
import { describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ChatAnswerResult, ChatAsideReadResult, ChatAsideRemoveResult, ChatAsideStopResult, ChatAskResult, ChatDecideResult, ChatDismissResult, ChatSetModeResult, ChatWorkerReadResult } from '@shared/contracts/chat';
import { MAX_ANSWER_TEXT } from '@shared/contracts/interaction';
import { type ChatDraftResult, EMPTY_DRAFT } from '@shared/contracts/composer';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { chatHandlers } from './chat';
import { createKindCounts } from './counts';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const CHANNELS = ['chat:read', 'chat:page', 'chat:readWorker', 'chat:send', 'chat:stop', 'chat:loadHistory', 'chat:ask', 'chat:readAside', 'chat:stopAside', 'chat:removeAside', 'chat:answer', 'chat:dismiss', 'chat:setMode', 'chat:decide', 'chat:draft'] as const;
const READ = { status: 'read', sessionId: SESSION, revision: 0, items: [], latest: true, turns: [], older: null, history: { state: 'checked', olderUnread: false, earlierMissing: false }, storage: 'ok', asides: [], asking: 'none', waiting: [], mode: null, grants: [] } as const;
const PAGE = { status: 'page', sessionId: SESSION, revision: 0, items: [], turns: [], older: null } as const;
const WORKER = { status: 'read', sessionId: SESSION, workerId: 'worker-1', revision: 0, worker: null, items: [], turns: [], older: null } as const;
const ASIDE = 'a51de000-0000-4000-8000-000000000001';
const ASIDE_READ = { status: 'read', sessionId: SESSION, asideId: ASIDE, revision: 0, aside: { id: ASIDE, title: 'New aside', source: null, createdAt: 1, running: false }, items: [], turns: [], older: null } as const;
const log = { warn: vi.fn(), error: vi.fn() };
const deps = (detail: DispatchDeps['detail'] = 'kinds'): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail });
const from = (kind: 'main' | 'pet', request: unknown) => ({
  windowKind: kind,
  sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true },
  request,
});

function runtime() {
  return {
    read: vi.fn(() => READ),
    page: vi.fn(() => PAGE),
    readWorker: vi.fn(() => WORKER as ChatWorkerReadResult),
    send: vi.fn(() => Promise.resolve({ status: 'accepted' } as const)),
    stop: vi.fn(() => ({ status: 'stopping' } as const)),
    loadHistory: vi.fn(() => ({ status: 'loading' } as const)),
    ask: vi.fn(() => Promise.resolve({ status: 'accepted', asideId: ASIDE } as ChatAskResult)),
    readAside: vi.fn(() => ASIDE_READ as ChatAsideReadResult),
    stopAside: vi.fn((): ChatAsideStopResult => ({ status: 'stopping' })),
    removeAside: vi.fn((): ChatAsideRemoveResult => ({ status: 'removed' })),
    answer: vi.fn((): Promise<ChatAnswerResult> => Promise.resolve({ status: 'answered' })),
    dismiss: vi.fn((): ChatDismissResult => ({ status: 'dismissed' })),
    setMode: vi.fn((): Promise<ChatSetModeResult> => Promise.resolve({ status: 'set' })),
    decide: vi.fn((): ChatDecideResult => ({ status: 'decided' })),
    draft: vi.fn((): ChatDraftResult => ({ status: 'saved', draft: EMPTY_DRAFT })),
    queue: vi.fn(() => Promise.resolve({ status: 'saved' as const })),
    unqueue: vi.fn(() => ({ status: 'saved' as const })),
    editQueued: vi.fn(() => Promise.resolve({ status: 'saved' as const })),
    resumeQueue: vi.fn(() => ({ status: 'saved' as const })),
    commands: vi.fn(() => Promise.resolve({ status: 'read' as const, rows: [], note: null })),
  };
}
const ANSWERS = [{ question: 0, options: [1], text: null }, { question: 1, options: [], text: 'PRIVATE-ANSWER' }];
const SOURCE = { kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 0, end: 14 }, digest: '0badc0de', excerpt: 'PRIVATE-EXCERPT', cut: false } as const;
const valid = (channel: (typeof CHANNELS)[number]): unknown => {
  switch (channel) {
    case 'chat:send': return { sessionId: SESSION, prompt: 'Fix the login bug' };
    case 'chat:page': return { sessionId: SESSION, before: 'item-1' };
    case 'chat:readWorker': return { sessionId: SESSION, workerId: 'worker-1' };
    case 'chat:ask': return { sessionId: SESSION, asideId: ASIDE, text: 'Why is the sea salty?' };
    case 'chat:readAside': case 'chat:stopAside': case 'chat:removeAside': return { sessionId: SESSION, asideId: ASIDE };
    case 'chat:answer': return { sessionId: SESSION, itemId: 'card-1', answers: ANSWERS };
    case 'chat:dismiss': return { sessionId: SESSION, itemId: 'card-1' };
    case 'chat:setMode': return { sessionId: SESSION, mode: 'ask-first' };
    case 'chat:decide': return { sessionId: SESSION, itemId: 'card-1', choice: 'approve' };
    case 'chat:read': case 'chat:stop': case 'chat:loadHistory': return { sessionId: SESSION };
    case 'chat:draft': return { sessionId: SESSION, op: 'text', revision: 3, prompt: 'PRIVATE-DRAFT', intent: { plan: false, skill: null } };
  }
};
const ask = (channel: (typeof CHANNELS)[number], made: ReturnType<typeof runtime>, kind: 'main' | 'pet', request: unknown, detail: DispatchDeps['detail'] = 'kinds') =>
  dispatchInvoke(channel, INVOKE_SPECS[channel], chatHandlers(made)[channel] as Handler<unknown, unknown>, from(kind, request), deps(detail));

describe('the chat channels', () => {
  it('hands each call to the runtime and answers what it answers', async () => {
    const made = runtime();
    expect(await ask('chat:read', made, 'main', valid('chat:read'))).toEqual({ ok: true, value: READ });
    // The newest page: no window is named.
    expect(made.read).toHaveBeenCalledExactlyOnceWith(SESSION, undefined);
    expect(await ask('chat:page', made, 'main', valid('chat:page'))).toEqual({ ok: true, value: PAGE });
    expect(made.page).toHaveBeenCalledExactlyOnceWith(SESSION, 'item-1');
    expect(await ask('chat:send', made, 'main', valid('chat:send'))).toEqual({ ok: true, value: { status: 'accepted' } });
    expect(made.send).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the login bug');
    expect(await ask('chat:stop', made, 'main', valid('chat:stop'))).toEqual({ ok: true, value: { status: 'stopping' } });
    expect(made.stop).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(await ask('chat:loadHistory', made, 'main', valid('chat:loadHistory'))).toEqual({ ok: true, value: { status: 'loading' } });
    expect(made.loadHistory).toHaveBeenCalledExactlyOnceWith(SESSION);
  });

  // M20a, V7 (C32, C34): a worker's conversation.
  it('reads a worker’s newest window, or the page before a cursor, and answers what the runtime answers', async () => {
    const made = runtime();
    expect(await ask('chat:readWorker', made, 'main', valid('chat:readWorker'))).toEqual({ ok: true, value: WORKER });
    expect(made.readWorker).toHaveBeenLastCalledWith(SESSION, 'worker-1', undefined);
    await ask('chat:readWorker', made, 'main', { sessionId: SESSION, workerId: 'worker-1', before: 'item-9' });
    expect(made.readWorker).toHaveBeenLastCalledWith(SESSION, 'worker-1', 'item-9');
    made.readWorker.mockReturnValueOnce({ status: 'refused', reason: 'unknown-worker' });
    expect(await ask('chat:readWorker', made, 'main', valid('chat:readWorker'))).toEqual({ ok: true, value: { status: 'refused', reason: 'unknown-worker' } });
  });

  it('counts a worker read by its outcome’s kind, and says no more of it than that', async () => {
    const made = runtime();
    const counts = createKindCounts();
    const handlers = chatHandlers(made, counts);
    const read = (request: { sessionId: string; workerId: string; before?: string }) => handlers['chat:readWorker'](request, { windowKind: 'main' } as never);
    await read({ sessionId: SESSION, workerId: 'PRIVATE-WORKER-ID' });
    await read({ sessionId: SESSION, workerId: 'PRIVATE-WORKER-ID', before: 'PRIVATE-CURSOR' });
    for (const reason of ['unknown-session', 'unknown-worker', 'unknown-cursor'] as const) {
      made.readWorker.mockReturnValueOnce({ status: 'refused', reason });
      await read({ sessionId: SESSION, workerId: 'PRIVATE-WORKER-ID' });
    }
    expect(counts.snapshot()).toEqual({ 'read:window': 1, 'read:page': 1, 'refused:unknown-session': 1, 'refused:unknown-worker': 1, 'refused:unknown-cursor': 1 });
    expect(JSON.stringify(counts.snapshot())).not.toMatch(/PRIVATE|worker-1|item/);
  });

  it.each(['kinds', 'full'] as const)('leaves in the log of a %s build a worker read’s channel and kind alone, for a bad request and for a handler that fails', async (detail) => {
    log.warn.mockClear();
    log.error.mockClear();
    const made = runtime();
    await ask('chat:readWorker', made, 'main', { sessionId: SESSION, workerId: 'PRIVATE-WORKER-ID', extra: 'PRIVATE-EXTRA' }, detail);
    made.readWorker.mockImplementationOnce(() => { throw new Error('the store failed'); });
    expect(await ask('chat:readWorker', made, 'main', { sessionId: SESSION, workerId: 'PRIVATE-WORKER-ID', before: 'PRIVATE-CURSOR' }, detail)).toEqual({ ok: false, error: 'internal' });
    const logged = [...log.warn.mock.calls, ...log.error.mock.calls].flat().map((part: unknown) => (part instanceof Error ? `${part.message} ${part.stack ?? ''}` : JSON.stringify(part))).join('\n');
    expect(logged).toContain('chat:readWorker');
    expect(logged).not.toContain('PRIVATE');
  });

  // M20b, V7 (C4, C33, C73): a question beside a session.
  it('hands an ask, an aside’s read, its Stop and its removal to the runtime, and answers what it answers', async () => {
    const made = runtime();
    expect(await ask('chat:ask', made, 'main', valid('chat:ask'))).toEqual({ ok: true, value: { status: 'accepted', asideId: ASIDE } });
    expect(made.ask).toHaveBeenLastCalledWith({ sessionId: SESSION, asideId: ASIDE, text: 'Why is the sea salty?' });
    await ask('chat:ask', made, 'main', { sessionId: SESSION, asideId: ASIDE, source: SOURCE });
    expect(made.ask).toHaveBeenLastCalledWith({ sessionId: SESSION, asideId: ASIDE, source: SOURCE });
    expect(await ask('chat:readAside', made, 'main', valid('chat:readAside'))).toEqual({ ok: true, value: ASIDE_READ });
    expect(made.readAside).toHaveBeenLastCalledWith(SESSION, ASIDE, undefined);
    await ask('chat:readAside', made, 'main', { sessionId: SESSION, asideId: ASIDE, before: 'item-9' });
    expect(made.readAside).toHaveBeenLastCalledWith(SESSION, ASIDE, 'item-9');
    expect(await ask('chat:stopAside', made, 'main', valid('chat:stopAside'))).toEqual({ ok: true, value: { status: 'stopping' } });
    expect(made.stopAside).toHaveBeenCalledExactlyOnceWith(SESSION, ASIDE);
    expect(await ask('chat:removeAside', made, 'main', valid('chat:removeAside'))).toEqual({ ok: true, value: { status: 'removed' } });
    expect(made.removeAside).toHaveBeenCalledExactlyOnceWith(SESSION, ASIDE);
    // A refusal is an answer, as a Send's is.
    made.ask.mockResolvedValueOnce({ status: 'refused', reason: 'no-conversation' });
    expect(await ask('chat:ask', made, 'main', valid('chat:ask'))).toEqual({ ok: true, value: { status: 'refused', reason: 'no-conversation' } });
    // The session's own channels were not touched by any of it.
    for (const call of [made.send, made.stop, made.read, made.page, made.loadHistory]) expect(call).not.toHaveBeenCalled();
  });

  it('counts what became of each by its kind — which way in an ask was, and why one was not taken — and says no more of it than that', async () => {
    const made = runtime();
    const counts = createKindCounts();
    const handlers = chatHandlers(made, createKindCounts(), counts);
    const sender = { windowKind: 'main' } as never;
    await handlers['chat:ask']({ sessionId: SESSION, asideId: ASIDE, text: 'PRIVATE-QUESTION' }, sender);
    await handlers['chat:ask']({ sessionId: SESSION, asideId: ASIDE, source: { ...SOURCE, path: null } }, sender);
    for (const reason of ['unsupported', 'no-conversation', 'aside-running', 'folder-not-trusted'] as const) {
      made.ask.mockResolvedValueOnce({ status: 'refused', reason });
      await handlers['chat:ask']({ sessionId: SESSION, asideId: ASIDE, text: 'PRIVATE-QUESTION' }, sender);
    }
    await handlers['chat:readAside']({ sessionId: SESSION, asideId: ASIDE }, sender);
    await handlers['chat:readAside']({ sessionId: SESSION, asideId: ASIDE, before: 'PRIVATE-CURSOR' }, sender);
    made.readAside.mockReturnValueOnce({ status: 'refused', reason: 'unknown-aside' });
    await handlers['chat:readAside']({ sessionId: SESSION, asideId: ASIDE }, sender);
    await handlers['chat:stopAside']({ sessionId: SESSION, asideId: ASIDE }, sender);
    made.stopAside.mockReturnValueOnce({ status: 'refused', reason: 'not-running' });
    await handlers['chat:stopAside']({ sessionId: SESSION, asideId: ASIDE }, sender);
    await handlers['chat:removeAside']({ sessionId: SESSION, asideId: ASIDE }, sender);
    made.removeAside.mockReturnValueOnce({ status: 'refused', reason: 'storage-failed' });
    await handlers['chat:removeAside']({ sessionId: SESSION, asideId: ASIDE }, sender);
    expect(counts.snapshot()).toEqual({
      'question:accepted': 1, 'explain:accepted': 1,
      'question:refused:unsupported': 1, 'question:refused:no-conversation': 1, 'question:refused:aside-running': 1, 'question:refused:folder-not-trusted': 1,
      'read:read': 1, 'page:read': 1, 'read:refused:unknown-aside': 1,
      'stop:stopping': 1, 'stop:refused:not-running': 1,
      'remove:removed': 1, 'remove:refused:storage-failed': 1,
    });
    // Kinds alone: no question, no passage, no cursor, and no id of a session or an aside.
    const told = JSON.stringify(counts.snapshot());
    expect(told).not.toMatch(/PRIVATE|a51de|5e551/);
  });

  it.each(['kinds', 'full'] as const)('leaves in the log of a %s build an aside’s channel and kind alone — never a question, a passage or an answer — for a bad request and for a handler that fails', async (detail) => {
    log.warn.mockClear();
    log.error.mockClear();
    const made = runtime();
    const question = 'PRIVATE-QUESTION-TEXT';
    // Refused as bad requests: an unknown field beside a question, and beside a passage.
    await ask('chat:ask', made, 'main', { sessionId: SESSION, asideId: ASIDE, text: question, extra: question }, detail);
    await ask('chat:ask', made, 'main', { sessionId: SESSION, asideId: ASIDE, source: { ...SOURCE, extra: 'PRIVATE-EXTRA' } }, detail);
    await ask('chat:readAside', made, 'main', { sessionId: SESSION, asideId: ASIDE, before: 'PRIVATE-CURSOR', extra: 1 }, detail);
    // And handlers that fail while holding a question and a passage. A packaged build logs a failure
    // by its kind alone, whatever its error says; a development build logs the error, which main
    // never writes a text into.
    const words = (what: string): string => (detail === 'kinds' ? `${what} for ${question} about PRIVATE-EXCERPT, answered PRIVATE-ANSWER` : what);
    made.ask.mockRejectedValueOnce(new Error(words('could not ask')));
    expect(await ask('chat:ask', made, 'main', { sessionId: SESSION, asideId: ASIDE, text: question }, detail)).toEqual({ ok: false, error: 'internal' });
    made.ask.mockRejectedValueOnce(new Error(words('the store failed')));
    expect(await ask('chat:ask', made, 'main', { sessionId: SESSION, asideId: ASIDE, source: SOURCE }, detail)).toEqual({ ok: false, error: 'internal' });
    made.readAside.mockImplementationOnce(() => { throw new Error(words('could not be read')); });
    expect(await ask('chat:readAside', made, 'main', valid('chat:readAside'), detail)).toEqual({ ok: false, error: 'internal' });
    made.removeAside.mockImplementationOnce(() => { throw new Error(words('could not be removed')); });
    expect(await ask('chat:removeAside', made, 'main', valid('chat:removeAside'), detail)).toEqual({ ok: false, error: 'internal' });
    const logged = [...log.warn.mock.calls, ...log.error.mock.calls].flat().map((part: unknown) => (part instanceof Error ? `${part.message} ${part.stack ?? ''}` : JSON.stringify(part))).join('\n');
    for (const channel of ['chat:ask', 'chat:readAside', 'chat:removeAside']) expect(logged).toContain(channel);
    expect(logged).not.toContain('PRIVATE');
    expect(logged).not.toContain(ASIDE);
  });

  // M21, V8 (C31, C34, C44): an answer to a question's card, and a dismissal.
  it('hands an answer and a dismissal to the runtime, by the card’s item and the answers’ places, and answers what it answers', async () => {
    const made = runtime();
    expect(await ask('chat:answer', made, 'main', valid('chat:answer'))).toEqual({ ok: true, value: { status: 'answered' } });
    expect(made.answer).toHaveBeenCalledExactlyOnceWith(SESSION, 'card-1', ANSWERS);
    expect(await ask('chat:dismiss', made, 'main', valid('chat:dismiss'))).toEqual({ ok: true, value: { status: 'dismissed' } });
    expect(made.dismiss).toHaveBeenCalledExactlyOnceWith(SESSION, 'card-1');
    // A refusal is an answer: a stale press, and an async card's own, which is a send's.
    for (const reason of ['not-pending', 'incomplete', 'mismatch', 'too-long', 'running', 'folder-not-trusted'] as const) {
      made.answer.mockResolvedValueOnce({ status: 'refused', reason });
      expect(await ask('chat:answer', made, 'main', valid('chat:answer'))).toEqual({ ok: true, value: { status: 'refused', reason } });
    }
    made.dismiss.mockReturnValueOnce({ status: 'refused', reason: 'not-open' });
    expect(await ask('chat:dismiss', made, 'main', valid('chat:dismiss'))).toEqual({ ok: true, value: { status: 'refused', reason: 'not-open' } });
    // An answer at its bound is taken; the session's own Send was never touched.
    expect(await ask('chat:answer', made, 'main', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: [], text: 'x'.repeat(MAX_ANSWER_TEXT) }] })).toMatchObject({ ok: true });
    expect(made.send).not.toHaveBeenCalled();
  });

  it('counts what became of an answer and a dismissal by its kind, and says no more of either than that', async () => {
    const made = runtime();
    const counts = createKindCounts();
    const handlers = chatHandlers(made, createKindCounts(), createKindCounts(), counts);
    const sender = { windowKind: 'main' } as never;
    const answer = { sessionId: SESSION, itemId: 'PRIVATE-ITEM', answers: [{ question: 0, options: [1], text: 'PRIVATE-ANSWER' }] };
    await handlers['chat:answer'](answer, sender);
    for (const reason of ['not-pending', 'mismatch', 'too-long', 'storage-failed', 'running'] as const) {
      made.answer.mockResolvedValueOnce({ status: 'refused', reason });
      await handlers['chat:answer'](answer, sender);
    }
    await handlers['chat:dismiss']({ sessionId: SESSION, itemId: 'PRIVATE-ITEM' }, sender);
    made.dismiss.mockReturnValueOnce({ status: 'refused', reason: 'not-open' });
    await handlers['chat:dismiss']({ sessionId: SESSION, itemId: 'PRIVATE-ITEM' }, sender);
    expect(counts.snapshot()).toEqual({
      'answer:answered': 1, 'answer:refused:not-pending': 1, 'answer:refused:mismatch': 1, 'answer:refused:too-long': 1, 'answer:refused:storage-failed': 1, 'answer:refused:running': 1,
      'dismiss:dismissed': 1, 'dismiss:refused:not-open': 1,
    });
    expect(JSON.stringify(counts.snapshot())).not.toMatch(/PRIVATE|5e551/);
  });

  it.each(['kinds', 'full'] as const)('leaves in the log of a %s build an answer’s channel and kind alone — never a question, an option, an answer or a secret’s — for a bad request and for a handler that fails', async (detail) => {
    log.warn.mockClear();
    log.error.mockClear();
    const made = runtime();
    const secret = 'PRIVATE-SECRET-ANSWER';
    const answer = { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: [], text: secret }] };
    // Refused as bad requests: an unknown field, an answer past its bound, an option by its label.
    await ask('chat:answer', made, 'main', { ...answer, extra: secret }, detail);
    await ask('chat:answer', made, 'main', { ...answer, answers: [{ question: 0, options: [], text: `${secret}${'x'.repeat(MAX_ANSWER_TEXT)}` }] }, detail);
    await ask('chat:answer', made, 'main', { ...answer, answers: [{ question: 0, options: ['PRIVATE-LABEL'], text: null }] }, detail);
    await ask('chat:dismiss', made, 'main', { sessionId: SESSION, itemId: 'card-1', why: 'PRIVATE-REASON' }, detail);
    // And handlers that fail while holding the answer.
    const words = (what: string): string => (detail === 'kinds' ? `${what}: ${secret} for PRIVATE-QUESTION` : what);
    made.answer.mockRejectedValueOnce(new Error(words('could not answer')));
    expect(await ask('chat:answer', made, 'main', answer, detail)).toEqual({ ok: false, error: 'internal' });
    made.dismiss.mockImplementationOnce(() => { throw new Error(words('could not dismiss')); });
    expect(await ask('chat:dismiss', made, 'main', valid('chat:dismiss'), detail)).toEqual({ ok: false, error: 'internal' });
    const logged = [...log.warn.mock.calls, ...log.error.mock.calls].flat().map((part: unknown) => (part instanceof Error ? `${part.message} ${part.stack ?? ''}` : JSON.stringify(part))).join('\n');
    for (const channel of ['chat:answer', 'chat:dismiss']) expect(logged).toContain(channel);
    expect(logged).not.toContain('PRIVATE');
  });

  it('reads the window the page holds: from its oldest item, keeping what it says (M18, C60)', async () => {
    const made = runtime();
    await ask('chat:read', made, 'main', { sessionId: SESSION, from: 'item-7', keep: 'oldest' });
    expect(made.read).toHaveBeenCalledExactlyOnceWith(SESSION, { from: 'item-7', keep: 'oldest' });
  });

  // M22, V7 (C26, C88): a change of a chat's mode, and a decision on an approval's card.
  it('hands a change of mode and a decision to the runtime, by a mode’s id and by the card’s item and a choice, and answers what it answers', async () => {
    const made = runtime();
    expect(await ask('chat:setMode', made, 'main', valid('chat:setMode'))).toEqual({ ok: true, value: { status: 'set' } });
    expect(made.setMode).toHaveBeenCalledExactlyOnceWith(SESSION, 'ask-first');
    expect(await ask('chat:decide', made, 'main', valid('chat:decide'))).toEqual({ ok: true, value: { status: 'decided' } });
    expect(made.decide).toHaveBeenCalledExactlyOnceWith(SESSION, 'card-1', 'approve');
    // A refusal is an answer: the gate's own word among them, and what the CLI said instead.
    for (const reason of ['mode-unavailable', 'running', 'changing-mode', 'folder-not-trusted'] as const) {
      made.setMode.mockResolvedValueOnce({ status: 'refused', reason });
      expect(await ask('chat:setMode', made, 'main', valid('chat:setMode'))).toEqual({ ok: true, value: { status: 'refused', reason } });
    }
    made.setMode.mockResolvedValueOnce({ status: 'refused', reason: 'not-confirmed', detail: 'default' });
    expect(await ask('chat:setMode', made, 'main', valid('chat:setMode'))).toEqual({ ok: true, value: { status: 'refused', reason: 'not-confirmed', detail: 'default' } });
    made.decide.mockReturnValueOnce({ status: 'refused', reason: 'not-offered' });
    expect(await ask('chat:decide', made, 'main', { sessionId: SESSION, itemId: 'card-1', choice: 'approve-session' })).toEqual({ ok: true, value: { status: 'refused', reason: 'not-offered' } });
  });

  it.each([
    // A mode is an id of fat-g's, never a native word, a flag or a scope.
    ['chat:setMode', { sessionId: SESSION }],
    ['chat:setMode', { sessionId: SESSION, mode: 'acceptEdits' }],
    ['chat:setMode', { sessionId: SESSION, mode: 'ask-first', sandbox: 'danger-full-access' }],
    ['chat:setMode', { sessionId: SESSION, mode: 'ask-first', once: true }],
    // A decision names the card and a choice: no request, no tool's input, no rule and no destination.
    ['chat:decide', { sessionId: SESSION, itemId: 'card-1' }],
    ['chat:decide', { sessionId: SESSION, itemId: 'card-1', choice: 'always' }],
    ['chat:decide', { sessionId: SESSION, requestId: 'n:1', choice: 'approve' }],
    ['chat:decide', { sessionId: SESSION, itemId: 'card-1', choice: 'approve', updatedInput: { command: 'rm -rf ~' } }],
    ['chat:decide', { sessionId: SESSION, itemId: 'card-1', choice: 'approve-session', destination: 'localSettings' }],
    ['chat:decide', { sessionId: SESSION, itemId: 'card-1', choice: 'approve-session', rules: [{ toolName: 'Bash' }] }],
  ] as const)('refuses %s with %j before any handler, through the dispatcher', async (channel, request) => {
    const made = runtime();
    expect(await ask(channel, made, 'main', request)).toEqual({ ok: false, error: 'bad-request' });
    for (const call of Object.values(made)) expect(call).not.toHaveBeenCalled();
  });

  it('counts what became of a change of mode and a decision by its kind, and says no more of either than that', async () => {
    const made = runtime();
    const counts = createKindCounts();
    const handlers = chatHandlers(made, createKindCounts(), createKindCounts(), createKindCounts(), counts);
    const sender = { windowKind: 'main' } as never;
    await handlers['chat:setMode']({ sessionId: SESSION, mode: 'private-mode' }, sender);
    made.setMode.mockResolvedValueOnce({ status: 'refused', reason: 'not-confirmed', detail: 'PRIVATE-DETAIL' });
    await handlers['chat:setMode']({ sessionId: SESSION, mode: 'private-mode' }, sender);
    await handlers['chat:decide']({ sessionId: SESSION, itemId: 'PRIVATE-ITEM', choice: 'approve-session' }, sender);
    made.decide.mockReturnValueOnce({ status: 'refused', reason: 'not-pending' });
    await handlers['chat:decide']({ sessionId: SESSION, itemId: 'PRIVATE-ITEM', choice: 'deny' }, sender);
    expect(counts.snapshot()).toEqual({ 'mode:set': 1, 'mode:refused:not-confirmed': 1, 'decide:approve-session': 1, 'decide:refused:not-pending': 1 });
    expect(JSON.stringify(counts.snapshot())).not.toMatch(/PRIVATE|private-mode|5e551/);
  });

  it('carries a refusal as an answer, not as an error', async () => {
    const made = runtime();
    made.send.mockResolvedValueOnce({ status: 'refused', reason: 'folder-not-trusted' } as never);
    expect(await ask('chat:send', made, 'main', valid('chat:send'))).toEqual({ ok: true, value: { status: 'refused', reason: 'folder-not-trusted' } });
  });

  // C76: a prompt and a message are the user's conversation, and the Pet shows on screen shares.
  it.each(CHANNELS)('refuses the Pet on %s as forbidden, and reaches no session', async (channel) => {
    const made = runtime();
    expect(INVOKE_SPECS[channel].from).toEqual(['main']);
    expect(await ask(channel, made, 'pet', valid(channel))).toEqual({ ok: false, error: 'forbidden' });
    for (const call of Object.values(made)) expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['chat:read', null],
    ['chat:read', {}],
    ['chat:read', { sessionId: 'not-an-id' }],
    ['chat:read', { sessionId: SESSION, folder: 'D:\\Code' }],
    ['chat:read', { sessionId: SESSION, from: 'item-1' }],
    ['chat:read', { sessionId: SESSION, from: 'item-1', keep: 'everything' }],
    ['chat:page', { sessionId: SESSION }],
    ['chat:page', { sessionId: SESSION, before: '' }],
    ['chat:page', { sessionId: SESSION, before: 'item-1', limit: 100_000 }],
    ['chat:readWorker', { sessionId: SESSION }],
    ['chat:readWorker', { sessionId: SESSION, workerId: '' }],
    ['chat:readWorker', { sessionId: SESSION, workerId: 'x'.repeat(257) }],
    ['chat:readWorker', { sessionId: 'not-an-id', workerId: 'worker-1' }],
    ['chat:readWorker', { sessionId: SESSION, workerId: 'worker-1', from: 'item-1', keep: 'newest' }],
    ['chat:readWorker', { sessionId: SESSION, workerId: 'worker-1', before: '' }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE }],
    ['chat:ask', { sessionId: SESSION, text: 'Why?' }],
    ['chat:ask', { sessionId: SESSION, asideId: 'not-an-id', text: 'Why?' }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, text: '' }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, text: ' \n ' }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, text: 'x'.repeat(MAX_MESSAGE_TEXT + 1) }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, text: 'Why?', source: SOURCE }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, text: 'Why?', model: 'gpt-6-sol' }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, source: { ...SOURCE, excerpt: '' } }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, source: { ...SOURCE, kind: 'plan' } }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, source: { ...SOURCE, role: null } }],
    ['chat:ask', { sessionId: SESSION, asideId: ASIDE, source: { ...SOURCE, digest: 'nope' } }],
    ['chat:readAside', { sessionId: SESSION }],
    ['chat:readAside', { sessionId: SESSION, asideId: ASIDE, before: '' }],
    ['chat:readAside', { sessionId: SESSION, asideId: ASIDE, from: 'item-1', keep: 'newest' }],
    ['chat:stopAside', { sessionId: SESSION }],
    ['chat:stopAside', { sessionId: SESSION, asideId: ASIDE, force: true }],
    ['chat:removeAside', { asideId: ASIDE }],
    ['chat:removeAside', { sessionId: 'not-an-id', asideId: ASIDE }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1' }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [] }],
    ['chat:answer', { sessionId: SESSION, itemId: '', answers: ANSWERS }],
    ['chat:answer', { sessionId: 'not-an-id', itemId: 'card-1', answers: ANSWERS }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: ANSWERS, requestId: 'request-1' }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: [1], text: null, key: 'Which file?' }] }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: ['notes-1.txt'], text: null }] }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 16, options: [], text: 'x' }] }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: [8], text: null }] }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: [], text: 'x'.repeat(MAX_ANSWER_TEXT + 1) }] }],
    ['chat:answer', { sessionId: SESSION, itemId: 'card-1', answers: [{ question: 0, options: [] }] }],
    ['chat:dismiss', { sessionId: SESSION }],
    ['chat:dismiss', { sessionId: SESSION, itemId: 'card-1', answers: ANSWERS }],
    ['chat:dismiss', { itemId: 'card-1' }],
    ['chat:stop', { sessionId: SESSION, force: true }],
    ['chat:loadHistory', { sessionId: 7 }],
    ['chat:send', { sessionId: SESSION }],
    ['chat:send', { sessionId: SESSION, prompt: '' }],
    ['chat:send', { sessionId: SESSION, prompt: ' \n\t ' }],
    ['chat:send', { sessionId: SESSION, prompt: 'x'.repeat(MAX_MESSAGE_TEXT + 1) }],
    ['chat:send', { sessionId: SESSION, prompt: ['Fix it'] }],
    ['chat:send', { sessionId: SESSION, prompt: 'Fix it', model: 'gpt-6-sol' }],
    ['chat:send', { sessionId: SESSION, prompt: 'Fix it', folder: 'D:\\Elsewhere' }],
  ] as const)('refuses a bad request on %s (%j)', async (channel, request) => {
    const made = runtime();
    expect(await ask(channel, made, 'main', request)).toEqual({ ok: false, error: 'bad-request' });
    for (const call of Object.values(made)) expect(call).not.toHaveBeenCalled();
  });

  it('takes a prompt at its bound', async () => {
    const made = runtime();
    expect(await ask('chat:send', made, 'main', { sessionId: SESSION, prompt: 'x'.repeat(MAX_MESSAGE_TEXT) })).toEqual({ ok: true, value: { status: 'accepted' } });
  });

  // V22 (C75): a prompt is never in a log, whatever the build and whatever became of the request.
  it.each(['kinds', 'full'] as const)('keeps a prompt out of the log in a %s build, for a bad request and for a handler that fails', async (detail) => {
    log.warn.mockClear();
    log.error.mockClear();
    const made = runtime();
    const secret = 'PRIVATE-PROMPT-TEXT';
    await ask('chat:send', made, 'main', { sessionId: 'not-an-id', prompt: secret }, detail);
    await ask('chat:send', made, 'main', { sessionId: SESSION, prompt: secret, extra: secret }, detail);
    made.send.mockRejectedValueOnce(new Error('the runtime failed'));
    expect(await ask('chat:send', made, 'main', { sessionId: SESSION, prompt: secret }, detail)).toEqual({ ok: false, error: 'internal' });
    expect(log.warn).toHaveBeenCalled();
    // Everything handed to the log, an error's own message and stack included.
    const logged = [...log.warn.mock.calls, ...log.error.mock.calls].flat().map((part: unknown) => (part instanceof Error ? `${part.message} ${part.stack ?? ''}` : JSON.stringify(part)));
    expect(logged.join('\n')).not.toContain(secret);
  });
});
