// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileReadAnswer } from '@shared/contracts/files';
import { invoke } from '../../ipc/client';

export const FILE_REFRESH_MS = 2_000;
type TextFile = Extract<FileReadAnswer, { outcome: 'text' }>;
interface RefreshControl { replace(answer: TextFile | null): void }

/** A selection may start outside the file and still touch it. No selection is saved or restored. */
function selected(element: HTMLElement | null): boolean {
  const selection = document.getSelection();
  if (element === null || selection === null || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

/** One best-effort request at a time, owned by the shown body. Failure never replaces its text. */
export function useFileRefresh(sessionId: string, path: string, scroller: RefObject<HTMLElement | null>, onText: (answer: TextFile) => void) {
  const [failed, setFailed] = useState(false);
  const control = useRef<RefreshControl | null>(null);
  const apply = useRef(onText);
  useLayoutEffect(() => { apply.current = onText; }, [onText]);

  useEffect(() => {
    let baseline: TextFile | null = null;
    let timer: number | undefined;
    let serial = 0;
    let busy = false;
    let disposed = false;
    let immediate = false;
    const eligible = (): boolean => !document.hidden && !selected(scroller.current);
    let wasEligible = eligible();
    const schedule = (): void => {
      window.clearTimeout(timer);
      if (!disposed && !busy && baseline !== null && eligible()) timer = window.setTimeout(() => { void refresh(); }, FILE_REFRESH_MS);
    };
    const refresh = async (): Promise<void> => {
      if (disposed || busy || baseline === null || !eligible()) return;
      window.clearTimeout(timer);
      const mine = serial;
      const revision = baseline.revision;
      busy = true;
      try {
        const answer = await invoke('files:refresh', { sessionId, path, revision });
        if (disposed || serial !== mine || baseline === null || !eligible()) return;
        if (answer.outcome === 'retry') return;
        if (answer.outcome === 'unchanged') setFailed(false);
        else if (answer.outcome === 'text' && answer.revision !== null) {
          setFailed(false);
          const previous = baseline;
          baseline = answer;
          if (answer.text !== previous.text || answer.view !== previous.view) apply.current(answer);
        } else setFailed(true);
      } catch {
        if (!disposed && serial === mine && eligible()) setFailed(true);
      } finally {
        busy = false;
        if (immediate) {
          immediate = false;
          void refresh();
        } else schedule();
      }
    };
    const replace = (answer: TextFile | null): void => {
      serial += 1;
      baseline = answer;
      setFailed(false);
      schedule();
    };
    control.current = { replace };
    const eligibilityChanged = (): void => {
      const next = eligible();
      if (next === wasEligible) return;
      wasEligible = next;
      serial += 1;
      window.clearTimeout(timer);
      if (next) {
        if (busy) immediate = true;
        else void refresh();
      }
    };
    document.addEventListener('visibilitychange', eligibilityChanged);
    document.addEventListener('selectionchange', eligibilityChanged);
    return () => {
      disposed = true;
      serial += 1;
      baseline = null;
      control.current = null;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', eligibilityChanged);
      document.removeEventListener('selectionchange', eligibilityChanged);
    };
  }, [sessionId, path, scroller]);

  // Null invalidates a pending automatic answer as soon as an explicit read starts.
  const replace = useCallback((answer: TextFile | null): void => { control.current?.replace(answer); }, []);
  return { failed, replace };
}
