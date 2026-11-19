// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { REMOVE_CHAT_TEXT } from '@shared/contracts/chat';
import type { SessionFlag } from '@shared/contracts/session-flags';
import { COMPLETED_STEP, type RunningDoing, type SessionEntry, sessionLabel, sessionParts, type SessionRefusal, type SessionSaved } from '@shared/contracts/sessions';
import { sessionOrderGroup } from '@shared/contracts/session-order';
import { useChatDrafts } from '../chat/chat-store';
import { showDetached } from '../chat/detached-store';
import { focusPrompt } from '../chat/prompt-focus';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { announce } from '../ui/Announcer';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { NoticeDialog } from '../ui/NoticeDialog';
import { applyCapsuleMove, arrangeMoves, capsulePositionText, capsuleStep, groupIds, heldOrder, isOwnCapsulePlace } from './capsule-reorder';
import { Capsule } from './Capsule';
import { type HeldPlace, withHeldSlots } from './held-slots';
import { completeWithFlash, type Leaving, useLeaving } from './leaving';
import styles from './Sessions.module.css';
import { ThinCapsule } from './ThinCapsule';
import { ToggleRow } from './ToggleRow';
import { selectSession } from './select';
import { hasCapsule } from './unstarted';
import { type MeasureCapsules, measureCapsules, useCapsuleDrag } from './useCapsuleDrag';

export const SESSION_FAILED_TEXT = 'fat-g could not save the change, and nothing was changed.';

/** What a running chat is doing, as a refusal because it runs says it (M22e; the maintainer's V6 review). */
const DOING_WORDS: Readonly<Record<RunningDoing, string>> = {
  review: 'it is writing its review of a plan',
  integration: 'it is evaluating a review’s feedback on its plan',
  plan: 'it is writing a plan',
  revision: 'it is revising its plan from your feedback',
  execution: 'it is carrying out a plan',
  workers: 'its sub-agents are still running',
  turn: 'it is still working on a reply',
};

/** What a running session cannot be: the list's notice, and the line under Done and Shelve (M14, C96; M100, C50). */
export type RunningAction = 'removed' | 'completed' | 'shelved';

/** Why a running session was not removed, completed or shelved (M14, C96): the list's notice, and the corner's line (M100, C50). */
export function runningNoticeText(action: RunningAction, doing: RunningDoing = 'turn'): string {
  return `A chat cannot be ${action} while ${DOING_WORDS[doing]}. Wait until it finishes, or stop it, then try again.`;
}

export interface SessionListProps {
  readonly projectName: string;
  /** This project's sessions, in stored order (C11). */
  readonly sessions: readonly SessionEntry[];
  readonly selectedId: string | null;
  /** What a provider is called, for the Remove confirmation. */
  readonly providerName: (providerId: string) => string;
  /** The project column, which scrolls. */
  readonly column: RefObject<HTMLElement | null>;
  /** How the list learns its geometry; tests replace it, as jsdom computes no layout. */
  readonly measure?: MeasureCapsules;
}

interface PendingMove {
  /** The sessions the move was made against: a newer list replaces it. */
  readonly base: readonly SessionEntry[];
  readonly id: string;
  readonly before: string | null;
}

/**
 * One project's sessions, below its header (M14, Design 9; C37–C50): the active capsules; the shelf —
 * the shelved sessions; the toggle row; the completed ones, five at a time. In each part the starred
 * stand first. A part with no session is left out, and a project with none shows
 * its header alone. Which sessions go where is `sessionParts`' to say (src/shared/contracts/sessions.ts):
 * this only renders what it returns.
 *
 * A capsule whose menu is open keeps its place while it is, so its flags can be set one after the
 * other in one opening: it is placed by the star it had when the menu opened, and drawn with the
 * flags it has. It goes where its star puts it when the menu closes — the focus with it, when it was
 * on the menu's button, or on the toggle row's half of its part, when that part no longer shows it.
 *
 * Choosing a session, or working in one, puts it first in its group (decision 0011, item 12). After a
 * press on a capsule the list holds its order until the pointer leaves it, so nothing moves under
 * the pointer; a move made meanwhile places the capsule among the capsules as shown.
 *
 * Both folds and the count shown are component state at every launch (C47, C48): both folds closed
 * (M100, C88, C94), and five.
 *
 * A session marked done from the page leaves a slot of its capsule's height where it was, under the
 * Done flash (leaving.ts), until the flash has faded, or Clean up done has ended and its flash has
 * faded, and the slot closes, the rows below sliding up. Until then the session is left out of the
 * parts, so the toggle row, the completed ones and their count wait for it, and a list that has only
 * slots left is still drawn.
 *
 * A session no turn has run shows no capsule while there is nothing to show for it — nothing typed
 * in its composer and no name (M26, round 2) — and it is left out before the parts are worked out,
 * so the drag and Alt+Up and Alt+Down never count a capsule that is not there. Leaving such a
 * session removes it (`unstarted.ts`), so none of them is hidden for long.
 */
export function SessionList({ projectName, sessions, selectedId, providerName, column, measure = measureCapsules }: SessionListProps) {
  const [shown, setShown] = useState(COMPLETED_STEP);
  const [shelfOpen, setShelfOpen] = useState(false);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [removing, setRemoving] = useState<SessionEntry | null>(null);
  const [busy, setBusy] = useState(false);
  /** Said in place of a confirmation, or after a refusal: the session runs (C96). */
  const [runningNotice, setRunningNotice] = useState<{ readonly name: string; readonly action: RunningAction; readonly doing?: RunningDoing | undefined } | null>(null);
  /** The capsule whose menu is open, and the star it had when it opened: where it stays until the menu closes. */
  const [held, setHeld] = useState<{ readonly id: string; readonly starred: boolean } | null>(null);
  /** The order shown when a capsule was pressed, kept until the pointer leaves the list. */
  const [hold, setHold] = useState<readonly string[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const menuRefocus = useRef<string | null>(null);
  // A draft per session, the page's own (chat-store.ts): the object changes only when one does.
  const drafts = useChatDrafts((state) => state.drafts);
  const active = useRef<HTMLUListElement>(null);
  const shelf = useRef<HTMLUListElement>(null);
  const completed = useRef<HTMLUListElement>(null);
  const refocus = useRef<string | null>(null);
  // A removal takes the session's saved chat with it (M18, C21): while the conversation store is
  // refused it could not reach it, so Remove is not offered (C42). Main refuses it too.
  const removable = useAppState((state) => state.snapshot?.conversations?.status.kind !== 'refused');
  const leaving = useLeaving((state) => state.leaving);

  // Nothing to show for it yet: its chat is open, and its capsule comes with its first keystroke.
  const listed = sessions.filter((entry) => hasCapsule(entry, drafts[entry.record.id] ?? ''));
  // A dropped capsule stays where it was dropped until the new state arrives, so it never jumps back.
  const moving = pending !== null && pending.base === sessions;
  const stored = moving ? applyCapsuleMove(listed, pending.id, pending.before) : listed;
  const ordered = hold === null ? stored : heldOrder(stored, hold);
  // The held capsule placed by its star of then, and every capsule drawn as it is now.
  const placed = held === null ? ordered : ordered.map((entry) => (entry.record.id === held.id && entry.record.starred !== held.starred ? { ...entry, record: { ...entry.record, starred: held.starred } } : entry));
  // A leaving session's slot holds its place under the flash.
  const slotted = (id: string): Leaving | undefined => {
    const entry = leaving[id];
    return entry?.slot != null ? entry : undefined;
  };
  const parts = sessionParts(placed.filter((entry) => slotted(entry.record.id) === undefined), shown);
  // This project's leaving sessions, each in the list it left.
  const places = (list: 'active' | 'shelf'): readonly HeldPlace[] => sessions.flatMap(({ record: { id } }) => {
    const slot = slotted(id)?.slot;
    return slot?.list === list ? [{ id, after: slot.after }] : [];
  });
  const activeIds = withHeldSlots(parts.active.map((entry) => entry.record.id), places('active'));
  const shelfIds = shelfOpen ? withHeldSlots(parts.shelf.map((entry) => entry.record.id), places('shelf')) : [];
  const now = new Map(ordered.map((entry) => [entry.record.id, entry]));
  const real = (entry: SessionEntry): SessionEntry => now.get(entry.record.id) ?? entry;
  const nameOf = (entry: SessionEntry): string => sessionLabel(entry);
  const visible = [...parts.active, ...(shelfOpen ? parts.shelf : []), ...(completedOpen ? parts.completed : [])].map(real);

  /** Runs one change. A refusal because the session runs is said; anything else that is not saved shows under the list. */
  async function change(request: () => Promise<SessionSaved | SessionRefusal>, running?: { readonly name: string; readonly action: RunningAction }): Promise<boolean> {
    try {
      const answer = await request();
      if (answer.status === 'refused' && answer.reason === 'running' && running !== undefined) {
        setFailed(false);
        setRunningNotice({ ...running, doing: answer.doing });
        return false;
      }
      setFailed(answer.status !== 'saved');
      return answer.status === 'saved';
    } catch {
      setFailed(true);
      return false;
    }
  }

  function move(id: string, before: string | null, spoken: boolean): void {
    const ids = groupIds(ordered, id);
    // The bottom of a visible page is before its hidden tail, not the end of all completed items.
    if (before === null) {
      const lastVisible = groupIds(visible, id).at(-1);
      if (lastVisible === undefined) return;
      before = ids[ids.indexOf(lastVisible) + 1] ?? null;
    }
    if (ids.length === 0 || isOwnCapsulePlace(ids, id, before)) return;
    const own = ordered.find((entry) => entry.record.id === id);
    if (own === undefined) return;
    const group = sessionOrderGroup(own.record);
    const after = applyCapsuleMove(ordered, id, before);
    const say = (): void => {
      const entry = after.find((session) => session.record.id === id);
      if (spoken && entry !== undefined) announce(capsulePositionText(nameOf(entry), groupIds(after, id), id, group));
    };
    if (hold !== null) {
      // The group goes to disk as shown, the promotions held back included: the user's order wins.
      const steps = arrangeMoves(groupIds(stored, id), groupIds(after, id));
      setHold(after.map((entry) => entry.record.id));
      void steps.reduce<Promise<boolean>>((done, step) => done.then((ok) => ok && change(() => invoke('sessions:move', { id: step.id, before: step.before, group }))), Promise.resolve(true)).then((ok) => { if (ok) say(); });
      return;
    }
    setPending({ base: sessions, id, before });
    void change(() => invoke('sessions:move', { id, before, group })).then((ok) => {
      if (!ok) {
        setPending(null);
        return;
      }
      say();
    });
  }

  const dragOptions = {
    column,
    measure,
    isOwnPlace: (id: string, before: string | null) => isOwnCapsulePlace(groupIds(visible, id), id, before),
    onDrop: (id: string, before: string | null) => move(id, before, false),
  };
  const orderKey = (entries: readonly SessionEntry[]) => entries.map((entry) => `${entry.record.id}:${entry.record.starred}`).join(',');
  const activeDrag = useCapsuleDrag({ ...dragOptions, list: active, resetKey: `${orderKey(parts.active)}|${activeIds.join(',')}` });
  const shelfDrag = useCapsuleDrag({ ...dragOptions, list: shelf, resetKey: `${orderKey(shelfOpen ? parts.shelf : [])}|${shelfIds.join(',')}` });
  const completedDrag = useCapsuleDrag({ ...dragOptions, list: completed, resetKey: orderKey(completedOpen ? parts.completed : []) });
  const drag = activeDrag.drag ?? shelfDrag.drag ?? completedDrag.drag;
  const step = (entry: SessionEntry, direction: -1 | 1): void => {
    const target = capsuleStep(groupIds(visible, entry.record.id), entry.record.id, direction);
    if (target === null) return;
    refocus.current = entry.record.id;
    move(entry.record.id, target.before, true);
  };

  // The keyboard move keeps the focus on the moved capsule, even when the list moved its element.
  useLayoutEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    const button = root.current?.querySelector<HTMLElement>(`[data-select-session="${id}"]`);
    if (button !== null && button !== undefined && document.activeElement !== button) button.focus();
    if (!moving) refocus.current = null;
  });

  // A capsule moved by its star when its menu closed: the focus that was on its `…` follows it, or goes
  // to the toggle row's half of its part, when the move took it past the completed ones shown.
  useLayoutEffect(() => {
    const id = menuRefocus.current;
    if (id === null || held !== null) return;
    menuRefocus.current = null;
    const own = root.current?.querySelector<HTMLElement>(`[data-session-menu="${id}"]`) ?? null;
    if (own !== null) {
      if (document.activeElement !== own) own.focus();
      return;
    }
    root.current?.querySelector<HTMLElement>(`[data-toggle="${parts.shelf.some((entry) => entry.record.id === id) ? 'shelf' : 'completed'}"]`)?.focus();
  });

  const menuChange = (entry: SessionEntry) => (open: boolean): void => {
    const { id, starred } = entry.record;
    if (open) {
      setHeld({ id, starred });
      return;
    }
    // Its star changed while the menu was open, and the menu was closed from the keyboard: the focus is on its `…`, which the move may take away.
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.dataset['sessionMenu'] === id;
    if (held?.id === id && held.starred !== starred && focused) menuRefocus.current = id;
    setHeld((current) => (current?.id === id ? null : current));
  };

  /**
   * Selecting a session, the selected one too, puts its chat back in the chat region, in place of a
   * chat without a session (M18, C31). ChatRegion focuses the newly shown chat's prompt. A pointer
   * press also asks explicitly (M100b, C61), so clicking the already selected session focuses it too.
   */
  const select = (entry: SessionEntry, byPointer: boolean): void => {
    showDetached(null);
    const { id } = entry.record;
    if (byPointer) setHold((current) => current ?? ordered.map((session) => session.record.id));
    void change(() => selectSession(id)).then((saved) => { if (saved && byPointer) focusPrompt(id); });
  };
  const setFlag = (entry: SessionEntry) => (flag: SessionFlag, on: boolean): void => void change(() => invoke('sessions:setFlag', { id: entry.record.id, flag, on }));
  const rename = (entry: SessionEntry, name: string): void => void change(() => invoke('sessions:rename', { id: entry.record.id, name }));
  const complete = (entry: SessionEntry): void => void change(() => completeWithFlash(entry), { name: nameOf(entry), action: 'completed' });
  const shelve = (entry: SessionEntry): void => void change(() => invoke('sessions:shelve', { id: entry.record.id }), { name: nameOf(entry), action: 'shelved' });
  /** Back to the active list, from the shelf or from the completed ones. */
  const restore = (entry: SessionEntry): void => void change(() => invoke('sessions:restore', { id: entry.record.id }));

  /**
   * Remove asks first — or, while the session runs, says so in place of the question (C36, C96),
   * with what it is doing as main says it (M22e), or a turn where main cannot say.
   */
  const askRemove = (entry: SessionEntry): void => {
    if (entry.summary.status !== 'running') { setRemoving(entry); return; }
    const name = nameOf(entry);
    invoke('sessions:doing', { id: entry.record.id }).then(
      (answer) => { setRunningNotice({ name, action: 'removed', doing: answer.status === 'read' ? answer.doing ?? undefined : undefined }); },
      () => { setRunningNotice({ name, action: 'removed' }); },
    );
  };

  const remove = async (): Promise<void> => {
    if (removing === null) return;
    setBusy(true);
    await change(() => invoke('sessions:remove', { id: removing.record.id }), { name: nameOf(removing), action: 'removed' });
    setBusy(false);
    setRemoving(null);
  };

  const thin = (placedEntry: SessionEntry) => {
    const entry = real(placedEntry);
    const driver = entry.record.shelvedAt !== null ? shelfDrag : completedDrag;
    return (
      <ThinCapsule
        key={entry.record.id}
        entry={entry}
        name={nameOf(entry)}
        selected={entry.record.id === selectedId}
        column={column}
        lifted={driver.drag?.id === entry.record.id}
        shift={driver.drag?.room.shifts.get(entry.record.id) ?? 0}
        onPointerDown={(event) => driver.onPointerDown(event, entry.record.id)}
        wasDragged={driver.wasDragged}
        onStep={(direction) => step(entry, direction)}
        onSelect={(byPointer) => select(entry, byPointer)}
        onFlag={setFlag(entry)}
        onComplete={() => complete(entry)}
        onRestore={() => restore(entry)}
        onShelve={() => shelve(entry)}
        onRemove={removable ? () => askRemove(entry) : null}
        onMenuChange={menuChange(entry)}
      />
    );
  };

  const dragged = drag === null ? undefined : ordered.find((entry) => entry.record.id === drag.id);
  const byId = new Map([...parts.active, ...parts.shelf].map((entry) => [entry.record.id, entry]));
  if (listed.length === 0) return null;

  return (
    <div ref={root} className={styles.sessions} onPointerLeave={() => setHold(null)}>
      {activeIds.length > 0 && (
        <ul ref={active} className={styles.group} aria-label={`Sessions of ${projectName}`} data-dragging={activeDrag.drag !== null || undefined}>
          {activeIds.map((id) => {
            const placedEntry = byId.get(id);
            if (placedEntry === undefined) return <Slot key={id} id={id} leaving={leaving[id]} />;
            const entry = real(placedEntry);
            return (
              <Capsule
                key={entry.record.id}
                entry={entry}
                name={nameOf(entry)}
                selected={entry.record.id === selectedId}
                column={column}
                lifted={drag?.id === entry.record.id}
                shift={drag?.room.shifts.get(entry.record.id) ?? 0}
                wasDragged={activeDrag.wasDragged}
                onPointerDown={(event) => activeDrag.onPointerDown(event, entry.record.id)}
                onSelect={(byPointer) => select(entry, byPointer)}
                onFlag={setFlag(entry)}
                onComplete={() => complete(entry)}
                onShelve={() => shelve(entry)}
                onRemove={removable ? () => askRemove(entry) : null}
                onRename={(name) => rename(entry, name)}
                onMenuChange={menuChange(entry)}
                onStep={(direction) => step(entry, direction)}
              />
            );
          })}
          {/* Where the capsule will land: the room the others made, outlined. */}
          {activeDrag.drag?.room.gap != null && (
            <li className={styles.gap} style={{ top: activeDrag.drag.room.gap.top, height: activeDrag.drag.room.gap.bottom - activeDrag.drag.room.gap.top }} data-gap="" aria-hidden="true" />
          )}
        </ul>
      )}
      {shelfIds.length > 0 && (
        <ul ref={shelf} className={styles.group} aria-label={`Shelf of ${projectName}`} data-dragging={shelfDrag.drag !== null || undefined}>
          {shelfIds.map((id) => {
            const entry = byId.get(id);
            return entry === undefined ? <Slot key={id} id={id} leaving={leaving[id]} /> : thin(entry);
          })}
          {shelfDrag.drag?.room.gap != null && <li className={styles.gap} style={{ top: shelfDrag.drag.room.gap.top, height: shelfDrag.drag.room.gap.bottom - shelfDrag.drag.room.gap.top }} data-gap="" aria-hidden="true" />}
        </ul>
      )}
      {parts.row !== null && (
        <ToggleRow
          shelf={parts.row.shelf}
          completed={parts.row.completed}
          shelfOpen={shelfOpen}
          completedOpen={completedOpen}
          onToggleShelf={() => setShelfOpen((open) => !open)}
          onToggleCompleted={() => setCompletedOpen((open) => !open)}
        />
      )}
      {completedOpen && parts.completed.length > 0 && (
        <ul ref={completed} className={styles.group} aria-label={`Completed sessions of ${projectName}`} data-dragging={completedDrag.drag !== null || undefined}>
          {parts.completed.map(thin)}
          {completedDrag.drag?.room.gap != null && <li className={styles.gap} style={{ top: completedDrag.drag.room.gap.top, height: completedDrag.drag.room.gap.bottom - completedDrag.drag.room.gap.top }} data-gap="" aria-hidden="true" />}
        </ul>
      )}
      {completedOpen && (parts.showMore || parts.showLess) && (
        <div className={styles.moreRow}>
          {parts.showLess && (
            <button type="button" className={styles.more} onClick={() => setShown((count) => Math.max(COMPLETED_STEP, count - COMPLETED_STEP))}>
              Show less
            </button>
          )}
          {parts.showMore && (
            <button type="button" className={styles.more} onClick={() => setShown((count) => count + COMPLETED_STEP)}>
              Show more
            </button>
          )}
        </div>
      )}
      {failed && (
        <p className={styles.problem} role="status">
          {SESSION_FAILED_TEXT}
        </p>
      )}
      {drag !== null && dragged !== undefined && (
        <div className={styles.lifted} data-thin={sessionOrderGroup(dragged.record).list !== 'active' || undefined} style={{ top: drag.top, left: drag.left, width: drag.width }} aria-hidden="true">
          <span className={styles.name}>{nameOf(dragged)}</span>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing === null ? 'this session' : nameOf(removing)}?`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      >
        <p>fat-g forgets this session.</p>
        <p>{REMOVE_CHAT_TEXT.session(removing === null ? 'the provider' : providerName(removing.record.providerId))}</p>
      </ConfirmDialog>
      <NoticeDialog open={runningNotice !== null} title={`${runningNotice?.name ?? 'This session'} is running`} onClose={() => setRunningNotice(null)}>
        <p>{runningNoticeText(runningNotice?.action ?? 'removed', runningNotice?.doing)}</p>
      </NoticeDialog>
    </div>
  );
}

/**
 * A leaving session's place (leaving.ts): its capsule's height, hidden from assistive technology, and
 * no divider, so empty slots side by side
 * read as one gap — kept empty while Clean up done holds it; then its height going to nothing over the
 * scene's duration.
 */
function Slot({ id, leaving }: { readonly id: string; readonly leaving: Leaving | undefined }) {
  const closing = leaving?.phase === 'closing';
  return (
    <li className={styles.slot} data-held-slot={id} data-closing={closing || undefined} aria-hidden="true" style={{ height: closing ? 0 : leaving?.slot?.height ?? 0 }} />
  );
}
