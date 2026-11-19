// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The history merge, as a plan (docs/planning/_archive/M18.md, Design 6; C14, C48, C49, C53; M20a.md,
// Design 6; C19, C58; M21.md, Design 4; C28): what a turn read from the provider's own history becomes in the store. Pure:
// it is handed what the store holds and answers what to write; store.ts writes a page's plans in one
// transaction.
//
//   The provider's turn                                   The store
//   its id is a stored turn's provider id                 that turn
//   else a user message's client id is a stored item's id that item's turn, which gains the provider's turn id
//   else                                                  a new turn, placed by the store
//
// In a matched turn an item the store holds whole by the provider's item id is skipped, and one it
// holds as far as it got — a message whose whole text never arrived, an activity whose end never
// came — is completed by the provider's own (M19, C68; M20a, C58); a user's message whose client id
// is a stored item's id IS that item, which gains the provider's item id and keeps its own id, text
// and time (C53); any other is added before the next item of that turn both sides hold, or last.
// Nothing is matched by text, time or position. An item is matched by its kind too (M21, C28): the
// card of a question asked in a message shares that message's id, and is never taken for it.
//
// A turn's messages and its activities are one list, in the provider's order (M20a, C19): each
// names its place among its turn's items where the provider's history gives both.
//
// A plan the provider's history returns (M22b, C28) is the plan line its turn holds where the store
// has one — matched by the provider's item id, and nothing of it written — and a message with the
// plan's text where it has none: what fat-g did not see arrive, it did not record as a version.
import type { HistoryActivity, HistoryMessage, HistoryPlan, HistoryTurn } from '@shared/contracts/agent-events';

/** What the store holds of a turn, for matching. */
export interface HeldTurn {
  readonly id: string;
  readonly providerTurnId: string | null;
  /** The provider's end is stored (C54). */
  readonly ended: boolean;
  readonly gap: boolean;
  /** An earlier check saw it (C51). */
  readonly reached: boolean;
  /**
   * The session's own items, in stored order: a worker's are no part of the session's history.
   * `complete`: false for a message whose whole text never arrived (M19, C15) and for an activity
   * whose end never came (M20a, C58). A checklist reads complete: history returns none, so none
   * holds its turn for a check (C24). `kind`: the item's, as it is stored (M21, C28).
   */
  readonly items: readonly { readonly id: string; readonly kind: string; readonly providerItemId: string | null; readonly notice: string | null; readonly complete: boolean }[];
}

export interface Held {
  byProviderTurnId(providerTurnId: string): HeldTurn | null;
  /** The turn of the stored item with this id: a prompt's id is the client id it was sent with. */
  byItemId(itemId: string): HeldTurn | null;
}

/** One item of a turn's history: a message, or an activity (M20a, C19). */
export type HistoryEntry = { readonly kind: 'message'; readonly message: HistoryMessage } | { readonly kind: 'activity'; readonly activity: HistoryActivity };

export type ItemPlan =
  /** The stored item is the provider's: it gains the provider's id for it, and nothing is added (C53). */
  | { readonly kind: 'name'; readonly itemId: string; readonly providerItemId: string }
  /**
   * The stored item is a message whose whole text never arrived (M19, C68): it takes the provider's
   * text, phase, questions and cut flag, and is complete. Its id, its place and its time stay.
   */
  | { readonly kind: 'complete'; readonly itemId: string; readonly message: HistoryMessage }
  /** Added before the stored item `before`, or last in its turn. */
  | { readonly kind: 'add'; readonly before: string | null; readonly message: HistoryMessage }
  /**
   * The stored item is an activity whose end never came (M20a, C58): it takes the status, output,
   * exit code and duration the provider's history gives, and is complete. Its id, its place, its
   * time and whatever else its body holds stay.
   */
  | { readonly kind: 'complete-activity'; readonly itemId: string; readonly activity: HistoryActivity }
  /** An activity the store lacks (C19): added before the stored item `before`, or last in its turn. */
  | { readonly kind: 'add-activity'; readonly before: string | null; readonly activity: HistoryActivity };

export type TurnPlan =
  /** Held, and nothing of it to write: the next older new turn goes directly before it (C49). */
  | { readonly kind: 'held'; readonly turnId: string }
  | {
      readonly kind: 'matched';
      readonly turnId: string;
      /** The provider's id for the turn, for a stored turn that has none (C53). */
      readonly providerTurnId: string | null;
      /** The outcome and times the provider gives, for a stored turn without the provider's end. */
      readonly end: HistoryTurn | null;
      /** A full read: nothing of it is missing any more (C19). */
      readonly clearGap: boolean;
      readonly items: readonly ItemPlan[];
      /** The turn was too large to read: a line stands in its place, once (M15, C102). */
      readonly notShown: boolean;
    }
  /** The turn's messages and — where history gives them (M20a, C19) — its activities: one list, by `orderEntries`. */
  | { readonly kind: 'new'; readonly turn: HistoryTurn; readonly messages: readonly HistoryMessage[]; readonly activities?: readonly HistoryActivity[]; readonly notShown: boolean };

/** How much of the turn was read: every item, the provider's summary, or nothing of it (it was passed over). */
export type ReadDetail = 'full' | 'summary' | 'passed-over';

const NOT_SHOWN = 'turn-not-shown';

/**
 * A turn's messages and activities as one list, in the provider's order (M20a, C19): by the place
 * each names, a message that names none keeping the order it was given in, ahead of any activity
 * that names no earlier place.
 */
export function orderEntries(messages: readonly HistoryMessage[], activities: readonly HistoryActivity[]): HistoryEntry[] {
  const placed: { readonly entry: HistoryEntry; readonly order: number; readonly tie: number }[] = [
    ...messages.map((message, index) => ({ entry: { kind: 'message' as const, message }, order: message.order ?? index, tie: index })),
    ...activities.map((activity, index) => ({ entry: { kind: 'activity' as const, activity }, order: activity.order, tie: messages.length + index })),
  ];
  return placed.sort((a, b) => a.order - b.order || a.tie - b.tie).map((entry) => entry.entry);
}

/** The stored turn a provider's turn is, or null (C48). */
export function matchTurn(turn: HistoryTurn, messages: readonly HistoryMessage[], held: Held): HeldTurn | null {
  const byId = held.byProviderTurnId(turn.turnId);
  if (byId !== null) return byId;
  for (const message of messages) {
    if (message.role !== 'user' || message.clientId === undefined) continue;
    const byPrompt = held.byItemId(message.clientId);
    // A turn that already has another provider id is another turn's.
    if (byPrompt !== null && (byPrompt.providerTurnId === null || byPrompt.providerTurnId === turn.turnId)) return byPrompt;
  }
  return null;
}

/** The stored item a provider's item is, or null: by the provider's item id and its kind, else by a user message's client id. */
function storedItem(entry: HistoryEntry, turn: HeldTurn): HeldTurn['items'][number] | null {
  const itemId = entry.kind === 'message' ? entry.message.itemId : entry.activity.itemId;
  const byProvider = turn.items.find((item) => item.providerItemId === itemId && item.kind === entry.kind);
  if (byProvider !== undefined) return byProvider;
  if (entry.kind !== 'message' || entry.message.role !== 'user' || entry.message.clientId === undefined) return null;
  const { clientId } = entry.message;
  return turn.items.find((item) => item.id === clientId && item.kind === 'message') ?? null;
}

/** A plan the store holds no line of (C28): a message of the model's, with the plan's whole text, which the store cuts as any. */
const planMessage = (plan: HistoryPlan): HistoryMessage => ({ role: 'assistant', itemId: plan.itemId, phase: null, text: plan.text, turnId: plan.turnId, at: plan.at, order: plan.order });

/**
 * What one turn of the provider's history, read with `detail`, becomes. `messages`, `activities`
 * and `plans` are the turn's own, each in the provider's order.
 */
export function planTurn(turn: HistoryTurn, read: readonly HistoryMessage[], detail: ReadDetail, held: Held, activities: readonly HistoryActivity[] = [], plans: readonly HistoryPlan[] = []): TurnPlan {
  const stored = matchTurn(turn, read, held);
  // A plan whose line the turn holds is that line (M22b, C28); any other is a message.
  const lined = (plan: HistoryPlan): boolean => stored !== null && stored.items.some((item) => item.providerItemId === plan.itemId && item.kind === 'interaction');
  const messages = plans.length === 0 ? read : [...read, ...plans.filter((plan) => !lined(plan)).map(planMessage)];
  const passedOver = detail === 'passed-over';
  if (stored === null) return { kind: 'new', turn, messages: passedOver ? [] : messages, ...(passedOver || activities.length === 0 ? {} : { activities }), notShown: passedOver };
  const entries = passedOver ? [] : orderEntries(messages, activities);

  const items: ItemPlan[] = [];
  for (const [index, entry] of entries.entries()) {
    const own = storedItem(entry, stored);
    if (own !== null) {
      if (entry.kind === 'message') {
        if (own.providerItemId === null) items.push({ kind: 'name', itemId: own.id, providerItemId: entry.message.itemId });
        // Held as far as it got: the provider's own text is the authority for it (M19, C68).
        if (!own.complete) items.push({ kind: 'complete', itemId: own.id, message: entry.message });
      } else if (!own.complete && entry.activity.status !== 'unfinished') {
        // Its end never came here, and the provider's history has it (M20a, C58).
        items.push({ kind: 'complete-activity', itemId: own.id, activity: entry.activity });
      }
      continue;
    }
    // In the provider's order: before the next of its items that the store holds too.
    const next = entries.slice(index + 1).map((later) => storedItem(later, stored)).find((item) => item !== null) ?? null;
    items.push(entry.kind === 'message' ? { kind: 'add', before: next?.id ?? null, message: entry.message } : { kind: 'add-activity', before: next?.id ?? null, activity: entry.activity });
  }
  return {
    kind: 'matched',
    turnId: stored.id,
    providerTurnId: stored.providerTurnId === null ? turn.turnId : null,
    end: !stored.ended && turn.outcome !== null ? turn : null,
    clearGap: detail === 'full' && stored.gap,
    items,
    notShown: passedOver && !stored.items.some((item) => item.notice === NOT_SHOWN),
  };
}

/**
 * Whether a check reads a listed turn with its items (C51): one the store lacks, or holds without
 * the provider's end, with a gap, or with an item that is not all there — a message whose whole text
 * never arrived (M19, C68), an activity whose end never came (M20a, C58).
 * `stop`: held whole, and an earlier check reached it — the walk ends there. A turn that is not
 * whole never ends the walk, also when an earlier check reached it; the walk is not lengthened for
 * one either, so a partial turn behind a newer whole turn a check has reached is not read again.
 */
export function listedTurn(turn: HistoryTurn, held: Held): { readonly read: boolean; readonly stop: boolean; readonly stored: HeldTurn | null } {
  const stored = held.byProviderTurnId(turn.turnId);
  if (stored === null) return { read: true, stop: false, stored };
  const whole = stored.ended && !stored.gap && stored.items.every((item) => item.complete);
  return { read: !whole, stop: whole && stored.reached, stored };
}
