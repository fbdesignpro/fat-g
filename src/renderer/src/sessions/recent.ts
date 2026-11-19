// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The recent sessions (docs/planning/_archive/M100.md, Design 5; C93): which sessions were selected in this
// run, the latest first, for the switcher Ctrl+Tab opens (`SessionSwitcher`). The page's own and in
// memory: session ids alone, never saved and never sent to main — the selection itself is main's,
// and never saved either. A removed session's id is left here and drops out of every list made from
// it, since an id is never given again. A session marked Done is left here too and drops out the
// same way, so a turn that reopens it (C35) finds its place again.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ProjectEntryView } from '@shared/contracts/projects';
import { isActive, type SessionEntry } from '@shared/contracts/sessions';
import { useAppState } from '../state/store';
import { hasCapsule } from './unstarted';

export interface VisitedSessions {
  /** The latest first. */
  readonly ids: readonly string[];
}

export const useVisitedSessions = create<VisitedSessions>()(() => ({ ids: [] }));

/** A session was selected: it goes first. */
export function visitSession(id: string): void {
  useVisitedSessions.setState((state) => (state.ids[0] === id ? state : { ids: [id, ...state.ids.filter((other) => other !== id)] }));
}

/**
 * Watches the selection, for the window, however it was made — a capsule's press, the switcher, a
 * new session. Mounted once, by the switcher.
 */
export function useRecentTracking(): void {
  const selectedId = useAppState((state) => state.snapshot?.sessions?.selectedId ?? null);
  useEffect(() => {
    if (selectedId !== null) visitSession(selectedId);
  }, [selectedId]);
}

/**
 * The switcher's rows: the sessions visited in this run, the latest first; then the other active
 * sessions of the visible projects, the latest active first, so the list is of use from launch. A
 * session that draws no capsule is left out, as the session list leaves it out, and so is a completed
 * or shelved one, visited or not: Done and Shelve take a session out of the list (the maintainer),
 * and Unshelve or a turn that reopens it (C35) brings it back where it was. One of a
 * hidden project is in it only once visited.
 */
export function recentSessions(
  visited: readonly string[],
  sessions: readonly SessionEntry[],
  projects: readonly ProjectEntryView[],
  drafts: Readonly<Record<string, string>>,
): SessionEntry[] {
  const shown = sessions.filter((entry) => hasCapsule(entry, drafts[entry.record.id] ?? ''));
  const byId = new Map(shown.map((entry) => [entry.record.id, entry]));
  const first = visited.flatMap((id) => {
    const entry = byId.get(id);
    return entry === undefined || !isActive(entry.record) ? [] : [entry];
  });
  const taken = new Set(first.map((entry) => entry.record.id));
  const hidden = new Set(projects.flatMap((project) => (project.kind === 'project' && project.hidden ? [project.id] : [])));
  const rest = shown
    .filter((entry) => !taken.has(entry.record.id) && isActive(entry.record) && !hidden.has(entry.record.projectId))
    .sort((a, b) => b.record.lastActiveAt - a.record.lastActiveAt);
  return [...first, ...rest];
}
