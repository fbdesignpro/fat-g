// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9 (docs/planning/_archive/M20b.md; C41, C44, C45, C48, C50): fat-g's own context menu on a selection, in
// the chat area as the app draws it — what opens it, what it holds, what its items do, and that
// nothing of it leaves the page but the ask itself.
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AsideSource } from '@shared/contracts/aside';
import type { ChatAskRequest } from '@shared/contracts/chat';
import { ASIDE_KIND } from '../artifacts/opener';
import { type AsideStage, asideStage, CODEX_ASIDES, session } from '../test/asides';
import { chatItem } from '../test/chat';
import { ASIDE_WORDS } from '../artifacts/aside/words';
import { SELECTION_MENU } from './SelectionMenu';

const ONE = session('Create plan');
const ID = ONE.record.id;
const ANSWER = 'The tide table lists **high** and low water.\n\nIt is read each morning.';

let stage: AsideStage;
let written: string[];
beforeEach(() => {
  stage = asideStage();
  written = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
});
afterEach(() => { document.getSelection()?.removeAllRanges(); cleanup(); });

/** A chat with a prompt and two answers, which can be asked beside. */
async function open(asking = CODEX_ASIDES, pane = false) {
  const chat = stage.chat(ONE);
  chat.items = [chatItem(ID, 'user', 'What does the table list?', { id: 'prompt-1' }), chatItem(ID, 'assistant', ANSWER, { id: 'answer-1' }), chatItem(ID, 'assistant', 'A second answer.', { id: 'answer-2' })];
  chat.revision = 3;
  chat.asking = asking;
  await stage.open([ONE], ONE, pane);
}
const list = () => screen.getByRole('group', { name: 'Messages' });
function textOf(words: string, root: ParentNode = document.body): Text {
  const walker = document.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if ((node as Text).data.includes(words)) return node as Text;
  throw new Error(`nothing drawn holds ${words}`);
}
function select(from: string, to: string = from): void {
  const range = document.createRange();
  const start = textOf(from);
  const end = textOf(to);
  range.setStart(start, start.data.indexOf(from));
  range.setEnd(end, end.data.indexOf(to) + to.length);
  const selection = document.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
}
/** A press of the right button on what holds `words`: whether the page took the event as its own. */
const rightPress = (words: string): boolean => !fireEvent.contextMenu(textOf(words).parentElement as Element, { button: 2, clientX: 40, clientY: 60 });
/**
 * Selects, then presses the right button on the selection. jsdom collapses a selection when a
 * button takes the focus, which a browser does not: each press here is given its selection again.
 */
const pressOn = (from: string, to: string = from): boolean => { select(from, to); return rightPress(from); };
const menu = () => screen.queryByRole('menu', { name: SELECTION_MENU.label });
const items = () => within(menu() as HTMLElement).getAllByRole('menuitem').map((item) => item.textContent);
const asks = () => stage.sent('chat:ask') as ChatAskRequest[];

describe('what opens it (C44)', () => {
  it('opens on a selection by the right button, holding Copy and Explain this, as a menu that has the focus itself and marks no item', async () => {
    await open();
    select('tide table');
    expect(rightPress('tide table')).toBe(true);
    expect(menu()).not.toBeNull();
    expect(items()).toEqual([SELECTION_MENU.copy, SELECTION_MENU.explain, SELECTION_MENU.sendToSideChat]);
    // Opened by the pointer, no item is marked before the pointer is over one: the focus is the menu's own.
    expect(document.activeElement).toBe(menu());
    // Drawn in the page, out of the shell.
    expect(menu()?.closest('main')).toBeNull();
    // A press on it is kept from ending the selection it was opened on: the mouse button's own doing is prevented.
    expect(fireEvent.mouseDown(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.copy }))).toBe(false);
  });

  it('opens by Shift+F10 and by the Menu key, with no pointer, its first item focused', async () => {
    await open();
    for (const key of [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
      select('each morning');
      expect(fireEvent.keyDown(list(), key), key.key).toBe(false);
      expect(items(), key.key).toEqual([SELECTION_MENU.copy, SELECTION_MENU.explain, SELECTION_MENU.sendToSideChat]);
      expect(document.activeElement?.textContent, key.key).toBe(SELECTION_MENU.copy);
      fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' });
      expect(menu(), key.key).toBeNull();
    }
    // F10 alone is not the menu's key.
    select('each morning');
    expect(fireEvent.keyDown(list(), { key: 'F10' })).toBe(true);
    expect(menu()).toBeNull();
  });

  it('does not open without a selection, on one that is only white space, or on a field’s own: the event is left as it was', async () => {
    await open();
    expect(rightPress('tide table')).toBe(false);
    expect(menu()).toBeNull();
    expect(fireEvent.keyDown(list(), { key: 'ContextMenu' })).toBe(true);
    // A selection in the page, and the press in the composer's field: the field's own menu is the field's.
    select('tide table');
    const field = screen.getByRole('textbox', { name: 'Message to Codex' });
    expect(fireEvent.contextMenu(field, { button: 2 })).toBe(true);
    expect(menu()).toBeNull();
  });

  it('closes by Escape, giving the focus back, by a press elsewhere and by Tab; a press on the menu keeps it', async () => {
    await open();
    list().focus();
    pressOn('tide table');
    fireEvent.pointerDown(menu() as HTMLElement);
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(list());

    pressOn('tide table');
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();

    pressOn('tide table');
    fireEvent.keyDown(menu() as HTMLElement, { key: 'Tab' });
    expect(menu()).toBeNull();
  });

  it('moves among its items by the arrow keys, Home and End', async () => {
    await open();
    select('each morning');
    fireEvent.keyDown(list(), { key: 'ContextMenu' });
    const focused = () => document.activeElement?.textContent;
    expect(focused()).toBe(SELECTION_MENU.copy);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowDown' });
    expect(focused()).toBe(SELECTION_MENU.explain);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowDown' });
    expect(focused()).toBe(SELECTION_MENU.sendToSideChat);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowDown' });
    expect(focused()).toBe(SELECTION_MENU.copy);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowUp' });
    expect(focused()).toBe(SELECTION_MENU.sendToSideChat);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'Home' });
    expect(focused()).toBe(SELECTION_MENU.copy);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'End' });
    expect(focused()).toBe(SELECTION_MENU.sendToSideChat);
  });

  it('goes from no item, opened by the right button: Down to its first item, Up to its last', async () => {
    await open();
    pressOn('tide table');
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe(SELECTION_MENU.copy);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' });
    pressOn('tide table');
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe(SELECTION_MENU.sendToSideChat);
  });

  it('has one current item: the pointer over an item gives it the focus, as an arrow key does', async () => {
    await open();
    select('tide table');
    rightPress('tide table');
    const focused = () => document.activeElement?.textContent;
    // Opened by the pointer, the focus is the menu's; the pointer over an item gives it the focus, and moving on takes it along: one item is marked, the focused one.
    expect(document.activeElement).toBe(menu());
    fireEvent.pointerMove(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    expect(focused()).toBe(SELECTION_MENU.explain);
    fireEvent.pointerMove(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.copy }));
    expect(focused()).toBe(SELECTION_MENU.copy);
    // The arrow keys go on from where the pointer left it.
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowDown' });
    expect(focused()).toBe(SELECTION_MENU.explain);
  });
});

describe('its items (C41, C44, C45, C50)', () => {
  it('opens a focused, editable side-chat draft with the selection in quotes, and sends only when asked', async () => {
    await open(CODEX_ASIDES, true);
    select('lists ', 'each morning.');
    const selected = document.getSelection()?.toString();
    rightPress('lists');
    // The draft uses what was selected when the menu opened, even if the selection changes.
    select('second answer');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.sendToSideChat }));
    await stage.settle();
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: ASIDE_WORDS.field });
    expect(field.value).toBe(`"${selected}"`);
    expect(field.value).toContain('high and low water.');
    expect(field.value).toContain('It is read each morning.');
    expect(document.activeElement).toBe(field);
    expect(menu()).toBeNull();
    expect(asks()).toEqual([]);
    expect(stage.sent('chat:send')).toEqual([]);
    const [tab] = stage.tabs(ONE);
    expect(tab?.kind).toBe(ASIDE_KIND);
    const text = `${field.value}\n\nWhy are there two tides?`;
    fireEvent.change(field, { target: { value: text } });
    fireEvent.click(within(document.querySelector('[data-aside]') as HTMLElement).getByRole('button', { name: ASIDE_WORDS.send }));
    await stage.settle();
    expect(asks()).toEqual([{ sessionId: ID, asideId: tab?.reference, text }]);
    expect(stage.sent('chat:send')).toEqual([]);
  });

  it('opens a fresh draft each time without replacing a draft already open', async () => {
    await open();
    for (let n = 0; n < 2; n += 1) {
      pressOn('tide table');
      fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.sendToSideChat }));
    }
    const tabs = stage.tabs(ONE);
    expect(new Set(tabs.map((tab) => tab.reference)).size).toBe(2);
    for (const tab of tabs) expect(tab.viewState).toHaveProperty('draft', '"tide table"');
    expect(asks()).toEqual([]);
  });

  it('copies the selection’s text, and closes', async () => {
    await open();
    select('lists ', ' and low');
    rightPress('lists');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.copy }));
    expect(written).toEqual(['lists high and low']);
    expect(menu()).toBeNull();
    expect(asks()).toEqual([]);
  });

  it('asks about the selection with its report, and opens the aside’s tab without moving the focus', async () => {
    await open();
    list().focus();
    select('tide table');
    rightPress('tide table');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    await stage.settle();
    const [ask] = asks() as [ChatAskRequest & { source: AsideSource }];
    expect(asks()).toHaveLength(1);
    expect(ask.sessionId).toBe(ID);
    // The page made the aside's id (C73).
    expect(ask.asideId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ask.source).toMatchObject({ kind: 'message', itemId: 'answer-1', role: 'assistant', excerpt: 'tide table', cut: false, lines: { first: 1, last: 2 } });
    expect(ask.source.range).toEqual({ start: 4, end: 14 });
    expect('text' in ask).toBe(false);
    // Its tab, titled by the excerpt's first line, with no focus asked for: neither the focus nor the place moves (C41).
    expect(stage.tabs(ONE).map((tab) => [tab.kind, tab.reference, tab.handed, tab.viewState])).toEqual([[ASIDE_KIND, ask.asideId, 'Explained: tide table', null]]);
    expect(document.activeElement).toBe(list());
    expect(menu()).toBeNull();
  });

  it('opens the aside main names: the one the same selection already has, and no second (C50)', async () => {
    await open();
    stage.ask = () => ({ status: 'accepted', asideId: 'existing-aside' });
    select('tide table');
    rightPress('tide table');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    await stage.settle();
    expect(stage.tabs(ONE).map((tab) => tab.reference)).toEqual(['existing-aside']);
    // The same selection again selects that one tab.
    pressOn('tide table');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    await stage.settle();
    expect(stage.tabs(ONE)).toHaveLength(1);
    expect(asks()).toHaveLength(2);
  });

  it('says in one line why an ask was not taken, and opens nothing', async () => {
    await open();
    stage.ask = () => ({ status: 'refused', reason: 'aside-running' });
    select('tide table');
    rightPress('tide table');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    await stage.settle();
    expect(stage.tabs(ONE)).toEqual([]);
    const REFUSED = 'This side question is still being answered. Ask again once it has finished.';
    expect(screen.getByText(REFUSED).getAttribute('role')).toBe('status');
    // The next ask that is taken clears the line.
    stage.ask = (request) => ({ status: 'accepted', asideId: request.asideId });
    pressOn('tide table');
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    await stage.settle();
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it('makes no round trip to main to open: only the ask itself leaves the page', async () => {
    await open();
    const before = stage.requests.length;
    select('tide table');
    rightPress('tide table');
    fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' });
    expect(stage.requests.length).toBe(before);
  });
});

describe('where it holds Copy alone (C45, C47, C48)', () => {
  it('holds Explain this on a prompt’s selection too, which has no icon', async () => {
    await open();
    select('table list');
    rightPress('table list');
    expect(items()).toEqual([SELECTION_MENU.copy, SELECTION_MENU.explain, SELECTION_MENU.sendToSideChat]);
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.explain }));
    await stage.settle();
    expect((asks()[0] as { source: AsideSource }).source).toMatchObject({ kind: 'message', itemId: 'prompt-1', role: 'user', lines: null });
  });

  it('offers a new side chat for a selection across two messages, without Explain', async () => {
    await open();
    select('each morning', 'second answer');
    rightPress('each morning');
    expect(items()).toEqual([SELECTION_MENU.copy, SELECTION_MENU.sendToSideChat]);
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: SELECTION_MENU.copy }));
    expect(written[0]).toContain('each morning');
    expect(written[0]).toContain('second answer');
  });

  it('holds Copy alone where the session cannot be asked beside: a provider without asides, or no conversation yet', async () => {
    await open('none');
    select('tide table');
    rightPress('tide table');
    expect(items()).toEqual([SELECTION_MENU.copy]);
  });
});
