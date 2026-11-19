// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The selected session's asides, in the page (docs/planning/_archive/M20b.md, Design 7; C30, C48, C74): the
// markers its last read listed, whether it can be asked beside, and the one line that says why an
// ask was not taken. Held as the chat's drafts are, in the page's memory for the run; set by the
// chat's own read, which every change of the list reads again (C30).
//
// A marker is where an aside came from and none of its text. The chat, a worker's tab and a file's
// tab each find theirs here by the thing they draw, so that none of them reads the session's chat
// for it; the kind's watcher restores their saved tabs.
import { create } from 'zustand';
import type { AsideCapability, AsideMarker, AsideSourceRef } from '@shared/contracts/aside';

/** What a marker is found by: the thing it was taken from, and for an activity which of its two texts. */
export function sourceKey(source: Pick<AsideSourceRef, 'kind' | 'itemId' | 'part' | 'path'>): string {
  return `${source.kind}\u0000${source.itemId ?? source.path ?? ''}\u0000${source.part ?? ''}`;
}

export interface AsidesState {
  /** The session these are of, or null before any read. */
  readonly sessionId: string | null;
  readonly markers: readonly AsideMarker[];
  /** The markers that have a source, by `sourceKey`. */
  readonly bySource: Readonly<Record<string, readonly AsideMarker[]>>;
  /** How the session's provider answers an aside, or `none` where no question can be asked beside it now (C48). */
  readonly asking: AsideCapability;
  /** Why the last ask was not taken, in fat-g's words; null once another is, or the session changes. */
  readonly problem: string | null;
}

const NOTHING: AsidesState = { sessionId: null, markers: [], bySource: {}, asking: 'none', problem: null };
export const NO_MARKERS: readonly AsideMarker[] = [];

export const useAsides = create<AsidesState>()(() => NOTHING);

const sameMarker = (a: AsideMarker, b: AsideMarker): boolean => a.id === b.id && a.title === b.title && a.running === b.running && a.createdAt === b.createdAt && JSON.stringify(a.source) === JSON.stringify(b.source);
const sameAsking = (a: AsideCapability, b: AsideCapability): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What a read of the session's chat listed. Nothing changes, and nothing is drawn again, for a list that reads the same. */
export function setAsides(sessionId: string, markers: readonly AsideMarker[], asking: AsideCapability): void {
  useAsides.setState((held) => {
    const same = held.sessionId === sessionId && held.markers.length === markers.length && held.markers.every((marker, index) => sameMarker(marker, markers[index] as AsideMarker));
    if (same && sameAsking(held.asking, asking)) return held;
    if (same) return { ...held, asking };
    const bySource: Record<string, AsideMarker[]> = {};
    for (const marker of markers) {
      if (marker.source === null) continue;
      (bySource[sourceKey(marker.source)] ??= []).push(marker);
    }
    return { sessionId, markers, bySource, asking, problem: held.sessionId === sessionId ? held.problem : null };
  });
}

/** Another session is shown, or none: nothing of the last one's stays. */
export function clearAsides(sessionId: string): void {
  useAsides.setState((held) => (held.sessionId === sessionId ? NOTHING : held));
}

export function setAsideProblem(sessionId: string, problem: string | null): void {
  useAsides.setState((held) => (held.sessionId === sessionId && held.problem !== problem ? { ...held, problem } : held));
}

/** The markers of one thing the page draws, in the session whose asides are held. */
export function useSourceMarkers(sessionId: string | null, source: Pick<AsideSourceRef, 'kind' | 'itemId' | 'part' | 'path'> | null): readonly AsideMarker[] {
  const key = source === null ? null : sourceKey(source);
  return useAsides((state) => (key === null || sessionId === null || state.sessionId !== sessionId ? NO_MARKERS : state.bySource[key] ?? NO_MARKERS));
}

/** For tests: nothing held. */
export function resetAsides(): void {
  useAsides.setState(NOTHING);
}
