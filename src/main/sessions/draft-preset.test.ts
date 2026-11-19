// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type { ModelPreset } from '@shared/contracts/presets';
import type { ChatMode } from '@shared/contracts/permissions';
import type { SessionRecord } from '../records/format';
import type { ConversationStore } from '../conversations/store';
import type { Permissions } from './permissions';
import { saveDraftPreset } from './draft-preset';

const record = { id: 'draft', providerId: 'a', instanceId: 'default', model: 'old', effort: 'low', createdAt: 1 } as SessionRecord;
const choice: ModelPreset = { providerId: 'a', instanceId: 'other', model: 'new', effort: 'high', speed: null };
const oldMode = { id: 'read', source: 'chat' } as const;
const nextMode = { id: 'ask', source: 'project' } as const;
function setup() {
  let mode: ChatMode | null = oldMode;
  const store: Pick<ConversationStore, 'conversation' | 'draftOnly' | 'setDraftMode'> = {
    conversation: () => ({ mode }) as ReturnType<ConversationStore['conversation']>,
    draftOnly: () => true,
    setDraftMode: vi.fn<ConversationStore['setDraftMode']>((_id, value) => { mode = value; }),
  };
  const records = { setDraftPreset: vi.fn(() => Promise.resolve({ status: 'saved' as const })) };
  const resolve = vi.fn(() => nextMode);
  const permissions = { resolve } as unknown as Permissions;
  const changed = vi.fn();
  return { record, store, records, permissions, resolve, changed };
}
describe('provisional permission mode when a selection changes', () => {
  it('retains the same-provider mode across account/model changes', async () => {
    const input = setup();
    expect(await saveDraftPreset({ ...input, preset: choice })).toEqual({ status: 'saved' });
    expect(input.resolve).not.toHaveBeenCalled();
    expect(input.changed).toHaveBeenCalledWith(oldMode);
  });
  it('uses the new provider’s defaults and writes a blocking marker before rebinding', async () => {
    const input = setup();
    input.records.setDraftPreset.mockImplementation(() => {
      expect(input.store.conversation('draft')?.mode?.id).toBe('draft-preset-changing');
      return Promise.resolve({ status: 'saved' });
    });
    expect(await saveDraftPreset({ ...input, preset: { ...choice, providerId: 'b' } })).toEqual({ status: 'saved' });
    expect(input.resolve).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'b' }), null);
    expect(input.changed).toHaveBeenCalledWith(nextMode);
  });
  it('restores the old mode after a record write fails', async () => {
    const input = setup();
    input.records.setDraftPreset.mockRejectedValue(new Error('disk full'));
    expect(await saveDraftPreset({ ...input, preset: { ...choice, providerId: 'b' } })).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(input.store.conversation('draft')?.mode).toEqual(oldMode);
  });
  it('leaves Send blocked if the new mode cannot be saved after rebinding', async () => {
    const input = setup();
    const write = input.store.setDraftMode;
    input.store.setDraftMode = (id, mode, at) => { if (mode?.id === 'ask') throw new Error('disk full'); write(id, mode, at); };
    expect(await saveDraftPreset({ ...input, preset: { ...choice, providerId: 'b' } })).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(input.changed).toHaveBeenCalledWith({ id: 'draft-preset-changing', source: 'chat' });
  });
  it('refuses any conversation content beyond the draft', async () => {
    const input = setup();
    input.store.draftOnly = () => false;
    expect(await saveDraftPreset({ ...input, preset: choice })).toEqual({ status: 'refused', reason: 'draft-locked' });
    expect(input.records.setDraftPreset).not.toHaveBeenCalled();
  });
});
