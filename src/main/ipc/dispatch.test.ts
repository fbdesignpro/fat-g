// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The three M2 refusal criteria (bad payload, foreign origin, wrong window kind) plus handler
// failure, driven through the real dispatcher with a synthetic contract.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { InvokeSpec } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../app/origins';
import { dispatchInvoke, type DispatchDeps, type InvokeCall } from './dispatch';

const origins = resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined });

function setup(detail: DispatchDeps['detail'] = 'kinds') {
  const log = { warn: vi.fn(), error: vi.fn() };
  const deps: DispatchDeps = { origins, log, detail };
  return { log, deps };
}

const mainOnly: InvokeSpec<{ n: number }> = { request: z.object({ n: z.number() }), from: ['main'] };
const fromMain = (request: unknown): InvokeCall => ({
  windowKind: 'main',
  sender: { frameUrl: 'app://fatg/index.html', isTopFrame: true },
  request,
});

describe('dispatchInvoke', () => {
  it('runs the handler with the parsed request and the caller window kind', async () => {
    const { deps } = setup();
    const handler = vi.fn((request: { n: number }) => request.n * 2);

    await expect(dispatchInvoke('test:double', mainOnly, handler, fromMain({ n: 21 }), deps)).resolves.toEqual({ ok: true, value: 42 });
    expect(handler).toHaveBeenCalledWith({ n: 21 }, { windowKind: 'main' });
  });

  it('awaits async handlers', async () => {
    const { deps } = setup();
    const result = await dispatchInvoke('test:async', mainOnly, (request) => Promise.resolve(request.n + 1), fromMain({ n: 1 }), deps);
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it.each([
    ['a wrong type', { n: 'one' }],
    ['a missing field', {}],
    ['no payload at all', undefined],
    ['null', null],
  ])('refuses %s as bad-request without calling the handler', async (_name, request) => {
    const { deps, log } = setup();
    const handler = vi.fn();

    await expect(dispatchInvoke('test:double', mainOnly, handler, fromMain(request), deps)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('refuses a foreign origin as forbidden without calling the handler', async () => {
    const { deps } = setup();
    const handler = vi.fn();
    const call: InvokeCall = { ...fromMain({ n: 1 }), sender: { frameUrl: 'https://evil.example/', isTopFrame: true } };

    await expect(dispatchInvoke('test:double', mainOnly, handler, call, deps)).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a window kind the channel does not allow as forbidden', async () => {
    const { deps } = setup();
    const handler = vi.fn();
    const call: InvokeCall = { windowKind: 'pet', sender: { frameUrl: 'app://fatg/pet.html', isTopFrame: true }, request: { n: 1 } };

    await expect(dispatchInvoke('test:double', mainOnly, handler, call, deps)).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks the sender before parsing, so a foreign page cannot probe the schema', async () => {
    const { deps } = setup();
    const call: InvokeCall = { ...fromMain('garbage'), sender: { frameUrl: 'https://evil.example/', isTopFrame: true } };
    await expect(dispatchInvoke('test:double', mainOnly, vi.fn(), call, deps)).resolves.toEqual({ ok: false, error: 'forbidden' });
  });

  it.each([
    ['throws', () => {
      throw new Error("ENOENT: no such file, open 'C:\\Users\\someone\\.claude\\secret.json'");
    }],
    ['rejects', () => Promise.reject(new Error('C:\\Users\\someone\\private'))],
  ])('when the handler %s, answers internal with nothing from the error', async (_name, handler) => {
    const { deps, log } = setup();

    const result = await dispatchInvoke('test:double', mainOnly, handler, fromMain({ n: 1 }), deps);

    expect(result).toEqual({ ok: false, error: 'internal' });
    expect(JSON.stringify(result)).not.toContain('someone');
    // A packaged build logs the kind only (C77).
    expect(log.error).toHaveBeenCalledWith('[ipc] test:double handler failed (Error)');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('someone');
  });

  it('keeps the real error for the developer in a development run (C79)', async () => {
    const { deps, log } = setup('full');
    const error = Object.assign(new Error("EPERM: rename 'C:\\Users\\someone\\records.json.tmp'"), { code: 'EPERM' });
    await dispatchInvoke('test:double', mainOnly, () => Promise.reject(error), fromMain({ n: 1 }), deps);
    expect(log.error).toHaveBeenCalledWith('[ipc] test:double handler failed (Error EPERM)', error);
  });
});

// M12 (C54, C77, C79): what a log line may hold. Filesystem errors say where the file is, and a
// request's values are the user's own text, so a packaged build logs neither.
describe('the log in a packaged build', () => {
  const strict: InvokeSpec<{ name: string; roots: { path: string }[] }> = {
    request: z.strictObject({ name: z.string().max(5), roots: z.array(z.strictObject({ path: z.string() })) }),
    from: ['main'],
  };

  it('names each fault by its code and field, never by a value, an index or an unknown key', async () => {
    const { deps, log } = setup();
    const request = { name: 'Someone Private', roots: [{ path: 'C:\\Users\\someone', extra: 1 }], 'C:\\Users\\someone': true };
    await dispatchInvoke('test:strict', strict, vi.fn(), fromMain(request), deps);
    const call: unknown[] = log.warn.mock.calls[0] ?? [];
    expect(call).toHaveLength(1);
    expect(call[0]).toBe('[ipc] bad request on test:strict from the main window: too_big at name, unrecognized_keys at roots, unrecognized_keys');
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/someone|Private|extra/i);
  });

  it('names no field for a request that is not an object', async () => {
    const { deps, log } = setup();
    await dispatchInvoke('test:null', { request: z.null(), from: ['main'] }, vi.fn(), fromMain('Someone'), deps);
    expect(log.warn).toHaveBeenCalledWith('[ipc] bad request on test:null from the main window: invalid_type');
  });

  it('adds zod’s issues in a development run', async () => {
    const { deps, log } = setup('full');
    await dispatchInvoke('test:strict', strict, vi.fn(), fromMain({ name: 'toolong', roots: [] }), deps);
    expect(log.warn).toHaveBeenCalledWith('[ipc] bad request on test:strict from the main window: too_big at name', expect.any(Array));
  });
});
