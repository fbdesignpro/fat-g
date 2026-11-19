// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { BrowserWindow } from 'electron';
import { DEFAULT_SEARCH_FILTERS } from '@shared/contracts/session-search';

/** Runs only in the smoke flavor against fixture data; records booleans, never search text. */
export async function checkSessionSearch(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
  const request = { ...DEFAULT_SEARCH_FILTERS, query: '', offset: 0 };
  const restricted = await pet.webContents.executeJavaScript(`window.fatg.invoke('sessions:search', ${JSON.stringify(request)}).then((r) => !r.ok && r.error === 'forbidden')`) as boolean;
  if (!restricted) throw new Error('search: the mini window could search sessions');
  const ready = await main.webContents.executeJavaScript(`(async () => {
    const request = ${JSON.stringify(request)};
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await window.fatg.invoke('sessions:search', request);
      if (!result.ok) return false;
      if (result.value.status === 'ready') return result.value.hits.length > 0 && result.value.hits.every((hit) => typeof hit.sessionId === 'string');
      if (result.value.status !== 'indexing') return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })()`) as boolean;
  if (!ready) throw new Error('search: the packaged service did not become ready');
  const dialog = await main.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('button[aria-label="Search"][aria-haspopup="dialog"]');
    if (!button) return { button: false };
    button.focus();
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const dialog = document.querySelector('dialog[open]');
    const input = dialog?.querySelector('input[type="search"]');
    const focused = !!input && document.activeElement === input;
    const controls = dialog?.querySelectorAll('select').length === 4;
    dialog?.close();
    // Native close is queued as a task, followed by React's unmount and its focus-restoring frame.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!dialog?.isConnected && document.activeElement === button) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return { button: true, focused, controls, closed: !dialog?.isConnected, restored: document.activeElement === button };
  })()`) as Record<string, boolean>;
  if (!dialog['button'] || !dialog['focused'] || !dialog['controls'] || !dialog['closed'] || !dialog['restored']) throw new Error(`search: dialog checks failed (${JSON.stringify(dialog)})`);
}
