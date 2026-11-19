// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AccountInfo } from './account';
import type { FolderRule, InstanceId, InstanceIssue } from './instances';
import type { ModeAvailability, SandboxSetupView } from './permissions';
import type { PlanAvailability } from './plans';
import type { ProviderDescriptor, ProviderId, ProviderInstallation } from './provider';
import type { UsageSnapshot } from './usage';
import type { ProviderPresence } from './provider-discovery';

/**
 * Why a working provider has no usage allocations to show. `unsupported-cli-version` means the CLI
 * lacks the usage interface; `usage-unavailable` means it answered but reported no allocations.
 */
export type NotApplicableReason = 'api-key' | 'cloud-provider' | 'unsupported-cli-version' | 'usage-unavailable';

/**
 * Where a provider stands. One discriminated union, so every screen must handle every case
 * (`switch-exhaustiveness-check` is on).
 *
 * - `stale`: the last good data is older than twice the poll interval; it is still shown, marked stale.
 * - `waking`: the machine woke and the CLI has not reported allocations yet, so what is shown was
 *   read before it slept (0001's wake amendment). It lasts the recovery window and no longer: after
 *   it, the read's own answer stands, `error` or `not-applicable` as it would without a wake.
 * - `error.message` is user-facing and must never contain personal data (paths, emails).
 * - `blocked` launches nothing. Its last three reasons are an added instance's own (M14b, C16, C37,
 *   C59): an entry the preferences cannot use, a folder that is gone, and a folder that fails a rule.
 *   They name a kind, never a path, a label or a project.
 */
export type ProviderStatus =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'blocked'; readonly reason: 'preferences-unavailable' | 'invalid-preferences' }
  | { readonly kind: 'blocked'; readonly reason: 'invalid-instance'; readonly issue: InstanceIssue }
  | { readonly kind: 'blocked'; readonly reason: 'folder-missing' }
  | { readonly kind: 'blocked'; readonly reason: 'folder-refused'; readonly rule: FolderRule }
  | { readonly kind: 'detecting' }
  | { readonly kind: 'not-installed'; readonly overrideInvalid: boolean }
  | { readonly kind: 'not-logged-in' }
  | { readonly kind: 'not-applicable'; readonly reason: NotApplicableReason }
  | { readonly kind: 'ok' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'waking' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * One instance of a provider (M14b, C19): the app state holds one snapshot each, in registry order
 * and, within a provider, the first instance then the added ones in stored order. A folder is never
 * here: it is in the preferences, which only the Main window reads.
 */
export interface ProviderSnapshot {
  /** The provider's id. With `instanceId` it names the instance. */
  readonly id: ProviderId;
  /** The first instance's fixed id, an added one's UUID, or the run-only key of an entry with no usable id. */
  readonly instanceId: InstanceId;
  /** The user's own word for the account, cleaned: "Default" for a first instance with none, empty for an entry with none. Never in the Pet (C24). */
  readonly label: string;
  /** The variable that moves the CLI's configuration folder, when the module declares one: a second account can then be added. Never in the Pet. */
  readonly instanceVariable: string | null;
  /** The names, never the values, of the variables fat-g was started with that this added instance does not inherit (C64). Never in the Pet. */
  readonly startedWithout: readonly string[];
  readonly displayName: string;
  readonly descriptor: ProviderDescriptor;
  readonly installation: ProviderInstallation | null;
  /** Main's installation discovery, independent of account/usage health. Main window only. */
  readonly presence?: ProviderPresence;
  readonly status: ProviderStatus;
  readonly account: AccountInfo | null;
  readonly usage: UsageSnapshot | null;
  /** Time of the last successful complete account-and-usage refresh. Pushes do not advance it. */
  readonly asOf: number | null;
  /** When the next scheduled read is due (epoch ms); null when not polling. */
  readonly nextRefreshAt: number | null;
  /** A read is in flight right now. */
  readonly refreshing: boolean;
  /**
   * Which of the provider's modes this account can use, and why not (M22, C43, C65): one for each
   * mode its descriptor declares, or none at all while its module has not said. A sandbox mode's
   * writable places are paths, so this is never in the Pet.
   */
  readonly modes?: readonly ModeAvailability[];
  /** Where the account's sandbox setup stands, for a provider that has one (M22, C60, C72); left out otherwise. Never in the Pet. */
  readonly sandboxSetup?: SandboxSetupView;
  /** Whether the account's CLI takes a plan turn now (M22b, C13, C80): left out for a provider that plans nothing, and while its module has not said. Never in the Pet. */
  readonly plans?: PlanAvailability;
}
