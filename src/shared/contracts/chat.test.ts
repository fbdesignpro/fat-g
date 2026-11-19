// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V18, V31 (docs/planning/_archive/M15.md; C54, C96) and V9 (M18.md; C20, C60): the chat's requests, and the
// page's rule for taking a read's answer or a push when two sessions' revisions match.
import { describe, expect, it } from 'vitest';
import { MAX_AGENT_ID, MAX_MESSAGE_TEXT } from './agent-events';
import { ANSWER_REFUSALS, asideNoticeWords, ASK_REFUSALS, blockWords, ChatAnswerRequestSchema, ChatDismissRequestSchema, DISMISS_REFUSALS, SEND_REFUSALS, CHAT_LINES, CHAT_NOTICE_KINDS, ChatAsideReadRequestSchema, ChatAsideRequestSchema, ChatAskRequestSchema, ChatPageRequestSchema, type ChatPush, ChatReadRequestSchema, ChatSendRequestSchema, ChatSessionRequestSchema, ChatWorkerReadRequestSchema, type HeldChat, noticeWords, REMOVE_CHAT_TEXT, removeUnsure, takeChat, appendText, PARTIAL_PUSH_MS, PROGRESS_WRITE_MS } from './chat';
import { COMMAND_NOTICE_KINDS, type ConversationItem, type ConversationTurn } from './conversation';
import { MAX_ANSWER_TEXT } from './interaction';
import { SEND_BLOCKS } from './sessions';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const TURN: ConversationTurn = { id: 't1', place: 1, origin: 'local', state: 'running', outcome: null, gap: false, mode: null, time: { acceptedAt: 1, providerStartedAt: null, providerEndedAt: null, endReceivedAt: null, providerDurationMs: null, elapsedMs: null } };
const item = (sessionId: string, place: number): ConversationItem => ({
  id: `m${place}`, conversationId: sessionId, turnId: 't1', order: { turn: 1, item: place }, kind: 'message', origin: 'local', providerItemId: null, workerId: null, activity: null, interaction: null, role: 'assistant', phase: 'final', model: null, state: 'complete',
  blocks: [{ type: 'text', text: 'x', cut: false }], questions: [], notice: null, detail: null, time: { receivedAt: 1, providerAt: null },
});
const push = (sessionId: string, revision: number): ChatPush => ({ sessionId, revision, item: item(sessionId, revision), turn: TURN });
const changed = (sessionId: string, revision: number): ChatPush => ({ sessionId, revision, changed: true });
const partial = (sessionId: string, revision: number): ChatPush => ({ sessionId, revision, partial: { itemId: 'm1', before: 1, append: 'y' } });

describe('the chat requests (V18)', () => {
  it('take a session id, and a prompt of 1 to 100 000 characters that is not only whitespace', () => {
    expect(ChatSessionRequestSchema.safeParse({ sessionId: A }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ sessionId: A, prompt: 'hello' }).success).toBe(true);
    expect(ChatSendRequestSchema.safeParse({ sessionId: A, prompt: 'x'.repeat(MAX_MESSAGE_TEXT) }).success).toBe(true);
  });

  it('refuse extra fields, a session id that is not one, and an empty, whitespace-only or over-long prompt', () => {
    expect(ChatSessionRequestSchema.safeParse({ sessionId: A, extra: 1 }).success).toBe(false);
    expect(ChatSessionRequestSchema.safeParse({ sessionId: 'not-an-id' }).success).toBe(false);
    expect(ChatSessionRequestSchema.safeParse({}).success).toBe(false);
    for (const prompt of ['', '   ', '\n\t ', 'x'.repeat(MAX_MESSAGE_TEXT + 1), 7, null]) {
      expect(ChatSendRequestSchema.safeParse({ sessionId: A, prompt }).success, String(prompt).slice(0, 20)).toBe(false);
    }
    expect(ChatSendRequestSchema.safeParse({ sessionId: A, prompt: 'hi', folder: '/x' }).success).toBe(false);
  });

  it('read the newest page, or the held window from its oldest item, and a page before a cursor (M18, C20, C60)', () => {
    expect(ChatReadRequestSchema.safeParse({ sessionId: A }).success).toBe(true);
    expect(ChatReadRequestSchema.safeParse({ sessionId: A, from: 'item-1', keep: 'newest' }).success).toBe(true);
    expect(ChatReadRequestSchema.safeParse({ sessionId: A, from: 'item-1', keep: 'oldest' }).success).toBe(true);
    // A window names both its start and what it keeps, and nothing else.
    for (const request of [{ sessionId: A, from: 'item-1' }, { sessionId: A, keep: 'newest' }, { sessionId: A, from: 'item-1', keep: 'all' }, { sessionId: A, from: '', keep: 'newest' }, { sessionId: A, from: 'a\nb', keep: 'newest' }, { sessionId: A, extra: 1 }]) {
      expect(ChatReadRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    }
    expect(ChatPageRequestSchema.safeParse({ sessionId: A, before: 'item-1' }).success).toBe(true);
    for (const request of [{ sessionId: A }, { sessionId: A, before: 'x'.repeat(129) }, { sessionId: A, before: 'item-1', limit: 500 }]) {
      expect(ChatPageRequestSchema.safeParse(request).success, JSON.stringify(request).slice(0, 60)).toBe(false);
    }
  });
});

describe('what the page does with an answer or a push (V31, C96)', () => {
  const held: HeldChat = { sessionId: A, revision: 5 };

  it('drops a push, and a read’s answer, for the session not shown, though their revisions match', () => {
    expect(takeChat(held, { kind: 'push', push: push(B, 6) })).toBe('drop');
    expect(takeChat(held, { kind: 'read', sessionId: B, revision: 9 })).toBe('drop');
    expect(takeChat({ sessionId: null, revision: null }, { kind: 'push', push: push(A, 1) })).toBe('drop');
  });

  it('applies an item push exactly one above, and drops a duplicate or an older one', () => {
    expect(takeChat(held, { kind: 'push', push: push(A, 6) })).toBe('append');
    expect(takeChat(held, { kind: 'push', push: push(A, 5) })).toBe('drop');
    expect(takeChat(held, { kind: 'push', push: push(A, 2) })).toBe('drop');
  });

  it('reads again on a gap, and on word that the list changed as a whole', () => {
    expect(takeChat(held, { kind: 'push', push: push(A, 7) })).toBe('read');
    expect(takeChat(held, { kind: 'push', push: changed(A, 6) })).toBe('read');
    expect(takeChat(held, { kind: 'push', push: changed(A, 9) })).toBe('read');
    expect(takeChat(held, { kind: 'push', push: changed(A, 5) })).toBe('drop');
  });

  it('takes a read’s answer that is not older than what it holds, and drops one answered after a newer push', () => {
    expect(takeChat(held, { kind: 'read', sessionId: A, revision: 5 })).toBe('take');
    expect(takeChat(held, { kind: 'read', sessionId: A, revision: 8 })).toBe('take');
    expect(takeChat(held, { kind: 'read', sessionId: A, revision: 4 })).toBe('drop');
  });

  it('drops every push until the first answer has come, and takes that answer whatever its revision', () => {
    const fresh: HeldChat = { sessionId: A, revision: null };
    expect(takeChat(fresh, { kind: 'push', push: push(A, 1) })).toBe('drop');
    expect(takeChat(fresh, { kind: 'push', push: changed(A, 3) })).toBe('drop');
    expect(takeChat(fresh, { kind: 'push', push: partial(A, 1) })).toBe('drop');
    expect(takeChat(fresh, { kind: 'read', sessionId: A, revision: 0 })).toBe('take');
  });

  // M19, V11 (C24): more text of a message that is being written.
  it('takes a partial push exactly one above as text to append, drops a duplicate, and reads again on a gap', () => {
    expect(takeChat(held, { kind: 'push', push: partial(A, 6) })).toBe('append-text');
    expect(takeChat(held, { kind: 'push', push: partial(A, 5) })).toBe('drop');
    expect(takeChat(held, { kind: 'push', push: partial(A, 8) })).toBe('read');
    expect(takeChat(held, { kind: 'push', push: partial(B, 6) })).toBe('drop');
  });

  it('appends a partial push’s text only to the item it names, at exactly the length it says the text had', () => {
    const held = { ...item(A, 1), state: 'streaming' as const, blocks: [{ type: 'text' as const, text: 'Hel', cut: false }] };
    const grown = appendText(held, { itemId: 'm1', before: 3, append: 'lo' });
    expect(grown?.blocks).toEqual([{ type: 'text', text: 'Hello', cut: false }]);
    // Everything else of the item is as it was: its state, its phase, its place.
    expect(grown).toMatchObject({ id: 'm1', state: 'streaming', phase: 'final', order: held.order });
    expect(held.blocks[0]?.text).toBe('Hel');
    // Another length, another item, or an item with no text block: the window is read again.
    expect(appendText(held, { itemId: 'm1', before: 2, append: 'lo' })).toBeNull();
    expect(appendText(held, { itemId: 'm1', before: 4, append: 'lo' })).toBeNull();
    expect(appendText(held, { itemId: 'm2', before: 3, append: 'lo' })).toBeNull();
    expect(appendText({ ...held, blocks: [] }, { itemId: 'm1', before: 0, append: 'lo' })).toBeNull();
    // Lengths are UTF-16 units: a pair counts two, and a push may end between a pair's halves.
    const pair = { ...held, blocks: [{ type: 'text' as const, text: 'a\ud83d', cut: false }] };
    expect(appendText(pair, { itemId: 'm1', before: 2, append: '\ude00!' })?.blocks[0]?.text).toBe('a😀!');
  });

  it('gathers a session’s text for 50 ms at most, and writes an open message again every 2 seconds at most (C16, C25)', () => {
    expect([PARTIAL_PUSH_MS, PROGRESS_WRITE_MS]).toEqual([50, 2_000]);
  });

  // M20a, V7 (C32): a push that names a worker.
  describe('a worker’s push (M20a; C32)', () => {
    const workers = (sessionId: string, revision: number, workerId: string): ChatPush => ({ ...push(sessionId, revision), workerId });
    const workersText = (sessionId: string, revision: number, workerId: string): ChatPush => ({ ...partial(sessionId, revision), workerId });
    const tab: HeldChat = { sessionId: A, revision: 5, workerId: 'w1' };

    it('is taken by the list for its revision alone: nothing of its window changes, and nothing is read again', () => {
      expect(takeChat(held, { kind: 'push', push: workers(A, 6, 'w1') })).toBe('pass');
      expect(takeChat(held, { kind: 'push', push: workersText(A, 6, 'w1') })).toBe('pass');
      // As any push: an older one is dropped, another session's too, and a gap is read.
      expect(takeChat(held, { kind: 'push', push: workers(A, 5, 'w1') })).toBe('drop');
      expect(takeChat(held, { kind: 'push', push: workers(B, 6, 'w1') })).toBe('drop');
      expect(takeChat(held, { kind: 'push', push: workers(A, 8, 'w1') })).toBe('read');
    });

    it('is applied by that worker’s tab as the list applies its own', () => {
      expect(takeChat(tab, { kind: 'push', push: workers(A, 6, 'w1') })).toBe('append');
      expect(takeChat(tab, { kind: 'push', push: workersText(A, 6, 'w1') })).toBe('append-text');
    });

    it('is passed by another worker’s tab, as the session’s own is by any worker’s', () => {
      expect(takeChat(tab, { kind: 'push', push: workers(A, 6, 'w2') })).toBe('pass');
      expect(takeChat(tab, { kind: 'push', push: push(A, 6) })).toBe('pass');
      expect(takeChat(tab, { kind: 'push', push: partial(A, 6) })).toBe('pass');
    });

    it('word that something else changed is read by both, whoever holds the window', () => {
      expect(takeChat(tab, { kind: 'push', push: changed(A, 6) })).toBe('read');
      expect(takeChat({ ...held, workerId: null }, { kind: 'push', push: changed(A, 6) })).toBe('read');
    });
  });

  // M20b, V7 (C73): a push that names an aside, as its tab, the list and every other window take it.
  describe('an aside’s push (M20b; C73)', () => {
    const asides = (sessionId: string, revision: number, asideId: string): ChatPush => ({ ...push(sessionId, revision), asideId }) as ChatPush;
    const asidesText = (sessionId: string, revision: number, asideId: string): ChatPush => ({ ...partial(sessionId, revision), asideId }) as ChatPush;
    const asidesChange = (sessionId: string, revision: number, asideId: string): ChatPush => ({ sessionId, revision, changed: true, asideId });
    const tab: HeldChat = { sessionId: A, revision: 5, asideId: 'aside-1' };
    const workersTab: HeldChat = { sessionId: A, revision: 5, workerId: 'w1' };

    it.each([
      ['the list', held, 'aside-1', 'pass', 'pass', 'pass'],
      ['a worker’s tab', workersTab, 'aside-1', 'pass', 'pass', 'pass'],
      ['the aside’s own tab', tab, 'aside-1', 'append', 'append-text', 'read'],
      ['another aside’s tab', tab, 'aside-2', 'pass', 'pass', 'pass'],
    ] as const)('%s takes an item, a partial and a change of it', (_who, window, asideId, onItem, onPartial, onChange) => {
      expect(takeChat(window, { kind: 'push', push: asides(A, 6, asideId) })).toBe(onItem);
      expect(takeChat(window, { kind: 'push', push: asidesText(A, 6, asideId) })).toBe(onPartial);
      expect(takeChat(window, { kind: 'push', push: asidesChange(A, 6, asideId) })).toBe(onChange);
    });

    it('is passed by an aside’s tab where it is the session’s own or a worker’s, and a change of the session’s list is read by it', () => {
      expect(takeChat(tab, { kind: 'push', push: push(A, 6) })).toBe('pass');
      expect(takeChat(tab, { kind: 'push', push: partial(A, 6) })).toBe('pass');
      expect(takeChat(tab, { kind: 'push', push: { ...push(A, 6), workerId: 'w1' } })).toBe('pass');
      // The session's list changed: an aside removed with nothing said of which is read for, by every window.
      expect(takeChat(tab, { kind: 'push', push: changed(A, 6) })).toBe('read');
      expect(takeChat(held, { kind: 'push', push: changed(A, 6) })).toBe('read');
    });

    it('is, as any push, dropped when older or another session’s, and read for on a gap — a change that names another aside included', () => {
      expect(takeChat(tab, { kind: 'push', push: asides(A, 5, 'aside-1') })).toBe('drop');
      expect(takeChat(tab, { kind: 'push', push: asides(B, 6, 'aside-1') })).toBe('drop');
      expect(takeChat(tab, { kind: 'push', push: asides(A, 8, 'aside-1') })).toBe('read');
      expect(takeChat(held, { kind: 'push', push: asidesChange(A, 8, 'aside-1') })).toBe('read');
      // Before its first answer a tab drops every push: its read will bring what they hold.
      expect(takeChat({ ...tab, revision: null }, { kind: 'push', push: asides(A, 6, 'aside-1') })).toBe('drop');
    });

    it('counts with its session’s revisions: the list that passed one applies the session’s next', () => {
      expect(takeChat(held, { kind: 'push', push: asides(A, 6, 'aside-1') })).toBe('pass');
      expect(takeChat({ ...held, revision: 6 }, { kind: 'push', push: push(A, 7) })).toBe('append');
    });
  });

  it('takes an ask by its session, the aside’s id and either a question or a selection’s report, and an aside’s read, Stop and removal by the two ids (M20b, C73)', () => {
    const source = { kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: null, range: { start: 0, end: 4 }, digest: '0badc0de', excerpt: 'text', cut: false };
    const base = { sessionId: A, asideId: B };
    expect(ChatAskRequestSchema.safeParse({ ...base, text: 'Why?' }).success).toBe(true);
    expect(ChatAskRequestSchema.safeParse({ ...base, source }).success).toBe(true);
    for (const bad of [
      base, { ...base, text: 'Why?', source }, { ...base, text: '' }, { ...base, text: '   ' }, { ...base, text: 'x'.repeat(100_001) }, { sessionId: A, text: 'Why?' }, { ...base, asideId: 'not-an-id', text: 'Why?' },
      { ...base, sessionId: 'nope', text: 'Why?' }, { ...base, source: { ...source, excerpt: '' } }, { ...base, source: { ...source, kind: 'plan' } }, { ...base, text: 'Why?', model: 'x' },
    ]) expect(ChatAskRequestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 100)).toBe(false);
    expect(ChatAsideReadRequestSchema.safeParse(base).success).toBe(true);
    expect(ChatAsideReadRequestSchema.safeParse({ ...base, before: 'item-1' }).success).toBe(true);
    expect(ChatAsideReadRequestSchema.safeParse({ ...base, from: 'item-1' }).success).toBe(false);
    expect(ChatAsideReadRequestSchema.safeParse({ sessionId: A }).success).toBe(false);
    expect(ChatAsideRequestSchema.safeParse(base).success).toBe(true);
    expect(ChatAsideRequestSchema.safeParse({ ...base, text: 'x' }).success).toBe(false);
    // Why an ask is not taken: these, and M15's blocks.
    expect([...ASK_REFUSALS]).toEqual(['unknown-session', 'unknown-aside', 'unsupported', 'no-conversation', 'aside-running', 'busy', 'unconfirmed', 'storage-failed', 'changing-mode', 'setting-up']);
  });

  it('takes a worker’s read request by its session and its worker, with a cursor for an older page (M20a, C32)', () => {
    const request = { sessionId: A, workerId: 'worker-1' };
    expect(ChatWorkerReadRequestSchema.safeParse(request).success).toBe(true);
    expect(ChatWorkerReadRequestSchema.safeParse({ ...request, before: 'item-1' }).success).toBe(true);
    for (const bad of [{ sessionId: A }, { ...request, workerId: '' }, { ...request, workerId: 'x'.repeat(MAX_AGENT_ID + 1) }, { ...request, workerId: 'a\u0000b' }, { ...request, sessionId: 'nope' }, { ...request, from: 'item-1' }, { ...request, before: '' }]) {
      expect(ChatWorkerReadRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('an answer and a dismissal (M21: V2; C31)', () => {
  const answer = { sessionId: A, itemId: 'card-1', answers: [{ question: 0, options: [1], text: null }] };

  it('take a session, the card’s item and one entry for each question, by places', () => {
    expect(ChatAnswerRequestSchema.safeParse(answer).success).toBe(true);
    expect(ChatAnswerRequestSchema.safeParse({ ...answer, answers: [{ question: 0, options: [], text: 'typed' }, { question: 1, options: [0, 2], text: 'and this' }] }).success).toBe(true);
    expect(ChatDismissRequestSchema.safeParse({ sessionId: A, itemId: 'card-1' }).success).toBe(true);
  });

  it('refuse an extra field, an answer past its bound, and anything that is no place', () => {
    for (const request of [
      { ...answer, requestId: 'request-1' },
      { ...answer, answers: [{ question: 0, options: [1], text: null, label: 'notes-2.txt' }] },
      { ...answer, answers: [{ question: 0, options: [], text: 'x'.repeat(MAX_ANSWER_TEXT + 1) }] },
      { ...answer, answers: [] },
      { ...answer, answers: [{ question: 0, options: ['notes-2.txt'], text: null }] },
      { ...answer, itemId: '' },
      { ...answer, sessionId: 'no-guid' },
      { sessionId: A, itemId: 'card-1' },
    ]) expect(ChatAnswerRequestSchema.safeParse(request).success, JSON.stringify(request).slice(0, 80)).toBe(false);
    expect(ChatAnswerRequestSchema.safeParse({ ...answer, answers: [{ question: 0, options: [], text: 'x'.repeat(MAX_ANSWER_TEXT) }] }).success).toBe(true);
    for (const request of [{ sessionId: A }, { sessionId: A, itemId: 'card-1', answers: [] }, { sessionId: A, itemId: 'a' + String.fromCharCode(10) }]) expect(ChatDismissRequestSchema.safeParse(request).success).toBe(false);
  });

  it('have closed lists of refusals: too long is an answer’s alone, and never a send’s (C26)', () => {
    expect([...ANSWER_REFUSALS]).toEqual(['unknown-session', 'unknown-item', 'not-pending', 'incomplete', 'mismatch', 'too-long', 'busy', 'storage-failed']);
    expect([...DISMISS_REFUSALS]).toEqual(['unknown-session', 'unknown-item', 'not-open', 'busy', 'storage-failed']);
    expect(SEND_REFUSALS as readonly string[]).not.toContain('too-long');
    // An async card's answer is a prompt: the send's own refusals are its too.
    expect(SEND_REFUSALS).toContain('running');
  });
});

describe('fat-g’s words', () => {
  it('has a sentence for every notice kind, naming the provider it is given and no other', () => {
    for (const kind of CHAT_NOTICE_KINDS) {
      const words = noticeWords(kind, 'Example', 'reopen');
      expect(words.length).toBeGreaterThan(10);
      expect(words).not.toMatch(/codex|claude|thread|app-server/i);
    }
    expect(noticeWords('start-failed', 'Example', 'send')).toContain('did not take the message');
    expect(noticeWords('start-failed', 'Example', 'launch')).toContain('could not be started');
  });

  it('says that no answer was given without a word as the model’s, and answers a command it did not send by naming it and the way in fat-g (M20b, C39, C56)', () => {
    expect(noticeWords('no-answer', 'Example')).toBe('No answer was given.');
    const clear = noticeWords('command-clear', 'Example');
    expect(clear).toBe('fat-g did not send /clear to Example. A session in fat-g keeps one conversation: for another, start a new session, or pick one from fat-g’s list.');
    const model = noticeWords('command-model', 'Example');
    expect(model).toBe('fat-g did not send /model to Example. A session’s model is fixed when the session is created: for another model, start a new session.');
    // And /fast (decision 0023): fat-g asks for the speed itself, with the effort.
    const fast = noticeWords('command-fast', 'Example');
    expect(fast).toBe('fat-g did not send /fast to Example. fat-g asks for a session’s speed itself: choose Fast with the effort, and it applies from the next reply.');
    // None claims what the command would have done: nothing was cleared, and no model or speed was changed.
    for (const words of [clear, model, fast]) expect(words).not.toMatch(/cleared|was changed|has been|switched|compact|turned on|turned off/i);
    expect([...COMMAND_NOTICE_KINDS]).toEqual(['command-clear', 'command-model', 'command-fast']);
    for (const kind of COMMAND_NOTICE_KINDS) expect(CHAT_NOTICE_KINDS).toContain(kind);
  });

  it('says of an aside’s turn what happened to the question, and never that the session’s turn was ended (M20b, C34, C39)', () => {
    for (const kind of ['start-failed', 'not-read-only', 'turn-failed', 'connection-lost', 'stop-unconfirmed'] as const) {
      const words = asideNoticeWords(kind, 'Example', 'open');
      expect(words, kind).toMatch(/question/);
      expect(words, kind).not.toBe(noticeWords(kind, 'Example', 'open'));
      expect(words, kind).not.toMatch(/codex|claude|thread|app-server|The turn was ended/i);
    }
    // Every other kind reads as it does in a session's chat.
    expect(asideNoticeWords('no-answer', 'Example')).toBe(noticeWords('no-answer', 'Example'));
    for (const kind of CHAT_NOTICE_KINDS) expect(asideNoticeWords(kind, 'Example', 'reopen').length, kind).toBeGreaterThan(10);
  });

  it('never says that a conversation was deleted, and says that the saved chat stays readable (C129; M16, C68)', () => {
    const offer = noticeWords('session-not-reopened', 'Example');
    expect(offer).toContain('It may have been deleted in Example, or something else may have gone wrong.');
    expect(offer).toContain('The chat fat-g saved stays readable.');
    expect(offer.endsWith('You can send again, or remove this session.')).toBe(true);
    expect(offer).toContain('remove this session');
    expect(removeUnsure('Example')).toContain('cannot tell for sure');
    expect(removeUnsure('Example')).toContain('nothing in Example is deleted');
  });

  it('tells a start refused before the prompt from one found overruled after it, and calls neither read-only (M16, C62, C63)', () => {
    const before = noticeWords('not-read-only', 'Example');
    expect(before).toContain('did not accept the restricted start, so nothing was sent');
    const after = noticeWords('start-overruled', 'Example');
    // The prompt was written: it never says that nothing was sent, or that nothing ran.
    expect(after).not.toMatch(/nothing was sent|nothing ran/i);
    expect(after).toContain('Your message had already been sent, so fat-g stopped the session.');
    // Both causes, which fat-g cannot tell apart.
    expect(after).toContain('A configuration that overrules fat-g’s start');
    expect(after).toContain('a version of Example that reports names fat-g does not know');
    for (const words of [before, after]) expect(words).not.toMatch(/read-only/i);
  });

  it('says that a folder was left out without naming it (M16, C20)', () => {
    const words = noticeWords('folder-not-passed', 'Example');
    expect(words).toBe('One of this project’s folders could not be passed to Example: its path holds a character fat-g cannot pass safely. The session runs without it.');
    expect(words).not.toMatch(/[A-Za-z]:\\|\//);
  });

  it('says that a removal deletes the saved chat, and nothing of the provider’s (M18, C21–C23)', () => {
    expect(removeUnsure('Example')).toContain('deletes the chat fat-g saved');
    expect(REMOVE_CHAT_TEXT.session('Example')).toContain('deleted too');
    expect(REMOVE_CHAT_TEXT.session('Example')).toContain('Example’s own history');
    expect(REMOVE_CHAT_TEXT.project).toContain('deleted too');
  });

  it('says of a saved session only that its entry could not be saved, and nothing of a restart (M18, C46)', () => {
    const words = noticeWords('session-unsaved', 'Example');
    expect(words).toBe('This session could not be saved to fat-g’s list. The conversation goes on.');
    expect(words).not.toMatch(/restart|anew/);
  });

  it('claims no more of an unconfirmed prompt than that it was not confirmed (M18, C15, C16)', () => {
    expect(CHAT_LINES.unacknowledged('Example')).toBe('Example did not confirm that it received this message.');
    expect(CHAT_LINES.unacknowledged('Example')).not.toMatch(/not (sent|delivered)|was lost/);
    expect(CHAT_LINES.unfinished).toBe('fat-g did not receive the end of this reply.');
  });

  it('has a reason in words for every block, with a remedy for the ones that have one (C68)', () => {
    const remedies = Object.fromEntries(SEND_BLOCKS.map((block) => [block, blockWords(block, 'Example').remedy]));
    expect(remedies).toEqual({
      'records-refused': null, 'conversations-refused': null, demo: null, 'provider-unavailable': 'settings', 'no-sessions': null, 'instance-unavailable': 'settings', 'folder-moved': null,
      'not-offered': 'edit-project', 'signed-out': 'settings', 'not-connected': 'settings', 'folder-not-root': 'edit-project', 'folder-not-trusted': 'edit-project', 'folder-missing': 'edit-project',
      // No other model is put in its place (decision 0016): nothing to press.
      'model-not-listed': null,
      // The chat's mode's own two (M22, C46, C89): their remedy is the change of mode itself.
      'mode-unconfirmed': 'change-mode', 'mode-unavailable': 'change-mode',
    });
    for (const block of SEND_BLOCKS) expect(blockWords(block, 'Example').text).not.toMatch(/[A-Za-z]:\\|\//);
  });
});
