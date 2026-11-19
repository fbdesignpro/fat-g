// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which mode a chat has, and whether its account can use it (docs/planning/_archive/M22.md, Design 2; C1,
// C40, C43, C44; decision 0027): the one place the hierarchy is resolved. A chat's saved mode stands
// as it is; with none saved, the project's default for its provider, else the user's, else the
// provider's fallback. Nothing substitutes for a choice: one its account cannot use is still the
// chat's mode, and blocks Send until the user chooses another.
//
// Pure, and it names no provider: the descriptors' declarations, the two defaults and what each
// account's facet says of its modes are handed in. It reads no file and holds nothing — the user's
// default is the preferences', the project's the records', the chat's own the conversation store's.
import type { InstanceRef } from '@shared/contracts/instances';
import { availabilityOf, type ChatMode, type ModeAvailability, modeOf, type PermissionCapability, type PermissionMode, resolveMode } from '@shared/contracts/permissions';

export interface PermissionsOptions {
  /** A provider's declared modes: its descriptor's word, or null for one that declares none. */
  readonly capability: (providerId: string) => PermissionCapability | null;
  /** The user's default mode for a provider (M22, C40): the preferences', or null for none chosen. */
  readonly userDefault: (providerId: string) => string | null;
  /** A project's default mode for a provider: its record's, or null — Use my default. */
  readonly projectDefault: (projectId: string, providerId: string) => string | null;
  /** What an account can use of its provider's modes, as its facet says now; undefined while it has no runtime, or says nothing yet. */
  readonly availability: (ref: InstanceRef) => readonly ModeAvailability[] | undefined;
}

/** What the hierarchy reads of a session: its provider, its account and its project. */
export interface ChatOwner {
  readonly providerId: string;
  readonly instanceId: string;
  readonly projectId: string;
}

export interface Permissions {
  /** A provider's declared modes, or null. */
  capability(providerId: string): PermissionCapability | null;
  /** The mode a provider lists under an id. */
  listed(providerId: string, mode: string): PermissionMode | undefined;
  /**
   * The chat's mode (C1): its saved one as it stands, with the source it was saved with; else what
   * the defaults give at this moment, which is what a new chat snapshots (C40). Null for a provider
   * that declares no mode.
   */
  resolve(owner: ChatOwner, saved: ChatMode | null): ChatMode | null;
  /**
   * Whether an account can use a mode now, and why not (C43). An id its provider does not list —
   * a saved one from a list that has since changed — is unavailable, as one no capture shows.
   */
  availability(ref: InstanceRef, mode: string): ModeAvailability;
}

export function createPermissions(options: PermissionsOptions): Permissions {
  const availability = (ref: InstanceRef, mode: string): ModeAvailability => {
    if (modeOf(options.capability(ref.providerId), mode) === undefined) return { id: mode, available: false, reason: 'unvalidated', setup: false, records: false, unconfined: false, places: null };
    return availabilityOf(options.availability(ref), mode);
  };
  return {
    capability: (providerId) => options.capability(providerId),
    listed: (providerId, mode) => modeOf(options.capability(providerId), mode),
    resolve(owner, saved) {
      const capability = options.capability(owner.providerId);
      if (capability === null || capability.modes.length === 0) return null;
      // A saved choice stands, whatever has become of the lists since (C43): never a silent substitution.
      if (saved !== null) return saved;
      const ref: InstanceRef = { providerId: owner.providerId, instanceId: owner.instanceId };
      return resolveMode(capability, { saved: null, project: options.projectDefault(owner.projectId, owner.providerId), user: options.userDefault(owner.providerId) }, (id) => availability(ref, id).available);
    },
    availability,
  };
}
