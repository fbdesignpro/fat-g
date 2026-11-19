// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { invoke } from '../ipc/client';

export const CANCEL_NEW_SESSION = 'Cancel new session';

/** Explicitly discard an unsent session; main refuses if its first turn has already started. */
export async function cancelNewSession(id: string): Promise<boolean> {
  return (await invoke('sessions:remove', { id, draftOnly: true })).status === 'saved';
}
