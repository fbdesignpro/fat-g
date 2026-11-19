// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { DataReset } from '../../app/data-reset';
import type { InvokeHandlers } from '../dispatch';

export interface DataResetHandlerDeps {
  readonly dataReset?: Pick<DataReset, 'info' | 'schedule'>;
  /** Already confirmed twice: still uses the normal process/drain/save shutdown. */
  readonly quitAfterReset?: () => void;
}
export function dataResetHandlers(deps: DataResetHandlerDeps): Pick<InvokeHandlers, 'diagnostics:dataResetInfo' | 'diagnostics:resetAllData'> {
  return {
    'diagnostics:dataResetInfo': () => deps.dataReset?.info() ?? { folder: '', available: false },
    async 'diagnostics:resetAllData'() {
      if (deps.dataReset === undefined || deps.quitAfterReset === undefined) return { status: 'failed' };
      const result = await deps.dataReset.schedule();
      // Answer the IPC first, then quit through the existing graceful drain, with no third question.
      if (result.status === 'scheduled') setTimeout(deps.quitAfterReset, 0);
      return result;
    },
  };
}
