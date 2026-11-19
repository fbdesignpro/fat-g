// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useCallback, useSyncExternalStore } from 'react';
import { actionStatus, type ActionHold, type SessionAction } from '@shared/contracts/sessions';

/** Only visible words use the grace. Main supplies its original deadline across every mount. */
export function useActionWords(action: Pick<SessionAction, 'kind' | 'wait'> | null, hold: ActionHold | undefined, active: boolean): string {
  const until = active && action?.kind === 'thinking' ? hold?.until : undefined;
  const subscribe = useCallback((wake: () => void) => {
    const remaining = until === undefined ? 0 : until - Date.now();
    const timer = remaining > 0 ? setTimeout(wake, remaining) : undefined;
    return () => clearTimeout(timer);
  }, [until]);
  const snapshot = useCallback(() => until !== undefined && until > Date.now(), [until]);
  const pending = useSyncExternalStore(subscribe, snapshot);
  return actionStatus(pending && hold !== undefined ? hold : action ?? 'thinking');
}
