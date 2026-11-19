// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageFileAddress, type ImageRefreshAnswer } from '@shared/contracts/files';
import { sessionEntry, SUMMARIES } from '../../../../../tests/support/sessions';
import { showDetached } from '../../chat/detached-store';
import { ImageFileStrip } from '../../chat/ImageFileStrip';
import { installFakeBridge } from '../../test/fake-bridge';
import { PaneWithKinds } from '../../test/pane';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { BUILT_IN_KINDS } from '../kinds';
import { IMAGE_KIND, openImage, openImageFile } from '../opener';
import { closeTab, resetTabs, selectTab, tabId, useTabs } from '../tabs-store';
import type { ImageViewState } from './ImageBody';

const PROJECT = project('Images');
const SESSION = sessionEntry('Edit image', SUMMARIES.idle, { projectId: PROJECT.id });
const S = SESSION.record.id;
const PATH = 'C:\\tmp\\preview.png';
const IMAGE = { path: PATH, id: 'a'.repeat(32), width: 640, height: 480 };
const NEXT = { ...IMAGE, id: 'b'.repeat(32), width: 700 };
let requests: unknown[];
let answer: ImageRefreshAnswer;
let hidden: boolean;
let withhold: boolean;
let waiting: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2020-02-28T18:00:00Z'));
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  requests = [];
  answer = { outcome: 'unchanged' };
  withhold = false;
  waiting = [];
  const bridge = installFakeBridge('win32');
  bridge.setInvoke((channel, request) => {
    if (channel === 'files:read') return Promise.resolve({ ok: true, value: { outcome: 'image', ...IMAGE } });
    if (channel !== 'files:refreshImage') return Promise.resolve({ ok: true, value: null });
    requests.push(request);
    const reply = { ok: true, value: answer };
    return withhold ? new Promise((resolve) => { waiting.push(() => resolve(reply)); }) : Promise.resolve(reply);
  });
  resetTabs();
  showDetached(null);
  render(<PaneWithKinds kinds={BUILT_IN_KINDS} />);
  act(() => { showState({ projects: [PROJECT], sessions: [SESSION], selectedId: S }); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

const open = () => act(() => { openImageFile(S, IMAGE); });
const advance = (ms = 2_000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const panel = () => screen.getByRole('tabpanel');
const status = () => panel().querySelector('[data-file-refresh]');
const candidate = () => panel().querySelector<HTMLImageElement>('[data-image-refresh-candidate]');
const viewState = () => useTabs.getState().sessions[S]?.tabs.find((tab) => tab.id === tabId(IMAGE_KIND, { path: PATH }))?.viewState as ImageViewState;
const visibility = (value: boolean) => act(() => { hidden = value; fireEvent(document, new Event('visibilitychange')); });
const load = () => act(() => { const image = candidate(); if (image === null) throw new Error('no candidate'); fireEvent.load(image); });

describe('visible image artifacts', () => {
  it('does not poll image thumbnails in the chat', async () => {
    render(<ImageFileStrip sessionId={S} targets={[{ target: PATH, name: 'preview.png' }]} missing={false} tabIndex={0} />);
    await advance(10_000);
    expect(screen.getByRole('img', { name: 'preview.png' })).toBeTruthy();
    expect(requests).toEqual([]);
  });

  it('polls only the shown file and leaves unchanged images and their clock alone', async () => {
    open();
    const image = screen.getByRole('img', { name: 'preview.png' });
    await advance();
    expect(requests).toEqual([{ sessionId: S, path: PATH, id: IMAGE.id }]);
    expect(screen.getByRole('img', { name: 'preview.png' })).toBe(image);
    expect(status()).toBeNull();
    expect(candidate()).toBeNull();
  });

  it('keeps the current image until its replacement loads, then shows the update time and age', async () => {
    open();
    const toggle = screen.getByRole('button', { name: 'Show at actual size' });
    fireEvent.click(toggle);
    toggle.focus();
    const scroller = panel().querySelector('[data-image-tab] > div:last-child') as HTMLElement;
    scroller.scrollTop = 35;
    const original = screen.getByRole('img', { name: 'preview.png' });
    answer = { outcome: 'image', ...NEXT };
    await advance();
    expect(candidate()?.getAttribute('src')).toBe(imageFileAddress(NEXT.id));
    expect(original.getAttribute('src')).toBe(imageFileAddress(IMAGE.id));
    expect(status()).toBeNull();
    load();
    expect(screen.getByRole('img', { name: 'preview.png' }).getAttribute('src')).toBe(imageFileAddress(NEXT.id));
    expect(status()?.textContent).toMatch(/^Auto-updated at .+ · seconds ago$/);
    expect(viewState()).toMatchObject({ actual: true, autoUpdatedAt: Date.now(), display: { file: NEXT.id, width: 700 } });
    expect(document.activeElement).toBe(toggle);
    expect(scroller.scrollTop).toBe(35);
    answer = { outcome: 'unchanged' };
    const at = viewState().autoUpdatedAt;
    await advance(60_000);
    expect(status()?.textContent).toContain('1 minute ago');
    expect(viewState().autoUpdatedAt).toBe(at);
    expect(requests.at(-1)).toMatchObject({ id: NEXT.id });
  });

  it('preserves the old pixels after a decode failure and retries without claiming an update', async () => {
    open();
    const original = screen.getByRole('img', { name: 'preview.png' });
    answer = { outcome: 'image', ...NEXT };
    await advance();
    fireEvent.error(candidate() as HTMLImageElement);
    expect(screen.getByRole('img', { name: 'preview.png' })).toBe(original);
    expect(status()?.textContent).toBe('auto refresh failed');
    expect(viewState().autoUpdatedAt).toBeUndefined();
    await advance();
    load();
    expect(status()?.textContent).toMatch(/^Auto-updated/);
  });

  it.each(['not-found', 'outside', 'no-answer', 'not-image'] as const)('keeps the shown image through %s and recovers quietly', async (why) => {
    open();
    const original = screen.getByRole('img', { name: 'preview.png' });
    answer = { outcome: 'refused', why };
    await advance(6_000);
    expect(screen.getByRole('img', { name: 'preview.png' })).toBe(original);
    expect(status()?.textContent).toBe('auto refresh failed');
    answer = { outcome: 'unchanged' };
    await advance();
    expect(status()).toBeNull();
    expect(viewState().autoUpdatedAt).toBeUndefined();
  });

  it('pauses while hidden and checks immediately on return', async () => {
    open();
    visibility(true);
    await advance(10_000);
    expect(requests).toEqual([]);
    visibility(false);
    await advance(0);
    expect(requests).toHaveLength(1);
    await advance();
    expect(requests).toHaveLength(2);
  });

  it('discards an outstanding result when hidden and holds at most one request', async () => {
    open();
    withhold = true;
    answer = { outcome: 'image', ...NEXT };
    await advance(10_000);
    expect(requests).toHaveLength(1);
    visibility(true);
    await act(async () => { waiting.splice(0).forEach((finish) => finish()); await Promise.resolve(); });
    expect(candidate()).toBeNull();
    expect(status()).toBeNull();
    withhold = false;
    visibility(false);
    await advance(0);
    expect(candidate()).not.toBeNull();
  });

  it('drops a candidate that finishes after the window is hidden', async () => {
    open();
    answer = { outcome: 'image', ...NEXT };
    await advance();
    const image = candidate() as HTMLImageElement;
    visibility(true);
    fireEvent.load(image);
    expect(viewState().autoUpdatedAt).toBeUndefined();
    expect(viewState().display?.file).toBe(IMAGE.id);
  });

  it('stops on tab changes, retains the timestamp on return, and drops it when closed', async () => {
    open();
    answer = { outcome: 'image', ...NEXT };
    await advance();
    load();
    const at = viewState().autoUpdatedAt;
    act(() => { openImage(S, 'c'.repeat(64), { name: 'stored.png', width: 10, height: 10, available: true, ordinal: 1 }); });
    const count = requests.length;
    await advance(10_000);
    expect(requests).toHaveLength(count);
    act(() => { selectTab(S, tabId(IMAGE_KIND, { path: PATH })); });
    expect(status()?.textContent).toMatch(/^Auto-updated/);
    expect(viewState().autoUpdatedAt).toBe(at);
    act(() => { closeTab(S, tabId(IMAGE_KIND, { path: PATH })); });
    open();
    expect(status()).toBeNull();
  });

  it('ignores a late read after changing tabs or reopening the same image explicitly', async () => {
    open();
    answer = { outcome: 'image', ...NEXT };
    withhold = true;
    await advance();
    open();
    await act(async () => { waiting.splice(0).forEach((finish) => finish()); await Promise.resolve(); });
    expect(candidate()).toBeNull();
    expect(viewState().display?.file).toBe(IMAGE.id);
    await advance();
    act(() => { openImage(S, 'c'.repeat(64), { name: 'stored.png', width: 10, height: 10, available: true, ordinal: 1 }); });
    await act(async () => { waiting.splice(0).forEach((finish) => finish()); await Promise.resolve(); });
    expect(candidate()).toBeNull();
    expect(within(panel()).getByRole('img', { name: 'stored.png' })).toBeTruthy();
  });
});
