// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V39 (docs/planning/_archive/M15.md; C13, C14, C36, C106): what each Codex connection may send.
// V19 (docs/planning/_archive/M22.md; C73): and the third, an account's sandbox connection, with its four.
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_REQUESTS, COMMAND_APPROVAL, DELTA_METHODS, existingHandshake, FILE_APPROVAL, mayBeSent, MESSAGE_DELTA_METHOD, MISSING_THREAD_CODE, OPTED_OUT_DELTAS, PLAN_DELTA_METHOD, QUESTION_REQUEST, refusedMethod, sandboxHandshake, secretaryHandshake, sendNotification, sendRequest, SERVER_REQUESTS, sessionHandshake, SETUP_COMPLETED_METHOD } from './methods';

const rpc = () => ({ request: vi.fn(() => Promise.resolve('sent')), notify: vi.fn(() => Promise.resolve()) });

describe('the two method sets (C14)', () => {
  it('lets the existing connection send its reads and the history read, and nothing of a session', async () => {
    const connection = rpc();
    for (const method of ['initialize', 'account/read', 'account/rateLimits/read', 'model/list', 'thread/turns/list']) {
      await expect(sendRequest('existing', connection, method, {})).resolves.toBe('sent');
    }
    await sendNotification('existing', connection, 'initialized', {});
    for (const method of ['turn/start', 'thread/start', 'thread/resume', 'turn/interrupt']) {
      await expect(sendRequest('existing', connection, method, {})).rejects.toMatchObject({ code: 'protocol-error' });
    }
    expect(connection.request).toHaveBeenCalledTimes(5);
  });

  // M20b (C19, C27): and fork its thread, for an aside's side thread. The existing connection cannot.
  it('lets a session’s connection start, resume, fork, send and interrupt, and none of the account reads', async () => {
    const connection = rpc();
    for (const method of ['initialize', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt']) {
      await expect(sendRequest('session', connection, method, {})).resolves.toBe('sent');
    }
    for (const method of ['account/read', 'account/rateLimits/read', 'model/list', 'thread/turns/list']) {
      await expect(sendRequest('session', connection, method, {})).rejects.toMatchObject({ code: 'protocol-error' });
    }
    expect(connection.request).toHaveBeenCalledTimes(6);
    expect(mayBeSent('existing', 'thread/fork')).toBe(false);
    await expect(sendRequest('existing', connection, 'thread/fork', {})).rejects.toMatchObject({ code: 'protocol-error' });
    expect(connection.request).toHaveBeenCalledTimes(6);
  });

  it.each(['existing', 'session', 'sandbox'] as const)('refuses a login, a config write, a thread deletion and every other thread method on the %s connection, before anything is written', async (kind) => {
    const connection = rpc();
    const forbidden = [
      'account/login/start', 'account/logout', 'config/value/write', 'config/batchWrite', 'config/read', 'thread/delete', 'thread/list', 'thread/read', 'thread/archive',
      'thread/name/set', 'thread/rollback', 'thread/items/list', 'thread/shellCommand', 'command/exec', '', 'INITIALIZE',
      // M23 (C36): a steer goes on a session's own connection alone.
      ...(kind === 'session' ? [] : ['turn/steer']),
    ];
    for (const method of forbidden) {
      expect(mayBeSent(kind, method), method).toBe(false);
      await expect(sendRequest(kind, connection, method, {}), method).rejects.toMatchObject({ code: 'protocol-error' });
      await expect(sendNotification(kind, connection, method, {}), method).rejects.toMatchObject({ code: 'protocol-error' });
    }
    expect(connection.request).not.toHaveBeenCalled();
    expect(connection.notify).not.toHaveBeenCalled();
  });
});

// M22 (V19; C60, C73): readiness and the setup go on a connection of their own, and on no other.
describe('the third set: an account’s sandbox connection (M22; C73)', () => {
  it('holds the handshake, readiness and the setup, and nothing else', async () => {
    const connection = rpc();
    for (const method of ['initialize', 'windowsSandbox/readiness', 'windowsSandbox/setupStart']) {
      await expect(sendRequest('sandbox', connection, method, {})).resolves.toBe('sent');
    }
    await sendNotification('sandbox', connection, 'initialized', {});
    expect(connection.request).toHaveBeenCalledTimes(3);
    expect(connection.notify).toHaveBeenCalledTimes(1);
    // It starts no thread, sends no prompt, and reads nothing of the account.
    for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt', 'account/read', 'account/rateLimits/read', 'model/list', 'thread/turns/list', 'windowsSandbox/setupCompleted', 'permissionProfile/list', 'configRequirements/read']) {
      expect(mayBeSent('sandbox', method), method).toBe(false);
      await expect(sendRequest('sandbox', connection, method, {}), method).rejects.toMatchObject({ code: 'protocol-error' });
    }
    expect(connection.request).toHaveBeenCalledTimes(3);
  });

  it.each(['existing', 'session'] as const)('lets neither readiness nor the setup be sent on the %s connection, before anything is written', async (kind) => {
    const connection = rpc();
    for (const method of ['windowsSandbox/readiness', 'windowsSandbox/setupStart', SETUP_COMPLETED_METHOD]) {
      expect(mayBeSent(kind, method), method).toBe(false);
      await expect(sendRequest(kind, connection, method, {}), method).rejects.toMatchObject({ code: 'protocol-error' });
      await expect(sendNotification(kind, connection, method, {}), method).rejects.toMatchObject({ code: 'protocol-error' });
    }
    expect(connection.request).not.toHaveBeenCalled();
    expect(connection.notify).not.toHaveBeenCalled();
  });

  it('makes a handshake of `clientInfo` alone, with nothing experimental; Codex’s word that a setup is over is a notification, and no method of any set', () => {
    expect(sandboxHandshake('9.9.9')).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '9.9.9' } });
    expect(JSON.stringify(sandboxHandshake('1'))).not.toMatch(/experimental/i);
    expect(SETUP_COMPLETED_METHOD).toBe('windowsSandbox/setupCompleted');
    for (const kind of ['existing', 'session', 'sandbox'] as const) expect(mayBeSent(kind, SETUP_COMPLETED_METHOD)).toBe(false);
  });
});

describe('the handshakes (C13; M19, C7)', () => {
  it('a session opts out of nine of the eleven delta notifications, and keeps an agent message’s and a plan’s; the existing connection sends clientInfo alone', () => {
    expect(DELTA_METHODS).toHaveLength(11);
    expect(new Set(DELTA_METHODS).size).toBe(11);
    expect(DELTA_METHODS.every((method) => /delta$/i.test(method))).toBe(true);
    // Exactly the nine others (M19, C7; M22b, C14): the two a session takes are the texts of an agent's message and of a plan.
    expect(MESSAGE_DELTA_METHOD).toBe('item/agentMessage/delta');
    expect(PLAN_DELTA_METHOD).toBe('item/plan/delta');
    expect([...OPTED_OUT_DELTAS]).toEqual([
      'command/exec/outputDelta',
      'item/commandExecution/outputDelta',
      'item/fileChange/outputDelta',
      'item/reasoning/summaryTextDelta',
      'item/reasoning/textDelta',
      'process/outputDelta',
      'thread/realtime/item/transcript/delta',
      'thread/realtime/outputAudio/delta',
      'thread/realtime/transcript/delta',
    ]);
    expect([...OPTED_OUT_DELTAS, MESSAGE_DELTA_METHOD, PLAN_DELTA_METHOD].sort()).toEqual([...DELTA_METHODS].sort());
    // The experimental API a plan turn needs (M22b, C13), and the plain handshake for a CLI that refused it (C80).
    expect(sessionHandshake('1.2.3')).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '1.2.3' }, capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    expect(sessionHandshake('1.2.3', true)).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '1.2.3' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    expect(existingHandshake('1.2.3')).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '1.2.3' } });
  });

  it('adds no method to either set for it: a delta is a notification the CLI sends, never one fat-g calls (M19, C8)', () => {
    for (const kind of ['existing', 'session'] as const) for (const method of DELTA_METHODS) expect(mayBeSent(kind, method), method).toBe(false);
  });

  it('asks for the experimental API in a session’s handshake alone: never the existing connection’s, the sandbox’s or the secretary’s (M22b, C13)', () => {
    expect(JSON.stringify([existingHandshake('1'), sandboxHandshake('1'), secretaryHandshake('1'), sessionHandshake('1', true)])).not.toMatch(/experimental/i);
    expect(JSON.stringify(sessionHandshake('1'))).toMatch(/"experimentalApi":true/);
  });
});

describe('requests from the CLI (C34, C106)', () => {
  // M22 (C8, C13): the two that M15 declined are the two a session holds for the user's decision, under every mode but Read only.
  it('knows the two requests for leave, a command’s and a file change’s, both among the ten the schema lists', () => {
    expect(SERVER_REQUESTS).toHaveLength(10);
    expect(APPROVAL_REQUESTS).toEqual(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
    expect([COMMAND_APPROVAL, FILE_APPROVAL]).toEqual([...APPROVAL_REQUESTS]);
    for (const method of APPROVAL_REQUESTS) expect(SERVER_REQUESTS).toContain(method);
    // Answering one calls no method: no set holds either, or a legacy approval's.
    for (const kind of ['existing', 'session', 'sandbox'] as const) for (const method of [...APPROVAL_REQUESTS, 'applyPatchApproval', 'execCommandApproval', 'item/permissions/requestApproval']) expect(mayBeSent(kind, method), method).toBe(false);
  });

  // M21 (C23, C29): a question is the one request answered when its answer comes. Answering it calls no method.
  it('answers one request more, a question, among the ten the schema lists and neither of the two for leave; no method is sent for it', () => {
    expect(QUESTION_REQUEST).toBe('item/tool/requestUserInput');
    expect(SERVER_REQUESTS).toContain(QUESTION_REQUEST);
    expect(APPROVAL_REQUESTS).not.toContain(QUESTION_REQUEST);
    for (const kind of ['existing', 'session'] as const) for (const method of [QUESTION_REQUEST, 'serverRequest/resolved']) expect(mayBeSent(kind, method), method).toBe(false);
  });

  it('counts a refused request under its method only when the schema lists it, and as `other` otherwise (V39)', () => {
    for (const method of SERVER_REQUESTS) expect(refusedMethod(method)).toBe(method);
    for (const method of ['C:\\Users\\someone\\secret', 'user@example.test', 'item/tool/requestUserInput ', 'currentTime/read', '']) expect(refusedMethod(method)).toBe('other');
  });

  it('knows a missing thread by the code the spike traced', () => {
    expect(MISSING_THREAD_CODE).toBe(-32600);
  });
});
