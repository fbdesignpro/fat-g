// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { RecordsStore } from '../../records/store';
import type { InvokeHandlers } from '../dispatch';

/**
 * The project column's note for a refused records file (M12, C61, C67). Start fresh moves the file
 * aside only once the page has asked the user and they confirmed it; a failed move rejects, and the
 * dispatcher logs its kind.
 */
export function recordsHandlers(records: RecordsStore): Pick<InvokeHandlers, 'records:startFresh' | 'records:retry'> {
  return {
    'records:startFresh': () => records.startFresh(),
    'records:retry': () => records.retry(),
  };
}
