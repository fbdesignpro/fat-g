// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CatalogState } from '@shared/contracts/catalog';
import { checkPreset, type ModelPreset, type OfferSnapshot, type PresetCheck, presetOffer } from '@shared/contracts/presets';

/** What admitting a preset reads: the project, the providers this build has, the catalog and the accounts. */
export interface PresetAdmissionDeps {
  readonly project: (projectId: string) => { readonly providers: readonly string[] } | undefined;
  readonly hasProvider: (providerId: string) => boolean;
  readonly catalog: () => CatalogState | undefined;
  readonly accounts: () => readonly OfferSnapshot[];
}

export type PresetAdmission = PresetCheck | { readonly ok: false; readonly reason: 'unknown-project' };

/**
 * Whether a session of the project may start on the preset (decision 0016, item 2): the check every
 * start takes — a new chat, a reviewer, a new session an integration makes. The project's providers
 * this build does not have are left out of its offer.
 */
export function admitPreset(deps: PresetAdmissionDeps, projectId: string, preset: ModelPreset): PresetAdmission {
  const project = deps.project(projectId);
  if (project === undefined) return { ok: false, reason: 'unknown-project' };
  const offered = project.providers.filter((id) => deps.hasProvider(id));
  return checkPreset(deps.catalog(), presetOffer(offered, deps.accounts()), preset);
}
