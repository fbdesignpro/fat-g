// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Synthetic status frames through real main state, preload, React and Chromium's compositor.
import type { BrowserWindow } from 'electron';
import type { ModelPreset } from '@shared/contracts/presets';
import type { SessionService } from '../sessions/service';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface Frame { readonly time: number; readonly rate: number; readonly cycle: number }
export async function checkStateStreams(main: BrowserWindow, pet: BrowserWindow, sessions: SessionService, projectId: string, preset: ModelPreset): Promise<string> {
  const selected = sessions.snapshot().selectedId;
  const miniVisible = pet.isVisible();
  pet.showInactive();
  const made = await sessions.create(projectId, preset, 'Synthetic M105 states');
  if (made.status !== 'saved') throw new Error('M105 smoke session could not be created');
  const id = made.id;
  const turnId = 'm105-smoke-turn';
  let otherId: string | null = null;
  const bar = '[data-status-bar]';
  const mini = `[data-pet-session="${id}"]`;
  const send = (event: Record<string, unknown>): void => sessions.apply({ sessionId: id, ...(String(event['type']).startsWith('request-') ? {} : { turnId }), ...event });
  const sample = async (window: BrowserWindow, selector = bar): Promise<Frame[]> => await window.webContents.executeJavaScript(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)})?.querySelector('[data-status-stream]');
    return field ? [...field.children].flatMap((light) => light.getAnimations().map((a) => ({time: Number(a.currentTime), rate: a.playbackRate, cycle: Number(a.effect.getTiming().duration)}))) : [];
  })()`) as Frame[];
  const rates = async (window: BrowserWindow, rate: number, selector = bar): Promise<void> => {
    const frames = await sample(window, selector);
    if (frames.length !== 24 || frames.some((frame) => Math.abs(frame.rate - rate) > 0.001)) throw new Error(`M105 compositor expected 24 animations at ${rate}: ${JSON.stringify(frames)}`);
  };
  const mainWaitRates = async (): Promise<void> => {
    const width = await main.webContents.executeJavaScript(`document.querySelector('${bar} [data-status-stream]')?.clientWidth`) as number;
    if (!(width > 0)) throw new Error('M105 waiting bar has no width');
    // Quarter speed at 200 CSS pixels; wider bars keep the same visible waiting pace.
    await rates(main, Math.min(0.25, 50 / width));
  };
  const waitFor = async (test: () => Promise<boolean>): Promise<void> => {
    for (let tries = 0; tries < 100; tries += 1) { if (await test()) return; await delay(50); }
    throw new Error('M105 status did not reach the page');
  };
  try {
    await sessions.select(id);
    send({ type: 'turn-started' });
    await waitFor(async () => (await sample(main)).length === 24);
    await delay(1200);
    await rates(main, 1);
    send({ type: 'action-changed', kind: 'waiting', wait: { reason: 'subagents', count: 2 } });
    await waitFor(async () => await main.webContents.executeJavaScript(`document.querySelector('${bar}')?.textContent.includes('Waiting for 2 sub-agents')`) as boolean);
    await delay(1200);
    await mainWaitRates();
    await rates(pet, 0.25, mini);
    const other = await sessions.create(projectId, preset, 'Synthetic M105 busy');
    if (other.status !== 'saved') throw new Error('M105 busy session could not be created');
    otherId = other.id;
    await sessions.select(id);
    sessions.apply({ sessionId: otherId, type: 'turn-started', turnId: 'm105-smoke-busy' });
    await delay(1200);
    const beforeSwitch = await sample(main);
    await sessions.select(otherId);
    await delay(100);
    const switched = await sample(main);
    if (switched.length !== 24 || switched.some((frame, index) => {
      const difference = Math.abs(frame.time - (beforeSwitch[index]?.time ?? NaN)) % frame.cycle;
      return Math.min(difference, frame.cycle - difference) > 250;
    })) throw new Error('M105 session switch moved the compositor phase');
    await delay(1200);
    await rates(main, 1);
    await sessions.select(id);
    await delay(1200);
    await mainWaitRates();
    const slow = await sample(main);
    send({ type: 'action-changed', kind: 'reading', file: 'synthetic.txt' });
    await delay(80);
    const transition = await sample(main);
    if (transition.some((frame, index) => Math.abs(frame.time - (slow[index]?.time ?? NaN)) > 250)) throw new Error('M105 pace change reset compositor position');
    await delay(1200);
    await rates(main, 1);
    send({ type: 'action-changed', kind: 'thinking' });
    await waitFor(async () => await main.webContents.executeJavaScript(`document.querySelector('${bar}')?.getAttribute('aria-label')?.startsWith('Thinking')`) as boolean);
    await delay(450);
    await waitFor(async () => await main.webContents.executeJavaScript(`document.querySelector('${bar}')?.textContent.includes('Thinking')`) as boolean);
    send({ type: 'action-changed', kind: 'waiting', wait: { reason: 'provider' } });
    await delay(1200);
    await mainWaitRates();
    send({ type: 'request-raised', owner: { turnId }, requestId: 'm105-question', kind: 'question', count: 1 });
    await delay(150);
    const stopped = await sample(main);
    await delay(150);
    const still = await sample(main);
    if (still.some((frame, index) => frame.time !== stopped[index]?.time)) throw new Error('M105 decision did not pause the stream immediately');
    send({ type: 'request-resolved', owner: { turnId }, requestId: 'm105-question' });
    await delay(1200);
    await mainWaitRates();
    // A live preference change removes CSS animations and leaves no hook ramp to revive them.
    main.webContents.debugger.attach('1.3');
    try {
      await main.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await delay(150);
      if ((await sample(main)).length !== 0) throw new Error('M105 reduced motion left animations running');
      await main.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await delay(150);
      await mainWaitRates();
    } finally { main.webContents.debugger.detach(); }
    return '24 compositor animations: full work pace, width-adjusted waiting, continuous position, unchanged mini pace, semantic fallback, immediate decision pause, live reduced motion';
  } finally {
    if (otherId !== null) {
      sessions.apply({ sessionId: otherId, type: 'turn-ended', turnId: 'm105-smoke-busy', outcome: 'completed' });
      await sessions.settled();
      await sessions.remove(otherId);
    }
    send({ type: 'turn-ended', outcome: 'completed' });
    await sessions.settled();
    await sessions.remove(id);
    if (selected !== null) await sessions.select(selected);
    if (!miniVisible) pet.hide();
  }
}
