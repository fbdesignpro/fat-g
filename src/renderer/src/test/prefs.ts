// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Preferences snapshots for renderer tests: defaults, with whatever a test changes on top.
import { defaultPreferences, type Preferences, type PreferencesSnapshot, type PreferencesStatus } from '@shared/contracts/prefs';

/** `rev` matters: main bumps it on every change, and the window ignores anything not newer. */
export function prefsSnapshot(values: Partial<Preferences> = {}, status: PreferencesStatus = { kind: 'ok' }, rev = 1): PreferencesSnapshot {
  return { rev, values: { ...defaultPreferences(), ...values }, status, providerIssues: {}, instances: {} };
}

/** What main answers a patch with: a newer revision. */
export function savedPrefs(values: Partial<Preferences>): PreferencesSnapshot {
  return prefsSnapshot(values, { kind: 'ok' }, 2);
}
