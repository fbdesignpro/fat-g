// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15 (docs/planning/_archive/M18.md, Design 8; C31, C32, C35): the row of chats without a session, at the foot
// of the project column, and the read-only chat it opens in the chat region. The column and the chat
// region together, on a fake bridge that answers the `conversations:` channels from chats the test
// holds and records each call.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import type { DetachedConversation } from '@shared/contracts/conversation';
import { sessionDisplayName } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import chatStyles from '../chat/Chat.module.css';
import { showDetached, useDetached } from '../chat/detached-store';
import { ProjectList } from '../projects/ProjectList';
import { ChatRegion } from '../shell/ChatRegion';
import { chatItems, type FakeChat, fakeChat } from '../test/chat';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState, type ShownState } from '../test/sessions';
import { detachedText, removeDetachedFailedText, removeDetachedText } from '../ui/detached-text';
import { DETACHED_LIST_FAILED_TEXT } from './DetachedRow';

const TRIP: DetachedConversation = { id: '0d0d0d0d-0000-4000-8000-000000000001', name: 'Plan the trip', createdAt: 1_579_696_800_000 };
const BUG: DetachedConversation = { id: '0d0d0d0d-0000-4000-8000-000000000002', name: 'Why does the login fail?', createdAt: 1_579_696_900_000 };
/** One with no prompt to name it: shown by its date. */
const UNNAMED: DetachedConversation = { id: '0d0d0d0d-0000-4000-8000-000000000003', name: null, createdAt: 1_579_697_000_000 };

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let listed: DetachedConversation[];
let chats: Record<string, FakeChat>;
let answers: Partial<Record<InvokeChannel, unknown>>;

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  requests = [];
  listed = [TRIP, BUG, UNNAMED];
  chats = { [TRIP.id]: fakeChat(TRIP.id, chatItems(TRIP.id, 250, 'trip')), [BUG.id]: fakeChat(BUG.id, chatItems(BUG.id, 2, 'bug')) };
  answers = {};
  showDetached(null);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    const value = (): unknown => {
      if (answers[channel] !== undefined) return answers[channel];
      if (channel === 'conversations:listDetached') return listed;
      if (channel === 'conversations:readDetached') {
        const { id, before } = request as { id: string; before?: string };
        const chat = chats[id];
        if (chat === undefined) return { status: 'refused', reason: 'unknown-conversation' };
        if (before !== undefined) return chat.page({ sessionId: id, before });
        const newest = chat.read({ sessionId: id });
        return { status: 'page', sessionId: id, revision: 0, items: newest.items, turns: newest.turns, older: newest.older };
      }
      if (channel === 'chat:read') return fakeChat((request as { sessionId: string }).sessionId).read(request as { sessionId: string });
      return { status: 'saved' };
    };
    return Promise.resolve({ ok: true, value: value() });
  });
});
afterEach(cleanup);

function Harness() {
  const column = useRef<HTMLElement>(null);
  return (
    <>
      <aside ref={column} aria-label="Projects">
        <ProjectList column={column} />
      </aside>
      <ChatRegion />
    </>
  );
}

const A = project('Calamari');
const SESSION = sessionEntry('Fix login', SUMMARIES.idle, { projectId: A.id });
const show = (detached: number, extra: Partial<ShownState> = {}) => act(() => { showState({ projects: [A], sessions: [SESSION], conversations: { status: { kind: 'ok' }, detached }, ...extra }); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const column = () => screen.getByRole('complementary', { name: 'Projects' });
const chat = () => screen.getByRole('main', { name: 'Chat' });
const row = () => column().querySelector<HTMLElement>('[data-detached-row]');
const toggle = () => within(row() as HTMLElement).getByRole('button', { expanded: false });
const list = () => within(column()).getByRole('list', { name: 'Chats without a session' });
const names = () => within(list()).getAllByRole('listitem').map((item) => item.querySelector('span')?.textContent);
const asked = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
const texts = () => within(chat()).queryAllByRole('article').map((article) => article.querySelectorAll('p')[0]?.textContent);

async function openList(detached = 3, extra: Partial<ShownState> = {}) {
  show(detached, extra);
  render(<Harness />);
  fireEvent.click(toggle());
  await settle();
}
async function choose(conversation: DetachedConversation) {
  fireEvent.click(within(list()).getByRole('button', { name: sessionDisplayName(conversation) }));
  await settle();
}

describe('the row of chats without a session (V15; C31)', () => {
  it('shows only with a count above zero, under the row of sessions without a project', () => {
    show(0, { orphans: 2 });
    const view = render(<Harness />);
    expect(row()).toBeNull();
    view.unmount();
    show(3, { orphans: 2 });
    render(<Harness />);
    expect(row()?.textContent).toBe('3 chats without a sessionRemove all');
    const orphans = column().querySelector('[data-orphan-row]') as HTMLElement;
    expect(orphans.compareDocumentPosition(row() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    show(1);
    expect(row()?.textContent).toBe('1 chat without a sessionRemove all');
    // The count is all the app state holds of them: nothing is asked of main until the row is opened.
    expect(requests).toEqual([]);
  });

  it('lists them when opened: each by its first prompt’s first line, and by its date when it has none', async () => {
    await openList();
    expect(asked('conversations:listDetached')).toEqual([null]);
    expect(names()).toEqual(['Plan the trip', 'Why does the login fail?', sessionDisplayName(UNNAMED)]);
    expect(sessionDisplayName(UNNAMED)).toMatch(/2020/);
    // Closed again, the list goes; nothing was read of any chat.
    fireEvent.click(within(row() as HTMLElement).getByRole('button', { expanded: true }));
    expect(within(column()).queryByRole('list', { name: 'Chats without a session' })).toBeNull();
    expect(asked('conversations:readDetached')).toEqual([]);
  });

  it('asks for the list again when the count changes while it is open', async () => {
    await openList();
    listed = [TRIP];
    show(1);
    await settle();
    expect(asked('conversations:listDetached')).toHaveLength(2);
    expect(names()).toEqual(['Plan the trip']);
  });

  it('says so when the list could not be read', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'internal' }));
    await openList();
    expect(within(column()).getByRole('status').textContent).toBe(DETACHED_LIST_FAILED_TEXT);
  });
});

describe('a chat without a session, opened (V15; C35)', () => {
  it('shows read-only in the chat region, a page at a time, with no input', async () => {
    await openList();
    await choose(TRIP);
    expect(asked('conversations:readDetached')).toEqual([{ id: TRIP.id }]);
    expect(texts()).toHaveLength(100);
    expect(texts().at(-1)).toBe('trip 250');
    expect(within(chat()).queryByRole('textbox')).toBeNull();
    expect(within(chat()).queryByRole('button', { name: 'Send' })).toBeNull();
    expect(within(chat()).getByRole('note').textContent).toContain(CHAT_LINES.readOnly);
    expect(within(chat()).getByRole('note').textContent).toContain('Plan the trip');
    expect(within(list()).getByRole('button', { name: 'Plan the trip' }).getAttribute('aria-current')).toBe('true');
    // Older pages, from the control, by the cursor of the oldest message held.
    const first = chats[TRIP.id]?.items[150];
    fireEvent.click(within(chat()).getByRole('button', { name: CHAT_LINES.showEarlier }));
    await settle();
    expect(asked('conversations:readDetached').at(-1)).toEqual({ id: TRIP.id, before: first?.id });
    expect(texts()).toHaveLength(200);
    expect(within(chat()).getByText(CHAT_LINES.earlierLoaded(100))).toBeTruthy();
    fireEvent.click(within(chat()).getByRole('button', { name: CHAT_LINES.showEarlier }));
    await settle();
    expect(texts()).toHaveLength(250);
    expect(texts()[0]).toBe('trip 1');
    expect(within(chat()).queryByRole('button', { name: CHAT_LINES.showEarlier })).toBeNull();
  });

  it('can be selected and copied: its text is text, in the list a session’s chat has', async () => {
    await openList();
    await choose(BUG);
    const log = within(chat()).getByRole('group', { name: 'Messages' });
    // The one part of the shell whose text can be selected (tests/architecture/styles.test.ts).
    expect(log.classList.contains(chatStyles.list ?? '')).toBe(true);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(log);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(selection?.toString()).toContain('bug 1');
    expect(selection?.toString()).toContain('bug 2');
    selection?.removeAllRanges();
  });

  it('asks main for its pages and nothing else: no prompt, no history read, nothing of a provider', async () => {
    await openList();
    await choose(TRIP);
    fireEvent.click(within(chat()).getByRole('button', { name: CHAT_LINES.showEarlier }));
    await settle();
    expect([...new Set(requests.map(([channel]) => channel))]).toEqual(['conversations:listDetached', 'conversations:readDetached']);
  });

  it('gives way to a session’s chat when one is selected, the selected one too', async () => {
    await openList(3, { selectedId: SESSION.record.id });
    await choose(BUG);
    expect(chat().querySelector('[data-detached-chat]')).not.toBeNull();
    fireEvent.click(within(column()).getByRole('button', { name: /^Fix login, / }));
    await settle();
    expect(useDetached.getState().shown).toBeNull();
    expect(chat().querySelector('[data-detached-chat]')).toBeNull();
    expect(within(chat()).getByRole('textbox')).toBeTruthy();
  });

  it('says so when it is no longer a chat without a session', async () => {
    await openList();
    Reflect.deleteProperty(chats, BUG.id);
    await choose(BUG);
    expect(within(chat()).getByRole('note').textContent).toContain('This chat is no longer among the chats without a session');
    expect(texts()).toEqual([]);
  });
});

describe('removing chats without a session (V15; C32)', () => {
  it('removes one after a confirmation that says one chat goes, and nothing of a provider’s', async () => {
    await openList();
    await choose(BUG);
    fireEvent.click(within(list()).getByRole('button', { name: 'Remove Why does the login fail?' }));
    const dialog = screen.getByRole('dialog', { name: `Remove ${detachedText(1)}?` });
    expect(dialog.textContent).toContain('Why does the login fail?');
    expect(dialog.textContent).toContain(removeDetachedText(1));
    expect(removeDetachedText(1)).toContain('Nothing in the providers’ own histories is deleted.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(asked('conversations:removeDetached')).toEqual([]);
    fireEvent.click(within(list()).getByRole('button', { name: 'Remove Why does the login fail?' }));
    listed = [TRIP, UNNAMED];
    fireEvent.click(within(screen.getByRole('dialog', { name: `Remove ${detachedText(1)}?` })).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(asked('conversations:removeDetached')).toEqual([{ ids: [BUG.id] }]);
    // It was the one shown: the chat region lets go of it, and the list is asked for again.
    expect(useDetached.getState().shown).toBeNull();
    expect(names()).toEqual(['Plan the trip', sessionDisplayName(UNNAMED)]);
  });

  it('removes all after a confirmation that says how many go', async () => {
    await openList();
    await choose(TRIP);
    fireEvent.click(within(row() as HTMLElement).getByRole('button', { name: 'Remove all' }));
    const dialog = screen.getByRole('dialog', { name: `Remove ${detachedText(3)}?` });
    expect(dialog.textContent).toContain(removeDetachedText(3));
    expect(removeDetachedText(3)).toContain('the 3 chats it saved');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(asked('conversations:removeDetached')).toEqual([]);
    fireEvent.click(within(row() as HTMLElement).getByRole('button', { name: 'Remove all' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: `Remove ${detachedText(3)}?` })).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(asked('conversations:removeDetached')).toEqual([{ all: true }]);
    expect(useDetached.getState().shown).toBeNull();
    // Main's next state has none left: the row goes.
    show(0);
    expect(row()).toBeNull();
  });

  it('removes the one shown from the chat region, after its own confirmation', async () => {
    await openList();
    await choose(TRIP);
    fireEvent.click(within(within(chat()).getByRole('note')).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: `Remove ${detachedText(1)}?` });
    expect(dialog.textContent).toContain('Plan the trip');
    expect(dialog.textContent).toContain(removeDetachedText(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(asked('conversations:removeDetached')).toEqual([{ ids: [TRIP.id] }]);
    expect(chat().querySelector('[data-detached-chat]')).toBeNull();
  });

  it.each(['records-refused', 'conversations-refused', 'storage-failed', 'unknown-conversation'] as const)('says nothing went when main refuses as %s, and keeps the chat shown', async (reason) => {
    answers['conversations:removeDetached'] = { status: 'refused', reason };
    await openList();
    await choose(TRIP);
    fireEvent.click(within(row() as HTMLElement).getByRole('button', { name: 'Remove all' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: `Remove ${detachedText(3)}?` })).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(within(column()).getByRole('status').textContent).toBe(removeDetachedFailedText(3));
    expect(useDetached.getState().shown).toBe(TRIP);
    expect(texts()).toHaveLength(100);
  });

  it('is not offered while records are refused, for one or for all: the chats are counted, listed and read', async () => {
    await openList(3, { recordsStatus: { kind: 'refused', cause: 'unreadable' } });
    // With no session listed, every saved chat is without one: the row stands under the records note.
    expect(row()?.textContent).toBe('3 chats without a session');
    expect(names()).toEqual(['Plan the trip', 'Why does the login fail?', sessionDisplayName(UNNAMED)]);
    expect(within(column()).queryByRole('button', { name: /^Remove/ })).toBeNull();
    await choose(BUG);
    expect(texts()).toEqual(['bug 1', 'bug 2']);
    const note = within(chat()).getByRole('note');
    expect(within(note).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(note).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(asked('conversations:removeDetached')).toEqual([]);
  });
});
