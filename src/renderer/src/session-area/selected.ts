// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { type CatalogModel, type CatalogProvider, findModel, type ProviderPresentation } from '@shared/contracts/catalog';
import { type InstanceRef, sameInstance, shownLabel } from '@shared/contracts/instances';
import type { PermissionCapability } from '@shared/contracts/permissions';
import type { DetachedConversation } from '@shared/contracts/conversation';
import { catalogEntry } from '@shared/contracts/presets';
import type { ProjectEntryView } from '@shared/contracts/projects';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { useDetached } from '../chat/detached-store';
import { useAppState } from '../state/store';

export type ProjectView = Extract<ProjectEntryView, { kind: 'project' }>;

export interface SelectedSession {
  readonly entry: SessionEntry;
  readonly project: ProjectView | null;
}

/** The session the Main window has selected, with its project; null with none selected (M14, C33, C58). */
export function useSelectedSession(): SelectedSession | null {
  const sessions = useAppState((state) => state.snapshot?.sessions);
  const projects = useAppState((state) => state.snapshot?.records?.projects);
  const entry = sessions?.selectedId == null ? undefined : sessions.sessions.find((candidate) => candidate.record.id === sessions.selectedId);
  if (entry === undefined) return null;
  const project = projects?.find((candidate): candidate is ProjectView => candidate.kind === 'project' && candidate.id === entry.record.projectId) ?? null;
  return { entry, project };
}

/** What the session window shows: the selected session's chat, a chat without a session in its place, or nothing. */
export type ShownChat =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'session' } & SelectedSession)
  | { readonly kind: 'detached'; readonly conversation: DetachedConversation };

const NOTHING_SHOWN: ShownChat = { kind: 'none' };

/**
 * A chat without a session, chosen from the row at the foot of the project column, is shown in the
 * selected session's place until a session is selected or no such chat is left (M18, C31, C35):
 * the chat region, the session's names, Done, the model column and the artifact pane all follow it.
 */
export function useShownChat(): ShownChat {
  const selected = useSelectedSession();
  const detached = useDetached((state) => state.shown);
  const count = useAppState((state) => state.snapshot?.conversations?.detached ?? 0);
  if (detached !== null && count > 0) return { kind: 'detached', conversation: detached };
  return selected === null ? NOTHING_SHOWN : { kind: 'session', ...selected };
}

/** What the catalog says of a session's instance and model, for the avatar column (M14, C88, C108; M14b, C28). */
export interface SessionCatalog {
  /** Its instance's catalog entry: undefined for one that is not configured, or not in this build. */
  readonly provider: CatalogProvider | undefined;
  /**
   * Its provider's look: the same for every account of it (M14b, C43), so a session whose account is
   * no longer configured keeps its provider's colour. Undefined for a provider this build does not have.
   */
  readonly presentation: ProviderPresentation | undefined;
  /** Its account's label, when its provider has more than one account configured (M14b, C47). */
  readonly label: string | null;
  /** The variable that names its provider's configuration folder, when the module declares one: said with a moved folder (M14b, C62). */
  readonly variable: string | null;
  /**
   * Whether its effort can be changed: the session is not held (M14b, C29, C62), and its instance's
   * CLI has reported its models. Otherwise the model shows by its key and the effort by its id, and
   * the effort menu is disabled; main refuses the change whatever the page shows.
   */
  readonly usable: boolean;
  /** The model the record names, as the catalog knows it — the generic entry when it does not. */
  readonly stored: CatalogModel;
  /** The model in force (C23): the record's, until a source reports what the session runs with. */
  readonly inForce: CatalogModel;
}

export function useSessionCatalog(entry: SessionEntry): SessionCatalog {
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const providers = useAppState((state) => state.snapshot?.providers);
  const ref = { providerId: entry.record.providerId, instanceId: entry.record.instanceId };
  const provider = catalogEntry(catalog, ref);
  return {
    provider,
    presentation: (provider ?? catalog?.providers.find((candidate) => candidate.id === ref.providerId))?.presentation,
    label: shownLabel(providers ?? [], ref),
    variable: providers?.find((candidate) => candidate.id === ref.providerId)?.instanceVariable ?? null,
    usable: entry.hold === null && provider !== undefined && provider.source.kind === 'report',
    stored: findModel(catalog, ref, entry.record.model),
    inForce: findModel(catalog, ref, entry.summary.model),
  };
}

/** A session's account as the app state holds it (M22, C43): its own snapshot, which says what the account can use, and its provider's name. */
export interface SessionAccount {
  /** The account's own snapshot: undefined for one that is no longer configured. Its `modes` and its `sandboxSetup` are this account's alone. */
  readonly account: ProviderSnapshot | undefined;
  /** The provider's display name: what fat-g's words name it by. Its id, for a provider this build does not have. */
  readonly name: string;
}

export function sessionAccount(providers: readonly ProviderSnapshot[] | undefined, ref: InstanceRef): SessionAccount {
  const account = providers?.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, ref));
  return { account, name: (account ?? providers?.find((provider) => provider.id === ref.providerId))?.displayName ?? ref.providerId };
}

/**
 * The modes a provider declares, in its own words (M22, C39, C63): its descriptor's, the same for
 * every account of it, or null for a provider that declares none. The page holds no mode table: a
 * mode's label, its description and the lines that stand with them are read from here.
 *
 * One value while the declaration reads the same: every snapshot of the app state is a new object,
 * and whoever hands this to a list of cards would otherwise draw them all again for each.
 */
/** Whether a provider's sessions take a declined question (M100b, C33): what offers Decline on a blocking card. A boolean, so no hold is needed. */
export function useDeclines(providerId: string): boolean {
  return useAppState((state) => state.snapshot?.providers.find((provider) => provider.id === providerId)?.descriptor.capabilities.declines === true);
}

/** Whether a provider's sessions report how full their context is (decision 0033): what draws the context meter. */
export function useReportsContext(providerId: string): boolean {
  return useAppState((state) => state.snapshot?.providers.find((provider) => provider.id === providerId)?.descriptor.capabilities.context === true);
}

export function usePermissions(providerId: string): PermissionCapability | null {
  const declared = useAppState((state) => state.snapshot?.providers.find((provider) => provider.id === providerId)?.descriptor.capabilities.permissions ?? null);
  const [held, setHeld] = useState(declared);
  if (held === declared) return held;
  // Another object: the same declaration keeps the value held, and a changed one replaces it.
  if (JSON.stringify(held) === JSON.stringify(declared)) return held;
  setHeld(declared);
  return declared;
}
