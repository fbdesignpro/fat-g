// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The avatar section as the preferences file holds it (docs/planning/_archive/M103.md, Design 2; C3,
// C5, C6; decision 0031): what the read pass keeps of it, and what a patch does to it. Pure,
// over plain JSON.
//
// The read pass keeps, of the registered providers alone, each override whose key is a catalog id and
// whose value is a reference of the form, and each active family that is a family reference. One
// avatar may be the override of several models. An `overlay` an older revision held is no longer
// read (revision 15; decision 0032). It reads and rewrites nothing: what it passed over stays in the file, unreported (C5).
//
// A patch sets each entry it names or, null, removes it, in the one write; unregistered providers,
// keys that are no catalog id, malformed values and unknown fields are left as they are.
import { type ActiveFamilies, type Assignments, type AvatarRef, isAvatarRef, isFamilyRef, sameRef } from '@shared/contracts/avatars';
import { catalogId } from '@shared/contracts/catalog';
import type { PreferencesPatch } from '@shared/contracts/prefs';
import { plainObject as plain } from '../storage/envelope';
import type { RawDocument } from './compatibility';

/** The section's kept overrides, of the registered providers in `providerIds`' order (C5). */
export function readRawAssignments(section: unknown, providerIds: readonly string[]): Assignments {
  const assignments = plain(section) ? section['assignments'] : undefined;
  if (!plain(assignments)) return {};
  const result: Record<string, Record<string, AvatarRef>> = {};
  for (const providerId of providerIds) {
    const entries = assignments[providerId];
    if (!plain(entries)) continue;
    for (const key of Object.keys(entries).sort()) {
      const value = entries[key];
      if (catalogId(key) === null || !isAvatarRef(value)) continue;
      (result[providerId] ??= {})[key] = { origin: value.origin, family: value.family, avatar: value.avatar };
    }
  }
  return result;
}

/** The section as the normalized values read it: the overrides and the active families of registered providers. */
export function readRawAvatars(section: unknown, providerIds: readonly string[]): { readonly assignments: Assignments; readonly active: ActiveFamilies } {
  const own = plain(section) ? section : {};
  const active = plain(own['active']) ? own['active'] : {};
  return {
    assignments: readRawAssignments(section, providerIds),
    active: Object.fromEntries(providerIds.flatMap((id) => (isFamilyRef(active[id]) ? [[id, active[id]]] : []))),
  };
}

/** A patch's avatar section in the retained document: each entry it names set or removed (C6). */
export function settleRawAvatars(raw: RawDocument, patch: PreferencesPatch['avatars']): RawDocument {
  if (patch === undefined) return raw;
  const next = structuredClone(raw);
  const section: RawDocument = plain(next['avatars']) ? next['avatars'] : {};
  for (const [providerId, entries] of Object.entries(patch.assignments ?? {})) {
    for (const [key, reference] of Object.entries(entries)) settleEntry(section, ['assignments', providerId], key, reference === null ? null : { origin: reference.origin, family: reference.family, avatar: reference.avatar }, sameReference);
  }
  for (const [providerId, family] of Object.entries(patch.active ?? {})) settleEntry(section, ['active'], providerId, family === null ? null : { origin: family.origin, family: family.family });
  next['avatars'] = section;
  return next;
}

/**
 * One entry under `path` in the section set to `value` or, null, removed; an entry already holding an
 * equal value keeps it as written, so the same patch again changes nothing.
 */
function settleEntry(section: RawDocument, path: readonly string[], key: string, value: unknown, same: (a: unknown, b: unknown) => boolean = sameJson): void {
  let parent = section;
  for (const name of path) {
    const child = parent[name];
    if (!plain(child)) {
      if (value === null) return;
      parent[name] = {};
    }
    parent = parent[name] as RawDocument;
  }
  if (value === null) {
    delete parent[key];
    return;
  }
  if (!same(parent[key], value)) parent[key] = value;
}

function sameReference(a: unknown, b: unknown): boolean {
  return isAvatarRef(a) && isAvatarRef(b) && sameRef(a, b);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
