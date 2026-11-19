// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useLayoutEffect, useRef } from 'react';
import { inPlan, isActive, notStarted, type SessionEntry } from '@shared/contracts/sessions';
import { useTabs } from '../artifacts/tabs-store';
import { useDetached } from '../chat/detached-store';
import type { ProjectView } from '../session-area/selected';
import { useAppState } from '../state/store';
import { closeNewSession, useNewSession } from './new-session-store';

export interface NewChatView {
  readonly project: ProjectView;
  /** The draft it shows: null while the `+` visit's is still being created. */
  readonly draftId: string | null;
  /** What the screen is keyed by: the `+` visit's serial, or the revisited draft's id. */
  readonly key: string;
}

/**
 * Which new-chat screen the session window shows, if any. The `+` visit's, from its press until it
 * ends; otherwise the selected session's while no turn of it has run (the maintainer):
 * a draft left with a prompt begun comes back to the same screen. A draft is shown as a chat once
 * its Send is accepted, once it takes part in a plan, and while an image or a plan of it is open
 * in a tab, which this screen has no pane for.
 */
export function useNewChatScreen(): NewChatView | null {
  const opening = useNewSession();
  const app = useAppState((state) => state.snapshot);
  const detached = useDetached((state) => state.shown);
  const selectedId = app?.sessions?.selectedId ?? null;
  const selected = app?.sessions?.sessions.find((session) => session.record.id === selectedId);
  const artifact = useTabs((state) => selectedId !== null && hasArtifact(state.sessions[selectedId]?.tabs));
  const projectOf = (id: string | null) => app?.records?.projects.find((entry): entry is ProjectView => entry.kind === 'project' && entry.id === id);

  if (opening.projectId !== null) {
    const project = projectOf(opening.projectId);
    return project === undefined ? null : { project, draftId: opening.sessionId, key: `visit-${opening.serial}` };
  }
  if (detached !== null || selected === undefined || artifact || !isFreshDraft(selected, opening.sent)) return null;
  const project = projectOf(selected.record.projectId);
  return project === undefined ? null : { project, draftId: selected.record.id, key: `draft-${selected.record.id}` };
}

/** The screen, and the `+` visit's end: screen lifetime is separate from draft lifetime. */
export function useNewChatLifecycle(): NewChatView | null {
  const opening = useNewSession();
  const app = useAppState((state) => state.snapshot);
  const detached = useDetached((state) => state.shown);
  const tabs = useTabs((state) => opening.sessionId === null ? undefined : state.sessions[opening.sessionId]);
  const seen = useRef<string | null>(null);
  const selectedId = app?.sessions?.selectedId ?? null;
  const project = app?.records?.projects.find((entry): entry is ProjectView => entry.kind === 'project' && entry.id === opening.projectId);
  const entry = app?.sessions?.sessions.find((session) => session.record.id === opening.sessionId);
  const artifact = hasArtifact(tabs?.tabs);

  useLayoutEffect(() => {
    if (opening.projectId === null) { seen.current = null; return; }
    if (opening.sessionId !== null && selectedId === opening.sessionId) seen.current = opening.sessionId;
    const left = opening.sessionId === null ? selectedId !== opening.previousId && !opening.creating
      : selectedId !== opening.sessionId && (seen.current === opening.sessionId || selectedId !== opening.previousId);
    if ((app?.records !== undefined && project === undefined) || detached !== null || left || artifact || (entry !== undefined && !isFreshDraft(entry, opening.sent))) closeNewSession();
  }, [opening, selectedId, project, app?.records, detached, artifact, entry]);

  return useNewChatScreen();
}

function hasArtifact(tabs: readonly { readonly kind: string }[] | undefined): boolean {
  return tabs?.some((tab) => tab.kind === 'image' || tab.kind === 'plan') === true;
}

function isFreshDraft(entry: SessionEntry, sent: ReadonlySet<string>): boolean {
  return notStarted(entry) && isActive(entry.record) && !inPlan(entry.summary) && entry.planPending !== true && !sent.has(entry.record.id);
}
