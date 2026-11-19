// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import { FIRST_INSTANCE_ID, type InstanceRef } from '@shared/contracts/instances';
import type { PreferencesStore } from '../../prefs/store';
import type { ProviderRegistry } from '../../services/provider-registry';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';
import type { ReachesRunning } from './guards';
import type { ProviderDiscovery } from '../../services/provider-discovery';

export interface ProviderHandlerDependencies {
  readonly registry: ProviderRegistry;
  readonly discovery?: Pick<ProviderDiscovery, 'scan' | 'acknowledge'>;
  readonly prefs: PreferencesStore;
  readonly pickExecutable: (providerId: string) => Promise<string | null>;
  /** Whether a session an action reaches is running (M15, C18). Nothing is refused for it when absent. */
  readonly reachesRunning?: ReachesRunning;
  readonly platform?: string;
}

export function providerHandlers(deps: ProviderHandlerDependencies): Pick<
  InvokeHandlers,
  'providers:refresh' | 'providers:redetect' | 'providers:pickExecutable' | 'providers:discover' | 'providers:acknowledgeDiscovery'
> {
  let pickerOpen = false;
  const known = (providerId: string): void => {
    if (!deps.registry.has(providerId)) throw new InvalidIpcRequest();
  };
  /** An unknown provider, and an instance the provider does not have, are bad requests (M14b, C21). */
  const instance = (ref: InstanceRef): InstanceRef => {
    if (!deps.registry.has(ref.providerId) || !deps.registry.hasInstance(ref)) throw new InvalidIpcRequest();
    return ref;
  };
  return {
    async 'providers:discover'() { await deps.discovery?.scan(true); return null; },
    'providers:acknowledgeDiscovery': ({ revision }) => deps.discovery?.acknowledge(revision) ?? false,
    // Each reaches the named instance alone (C60).
    'providers:refresh': (ref) => deps.registry.refresh(instance(ref)),
    // A Redetect replaces the instance's runtime, and with it every process it owns (M15, C18).
    'providers:redetect': (ref) => (deps.reachesRunning?.('redetect', instance(ref)) === true ? { status: 'refused', reason: 'session-running' } : deps.registry.redetect(instance(ref))),
    async 'providers:pickExecutable'({ providerId }) {
      known(providerId);
      if (!deps.prefs.isWritable()) return { status: 'refused', reason: 'preferences-blocked' };
      // Another executable replaces the runtime of every instance of the provider (C18): refused
      // before the picker opens, and again after it, since a turn may have started meanwhile.
      const running = (): boolean => deps.reachesRunning?.('provider-executable', { providerId, instanceId: FIRST_INSTANCE_ID }) === true;
      if (running()) return { status: 'refused', reason: 'session-running' };
      if (pickerOpen) return { status: 'refused', reason: 'busy' };
      const before = deps.prefs.getSnapshot().values.providers[providerId]?.executablePath ?? null;
      pickerOpen = true;
      let selected: string | null;
      try { selected = await deps.pickExecutable(providerId); }
      finally { pickerOpen = false; }
      if (selected === null) return { status: 'cancelled' };
      const p = (deps.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
      if (!p.isAbsolute(selected) || selected.includes('\0')) return { status: 'refused', reason: 'unsupported-path' };
      const after = deps.prefs.getSnapshot().values.providers[providerId]?.executablePath ?? null;
      if (after !== before) return { status: 'refused', reason: 'stale-selection' };
      if (selected !== before && running()) return { status: 'refused', reason: 'session-running' };
      deps.prefs.patch({ providers: { [providerId]: { executablePath: selected } } });
      return { status: 'selected' };
    },
  };
}
