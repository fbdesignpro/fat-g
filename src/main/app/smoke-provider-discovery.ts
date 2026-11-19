// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { BrowserWindow } from 'electron';

/** Real preload, native dialog, dismissal, unchanged rescan and mini-window refusal. Fixture-only. */
export async function checkProviderDiscovery(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
  const evaluate = (code: string): Promise<unknown> => main.webContents.executeJavaScript(code);
  const until = async (code: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await evaluate(code) === true) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Provider discovery smoke timed out');
  };
  await until(`(async () => {
    const result = await window.fatg.invoke('state:getSnapshot', null);
    return result.ok && result.value.providerDiscovery !== undefined && !result.value.providerDiscovery.checking;
  })()`);
  const hasNotice = await evaluate(`(async () => (await window.fatg.invoke('state:getSnapshot', null)).value.providerDiscovery.notice !== null)()`);
  if (hasNotice) {
    await until(`[...document.querySelectorAll('dialog[open] h2')].some((heading) => heading.textContent === 'Providers detected' || heading.textContent === 'Provider availability changed')`);
    const focused = await evaluate(`document.activeElement?.textContent === 'Got it'`);
    if (!focused) throw new Error('Provider detection did not focus Got it');
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('dialog[open]')].find((element) => /Providers detected|Provider availability changed/.test(element.querySelector('h2')?.textContent ?? ''));
      [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Got it').click();
    })()`);
    await until(`(async () => (await window.fatg.invoke('state:getSnapshot', null)).value.providerDiscovery.notice === null)()`);
    await until(`![...document.querySelectorAll('dialog[open] h2')].some((heading) => /Providers detected|Provider availability changed/.test(heading.textContent))`);
  }
  const rescan = await evaluate(`(async () => {
    const result = await window.fatg.invoke('providers:discover', null);
    const state = await window.fatg.invoke('state:getSnapshot', null);
    return result.ok && state.ok && state.value.providerDiscovery.notice === null;
  })()`);
  if (!rescan) throw new Error('Unchanged provider rescan was not quiet');
  const restricted: unknown = await pet.webContents.executeJavaScript(`(async () => {
    const scan = await window.fatg.invoke('providers:discover', null);
    const ack = await window.fatg.invoke('providers:acknowledgeDiscovery', { revision: 1 });
    const state = await window.fatg.invoke('state:getSnapshot', null);
    return !scan.ok && !ack.ok && state.ok && !('providerDiscovery' in state.value) && state.value.providers.every((provider) => !('presence' in provider));
  })()`);
  if (restricted !== true) throw new Error('Provider discovery reached the mini window');
  // Later provider tests deliberately remove executables and flip switches. Acknowledge their
  // notices through the same IPC so unrelated modal checks are not intercepted by those changes.
  await evaluate(`(() => {
    let acknowledged = 0;
    window.fatg.on('state:snapshot', (snapshot) => {
      const notice = snapshot.providerDiscovery?.notice;
      if (notice && notice.revision !== acknowledged) {
        acknowledged = notice.revision;
        void window.fatg.invoke('providers:acknowledgeDiscovery', { revision: notice.revision });
      }
    });
  })()`);
}
