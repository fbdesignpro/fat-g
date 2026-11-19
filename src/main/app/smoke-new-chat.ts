// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The initial screen through the real preload, dispatcher and stores, on smoke's isolated data.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { ChatRead } from '@shared/contracts/chat';
import { imageFileAddress, type FileReadAnswer, type ImageRefreshAnswer } from '@shared/contracts/files';
import type { PreferencesStore } from '../prefs/store';
import { pngBytes } from '../images/test-support';
import { offeredInstances, presetOffer, presetTiles, preselectPreset, type ModelPreset } from '@shared/contracts/presets';
import { savedPresetProblem } from '@shared/contracts/saved-presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';

interface Context {
  readonly main: BrowserWindow;
  readonly pet: BrowserWindow;
  readonly prefs: PreferencesStore;
  readonly snapshot: () => AppStateSnapshot;
  readonly projectId: string;
}

export async function checkNewChat({ main, pet, prefs, snapshot, projectId }: Context): Promise<void> {
  const evaluate = <T>(code: string): Promise<T> => main.webContents.executeJavaScript(code) as Promise<T>;
  const ask = <T>(channel: string, request: unknown): Promise<T> => evaluate(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)}).then(r => { if (!r.ok) throw Error(r.error); return r.value; })`);
  const check = (value: boolean, message: string): void => { if (!value) throw new Error(`new-chat: ${message}`); };
  const wait = async (code: string): Promise<void> => {
    const until = Date.now() + 5_000;
    while (!(await evaluate<boolean>(code))) {
      if (Date.now() > until) throw new Error(`new-chat: renderer did not settle: ${code}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await wait(`document.querySelector('[data-new-session-for="${projectId}"]') !== null`);
  const clickPlus = `document.querySelector('[data-new-session-for="${projectId}"]').click()`;
  const before = snapshot().sessions?.sessions.length;
  await evaluate(clickPlus);
  await wait(`document.querySelector('[data-new-chat-screen] textarea') !== null`);
  const id = snapshot().sessions?.selectedId;
  check(typeof id === 'string', 'no provisional selection');
  if (id == null) return;
  // Exercise image metadata refresh through the real Main-only bridge and Chromium's media route.
  const imageFolder = mkdtempSync(path.join(tmpdir(), 'fatg-smoke-image-refresh-files-'));
  const imagePath = path.join(imageFolder, 'image-refresh.png');
  writeFileSync(imagePath, pngBytes(12, 8));
  const image = await ask<FileReadAnswer>('files:read', { sessionId: id, target: imagePath });
  if (image.outcome !== 'image') throw new Error('new-chat: fixture image was not admitted');
  const imageRequest = { sessionId: id, path: image.path, id: image.id };
  check(await pet.webContents.executeJavaScript(`window.fatg.invoke('files:refreshImage', ${JSON.stringify(imageRequest)}).then(r => !r.ok && r.error === 'forbidden')`) as boolean, 'the mini window could refresh an image');
  check((await ask<ImageRefreshAnswer>('files:refreshImage', imageRequest)).outcome === 'unchanged', 'unchanged image metadata was not recognized');
  writeFileSync(imagePath, pngBytes(24, 16));
  const modified = new Date(Date.now() + 1_000);
  utimesSync(imagePath, modified, modified);
  const replacement = await ask<ImageRefreshAnswer>('files:refreshImage', imageRequest);
  if (replacement.outcome !== 'image' || replacement.id === image.id) throw new Error('new-chat: changed image kept its old preview id');
  check(await evaluate<boolean>(`new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth === 24 && image.naturalHeight === 16); image.onerror = () => resolve(false); image.src = ${JSON.stringify(imageFileAddress(replacement.id))}; })`), 'refreshed image did not decode through the media route');
  const initial = snapshot().sessions?.sessions.find((entry) => entry.record.id === id);
  check(initial?.summary.status === 'not-started', 'opening started a turn');
  await evaluate(clickPlus);
  check(snapshot().sessions?.sessions.length === (before ?? 0) + 1, 'repeated + created another record');
  const hierarchy = await evaluate<{ ratio: number; stacked: boolean; avatar: number; rule: number; prefix: boolean; panes: number }>(`(() => {
    const area = document.querySelector('[data-new-chat-screen]');
    const heading = area.querySelector('h1');
    return { ratio: parseFloat(getComputedStyle(heading.lastElementChild).fontSize) / parseFloat(getComputedStyle(heading).fontSize),
      stacked: heading.hasAttribute('data-stacked'),
      avatar: area.querySelector('[data-avatar]').getBoundingClientRect().width,
      rule: parseFloat(getComputedStyle(area.querySelector('hr')).borderTopWidth),
      prefix: [...area.querySelectorAll('[data-action-prefix]')].some(node => getComputedStyle(node).display !== 'none'),
      panes: document.querySelectorAll('[data-chat-window]').length };
  })()`);
  const subtitleScale = hierarchy.stacked ? 0.65 : 0.5;
  check(Math.abs(hierarchy.ratio - subtitleScale) < 0.01 && hierarchy.avatar === 176 && hierarchy.rule >= 6 && !hierarchy.prefix && hierarchy.panes === 0, `layout hierarchy ${JSON.stringify(hierarchy)}`);

  const denied = await pet.webContents.executeJavaScript(`window.fatg.invoke('sessions:setDraftPreset', { id: ${JSON.stringify(id)}, preset: {} }).then(r => r.ok ? 'allowed' : r.error, () => 'forbidden')`) as string;
  check(denied === 'forbidden', 'Pet admitted draft selection changes');
  const app = snapshot();
  const project = app.records?.projects.find((entry) => entry.kind === 'project' && entry.id === projectId);
  if (project?.kind !== 'project') throw new Error('new-chat: project disappeared');
  const preset = preselectPreset({ catalog: app.catalog, offer: presetOffer(project.providers, app.providers), projectId, sessions: [] });
  if (preset === null) throw new Error('new-chat: no usable selection');
  const attachment = await evaluate<{ status: string; attachment: { id: string } }>(`window.fatg.invoke('attachments:stage', { sessionId: ${JSON.stringify(id)}, bytes: new Uint8Array(${JSON.stringify([...pngBytes(12, 8)])}), name: 'new-chat.png' }).then(r => r.value)`);
  check(attachment.status === 'staged', 'could not stage an image');
  await ask('chat:draft', { sessionId: id, op: 'text', revision: 5, prompt: 'A provisional smoke draft', intent: { plan: true, skill: null } });
  await ask('chat:draft', { sessionId: id, op: 'flush' });
  const changed = await ask<{ status: string }>('sessions:setDraftPreset', { id, preset });
  check(changed.status === 'saved', 'selection refused');
  const read = await ask<ChatRead>('chat:read', { sessionId: id });
  check(read.status === 'read' && read.composer?.draft.text === 'A provisional smoke draft' && read.composer.draft.intent.plan && read.composer.draft.attachments[0]?.id === attachment.attachment.id, 'selection lost draft content');
  const ids = Array.from({ length: 8 }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`);
  await ask('prefs:patch', { presets: Object.fromEntries(ids.map((key, i) => [key, { ...preset, name: i === 7 ? 'A long named preset for careful implementation and review' : `Smoke preset ${i + 1}` }])) });
  await wait(`document.querySelectorAll('[data-preset-id]').length > 0`);
  // The last page has the same selection with a different identity: only the clicked id is recent.
  for (let page = 0; page < 4 && !(await evaluate<boolean>(`document.querySelector('[data-preset-id="${ids[7]}"]') !== null`)); page += 1) {
    await evaluate(`document.querySelector('[aria-label="Show more presets"]').click()`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await wait(`document.querySelector('[data-preset-id="${ids[7]}"]') !== null`);
  const visiblePresets = await evaluate<string[]>(`[...document.querySelectorAll('[data-preset-id]')].map((node) => node.getAttribute('data-preset-id'))`);
  await evaluate(`(() => { const button = document.querySelector('[data-preset-id="${ids[7]}"]'); button.focus(); button.click(); })()`);
  // Usage is saved immediately, while the current visit keeps its order and keyboard focus.
  await wait(`document.activeElement?.getAttribute('data-preset-id') === '${ids[7]}'`);
  await wait(`window.fatg.invoke('prefs:get', null).then((answer) => answer.ok && answer.value.values.presetRecency[0] === '${ids[7]}')`);
  check(prefs.getSnapshot().values.presetRecency[0] === ids[7], 'clicked preset was not first in main');
  check(JSON.stringify(await evaluate<string[]>(`[...document.querySelectorAll('[data-preset-id]')].map((node) => node.getAttribute('data-preset-id'))`)) === JSON.stringify(visiblePresets), 'choosing a preset reordered the current visit');
  const recentChoices: ModelPreset[] = presetTiles(app.catalog, offeredInstances(presetOffer(project.providers, app.providers))).flatMap((group) => group.tiles.flatMap((tile) =>
    (tile.efforts.length === 0 ? [null] : tile.efforts.map((effort) => effort.id)).map((effort) => ({ providerId: group.provider.id, instanceId: group.provider.instanceId, model: tile.key, effort, speed: null }))))
    .filter((choice) => savedPresetProblem(choice, app.catalog, app.providers) === null && modelSelectionKey(choice) !== modelSelectionKey(preset)).slice(0, 3);
  for (const choice of [...recentChoices].reverse()) prefs.noteModelUse(choice);
  prefs.noteModelUse({ ...preset, model: 'smoke-unavailable-model' });
  await wait(`document.querySelectorAll('[data-recent-model]').length > 0`);
  let expectedRecents = recentChoices.length;
  const seedRecents = async (count: number): Promise<void> => {
    // Fill only smoke's history, evicting earlier fixture choices without a renderer write API.
    for (let i = 0; i < 12; i += 1) prefs.noteModelUse({ ...preset, model: `smoke-unavailable-${i}` });
    for (const choice of recentChoices.slice(0, count).reverse()) prefs.noteModelUse(choice);
    expectedRecents = count;
    await wait(`(() => {
      const row = document.querySelector('[aria-label="Recent"] > div');
      const columns = row ? Math.max(1, Math.min(3, Math.floor((row.getBoundingClientRect().width - 38 + 12) / 272))) : 3;
      return document.querySelectorAll('[data-recent-model]').length === Math.min(${count}, columns);
    })()`);
  };
  const checkLayout = async (): Promise<void> => {
    const layout = await evaluate<{ recent: number; columns: number; presetRows: number; oneRow: boolean; withinWidth: boolean; gap: number; ordered: boolean }>(`(() => {
      const area = document.querySelector('[data-new-chat-screen]');
      const recent = area.querySelector('[aria-label="Recent"]');
      const presets = area.querySelector('[aria-label="Presets"]');
      const buttons = [...area.querySelectorAll('[data-recent-model]')];
      const saved = [...area.querySelectorAll('[data-preset-id]')];
      const grid = buttons[0]?.parentElement;
      const lower = area.querySelectorAll(':scope > hr')[1];
      const last = recent ?? presets ?? area.querySelector('[data-start-screen]');
      return { recent: buttons.length, columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 3,
        presetRows: new Set(saved.map(node => Math.round(node.getBoundingClientRect().top))).size,
        oneRow: buttons.every(node => Math.abs(node.getBoundingClientRect().top - buttons[0].getBoundingClientRect().top) < 1),
        withinWidth: buttons.every(node => node.getBoundingClientRect().width <= 261 && node.getBoundingClientRect().right <= area.getBoundingClientRect().right),
        gap: lower.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
        ordered: !presets || !recent || Boolean(presets.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING) };
    })()`);
    check(layout.recent === Math.min(expectedRecents, layout.columns) && layout.presetRows <= 2 && layout.oneRow && layout.withinWidth && layout.ordered && layout.gap >= 0 && layout.gap <= 32, `recent layout ${JSON.stringify(layout)}`);
    check(!(await evaluate<boolean>(`[...document.querySelectorAll('[data-recent-model]')].some(node => node.getAttribute('data-recent-model').includes('smoke-unavailable'))`)), 'unavailable recent was shown');
  };
  await checkLayout();
  const recentKey = await evaluate<string>(`document.querySelector('[data-recent-model]').getAttribute('data-recent-model')`);
  const historyBefore = JSON.stringify(prefs.getSnapshot().values.recentModels);
  await evaluate(`document.querySelector('[data-recent-model]').click()`);
  // The composer may already be focused from the previous selection. Wait for the selection's push.
  await wait(`document.querySelector('[data-recent-model][aria-pressed="true"]')?.getAttribute('data-recent-model') === ${JSON.stringify(recentKey)}`);
  await wait(`document.querySelector('[data-new-chat-screen] textarea') === document.activeElement`);
  check(JSON.stringify(prefs.getSnapshot().values.recentModels) === historyBefore, 'a recent click changed usage history');
  check((await ask<ChatRead>('chat:read', { sessionId: id })).status === 'read', 'recent lost its draft');
  check((await evaluate<string>(`document.querySelector('[data-recent-model][aria-pressed="true"]')?.getAttribute('data-recent-model')`)) === recentKey, 'recent selection did not match');
  prefs.flushSync();

  const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
  const original = prefs.getSnapshot().values;
  const bounds = main.getBounds();
  const maximized = main.isMaximized();
  const zoom = main.webContents.getZoomFactor();
  if (directory !== undefined && path.isAbsolute(directory)) {
    mkdirSync(directory, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await ask('prefs:patch', { appearance: { theme }, layout: { projectColumn: theme === 'light' ? 'left' : 'right' } });
      await wait(`document.documentElement.dataset.theme === '${theme}'`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await checkLayout();
      writeFileSync(path.join(directory, `new-chat-${theme}.png`), (await main.webContents.capturePage()).toPNG());
      for (let count = 0; count <= recentChoices.length; count += 1) {
        await seedRecents(count);
        for (const savedCount of [0, 1, 6]) {
          await ask('prefs:patch', { presets: Object.fromEntries(ids.map((key, i) => [key, i < savedCount ? { ...preset, name: `Smoke preset ${i + 1}` } : null])) });
          await wait(`document.querySelectorAll('[data-preset-id]').length === ${savedCount}`);
          await checkLayout();
          writeFileSync(path.join(directory, `new-chat-${theme}-recents-${count}-presets-${savedCount}.png`), (await main.webContents.capturePage()).toPNG());
        }
      }
    }
    await seedRecents(recentChoices.length);
    main.unmaximize();
    main.setSize(900, 700);
    main.webContents.setZoomFactor(1.5);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await checkLayout();
    await evaluate(`document.querySelector('[data-new-chat-screen]').scrollTop = 0`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const fits = await evaluate<boolean>(`(() => { const area = document.querySelector('[data-new-chat-screen]').getBoundingClientRect(); const input = document.querySelector('[data-new-chat-screen] textarea').getBoundingClientRect(); return input.width > 0 && input.left >= area.left && input.right <= area.right; })()`);
    check(fits, 'composer overflows the work area at high zoom');
    writeFileSync(path.join(directory, 'new-chat-narrow-top.png'), (await main.webContents.capturePage()).toPNG());
    await evaluate(`document.querySelector('[data-new-chat-screen]').scrollTop = 10000`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const reachable = await evaluate<boolean>(`(() => { const area = document.querySelector('[data-new-chat-screen]'); return area.lastElementChild.getBoundingClientRect().bottom <= area.getBoundingClientRect().bottom + 1; })()`);
    check(reachable, 'stats cannot be reached by scrolling at high zoom');
    writeFileSync(path.join(directory, 'new-chat-narrow-zoom.png'), (await main.webContents.capturePage()).toPNG());
    main.webContents.setZoomFactor(zoom);
    main.setBounds(bounds);
    if (maximized) main.maximize();
    await ask('prefs:patch', { appearance: { theme: original.appearance.theme }, layout: original.layout });
  }
  await ask('prefs:patch', { presets: Object.fromEntries(ids.map((key) => [key, null])) });
  await wait(`document.querySelector('[aria-label="Presets"]') === null`);
  await checkLayout();
  check(ids.every((key) => !prefs.getSnapshot().values.presetRecency.includes(key)), 'deleted preset retained recency');
  await ask('sessions:remove', { id });
  await wait(`document.querySelector('[data-new-chat-screen]') === null`);
}
