// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M13 (C43, C51, C58; V14): Reload reads catalog.json again, for the Main window only.
import { describe, expect, it, vi } from 'vitest';
import type { OverrideStatus } from '@shared/contracts/catalog';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { catalogHandlers } from './catalog';

const deps: DispatchDeps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: { warn: vi.fn(), error: vi.fn() }, detail: 'kinds' };
const status: OverrideStatus = { kind: 'ignored', path: 'C:\\data\\catalog.json', cause: 'not-json', field: null };

function call(windowKind: 'main' | 'pet', request: unknown) {
  const reload = vi.fn(() => status);
  const handler = catalogHandlers({ reload })['catalog:reload'];
  const sender = { frameUrl: windowKind === 'main' ? 'app://fatg/index.html' : 'app://fatg/pet.html', isTopFrame: true };
  return { reload, result: dispatchInvoke('catalog:reload', INVOKE_SPECS['catalog:reload'], handler, { windowKind, sender, request }, deps) };
}

describe('catalog:reload', () => {
  it('reads the file again and answers its status', async () => {
    const { reload, result } = call('main', null);
    await expect(result).resolves.toEqual({ ok: true, value: status });
    expect(reload).toHaveBeenCalledOnce();
  });

  it('takes nothing but null', async () => {
    const { reload, result } = call('main', { path: 'C:\\elsewhere\\catalog.json' });
    await expect(result).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('is refused to the Pet', async () => {
    const { reload, result } = call('pet', null);
    await expect(result).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(reload).not.toHaveBeenCalled();
  });
});
