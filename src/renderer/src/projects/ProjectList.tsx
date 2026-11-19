// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { REMOVE_CHAT_TEXT } from '@shared/contracts/chat';
import type { ProjectEntryView, ProjectRefusal, ProjectSaved, RecordsState } from '@shared/contracts/projects';
import type { SessionEntry } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { DetachedRow } from '../sessions/DetachedRow';
import { OrphanRow } from '../sessions/OrphanRow';
import { SessionList } from '../sessions/SessionList';
import type { MeasureCapsules } from '../sessions/useCapsuleDrag';
import { useAppState } from '../state/store';
import { announce } from '../ui/Announcer';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { NoticeDialog } from '../ui/NoticeDialog';
import { HiddenRow } from './HiddenRow';
import { clearAdded, openProjectDialog, useProjectDialog } from './project-dialog-store';
import { ProjectHeader } from './ProjectHeader';
import styles from './Projects.module.css';
import { KeptNote, RecordsNote } from './RecordsNote';
import { applyMove, groupOf, HIDDEN_ROW, positionText, stepMove } from './reorder';
import { type MeasureList, measureList, useProjectDrag } from './useProjectDrag';

export const FAILED_TEXT = 'fat-g could not save the change, and nothing was changed.';

export interface ProjectListProps {
  /** The project column, which scrolls: a drag near its edges scrolls it, and a menu closes with it. */
  readonly column: RefObject<HTMLElement | null>;
  /** How the list learns its geometry; tests replace it, as jsdom computes no layout. */
  readonly measure?: MeasureList;
  /** The same for a project's capsules (M14). */
  readonly measureCapsules?: MeasureCapsules;
}

/**
 * The project list (docs/planning/_archive/M12.md, Design 8), on the grid with gaps between projects
 * (docs/planning/_archive/M100.md, Design 5; C21). With the records refused, only the note (C50); otherwise
 * the visible projects in stored order, the hidden row when any is hidden, and the hidden list when
 * it is open (C47). Add project stands in the top band, over the list (M100, C20). Nothing shows
 * before the first state arrives.
 *
 * Since M14 each project's sessions are listed under its header, in the hidden list too, and a dim
 * row at the foot counts the session entries left without a project (M14, C37, C107). Since M18 a
 * second one counts the saved chats no listed session has (M18, C31) — under the note too: with
 * the records refused no session is listed, and every saved chat is one.
 */
export function ProjectList({ column, measure = measureList, measureCapsules }: ProjectListProps) {
  const records = useAppState((state) => state.snapshot?.records);
  if (records === undefined) return null;
  if (records.status.kind === 'refused') {
    return (
      <>
        <RecordsNote cause={records.status.cause} />
        <DetachedRow />
      </>
    );
  }
  return <Projects records={records} keptAs={records.status.keptAs} column={column} measure={measure} measureCapsules={measureCapsules} />;
}

interface PendingMove {
  /** The state the move was made against: a newer one replaces it. */
  readonly base: RecordsState;
  readonly key: string;
  readonly hidden: boolean;
  readonly before: string | null;
}

const NO_SESSIONS: readonly SessionEntry[] = [];

/** "Its 3 sessions go with it." — counted as main matches them, on an unreadable project's row too (M14, C13, C57). */
export function sessionsGoText(count: number): string {
  if (count === 0) return '';
  return count === 1 ? ' Its 1 session goes with it.' : ` Its ${count} sessions go with it.`;
}

function Projects({ records, keptAs, column, measure, measureCapsules }: {
  records: RecordsState;
  keptAs: string | null;
  column: RefObject<HTMLElement | null>;
  measure: MeasureList;
  measureCapsules: MeasureCapsules | undefined;
}) {
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [removing, setRemoving] = useState<ProjectEntryView | null>(null);
  /** Said in place of Remove's confirmation: one of the project's sessions runs (M14, C96). */
  const [running, setRunning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  const added = useProjectDialog((state) => state.added);
  const sessions = useAppState((state) => state.snapshot?.sessions);
  const providers = useAppState((state) => state.snapshot?.providers);
  // A removal takes the saved chats with it (M18, C21): while the conversation store is refused it
  // could not reach them, so no Remove is offered — a project's, or the orphan row's (C42).
  const removable = useAppState((state) => state.snapshot?.conversations?.status.kind !== 'refused');

  // Each project's sessions, in stored order. The same lists until the sessions change, so a capsule
  // dropped at a new place stays there until they do.
  const byProject = useMemo(() => {
    const grouped = new Map<string, SessionEntry[]>();
    for (const entry of sessions?.sessions ?? []) grouped.set(entry.record.projectId, [...(grouped.get(entry.record.projectId) ?? []), entry]);
    return grouped;
  }, [sessions?.sessions]);
  const providerName = (id: string): string => providers?.find((provider) => provider.id === id)?.displayName ?? id;

  // A dropped header stays where it was dropped until the new state arrives, so it never jumps back.
  const moving = pending !== null && pending.base === records;
  const entries = moving ? applyMove(records.projects, pending.key, pending.hidden, pending.before) : records.projects;
  const visible = entries.filter((entry) => groupOf(entry) === 'visible');
  const hidden = entries.filter((entry) => groupOf(entry) === 'hidden');

  /** Runs one change; anything but saved says so at the list's top. */
  async function change(request: () => Promise<ProjectSaved | ProjectRefusal>): Promise<boolean> {
    try {
      const saved = (await request()).status === 'saved';
      setFailed(!saved);
      return saved;
    } catch {
      setFailed(true);
      return false;
    }
  }

  function move(key: string, toHidden: boolean, before: string | null, spoken: boolean): void {
    const after = applyMove(entries, key, toHidden, before);
    setPending({ base: records, key, hidden: toHidden, before });
    void change(() => invoke('projects:move', { id: key, hidden: toHidden, before })).then((saved) => {
      if (!saved) {
        setPending(null);
        return;
      }
      const text = spoken ? positionText(after, key) : null;
      if (text !== null) announce(text);
    });
  }

  const { drag, onPointerDown, wasDragged } = useProjectDrag({
    list,
    column,
    measure,
    entries,
    hiddenOpen,
    firstHidden: hidden[0]?.key ?? null,
    onDrop: (key, toHidden, before) => move(key, toHidden, before, false),
  });

  // The keyboard move keeps the focus on the moved project, even when the list moved its element:
  // while the move is shown ahead of the state, and once more when the state arrives. Then it stops.
  useLayoutEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    const button = list.current?.querySelector<HTMLElement>(`[data-actions-for="${key}"]`);
    if (button !== null && button !== undefined && document.activeElement !== button) button.focus();
    if (!moving) refocus.current = null;
  });

  // A new project goes at the end; once the state holds it, the column brings it into view (C49).
  useEffect(() => {
    if (added === null) return;
    const header = list.current?.querySelector(`[data-entry-key="${added}"]`);
    if (header === null || header === undefined) return;
    header.scrollIntoView?.({ block: 'nearest' });
    clearAdded();
  }, [added, entries]);

  const nameOf = (entry: ProjectEntryView): string => (entry.kind === 'project' ? entry.name : 'this unreadable project');
  const runs = (entry: ProjectEntryView): boolean => entry.kind === 'project' && (byProject.get(entry.id) ?? NO_SESSIONS).some((session) => session.summary.status === 'running');

  const header = (entry: ProjectEntryView) => (
    <ProjectHeader
      key={entry.key}
      entry={entry}
      column={column}
      lifted={drag?.key === entry.key}
      shift={drag?.room.shifts.get(entry.key) ?? 0}
      onPointerDown={onPointerDown}
      wasDragged={wasDragged}
      onToggleCollapsed={() => entry.kind === 'project'
        ? change(() => invoke('projects:setCollapsed', { id: entry.id, collapsed: !entry.collapsed }))
        : Promise.resolve(false)}
      onEdit={() => {
        if (entry.kind === 'project') openProjectDialog(entry.id);
      }}
      onToggleHidden={() => {
        if (entry.kind === 'project') void change(() => invoke('projects:setHidden', { id: entry.id, hidden: !entry.hidden }));
      }}
      onRemove={removable ? () => {
        // While one of its sessions runs, the refusal is said in place of the question (M14, C96).
        if (runs(entry)) setRunning(nameOf(entry));
        else setRemoving(entry);
      } : null}
      onStep={(direction) => {
        const step = stepMove(entries, entry.key, direction);
        if (step === null) return;
        refocus.current = entry.key;
        move(entry.key, step.hidden, step.before, true);
      }}
    >
      {entry.kind === 'project' && (
        <SessionList
          projectName={entry.name}
          sessions={byProject.get(entry.id) ?? NO_SESSIONS}
          selectedId={sessions?.selectedId ?? null}
          providerName={providerName}
          column={column}
          {...(measureCapsules === undefined ? {} : { measure: measureCapsules })}
        />
      )}
    </ProjectHeader>
  );

  const remove = async (): Promise<void> => {
    if (removing === null) return;
    setBusy(true);
    try {
      const answer = await invoke('projects:remove', { key: removing.key });
      // Main refuses a removal while a session runs, whatever the page showed (M14, C96).
      const sessionRuns = answer.status === 'refused' && answer.reason === 'session-running';
      if (sessionRuns) setRunning(nameOf(removing));
      setFailed(answer.status !== 'saved' && !sessionRuns);
    } catch {
      setFailed(true);
    }
    setBusy(false);
    setRemoving(null);
  };

  const dragged = drag === null ? undefined : entries.find((entry) => entry.key === drag.key);

  return (
    <div className={styles.projects}>
      {failed && (
        <p className={styles.problem} role="status">
          {FAILED_TEXT}
        </p>
      )}
      {keptAs !== null && <KeptNote path={keptAs} />}
      <div ref={list} className={styles.list} data-dragging={drag !== null || undefined}>
        {visible.length > 0 && (
          <ul className={styles.group} aria-label="Visible projects">
            {visible.map(header)}
          </ul>
        )}
        {(hidden.length > 0 || drag !== null) && (
          <HiddenRow
            count={hidden.length}
            open={hiddenOpen}
            onToggle={() => setHiddenOpen((open) => !open)}
            target={drag?.target.row === true}
            shift={drag?.room.shifts.get(HIDDEN_ROW) ?? 0}
          />
        )}
        {hiddenOpen && hidden.length > 0 && (
          <ul className={styles.group} aria-label="Hidden projects">
            {hidden.map(header)}
          </ul>
        )}
        {/* Where the project will land: the room the others made, outlined (C86). */}
        {drag?.room.gap != null && (
          <div className={styles.gap} style={{ top: drag.room.gap.top, height: drag.room.gap.bottom - drag.room.gap.top }} data-gap="" aria-hidden="true" />
        )}
      </div>
      {/* Session entries no project's removal reaches (M14, C107). */}
      <OrphanRow count={sessions?.orphans ?? 0} removable={removable} />
      {/* Saved chats no listed session has (M18, C31). */}
      <DetachedRow />
      {drag !== null && dragged?.kind === 'project' && (
        <div className={styles.lifted} style={{ top: drag.top, left: drag.left, width: drag.width }} data-color={dragged.color ?? 'grey'} aria-hidden="true">
          <span className={styles.name}>{dragged.name}</span>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing === null ? 'this project' : nameOf(removing)}?`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      >
        {(removing?.sessions ?? 0) === 0 ? (
          <p>fat-g forgets this project. Nothing in its folders, and nothing in the providers’ history, is touched.</p>
        ) : (
          <>
            <p>fat-g forgets this project.{sessionsGoText(removing?.sessions ?? 0)} Nothing in its folders is touched.</p>
            <p>{REMOVE_CHAT_TEXT.project}</p>
          </>
        )}
      </ConfirmDialog>
      <NoticeDialog open={running !== null} title={`A session of ${running ?? 'this project'} is running`} onClose={() => setRunning(null)}>
        <p>A project cannot be removed while one of its chats or its sub-agents is still working. Try again once they have finished.</p>
      </NoticeDialog>
    </div>
  );
}
