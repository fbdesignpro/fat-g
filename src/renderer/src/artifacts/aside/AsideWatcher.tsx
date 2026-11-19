// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect } from 'react';
import { useAsides } from '../../chat/asides-store';
import { ASIDE_KIND } from '../opener';
import { openTab, setTitle, tabId } from '../tabs-store';
import { tabTitle } from './words';

/** Restore saved side questions as tabs when their session is read, without moving focus or selection. */
export function AsideWatcher() {
  const sessionId = useAsides((state) => state.sessionId);
  const markers = useAsides((state) => state.markers);
  useEffect(() => {
    if (sessionId === null) return;
    for (const marker of markers) {
      openTab(sessionId, ASIDE_KIND, marker.id, { select: false });
      setTitle(sessionId, tabId(ASIDE_KIND, marker.id), tabTitle(marker.title));
    }
  }, [sessionId, markers]);
  return null;
}
