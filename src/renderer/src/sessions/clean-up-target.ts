// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { isActive, notStarted, type SessionEntry } from '@shared/contracts/sessions';

/**
 * Whether a press in Clean up done's mode marks this session done (clean-up.ts): one not completed
 * and not running, that has run — a session no turn has run has Cancel for its Done (DoneButton.tsx),
 * which would drop its draft. Its capsule says so to the page, for the mode's hover marking.
 */
export function canCleanUp(entry: SessionEntry): boolean {
  const { record } = entry;
  return record.completedAt === null && entry.summary.status !== 'running' && !(notStarted(entry) && isActive(record));
}
