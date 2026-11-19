// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { WindowKind } from '@shared/ipc/channels';
import { connectPrefs } from './state/prefs-store';
import { connectAppState } from './state/store';
import { ThemeRoot } from './theme/ThemeRoot';

/**
 * Starts a page: mirror what main holds before rendering, so the window never misses a push.
 *
 * Preferences are the Main window's business — the Pet window is not allowed to ask for them
 * (see `from` in src/shared/ipc/contract.ts), so it does not try. The theme reaches both windows
 * through the app state instead.
 */
export function boot(page: WindowKind, app: ReactNode): void {
  connectAppState();
  if (page === 'main') connectPrefs();

  const container = document.getElementById('root');
  if (!container) throw new Error('#root element missing from the page');

  createRoot(container).render(
    <StrictMode>
      <ThemeRoot />
      {app}
    </StrictMode>,
  );
}
