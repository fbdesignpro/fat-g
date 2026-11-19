// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { type PetHandlerDeps, petHandlers } from './pet';

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

const SESSION = '0b7c4a52-1d2e-4f3a-9b8c-7d6e5f4a3b2c';
const fakes = (): { [K in keyof PetHandlerDeps]: ReturnType<typeof vi.fn> } => ({ hidePet: vi.fn(), setPetSize: vi.fn(), openSession: vi.fn(), showMain: vi.fn() });
const handlers = (deps: ReturnType<typeof fakes>) => petHandlers(deps as unknown as PetHandlerDeps);

// Through the real contract: the sender policy, the payload schema and the handler together.
describe('pet:hide', () => {
  it('hides the Pet when the Pet asks', async () => {
    const pet = fakes();
    const { hidePet } = pet;
    const result = await dispatchInvoke('pet:hide', INVOKE_SPECS['pet:hide'], handlers(pet)['pet:hide'], from('pet', null), deps);
    expect(result).toEqual({ ok: true, value: null });
    expect(hidePet).toHaveBeenCalledOnce();
  });

  it('refuses the Main window, which shows and hides the Pet through its preferences instead', async () => {
    const pet = fakes();
    const { hidePet } = pet;
    const result = await dispatchInvoke('pet:hide', INVOKE_SPECS['pet:hide'], handlers(pet)['pet:hide'], from('main', null), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(hidePet).not.toHaveBeenCalled();
  });

  it('takes null and nothing else', async () => {
    const pet = fakes();
    const { hidePet } = pet;
    const result = await dispatchInvoke('pet:hide', INVOKE_SPECS['pet:hide'], handlers(pet)['pet:hide'], from('pet', { now: true }), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(hidePet).not.toHaveBeenCalled();
  });
});

describe('pet:setSize', () => {
  it('sets the size the Pet asks for', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:setSize', INVOKE_SPECS['pet:setSize'], handlers(pet)['pet:setSize'], from('pet', { size: 'compact' }), deps);
    expect(result).toEqual({ ok: true, value: null });
    expect(pet.setPetSize.mock.calls).toEqual([['compact']]);
  });

  it('refuses the Main window', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:setSize', INVOKE_SPECS['pet:setSize'], handlers(pet)['pet:setSize'], from('main', { size: 'compact' }), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(pet.setPetSize).not.toHaveBeenCalled();
  });

  it.each([{ size: 'huge' }, { size: 'compact', more: true }, null])('refuses %j', async (request) => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:setSize', INVOKE_SPECS['pet:setSize'], handlers(pet)['pet:setSize'], from('pet', request), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(pet.setPetSize).not.toHaveBeenCalled();
  });
});

describe('pet:open', () => {
  it('opens the session the Pet names', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:open', INVOKE_SPECS['pet:open'], handlers(pet)['pet:open'], from('pet', { id: SESSION }), deps);
    expect(result).toEqual({ ok: true, value: null });
    expect(pet.openSession.mock.calls).toEqual([[SESSION]]);
  });

  it('refuses the Main window, which opens a session by its own capsule', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:open', INVOKE_SPECS['pet:open'], handlers(pet)['pet:open'], from('main', { id: SESSION }), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(pet.openSession).not.toHaveBeenCalled();
  });

  it('takes an id and nothing else', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:open', INVOKE_SPECS['pet:open'], handlers(pet)['pet:open'], from('pet', { id: SESSION, select: true }), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(pet.openSession).not.toHaveBeenCalled();
  });
});

describe('pet:showMain', () => {
  it('brings Main forward without opening a session', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:showMain', INVOKE_SPECS['pet:showMain'], handlers(pet)['pet:showMain'], from('pet', null), deps);
    expect(result).toEqual({ ok: true, value: null });
    expect(pet.showMain).toHaveBeenCalledOnce();
    expect(pet.openSession).not.toHaveBeenCalled();
  });

  it('refuses the Main window', async () => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:showMain', INVOKE_SPECS['pet:showMain'], handlers(pet)['pet:showMain'], from('main', null), deps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(pet.showMain).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { id: SESSION }])('refuses %j instead of null', async (request) => {
    const pet = fakes();
    const result = await dispatchInvoke('pet:showMain', INVOKE_SPECS['pet:showMain'], handlers(pet)['pet:showMain'], from('pet', request), deps);
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(pet.showMain).not.toHaveBeenCalled();
  });
});
