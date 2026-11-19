// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { appHandlers } from './app';

const deps: DispatchDeps = {
  origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }),
  log: { warn: vi.fn(), error: vi.fn() },
  detail: 'kinds',
};
const from = (kind: 'main' | 'pet', request: unknown) => ({
  windowKind: kind,
  sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html?theme=light`, isTopFrame: true },
  request,
});
const handlers = (quit = vi.fn(), answerQuit = vi.fn(() => true)) => appHandlers({ quit, answerQuit });

afterEach(() => {
  vi.useRealTimers();
});

// Through the real contract: the sender policy, the payload schema and the handler together.
describe('app:quit', () => {
  it('answers the Main window first, then quits on the next tick', async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const result = await dispatchInvoke('app:quit', INVOKE_SPECS['app:quit'], handlers(quit)['app:quit'], from('main', null), deps);
    expect(result).toEqual({ ok: true, value: null });
    expect(quit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(quit).toHaveBeenCalledOnce();
  });

  it('refuses the Pet window', async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const result = await dispatchInvoke('app:quit', INVOKE_SPECS['app:quit'], handlers(quit)['app:quit'], from('pet', null), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    vi.runAllTimers();
    expect(quit).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { force: true }, 'now'])('takes null and nothing else, refusing %j', async (request) => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const result = await dispatchInvoke('app:quit', INVOKE_SPECS['app:quit'], handlers(quit)['app:quit'], from('main', request), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    vi.runAllTimers();
    expect(quit).not.toHaveBeenCalled();
  });
});

// M14 (C101, V7): the page's answer to main's quit question.
describe('app:answerQuit', () => {
  const ask = (answerQuit: (quit: boolean) => boolean, kind: 'main' | 'pet', request: unknown, quit = vi.fn()) =>
    dispatchInvoke('app:answerQuit', INVOKE_SPECS['app:answerQuit'], appHandlers({ quit, answerQuit })['app:answerQuit'], from(kind, request), deps);

  it.each([true, false])('hands the Main window’s answer (%s) to the gate, once', async (quit) => {
    const answerQuit = vi.fn(() => true);
    expect(await ask(answerQuit, 'main', { quit })).toEqual({ ok: true, value: { status: 'answered' } });
    expect(answerQuit.mock.calls).toEqual([[quit]]);
  });

  it('is refused while no question is asked, and quits nothing itself', async () => {
    const quit = vi.fn();
    expect(await ask(() => false, 'main', { quit: true }, quit)).toEqual({ ok: true, value: { status: 'refused', reason: 'no-question' } });
    expect(quit).not.toHaveBeenCalled();
  });

  it('refuses the Pet window, which is never asked', async () => {
    const answerQuit = vi.fn(() => true);
    expect(await ask(answerQuit, 'pet', { quit: true })).toEqual({ ok: false, error: 'forbidden' });
    expect(answerQuit).not.toHaveBeenCalled();
  });

  it.each([null, {}, { quit: 'yes' }, { quit: true, force: true }])('takes { quit } and nothing else, refusing %j', async (request) => {
    const answerQuit = vi.fn(() => true);
    expect(await ask(answerQuit, 'main', request)).toEqual({ ok: false, error: 'bad-request' });
    expect(answerQuit).not.toHaveBeenCalled();
  });
});
