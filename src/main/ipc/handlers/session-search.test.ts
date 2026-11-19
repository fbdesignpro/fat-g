// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH_FILTERS, MAX_SEARCH_QUERY } from '@shared/contracts/session-search';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { sessionSearchHandlers } from './session-search';

const request = { ...DEFAULT_SEARCH_FILTERS, query: 'private query', offset: 0 };
describe('sessions:search', () => {
  const setup = () => {
    const result = { status: 'ready' as const, hits: [], total: 0, more: false };
    const search = vi.fn(() => Promise.resolve(result));
    const handlers = sessionSearchHandlers({ search, release: () => undefined, stop: () => undefined });
    const deps: DispatchDeps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: { warn: vi.fn(), error: vi.fn() }, detail: 'full' };
    const invoke = (kind: 'main' | 'pet', payload: unknown) => dispatchInvoke('sessions:search', INVOKE_SPECS['sessions:search'], handlers['sessions:search'], {
      windowKind: kind, sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request: payload,
    }, deps);
    return { search, deps, invoke, result };
  };
  it('allows only Main, and validates all query parameters before reaching the service', async () => {
    const { invoke, search, result } = setup();
    expect(await invoke('pet', request)).toEqual({ ok: false, error: 'forbidden' });
    for (const invalid of [null, { ...request, offset: -1 }, { ...request, scope: 'files' }, { ...request, projectId: '../outside' }, { ...request, query: 'x'.repeat(MAX_SEARCH_QUERY + 1) }]) {
      expect(await invoke('main', invalid)).toEqual({ ok: false, error: 'bad-request' });
    }
    expect(search).not.toHaveBeenCalled();
    expect(await invoke('main', request)).toEqual({ ok: true, value: result });
    expect(search).toHaveBeenCalledWith(request);
  });
  it('never logs queries or errors containing conversation text, even in development', async () => {
    const { search, deps, invoke } = setup();
    search.mockRejectedValue(new Error('private query and conversation excerpt'));
    expect(await invoke('main', request)).toEqual({ ok: true, value: { status: 'messages-unavailable', hits: [], total: 0, more: false } });
    expect(deps.log.error).not.toHaveBeenCalled();
    expect(deps.log.warn).not.toHaveBeenCalled();
  });
});
