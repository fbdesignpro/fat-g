// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The window of a conversation the page holds (docs/planning/_archive/M18.md, Design 5; C20, C58, C60;
// M19.md, Design 5, 8; C24, C26, C46, C49; M21.md, Design 6; C43, C71, C74; M22.md, Design 10; C36): 500
// items at most, sorted by their stored places and told apart by their ids, with the turns they
// belong to. Pure: `useChat` and `useDetachedChat` say when a read, a page or a push arrives, and
// these say what the window is afterwards. Both of the window's bounds are `fitWindow`'s, the same
// function main answers a window with.
import { appendText, type ChatHistory, type ChatPage, type ChatPartial, type ChatRead, type ChatStorage } from '@shared/contracts/chat';
import { compareItems, type ConversationItem, type ConversationTurn, fitWindow } from '@shared/contracts/conversation';
import { type ApprovalKind, approvalOf, questionOf } from '@shared/contracts/interaction';
import type { TurnOutcome } from '@shared/contracts/sessions';

/**
 * What the last change was, for the list to keep its place by (C20):
 * - `latest`: the newest page, shown from its end — the first read, and Show latest.
 * - `replace`: the held window, read again (C60).
 * - `append`: one item at the end, or a held one as it now is, in its place (M19, C26; M21, C71).
 * - `grow`: more text of a held item (M19, C24).
 * - `older-page`: a page put before what is held (C58).
 */
export type ChatChangeKind = 'latest' | 'replace' | 'append' | 'grow' | 'older-page';

export interface ChatChange {
  /** Goes up by one with every change, so two alike are told apart. */
  readonly serial: number;
  readonly kind: ChatChangeKind;
}

export interface ChatView {
  /** Oldest first. */
  readonly items: readonly ConversationItem[];
  /** The turns those items belong to, by id. */
  readonly turns: ReadonlyMap<string, ConversationTurn>;
  /** The items end with the conversation's newest. False once an older page pushed the newest out (C58). */
  readonly latest: boolean;
  /** The cursor of the page before the window: the id of its oldest item, when the store holds older ones. */
  readonly older: string | null;
  readonly history: ChatHistory;
  readonly storage: ChatStorage;
  readonly change: ChatChange;
  /** The last older page put in, and how many earlier messages it added: the line announced in their place (Design 5). */
  readonly loaded: { readonly serial: number; readonly count: number } | null;
  /** How many times something arrived at the window's end — an item, or more of one's text: what the control at the list's foot tells a reader who is away from the end (M19, C46). */
  readonly arrivals: number;
  /** Something arrived that a window which let go of its newest does not show (M19, C24, C46). */
  readonly newer: boolean;
  /** The last turn seen running here, then seen over: the one notice of a live turn's end (M19, C49). Never set by a first read. */
  readonly ended: { readonly serial: number; readonly turnId: string; readonly outcome: TurnOutcome | null } | null;
  /**
   * The last blocking question a push raised here (M21, C43, C74), or the last approval (M22, C36):
   * the one line posted for it. `worker`: it is a worker's, whose push the session's list passes.
   * `what`: a question, or what an approval asks leave for. Never set by a read.
   */
  readonly asked: { readonly serial: number; readonly worker: boolean; readonly what: Raised } | null;
}

/** What a raised request asks (M22, C36): an answer, or leave for a command, a file change or a tool's use. */
export type Raised = 'question' | ApprovalKind;

/** How a message is labelled, or null for an item that is no message: an activity, which its group draws (M20a, C36), an interaction, which its card draws (M21, C37), a reserved kind (C3), or a message with no role. */
export function shownRole(item: Pick<ConversationItem, 'kind' | 'role'>): 'user' | 'assistant' | 'notice' | null {
  if (item.kind === 'notice') return 'notice';
  return item.kind === 'message' ? item.role : null;
}

/**
 * Whether an entry of the list draws anything (M20a, C9, C36, C42; M21, C43): a message or a notice
 * that is labelled, a group that holds an activity other than thinking, and a question's card. What
 * draws nothing is no stop of the keyboard's, and no anchor of the list's place.
 */
export function drawsEntry(entry: readonly Pick<ConversationItem, 'kind' | 'role' | 'activity' | 'interaction'>[]): boolean {
  const [first] = entry;
  if (first === undefined) return false;
  if (first.kind === 'interaction') return first.interaction !== null;
  return first.kind === 'activity' ? entry.some((item) => item.activity !== null && item.activity.type !== 'thinking') : shownRole(first) !== null;
}

/** One of each id, a later list's winning, in stored order (C2). */
function merge(...lists: readonly (readonly ConversationItem[])[]): ConversationItem[] {
  const byId = new Map<string, ConversationItem>();
  for (const list of lists) for (const item of list) byId.set(item.id, item);
  return [...byId.values()].sort(compareItems);
}

/** The turns of the items held, and no other: a later source's wins. */
function turnsOf(items: readonly ConversationItem[], ...sources: readonly Iterable<ConversationTurn>[]): ReadonlyMap<string, ConversationTurn> {
  const known = new Map<string, ConversationTurn>();
  for (const source of sources) for (const turn of source) known.set(turn.id, turn);
  const held = new Map<string, ConversationTurn>();
  for (const item of items) {
    const turn = known.get(item.turnId);
    if (turn !== undefined) held.set(turn.id, turn);
  }
  return held;
}

/**
 * The window's bounds (C58). What is let go is still on disk: at the head the cursor moves to the
 * new first item, and at the end the window no longer holds the newest.
 */
function fit(items: readonly ConversationItem[], keep: 'newest' | 'oldest', older: string | null, latest: boolean): { readonly items: readonly ConversationItem[]; readonly older: string | null; readonly latest: boolean } {
  const fitted = fitWindow(items, keep);
  if (!fitted.cut) return { items, older, latest };
  return keep === 'newest' ? { items: fitted.items, older: fitted.items[0]?.id ?? older, latest } : { items: fitted.items, older, latest: false };
}

/**
 * A turn the window held as running that is over in what it holds now: the newest such, with how it
 * ended (M19, C49). Null when none ended — and for a first read, which saw none run.
 */
function turnEnded(previous: ChatView | null, turns: ReadonlyMap<string, ConversationTurn>, serial: number): ChatView['ended'] {
  if (previous === null) return null;
  let ended: ConversationTurn | null = null;
  for (const before of previous.turns.values()) {
    if (before.state !== 'running') continue;
    const now = turns.get(before.id);
    if (now !== undefined && now.state !== 'running' && (ended === null || now.place >= ended.place)) ended = now;
  }
  return ended === null ? previous.ended : { serial, turnId: ended.id, outcome: ended.outcome };
}

/** A read's answer, in place of whatever was held. The older page's line stays through a window read again. */
export function windowOf(answer: Pick<ChatRead, 'items' | 'turns' | 'latest' | 'older' | 'history' | 'storage'>, change: ChatChange, previous: ChatView | null): ChatView {
  const fitted = fit(merge(answer.items), answer.latest ? 'newest' : 'oldest', answer.older, answer.latest);
  const turns = turnsOf(fitted.items, answer.turns);
  return {
    items: fitted.items,
    turns,
    latest: fitted.latest,
    older: fitted.older,
    history: answer.history,
    storage: answer.storage,
    change,
    loaded: change.kind === 'replace' ? previous?.loaded ?? null : null,
    arrivals: previous?.arrivals ?? 0,
    // A window that holds the newest shows everything that arrived.
    newer: fitted.latest ? false : previous?.newer ?? false,
    ended: turnEnded(previous, turns, change.serial),
    asked: previous?.asked ?? null,
  };
}

/** Whether the window holds an item of this id: a push of one is applied in place on any page (M21, C71). */
export function holdsItem(view: ChatView, id: string): boolean {
  return view.items.some((item) => item.id === id);
}

/**
 * One item at the end, or a held one as it now is, in its place (M19, C26), with its turn as it
 * then is. Past the bounds the oldest are let go.
 *
 * A held one is replaced where it stands, whatever page the window shows (M21, C71): the window's
 * other items and its cursor are as they were, and no arrival is counted — an outcome's push, or a
 * message's completion, is nothing new below. A blocking question that is new here, and pending,
 * is the one a line is posted for (C43).
 */
export function withItem(view: ChatView, item: ConversationItem, turn: ConversationTurn, serial: number): ChatView {
  const held = holdsItem(view, item.id);
  // A window that let go of its newest keeps its bounds as they are: the item it holds only changed.
  const fitted = held && !view.latest ? { items: view.items.map((entry) => (entry.id === item.id ? item : entry)), older: view.older } : fit(merge(view.items, [item]), 'newest', view.older, view.latest);
  return {
    ...view, items: fitted.items, older: fitted.older, turns: turnsOf(fitted.items, view.turns.values(), [turn]), change: { serial, kind: 'append' },
    arrivals: held ? view.arrivals : view.arrivals + 1,
    asked: held ? view.asked : askedBy(view, item, serial, false),
  };
}

/**
 * What an item raises as its push brings it (M21, C43; M22, C36): a blocking question that is
 * pending on this run, or an approval that is — which always holds its turn. Null for every other item.
 */
export function raisedBy(item: Pick<ConversationItem, 'interaction'>): Raised | null {
  const question = questionOf(item);
  if (question !== null) return question.mode === 'blocking' && question.outcome === 'pending' ? 'question' : null;
  const approval = approvalOf(item);
  return approval !== null && approval.outcome === 'pending' ? approval.request.kind : null;
}

/** A blocking question, or an approval, as its raising pushes it (M21, C43; M22, C36): pending, on this run. */
export function isRaised(item: Pick<ConversationItem, 'interaction'>): boolean {
  return raisedBy(item) !== null;
}

function askedBy(view: ChatView, item: Pick<ConversationItem, 'interaction'>, serial: number, worker: boolean): ChatView['asked'] {
  const what = raisedBy(item);
  return what === null ? view.asked : { serial, worker, what };
}

/**
 * A blocking question or an approval was raised that the window does not take in (M21, C43, C74;
 * M22, C36): a worker's, whose push is its tab's to apply, or the session's own while the window
 * shows an older page. The line posted for it is the chat's all the same, and nothing in the window
 * moves. An item that raises nothing changes nothing.
 */
export function withAsked(view: ChatView, serial: number, worker: boolean, item: Pick<ConversationItem, 'interaction'>): ChatView {
  const asked = askedBy(view, item, serial, worker);
  return asked === view.asked ? view : { ...view, asked };
}

/**
 * More text of a held item (M19, C24): appended only to an item of exactly the length the push
 * says it had. Null when the window does not hold that item at that length: it is then read again.
 * A message being written is among the window's newest, so the search starts at its end.
 */
export function withText(view: ChatView, partial: ChatPartial, serial: number): ChatView | null {
  for (let index = view.items.length - 1; index >= 0; index -= 1) {
    const held = view.items[index];
    if (held === undefined || held.id !== partial.itemId) continue;
    const grown = appendText(held, partial);
    if (grown === null) return null;
    const items = [...view.items];
    items[index] = grown;
    const fitted = fit(items, 'newest', view.older, view.latest);
    // The same turns, by the same objects: no message but the one that grew is drawn again.
    return { ...view, items: fitted.items, older: fitted.older, turns: fitted.items === items ? view.turns : turnsOf(fitted.items, view.turns.values()), change: { serial, kind: 'grow' }, arrivals: view.arrivals + 1 };
  }
  return null;
}

/** Something arrived that a window which let go of its newest does not show (M19, C24, C46): it says so, and nothing in it moves. */
export function withNewer(view: ChatView): ChatView {
  return view.newer ? view : { ...view, newer: true };
}

/**
 * A page put before what is held. Past the bounds the newest are let go, and the window then says
 * so (C58). `fresher`: the page was answered at a later revision than the window holds, so where
 * both have an item or a turn, the page's is taken.
 */
export function withOlderPage(view: ChatView, page: Pick<ChatPage, 'items' | 'turns' | 'older'>, fresher: boolean, serial: number): ChatView {
  const held = new Set(view.items.map((item) => item.id));
  const count = page.items.filter((item) => !held.has(item.id) && shownRole(item) !== null).length;
  const items = fresher ? merge(view.items, page.items) : merge(page.items, view.items);
  const fitted = fit(items, 'oldest', page.older, view.latest);
  const turns = fresher ? turnsOf(fitted.items, view.turns.values(), page.turns) : turnsOf(fitted.items, page.turns, view.turns.values());
  return { ...view, items: fitted.items, latest: fitted.latest, older: fitted.older, turns, change: { serial, kind: 'older-page' }, loaded: { serial, count } };
}
