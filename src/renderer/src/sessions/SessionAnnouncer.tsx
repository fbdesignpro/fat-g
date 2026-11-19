// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from 'react';
import { attentionWords, sessionDisplayName } from '@shared/contracts/sessions';
import { useAppState } from '../state/store';
import { announce } from '../ui/Announcer';

/**
 * Says a change of attention to a screen reader, politely and once (M14, C52): "Calamari, Create
 * plan: 3 Questions". Mounted once in the Main window (App.tsx); it draws nothing. It compares each
 * session's attention kind and count with the last snapshot's, so being acknowledged — which changes
 * neither — is not said again, and the first snapshot announces nothing.
 *
 * A question of the selected session is left to the chat's own status region (M21, C64, C74), which
 * posts it in words as it is raised — the session's own and a worker's alike: said here too, it
 * would be read twice. Another session's question is announced as any attention is.
 *
 * An approval of the selected session is left to that region the same way (M22, C36), which posts
 * what it asks leave for; another session's is announced here, "1 Approval".
 *
 * And a plan of the selected session (M22b, C27, C50), which the list's own status line announces
 * once; another session's is announced here, "plan ready". A plan ready in several chats at once is
 * one plan (decision 0029): said once, naming each of them. What a chat waits on while another holds
 * its plan is no attention, and is not said.
 */
export function SessionAnnouncer() {
  const sessions = useAppState((state) => state.snapshot?.sessions);
  const projects = useAppState((state) => state.snapshot?.records?.projects);
  const last = useRef<ReadonlyMap<string, string> | null>(null);

  useEffect(() => {
    if (sessions === undefined) return;
    const next = new Map(sessions.sessions.map(({ record, summary }) => [record.id, summary.attention === null ? '' : `${summary.attention.kind}:${summary.attention.count}`]));
    const previous = last.current;
    last.current = next;
    if (previous === null) return;
    const changes: string[] = [];
    const ready: string[] = [];
    for (const { record, summary } of sessions.sessions) {
      if (summary.attention === null || next.get(record.id) === previous.get(record.id)) continue;
      // The shown chat says these itself: its card, its panel, or its review's arrival (M22e, C21).
      if ((summary.attention.kind === 'question' || summary.attention.kind === 'approval' || summary.attention.kind === 'plan' || summary.attention.kind === 'review') && record.id === sessions.selectedId) continue;
      const project = projects?.find((entry) => entry.kind === 'project' && entry.id === record.projectId);
      const projectName = project?.kind === 'project' ? `${project.name}, ` : '';
      const who = `${projectName}${sessionDisplayName(record)}`;
      if (summary.attention.kind === 'plan') ready.push(who);
      else changes.push(`${who}: ${attentionWords(summary.attention)}`);
    }
    if (ready.length > 0) changes.push(`${ready.join('; ')}: ${attentionWords({ kind: 'plan', count: 1 })}`);
    if (changes.length > 0) announce(changes.join('. '));
  }, [sessions, projects]);

  return null;
}
