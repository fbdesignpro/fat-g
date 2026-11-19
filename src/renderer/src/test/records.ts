// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Records for renderer tests: projects in the view's shape, and app state that carries them.
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { ProjectEntryView, RecordsState, RecordsStatus } from '@shared/contracts/projects';
import { sampleSnapshot } from '../../../../tests/support/app-state';

type Project = Extract<ProjectEntryView, { kind: 'project' }>;

/** A project whose key and id are the same made-up UUID, derived from its name. */
export function project(name: string, overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? uuidFor(name);
  return {
    kind: 'project',
    key: id,
    id,
    name,
    color: 'teal',
    hidden: false,
    collapsed: false,
    providers: ['claude'],
    roots: [{ path: `D:\\Code\\${name}`, trust: 'trusted', missing: false }],
    sessions: 0,
    permissionModes: {},
    ...overrides,
  };
}

export function unreadable(label: string, sessions = 0): ProjectEntryView {
  return { kind: 'unreadable', key: uuidFor(`unreadable:${label}`), sessions };
}

export function uuidFor(text: string): string {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${hex.padStart(12, '0')}`;
}

export function recordsState(projects: readonly ProjectEntryView[], status: RecordsStatus = { kind: 'ok', keptAs: null }): RecordsState {
  return { status, projects };
}

/** App state for the Main window, with these records. `seq` must grow for a window to take it. */
export function withRecords(records: RecordsState, seq = 1): AppStateSnapshot {
  return { ...sampleSnapshot(seq), records };
}
