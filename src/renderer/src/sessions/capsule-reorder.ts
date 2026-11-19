// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where a dragged capsule lands, and what a move does to a project's sessions (docs/planning/_archive/M14.md,
// Design 10; C11, C55, C90). Pure: the drag hook measures, this decides, and main applies the same
// rules (src/main/records/store.ts, `moveSession`) — the page's copy only keeps a dropped capsule
// where it was dropped until the new state arrives.
//
// A capsule moves within its own project, lifecycle list and star group: staying inside
// the group keeps a drag from starring, shelving or completing a session by accident.
import { type SessionGroup, type SessionView } from '@shared/contracts/sessions';
import { moveSessionEntry, sameSessionOrderGroup, sessionOrderGroup, type SessionOrderGroup } from '@shared/contracts/session-order';
import { type Box, makeRoom, type Room } from '../projects/reorder';

export interface CapsuleBox extends Box {
  readonly id: string;
  readonly group: SessionGroup;
}

export interface CapsuleTarget {
  /** The session it goes before, or null for the end of its group. */
  readonly before: string | null;
}

/**
 * The gap under `y` among the capsules of the dragged one's group, or null outside the group: a
 * release there cancels (C55). `boxes` are one project's visible capsules in one lifecycle list, top to bottom, in the
 * list's own coordinates, where the layout puts them before anything moves out of the way.
 */
export function capsuleDropAt(boxes: readonly CapsuleBox[], dragged: string, y: number): CapsuleTarget | null {
  const group = groupBoxes(boxes, dragged);
  const first = group[0];
  const last = group.at(-1);
  if (first === undefined || last === undefined || y < first.top || y > last.bottom) return null;
  return { before: group.find((box) => y < (box.top + box.bottom) / 2)?.id ?? null };
}

function groupBoxes(boxes: readonly CapsuleBox[], dragged: string): readonly CapsuleBox[] {
  const own = boxes.find((box) => box.id === dragged);
  return own === undefined ? [] : boxes.filter((box) => box.group === own.group);
}

const NO_ROOM: Room = { shifts: new Map(), gap: null };

/** How the group's other capsules move out of the way, and where the gap opens: M12's arithmetic, on one group. */
export function capsuleRoom(boxes: readonly CapsuleBox[], dragged: string, target: CapsuleTarget | null): Room {
  if (target === null) return NO_ROOM;
  const entries = groupBoxes(boxes, dragged).map((box) => ({ key: box.id, group: 'visible' as const, top: box.top, bottom: box.bottom }));
  return makeRoom({ entries, hiddenRow: null, hiddenOpen: false, firstHidden: null }, dragged, { hidden: false, before: target.before, row: false });
}

type Movable = { readonly record: Pick<SessionView, 'id' | 'starred' | 'completedAt' | 'shelvedAt'> };

/** The ids in the same lifecycle and star group, in saved order. The caller supplies one project. */
export function groupIds(sessions: readonly Movable[], id: string): readonly string[] {
  const own = sessions.find((session) => session.record.id === id);
  if (own === undefined) return [];
  return sessions.filter((session) => sameSessionOrderGroup(sessionOrderGroup(session.record), sessionOrderGroup(own.record))).map((session) => session.record.id);
}

/** A drop where the capsule already is: nothing is sent. */
export function isOwnCapsulePlace(ids: readonly string[], id: string, before: string | null): boolean {
  const next = ids[ids.indexOf(id) + 1] ?? null;
  return before === id || before === next;
}

/** One project's sessions after a move, by main's rules: before a session, or after its group's last one (C11). */
export function applyCapsuleMove<T extends Movable>(sessions: readonly T[], id: string, before: string | null): readonly T[] {
  const moved = sessions.find((session) => session.record.id === id);
  const ids = groupIds(sessions, id);
  if (moved === undefined || ids.length === 0 || isOwnCapsulePlace(ids, id, before)) return sessions;
  if (before !== null && !ids.includes(before)) return sessions;
  return moveSessionEntry(sessions, moved, before === null ? null : sessions.find((session) => session.record.id === before) ?? null, (session) => ids.includes(session.record.id));
}

/**
 * The saved order as a held list shows it: the sessions `hold` names take each other's places, in
 * its order, and every other one keeps its own. Which list and star group each is in is still the
 * record's, so a Done or a star shows at once; only a promotion waits.
 */
export function heldOrder<T extends Movable>(sessions: readonly T[], hold: readonly string[]): readonly T[] {
  const rank = new Map(hold.map((id, index) => [id, index]));
  const held = sessions.filter((session) => rank.has(session.record.id)).sort((a, b) => (rank.get(a.record.id) ?? 0) - (rank.get(b.record.id) ?? 0));
  let next = 0;
  return sessions.map((session) => (rank.has(session.record.id) ? held[next++] ?? session : session));
}

/**
 * The fewest moves, each as main takes one, that turn a group's saved order into the one shown: a
 * move made in a held list places the capsule as the user saw it, the promotions held back included.
 * The longest run already in saved order stays; each other session goes before the one shown after
 * it, from the end up. Both lists hold the same ids.
 */
export function arrangeMoves(saved: readonly string[], shown: readonly string[]): readonly { readonly id: string; readonly before: string | null }[] {
  const ranks = shown.map((id) => saved.indexOf(id));
  // The longest run of `shown` in saved order: for each place, the longest ending there, and the one before it.
  const length = ranks.map(() => 1);
  const previous = ranks.map(() => -1);
  for (let at = 0; at < ranks.length; at += 1) {
    for (let earlier = 0; earlier < at; earlier += 1) {
      if ((ranks[earlier] ?? 0) < (ranks[at] ?? 0) && (length[earlier] ?? 0) + 1 > (length[at] ?? 0)) {
        length[at] = (length[earlier] ?? 0) + 1;
        previous[at] = earlier;
      }
    }
  }
  const stays = new Set<string>();
  for (let at = length.indexOf(Math.max(0, ...length)); at !== -1; at = previous[at] ?? -1) stays.add(shown[at] ?? '');
  const order = [...saved];
  const moves: { id: string; before: string | null }[] = [];
  for (let at = shown.length - 1; at >= 0; at -= 1) {
    const id = shown[at];
    if (id === undefined || stays.has(id)) continue;
    const before = shown[at + 1] ?? null;
    if ((order[order.indexOf(id) + 1] ?? null) === before) continue;
    order.splice(order.indexOf(id), 1);
    order.splice(before === null ? order.length : order.indexOf(before), 0, id);
    moves.push({ id, before });
  }
  return moves;
}

/** Alt+Up and Alt+Down: one place within the group, or nothing at its ends (C90). */
export function capsuleStep(ids: readonly string[], id: string, direction: -1 | 1): CapsuleTarget | null {
  const at = ids.indexOf(id);
  if (at === -1) return null;
  if (direction === -1) {
    const previous = ids[at - 1];
    return previous === undefined ? null : { before: previous };
  }
  if (at === ids.length - 1) return null;
  return { before: ids[at + 2] ?? null };
}

/** "Create plan, position 2 of 5 in starred sessions." */
export function capsulePositionText(name: string, ids: readonly string[], id: string, group: SessionOrderGroup): string {
  const list = group.list === 'active' ? 'sessions' : group.list === 'shelf' ? 'shelved sessions' : 'completed sessions';
  return `${name}, position ${ids.indexOf(id) + 1} of ${ids.length} in ${group.starred ? 'starred ' : ''}${list}.`;
}
