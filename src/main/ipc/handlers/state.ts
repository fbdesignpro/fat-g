// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AppStateStore } from '../../state/app-state-store';
import { projectForWindow } from '../../state/projection';
import type { InvokeHandlers } from '../dispatch';

export function stateHandlers(store: AppStateStore): Pick<InvokeHandlers, 'state:getSnapshot'> {
  return {
    // Projected for the caller exactly as broadcasts are: this is how every window gets its FIRST
    // snapshot, so an unprojected answer here would leak account identity into the Pet window.
    'state:getSnapshot': (_request, { windowKind }) => projectForWindow(windowKind, store.getSnapshot()),
  };
}
