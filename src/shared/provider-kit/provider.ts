// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AccountInfo } from '../contracts/account';
import type { ModelReport } from '../contracts/catalog';
import type { NotApplicableReason } from '../contracts/status';
import type { ProviderDescriptor, ProviderInstallation } from '../contracts/provider';
import type { ModelLabel } from '../contracts/avatar-overlay';
import type { UsageSnapshot } from '../contracts/usage';
import type { ProviderContext } from './context';
import type { EnvironmentConstraints, Executable, InstallDirectory, VariableSet, VersionedInstallDirectory } from './process';
import type { SessionFacet } from './sessions';

export interface InstallDirectoryHint {
  readonly base: 'home' | 'app-data' | 'local-app-data' | 'applications' | 'mac-applications';
  readonly segments: readonly string[];
  readonly platforms?: readonly ('win32' | 'darwin' | 'linux')[];
  /** Optional runtime versions, searched after ordinary fixed install directories. */
  readonly versions?: Omit<VersionedInstallDirectory, 'root'>;
}

/**
 * What lets a provider run as several instances (M14b, C4, C5): the same CLI started with its own
 * configuration folder, and so its own login. A module declares it from its CLI's documentation;
 * a module without it has one instance, and nothing outside a module names a variable.
 */
export interface InstanceSupport {
  /** The variable that moves the CLI's configuration folder. */
  readonly variable: string;
  /** The CLI's documented default folder, as path segments under the home folder. */
  readonly defaultFolder: readonly string[];
  /**
   * What an added instance's children do not inherit (C9): each would put a credential, a backend
   * or an endpoint before the folder's login, or move the folder's state out of it. The first
   * instance inherits them as the provider does. Names compare case-insensitively on Windows.
   */
  readonly withhold: VariableSet;
}

export interface ProviderDefinition {
  readonly descriptor: ProviderDescriptor;
  /**
   * The module's `catalog-defaults.json`, imported and passed on unparsed: the catalog checks it
   * against the contract when it starts (src/main/catalog/defaults.ts, M13 C20, C24). Imported JSON
   * is widened by TypeScript, so it is never assigned to a typed field before that check.
   */
  readonly catalogDefaults: unknown;
  /**
   * The module's logo for the usage box (M100, C69): its `logo.png` imported with `?inline`, so a
   * `data:image/…;base64,` address, checked at start with the catalog defaults.
   */
  readonly logo?: string;
  /** The status stream's glow image, imported with `?inline` and checked with the defaults. */
  readonly streamImage?: string;
  /** Where Settings' Installation guide leads: an `https:` address, checked at start (M13, C25, C72). The page never sends one. */
  readonly installationGuide: string;
  readonly executableNames: readonly string[];
  readonly installDirectoryHints: readonly InstallDirectoryHint[];
  /** Applied by the process layer to every child of this provider, including version probes. */
  readonly environment?: EnvironmentConstraints;
  /** Present when the CLI keeps one login per configuration folder and documents the variable that moves it. */
  readonly instances?: InstanceSupport;
  /**
   * The version and short name a model identifier of this provider says (decision 0032): the default
   * texts of the avatar overlay. Pure; none where absent. The one place a provider's naming is known.
   */
  readonly modelLabel?: (id: string) => ModelLabel;
  /** A small-family identifier's numeric version, or null for another family. Pure and provider-owned. */
  readonly smallModelVersion?: (id: string) => readonly number[] | null;
  readonly factory: ProviderFactory;
}

export type ProviderFactory = (context: ProviderContext) => AgentProvider;

export interface DetectionOptions {
  readonly override: string | null;
  readonly knownDirs: readonly InstallDirectory[];
}

export type DetectionResult =
  /**
   * `executable`: the file it resolved, kept in main for a sign-in terminal when the CLI was not found
   * on PATH. It never enters app state (`ProviderInstallation`). A stand-in without one has none.
   */
  | { readonly kind: 'found'; readonly installation: ProviderInstallation; readonly executable?: Executable }
  | { readonly kind: 'not-installed'; readonly overrideInvalid: boolean }
  | { readonly kind: 'error'; readonly reason: 'launch-failed' | 'probe-failed' };

/** `cleanup-failed`: an earlier child could not be confirmed gone, so this provider launches nothing. */
export type ProviderErrorReason = 'temporarily-unavailable' | 'unsupported-data' | 'cleanup-failed';

export type AccountResult =
  | { readonly kind: 'account'; readonly account: AccountInfo }
  | { readonly kind: 'not-logged-in' }
  | { readonly kind: 'not-applicable'; readonly reason: NotApplicableReason }
  | { readonly kind: 'error'; readonly reason: ProviderErrorReason };

/**
 * Usage-level `unsupported-cli-version` / `usage-unavailable` keep the account just validated (an
 * account-only panel); a usage-level `api-key` / `cloud-provider` contradicts it and clears it.
 */
export type UsageResult =
  | { readonly kind: 'usage'; readonly usage: UsageSnapshot }
  | { readonly kind: 'empty' }
  | { readonly kind: 'not-applicable'; readonly reason: NotApplicableReason }
  | { readonly kind: 'error'; readonly reason: ProviderErrorReason };

/**
 * Usage events carry the adapter's complete normalized cache; `asOf` remains a full-read time. A
 * `models` event carries the CLI's model list, mapped and bounded by the adapter, which forwards
 * nothing else of the reply (M13, C26); it is never sent with no model in it (C15).
 */
export type ProviderEvent =
  | { readonly type: 'usage'; readonly usage: UsageSnapshot }
  | { readonly type: 'invalidate' }
  | { readonly type: 'connection'; readonly state: 'ready' | 'disconnected' }
  | { readonly type: 'models'; readonly report: ModelReport };

export interface AgentProvider {
  readonly descriptor: ProviderDescriptor;
  detect(options: DetectionOptions, signal: AbortSignal): Promise<DetectionResult>;
  getAccount(signal: AbortSignal): Promise<AccountResult>;
  getUsage(signal: AbortSignal): Promise<UsageResult>;
  subscribe?(listener: (event: ProviderEvent) => void): () => void;
  /**
   * Ask the CLI for its models again (M13, C90, C92); the answer arrives as a `models` event, or not
   * at all. It sends only what the adapter's usage reads may send, and a failure changes nothing: a
   * connection adapter sends nothing while it is not connected, and Claude's runs a session that
   * sends only `initialize`.
   */
  reportModels?(signal: AbortSignal): Promise<void>;
  /** Present exactly when the descriptor says `capabilities.sessions` (M15, C6, C7). */
  readonly sessions?: SessionFacet;
  dispose(): Promise<void>;
}
