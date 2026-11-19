// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { zoomHandlers } from './zoom';

const deps: DispatchDeps = {
  origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }),
  log: { warn: vi.fn(), error: vi.fn() },
  detail: 'kinds',
};
const from = (kind: 'main' | 'pet', request: unknown) => ({
  windowKind: kind,
  sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true },
  request,
});

// Through the real contract: the sender policy, the payload schema and the handler together.
describe('zoom:change', () => {
  it.each(['in', 'out', 'reset'] as const)('changes the zoom when the Main window asks: %s', async (to) => {
    const changeZoom = vi.fn();
    const result = await dispatchInvoke('zoom:change', INVOKE_SPECS['zoom:change'], zoomHandlers(changeZoom)['zoom:change'], from('main', { to }), deps);
    expect(result).toEqual({ ok: true, value: null });
    expect(changeZoom).toHaveBeenCalledWith(to);
  });

  it('refuses the Pet, which keeps its own zoom', async () => {
    const changeZoom = vi.fn();
    const result = await dispatchInvoke('zoom:change', INVOKE_SPECS['zoom:change'], zoomHandlers(changeZoom)['zoom:change'], from('pet', { to: 'in' }), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(changeZoom).not.toHaveBeenCalled();
  });

  it.each([{ to: 125 }, { to: 'in', by: 2 }, null])('takes a step and nothing else: %j', async (request) => {
    const changeZoom = vi.fn();
    const result = await dispatchInvoke('zoom:change', INVOKE_SPECS['zoom:change'], zoomHandlers(changeZoom)['zoom:change'], from('main', request), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(changeZoom).not.toHaveBeenCalled();
  });
});
