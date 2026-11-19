// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Renderer-safe provider identity. Runtime factories and executable hints live in
// shared/provider-kit/provider.ts and never cross into a window; how a provider looks lives in its
// catalog entry (shared/contracts/catalog.ts, M13).
import type { AsideCapability } from './aside';
import type { QuestionCapability } from './interaction';
import type { PermissionCapability } from './permissions';
import type { PlanCapability } from './plans';

/**
 * A provider's stable identifier, e.g. `claude` or `codex`. Deliberately a plain string: the list
 * of built-in providers lives in exactly one place (src/main/providers/index.ts, M6), not here.
 */
export type ProviderId = string;

export interface ProviderCapabilities {
  readonly account: boolean;
  readonly usage: 'none' | 'poll' | 'poll+push';
  /** The provider has a session facet (`AgentProvider.sessions`): fat-g can start its sessions (M15, C6). */
  readonly sessions: boolean;
  /**
   * The provider can read a session's earlier conversation back (M18, C6, C25): its facet has the
   * `history` member exactly when this is true. Apart from `sessions`: a provider can run sessions
   * and keep nothing fat-g can read back, and its chats then show what fat-g recorded itself.
   */
  readonly history: boolean;
  /**
   * The provider's sessions take a project's other root folders beside the one they run in (M16,
   * C61): main hands them over at each start and resume, as `SessionStart.otherFolders`, and hands
   * an empty list to a provider without it.
   */
  readonly otherFolders: boolean;
  /** The adapter reports the CLI's models, as `models` events (M13, C26). */
  readonly models: boolean;
  /**
   * Whether the provider answers a question asked beside a session, and how (M20b, C24): its
   * sessions take `ask` exactly when this is not `none`. A provider with `none` is offered no
   * Explain this and no side question, and no new conversation is passed off as the session's.
   */
  readonly asides: AsideCapability;
  /**
   * Whether the provider's sessions ask the user questions, and how (M21, C30): as requests that
   * hold a turn, in messages, both or neither. Its sessions take `answer` exactly when this is
   * `blocking` or `both`. A provider with `none` raises no card, and a message's questions stay the
   * plain lines they were.
   */
  readonly questions: QuestionCapability;
  /**
   * The provider's sessions take `decline` (M100b, C31, C33): a blocking question's card offers Decline,
   * which declines the whole request and tells the CLI so. Left out, or false, for one that cannot:
   * its blocking card has no Decline. An async card's Decline tells the CLI nothing, and needs none of this.
   */
  readonly declines?: boolean;
  /**
   * The modes the provider's sessions run under, in fat-g's names (M22, C39, C63): what a chat's
   * header, Settings and a project offer. Its facet has `modes` and `transition`, and its sessions
   * take `decide` where a mode asks, exactly when this is not null. Null for a provider that
   * declares none: its sessions run as they always did, and no mode is shown for them.
   */
  readonly permissions: PermissionCapability | null;
  /**
   * The provider's facet has `secretary` (M26; decision 0028): a new session's title is asked of its
   * CLI, and Settings offers which of its models writes it. Left out, or false, for one that has none.
   */
  readonly titles?: boolean;
  /**
   * The provider's sessions take a plan turn (M22b, C2, C5): the modes one may start from and why the
   * others take none. `chat:send` with the plan mode is refused for a provider without it, and its
   * facet has `plans` exactly when this is not null. Left out, or null, for one that plans nothing.
   */
  readonly plans?: PlanCapability | null;
  /**
   * The provider's sessions report how full their context window is, as `context` events (decision
   * 0033): the chat draws its context meter. Left out, or false, for one that reports nothing: no
   * meter stands empty for it.
   */
  readonly context?: boolean;
}

/** Static help examples from a provider module, never resolved paths from the user's machine. */
export interface ExecutableHelp {
  readonly command: string;
  readonly locations: Partial<Record<'win32' | 'darwin' | 'linux', {
    readonly folders: readonly string[];
    readonly note?: string;
  }>>;
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly installGuidance: string;
  readonly executableHelp?: ExecutableHelp;
  readonly loginCommand: string;
  readonly minPollIntervalSec: number;
  readonly capabilities: ProviderCapabilities;
}

/** Safe detection details. The resolved executable path deliberately never enters app state. */
export interface ProviderInstallation {
  readonly source: 'override' | 'path' | 'known-dir';
  readonly version: string | null;
}

export type ProviderActionResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'deferred' }
  /** `session-running`: a Redetect, while a session of that instance runs (M15, C18). */
  | { readonly status: 'refused'; readonly reason: 'disabled' | 'preferences-blocked' | 'not-ready' | 'session-running' };
