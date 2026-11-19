// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Modes for the renderer's tests (M22): a provider's declaration in the contract's shape, an
// account's availability, and sessions that have a mode. The words are made up for the tests: the
// page holds no mode table, so whatever a test reads of a mode it reads from here, through the
// descriptor, as it would from a real provider's.
import type { ChatMode, ModeAvailability, PermissionCapability, PermissionMode } from '@shared/contracts/permissions';
import type { SendBlock, SessionEntry, SessionSummary, SessionView } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { sampleDescriptor, sampleProvider } from '../../../../tests/support/app-state';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';

const mode = (id: string, label: string, description: string, patch: Partial<PermissionMode> = {}): PermissionMode => ({ id, label, description, asks: true, reading: false, transitionsFrom: [], ...patch });

/**
 * Five modes, as a provider would declare them: a reading one, two that reach one another with no
 * restart, one that needs a setup, and one where nothing asks. Ask first is the fallback.
 */
export const MODES: PermissionCapability = {
  modes: [
    mode('read-only', 'Read only', 'Reads files and runs nothing that changes them; every request is refused', { asks: false, reading: true }),
    mode('ask-first', 'Ask first', 'Each command and each file change asks before it runs', { transitionsFrom: ['edits-ok'] }),
    mode('edits-ok', 'Edits ok', 'File changes run without asking; other commands ask', { transitionsFrom: ['ask-first'] }),
    mode('sandbox-ok', 'Sandbox ok', 'Changes in the project’s folder run without asking'),
    mode('berserk', 'Berserk', 'Everything runs without asking: the CLI’s Full access', { asks: false }),
  ],
  fallback: 'ask-first',
  setup: {
    changes: 'By its vendor’s own description, the CLI’s setup creates dedicated sandbox user accounts on this machine, and changes firewall rules and file permissions.',
    approval: 'The system will ask for an administrator’s approval by itself.',
    waiting: 'The system may be asking for your approval.',
  },
  inherited: 'Rules of your own configuration act as it lets them, with no card here',
  rules: 'The CLI’s own rules are not listed by this version',
};

/** What an account can do with a mode: usable, with nothing more known, unless said. */
export function availability(id: string, patch: Partial<ModeAvailability> = {}): ModeAvailability {
  return { id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null, ...patch };
}

/** A provider's account whose descriptor declares modes: the sample provider, with `MODES` unless said. */
export function modedProvider(overrides: Partial<ProviderSnapshot> = {}, capability: PermissionCapability | null = MODES): ProviderSnapshot {
  const id = overrides.id ?? 'claude';
  const displayName = overrides.displayName ?? 'Claude';
  const descriptor = sampleDescriptor({ id, displayName });
  return sampleProvider({ ...overrides, id, displayName, descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, permissions: capability } } });
}

/**
 * A session with a mode: its chat's saved one and where it came from, and — `confirmed` — the mode
 * its live process confirmed, which is none unless said.
 */
export function modedEntry(name: string, saved: ChatMode, options: { readonly summary?: SessionSummary; readonly confirmed?: string | null; readonly record?: Partial<SessionView>; readonly block?: SendBlock | null; readonly changingMode?: boolean } = {}): SessionEntry {
  const entry = sessionEntry(name, options.summary ?? SUMMARIES.idle, options.record);
  return { ...entry, summary: { ...entry.summary, mode: options.confirmed ?? null }, block: options.block ?? null, mode: saved, changingMode: options.changingMode ?? false };
}
