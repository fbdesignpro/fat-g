// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// New-family drag and drop through the real renderer, preload, dispatcher and user avatar store.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { PreferencesStore } from '../prefs/store';
import { MAX_STAGE_BYTES } from '@shared/ipc/channels';

export async function checkCreateFamily(main: BrowserWindow, pet: BrowserWindow, prefs: PreferencesStore): Promise<void> {
  const evaluate = <T>(code: string): Promise<T> => main.webContents.executeJavaScript(code) as Promise<T>;
  const wait = async (code: string): Promise<void> => {
    const until = Date.now() + 8_000;
    while (!(await evaluate<boolean>(code))) {
      if (Date.now() > until) throw new Error(`avatar-family: renderer did not settle: ${code}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const check = (value: boolean, words: string): void => { if (!value) throw new Error(`avatar-family: ${words}`); };
  await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`);
  await wait(`document.querySelector('#settings-tab-avatars') !== null`);
  await evaluate(`document.querySelector('#settings-tab-avatars').click()`);
  const zone = `document.querySelector('[data-avatar-families] [data-avatar-drop]')`;
  const popup = `document.querySelector('[data-create-family][open]')`;
  await wait(`${zone} !== null`);
  check(await evaluate<boolean>(`(() => {
    const info = [...document.querySelectorAll('[data-avatar-families] button')].find(b => b.textContent.includes('Technical details'));
    return info?.previousElementSibling?.textContent === 'Show avatars folder';
  })()`), 'Technical details is not beside Show avatars folder');
  // A real decoded PNG is dropped; no fixture path or source image is stored elsewhere.
  const drop = async (): Promise<void> => {
    await evaluate(`(async () => {
      const canvas = new OffscreenCanvas(768, 768);
      const context = canvas.getContext('2d');
      context.fillStyle = '#4080c0'; context.fillRect(0, 0, 768, 768);
      const image = new File([await canvas.convertToBlob({ type: 'image/png' })], 'Smoke Sun.png', { type: 'image/png' });
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(image);
      ${zone}.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    })()`);
    await wait(`${popup}?.querySelectorAll('img').length === 2`);
    await evaluate(`Promise.all([...${popup}.querySelectorAll('img')].map(img => img.decode()))`);
    check(await evaluate<boolean>(`document.activeElement === ${popup}.querySelector('input')`), 'family name did not take focus');
  };
  const setName = (name: string): Promise<unknown> => evaluate(`(() => {
    const input = ${popup}.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
  const originalTheme = prefs.getSnapshot().values.appearance.theme;
  const screenshot = async (name: string): Promise<void> => {
    if (directory !== undefined && path.isAbsolute(directory)) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${name}.png`), (await main.webContents.capturePage()).toPNG());
    }
  };
  const family = `Smoke family ${Date.now()}`;
  for (const matched of [false, true]) {
    await drop();
    const name = matched ? `${family} matched` : family;
    await setName(name);
    if (matched) {
      await evaluate(`${popup}.querySelector('[data-add-match]').click()`);
      await wait(`${popup}.querySelectorAll('input').length === 3`);
    }
    if (!matched) {
      for (const theme of ['light', 'dark'] as const) {
        await evaluate(`window.fatg.invoke('prefs:patch', { appearance: { theme: '${theme}' } })`);
        await wait(`document.documentElement.dataset.theme === '${theme}'`);
        await screenshot(`avatar-family-${theme}`);
      }
    }
    await evaluate(`${popup}.querySelector('footer button:last-child').click()`);
    await wait(`document.querySelector('[data-family-editor="${name}"][open] [data-family-columns]') !== null`);
    const listed = await evaluate<boolean>(`window.fatg.invoke('avatars:list', null).then(r => {
      const family = r.ok && r.value.roots.find(root => root.origin === 'user')?.families.find(f => f.folder === '${name}');
      return !!family && family.problems.length === 0 && family.avatars.length === ${matched ? 2 : 1}
        && family.avatars.every(a => a.files.length === 2 && a.files.some(f => f.role === 'portrait' && f.width === 512) && a.files.some(f => f.role === 'small' && f.width === 64));
    })`);
    check(listed, 'created family did not list its prepared images');
    await evaluate(`document.querySelector('[data-family-editor][open]').close()`);
    await wait(`document.querySelector('[data-family-editor][open]') === null`);
  }
  // Validate the actual preload byte bound and mini-window refusal with a complete request.
  const restricted = (await pet.webContents.executeJavaScript(`window.fatg.invoke('avatars:createFamily', { name: 'Denied', avatar: null, portrait: new Uint8Array([1]), small: new Uint8Array([1]) }).then(r => !r.ok && r.error === 'forbidden')`)) as boolean;
  check(restricted, 'mini window could create a family');
  check(await evaluate<boolean>(`window.fatg.invoke('avatars:createFamily', { name: 'Too large', avatar: null, portrait: new Uint8Array(${MAX_STAGE_BYTES + 1}), small: new Uint8Array([1]) }).then(() => false, () => true)`), 'preload forwarded an oversized image');
  await drop();
  await setName(family.toUpperCase());
  await wait(`${popup}.querySelector('footer button:last-child').disabled === true`);
  await evaluate(`${popup}.querySelector('footer button').click()`);
  await wait(`${popup} === null && document.activeElement === ${zone}`);
  await screenshot('avatar-families');
  await evaluate(`window.fatg.invoke('prefs:patch', { appearance: { theme: ${JSON.stringify(originalTheme)} } })`);
  await evaluate(`document.querySelector('button[aria-label="Close settings"]').click()`);
}
