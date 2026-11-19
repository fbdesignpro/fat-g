// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where a dragged project lands, how the list makes room for it, and what a move does to the list
// (docs/planning/_archive/M12.md, Design 10; C68, C72, C74, C75, C86). Pure: the drag hook measures, this
// decides, and main applies the same rules (src/main/records/store.ts, `move`) — the page's copy only
// keeps a dropped header where it was dropped until the new state arrives.
import type { ProjectEntryView } from '@shared/contracts/projects';

export type Group = 'visible' | 'hidden';

/** An unreadable entry is shown among the visible projects, at its place (C60). */
export function groupOf(entry: ProjectEntryView): Group {
  return entry.kind === 'project' && entry.hidden ? 'hidden' : 'visible';
}

export function groupLabel(group: Group): string {
  return group === 'visible' ? 'visible projects' : 'hidden projects';
}

export interface Box {
  readonly top: number;
  readonly bottom: number;
}

export interface MeasuredEntry extends Box {
  readonly key: string;
  readonly group: Group;
}

/**
 * The list as laid out, top to bottom, in the list's own coordinates: where each entry sits before
 * anything moves out of the way, which is what the pointer is compared with.
 */
export interface ListLayout {
  /** The visible entries, then — while it is open — the hidden list. */
  readonly entries: readonly MeasuredEntry[];
  /** The "n hidden projects" row; during a drag it is always there (C75). */
  readonly hiddenRow: Box | null;
  readonly hiddenOpen: boolean;
  /** The first hidden project in stored order, drawn or not: a drop on the row goes before it. */
  readonly firstHidden: string | null;
}

export interface DropTarget {
  readonly hidden: boolean;
  /** The entry it goes before, or null for the end of its group. */
  readonly before: string | null;
  /** Dropped on the hidden row itself, which lights up (C75). */
  readonly row: boolean;
}

/**
 * The target under `y`. Every gap between visible entries is one — an unreadable entry never moves,
 * but it has gaps around it — and so is the hidden row, and every gap in the open hidden list. Below
 * a closed hidden row is the row.
 */
export function dropAt(layout: ListLayout, y: number): DropTarget {
  const row = layout.hiddenRow;
  const hidden = layout.hiddenOpen ? layout.entries.filter((entry) => entry.group === 'hidden') : [];
  if (row !== null && y >= row.top) {
    if (y <= row.bottom || hidden.length === 0) return { hidden: true, before: layout.firstHidden, row: true };
    return gapUnder(hidden, y, true);
  }
  return gapUnder(layout.entries.filter((entry) => entry.group === 'visible'), y, false);
}

function gapUnder(entries: readonly MeasuredEntry[], y: number, hidden: boolean): DropTarget {
  const below = entries.find((entry) => y < (entry.top + entry.bottom) / 2);
  return { hidden, before: below?.key ?? null, row: false };
}

/** The key the hidden row goes by among the entries that move out of the way. */
export const HIDDEN_ROW = 'hidden-row';

export interface Room {
  /** How far each entry — and the hidden row, as HIDDEN_ROW — moves, in pixels, while it is dragged. */
  readonly shifts: ReadonlyMap<string, number>;
  /** Where the dragged project will land, one header tall; none on a closed hidden row, which lights up. */
  readonly gap: Box | null;
}

/**
 * The room the list makes for a dragged project (C86). Its own place stays in the layout, drawn
 * empty; the entries between it and the target each move towards it by its height and the space that
 * follows it, which closes the old place and opens the gap at the new one. Everything is worked out
 * from the layout before anything moved, and applied as transforms, so what the pointer is compared
 * with never moves.
 *
 * The space is the layout's, as measured (M100, C61): the next item's top less the dragged one's
 * bottom, or for the last item the space before it. Without it, every item passed would stand a gap
 * away from where the drop puts it, and jump there. The capsules' drag takes the same arithmetic.
 */
export function makeRoom(layout: ListLayout, dragged: string, target: DropTarget): Room {
  const items = [
    ...layout.entries.map(({ key, top, bottom }) => ({ key, top, bottom })),
    ...(layout.hiddenRow === null ? [] : [{ key: HIDDEN_ROW, ...layout.hiddenRow }]),
  ].sort((a, b) => a.top - b.top);
  const from = items.findIndex((item) => item.key === dragged);
  const moving = items[from];
  if (moving === undefined) return { shifts: new Map(), gap: null };
  const height = moving.bottom - moving.top;
  const next = items[from + 1];
  const previous = items[from - 1];
  const space = next !== undefined ? next.top - moving.bottom : previous !== undefined ? moving.top - previous.bottom : 0;
  const step = height + Math.max(0, space);

  // Where it goes, as "before the item at this index", with the dragged entry still in the list.
  const indexOf = (key: string | null): number => {
    const found = key === null ? -1 : items.findIndex((item) => item.key === key);
    return found === -1 ? items.length : found;
  };
  let at: number;
  if (target.row || target.before !== null) at = indexOf(target.before);
  else if (target.hidden) at = items.length;
  else at = indexOf(layout.hiddenRow === null ? null : HIDDEN_ROW);

  const shifts = new Map<string, number>();
  let gap: Box;
  if (at > from + 1) {
    for (const item of items.slice(from + 1, at)) shifts.set(item.key, -step);
    const above = items[at - 1] ?? moving;
    gap = { top: above.bottom - height, bottom: above.bottom };
  } else if (at < from) {
    for (const item of items.slice(at, from)) shifts.set(item.key, step);
    const first = items[at]?.top ?? moving.top;
    gap = { top: first, bottom: first + height };
  } else {
    gap = { top: moving.top, bottom: moving.bottom };
  }
  // Onto a closed hidden row, or one with nothing under it: no place is drawn, the row lights up.
  return { shifts, gap: target.row && at === items.length ? null : gap };
}

/** A drop where the project already is: nothing is sent (C68). */
export function isOwnPlace(entries: readonly ProjectEntryView[], key: string, target: Pick<DropTarget, 'hidden' | 'before'>): boolean {
  const entry = entries.find((item) => item.key === key);
  if (entry === undefined) return true;
  const group = groupOf(entry);
  if (target.hidden !== (group === 'hidden')) return false;
  const members = entries.filter((item) => groupOf(item) === group);
  const next = members[members.findIndex((item) => item.key === key) + 1]?.key ?? null;
  return target.before === key || target.before === next;
}

/** The list after a move, by main's rules: before an entry, or after its group's last one (C74). */
export function applyMove(entries: readonly ProjectEntryView[], key: string, hidden: boolean, before: string | null): readonly ProjectEntryView[] {
  const from = entries.findIndex((item) => item.key === key);
  const entry = entries[from];
  if (entry?.kind !== 'project') return entries;
  const moved: ProjectEntryView = { ...entry, hidden };
  if (before === key) return entries.map((item, index) => (index === from ? moved : item));
  const rest = entries.filter((_, index) => index !== from);
  let to: number;
  if (before !== null) {
    to = rest.findIndex((item) => item.key === before);
    if (to === -1) return entries;
  } else {
    const last = rest.findLastIndex((item) => groupOf(item) === (hidden ? 'hidden' : 'visible'));
    to = last !== -1 ? last + 1 : hidden ? rest.length : 0;
  }
  return [...rest.slice(0, to), moved, ...rest.slice(to)];
}

/** Alt+Up and Alt+Down: one place within its group, or nothing at its ends (C72). */
export function stepMove(entries: readonly ProjectEntryView[], key: string, direction: -1 | 1): { hidden: boolean; before: string | null } | null {
  const entry = entries.find((item) => item.key === key);
  if (entry?.kind !== 'project') return null;
  const group = groupOf(entry);
  const members = entries.filter((item) => groupOf(item) === group);
  const at = members.findIndex((item) => item.key === key);
  if (direction === -1) {
    const previous = members[at - 1];
    return previous === undefined ? null : { hidden: entry.hidden, before: previous.key };
  }
  if (at === members.length - 1) return null;
  return { hidden: entry.hidden, before: members[at + 2]?.key ?? null };
}

/** "fat-g, position 2 of 5 in visible projects." */
export function positionText(entries: readonly ProjectEntryView[], key: string): string | null {
  const entry = entries.find((item) => item.key === key);
  if (entry?.kind !== 'project') return null;
  const group = groupOf(entry);
  const members = entries.filter((item) => groupOf(item) === group);
  return `${entry.name}, position ${members.indexOf(entry) + 1} of ${members.length} in ${groupLabel(group)}.`;
}
