// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's tabs, in the page (docs/planning/_archive/M19b.md, Design 1, 2; C6–C8): for each session its
// tabs in the order they were opened, which one is selected, and the view state each tab's kind set.
// Made as the chat's drafts are (src/renderer/src/chat/chat-store.ts): held in the page's memory,
// for the run. Nothing of it is sent to main and nothing is written: a restart begins with none,
// and a link in the chat opens its file again (C7).
//
// The store names no kind. It holds the page's kinds by their id, set once by the pane, so that the
// opener can open a tab by a kind's id and a title is worked out here.
import { create } from 'zustand';
import type { TabKind } from './tab-kind';

export interface Tab {
  /** Its identity in its session: its kind and its reference's canonical JSON (C8). */
  readonly id: string;
  /** A number of its own, for the ids its elements carry. */
  readonly serial: number;
  readonly kind: string;
  readonly reference: unknown;
  /** What its button shows: the title its body set, else the one its kind gives its reference. */
  readonly title: string;
  /** The title its body set while it was shown, if it set one (C5). */
  readonly named: string | null;
  readonly viewState: unknown;
  /**
   * What whoever opened the tab had already read for it: its body takes it at its next showing, or
   * at once when it is shown, and it is dropped as it is taken. Undefined when there is none.
   */
  readonly handed: unknown;
  /** Whether the user may close it: its kind's word, set as it opens, so that the tab list needs no kind (M106, C2). */
  readonly closable: boolean;
}

export interface SessionTabs {
  readonly tabs: readonly Tab[];
  readonly selected: string | null;
}

export interface TabsState {
  readonly sessions: Readonly<Record<string, SessionTabs>>;
}

export const useTabs = create<TabsState>()(() => ({ sessions: {} }));

let kinds: ReadonlyMap<string, TabKind> = new Map();
let serial = 0;

/** The page's kinds, by id: what `openTab` may open, and what titles a tab. Set by the pane when it mounts. */
export function registerKinds(list: readonly TabKind[]): void {
  kinds = new Map(list.map((kind) => [kind.id, kind]));
}

/** A value as JSON with its keys in order, so that two spellings of one value are one text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const tabId = (kind: string, reference: unknown): string => `${kind}\u0000${canonical(reference)}`;

/** Each tab's title, asked again: a title depends on the session's other tabs of its kind. */
function titled(tabs: readonly Tab[]): Tab[] {
  return tabs.map((tab) => {
    const others = tabs.filter((other) => other.kind === tab.kind && other.id !== tab.id).map((other) => other.reference);
    const title = tab.named ?? kinds.get(tab.kind)?.title(tab.reference, others) ?? tab.title;
    return title === tab.title ? tab : { ...tab, title };
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A view state with another's fields put over it: a later reference to an open file moves its line and keeps its place. */
const merged = (held: unknown, given: unknown): unknown => (given === undefined ? held : isRecord(held) && isRecord(given) ? { ...held, ...given } : given);

function change(sessionId: string, recipe: (held: SessionTabs) => SessionTabs | null): void {
  useTabs.setState((state) => {
    const held = state.sessions[sessionId];
    if (held === undefined) return state;
    const next = recipe(held);
    return next === null ? state : { sessions: { ...state.sessions, [sessionId]: next } };
  });
}
const changeTab = (sessionId: string, id: string, recipe: (tab: Tab) => Tab): void => {
  change(sessionId, (held) => {
    const tab = held.tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) return null;
    const next = recipe(tab);
    return next === tab ? null : { ...held, tabs: titled(held.tabs.map((candidate) => (candidate.id === id ? next : candidate))) };
  });
};

export interface OpenOptions {
  /** Put over the tab's view state: a file's line. */
  readonly viewState?: unknown;
  /** What was already read for it, for its body to take. */
  readonly handed?: unknown;
  /**
   * False for a tab that opens by itself (docs/planning/_archive/M100.md, round 8; C78): it takes the view
   * only where the session shows no tab, and leaves the one that is shown. True when left out.
   */
  readonly select?: boolean;
  /** A new tab goes before the others rather than after the last. */
  readonly first?: boolean;
}

/**
 * Opens a tab in a session (C8), or selects the one that is open for that kind and reference. A new
 * tab goes after the last — or first, where asked — and is selected unless asked not to be. False for
 * a kind the page does not have.
 */
export function openTab(sessionId: string, kind: string, reference: unknown, options: OpenOptions = {}): boolean {
  if (!kinds.has(kind)) return false;
  const id = tabId(kind, reference);
  serial += 1;
  const fresh = serial;
  useTabs.setState((state) => {
    const held = state.sessions[sessionId] ?? { tabs: [], selected: null };
    const open = held.tabs.some((tab) => tab.id === id);
    const added: Tab = { id, serial: fresh, kind, reference, title: '', named: null, viewState: options.viewState ?? null, handed: options.handed, closable: kinds.get(kind)?.closable !== false };
    // An open tab given nothing new is the same tab: a watcher may open it at every change (M106, C1).
    const touched = options.viewState !== undefined || 'handed' in options;
    const tabs = open
      ? (touched ? held.tabs.map((tab) => (tab.id === id ? { ...tab, viewState: merged(tab.viewState, options.viewState), handed: 'handed' in options ? options.handed : tab.handed } : tab)) : held.tabs)
      : titled(options.first === true ? [added, ...held.tabs] : [...held.tabs, added]);
    const selected = options.select === false && held.selected !== null ? held.selected : id;
    if (tabs === held.tabs && selected === held.selected) return state;
    return { sessions: { ...state.sessions, [sessionId]: { tabs, selected } } };
  });
  return true;
}

export function selectTab(sessionId: string, id: string): void {
  change(sessionId, (held) => (held.selected === id || !held.tabs.some((tab) => tab.id === id) ? null : { ...held, selected: id }));
}

const closing = new Set<number>();

/**
 * Closes a tab (C8, C10): closing the selected one selects the one after it, else the one before. The
 * last one leaves the session with none. A tab its kind keeps open is left where it is (M106, C2).
 */
export function closeTab(sessionId: string, id: string): void {
  const tab = useTabs.getState().sessions[sessionId]?.tabs.find((candidate) => candidate.id === id);
  if (tab === undefined || !tab.closable || closing.has(tab.serial)) return;
  const beforeClose = kinds.get(tab.kind)?.beforeClose;
  if (beforeClose === undefined) { finishClose(sessionId, tab); return; }
  closing.add(tab.serial);
  void beforeClose(sessionId, tab.reference).then((close) => {
    if (close) finishClose(sessionId, tab);
  }).catch(() => undefined).finally(() => closing.delete(tab.serial));
}

function finishClose(sessionId: string, closingTab: Tab): void {
  const id = closingTab.id;
  useTabs.setState((state) => {
    const held = state.sessions[sessionId];
    const at = held?.tabs.findIndex((tab) => tab.id === id) ?? -1;
    if (held === undefined || at === -1 || held.tabs[at]?.serial !== closingTab.serial) return state;
    const tabs = titled(held.tabs.filter((tab) => tab.id !== id));
    const sessions = { ...state.sessions };
    if (tabs.length === 0) delete sessions[sessionId];
    else sessions[sessionId] = { tabs, selected: held.selected === id ? (tabs[at] ?? tabs[at - 1])?.id ?? null : held.selected };
    return { sessions };
  });
}

export function setViewState(sessionId: string, id: string, viewState: unknown): void {
  changeTab(sessionId, id, (tab) => (Object.is(tab.viewState, viewState) ? tab : { ...tab, viewState }));
}

export function setTitle(sessionId: string, id: string, title: string): void {
  changeTab(sessionId, id, (tab) => (tab.named === title ? tab : { ...tab, named: title }));
}

/** What was handed to a tab, taken once: it is dropped here as it is given. */
export function takeHanded(sessionId: string, id: string): unknown {
  const handed = useTabs.getState().sessions[sessionId]?.tabs.find((tab) => tab.id === id)?.handed;
  if (handed !== undefined) changeTab(sessionId, id, (tab) => ({ ...tab, handed: undefined }));
  return handed;
}

/** A session that is no longer listed takes its tabs with it (C6): every session but these is dropped. */
export function keepSessions(listed: ReadonlySet<string>): void {
  useTabs.setState((state) => {
    const kept = Object.entries(state.sessions).filter(([id]) => listed.has(id));
    return kept.length === Object.keys(state.sessions).length ? state : { sessions: Object.fromEntries(kept) };
  });
}

/** Every session's tabs gone: what a new run starts with. For tests. */
export function resetTabs(): void {
  useTabs.setState({ sessions: {} });
}
