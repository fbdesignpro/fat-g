// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileImage } from '@shared/contracts/files';
import { invoke } from '../../ipc/client';

export const IMAGE_REFRESH_MS = 2_000;
interface Control { loaded(id: string, ok: boolean): void }

/** Only the mounted image tab polls. Keep its current pixels until the replacement has loaded. */
export function useImageRefresh(sessionId: string, path: string | null, id: string | undefined, opening: number, onImage: (image: FileImage) => void) {
  const key = `${sessionId}\0${path ?? ''}\0${id ?? ''}\0${opening}`;
  const [state, setState] = useState<{ readonly key: string; readonly failed: boolean; readonly pending: FileImage | null } | null>(null);
  const control = useRef<Control | null>(null);
  const apply = useRef(onImage);
  useLayoutEffect(() => { apply.current = onImage; }, [onImage]);
  useEffect(() => {
    if (path === null || id === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let generation = 0;
    let busy = false;
    let immediate = false;
    let pending: FileImage | null = null;
    const eligible = (): boolean => !document.hidden;
    const show = (failed: boolean): void => { setState({ key, failed, pending }); };
    const schedule = (): void => {
      clearTimeout(timer);
      if (!disposed && !busy && eligible()) timer = setTimeout(() => { void refresh(); }, IMAGE_REFRESH_MS);
    };
    const refresh = async (): Promise<void> => {
      if (disposed || busy || !eligible()) return;
      clearTimeout(timer);
      const mine = generation;
      busy = true;
      try {
        const answer = await invoke('files:refreshImage', { sessionId, path, id });
        if (disposed || mine !== generation || !eligible()) return;
        if (answer.outcome === 'image' && answer.id !== id) {
          pending = answer;
          show(false);
        } else if (answer.outcome !== 'retry') show(answer.outcome === 'refused');
      } catch {
        if (!disposed && mine === generation && eligible()) show(true);
      } finally {
        // A replacement's load owns the request until it succeeds or fails.
        if (pending === null) {
          busy = false;
          if (immediate) { immediate = false; void refresh(); }
          else schedule();
        }
      }
    };
    control.current = {
      loaded(candidate, ok) {
        if (disposed || pending?.id !== candidate) return;
        const image = pending;
        pending = null;
        busy = false;
        if (eligible()) {
          show(!ok);
          if (ok) apply.current(image);
        }
        schedule();
      },
    };
    const visibilityChanged = (): void => {
      generation += 1;
      clearTimeout(timer);
      if (pending !== null) { pending = null; busy = false; show(false); }
      if (eligible()) {
        if (busy) immediate = true;
        else void refresh();
      }
    };
    show(false);
    schedule();
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => {
      disposed = true;
      generation += 1;
      clearTimeout(timer);
      control.current = null;
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [key, sessionId, path, id]);
  const loaded = useCallback((candidate: string, ok: boolean): void => { control.current?.loaded(candidate, ok); }, []);
  return { failed: state?.key === key && state.failed, pending: state?.key === key ? state.pending : null, loaded };
}
