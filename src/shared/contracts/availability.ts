// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether an instance can be asked for anything (M14, C54, C108; M14b, C25, C29): read from the app
// state's provider snapshots, which main and the Main window both hold, so create refuses exactly
// what the popup leaves out and a session is held for the reason the page shows.
//
// Renderer-safe and pure. A folder is never compared here: that is main's alone (C62).
import { FIRST_INSTANCE_ID, type InstanceRef, sameInstance } from './instances';
import type { ProviderSnapshot } from './status';

export type Unavailable = 'provider-unavailable' | 'instance-unavailable';

type Side = Pick<ProviderSnapshot, 'id' | 'instanceId' | 'status' | 'presence'>;

const refOf = (snapshot: Pick<Side, 'id' | 'instanceId'>): InstanceRef => ({ providerId: snapshot.id, instanceId: snapshot.instanceId });

/** An instance's own entry cannot be used: remove it, or put its folder back (C37, C59, C66). */
function instanceBlocked(status: Side['status']): boolean {
  return status.kind === 'blocked' && (status.reason === 'invalid-instance' || status.reason === 'folder-missing' || status.reason === 'folder-refused');
}

/**
 * Why nothing can be started on an instance, or null:
 *
 * - `provider-unavailable`: this build does not have the provider, or it is switched off in
 *   Settings. The first instance has no switch of its own, so it reads `disabled` only then.
 * - `instance-unavailable`: the instance is not configured, is switched off, or is blocked as an
 *   entry or by its folder.
 */
export function unavailable(snapshots: readonly Side[], ref: InstanceRef): Unavailable | null {
  const first = snapshots.find((snapshot) => snapshot.id === ref.providerId && snapshot.instanceId === FIRST_INSTANCE_ID);
  if (first?.presence === 'missing' || first?.presence === 'checking' || first?.presence === 'blocked') return 'provider-unavailable';
  if (first === undefined || first.status.kind === 'disabled') return 'provider-unavailable';
  const own = snapshots.find((snapshot) => sameInstance(refOf(snapshot), ref));
  if (own === undefined || own.status.kind === 'disabled' || instanceBlocked(own.status)) return 'instance-unavailable';
  return null;
}

/** The instances a session can be started on, in the app state's order. */
export function availableInstances(snapshots: readonly Side[]): InstanceRef[] {
  return snapshots.map(refOf).filter((ref) => unavailable(snapshots, ref) === null);
}
