// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The guards on Settings' actions (docs/planning/_archive/M15.md, Design 10; C18, C99). A provider's switch, a
// change of its executable, an instance's switch and its Redetect each end a runtime and every
// process tree it owns, so main refuses each while a session it reaches is running — in a turn, or
// on workers alone. Which instances an action reaches is the registry's answer (M14b, C60).
//
// A patch is judged as a whole: one part that would end a running session's runtime refuses it all,
// its other parts included, as a patch's other rules do (M14b, C18).
import { FIRST_INSTANCE_ID, type InstanceRef } from '@shared/contracts/instances';
import type { PreferencesPatch, PreferencesSnapshot } from '@shared/contracts/prefs';
import type { RegistryAction } from '../../services/provider-registry';

/** Whether a session of an instance the action reaches is running. */
export type ReachesRunning = (action: RegistryAction, ref: InstanceRef) => boolean;

export interface GuardedAction {
  readonly action: RegistryAction;
  readonly ref: InstanceRef;
}

/**
 * What a patch would do to a runtime, given the preferences as they are: a switch or an executable
 * it names with the value already held changes nothing, and is no action.
 */
export function patchActions(patch: PreferencesPatch, snapshot: Pick<PreferencesSnapshot, 'values' | 'instances'>): GuardedAction[] {
  const actions: GuardedAction[] = [];
  for (const [providerId, update] of Object.entries(patch.providers ?? {})) {
    const held = snapshot.values.providers[providerId];
    const first: InstanceRef = { providerId, instanceId: FIRST_INSTANCE_ID };
    if (update.enabled !== undefined && update.enabled !== held?.enabled) actions.push({ action: 'provider-switch', ref: first });
    if (update.executablePath !== undefined && update.executablePath !== (held?.executablePath ?? null)) actions.push({ action: 'provider-executable', ref: first });
    for (const [key, change] of Object.entries(update.instances ?? {})) {
      if (change.enabled === undefined) continue;
      const entry = snapshot.instances[providerId]?.added.find((candidate) => candidate.id !== null && candidate.id.toLowerCase() === key.toLowerCase());
      if (entry?.enabled !== change.enabled) actions.push({ action: 'instance-switch', ref: { providerId, instanceId: entry?.id ?? key } });
    }
  }
  return actions;
}

/** Whether the patch would end the runtime of a running session. */
export function patchReachesRunning(patch: PreferencesPatch, snapshot: Pick<PreferencesSnapshot, 'values' | 'instances'>, reachesRunning: ReachesRunning): boolean {
  return patchActions(patch, snapshot).some(({ action, ref }) => reachesRunning(action, ref));
}
