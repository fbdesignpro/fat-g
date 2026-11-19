// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { sampleProvider } from '../../../tests/support/app-state';
import { sampleCatalog } from '../../../tests/support/catalog';
import { createAppStateStore } from './app-state-store';

describe('AppStateStore', () => {
  it('starts empty and light at seq 0', () => {
    expect(createAppStateStore().getSnapshot()).toEqual({ seq: 0, appearance: { theme: 'light' }, providers: [] });
  });

  it('starts in the appearance it is given', () => {
    expect(createAppStateStore({ appearance: { theme: 'dark' } }).getSnapshot().appearance).toEqual({ theme: 'dark' });
  });

  it('bumps seq by exactly one per change and hands out a new snapshot each time', () => {
    const store = createAppStateStore();
    const first = store.getSnapshot();
    store.updateProviders(() => [sampleProvider()]);
    const second = store.getSnapshot();
    store.updateProviders((providers) => [...providers]);

    expect([first.seq, second.seq, store.getSnapshot().seq]).toEqual([0, 1, 2]);
    expect(second).not.toBe(first);
    expect(first.providers).toEqual([]); // earlier snapshots are never mutated
  });

  it('treats a recipe that returns the same array as "no change"', () => {
    const store = createAppStateStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.updateProviders((providers) => providers);

    expect(store.getSnapshot().seq).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('tells every subscriber about each change, and stops after unsubscribe', () => {
    const store = createAppStateStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribeA = store.subscribe(a);
    store.subscribe(b);

    store.updateProviders(() => [sampleProvider()]);
    unsubscribeA();
    store.updateProviders(() => []);

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }));
    expect(b).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenLastCalledWith({ seq: 2, appearance: { theme: 'light' }, providers: [] });
  });
});

describe('setAppearance', () => {
  it('changes the theme as a change like any other, keeping the providers', () => {
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider()]);
    const before = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setAppearance({ theme: 'dark' });

    expect(store.getSnapshot()).toEqual({ seq: 2, appearance: { theme: 'dark' }, providers: before.providers });
    expect(store.getSnapshot().providers).toBe(before.providers);
    expect(before.appearance.theme).toBe('light'); // never mutated
    expect(listener).toHaveBeenCalledOnce();
  });

  it('treats the same theme again as "no change"', () => {
    const store = createAppStateStore({ appearance: { theme: 'dark' } });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setAppearance({ theme: 'dark' });
    expect(store.getSnapshot().seq).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('setRecords (M12)', () => {
  it('replaces the records as a change like any other, keeping the rest', () => {
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider()]);
    const listener = vi.fn();
    store.subscribe(listener);
    const records = { status: { kind: 'ok', keptAs: null }, projects: [] } as const;
    store.setRecords(records);
    expect(store.getSnapshot()).toMatchObject({ seq: 2, records, providers: [expect.objectContaining({ id: 'claude' })] });
    expect(listener).toHaveBeenCalledOnce();
    store.setAppearance({ theme: 'dark' });
    expect(store.getSnapshot().records).toBe(records);
  });
});

describe('setCatalog (M13, C50)', () => {
  it('replaces the catalog as a change like any other, and the same object again is no change', () => {
    const store = createAppStateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const catalog = sampleCatalog(['claude']);
    store.setCatalog(catalog);
    store.setCatalog(catalog);
    expect(store.getSnapshot()).toMatchObject({ seq: 1, catalog });
    expect(listener).toHaveBeenCalledOnce();
    store.setCatalog(sampleCatalog(['claude']));
    expect(store.getSnapshot().seq).toBe(2);
  });
});

describe('setSessions and setQuitQuestion (M14, C24, C65, C100)', () => {
  it('replaces the sessions as a change like any other, and the same object again is no change', () => {
    const store = createAppStateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const sessions = { sessions: [], selectedId: null, orphans: 0 } as const;
    store.setSessions(sessions);
    store.setSessions(sessions);
    expect(store.getSnapshot()).toMatchObject({ seq: 1, sessions });
    expect(listener).toHaveBeenCalledOnce();
    store.setSessions({ ...sessions, orphans: 2 });
    expect(store.getSnapshot()).toMatchObject({ seq: 2, sessions: { orphans: 2 } });
  });

  it('holds no question until one is asked, and the same answer again is no change', () => {
    const store = createAppStateStore();
    expect('quitQuestion' in store.getSnapshot()).toBe(false);
    store.setQuitQuestion(false);
    expect(store.getSnapshot().seq).toBe(0);
    store.setQuitQuestion(true);
    store.setQuitQuestion(true);
    expect(store.getSnapshot()).toMatchObject({ seq: 1, quitQuestion: true });
    store.setQuitQuestion(false);
    expect(store.getSnapshot()).toMatchObject({ seq: 2, quitQuestion: false });
  });
});

describe('setZoom', () => {
  it('holds no zoom until the Main window has loaded, and the same zoom again is no change', () => {
    const store = createAppStateStore();
    const listener = vi.fn();
    store.subscribe(listener);
    expect('zoom' in store.getSnapshot()).toBe(false);
    store.setZoom(90);
    store.setZoom(90);
    expect(store.getSnapshot()).toMatchObject({ seq: 1, zoom: 90 });
    expect(listener).toHaveBeenCalledOnce();
    store.setZoom(100);
    expect(store.getSnapshot()).toMatchObject({ seq: 2, zoom: 100 });
  });
});
