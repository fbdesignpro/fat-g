// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Avatar bindings use model identifiers already accepted by the preferences: either the CLI's
// key (which may follow a newer version), or its resolved model id (one specific version).
import type { AvatarRef } from './avatars';

export type AvatarAssignmentMode = 'key' | 'version';

export interface AvatarModelIdentity {
  readonly key: string;
  readonly resolvedId: string | null;
}

export function avatarAssignmentKey(model: AvatarModelIdentity, mode: AvatarAssignmentMode): string {
  return mode === 'version' ? model.resolvedId ?? model.key : model.key;
}

/** A specific version wins over the key's fallback. No assignment is changed by resolution. */
export function avatarAssignment(entries: Readonly<Record<string, AvatarRef>>, model: AvatarModelIdentity): { readonly key: string; readonly ref: AvatarRef } | null {
  const found = byModelIdentity(entries, model);
  return found === null ? null : { key: found.key, ref: found.value };
}

/** A model's entry of a record kept by model identifier: its resolved version id's before its key's. */
export function byModelIdentity<T>(entries: Readonly<Record<string, T>>, model: AvatarModelIdentity): { readonly key: string; readonly value: T } | null {
  for (const key of new Set([model.resolvedId, model.key])) {
    if (key !== null && Object.hasOwn(entries, key) && entries[key] !== undefined) return { key, value: entries[key] };
  }
  return null;
}
