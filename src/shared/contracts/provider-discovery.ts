// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/** Installation availability alone; account and usage health are separate. Main window only. */
export type ProviderPresence = 'checking' | 'present' | 'missing' | 'unknown' | 'blocked';

export interface DiscoveredProvider {
  readonly id: string;
  readonly displayName: string;
  readonly presence: ProviderPresence;
  readonly enabled: boolean;
  readonly overrideInvalid: boolean;
  readonly checkFailed: boolean;
}

export interface ProviderDiscoveryNotice {
  readonly revision: number;
  readonly initial: boolean;
  readonly providers: readonly DiscoveredProvider[];
}

export interface ProviderDiscoveryState {
  readonly checking: boolean;
  readonly providers: readonly DiscoveredProvider[];
  readonly notice: ProviderDiscoveryNotice | null;
  readonly historyIssue: 'unavailable' | 'save-failed' | null;
}

export interface ExecutablePresence {
  readonly kind: 'present' | 'missing' | 'unknown';
  readonly overrideInvalid: boolean;
}
