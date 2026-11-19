// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What each kind of window is allowed to see of the app state.
//
// The Pet window is always on top, so it appears in screen shares and screenshots: it gets a copy
// with no account identity. That copy is built from an ALLOWLIST, field by field, on purpose — a
// field added to ProviderSnapshot later stays out of the Pet window until someone decides it
// belongs there, instead of leaking by default.
//
// Applied on BOTH paths a snapshot takes to a window: the `state:getSnapshot` response and every
// broadcast. Pure — no Electron imports.
import type { AccountInfo } from '@shared/contracts/account';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { ProviderSnapshot } from '@shared/contracts/status';
import type { WindowKind } from '@shared/ipc/channels';
import { petView } from './pet-view';

export function projectForWindow(kind: WindowKind, snapshot: AppStateSnapshot): AppStateSnapshot {
  switch (kind) {
    case 'main':
      return snapshot;
    case 'pet':
      return {
        seq: snapshot.seq,
        // The theme is no one's identity, and the Pet follows it like the Main window (C9); so does
        // the attention flash its capsules draw.
        appearance: appearanceForPet(snapshot.appearance),
        providers: snapshot.providers.map(providerForPet),
        // The sessions running or waiting on the user, by their own allowlist (decision 0010).
        pet: petView(snapshot),
      };
  }
}

function providerForPet(provider: ProviderSnapshot): ProviderSnapshot {
  return {
    id: provider.id,
    // A random id that says nothing of the account: what tells two snapshots of one provider apart
    // (M14b, C67). The label is the user's own word and may say "Work" on a shared screen, and the
    // variable and the withheld names describe the user's environment: none of them is copied (C24).
    instanceId: provider.instanceId,
    label: '',
    instanceVariable: null,
    startedWithout: [],
    displayName: provider.displayName,
    descriptor: provider.descriptor,
    installation: provider.installation,
    // Status and usage carry no identity (status messages must never contain personal data).
    status: provider.status,
    account: provider.account === null ? null : accountForPet(provider.account),
    usage: provider.usage,
    asOf: provider.asOf,
    nextRefreshAt: provider.nextRefreshAt,
    refreshing: provider.refreshing,
  };
}

function appearanceForPet({ theme, flash }: AppStateSnapshot['appearance']): AppStateSnapshot['appearance'] {
  return flash === undefined ? { theme } : { theme, flash: { enabled: flash.enabled, speed: flash.speed, seconds: flash.seconds } };
}

/** How the account signs in and on which plan — never who it is (no email, no organization). */
function accountForPet(account: AccountInfo): AccountInfo {
  return account.plan === undefined ? { authKind: account.authKind } : { authKind: account.authKind, plan: account.plan };
}
