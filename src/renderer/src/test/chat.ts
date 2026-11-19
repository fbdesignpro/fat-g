// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Conversations for the renderer's chat tests (M18): items and turns in the contract's shape, and a
// stand-in for what main answers `chat:read` and `chat:page` with — the newest page, the window from
// an item on, the page before a cursor — over a list the test holds and may change.
import type { ActivityBody } from '@shared/contracts/activity';
import type { AsideCapability, AsideMarker } from '@shared/contracts/aside';
import type { ChatHistory, ChatPageRequest, ChatPageResult, ChatRead, ChatReadRequest, ChatStorage, WaitingQuestion } from '@shared/contracts/chat';
import { boundItems, type ConversationItem, type ConversationTurn, fitWindow, MAX_PAGE_UNITS, PAGE_ENTRIES } from '@shared/contracts/conversation';
import { type ApprovalBody, approvalOf, type ApprovalRequest, type InteractionQuestion, type QuestionBody, questionOf, raisedBody, type SessionGrant } from '@shared/contracts/interaction';
import type { ChatMode } from '@shared/contracts/permissions';
import type { ChatComposer } from '@shared/contracts/composer';

let made = 0;

/** A message or a notice, each in a turn of its own unless said, placed after every one made before it. */
export function chatItem(conversationId: string, role: 'user' | 'assistant' | 'notice', text: string, overrides: Partial<ConversationItem> & { readonly cut?: boolean } = {}): ConversationItem {
  made += 1;
  const { cut = false, ...rest } = overrides;
  return {
    id: `m${made}`,
    conversationId,
    turnId: `t${made}`,
    order: { turn: made, item: 0 },
    kind: role === 'notice' ? 'notice' : 'message',
    origin: 'local',
    providerItemId: null,
    workerId: null,
    activity: null,
    interaction: null,
    role: role === 'notice' ? null : role,
    phase: role === 'assistant' ? 'final' : null,
    model: null,
    state: 'complete',
    blocks: [{ type: 'text', text, cut }],
    questions: [],
    notice: null,
    detail: null,
    time: { receivedAt: 1, providerAt: null },
    ...rest,
  };
}

/**
 * An activity of a turn (M20a): completed in a second unless said, placed after every item made
 * before it. Made one after another under one `turnId`, they are one group of the list.
 */
export function chatActivity(conversationId: string, turnId: string, body: Partial<ActivityBody> & Pick<ActivityBody, 'type'>, overrides: Partial<ConversationItem> = {}): ConversationItem {
  made += 1;
  const activity: ActivityBody = {
    name: body.type, summary: '', input: null, output: null, files: [], status: 'completed', exitCode: null, changes: [], steps: [], thinking: null, workerId: null,
    duration: body.status === 'running' || body.status === 'unfinished' ? null : { ms: 1_000, provenance: 'local' }, cut: null, declinedBy: null, model: null, agentType: null, ...body,
  };
  return {
    id: `m${made}`,
    conversationId,
    turnId,
    order: { turn: made, item: 0 },
    kind: 'activity',
    origin: 'local',
    providerItemId: `p${made}`,
    workerId: null,
    activity,
    interaction: null,
    role: null,
    phase: null,
    model: null,
    state: activity.status === 'running' ? 'streaming' : activity.status === 'unfinished' ? 'partial' : 'complete',
    blocks: [],
    questions: [],
    notice: null,
    detail: null,
    time: { receivedAt: 1, providerAt: null },
    ...overrides,
  };
}

/** A question as a card draws it: two options, one choice, free text taken, unless said. */
export function cardQuestion(patch: Partial<InteractionQuestion> = {}): InteractionQuestion {
  return { text: 'Which file should I read?', header: 'File', options: [{ label: 'notes-1.txt', description: 'The first note' }, { label: 'notes-2.txt', description: null }], multiple: false, freeText: true, secret: false, ...patch };
}

/**
 * A question's card of a turn (M21): a blocking one, pending, with one question, unless said,
 * placed after every item made before it.
 */
export function chatCard(conversationId: string, turnId: string, body: Partial<QuestionBody> = {}, overrides: Partial<ConversationItem> = {}): ConversationItem {
  made += 1;
  const mode = body.mode ?? 'blocking';
  return {
    id: `m${made}`,
    conversationId,
    turnId,
    order: { turn: made, item: 0 },
    kind: 'interaction',
    origin: 'local',
    providerItemId: `p${made}`,
    workerId: null,
    activity: null,
    interaction: { ...raisedBody(mode, [cardQuestion()], false), ...body },
    role: null,
    phase: null,
    model: null,
    state: 'complete',
    blocks: [],
    questions: [],
    notice: null,
    detail: null,
    time: { receivedAt: 1, providerAt: null },
    ...overrides,
  };
}

/** A question's card as a push of its next state carries it: the same item, its body changed. An item that holds no question is as it was. */
export function cardWith(item: ConversationItem, patch: Partial<QuestionBody>): ConversationItem {
  const body = questionOf(item);
  return body === null ? item : { ...item, interaction: { ...body, ...patch } };
}

/** An approval's card as a push of its next state carries it (M22): the same item, its body changed. */
export function approvalWith(item: ConversationItem, patch: Partial<Omit<ApprovalBody, 'kind'>>): ConversationItem {
  const body = approvalOf(item);
  return body === null ? item : { ...item, interaction: { ...body, ...patch } };
}

/** A request for leave to act as a card draws it (M22): a command, with Approve once and Deny, whole, unless said. */
export function approvalRequest(patch: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    kind: 'command', tool: 'Bash', summary: 'touch notes.txt', folder: null, targets: [], outside: false, reason: null, authority: [],
    detail: { kind: 'command', command: 'touch notes.txt' }, choices: ['approve', 'deny'], grant: null, modeThatWouldStop: null, cut: false, ...patch,
  };
}

/**
 * An approval's card of a turn (M22): pending, for a command, unless said, placed after every item
 * made before it. `request` patches the request alone.
 */
export function chatApproval(conversationId: string, turnId: string, body: Partial<Omit<ApprovalBody, 'request' | 'kind'>> & { readonly request?: Partial<ApprovalRequest> } = {}, overrides: Partial<ConversationItem> = {}): ConversationItem {
  made += 1;
  const { request, ...rest } = body;
  const interaction: ApprovalBody = { kind: 'approval', request: approvalRequest(request), outcome: 'pending', decidedAt: null, settledAt: null, delivered: null, confirmedAt: null, withdrawnBy: null, grant: null, ...rest };
  return {
    id: `m${made}`,
    conversationId,
    turnId,
    order: { turn: made, item: 0 },
    kind: 'interaction',
    origin: 'local',
    providerItemId: `p${made}`,
    workerId: null,
    activity: null,
    interaction,
    role: null,
    phase: null,
    model: null,
    state: 'complete',
    blocks: [],
    questions: [],
    notice: null,
    detail: null,
    time: { receivedAt: 1, providerAt: null },
    ...overrides,
  };
}

/** A turn that ended, unless said. */
export function chatTurn(id: string, overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id,
    place: 0,
    origin: 'local',
    state: 'ended',
    outcome: 'completed',
    gap: false,
    mode: null,
    time: { acceptedAt: null, providerStartedAt: null, providerEndedAt: null, endReceivedAt: null, providerDurationMs: null, elapsedMs: null },
    ...overrides,
  };
}

/** `count` messages of one conversation, oldest first, named "<prefix> 1" onwards. */
export function chatItems(conversationId: string, count: number, prefix = 'message'): ConversationItem[] {
  return Array.from({ length: count }, (_, index) => chatItem(conversationId, index % 2 === 0 ? 'user' : 'assistant', `${prefix} ${index + 1}`));
}

export const CHECKED: ChatHistory = { state: 'checked', olderUnread: false, earlierMissing: false };

/** What main holds of one session's chat, as far as the page can tell. */
export interface FakeChat {
  readonly sessionId: string;
  /** The whole conversation, oldest first. */
  items: ConversationItem[];
  /** Turns that are not simply ended, by id. */
  turns: Map<string, ConversationTurn>;
  revision: number;
  history: ChatHistory;
  storage: ChatStorage;
  /** The session's asides, as its read lists them (M20b, C30), and whether it can be asked beside (C48). */
  asides: AsideMarker[];
  asking: AsideCapability;
  /** The session's workers' questions that wait for an answer, as its read lists them (M21, C73). */
  waiting: WaitingQuestion[];
  /** The chat's saved mode, and the grants fat-g sent, as its read lists them (M22, C40, C57). */
  mode: ChatMode | null;
  grants: SessionGrant[];
  /** The composer beside it, as its read carries it (M23, C57): left out while null. */
  composer: ChatComposer | null;
  /** The turn an item belongs to, as main would send it. */
  turnOf(item: ConversationItem): ConversationTurn;
  read(request: ChatReadRequest): ChatRead;
  page(request: ChatPageRequest): ChatPageResult;
}

export function fakeChat(sessionId: string, items: readonly ConversationItem[] = [], revision = items.length): FakeChat {
  const chat: FakeChat = {
    sessionId,
    items: [...items],
    turns: new Map(),
    revision,
    history: CHECKED,
    storage: 'ok',
    asides: [],
    asking: 'none',
    waiting: [],
    mode: null,
    grants: [],
    composer: null,
    turnOf: (item) => chat.turns.get(item.turnId) ?? chatTurn(item.turnId, { place: item.order.turn }),
    read(request) {
      const all = chat.items;
      const start = 'from' in request ? all.findIndex((item) => item.id === request.from) : -1;
      // The window from that item on, within its bounds — or the newest page, also for a `from` the
      // store does not have, which is answered as a first read (C60).
      const fitted = 'from' in request && start !== -1 ? fitWindow(all.slice(start), request.keep) : null;
      // A page is bounded as main bounds one (M20a, C31): by its entries and its size, an entry whole or not at all.
      const held = fitted === null ? boundItems(all, 'newest', PAGE_ENTRIES, MAX_PAGE_UNITS).items : fitted.items;
      const latest = fitted === null || !fitted.cut || ('from' in request && request.keep === 'newest');
      const first = held[0];
      return {
        status: 'read',
        sessionId,
        revision: chat.revision,
        items: held,
        latest,
        turns: turnsOf(chat, held),
        older: first !== undefined && first !== all[0] ? first.id : null,
        history: chat.history,
        storage: chat.storage,
        asides: chat.asides,
        asking: chat.asking,
        waiting: chat.waiting,
        mode: chat.mode,
        grants: chat.grants,
        ...(chat.composer === null ? {} : { composer: chat.composer }),
      };
    },
    page({ before }) {
      const all = chat.items;
      const end = all.findIndex((item) => item.id === before);
      if (end === -1) return { status: 'refused', reason: 'unknown-cursor' };
      const held = boundItems(all.slice(0, end), 'newest', PAGE_ENTRIES, MAX_PAGE_UNITS).items;
      const first = held[0];
      return { status: 'page', sessionId, revision: chat.revision, items: held, turns: turnsOf(chat, held), older: first !== undefined && first !== all[0] ? first.id : null };
    },
  };
  return chat;
}

function turnsOf(chat: FakeChat, items: readonly ConversationItem[]): ConversationTurn[] {
  const turns = new Map<string, ConversationTurn>();
  for (const item of items) turns.set(item.turnId, chat.turnOf(item));
  return [...turns.values()];
}
