// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ChatMode } from '@shared/contracts/permissions';
import type { ModelPreset } from '@shared/contracts/presets';
import type { SessionRefusal, SessionSaved } from '@shared/contracts/sessions';
import type { ConversationStore } from '../conversations/store';
import type { SessionRecord } from '../records/format';
import type { RecordsStore } from '../records/store';
import type { Permissions } from './permissions';

/** A crash between the two stores must leave Send blocked, never under the other provider's mode. */
const CHANGING: ChatMode = { id: 'draft-preset-changing', source: 'chat' };

export async function saveDraftPreset(input: {
  readonly record: SessionRecord;
  readonly preset: ModelPreset;
  readonly records: Pick<RecordsStore, 'setDraftPreset'>;
  readonly store: Pick<ConversationStore, 'conversation' | 'draftOnly' | 'setDraftMode'>;
  readonly permissions: Permissions | undefined;
  readonly changed: (mode: ChatMode | null) => void;
}): Promise<SessionSaved | SessionRefusal> {
  const { record, preset, records, store, permissions } = input;
  const id = record.id;
  const previous = store.conversation(id)?.mode ?? null;
  const crossProvider = record.providerId !== preset.providerId;
  const next = crossProvider ? permissions?.resolve({ ...record, ...preset }, null) ?? null : previous;
  let rebound = false;
  try {
    if (!store.draftOnly(id)) return { status: 'refused', reason: 'draft-locked' };
    if (crossProvider) store.setDraftMode(id, CHANGING, record.createdAt);
    const answer = await records.setDraftPreset(id, preset);
    rebound = answer.status === 'saved';
    if (crossProvider) store.setDraftMode(id, rebound ? next : previous, record.createdAt);
    input.changed(rebound ? next : previous);
    return answer;
  } catch {
    if (!crossProvider) {
      input.changed(previous);
      return { status: 'refused', reason: 'storage-failed' };
    }
    // A failed records write retains the old selection; restore its mode where the store permits.
    // A failed mode write after rebinding keeps the durable blocking marker until Change mode.
    if (!rebound) {
      try { store.setDraftMode(id, previous, record.createdAt); } catch { /* The blocking marker remains. */ }
    }
    let mode = CHANGING;
    try { mode = store.conversation(id)?.mode ?? CHANGING; } catch { /* Remain blocked. */ }
    input.changed(mode);
    return { status: 'refused', reason: 'storage-failed' };
  }
}
