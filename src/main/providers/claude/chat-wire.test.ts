// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2 (docs/planning/_archive/M16.md; C7–C9), V3 (M20b.md; C13, C15), V4 (M21.md; C17, C18) and V7, V27
// (M22.md; C5, C13, C21, C22, C68, C69): what a chat session can put on the wire, frame by frame.
// The frames are K20's and K23's, M20b's K1's, M21's K1's and M22's K2's, as the captures under
// tests/fixtures/claude/captures/ hold them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTABLE_WORDS } from './chat-modes';
import { type ChatAnswer, type ChatSend, CHAT_WIRE_LIMITS, createChatWire, DENY_MESSAGE, DENY_MESSAGES, encodeAnswer, encodeSend, PLAN_CANCEL_MESSAGE, PLAN_MISSING_MESSAGE, readOffer, type SessionGrant, USER_DECLINE_MESSAGE, USER_DENY_MESSAGE, userContent } from './chat-wire';
import { scriptedChild } from './control-test-support';

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const capture = (name: string) => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: Record<string, unknown> }[] }).frames;
const sent = (name: string) => capture(name).filter((entry) => entry.dir === 'send').map((entry) => entry.frame);
/** A question capture's request as the CLI sent it, and the reply the spike gave it. */
const asked = (name: string) => {
  const request = capture(name).find((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')?.frame as { request_id: string; request: { input: Record<string, unknown> } };
  const reply = sent(name).find((frame) => frame['type'] === 'control_response') as { response: { response: { updatedInput: { answers: Record<string, string> } } } };
  return { requestId: request.request_id, input: request.request.input, reply, answers: reply.response.response.updatedInput.answers };
};

describe('what a chat session sends (decision 0020)', () => {
  it('encodes each of the seven as the exact frame the captures show, and nothing beside it', () => {
    const [initialize, prompt] = sent('m16-t1-basic');
    expect(encodeSend({ kind: 'initialize' }, 'm10-1')).toEqual(initialize);
    // One text and one id: no session, no parent, no second block.
    expect(encodeSend({ kind: 'prompt', id: '<uuid-2>', text: (prompt?.['message'] as { content: string }).content }, '')).toEqual(prompt);
    expect(encodeSend({ kind: 'interrupt' }, 'm10-2')).toEqual(sent('m16-t4-interrupt')[2]);
    // M23 (C43; K2): the interrupt that drops what the CLI holds, as K2 sent it.
    expect(encodeSend({ kind: 'interrupt', cancelQueued: true }, 'm10-2')).toEqual(sent('m23-claude-stop-held').find((frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'interrupt'));
    // The eighth (M23, C36; K2): a message written while a turn runs, the prompt's own frame under its own id.
    const [, , during] = sent('m23-claude-steer-text');
    expect(encodeSend({ kind: 'steer', id: '<uuid-33>', text: ((during?.['message'] as { content: string }).content) }, '')).toEqual(during);
    // `effortLevel` alone, as K4 sent it.
    expect(encodeSend({ kind: 'effort', level: 'medium' }, 'm10-3')).toEqual(sent('m16-effort-change').find((frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'apply_flag_settings'));
    expect(encodeSend({ kind: 'effort', level: 'high' }, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } });
    // The ninth (decision 0020): `fastMode` alone, on or off, by the same subtype.
    expect(encodeSend({ kind: 'fast', on: true }, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'apply_flag_settings', settings: { fastMode: true } } });
    expect(encodeSend({ kind: 'fast', on: false }, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'apply_flag_settings', settings: { fastMode: false } } });
    // The tenth (decision 0033): the context's summary detail, as M10's discovery sent it, and never the full one.
    expect(encodeSend({ kind: 'context' }, 'm10-3')).toEqual(sent('discovery-idle').find((frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'get_context_usage'));
    expect(encodeSend({ kind: 'context', detail: 'full' } as unknown as ChatSend, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'get_context_usage', detail: 'summary' } });
    // A side question (M20b, C13), as K1 sent one with no earlier exchange: its text, and no `history` key at all.
    const side = (name: string) => sent(name).find((frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'side_question') as { request: { question: string; history?: { question: string; response: string }[] } };
    const first = side('m20b-idle');
    expect(Object.keys(first.request).sort()).toEqual(['question', 'subtype']);
    expect(encodeSend({ kind: 'side-question', question: first.request.question, history: [] }, 'm10-2')).toEqual(first);
    // And a follow-up: the aside's earlier exchanges, each its two texts, in their order.
    const followUp = side('m20b-followup');
    expect(followUp.request.history).toHaveLength(1);
    expect(encodeSend({ kind: 'side-question', question: followUp.request.question, history: followUp.request.history ?? [] }, 'm10-2')).toEqual(followUp);
    const pairs = [{ question: 'one?', response: 'first' }, { question: 'two?', response: 'second' }];
    expect(encodeSend({ kind: 'side-question', question: 'three?', history: pairs }, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'side_question', question: 'three?', history: pairs } });
    // The cancel (C15): the id of the request it takes back, and none of its own.
    expect(encodeSend({ kind: 'cancel', requestId: 'm10-2' }, 'ignored')).toEqual(sent('m20b-cancel').find((frame) => frame['type'] === 'control_cancel_request'));
    expect(encodeSend({ kind: 'cancel', requestId: 'fatg_7' }, '')).toEqual({ type: 'control_cancel_request', request_id: 'fatg_7' });
    // The seventh (M22, C5): a change of the permission mode, as K2 sent each — the mode's word, and nothing else.
    const sets = sent('m22-modes-set').filter((frame) => (frame['request'] as { subtype?: string } | undefined)?.subtype === 'set_permission_mode') as { request_id: string; request: { mode: string } }[];
    for (const word of ['acceptEdits', 'default', 'auto']) {
      const set = sets.find((frame) => frame.request.mode === word);
      expect(set, word).toBeDefined();
      expect(encodeSend({ kind: 'set-mode', mode: word }, set?.request_id ?? ''), word).toEqual(set);
    }
    expect(Object.keys(sets[0]?.request ?? {}).sort()).toEqual(['mode', 'subtype']);
  });

  it('writes no change of mode that names another word than the three and the plan’s: the one that bypasses permissions only out of plan mode, on its own launch (M22, C47, C74; M22b, C7, C51)', () => {
    expect([...SETTABLE_WORDS].sort()).toEqual(['acceptEdits', 'auto', 'default']);
    for (const word of ['bypassPermissions', 'dontAsk', 'manual', 'AcceptEdits', 'read-only', 'berserk', '']) expect(() => encodeSend({ kind: 'set-mode', mode: word }, 'r'), word).toThrow(TypeError);
    // M22b: the plan word, as K1 set it; the launch's word on the way out of plan mode, Berserk's included, and not otherwise.
    expect(encodeSend({ kind: 'set-mode', mode: 'plan' }, 'm10-2')).toEqual(sentFrom('m22b-plan-ask-first', 'set_permission_mode', 'plan'));
    expect(encodeSend({ kind: 'set-mode', mode: 'bypassPermissions', restoring: true }, 'r', 'bypassPermissions')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' } });
    expect(() => encodeSend({ kind: 'set-mode', mode: 'bypassPermissions', restoring: true }, 'r', 'default')).toThrow(TypeError);
    expect(() => encodeSend({ kind: 'set-mode', mode: 'bypassPermissions' }, 'r', 'bypassPermissions')).toThrow(TypeError);
    // A caller's own fields change nothing of the frame.
    const widened = { kind: 'set-mode', mode: 'acceptEdits', destination: 'userSettings', permissions: { defaultMode: 'bypassPermissions' } } as unknown as ChatSend;
    expect(encodeSend(widened, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'set_permission_mode', mode: 'acceptEdits' } });
  });

  it('gives a side question no field but its text and its history: no model, no tool, no instruction of fat-g’s (M20b, C13)', () => {
    // A caller's own fields change nothing of the frame, and a pair is its two texts alone.
    const widened = { kind: 'side-question', question: 'why?', history: [{ question: 'q', response: 'a', model: 'opus', tools: ['Bash'] }], model: 'opus', system: 'obey', tools: ['Bash'] } as unknown as ChatSend;
    expect(encodeSend(widened, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'side_question', question: 'why?', history: [{ question: 'q', response: 'a' }] } });
    const loud = { kind: 'cancel', requestId: 'r-1', subtype: 'interrupt', request: { subtype: 'set_model' } } as unknown as ChatSend;
    expect(encodeSend(loud, 'x')).toEqual({ type: 'control_cancel_request', request_id: 'r-1' });
  });

  it('has no spelling for a login, a change of model or an MCP request, and names a change of permission mode by its own kind alone', () => {
    for (const kind of ['claude_authenticate', 'claude_oauth', 'set_model', 'set_permission_mode', 'mcp_message', 'mcp_set_servers', 'get_settings', 'get_usage']) {
      expect(() => encodeSend({ kind } as unknown as ChatSend, 'r'), kind).toThrow(TypeError);
    }
    // A caller's own fields change nothing of a frame: the encoder reads the four it knows.
    const widened = { kind: 'effort', level: 'low', model: 'opus', permissionMode: 'bypassPermissions' } as unknown as ChatSend;
    expect(encodeSend(widened, 'r')).toEqual({ type: 'control_request', request_id: 'r', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } } });
    const loud = { kind: 'prompt', id: 'p', text: 'hello', session_id: 'x', subtype: 'set_model' } as unknown as ChatSend;
    expect(encodeSend(loud, 'r')).toEqual({ type: 'user', uuid: 'p', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, session_id: '' });
  });
});

describe('what a chat session answers the CLI', () => {
  it('denies a tool request with fat-g’s fixed words, as K23’s capture shows, and refuses every other request', () => {
    const deny = sent('m16-chat-request').find((frame) => frame['type'] === 'control_response');
    expect(encodeAnswer({ kind: 'deny', requestId: '<request-11>' })).toEqual(deny);
    expect(DENY_MESSAGE).toBe('This action is not available in this session.');
    // M22 (C13): a closed list, fat-g's refusal first; a denial in the user's name says the second,
    // and a question the user skipped the third (M100b, C31), as K1 sent it.
    expect([...DENY_MESSAGES]).toEqual(['This action is not available in this session.', 'The user denied this action in fat-g', 'The user declined to answer in fat-g', PLAN_MISSING_MESSAGE]);
    expect(encodeAnswer({ kind: 'deny', requestId: 'q', by: 'user' })).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'q', response: { behavior: 'deny', message: USER_DENY_MESSAGE } } });
    expect(encodeAnswer({ kind: 'deny', requestId: 'q', by: 'user-skipped' })).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'q', response: { behavior: 'deny', message: USER_DECLINE_MESSAGE } } });
    // No other message can be said: a caller's own is not read.
    expect(encodeAnswer({ kind: 'deny', requestId: 'q', by: 'someone', message: 'rm -rf' } as unknown as ChatAnswer)).toEqual(encodeAnswer({ kind: 'deny', requestId: 'q' }));
    expect(encodeAnswer({ kind: 'unsupported', requestId: 'q' })).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'q', error: 'unsupported' } });
  });

  it('grants nothing: neither refusal says allow, and an unknown kind is no answer', () => {
    for (const answer of [{ kind: 'deny', requestId: 'a' }, { kind: 'unsupported', requestId: 'a' }] as const) expect(JSON.stringify(encodeAnswer(answer))).not.toMatch(/allow/);
    expect(() => encodeAnswer({ kind: 'allow', requestId: 'a' } as unknown as ChatAnswer)).toThrow(TypeError);
  });

  // M21 (V4; C17, C18): the third answer, frame for frame against what K1 sent.
  it.each(['m21-question-one', 'm21-question-multi', 'm21-question-two'])('answers a question with `allow`, the request’s input as it came and the answers by each question’s whole text: %s', (name) => {
    const { requestId, input, reply, answers } = asked(name);
    expect(encodeAnswer({ kind: 'allow-question', requestId, tool: 'AskUserQuestion', input, answers })).toEqual(reply);
    // The questions go back untouched, beside the answers: the input's own keys, and one more.
    const encoded = encodeAnswer({ kind: 'allow-question', requestId, tool: 'AskUserQuestion', input, answers }) as { response: { response: { behavior: string; updatedInput: Record<string, unknown> } } };
    expect(encoded.response.response.behavior).toBe('allow');
    expect(encoded.response.response.updatedInput['questions']).toEqual(input['questions']);
    expect(Object.keys(encoded.response.response.updatedInput)).toEqual([...Object.keys(input), 'answers']);
    expect(Object.keys(encoded.response.response).sort()).toEqual(['behavior', 'updatedInput']);
  });

  it('holds K1’s three encodings: one option, several joined by a comma and a space, and free text beside an option of another question', () => {
    expect(asked('m21-question-one').answers).toEqual({ 'Which file should I read?': 'notes-2.txt' });
    expect(asked('m21-question-multi').answers).toEqual({ 'Which notes file(s) should I read?': 'notes-1.txt, notes-3.txt' });
    expect(asked('m21-question-two').answers).toEqual({ 'Which file do you want read?': 'notes-3.txt', 'Which language do you want the answer in?': 'French' });
  });

  it('allows the tool that asks the user and no other name: another is refused by the type, and by the encoder', () => {
    const { requestId, input, answers } = asked('m21-question-one');
    for (const tool of ['Read', 'Bash', 'Write', 'askuserquestion', 'AskUserQuestion ', '']) {
      // @ts-expect-error -- the answer is typed to the one tool's name (C17, C29)
      const other: ChatAnswer = { kind: 'allow-question', requestId, tool, input, answers };
      expect(() => encodeAnswer(other), tool).toThrow(TypeError);
    }
    // And it carries nothing a caller adds: the request's id, its input and the answers.
    const widened = { kind: 'allow-question', requestId: 'r', tool: 'AskUserQuestion', input: { questions: [] }, answers: {}, updatedPermissions: [{ type: 'addRules' }], message: 'm', interrupt: true } as unknown as ChatAnswer;
    expect(encodeAnswer(widened)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { behavior: 'allow', updatedInput: { questions: [], answers: {} } } } });
  });

  it('puts the answers last, so that a request’s own `answers` key never stands for the user’s', () => {
    const encoded = encodeAnswer({ kind: 'allow-question', requestId: 'r', tool: 'AskUserQuestion', input: { questions: [], answers: { planted: 'yes' } }, answers: { 'Which?': 'this' } }) as { response: { response: { updatedInput: { answers: unknown } } } };
    expect(encoded.response.response.updatedInput.answers).toEqual({ 'Which?': 'this' });
  });
});

describe('the chat wire', () => {
  it('writes one line per send, names each control request by an id of its own, and a prompt by its message’s id alone', async () => {
    const s = scriptedChild();
    const wire = createChatWire(s.child);
    const first = wire.send({ kind: 'initialize' });
    const prompt = wire.send({ kind: 'prompt', id: 'message-1', text: 'Say hello.' });
    const stop = wire.send({ kind: 'interrupt' });
    await Promise.all([first.written, prompt.written, stop.written]);
    expect(prompt.requestId).toBeNull();
    expect(typeof first.requestId).toBe('string');
    expect(first.requestId).not.toBe(stop.requestId);
    expect(s.frames).toEqual([
      { type: 'control_request', request_id: first.requestId, request: { subtype: 'initialize' } },
      { type: 'user', uuid: 'message-1', message: { role: 'user', content: 'Say hello.' }, parent_tool_use_id: null, session_id: '' },
      { type: 'control_request', request_id: stop.requestId, request: { subtype: 'interrupt' } },
    ]);
  });

  it('names a side question by an id of its own, and a cancel by the id of the request it takes back alone (M20b, C13, C15)', async () => {
    const s = scriptedChild();
    const wire = createChatWire(s.child);
    const one = wire.send({ kind: 'side-question', question: 'one?', history: [] });
    const two = wire.send({ kind: 'side-question', question: 'two?', history: [] });
    expect(typeof one.requestId).toBe('string');
    expect(one.requestId).not.toBe(two.requestId);
    const cancel = wire.send({ kind: 'cancel', requestId: one.requestId ?? '' });
    await Promise.all([one.written, two.written, cancel.written]);
    // No reply names a cancel: it is answered through the request it takes back.
    expect(cancel.requestId).toBeNull();
    expect(s.frames).toEqual([
      { type: 'control_request', request_id: one.requestId, request: { subtype: 'side_question', question: 'one?' } },
      { type: 'control_request', request_id: two.requestId, request: { subtype: 'side_question', question: 'two?' } },
      { type: 'control_cancel_request', request_id: one.requestId },
    ]);
  });

  it('answers a request by its id and says the line went, and leaves one whose id is over the limit unanswered', async () => {
    const s = scriptedChild();
    const wire = createChatWire(s.child);
    await expect(wire.answer({ kind: 'deny', requestId: 'cli-1' })).resolves.toBe(true);
    await expect(wire.answer({ kind: 'unsupported', requestId: 'x'.repeat(CHAT_WIRE_LIMITS.requestIdChars + 1) })).resolves.toBe(false);
    await settled();
    expect(s.frames).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'cli-1', response: { behavior: 'deny', message: DENY_MESSAGE } } }]);
  });

  it('says when a write failed, and an answer that could not be written says so and throws nothing (M21, C14, C66)', async () => {
    const s = scriptedChild();
    const wire = createChatWire(s.child);
    // The process refused the line while it lives — its queue is full — or its pipe is gone.
    for (const code of ['output-limit', 'transport-closed'] as const) {
      s.failWrites(code);
      await expect(wire.send({ kind: 'prompt', id: 'm', text: 't' }).written).rejects.toMatchObject({ code });
      await expect(wire.answer({ kind: 'deny', requestId: 'cli-2' }), code).resolves.toBe(false);
      await expect(wire.answer({ kind: 'allow-question', requestId: 'cli-3', tool: 'AskUserQuestion', input: {}, answers: {} }), code).resolves.toBe(false);
    }
    await settled();
    expect(s.frames).toEqual([]);
  });
});

// M22 (V7, V27; C13, C21, C22, C68, C69): the fourth answer, frame for frame against what K2 sent.
describe('leave for an action (M22)', () => {
  type Requested = { request_id: string; request: { tool_name: string; input: Record<string, unknown>; permission_suggestions?: unknown[] } };
  /** A capture's requests to act, each with the reply the spike gave it. */
  const actions = (name: string): { asked: Requested; reply: Record<string, unknown> }[] => {
    const requests = capture(name).filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request').map((entry) => entry.frame as unknown as Requested);
    const replies = sent(name).filter((frame) => frame['type'] === 'control_response');
    return requests.map((asked) => ({ asked, reply: replies.find((reply) => (reply['response'] as { request_id?: string }).request_id === asked.request_id) as Record<string, unknown> }));
  };
  const grantOf = (asked: Requested): SessionGrant => {
    const offer = (asked.request.permission_suggestions ?? []).map((suggestion) => readOffer(suggestion, asked.request.tool_name)).find((read) => read.kind === 'grant');
    if (offer?.kind !== 'grant') throw new Error('the request offers no rule that allows');
    return offer.grant;
  };

  it('allows once with the request’s input as it came, as K2 sent it for a command, a file’s content, an edit and a worker’s command', () => {
    const allowed = [actions('m22-approve-once')[0], ...actions('m22-approve-files'), ...actions('m22-approve-worker')];
    expect(allowed.map((action) => action?.asked.request.tool_name)).toEqual(['Bash', 'Write', 'Edit', 'Write', 'Write', 'Bash']);
    for (const action of allowed) {
      if (action === undefined) throw new Error('a capture holds no such request');
      const { asked, reply } = action;
      const encoded = encodeAnswer({ kind: 'allow-action', requestId: asked.request_id, tool: asked.request.tool_name, input: asked.request.input, grant: null });
      expect(encoded, asked.request.tool_name).toEqual(reply);
      // The input goes back as it came, the very object, and nothing stands beside it: no rule, no mode, no folder.
      const response = (encoded as { response: { response: Record<string, unknown> } }).response.response;
      expect(response['updatedInput']).toBe(asked.request.input);
      expect(Object.keys(response).sort()).toEqual(['behavior', 'updatedInput']);
    }
  });

  it('denies as K2 denied, in fat-g’s words for its own refusal', () => {
    const [, denied] = actions('m22-approve-once');
    expect(encodeAnswer({ kind: 'deny', requestId: denied?.asked.request_id ?? '' })).toEqual(denied?.reply);
  });

  it('sends a session grant as the CLI’s own rule at the session’s scope, alone, as K2 sent it — though the CLI offered it at a scope that keeps it', () => {
    const [{ asked, reply }] = actions('m22-approve-session') as [{ asked: Requested; reply: Record<string, unknown> }];
    // The offer as it came names a settings file's scope (K2): sent back unchanged, the CLI wrote into the project.
    expect(asked.request.permission_suggestions?.[0]).toEqual({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch bash-session.txt' }], behavior: 'allow', destination: 'localSettings' });
    const grant = grantOf(asked);
    expect(grant).toEqual({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch bash-session.txt' }], behavior: 'allow', destination: 'session' });
    const encoded = encodeAnswer({ kind: 'allow-action', requestId: asked.request_id, tool: 'Bash', input: asked.request.input, grant });
    expect(encoded).toEqual(reply);
    const response = (encoded as { response: { response: { updatedPermissions: Record<string, unknown>[] } } }).response.response;
    // Exactly that one (C69): not the folder and not the mode the same request offered beside it.
    expect(asked.request.permission_suggestions).toHaveLength(3);
    expect(response.updatedPermissions).toHaveLength(1);
    expect(Object.keys(response.updatedPermissions[0] ?? {}).sort()).toEqual(['behavior', 'destination', 'rules', 'type']);
    // The rules are the CLI's, as it wrote them: the same array.
    expect(response.updatedPermissions[0]?.['rules']).toBe((asked.request.permission_suggestions?.[0] as { rules: unknown }).rules);
  });

  it('names the session’s scope whatever scope the offer named, and copies nothing else the offer held (C22, C69)', () => {
    for (const destination of ['localSettings', 'userSettings', 'projectSettings', 'policySettings', 'cliArg', 'session', undefined, 7]) {
      const offer = readOffer({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination, directories: ['C:\\'], mode: 'bypassPermissions' }, 'Bash');
      if (offer.kind !== 'grant') throw new Error(`no grant at ${String(destination)}`);
      expect(offer.grant, String(destination)).toEqual({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' });
      const text = JSON.stringify(encodeAnswer({ kind: 'allow-action', requestId: 'r', tool: 'Bash', input: { command: 'npm test' }, grant: offer.grant }));
      expect(text, String(destination)).toContain('"destination":"session"');
      expect(text, String(destination)).not.toMatch(/Settings|cliArg|directories|bypassPermissions/);
    }
  });

  it('writes no update that is not that grant: another scope, another type, a rule that denies, rules that are none — each is refused before anything is written', () => {
    const grant: SessionGrant = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' };
    const answer = (wrong: unknown): ChatAnswer => ({ kind: 'allow-action', requestId: 'r', tool: 'Bash', input: { command: 'npm test' }, grant: wrong as SessionGrant });
    for (const wrong of [{ ...grant, destination: 'localSettings' }, { ...grant, destination: 'userSettings' }, { ...grant, destination: 'projectSettings' }, { ...grant, type: 'setMode', mode: 'acceptEdits' }, { ...grant, type: 'addDirectories' }, { ...grant, type: 'replaceRules' }, { ...grant, behavior: 'deny' }, { ...grant, behavior: 'ask' }, { ...grant, rules: 'Bash' }, {}]) {
      expect(() => encodeAnswer(answer(wrong)), JSON.stringify(wrong)).toThrow(TypeError);
    }
    // A second update has no place to stand: the answer carries one grant or none, and a caller's own list is not read.
    const widened = { ...answer(null), grant: null, updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }], message: 'm' } as unknown as ChatAnswer;
    expect(encodeAnswer(widened)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { behavior: 'allow', updatedInput: { command: 'npm test' } } } });
  });

  it('never gives a question leave as an action: the tool that asks the user is answered, with its answers', () => {
    expect(() => encodeAnswer({ kind: 'allow-action', requestId: 'r', tool: 'AskUserQuestion', input: { questions: [] }, grant: null })).toThrow(TypeError);
  });
});

describe('the CLI’s own offers, each read for its kind (M22: C8, C56, C68)', () => {
  const suggestionsOf = (name: string, nth = 0): unknown[] => (capture(name).filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')[nth]?.frame['request'] as { permission_suggestions: unknown[] }).permission_suggestions;

  it('reads K2’s three offers of a command’s request: the rule a grant is made of, a folder, and a mode', () => {
    expect(suggestionsOf('m22-approve-once').map((suggestion) => readOffer(suggestion, 'Bash'))).toEqual([
      // `saved`: as the CLI offered it, the rule would be kept beyond the session.
      { kind: 'grant', grant: { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch bash-once.txt' }], behavior: 'allow', destination: 'session' }, covers: 'touch bash-once.txt', saved: true },
      { kind: 'folder' },
      { kind: 'mode', word: 'acceptEdits' },
    ]);
  });

  it('reads a file change’s offers as K2 saw them: a mode alone, or a mode and a folder — and no rule', () => {
    expect(suggestionsOf('m22-approve-files', 0).map((suggestion) => readOffer(suggestion, 'Write'))).toEqual([{ kind: 'mode', word: 'acceptEdits' }]);
    expect(suggestionsOf('m22-approve-files', 3).map((suggestion) => readOffer(suggestion, 'Write'))).toEqual([{ kind: 'mode', word: 'acceptEdits' }, { kind: 'folder' }]);
  });

  it('makes a grant of a rule that allows, and of nothing else (C68)', () => {
    const rules = [{ toolName: 'Bash', ruleContent: 'npm test' }];
    const kinds = (suggestion: unknown): string => readOffer(suggestion, 'Bash').kind;
    expect(kinds({ type: 'addRules', rules, behavior: 'allow', destination: 'session' })).toBe('grant');
    // A rule that denies or asks, one that replaces or removes, rules that cannot be read whole: rules, and never a grant.
    for (const other of [{ type: 'addRules', rules, behavior: 'deny' }, { type: 'addRules', rules, behavior: 'ask' }, { type: 'replaceRules', rules, behavior: 'allow' }, { type: 'removeRules', rules, behavior: 'allow' }, { type: 'addRules', rules: [], behavior: 'allow' }, { type: 'addRules', rules: [{ ruleContent: 'npm test' }], behavior: 'allow' }, { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 7 }], behavior: 'allow' }]) {
      expect(kinds(other), JSON.stringify(other)).toBe('rule');
    }
    expect(kinds({ type: 'addRules', rules: 'Bash', behavior: 'allow' })).toBe('rule');
    // A mode, a folder, and what this build does not know.
    expect(readOffer({ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, 'Bash')).toEqual({ kind: 'mode', word: 'bypassPermissions' });
    expect(readOffer({ type: 'setMode' }, 'Bash')).toEqual({ kind: 'mode', word: null });
    expect(kinds({ type: 'addDirectories', directories: ['C:\\private'], destination: 'session' })).toBe('folder');
    for (const unknown of [{ type: 'removeDirectories' }, { type: 'somethingNew', destination: 'userSettings' }, {}, null, 'addRules', 7, []]) expect(readOffer(unknown, 'Bash'), JSON.stringify(unknown)).toEqual({ kind: 'other' });
  });

  it('says whether an offer would be kept beyond the session, by the scope the CLI wrote on it', () => {
    const rule = (destination: unknown) => readOffer({ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination }, 'Bash');
    for (const destination of ['localSettings', 'userSettings', 'projectSettings', 'anything']) expect(rule(destination), destination).toEqual({ kind: 'rule', saved: true });
    for (const destination of ['session', undefined, null, 7]) expect(rule(destination), String(destination)).toEqual({ kind: 'rule', saved: false });
  });

  it('words what a grant covers as the CLI writes a rule: what it allows of the request’s tool, the tool’s name for all of it, another tool named before its own', () => {
    const covers = (rules: unknown[], tool = 'Bash'): string | undefined => { const offer = readOffer({ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }, tool); return offer.kind === 'grant' ? offer.covers : undefined; };
    expect(covers([{ toolName: 'Bash', ruleContent: 'touch notes.txt' }])).toBe('touch notes.txt');
    expect(covers([{ toolName: 'Bash' }])).toBe('Bash');
    expect(covers([{ toolName: 'Bash', ruleContent: '' }])).toBe('Bash');
    expect(covers([{ toolName: 'Edit', ruleContent: '/src/**' }])).toBe('Edit(/src/**)');
    expect(covers([{ toolName: 'Bash', ruleContent: 'npm test' }, { toolName: 'Read' }])).toBe('npm test, Read');
    expect(covers([{ toolName: 'mcp__notes__write' }], 'mcp__notes__write')).toBe('mcp__notes__write');
  });
});

/** A frame the spike sent in a capture: the first control response, or the request of a subtype naming a mode. */
function sentFrom(name: string, subtype: string, mode: string): unknown {
  const frames = capture(name);
  return frames.find((entry) => entry.dir === 'send' && (entry.frame['request'] as Record<string, unknown> | undefined)?.['subtype'] === subtype && (entry.frame['request'] as Record<string, unknown> | undefined)?.['mode'] === mode)?.frame;
}

describe('a plan’s three answers (M22b, V3; C9, C11)', () => {
  const responses = (name: string) => capture(name).filter((entry) => entry.dir === 'send' && entry.frame['type'] === 'control_response').map((entry) => entry.frame);

  it('writes feedback as the user’s own words and Cancel with fat-g’s and the interrupt, as K1 sent them', () => {
    const [feedback, cancel] = responses('m22b-plan-read-only');
    const id = (frame: unknown): string => ((frame as { response: { request_id: string } }).response.request_id);
    expect(encodeAnswer({ kind: 'plan-feedback', requestId: id(feedback), text: 'Add a final step that reads the file back to confirm the line is there.' })).toEqual(feedback);
    expect(PLAN_CANCEL_MESSAGE).toBe('The user cancelled this plan in fat-g.');
    expect(encodeAnswer({ kind: 'plan-cancel', requestId: id(cancel) })).toEqual(cancel);
  });

  it('writes Execute as the request’s input as it came, with no update, as K1 sent it', () => {
    const [execute] = responses('m22b-plan-ask-first');
    const response = (execute as { response: { request_id: string; response: { updatedInput: Record<string, unknown> } } }).response;
    expect(encodeAnswer({ kind: 'allow-action', requestId: response.request_id, tool: 'ExitPlanMode', input: response.response.updatedInput, grant: null })).toEqual(execute);
  });

  it('denies a request that carried no plan in fat-g’s words, which name no tool and no path', () => {
    expect(encodeAnswer({ kind: 'deny', requestId: 'p', by: 'no-plan' })).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'p', response: { behavior: 'deny', message: PLAN_MISSING_MESSAGE } } });
  });
});

// M23, V5 (C21; K2): the content of a user frame with images, as the capture has it.
describe('a user frame’s content (M23: V5; C21)', () => {
  it('is the text alone without images, and the text block and base64 image blocks with them', () => {
    expect(userContent('hello')).toBe('hello');
    const bytes = new Uint8Array([1, 2, 3, 250]);
    expect(userContent('hello', [{ mediaType: 'image/webp', bytes }])).toEqual([{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AQID+g==' } }]);
    expect(userContent('', [{ mediaType: 'image/jpeg', bytes }])).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID+g==' } }]);
    // A view of a larger buffer is encoded as the view.
    const view = new Uint8Array(new Uint8Array([9, 9, 1, 2, 3, 250, 9]).buffer, 2, 4);
    expect((userContent('', [{ mediaType: 'image/png', bytes: view }]) as { source: { data: string } }[])[0]?.source.data).toBe('AQID+g==');
  });

  it('matches the frame K2 sent, its image bytes replaced by the capture’s marker', () => {
    const capture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../../tests/fixtures/claude/captures/m23-claude-image.json'), 'utf8')) as { frames: { dir: string; frame: Record<string, unknown> }[] };
    const sent = capture.frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'user')?.frame as { uuid: string; message: { content: { type: string; text?: string }[] } };
    const text = sent.message.content.find((block) => block.type === 'text')?.text ?? '';
    const encoded = encodeSend({ kind: 'prompt', id: sent.uuid, text, images: [{ mediaType: 'image/png', bytes: new Uint8Array([1]) }] }, '') as { message: { content: { type: string; source?: { data: string } }[] } };
    const marked = { ...encoded, message: { ...encoded.message, content: encoded.message.content.map((block) => (block.type === 'image' ? { ...block, source: { ...block.source, data: (sent.message.content[1] as unknown as { source: { data: string } }).source.data } } : block)) } };
    expect(marked).toEqual(sent);
  });
});
