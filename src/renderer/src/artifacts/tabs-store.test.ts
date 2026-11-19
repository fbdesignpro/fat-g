// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M19b.md; C4, C6–C8): a session's tabs, in the page's memory. The store names no
// kind: these tests give it one of their own.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBridge } from '../test/fake-bridge';
import { tabKind } from './tab-kind';
import { canonical, closeTab, keepSessions, openTab, registerKinds, resetTabs, selectTab, setTitle, setViewState, tabId, takeHanded, useTabs } from './tabs-store';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const note = tabKind<{ readonly note: string; readonly extra?: number }, { readonly line?: number; readonly top?: number }>({
  id: 'note',
  // Two of one note tell themselves apart by what else they hold.
  title: (reference, others) => (others.some((other) => other.note === reference.note) ? `${reference.note} (${reference.extra ?? 0})` : reference.note),
  Body: () => null,
});
const other = tabKind<string, never>({ id: 'other', title: (reference) => `other ${reference}`, Body: () => null });
/** A kind whose tabs stay (M106, C2). */
const pinned = tabKind<string, never>({ id: 'pinned', title: (reference) => `pinned ${reference}`, Body: () => null, closable: false });

const tabs = (session: string) => useTabs.getState().sessions[session];
const titles = (session: string) => tabs(session)?.tabs.map((tab) => tab.title) ?? [];
const selected = (session: string) => tabs(session)?.tabs.find((tab) => tab.id === tabs(session)?.selected)?.title ?? null;
const idOf = (session: string, title: string): string => tabs(session)?.tabs.find((tab) => tab.title === title)?.id ?? '';

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  bridge = installFakeBridge();
  resetTabs();
  registerKinds([note, other, pinned]);
});

describe('a session’s tabs (C6–C8)', () => {
  it('waits for cleanup, ignores repeated closes, and keeps the tab on failure', async () => {
    let finish!: (close: boolean) => void;
    const beforeClose = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    registerKinds([{ ...other, beforeClose }]);
    openTab(A, 'other', 'one');
    const id = idOf(A, 'other one');
    closeTab(A, id);
    closeTab(A, id);
    expect(beforeClose).toHaveBeenCalledExactlyOnceWith(A, 'one');
    expect(titles(A)).toEqual(['other one']);
    finish(false);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(titles(A)).toEqual(['other one']);
    closeTab(A, id);
    finish(true);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(titles(A)).toEqual([]);
  });

  it('does not close a replacement tab when an old cleanup finishes', async () => {
    let finish!: (close: boolean) => void;
    registerKinds([{ ...other, beforeClose: () => new Promise<boolean>((resolve) => { finish = resolve; }) }]);
    openTab(A, 'other', 'one');
    closeTab(A, idOf(A, 'other one'));
    keepSessions(new Set());
    openTab(A, 'other', 'one');
    finish(true);
    await Promise.resolve();
    expect(titles(A)).toEqual(['other one']);
  });

  it('starts with none', () => {
    expect(useTabs.getState()).toEqual({ sessions: {} });
  });

  it('puts a new tab after the last and selects it, in the order they were opened', () => {
    for (const name of ['one', 'two', 'three']) expect(openTab(A, 'note', { note: name })).toBe(true);
    expect(titles(A)).toEqual(['one', 'two', 'three']);
    expect(selected(A)).toBe('three');
  });

  it('keeps each session’s own tabs and its own selected tab', () => {
    openTab(A, 'note', { note: 'a1' });
    openTab(A, 'note', { note: 'a2' });
    openTab(B, 'note', { note: 'b1' });
    selectTab(A, idOf(A, 'a1'));
    expect([titles(A), selected(A)]).toEqual([['a1', 'a2'], 'a1']);
    expect([titles(B), selected(B)]).toEqual([['b1'], 'b1']);
  });

  it('opens what is open by selecting it: one tab for a kind and a reference', () => {
    openTab(A, 'note', { note: 'one' });
    openTab(A, 'note', { note: 'two' });
    openTab(A, 'note', { note: 'one' });
    expect(titles(A)).toEqual(['one', 'two']);
    expect(selected(A)).toBe('one');
    // Another kind with the same reference is another tab.
    openTab(A, 'other', 'one');
    expect(titles(A)).toEqual(['one', 'two', 'other one']);
  });

  it('knows a reference by its value, whatever order its keys were written in', () => {
    openTab(A, 'note', { note: 'one', extra: 1 });
    openTab(A, 'note', { extra: 1, note: 'one' });
    expect(titles(A)).toHaveLength(1);
    expect(canonical({ b: [1, { d: 2, c: 3 }], a: null })).toBe('{"a":null,"b":[1,{"c":3,"d":2}]}');
    expect(tabId('note', { note: 'x', extra: 2 })).toBe(tabId('note', { extra: 2, note: 'x' }));
    expect(tabId('note', 'x')).not.toBe(tabId('other', 'x'));
  });

  it('selects the tab after the one closed, else the one before, and leaves another selection as it is', () => {
    for (const name of ['one', 'two', 'three']) openTab(A, 'note', { note: name });
    selectTab(A, idOf(A, 'two'));
    closeTab(A, idOf(A, 'two'));
    expect([titles(A), selected(A)]).toEqual([['one', 'three'], 'three']);
    closeTab(A, idOf(A, 'three'));
    expect([titles(A), selected(A)]).toEqual([['one'], 'one']);
    openTab(A, 'note', { note: 'four' });
    closeTab(A, idOf(A, 'one'));
    expect(selected(A)).toBe('four');
    closeTab(A, idOf(A, 'four'));
    expect(tabs(A)).toBeUndefined();
  });

  // M100 (round 8; C78): a tab that opens by itself goes first, and takes the view from no tab that is shown.
  it('puts a tab first where asked, and leaves the shown tab selected where asked not to select', () => {
    openTab(A, 'note', { note: 'one' });
    openTab(A, 'note', { note: 'two' });
    selectTab(A, idOf(A, 'one'));
    expect(openTab(A, 'other', 'own', { select: false, first: true })).toBe(true);
    expect([titles(A), selected(A)]).toEqual([['other own', 'one', 'two'], 'one']);
    // Open already: neither moved nor selected.
    openTab(A, 'other', 'own', { select: false, first: true });
    expect([titles(A), selected(A)]).toEqual([['other own', 'one', 'two'], 'one']);
    // A session that shows no tab shows it.
    openTab(B, 'other', 'own', { select: false, first: true });
    expect([titles(B), selected(B)]).toEqual([['other own'], 'other own']);
    // Opened again at a press, it is selected as any tab is.
    openTab(A, 'other', 'own');
    expect(selected(A)).toBe('other own');
  });

  it('refuses a kind the page does not have, and ignores a tab or a session that is not there', () => {
    expect(openTab(A, 'plan', 'x')).toBe(false);
    expect(useTabs.getState()).toEqual({ sessions: {} });
    const before = useTabs.getState();
    selectTab(A, 'nothing');
    closeTab(A, 'nothing');
    setViewState(A, 'nothing', {});
    setTitle(A, 'nothing', 'x');
    expect(takeHanded(A, 'nothing')).toBeUndefined();
    expect(useTabs.getState()).toBe(before);
  });

  // M106 (V6; C2): a kind says whether its tabs close.
  it('carries its kind’s word on whether it closes, and leaves a tab that does not where it is', () => {
    openTab(A, 'pinned', 'x');
    openTab(A, 'other', 'y');
    expect(tabs(A)?.tabs.map((tab) => [tab.title, tab.closable])).toEqual([['pinned x', false], ['other y', true]]);
    const before = useTabs.getState();
    closeTab(A, idOf(A, 'pinned x'));
    expect(useTabs.getState()).toBe(before);
    closeTab(A, idOf(A, 'other y'));
    expect(titles(A)).toEqual(['pinned x']);
    // It goes with its session alone.
    keepSessions(new Set());
    expect(tabs(A)).toBeUndefined();
  });
});

describe('a tab’s title (C4, C5, C36)', () => {
  it('is what its kind gives its reference, asked again when the session’s tabs change', () => {
    openTab(A, 'note', { note: 'log', extra: 1 });
    expect(titles(A)).toEqual(['log']);
    openTab(A, 'note', { note: 'log', extra: 2 });
    expect(titles(A)).toEqual(['log (1)', 'log (2)']);
    closeTab(A, idOf(A, 'log (2)'));
    expect(titles(A)).toEqual(['log']);
    // Another session's tab of the same name changes nothing here.
    openTab(B, 'note', { note: 'log', extra: 3 });
    expect([titles(A), titles(B)]).toEqual([['log'], ['log']]);
  });

  it('is the one its body set while it was shown, from then on', () => {
    openTab(A, 'note', { note: 'one' });
    setTitle(A, idOf(A, 'one'), 'Renamed');
    expect(titles(A)).toEqual(['Renamed']);
    openTab(A, 'note', { note: 'two' });
    expect(titles(A)).toEqual(['Renamed', 'two']);
  });
});

describe('a tab’s view state, and what was read for it (C5, C8, C32)', () => {
  it('keeps what its kind set, for as long as the tab is open', () => {
    openTab(A, 'note', { note: 'one' });
    const id = idOf(A, 'one');
    expect(tabs(A)?.tabs[0]?.viewState).toBeNull();
    setViewState(A, id, { top: 240 });
    openTab(A, 'note', { note: 'two' });
    expect(tabs(A)?.tabs[0]?.viewState).toEqual({ top: 240 });
  });

  it('puts a later opening’s view state over it: an open file’s line moves, and its place stays', () => {
    openTab(A, 'note', { note: 'one' }, { viewState: { line: 12 } });
    setViewState(A, idOf(A, 'one'), { line: 12, top: 240 });
    openTab(A, 'note', { note: 'one' }, { viewState: { line: 40 } });
    expect(tabs(A)?.tabs[0]?.viewState).toEqual({ line: 40, top: 240 });
    // An opening that names none leaves it.
    openTab(A, 'note', { note: 'one' });
    expect(tabs(A)?.tabs[0]?.viewState).toEqual({ line: 40, top: 240 });
  });

  it('hands a tab what was read for it once: it is dropped as it is taken', () => {
    openTab(A, 'note', { note: 'one' }, { handed: { text: 'the answer' } });
    const id = idOf(A, 'one');
    expect(takeHanded(A, id)).toEqual({ text: 'the answer' });
    expect(takeHanded(A, id)).toBeUndefined();
    expect(JSON.stringify(useTabs.getState())).not.toContain('the answer');
    // A later opening of the open tab hands it a fresh one.
    openTab(A, 'note', { note: 'one' }, { handed: { text: 'read again' } });
    expect(takeHanded(A, id)).toEqual({ text: 'read again' });
  });
});

describe('what is kept, and what is not (C6, C7)', () => {
  it('drops the tabs of a session that is no longer listed, and keeps every other session’s', () => {
    openTab(A, 'note', { note: 'a1' });
    openTab(B, 'note', { note: 'b1' });
    keepSessions(new Set([A, B]));
    expect(Object.keys(useTabs.getState().sessions)).toEqual([A, B]);
    keepSessions(new Set([B]));
    expect(Object.keys(useTabs.getState().sessions)).toEqual([B]);
    const before = useTabs.getState();
    keepSessions(new Set([B, 'cccccccc-0000-4000-8000-00000000000c']));
    expect(useTabs.getState()).toBe(before);
  });

  it('asks main for nothing and stores nothing: the tabs are the page’s memory, for the run', () => {
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    openTab(A, 'note', { note: 'one' }, { viewState: { line: 3 }, handed: 'x' });
    setViewState(A, idOf(A, 'one'), { top: 9 });
    setTitle(A, idOf(A, 'one'), 'Renamed');
    selectTab(A, idOf(A, 'Renamed'));
    closeTab(A, idOf(A, 'Renamed'));
    expect(bridge.calls).toEqual([]);
    expect(stored).not.toHaveBeenCalled();
    stored.mockRestore();
    // A new run is a new page: its store holds none.
    resetTabs();
    expect(useTabs.getState()).toEqual({ sessions: {} });
  });
});
