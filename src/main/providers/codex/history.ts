// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's earlier messages, read back from Codex (docs/planning/_archive/M15.md, Design 12; C57, C92,
// C120, C134): one page of `thread/turns/list`, over the instance's existing connection. It needs
// no resumed thread, so reading starts no process.
//
// History is mapped by a rule of its own (C92): a `userMessage` item is a user message and an
// `agentMessage` item an assistant message, in the CLI's order, and nothing of history is an event
// of a turn. What a turn did between its messages is read too (docs/planning/_archive/M20a.md, Design 3; C19):
// a command, a file change, an MCP call, a web search and a reasoning item, each mapped as a live
// one is, with its status as history gives it and its duration where the item has one. An item of
// history has no start time of its own (K1): it carries its turn's. A history read returns no
// checklist (K1), and none is made of one.
//
// What the conversation store matches by is carried through (docs/planning/_archive/M18.md, Design 1, 6;
// C47, C51): each turn with Codex's own id for it, how Codex says it ended and its times; each
// message with its turn's id, and the user's own with the id it was sent with, when Codex kept it.
//
// A question asked in a message is read back with its message (docs/planning/_archive/M21.md, Design 4; C28,
// C56): the message keeps its `questions`, from which the merge makes its card. The empty message
// such a turn ends with is no message here, as it is none live. A question asked as a request is in
// no history read: nothing of it is looked for.
//
// An item that was refused leave reads `declined` from history as it does live (docs/planning/_archive/M22.md,
// Design 7; C76): Codex's own status, and no failure. History says nothing of who declined it.
import type { HistoryActivity, HistoryMessage, HistoryPlan, HistoryTurn } from '@shared/contracts/agent-events';
import { ProcessFailure } from '@shared/provider-kit/process';
import type { HistoryAnswer, HistoryDetail, HistoryRequest } from '@shared/provider-kit/sessions';
import { HISTORY_METHOD } from './methods';
import { mergeCuts } from '@shared/contracts/activity';
import { type TakenActivity, takeHistoryPage, type TakenHistoryPage } from './session-schemas';

/** How much of a turn a read asks Codex for: every item, its own summary, or none (C102, C134). */
const VIEWS: Readonly<Record<HistoryDetail, string>> = { full: 'full', summary: 'summary', none: 'notLoaded' };

/** The request for one page: newest first, which is the CLI's own default. */
export function historyParams(reference: string, page: HistoryRequest): { readonly method: string; readonly params: unknown } {
  return { method: HISTORY_METHOD, params: { threadId: reference, limit: page.size, itemsView: VIEWS[page.detail], ...(page.cursor === null ? {} : { cursor: page.cursor }) } };
}

/** A page's turns, oldest first (M18, C47, C51): the CLI sends them newest first. A time is Codex's own, or null: none is filled in. */
export function historyTurns(page: TakenHistoryPage): HistoryTurn[] {
  return [...page.turns].reverse().map((turn) => ({ turnId: turn.id, outcome: turn.status, startedAt: turn.startedAt, endedAt: turn.completedAt, durationMs: turn.durationMs }));
}

/**
 * A page's messages, oldest first: the CLI sends its turns newest first, each turn's items in order.
 * Each names its turn, and a user's message the id its prompt was sent with, when the CLI kept one
 * (M18, C47).
 */
export function historyMessages(page: TakenHistoryPage): HistoryMessage[] {
  return [...page.turns].reverse().flatMap((turn) => turn.items.flatMap((item, index): HistoryMessage[] => {
    // Its place among its turn's items (M20a, C19): what puts it in one order with the turn's activities.
    const order = turn.places[index] ?? index;
    // Its images by the paths it was sent with (M23, C24, C25): main matches each, and reads none.
    if (item.type === 'userMessage') return [{ role: 'user', itemId: item.id, phase: null, text: item.text, turnId: turn.id, ...(item.clientId === null ? {} : { clientId: item.clientId }), at: turn.startedAt, order, ...(item.cut ? { cut: true } : {}), ...(item.images.length === 0 ? {} : { images: item.images.map((path) => ({ path })) }) }];
    if (item.type !== 'agentMessage') return [];
    // No message at all (M21, C56, C69): the empty one a turn that asks in a message ends with. The
    // live path lets it go at its completion, so the merge must never add it.
    if (item.text === '' && item.questions.length === 0) return [];
    return [{ role: 'assistant', itemId: item.id, phase: item.phase, text: item.text, turnId: turn.id, at: turn.startedAt, order, ...(item.questions.length === 0 ? {} : { questions: [...item.questions] }), ...(item.cut ? { cut: true } : {}) }];
  }));
}

/**
 * A page's activities, oldest first (M20a, C19): each names its turn and its place among that
 * turn's items. Its status is as history gives it — an item still marked in progress reads
 * unfinished — and its time is its turn's start, the only one history has for it.
 */
export function historyActivities(page: TakenHistoryPage): HistoryActivity[] {
  return [...page.turns].reverse().flatMap((turn) => turn.activities.map(({ place, activity }): HistoryActivity => {
    const cut = mergeCuts(activity.startCut, activity.endCut);
    return {
      turnId: turn.id,
      itemId: activity.itemId,
      activityType: activity.activityType,
      name: activity.start.name,
      summary: activity.start.summary,
      ...(typeof activity.start.input === 'string' ? { input: activity.start.input } : {}),
      ...(typeof activity.end.output === 'string' ? { output: activity.end.output } : {}),
      ...(activity.exitCode === null ? {} : { exitCode: activity.exitCode }),
      ...carried(activity),
      ...(cut === null ? {} : { cut }),
      status: activity.outcome === 'in-progress' ? 'unfinished' : activity.outcome,
      ...(activity.durationMs === null ? {} : { durationMs: activity.durationMs }),
      at: turn.startedAt,
      order: place,
    };
  }));
}

/**
 * A page's plans, oldest first (M22b, C28): each names its turn and its place among that turn's
 * items, and holds its whole text. The merge reconciles each with the plan line the store holds for
 * it, and makes it a message where there is none: none is a version.
 */
export function historyPlans(page: TakenHistoryPage): HistoryPlan[] {
  return [...page.turns].reverse().flatMap((turn) => turn.plans.map((plan): HistoryPlan => ({ turnId: turn.id, itemId: plan.id, text: plan.text, at: turn.startedAt, order: plan.place })));
}

/** The lists and the thinking text an item holds, from whichever of its two readings has them: its end's, else its start's. */
export function carried(activity: TakenActivity): Pick<HistoryActivity, 'files' | 'changes' | 'thinking'> {
  const files = activity.end.files ?? activity.start.files;
  const changes = activity.end.changes ?? activity.start.changes;
  const thinking = activity.end.thinking ?? activity.start.thinking;
  return {
    ...(files === undefined || files.length === 0 ? {} : { files: [...files] }),
    ...(changes === undefined || changes.length === 0 ? {} : { changes: [...changes] }),
    ...(typeof thinking === 'string' ? { thinking } : {}),
  };
}

export interface HistoryConnection {
  /** The connection is ready: a read sends nothing otherwise, since asking would start a CLI (C57). */
  ready(): boolean;
  /** Lines this connection has dropped as oversized, counted since it was made (C19). */
  droppedLines(): number;
  /** Told of each line dropped from now on; returns the function that stops it. */
  onDropped(listener: () => void): () => void;
  /** Sends the request through the module's one sender (methods.ts). Rejects with a `ProcessFailure`. */
  ask(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
}

/**
 * One page. `dropped` only when the connection dropped a line while this request was pending
 * (C120): a slow page and a lost one both end as a timeout, so a timeout alone says nothing. The
 * answer comes at the drop, not at the deadline it would otherwise run to. Reads of one connection
 * are made one at a time by the caller, so the dropped line is this read's own reply.
 */
export async function readHistoryPage(connection: HistoryConnection, reference: string, page: HistoryRequest, signal: AbortSignal): Promise<HistoryAnswer> {
  if (signal.aborted || !connection.ready()) return { kind: 'failed' };
  const before = connection.droppedLines();
  const dropped = new AbortController();
  const forward = (): void => dropped.abort();
  signal.addEventListener('abort', forward, { once: true });
  const stop = connection.onDropped(() => dropped.abort());
  try {
    const { method, params } = historyParams(reference, page);
    const taken = takeHistoryPage(await connection.ask(method, params, dropped.signal));
    if (taken === null) return { kind: 'failed' };
    // A read that asked for no item answers none, whatever the CLI sent with its turns (M18, C51).
    // Activities with the items of a full read alone: Codex's summary of a turn is its messages.
    const activities = page.detail === 'full' ? historyActivities(taken) : [];
    // A plan with a turn's messages (M22b, C28): what it wrote is as much its words as a message.
    const plans = page.detail === 'none' ? [] : historyPlans(taken);
    const images = page.detail === 'full' ? [...taken.turns].reverse().flatMap((turn) => turn.images.map((image) => ({ ...image, turnId: turn.id }))) : [];
    return { kind: 'page', turns: historyTurns(taken), messages: page.detail === 'none' ? [] : historyMessages(taken), ...(activities.length === 0 ? {} : { activities }), ...(plans.length === 0 ? {} : { plans }), ...(images.length === 0 ? {} : { images }), next: taken.next };
  } catch (error) {
    const lost = connection.droppedLines() > before && !signal.aborted;
    return lost && error instanceof ProcessFailure && (error.code === 'aborted' || error.code === 'timeout') ? { kind: 'dropped' } : { kind: 'failed' };
  } finally {
    stop();
    signal.removeEventListener('abort', forward);
  }
}
