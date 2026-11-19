// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A stage for the tests of a session's asides in the page (M20b): a fake bridge that answers a
// chat's read from what the test holds, with its asides and whether it can be asked beside, and the
// four aside channels from functions the test may replace. It records every request.
import { act, render } from '@testing-library/react';
import type { AsideCapability, AsideMarker, AsideSourceRef, AsideView } from '@shared/contracts/aside';
import type { ChatAsideReadRequest, ChatAsideReadResult, ChatAsideRemoveResult, ChatAsideStopResult, ChatAskRequest, ChatAskResult, ChatPush } from '@shared/contracts/chat';
import type { ConversationItem, ConversationTurn } from '@shared/contracts/conversation';
import { planOf } from '@shared/contracts/interaction';
import type { SessionWorkflow } from '@shared/contracts/workflow';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { PaneWithKinds } from './pane';
import { BUILT_IN_KINDS } from '../artifacts/kinds';
import { registerKinds, resetTabs, type Tab, useTabs } from '../artifacts/tabs-store';
import { resetAsides } from '../chat/asides-store';
import { useChatDrafts } from '../chat/chat-store';
import { resetWorkflows } from '../chat/workflow-store';
import { showDetached } from '../chat/detached-store';
import { ChatRegion } from '../shell/ChatRegion';
import { chatTurn, type FakeChat, fakeChat } from './chat';
import { installDialogStandIn } from './dialog';
import { type FakeBridge, installFakeBridge } from './fake-bridge';
import { project } from './records';
import { showState } from './sessions';

/** How each built-in provider answers an aside (C24). */
export const CODEX_ASIDES: AsideCapability = { followUp: true, streamed: true, tools: 'read-only' };
export const CLAUDE_ASIDES: AsideCapability = { followUp: true, streamed: false, tools: 'none' };

export const PROJECT = project('Calamari', { providers: ['codex'] });
export const CATALOG = {
  ...sampleCatalog([]),
  providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', resolvedId: 'gpt-6-sol', name: 'GPT-6 Sol' }), sampleModel({ key: 'gpt-6-luna', resolvedId: 'gpt-6-luna', name: 'GPT-6 Luna' })] })],
};
export const PROVIDERS = [sampleProvider({ id: 'codex', displayName: 'Codex' })];
export const session = (name: string, summary = SUMMARIES.idle): SessionEntry => sessionEntry(name, summary, { projectId: PROJECT.id, providerId: 'codex', model: 'gpt-6-sol', effort: 'high' });

/** A marker of an aside asked about a message, with no place in its drawing unless one is given. */
export function marker(id: string, title: string, source: Partial<AsideSourceRef> | null = {}, overrides: Partial<AsideMarker> = {}): AsideMarker {
  return {
    id, title, createdAt: 1, running: false,
    source: source === null ? null : { kind: 'message', itemId: null, role: 'assistant', part: null, workerId: null, path: null, lines: null, range: { start: 0, end: 1 }, digest: '00000000', ...source },
    ...overrides,
  };
}

/** What main holds of one aside, as its own read answers it. */
export interface HeldAside {
  view: AsideView;
  items: ConversationItem[];
  turns: ConversationTurn[];
}

export interface AsideStage {
  readonly bridge: FakeBridge;
  readonly requests: [InvokeChannel, unknown][];
  /** What main holds of each session's chat. */
  readonly chats: Record<string, FakeChat>;
  /** And of each aside, by its id: one main does not hold reads as unknown. */
  readonly asides: Record<string, HeldAside>;
  /** The providers the app state lists: Codex's sample unless a test says otherwise. */
  providers: readonly ProviderSnapshot[];
  /** A test's own answers, by channel, before the stage's (M22b): what a plan's channels answer. */
  readonly answers: Partial<Record<InvokeChannel, (request: unknown) => unknown>>;
  /** How main answers an ask: by default it takes it, under the id it was sent. */
  ask: (request: ChatAskRequest) => ChatAskResult | Promise<ChatAskResult>;
  stop: (request: { sessionId: string; asideId: string }) => ChatAsideStopResult;
  remove: (request: { sessionId: string; asideId: string }) => ChatAsideRemoveResult;
  /** A session's chat as main holds it, made on first use. */
  chat(entry: SessionEntry): FakeChat;
  sent(channel: InvokeChannel): unknown[];
  tabs(entry: SessionEntry): readonly Tab[];
  /** The app's state with these sessions, the first selected unless another is. */
  show(entries: readonly SessionEntry[], selected?: SessionEntry | null): void;
  /** The chat region, and — where asked — the pane beside it. */
  open(entries: readonly SessionEntry[], selected?: SessionEntry | null, pane?: boolean): Promise<ReturnType<typeof render>>;
  push(payload: ChatPush): void;
  /** The `changed` push: the session's list of asides is to be read again. */
  changed(entry: SessionEntry): void;
  settle(): Promise<void>;
}

function readAside(stage: AsideStage, request: ChatAsideReadRequest): ChatAsideReadResult {
  const held = stage.asides[request.asideId];
  if (held === undefined) return { status: 'refused', reason: 'unknown-aside' };
  const end = request.before === undefined ? held.items.length : held.items.findIndex((item) => item.id === request.before);
  if (end === -1) return { status: 'refused', reason: 'unknown-cursor' };
  const items = held.items.slice(0, end);
  const turns = held.turns.length > 0 ? held.turns : [...new Set(items.map((item) => item.turnId))].map((turnId, index) => chatTurn(turnId, { place: index + 1 }));
  return { status: 'read', sessionId: request.sessionId, asideId: request.asideId, revision: stage.chats[request.sessionId]?.revision ?? 0, aside: held.view, items, turns, older: null };
}

/**
 * A chat's part in its plan's workflow as main would answer it where a test says nothing else
 * (decision 0029): ready on the version its newest waiting line stands on, the chat alone taking part.
 */
export function workflowOf(stage: AsideStage, sessionId: string): SessionWorkflow | null {
  const items = stage.chats[sessionId]?.items ?? [];
  const waiting = [...items].reverse().map((item) => planOf(item)).find((body) => body !== null && body.outcome === 'pending') ?? null;
  if (waiting === null || waiting === undefined) return null;
  return { kind: 'plan', role: 'participant', workflow: { planId: waiting.planId, state: 'ready', revision: 1, version: waiting.version, participants: [sessionId], holder: null, operation: null, reviewId: null, busy: null } };
}

/** Call in `beforeEach`: a clean page, and a bridge that answers from what the stage holds. */
export function asideStage(): AsideStage {
  installDialogStandIn();
  const bridge = installFakeBridge('win32');
  resetTabs();
  // The pane registers the kinds when it mounts: a test without it opens tabs all the same.
  registerKinds(BUILT_IN_KINDS);
  resetAsides();
  resetWorkflows();
  showDetached(null);
  useChatDrafts.setState({ drafts: {} });
  const settle = () => act(async () => { for (let turn = 0; turn < 6; turn += 1) await Promise.resolve(); });
  const stage: AsideStage = {
    bridge,
    requests: [],
    chats: {},
    asides: {},
    providers: PROVIDERS,
    answers: {},
    ask: (request) => ({ status: 'accepted', asideId: request.asideId }),
    stop: () => ({ status: 'stopping' }),
    remove: () => ({ status: 'removed' }),
    chat(entry) { return (stage.chats[entry.record.id] ??= fakeChat(entry.record.id)); },
    sent: (channel) => stage.requests.filter(([name]) => name === channel).map(([, request]) => request),
    tabs: (entry) => useTabs.getState().sessions[entry.record.id]?.tabs ?? [],
    show(entries, selected = entries[0] ?? null) {
      act(() => { showState({ projects: [PROJECT], sessions: [...entries], selectedId: selected?.record.id ?? null, catalog: CATALOG, providers: stage.providers }); });
    },
    async open(entries, selected = entries[0] ?? null, pane = false) {
      stage.show(entries, selected);
      const view = render(<>{<ChatRegion />}{pane && <PaneWithKinds kinds={BUILT_IN_KINDS} />}</>);
      await settle();
      return view;
    },
    push(payload) {
      act(() => {
        // What main pushes of an item, its store holds: a later read finds it so.
        if ('item' in payload) {
          const chat = (stage.chats[payload.sessionId] ??= fakeChat(payload.sessionId));
          const at = chat.items.findIndex((item) => item.id === payload.item.id);
          if (at === -1) chat.items.push(payload.item); else chat.items[at] = payload.item;
        }
        bridge.push('chat:message', payload);
        // A plan's line that changed changes its chat's part in the plan's workflow, as main says by its own push (decision 0029).
        const body = 'item' in payload ? planOf(payload.item) : null;
        if (body !== null) bridge.push('plans:workflowChanged', { planId: body.planId, sessionIds: [payload.sessionId] });
      });
    },
    changed(entry) {
      const chat = stage.chat(entry);
      chat.revision += 1;
      stage.push({ sessionId: entry.record.id, revision: chat.revision, changed: true });
    },
    settle,
  };
  bridge.setInvoke(async (channel, request) => {
    stage.requests.push([channel, request]);
    const own = stage.answers[channel];
    if (own !== undefined) return { ok: true, value: await own(request) };
    if (channel === 'chat:read') {
      const { sessionId } = request as { sessionId: string };
      return { ok: true, value: (stage.chats[sessionId] ??= fakeChat(sessionId)).read(request as { sessionId: string }) };
    }
    if (channel === 'chat:ask') return { ok: true, value: await stage.ask(request as ChatAskRequest) };
    if (channel === 'chat:readAside') return { ok: true, value: readAside(stage, request as ChatAsideReadRequest) };
    if (channel === 'chat:stopAside') return { ok: true, value: stage.stop(request as { sessionId: string; asideId: string }) };
    if (channel === 'chat:removeAside') return { ok: true, value: stage.remove(request as { sessionId: string; asideId: string }) };
    if (channel === 'chat:send') return { ok: true, value: { status: 'accepted' } };
    if (channel === 'chat:stop') return { ok: true, value: { status: 'stopping' } };
    if (channel === 'plans:list') return { ok: true, value: { status: 'listed', plans: [] } };
    if (channel === 'plans:workflow') return { ok: true, value: { status: 'read', workflow: workflowOf(stage, (request as { sessionId: string }).sessionId) } };
    return { ok: true, value: { status: 'saved' } };
  });
  return stage;
}
