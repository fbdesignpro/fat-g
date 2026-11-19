// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useMemo } from 'react';
import type { RecordsState } from '@shared/contracts/projects';
import type { DiscoveredProvider, ProviderDiscoveryState } from '@shared/contracts/provider-discovery';
import { useAppState } from '../state/store';

/**
 * What the empty session window tells someone starting out (the maintainer): with no
 * provider detected and switched on, how to get one; with one and no project yet, where to add one.
 */
export type FirstRunGuide =
  | { readonly kind: 'no-provider'; readonly providers: readonly DiscoveredProvider[]; readonly checking: boolean }
  | { readonly kind: 'add-project' };

/**
 * Nothing until main's first check has settled, so neither guide flashes at launch; nothing once a
 * project exists, or while the records file is refused (its own note says what to do). A switched-on
 * provider checked again keeps counting as usable, so a recheck does not flash the guide either.
 */
export function firstRunGuide(discovery: ProviderDiscoveryState | undefined, records: RecordsState | undefined): FirstRunGuide | null {
  if (discovery === undefined) return null;
  const usable = discovery.providers.some((provider) => provider.enabled && (provider.presence === 'present' || provider.presence === 'checking'));
  if (!usable) {
    if (discovery.providers.every((provider) => provider.presence === 'checking')) return null;
    return { kind: 'no-provider', providers: discovery.providers, checking: discovery.checking };
  }
  return records?.status.kind === 'ok' && records.projects.length === 0 ? { kind: 'add-project' } : null;
}

export function useFirstRunGuide(): FirstRunGuide | null {
  const discovery = useAppState((state) => state.snapshot?.providerDiscovery);
  const records = useAppState((state) => state.snapshot?.records);
  return useMemo(() => firstRunGuide(discovery, records), [discovery, records]);
}
