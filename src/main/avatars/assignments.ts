// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a model and a session draw (docs/planning/_archive/M103.md, Design 3; C9–C11, C14, C15; decision
// 0031): the avatar the user assigned to the model — its override — then its provider's active family
// searched by its match entries, then that family's face, then the provider's built-in face, then
// none, the placeholder standing in the page. The search is made at each resolution and never written:
// nothing automatic changes an assignment. A reference the current scan does not list, or whose avatar
// has no usable portrait, resolves past itself, and the assignment stays as it is (C7, C11).
//
// The active family is the user's choice for the provider, else the built-in family that holds its
// face; a chosen family the scan does not list, or that has nothing for the provider, stands aside.
// With the avatar comes its overlay (decision 0032): the family's layer, then the avatar's, both from
// the family's own file, over the texts the provider reads from the model's identifiers. The effort its
// marks count is the session's, given where it is drawn, and no part of what is resolved here.
//
// A session's model is found by key, then resolved id, within its own account, or by its reported id
// where no catalog row exists. Its version-id assignment takes priority over its CLI-key fallback;
// neither moves when the CLI changes an alias (decision 0031, version identifiers).
//
// The resolution runs again on each change of what it reads (C12): the assignments, in the preferences,
// redraw every model and every session; a catalog change — a report, a Rescan, the override — every
// session, whose model in force may be found under another key. The scan's landing redraws both, as
// M102 wired it. An unchanged resolution is the same object, so nothing unchanged is sent again.
//
// Electron-free: the avatar service, the preferences, the app state and the two services are its options.
import { type ModelLabel, NO_LABEL, resolveOverlay } from '@shared/contracts/avatar-overlay';
import type { AvatarSource, ResolvedAvatar } from '@shared/contracts/avatars';
import { avatarAssignment } from '@shared/contracts/avatar-targets';
import { type CatalogState, findModel } from '@shared/contracts/catalog';
import type { InstanceRef } from '@shared/contracts/instances';
import type { Preferences } from '@shared/contracts/prefs';
import type { PreferencesStore } from '../prefs/store';
import type { CatalogService } from '../services/catalog-service';
import type { SessionService } from '../sessions/service';
import type { AppStateStore } from '../state/app-state-store';
import type { AvatarService } from './service';

export interface AvatarResolverOptions {
  readonly avatars: Pick<AvatarService, 'assigned' | 'defaultFace' | 'family' | 'defaultFamily' | 'layers'>;
  /** The preferences' avatar section — overrides and active families — as the snapshot holds it now. */
  readonly preferences: () => Preferences['avatars'];
  /** A provider's reading of a model identifier's version and short name (decision 0032); none where absent. */
  readonly label?: (providerId: string, id: string) => ModelLabel;
}

export interface AvatarResolver {
  /** A catalog model's avatar: its version id first, then its CLI key. */
  forModel(providerId: string, key: string, resolvedId?: string | null): ResolvedAvatar | null;
  /** A session's avatar, by the model it reports in force (C9). */
  forSession(catalog: CatalogState | undefined, ref: InstanceRef, model: string): ResolvedAvatar | null;
}

export function createAvatarResolver({ avatars, preferences, label = () => NO_LABEL }: AvatarResolverOptions): AvatarResolver {
  /** The provider's active family: the user's choice where the scan lists it and it has something for the provider. */
  const activeFamily = (providerId: string, settings: Preferences['avatars']) => {
    const chosen = settings.active[providerId];
    const family = chosen === undefined ? undefined : avatars.family(chosen);
    if (family?.usableFor(providerId) === true) return family;
    const fallback = avatars.defaultFamily(providerId);
    return fallback === null ? undefined : avatars.family(fallback);
  };

  /** What the model draws and why: the override, the family's match, its face, the built-in face. */
  const drawn = (providerId: string, model: { readonly key: string; readonly resolvedId: string | null }, settings: Preferences['avatars']): { readonly avatar: ResolvedAvatar; readonly source: AvatarSource } | null => {
    const held = avatarAssignment(settings.assignments[providerId] ?? {}, model);
    const assigned = held === null ? null : avatars.assigned(held.ref);
    if (assigned !== null) return { avatar: assigned, source: 'override' };
    const family = activeFamily(providerId, settings);
    const matched = family?.match(providerId, model) ?? null;
    if (matched !== null) return { avatar: matched, source: 'match' };
    const face = family?.face(providerId) ?? null;
    if (face !== null) return { avatar: face, source: 'family-face' };
    const builtIn = avatars.defaultFace(providerId);
    return builtIn === null ? null : { avatar: builtIn, source: 'built-in-face' };
  };

  /** The provider's reading of the model: its resolved id's, else its key's. */
  const labelOf = (providerId: string, model: { readonly key: string; readonly resolvedId: string | null }): ModelLabel => {
    const read = model.resolvedId === null ? NO_LABEL : label(providerId, model.resolvedId);
    return read.version !== null || read.name !== null ? read : label(providerId, model.key);
  };

  const forModel = (providerId: string, key: string, resolvedId: string | null = null): ResolvedAvatar | null => {
    const settings = preferences();
    const model = { key, resolvedId };
    const found = drawn(providerId, model, settings);
    if (found === null) return null;
    const { avatar, source } = found;
    const overlay = resolveOverlay(avatars.layers(avatar.ref), labelOf(providerId, model));
    return { ...avatar, source, overlay };
  };
  return {
    forModel,
    forSession: (catalog, ref, model) => {
      const found = findModel(catalog, ref, model);
      return forModel(ref.providerId, found.key, found.resolvedId);
    },
  };
}

export interface AvatarChangeOptions {
  readonly prefs: Pick<PreferencesStore, 'getSnapshot' | 'subscribe'>;
  readonly store: Pick<AppStateStore, 'getSnapshot' | 'subscribe'>;
  readonly catalog: Pick<CatalogService, 'avatarsChanged'>;
  readonly sessions: Pick<SessionService, 'avatarsChanged'>;
  readonly presentation?: { changed(): void };
}

/**
 * Asks the models and the sessions again on a change of what they resolve by (C12). The catalog is
 * rebuilt only when the avatar section changed — an override, an active family — not at
 * each preference saved, such as a window's place. Answers the function that stops following.
 */
export function followAvatarChanges({ prefs, store, catalog, sessions, presentation }: AvatarChangeOptions): () => void {
  let assignmentsSeen = JSON.stringify(prefs.getSnapshot().values.avatars);
  let catalogSeen = store.getSnapshot().catalog;
  const stopPrefs = prefs.subscribe((snapshot) => {
    const assignments = JSON.stringify(snapshot.values.avatars);
    if (assignments === assignmentsSeen) return;
    assignmentsSeen = assignments;
    catalog.avatarsChanged();
    sessions.avatarsChanged();
    presentation?.changed();
  });
  const stopStore = store.subscribe((snapshot) => {
    if (snapshot.catalog === catalogSeen) return;
    catalogSeen = snapshot.catalog;
    // After this change has reached every listener: the sessions' own change follows it, in order.
    queueMicrotask(() => { sessions.avatarsChanged(); presentation?.changed(); });
  });
  return () => { stopPrefs(); stopStore(); };
}
