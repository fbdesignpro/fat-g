// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether the sandbox setup's dialog is open, and for which account (docs/planning/_archive/M22.md, Design 10;
// C60, C62). In memory only, never saved: it is where you happen to be, as Settings' own store is.
// What the dialog shows is the account's own snapshot, which main publishes; nothing of a setup is
// held here, and opening the dialog sends nothing.
import { create } from 'zustand';
import type { InstanceRef } from '@shared/contracts/instances';

export interface SandboxSetupDialogView {
  readonly open: boolean;
  /** The account the setup belongs to: a provider's instance (decision 0017). */
  readonly target: InstanceRef | null;
}

export const useSandboxSetup = create<SandboxSetupDialogView>()(() => ({ open: false, target: null }));

export function openSandboxSetup(target: InstanceRef): void {
  useSandboxSetup.setState({ open: true, target: { providerId: target.providerId, instanceId: target.instanceId } });
}

export function closeSandboxSetup(): void {
  useSandboxSetup.setState({ open: false, target: null });
}
