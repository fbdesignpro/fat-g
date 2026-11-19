// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { ProcessFailure } from '@shared/provider-kit/process';
import { CONTROL_LIMITS, createControlClient } from './control-client';
import { scriptedChild } from './control-test-support';

const SENTINEL = 'FATG-PRIVATE-SENTINEL-7Q2';
const signal = () => new AbortController().signal;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Claude control client', () => {
  it('writes one control_request per call and settles each on its own control_response', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const first = client.request('initialize', { systemPrompt: [''] }, signal());
    const second = client.request('get_usage', { skip_behaviors: true }, signal());
    await settled();
    expect(s.frames.map(({ type, request }) => ({ type, request }))).toEqual([
      { type: 'control_request', request: { subtype: 'initialize', systemPrompt: [''] } },
      { type: 'control_request', request: { subtype: 'get_usage', skip_behaviors: true } },
    ]);
    expect(s.frames.map((frame) => typeof frame.request_id)).toEqual(['string', 'string']);
    expect(s.frames[0]!.request_id).not.toBe(s.frames[1]!.request_id);
    // Out of order, with noise in between.
    s.line({ type: 'system', subtype: 'status', note: SENTINEL });
    s.reply(s.frames[1]!, { usage: 1 });
    s.line({ type: 'keep_alive' });
    s.reply(s.frames[0]!, { account: {} });
    expect(await second).toEqual({ kind: 'success', value: { usage: 1 } });
    expect(await first).toEqual({ kind: 'success', value: { account: {} } });
    expect(client.counts()).toEqual({ cliRequests: 0, turnMessages: 0, ignored: 2 });
  });

  it('never lets a payload change which request is sent', async () => {
    const s = scriptedChild();
    void createControlClient(s.child).request('initialize', { subtype: 'claude_authenticate' }, signal());
    await settled();
    expect(s.frames[0]!.request).toEqual({ subtype: 'initialize' });
  });

  it('ignores replies to unknown or already settled IDs', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const pending = client.request('initialize', {}, signal());
    await settled();
    s.reply({ request_id: 'someone-else' }, { account: { email: SENTINEL } });
    s.line({ type: 'control_response', response: 'not-an-object' });
    s.reply(s.frames[0]!, 'first');
    s.reply(s.frames[0]!, 'second');
    expect(await pending).toEqual({ kind: 'success', value: 'first' });
    expect(client.counts().ignored).toBe(3);
  });

  it('bounds error text, and treats a non-string error as empty', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const long = client.request('get_usage', {}, signal());
    const odd = client.request('get_usage', {}, signal());
    await settled();
    s.reject(s.frames[0]!, 'x'.repeat(10_000));
    s.reject(s.frames[1]!, { message: SENTINEL });
    expect(await long).toEqual({ kind: 'error', error: 'x'.repeat(CONTROL_LIMITS.errorChars) });
    expect(await odd).toEqual({ kind: 'error', error: '' });
  });

  it('refuses every request the CLI makes, and counts it', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    s.line({ type: 'control_request', request_id: 'cli-1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    s.line({ type: 'control_request', request_id: 'x'.repeat(CONTROL_LIMITS.requestIdChars + 1), request: { subtype: 'hook_callback' } });
    s.line({ type: 'control_request', request: { subtype: 'mcp_message' } });
    await settled();
    expect(s.frames).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'cli-1', error: 'unsupported' } }]);
    expect(client.counts().cliRequests).toBe(3);
    client.close();
    s.line({ type: 'control_request', request_id: 'cli-2', request: { subtype: 'can_use_tool' } });
    await settled();
    expect(s.frames).toHaveLength(1);
  });

  it('counts turn messages without mistaking them for replies', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const pending = client.request('initialize', {}, signal());
    await settled();
    for (const type of ['assistant', 'result', 'user']) s.line({ type, request_id: s.frames[0]!.request_id, response: {} });
    s.reply(s.frames[0]!, 'ok');
    expect(await pending).toEqual({ kind: 'success', value: 'ok' });
    expect(client.counts()).toEqual({ cliRequests: 0, turnMessages: 3, ignored: 0 });
  });

  it('drops non-JSON lines, keeping neither them nor the session from working', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const pending = client.request('initialize', {}, signal());
    await settled();
    s.bytes(`${SENTINEL} malformed output C:\\Users\\private\n`);
    s.reply(s.frames[0]!, 'ok');
    expect(await pending).toEqual({ kind: 'success', value: 'ok' });
    expect(client.counts().ignored).toBe(1);
  });

  it.each([
    ['an oversized line', (s: ReturnType<typeof scriptedChild>) => s.bytes(`"${'x'.repeat(1024 * 1024)}`), 'protocol-error'],
    ['invalid UTF-8', (s: ReturnType<typeof scriptedChild>) => s.bytes(new Uint8Array([0x7b, 0xff, 0xfe, 0x0a])), 'protocol-error'],
    ['too much output in total', (s: ReturnType<typeof scriptedChild>) => { for (let i = 0; i < 5; i += 1) s.bytes(`${JSON.stringify({ type: 'noise', pad: 'x'.repeat(1024 * 1024 - 64) })}\n`); }, 'output-limit'],
  ] as const)('fails pending and later requests on %s, without raw text', async (_name, feed, code) => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const pending = client.request('initialize', {}, signal());
    await settled();
    feed(s);
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProcessFailure);
    expect(error).toMatchObject({ code, message: code });
    await expect(client.request('get_usage', {}, signal())).rejects.toMatchObject({ code });
  });

  it('keeps awaiting replies after exit until stdout ends, then fails what is left', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const answered = client.request('initialize', {}, signal());
    const unanswered = client.request('get_usage', {}, signal());
    await settled();
    s.emit({ type: 'exit', info: { code: 0, signal: null } });
    s.reply(s.frames[0]!, 'late but in the pipe');
    expect(await answered).toEqual({ kind: 'success', value: 'late but in the pipe' });
    s.emit({ type: 'eof' });
    await expect(unanswered).rejects.toMatchObject({ code: 'transport-closed' });
  });

  it('rejects everything pending with the process layer’s failure code', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const pending = client.request('initialize', {}, signal());
    await settled();
    s.emit({ type: 'error', code: 'aborted' });
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('an abort rejects only its own request, and its late reply is ignored', async () => {
    const s = scriptedChild();
    const client = createControlClient(s.child);
    const controller = new AbortController();
    const aborted = client.request('get_usage', {}, controller.signal);
    const other = client.request('initialize', {}, signal());
    await settled();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
    s.reply(s.frames[0]!, 'too late');
    s.reply(s.frames[1]!, 'fine');
    expect(await other).toEqual({ kind: 'success', value: 'fine' });
    await expect(client.request('get_usage', {}, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
  });

  it('rejects a request whose write fails', async () => {
    const s = scriptedChild();
    s.failWrites('transport-closed');
    await expect(createControlClient(s.child).request('initialize', {}, signal())).rejects.toMatchObject({ code: 'transport-closed' });
  });

  it('close ends stdin once and rejects what is pending and anything later', async () => {
    const s = scriptedChild({ exitOnEnd: false });
    const client = createControlClient(s.child);
    const pending = client.request('get_usage', {}, signal());
    await settled();
    client.close();
    client.close();
    expect(s.log).toEqual(['end']);
    await expect(pending).rejects.toMatchObject({ code: 'transport-closed' });
    await expect(client.request('initialize', {}, signal())).rejects.toMatchObject({ code: 'transport-closed' });
  });
});
