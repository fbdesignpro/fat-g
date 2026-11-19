// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the Avatars tab reads of the listing main gave it (M102, C63; M103, C20, C21, C24): an avatar as
// main would draw it, the avatar a reference names, a provider's default face, and the families it may
// take as its active one (decision 0031). The page resolves nothing that reaches a session or a model:
// main does (M103, C12). These only say what the tab shows: which model a family's search gives an
// avatar and by which entry, and how an avatar looks in its family's style (decision 0032), drawn
// with the texts of a model it suits.
import { avatarLayers, type ModelLabel, NO_LABEL, type OverlayLayer, resolveOverlay } from '@shared/contracts/avatar-overlay';
import { type AvatarFileView, type AvatarListing, type AvatarOrigin, type AvatarRef, type AvatarView, type FamilyRef, familySupports, type FamilyView, isDefaultFolder, type MatchEntryView, type ResolvedAvatar, strongestMatch } from '@shared/contracts/avatars';
import type { CatalogModel, CatalogProvider } from '@shared/contracts/catalog';

/** What an avatar of the listing draws: its usable portrait and small, as main would resolve it (M102, C10). */
export function resolvedOf(family: FamilyView, view: AvatarView): ResolvedAvatar | null {
  const portrait = view.files.find((file) => file.role === 'portrait');
  if (portrait === undefined) return null;
  return { ref: { origin: family.origin, family: family.folder, avatar: view.folder }, portrait: portrait.id, small: view.files.find((file) => file.role === 'small')?.id ?? null };
}

/** The avatar a reference names, with its family: of its origin's root, by the folders' names as listed (M103, C11). */
export function findInListing(listing: AvatarListing, ref: AvatarRef): { readonly family: FamilyView; readonly view: AvatarView } | undefined {
  const family = listing.roots.find((root) => root.origin === ref.origin)?.families.find((candidate) => candidate.folder === ref.family);
  const view = family?.avatars.find((candidate) => candidate.folder === ref.avatar);
  return family === undefined || view === undefined ? undefined : { family, view };
}

/** Whether both roots hold a family of this folder's name, so that its origin is named beside it (M102, C20). */
export function twinFamily(listing: AvatarListing, folder: string): boolean {
  return listing.roots.filter((root) => root.families.some((family) => family.folder === folder)).length > 1;
}

/**
 * A provider's built-in face as main finds it (M102, C30): the default of the first built-in family in
 * name order whose manifest names it the provider's starting family; none where none does.
 */
export function defaultFaceOf(listing: AvatarListing, providerId: string): { readonly family: FamilyView; readonly view: AvatarView } | undefined {
  const family = defaultFamilyOf(listing, providerId);
  return family === undefined ? undefined : fallbackOf(family);
}

/** The built-in family whose manifest names it the provider's starting family (decision 0031): its active family until the user chooses one. */
export function defaultFamilyOf(listing: AvatarListing, providerId: string): FamilyView | undefined {
  // A family with no default is no one's starting family: the next that names the provider is.
  return listing.roots.find((root) => root.origin === 'built-in')?.families.find((family) => family.defaultFor.includes(providerId) && usableFor(family, providerId));
}

/** Display order alone: the fallback comes last; the manifest and matching order stay untouched. */
export function avatarsForDisplay(family: Pick<FamilyView, 'avatars'>): readonly AvatarView[] {
  return [...family.avatars].sort((left, right) => Number(left.fallback || isDefaultFolder(left.folder)) - Number(right.fallback || isDefaultFolder(right.folder)));
}

/** A family's default (decision 0031): its `Default` folder, where it has a usable portrait — what a model nothing matches shows, for every provider. */
export function fallbackOf(family: FamilyView): { readonly family: FamilyView; readonly view: AvatarView } | undefined {
  const view = family.avatars.find((candidate) => candidate.fallback);
  return view === undefined ? undefined : { family, view };
}

/** Whether its provider scope fits and it has a default to draw, as main judges it (decision 0031). */
export function usableFor(family: FamilyView, providerId: string): boolean {
  return familySupports(family, providerId) && fallbackOf(family) !== undefined;
}

/** The families a provider may take as its active family: the built-in ones, then the user's, each by name. */
export function usableFamilies(listing: AvatarListing, providerId: string): FamilyView[] {
  return listing.roots.flatMap((root) => root.families.filter((family) => usableFor(family, providerId)));
}

/** A provider's active family as main finds it: the user's choice where listed and usable, else the default. */
export function activeFamilyOf(listing: AvatarListing, providerId: string, chosen: FamilyRef | undefined): FamilyView | undefined {
  const family = chosen === undefined ? undefined : listing.roots.find((root) => root.origin === chosen.origin)?.families.find((candidate) => candidate.folder === chosen.family);
  return family !== undefined && usableFor(family, providerId) ? family : defaultFamilyOf(listing, providerId);
}

/** A family as a select's value names it: `<origin>/<folder>`. */
export function familyKeyOf(family: { readonly origin: AvatarOrigin; readonly folder: string }): string {
  return `${family.origin}/${family.folder}`;
}

/** A select's value read back into a family reference; null for one of another form. */
export function parseFamilyKey(key: string): FamilyRef | null {
  const match = /^(built-in|user)\/(.{1,255})$/su.exec(key);
  return match === null ? null : { origin: match[1] as AvatarOrigin, family: match[2] as string };
}

/** The avatars a family's search goes through, as main's: those with a usable portrait, in its order. */
function searched(family: FamilyView): AvatarView[] {
  return family.avatars.filter((view) => resolvedOf(family, view) !== null);
}

/** The avatar a family's search gives a provider's model, and the entry that won; null where none matches. */
export function familyMatch(family: FamilyView, providerId: string, model: Pick<CatalogModel, 'key' | 'resolvedId'>): { readonly view: AvatarView; readonly entry: MatchEntryView } | null {
  if (!familySupports(family, providerId)) return null;
  const found = strongestMatch(searched(family), providerId, model);
  return found === null ? null : { view: found.avatar, entry: found.entry };
}

/**
 * Whether a family's search would give a provider's model a new avatar of these match entries, added
 * last to it (decision 0036): as `familyMatch` searches, the new avatar among those it goes through.
 */
export function newAvatarTakes(family: FamilyView, matches: readonly MatchEntryView[], providerId: string, model: Pick<CatalogModel, 'key' | 'resolvedId'>): boolean {
  if (!familySupports(family, providerId)) return false;
  const added = { matches };
  return strongestMatch<{ readonly matches: readonly MatchEntryView[] }>([...searched(family), added], providerId, model)?.avatar === added;
}

/**
 * The texts an avatar of a family is shown with in the tab: the label of the first model of the
 * catalog the family's search gives it; for its default, of the first model nothing matches; none
 * where it suits no model listed now.
 */
export function sampleLabel(family: FamilyView, view: AvatarView, providers: readonly CatalogProvider[]): ModelLabel {
  for (const provider of providers) {
    if (!familySupports(family, provider.id)) continue;
    for (const model of provider.models) if (familyMatch(family, provider.id, model)?.view === view) return model.label ?? NO_LABEL;
  }
  if (view.fallback) {
    for (const provider of providers) {
      if (!familySupports(family, provider.id)) continue;
      const model = provider.models.find((candidate) => familyMatch(family, provider.id, candidate) === null);
      if (model !== undefined) return model.label ?? NO_LABEL;
    }
  }
  return NO_LABEL;
}

/** An avatar of the listing drawn in a style: its family's layer and its own — the family default's fixed texts — or the ones given. */
export function styledOf(family: FamilyView, view: AvatarView, texts: ModelLabel, layers: readonly (OverlayLayer | undefined)[] = avatarLayers(family.overlay, view.overlay, view.fallback)): ResolvedAvatar | null {
  const resolved = resolvedOf(family, view);
  return resolved === null ? null : { ...resolved, overlay: resolveOverlay(layers, texts) };
}

/** A file's name as the tab shows it: its role and its format, as the convention names it. */
export function fileName(file: AvatarFileView): string {
  return `${file.role}.${file.format}`;
}
