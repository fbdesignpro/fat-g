// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { dispatchInvoke } from '../dispatch';
import { resolveTrustedOrigins } from '../../app/origins';
import { dataResetHandlers } from './data-reset';

const deps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: { warn: vi.fn(), error: vi.fn() }, detail: 'kinds' as const };
const from = (windowKind: 'main' | 'pet', request: unknown) => ({ windowKind, sender: { frameUrl: `app://fatg/${windowKind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });
afterEach(() => vi.useRealTimers());

describe('full reset IPC', () => {
  it('reports only the fixed folder and replies before a confirmed graceful quit', async () => {
    vi.useFakeTimers();
    const schedule = vi.fn(() => Promise.resolve({ status: 'scheduled' } as const));
    const quit = vi.fn();
    const handlers = dataResetHandlers({ dataReset: { info: () => Promise.resolve({ folder: '/data/fat-g', available: true }), schedule }, quitAfterReset: quit });
    expect(await dispatchInvoke('diagnostics:dataResetInfo', INVOKE_SPECS['diagnostics:dataResetInfo'], handlers['diagnostics:dataResetInfo'], from('main', null), deps)).toEqual({ ok: true, value: { folder: '/data/fat-g', available: true } });
    expect(await dispatchInvoke('diagnostics:resetAllData', INVOKE_SPECS['diagnostics:resetAllData'], handlers['diagnostics:resetAllData'], from('main', null), deps)).toEqual({ ok: true, value: { status: 'scheduled' } });
    expect(quit).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(quit).toHaveBeenCalledOnce();
  });
  it('does not quit when the request cannot be persisted', async () => {
    vi.useFakeTimers();
    const quit = vi.fn();
    const handlers = dataResetHandlers({ dataReset: { info: () => Promise.resolve({ folder: '', available: false }), schedule: () => Promise.resolve({ status: 'failed' }) }, quitAfterReset: quit });
    expect(await handlers['diagnostics:resetAllData'](null, { windowKind: 'main' })).toEqual({ status: 'failed' });
    vi.runAllTimers(); expect(quit).not.toHaveBeenCalled();
  });
  it.each(['diagnostics:dataResetInfo', 'diagnostics:resetAllData'] as const)('refuses the mini window and renderer-supplied paths on %s', async (channel) => {
    const handlers = dataResetHandlers({});
    expect(await dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as never, from('pet', null), deps)).toEqual({ ok: false, error: 'forbidden' });
    for (const bad of [{ folder: '/project' }, { confirmed: true }, undefined]) expect(await dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as never, from('main', bad), deps)).toEqual({ ok: false, error: 'bad-request' });
  });
});
