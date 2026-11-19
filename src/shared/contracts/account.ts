// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Who a CLI is signed in as. The identity fields (email, organization) are personal data: they live
// in memory only, and the Pet window never receives them (src/main/state/projection.ts).

/** How the CLI authenticates. Only `subscription` accounts have usage allocations to show. */
export type AuthKind = 'subscription' | 'api-key' | 'cloud-provider' | 'unknown';

export interface AccountInfo {
  readonly authKind: AuthKind;
  /** Plan slug as the CLI reports it (`max`, `prolite`) — the slug, not a display string. */
  readonly plan?: string;
  readonly email?: string;
  readonly organization?: string;
}
