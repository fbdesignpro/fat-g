// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3 (docs/planning/_archive/M20b.md; C13, C14): what the adapter reads of a side question's frames — its
// progress frame and its reply — on K1's captures, as tests/fixtures/claude/captures/ holds them,
// and on those frames with one named change. What it reads of a turn's frames is the mapper's test.
// And V2, V21, V27, V31 (docs/planning/_archive/M22.md; C5, C7, C8, C68, C76, C91): what it reads of a report's
// permission mode and tools, of a request to act, and of a denial by a rule, on K2's captures.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { frameKind, type RequestPayload, samePayload, takeAssistant, takeCancel, takeDenied, takeInit, takeModeReply, takeProgress, takeReply, takeRequest, takeSideReply, takeStatus, takeTask } from './chat-frames';

type Frame = Record<string, unknown>;
const capture = (name: string): { dir: string; frame: Frame }[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: Frame }[] }).frames;
const received = (name: string): Frame[] => capture(name).filter((entry) => entry.dir === 'recv').map((entry) => entry.frame);
/** The request id a capture's side question was sent under. */
const sideId = (name: string): string => String(capture(name).find((entry) => entry.dir === 'send' && (entry.frame['request'] as { subtype?: string } | undefined)?.subtype === 'side_question')?.frame['request_id']);
const progressOf = (name: string): Frame[] => received(name).filter((frame) => frame['subtype'] === 'control_request_progress');
/** The value a side question's reply carries: what `takeSideReply` is given. */
const replyOf = (name: string): unknown => {
  const id = sideId(name);
  const reply = received(name).find((frame) => frame['type'] === 'control_response' && (frame['response'] as { request_id?: string }).request_id === id);
  return (reply?.['response'] as { response?: unknown } | undefined)?.response;
};

describe('a side question’s progress frame (C14)', () => {
  it('is read as its own kind, and names the request that started', () => {
    for (const name of ['m20b-idle', 'm20b-followup', 'm20b-cancel', 'm20b-during', 'm20b-two']) {
      const frames = progressOf(name);
      expect(frames.length, name).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frameKind(frame), name).toBe('request-progress');
        expect(takeProgress(frame), name).toMatchObject({ status: 'started' });
      }
    }
    expect(takeProgress(progressOf('m20b-idle')[0])).toEqual({ requestId: sideId('m20b-idle'), status: 'started' });
    // Two asked at once: each has its own frame, under its own request's id.
    expect(new Set(progressOf('m20b-two').map((frame) => takeProgress(frame)?.requestId)).size).toBe(2);
  });

  it('says a retry is one, any other status is neither, and a frame that names no request is not read', () => {
    const [started] = progressOf('m20b-idle') as [Frame];
    expect(takeProgress({ ...started, status: 'api_retry' })).toEqual({ requestId: sideId('m20b-idle'), status: 'retry' });
    expect(takeProgress({ ...started, status: 'compacting' })).toEqual({ requestId: sideId('m20b-idle'), status: null });
    const { request_id: _id, ...unnamed } = started;
    expect(takeProgress(unnamed)).toBeNull();
    expect(takeProgress({ ...started, status: 7 })).toBeNull();
    expect(takeProgress({ ...started, request_id: '' })).toBeNull();
    expect(takeProgress(null)).toBeNull();
    // Nothing of it is text: what it returns holds the id and the status alone.
    expect(Object.keys(takeProgress({ ...started, message: 'private words', detail: 'more' }) ?? {}).sort()).toEqual(['requestId', 'status']);
  });

  it('is the only `system` frame of a request’s that is read: another subtype stays unread', () => {
    const [started] = progressOf('m20b-idle') as [Frame];
    expect(frameKind({ ...started, subtype: 'control_request_cancelled' })).toBe('unread');
    // The CLI's taking back of a request of its own is a kind of its own since M21 (C20): no `system` frame.
    expect(frameKind({ type: 'control_cancel_request', request_id: 'x' })).toBe('cancel');
  });
});

// V4 (docs/planning/_archive/M21.md, Design 3; C19, C20): what the adapter reads of a question's request and
// of its withdrawal, on K1's captures and on those frames with one named change.
describe('a question’s request (M21: C19)', () => {
  const requestOf = (name: string): Frame => received(name).find((frame) => frame['type'] === 'control_request') as Frame;
  const input = (name: string): Frame => (requestOf(name)['request'] as { input: Frame }).input;
  const change = (name: string, patch: Frame): Frame => ({ ...requestOf(name), request: { ...(requestOf(name)['request'] as Frame), ...patch } });

  it('is read for its request id, its tool use, its input’s questions and the worker it names, as K1’s captures hold it', () => {
    const frame = requestOf('m21-question-one');
    const one = takeRequest(frame);
    expect(one).toEqual({
      requestId: '<request-31>', subtype: 'can_use_tool', tool: true,
      question: {
        tool: 'AskUserQuestion', requestId: '<request-31>', toolUseId: '<tool-use-10>', agentId: null, input: input('m21-question-one'),
        questions: [{ text: 'Which file should I read?', header: 'File choice', options: [{ label: 'notes-1.txt', description: 'Read notes-1.txt' }, { label: 'notes-2.txt', description: 'Read notes-2.txt' }], multiple: false, freeText: true, secret: false }],
      },
      // M22 (C8, C91): it is no request to act, and its payload is kept as it came, to compare a repeated delivery with.
      action: null,
      // M22b: nor a plan.
      plan: null,
      payload: { tool: 'AskUserQuestion', input: input('m21-question-one'), toolUseId: '<tool-use-10>', agentId: undefined },
    });
    // The input is the request's own, whole and untouched: what the answer is sent back with (C17).
    expect(one.question?.input).toBe((frame['request'] as { input: Frame }).input);
    // `multiSelect` is whether several may be chosen; free text is always taken, and none is a secret (C7).
    expect(takeRequest(requestOf('m21-question-multi')).question?.questions).toMatchObject([{ text: 'Which notes file(s) should I read?', multiple: true, freeText: true, secret: false, options: [{ label: 'notes-1.txt' }, { label: 'notes-2.txt' }, { label: 'notes-3.txt' }] }]);
    expect(takeRequest(requestOf('m21-question-two')).question?.questions?.map((question) => [question.text, question.header, question.options.map((option) => option.label)])).toEqual([
      ['Which file do you want read?', 'File choice', ['notes-1.txt', 'notes-2.txt']],
      ['Which language do you want the answer in?', 'Language', ['English', 'French']],
    ]);
    // K1 saw no `agent_id` on any request (C21).
    for (const name of ['m21-question-one', 'm21-question-multi', 'm21-question-two', 'm21-question-stop', 'm21-question-killed-first']) {
      expect(frameKind(requestOf(name)), name).toBe('request');
      expect(takeRequest(requestOf(name)).question?.agentId, name).toBeNull();
    }
  });

  it('reads the worker a request names, where it names one that could be an id', () => {
    expect(takeRequest(change('m21-question-one', { agent_id: 'task-7' })).question?.agentId).toBe('task-7');
    for (const named of ['', 'x'.repeat(257), 'a\nb', 7, null, { id: 'task-7' }]) expect(takeRequest(change('m21-question-one', { agent_id: named })).question?.agentId, JSON.stringify(named)).toBeNull();
  });

  it('reads no question of any other request: a tool request for another name, which is one to act (M22), and every other subtype', () => {
    const read = change('m21-question-one', { tool_name: 'Read', input: { file_path: 'C:\\private\\second.txt' } });
    expect(takeRequest(read)).toMatchObject({ requestId: '<request-31>', subtype: 'can_use_tool', tool: true, question: null, action: { tool: 'Read', toolUseId: '<tool-use-10>' } });
    for (const name of ['askuserquestion', 'AskUserQuestion ', 'mcp__x__AskUserQuestion', '', 7, null, undefined]) expect(takeRequest(change('m21-question-one', { tool_name: name })).question, JSON.stringify(name)).toBeNull();
    // The name alone does not make a question of another subtype's request.
    for (const subtype of ['elicitation', 'request_user_dialog', 'hook_callback', 'mcp_message', 'set_permission_mode']) {
      const taken = takeRequest(change('m21-question-one', { subtype }));
      expect(taken.question, subtype).toBeNull();
      expect(taken.tool, subtype).toBe(false);
      // Nothing more is read of a request that asks for no tool: no action, and no payload.
      expect([taken.action, taken.payload], subtype).toEqual([null, null]);
    }
    expect(takeRequest(requestOf('m16-chat-request'))).toMatchObject({ requestId: '<request-11>', subtype: 'can_use_tool', tool: true, question: null });
  });

  it('gives no id for a request id or a tool use that could be none, and no questions for what is no list of them', () => {
    const named = (patch: Frame): ReturnType<typeof takeRequest> => takeRequest({ ...requestOf('m21-question-one'), ...patch });
    // The raw id is still there to refuse by; the question's own is null, so it is never held.
    expect(named({ request_id: 'a\u0000b' })).toMatchObject({ requestId: 'a\u0000b', question: { requestId: null } });
    expect(named({ request_id: 'x'.repeat(257) }).question?.requestId).toBeNull();
    expect(named({ request_id: '' })).toMatchObject({ requestId: null, question: { requestId: null } });
    for (const toolUse of ['', 'x'.repeat(257), 'a\tb', 7, null, undefined]) expect(takeRequest(change('m21-question-one', { tool_use_id: toolUse })).question?.toolUseId, JSON.stringify(toolUse)).toBeNull();
    const [question] = input('m21-question-one')['questions'] as [Frame];
    const noList: unknown[] = [
      undefined, null, 'Which file?', { question: 'Which file?' }, [null], ['Which file?'], [{ header: 'no text' }], [{ question: 7 }],
      [{ ...question, options: 'notes-1.txt' }], [{ ...question, options: ['notes-1.txt'] }], [{ ...question, options: [{ description: 'no label' }] }], [question, { question: null }],
    ];
    for (const questions of noList) expect(takeRequest(change('m21-question-one', { input: { questions } })).question?.questions, JSON.stringify(questions)).toBeNull();
    expect(takeRequest(change('m21-question-one', { input: 'not an object' })).question).toMatchObject({ input: {}, questions: null });
  });

  it('takes a question as it came, whatever its size: nothing is cut here, and what is missing reads as none', () => {
    const long = 'x'.repeat(5_000);
    const options = Array.from({ length: 30 }, (_, n) => ({ label: `${long}-${n}`, description: long }));
    const [taken] = takeRequest(change('m21-question-one', { input: { questions: [{ question: long, header: long, options, multiSelect: true }] } })).question?.questions ?? [];
    expect(taken).toEqual({ text: long, header: long, options, multiple: true, freeText: true, secret: false });
    // No header, no description, no options, no `multiSelect`: a question all the same, answered in words.
    expect(takeRequest(change('m21-question-one', { input: { questions: [{ question: 'Why?' }, { question: 'Which?', options: [{ label: 'a', description: 7 }], multiSelect: 'yes' }] } })).question?.questions).toEqual([
      { text: 'Why?', header: null, options: [], multiple: false, freeText: true, secret: false },
      { text: 'Which?', header: null, options: [{ label: 'a', description: null }], multiple: false, freeText: true, secret: false },
    ]);
    expect(takeRequest(change('m21-question-one', { input: { questions: [] } })).question?.questions).toEqual([]);
  });

  it('reads no other field of it: `display_name`, `requires_user_interaction` and anything else change nothing', () => {
    const plain = takeRequest(requestOf('m21-question-one'));
    expect(takeRequest(change('m21-question-one', { display_name: 'Something else', requires_user_interaction: false, permission_suggestions: [{ type: 'addRules' }], blocked_path: 'C:\\private' }))).toEqual(plain);
    expect(Object.keys(plain.question ?? {}).sort()).toEqual(['agentId', 'input', 'questions', 'requestId', 'tool', 'toolUseId']);
  });
});

describe('the CLI’s taking back of a request (M21: C20)', () => {
  const cancel = received('m21-question-stop').find((frame) => frame['type'] === 'control_cancel_request') as Frame;

  it('is read for the request it names, as K1’s Stop shows it: `{ type, request_id }`, the question’s own id', () => {
    expect(Object.keys(cancel).sort()).toEqual(['request_id', 'type']);
    expect(frameKind(cancel)).toBe('cancel');
    const request = received('m21-question-stop').find((frame) => frame['type'] === 'control_request') as Frame;
    expect(takeCancel(cancel)).toEqual({ requestId: request['request_id'] });
    // Nothing else of it is read.
    expect(takeCancel({ ...cancel, reason: 'private words', request: { subtype: 'interrupt' } })).toEqual({ requestId: request['request_id'] });
  });

  it('names nothing where its id could be none', () => {
    for (const id of ['', 'x'.repeat(257), 'a\nb', 7, null, undefined]) expect(takeCancel({ ...cancel, request_id: id }), JSON.stringify(id)).toBeNull();
    for (const value of [null, undefined, 'control_cancel_request', []]) expect(takeCancel(value)).toBeNull();
  });
});

describe('a side question’s reply (C13)', () => {
  it('gives the answer whole, as K1’s replies hold it, and no model where the session’s own answered', () => {
    const idle = replyOf('m20b-idle') as { response: string; synthetic: boolean };
    expect(idle.synthetic).toBe(false);
    expect(takeSideReply(idle)).toEqual({ text: idle.response, cut: false, model: null });
    expect(takeSideReply(replyOf('m20b-followup'))).toEqual({ text: 'HARBOUR', cut: false, model: null });
  });

  it('gives no answer for a null reply, an empty one, one that is no text, and a placeholder no model wrote', () => {
    const idle = replyOf('m20b-idle') as Record<string, unknown>;
    const none = { text: null, cut: false, model: null };
    expect(takeSideReply({ ...idle, response: null })).toEqual(none);
    expect(takeSideReply({ ...idle, response: '' })).toEqual(none);
    expect(takeSideReply({ ...idle, response: 7 })).toEqual(none);
    expect(takeSideReply({ ...idle, response: ['a', 'b'] })).toEqual(none);
    // Marked synthetic: a text is there, and it is never shown as the model's (C39).
    expect(takeSideReply({ ...idle, synthetic: true })).toEqual(none);
    for (const value of [null, undefined, 'a text', 4, [], [idle]]) expect(takeSideReply(value)).toEqual(none);
  });

  it('names the model that answered in place of the session’s, where the reply says one did (C7)', () => {
    const idle = replyOf('m20b-idle') as Record<string, unknown>;
    const fallback = { original_model: 'claude-sonnet-5', fallback_model: 'claude-haiku-5' };
    expect(takeSideReply({ ...idle, refusal_fallback: fallback })).toEqual({ text: idle['response'], cut: false, model: 'claude-haiku-5' });
    // A name that could be no catalog key is no name: empty, too long, with a control character, or no text.
    for (const named of ['', 'x'.repeat(129), 'a\nb', 7, null, { name: 'claude-haiku-5' }]) {
      expect(takeSideReply({ ...idle, refusal_fallback: { ...fallback, fallback_model: named } }).model, JSON.stringify(named)).toBeNull();
    }
    expect(takeSideReply({ ...idle, refusal_fallback: 'claude-haiku-5' }).model).toBeNull();
    // A placeholder names none either, whatever it says.
    expect(takeSideReply({ ...idle, synthetic: true, refusal_fallback: fallback }).model).toBeNull();
  });

  it('cuts an answer to a message’s bound, and says so', () => {
    const taken = takeSideReply({ response: 'x'.repeat(MAX_MESSAGE_TEXT + 10), synthetic: false });
    expect(taken.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(taken.cut).toBe(true);
    expect(takeSideReply({ response: 'x'.repeat(MAX_MESSAGE_TEXT), synthetic: false }).cut).toBe(false);
  });

  it('reads nothing else of it: a reply’s other fields change nothing', () => {
    const idle = replyOf('m20b-idle') as Record<string, unknown>;
    expect(takeSideReply({ ...idle, usage: { input_tokens: 9 }, cost: 1, tool_calls: [{ name: 'Bash' }], session_id: 'x' })).toEqual(takeSideReply(idle));
    expect(Object.keys(takeSideReply(idle)).sort()).toEqual(['cut', 'model', 'text']);
  });

  it('is an error reply where the question was cancelled: K1’s carries no answer at all', () => {
    const id = sideId('m20b-cancel');
    const reply = received('m20b-cancel').find((frame) => frame['type'] === 'control_response' && (frame['response'] as { request_id?: string }).request_id === id);
    expect(reply?.['response']).toEqual({ subtype: 'error', request_id: id, error: 'Side question cancelled' });
  });
});

// M22 (V2; C5, C7): a report's permission mode and tools, given as they came for the session to compare.
describe('what a report says of the permission mode (M22: C5, C7)', () => {
  const replyTo = (name: string, request: number): unknown => {
    const frames = capture(name);
    const id = frames[request]?.frame['request_id'];
    return (frames.find((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_response' && (entry.frame['response'] as { request_id?: unknown }).request_id === id)?.frame['response'] as { response?: unknown }).response;
  };
  const initOf = (name: string, nth = 0): Frame => received(name).filter((frame) => frame['type'] === 'system' && frame['subtype'] === 'init')[nth] as Frame;

  it('gives the mode the launch’s reply names, as each of K2’s launches reported its own', () => {
    for (const [name, word] of [['m22-approve-once', 'default'], ['m22-modes-launch-acceptEdits', 'acceptEdits'], ['m22-modes-launch-auto', 'auto'], ['m22-modes-launch-bypassPermissions', 'bypassPermissions'], ['m22-modes-launch-dontAsk', 'dontAsk']] as const) expect(takeReply(replyTo(name, 0)), name).toEqual({ mode: word });
    // A reply that names none, or what is no word: no mode is reported, and the session's is then not confirmed.
    for (const reply of [null, undefined, 'default', [], {}, { current_permission_mode: 7 }, { current_permission_mode: '' }, { current_permission_mode: 'x'.repeat(65) }, { current_permission_mode: 'de\nfault' }, { permissionMode: 'default' }]) expect(takeReply(reply), JSON.stringify(reply)).toEqual({ mode: null });
  });

  it('gives the mode a change’s reply names, and the mode of the status frame that follows it, as K2’s capture holds each change', () => {
    const frames = capture('m22-modes-set');
    const sets = frames.flatMap((entry, index) => (entry.dir === 'send' && (entry.frame['request'] as { subtype?: string } | undefined)?.subtype === 'set_permission_mode' ? [{ index, asked: (entry.frame['request'] as { mode: string }).mode }] : []));
    expect(sets.map((set) => set.asked)).toEqual(['acceptEdits', 'default', 'auto', 'default', 'dontAsk', 'default', 'plan', 'default', 'bypassPermissions', 'default']);
    // Each change the CLI took: its reply names the mode, and so does the status frame in the same millisecond.
    for (const set of sets.slice(0, 8)) {
      expect(takeModeReply(replyTo('m22-modes-set', set.index)), set.asked).toEqual({ mode: set.asked });
      const status = frames[set.index + 2]?.frame as Frame;
      expect(frameKind(status), set.asked).toBe('status');
      expect(takeStatus(status), set.asked).toEqual({ named: true, mode: set.asked });
    }
    // A change to the mode already in force brings the reply and no status frame (K2): the last one here.
    expect(takeModeReply(replyTo('m22-modes-set', sets.at(-1)?.index ?? -1))).toEqual({ mode: 'default' });
    for (const reply of [undefined, null, {}, { mode: 7 }, { mode: '' }, { permissionMode: 'auto' }]) expect(takeModeReply(reply), JSON.stringify(reply)).toEqual({ mode: null });
  });

  it('reads no mode of the status frames a turn sends, which say what the process is doing and name none', () => {
    const during = received('m22-approve-once').filter((frame) => frame['type'] === 'system' && frame['subtype'] === 'status');
    expect(during.length).toBeGreaterThan(2);
    for (const frame of during) {
      expect(frameKind(frame)).toBe('status');
      expect(takeStatus(frame)).toEqual({ named: false, mode: null });
    }
    // A frame that names one that could be no word names it all the same: a mode fat-g did not ask for.
    for (const named of [7, '', 'x'.repeat(65), { mode: 'auto' }]) expect(takeStatus({ type: 'system', subtype: 'status', permissionMode: named }), JSON.stringify(named)).toEqual({ named: true, mode: null });
    expect(takeStatus({ type: 'system', subtype: 'status', status: null, permissionMode: null })).toEqual({ named: false, mode: null });
  });

  it('gives an `init`’s mode and its built-in tools by name, the tools of the user’s own configuration left out', () => {
    expect(takeInit(initOf('m22-approve-once'))).toMatchObject({ sessionId: '<session-1>', mode: 'default', tools: ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'] });
    // A turn under a mode set between turns names it (K2), and the next turn the mode set back.
    expect([takeInit(initOf('m22-mode-accept-edits', 0))?.mode, takeInit(initOf('m22-mode-accept-edits', 1))?.mode]).toEqual(['acceptEdits', 'default']);
    expect([takeInit(initOf('m22-mode-auto'))?.mode, takeInit(initOf('m22-mode-bypass-main'))?.mode]).toEqual(['auto', 'bypassPermissions']);
    expect(takeInit(initOf('m21-question-one'))).toMatchObject({ mode: 'default', tools: ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read'] });
    // A list that is no list of names cannot be compared, and a mode that is no word is none.
    for (const tools of [undefined, 'Read', [7], ['Read', null], { Read: true }]) expect(takeInit({ type: 'system', subtype: 'init', tools, permissionMode: 'default' })?.tools, JSON.stringify(tools)).toBeNull();
    expect(takeInit({ type: 'system', subtype: 'init', tools: ['Read', 'mcp__a__b'], permissionMode: 7 })).toMatchObject({ mode: null, tools: ['Read'] });
  });
});

// M22 (V27, V31; C8, C68, C91): a tool request for any tool but the one that asks the user.
describe('a request to act (M22: C8, C68, C91)', () => {
  const requestsOf = (name: string): Frame[] => received(name).filter((frame) => frame['type'] === 'control_request');
  const change = (name: string, patch: Frame, nth = 0): Frame => ({ ...requestsOf(name)[nth], request: { ...(requestsOf(name)[nth]?.['request'] as Frame), ...patch } });

  it('is read for its ids, its tool, its input as it came, its own line, the path it is held for and the CLI’s offers, as K2’s capture holds a command’s', () => {
    const frame = requestsOf('m22-approve-once')[0] as Frame;
    const request = frame['request'] as { input: Frame; permission_suggestions: unknown[] };
    const taken = takeRequest(frame);
    expect(taken).toEqual({
      requestId: '<request-28>', subtype: 'can_use_tool', tool: true, question: null,
      action: {
        requestId: '<request-28>', toolUseId: '<tool-use-16>', agentId: null, tool: 'Bash', input: { command: 'touch bash-once.txt', description: 'Create empty file bash-once.txt' },
        description: 'Create empty file bash-once.txt', blockedPath: '<scratch>\\bash-once.txt', outside: false, suggestions: request.permission_suggestions, noGrant: false,
      },
      plan: null,
      payload: { tool: 'Bash', input: request.input, toolUseId: '<tool-use-16>', agentId: undefined },
    });
    // The input and the offers are the request's own, untouched: what a decision is encoded from.
    expect(taken.action?.input).toBe(request.input);
    expect(taken.action?.suggestions).toBe(request.permission_suggestions);
    expect(Object.keys(taken.action ?? {}).sort()).toEqual(['agentId', 'blockedPath', 'description', 'input', 'noGrant', 'outside', 'requestId', 'suggestions', 'tool', 'toolUseId']);
  });

  it('says a path outside the session’s folders, the worker a request names, and the mark for a request no rule is kept for', () => {
    const files = requestsOf('m22-approve-files').map((frame) => takeRequest(frame).action);
    expect(files.map((action) => [action?.tool, action?.outside, action?.blockedPath])).toEqual([['Write', false, null], ['Edit', false, null], ['Write', false, null], ['Write', true, null]]);
    // A worker's names it by its task id, which is no tool use (K2).
    expect(takeRequest(requestsOf('m22-approve-worker')[0])).toMatchObject({ action: { agentId: '<worker-34>', tool: 'Bash', toolUseId: '<tool-use-41>' }, payload: { agentId: '<worker-34>' } });
    expect(takeRequest(change('m22-approve-once', { suppress_always_allow_rule: true })).action?.noGrant).toBe(true);
    for (const mark of [false, 'true', 1, null, undefined]) expect(takeRequest(change('m22-approve-once', { suppress_always_allow_rule: mark })).action?.noGrant, String(mark)).toBe(false);
    // Any other reason type is no word that a path lies outside.
    for (const reason of ['rule', 'mode', 'other', 7, undefined]) expect(takeRequest(change('m22-approve-files', { decision_reason_type: reason }, 3)).action?.outside, String(reason)).toBe(false);
  });

  it('gives no tool, no input and no id where the request holds none that could be one, and offers that are no list as none', () => {
    expect(takeRequest(change('m22-approve-once', { tool_name: undefined })).action).toMatchObject({ tool: null });
    for (const input of ['touch x', 7, null, undefined, ['touch x']]) expect(takeRequest(change('m22-approve-once', { input })).action?.input, JSON.stringify(input)).toBeNull();
    for (const toolUse of ['', 'x'.repeat(257), 'a\tb', 7, null, undefined]) expect(takeRequest(change('m22-approve-once', { tool_use_id: toolUse })).action?.toolUseId, JSON.stringify(toolUse)).toBeNull();
    for (const agent of ['', 'x'.repeat(257), 7, null]) expect(takeRequest(change('m22-approve-once', { agent_id: agent })).action?.agentId, JSON.stringify(agent)).toBeNull();
    for (const offers of [undefined, null, 'addRules', { type: 'addRules' }]) expect(takeRequest(change('m22-approve-once', { permission_suggestions: offers })).action?.suggestions, JSON.stringify(offers)).toEqual([]);
    expect(takeRequest({ ...requestsOf('m22-approve-once')[0], request_id: 'x'.repeat(257) }).action?.requestId).toBeNull();
    expect(takeRequest(change('m22-approve-once', { description: 7, blocked_path: '' })).action).toMatchObject({ description: null, blockedPath: null });
  });

  it('compares a request delivered again by its tool, its input, its tool use and its worker, each as it came (C91)', () => {
    const payload = (frame: Frame): RequestPayload | null => takeRequest(frame).payload;
    const first = payload(requestsOf('m22-approve-once')[0] as Frame);
    // The same request, parsed again from its line: the same.
    expect(samePayload(first, payload(JSON.parse(JSON.stringify(requestsOf('m22-approve-once')[0])) as Frame))).toBe(true);
    // What the comparison does not look at changes nothing: the request's own line, its offers.
    expect(samePayload(first, payload(change('m22-approve-once', { description: 'another line', permission_suggestions: [], blocked_path: 'C:\\elsewhere' })))).toBe(true);
    const other: [string, Frame][] = [
      ['another command', { input: { command: 'rm -rf .', description: 'Create empty file bash-once.txt' } }], ['a key more', { input: { command: 'touch bash-once.txt', description: 'Create empty file bash-once.txt', timeout: 1 } }],
      ['a key less', { input: { command: 'touch bash-once.txt' } }], ['an input that is none', { input: null }], ['another tool', { tool_name: 'Write' }],
      ['another tool use', { tool_use_id: '<tool-use-17>' }], ['a worker named', { agent_id: 'task-1' }],
    ];
    for (const [what, patch] of other) expect(samePayload(first, payload(change('m22-approve-once', patch))), what).toBe(false);
    // Nested values, item by item and key by key; an order of keys is no difference, an order of items is.
    const nested = (input: unknown): RequestPayload | null => payload(change('m22-approve-once', { tool_name: 'MultiEdit', input }));
    expect(samePayload(nested({ file_path: 'a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }), nested({ edits: [{ new_string: 'b', old_string: 'a' }, { old_string: 'c', new_string: 'd' }], file_path: 'a' }))).toBe(true);
    expect(samePayload(nested({ file_path: 'a', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }), nested({ file_path: 'a', edits: [{ old_string: 'c', new_string: 'd' }, { old_string: 'a', new_string: 'b' }] }))).toBe(false);
    // A request that asks for no tool has no payload, and is the same as nothing.
    expect(samePayload(first, payload(change('m22-approve-once', { subtype: 'hook_callback' })))).toBe(false);
    expect(samePayload(null, null)).toBe(false);
    // A question's is compared the same way.
    const question = requestsOf('m21-question-one')[0] as Frame;
    expect(samePayload(payload(question), payload(JSON.parse(JSON.stringify(question)) as Frame))).toBe(true);
    expect(samePayload(payload(question), payload({ ...question, request: { ...(question['request'] as Frame), input: { questions: [] } } }))).toBe(false);
  });
});

// M22 (V21; C76): a rule of the user's own configuration refused a tool's use, with no request.
describe('a denial by a rule (M22: C76)', () => {
  const denied = (): Frame => received('m22-inherited').find((frame) => frame['subtype'] === 'permission_denied') as Frame;

  it('is read as its own kind, for the tool use it names and whether a rule is its reason, as K2’s capture holds it — and its message is not read', () => {
    expect(frameKind(denied())).toBe('permission-denied');
    expect(denied()).toMatchObject({ tool_name: 'Bash', decision_reason_type: 'rule' });
    const read: string[] = [];
    const guarded = new Proxy(denied(), { get: (target, key) => { read.push(String(key)); return target[String(key)]; } });
    expect(takeDenied(guarded)).toEqual({ toolUseId: '<tool-use-33>', rule: true });
    expect([...new Set(read)].sort()).toEqual(['decision_reason_type', 'tool_use_id']);
    // Another reason is no rule's; a frame that names no tool use names none.
    for (const reason of ['mode', 'classifier', 'hook', 7, undefined]) expect(takeDenied({ ...denied(), decision_reason_type: reason }), String(reason)).toEqual({ toolUseId: '<tool-use-33>', rule: false });
    for (const toolUse of ['', 7, null, undefined, 'x'.repeat(257)]) expect(takeDenied({ ...denied(), tool_use_id: toolUse }).toolUseId, JSON.stringify(toolUse)).toBeNull();
    expect(takeDenied(null)).toEqual({ toolUseId: null, rule: false });
  });
});

describe('a sub-agent’s model and agent definition (M106: C14, C20)', () => {
  it('takes the agent definition from `task_started` alone, one line', () => {
    const started = { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1', description: 'Reads notes', subagent_type: 'Explore\nmore' };
    expect(takeTask('task-started', started)).toMatchObject({ taskId: 'task-1', description: 'Reads notes', agentType: 'Explore' });
    expect(takeTask('task-progress', { ...started, subtype: 'task_progress' })?.agentType).toBeNull();
    for (const subagent_type of [undefined, 4, '', '   ']) expect(takeTask('task-started', { ...started, subagent_type })?.agentType, String(subagent_type)).toBeNull();
  });

  it('reads a reply’s model where a model said it and it is a catalog id', () => {
    const reply = (model: unknown) => takeAssistant({ type: 'assistant', uuid: 'u-1', parent_tool_use_id: 'agent-1', message: { id: 'm-1', model, content: [] } });
    expect(reply('claude-haiku-4-5-20251001')?.model).toBe('claude-haiku-4-5-20251001');
    for (const model of ['<synthetic>', '', 'two words', 7, undefined, 'x'.repeat(129)]) expect(reply(model)?.model, String(model)).toBeNull();
  });
});
