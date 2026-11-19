// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { WindowKind } from '@shared/ipc/channels';
import { useAppState } from '../state/store';
import { useCspViolations } from './useCspViolations';

/**
 * Invisible markers for smoke mode (src/main/app/smoke.ts): which page this is, the seq it holds,
 * how many CSP violations it has seen, and whether the state that reached this window carries
 * account identity (which must never happen in the Pet window). Attributes only, no text — it
 * cannot change what the user sees or copies, and smoke checks survive UI redesigns.
 */
export function SmokeProbe({ page }: { readonly page: WindowKind }) {
  const snapshot = useAppState((state) => state.snapshot);
  const violations = useCspViolations();
  return (
    <div
      hidden
      data-smoke-page={page}
      data-smoke-seq={snapshot?.seq ?? ''}
      data-smoke-csp={violations.length}
      data-smoke-identity={holdsIdentity(snapshot) ? 'yes' : 'no'}
    />
  );
}

function holdsIdentity(snapshot: AppStateSnapshot | null): boolean {
  return snapshot?.providers.some((provider) => provider.account?.email !== undefined || provider.account?.organization !== undefined) ?? false;
}
