// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V11, V19 (docs/planning/_archive/M18.md, Design 9; C23, C32, C33, C41): Settings' Storage section — the sizes,
// the cleanups and their failures, the set-aside stores removed by name, and the refused store's
// note. The section alone, on a fake bridge that answers `conversations:storage` from what the test
// holds and records each call.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationsState, ConversationsStorage } from '@shared/contracts/conversation';
import type { InvokeChannel } from '@shared/ipc/channels';
import { showDetached, useDetached } from '../chat/detached-store';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { showState, type ShownState } from '../test/sessions';
import { detachedText, removeDetachedFailedText, removeDetachedText } from '../ui/detached-text';
import { formatBytes } from '../ui/format';
import { explain, startFreshText, unchangedText } from '../ui/refusal-text';
import { SET_ASIDE_REFUSED_TEXT, setAsideFailedText, STORAGE_UNREAD_TEXT, StorageSection } from './StorageSection';

const FIRST = 'conversations.set-aside.2020-01-23T09-00-00Z.sqlite';
const SECOND = 'conversations.set-aside.2020-01-24T18-30-05Z-1.sqlite';
const OK: ConversationsState = { status: { kind: 'ok' }, detached: 0 };

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let storage: ConversationsStorage;
let answers: Partial<Record<InvokeChannel, unknown>>;
/** The plans' count and size (M22b, C21): none unless a test says otherwise. */
let plans: { count: number; bytes: number; orphans: number };

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  requests = [];
  answers = {};
  storage = { status: { kind: 'ok' }, bytes: 3 * 1024 * 1024, detached: { count: 0, textUnits: 0 }, setAside: [], attachments: { count: 0, bytes: 0 } };
  plans = { count: 0, bytes: 0, orphans: 0 };
  showDetached(null);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: channel === 'conversations:storage' ? storage : channel === 'plans:storage' ? plans : answers[channel] ?? (channel === 'shell:showDataFolder' ? null : { status: 'saved' }) });
  });
});
afterEach(cleanup);

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const section = () => screen.getByRole('tabpanel');
const rows = (kind: string) => [...section().querySelectorAll<HTMLElement>(`[data-storage-row="${kind}"]`)];
const asked = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
const acted = () => requests.filter(([name]) => name !== 'conversations:storage' && name !== 'plans:storage');
const confirm = async (name: string | RegExp, button = 'Remove') => {
  fireEvent.click(within(screen.getByRole('dialog', { name })).getByRole('button', { name: button }));
  await settle();
};

async function open(state: Partial<ShownState> = { conversations: OK }) {
  act(() => { showState(state); });
  render(<StorageSection />);
  await settle();
}

describe('the sizes (V11; C23)', () => {
  // M23, V3 (C12): the images' folder beside the store, counted and measured, removed by nothing of its own.
  it('lists the images with their count and size, and offers no removal of them', async () => {
    storage = { ...storage, attachments: { count: 3, bytes: 3 * 1024 * 1024 } };
    await open();
    expect(rows('attachments')[0]?.textContent).toContain('Images');
    expect(rows('attachments')[0]?.textContent).toContain('3 images');
    expect(rows('attachments')[0]?.textContent).toContain('3.0 MB');
    expect(within(rows('attachments')[0] as HTMLElement).queryAllByRole('button')).toEqual([]);
    storage = { ...storage, attachments: null };
    cleanup();
    await open();
    expect(rows('attachments')[0]?.textContent).toContain('Size unknown');
  });

  it('asks for them when it shows: the store’s size, and no row for what there is none of', async () => {
    await open();
    expect(asked('conversations:storage')).toEqual([null]);
    expect(rows('store')[0]?.textContent).toContain('Saved chats');
    expect(rows('store')[0]?.textContent).toContain('3.0 MB');
    expect(rows('detached')).toEqual([]);
    expect(rows('set-aside')).toEqual([]);
    // The plans' row is always there (M22b, C21), with its folder; Remove all only where there are plans.
    expect(within(section()).queryAllByRole('button').map((button) => button.textContent)).toEqual(['Show data folder', 'Show plans folder']);
  });

  it('shows the chats without a session with their count and their text’s size, and each set-aside store by name with its size', async () => {
    storage = { ...storage, detached: { count: 3, textUnits: 987 }, setAside: [{ name: FIRST, bytes: 2048 }, { name: SECOND, bytes: 5 * 1024 * 1024 }] };
    await open({ conversations: { status: { kind: 'ok' }, detached: 3 } });
    expect(rows('detached')[0]?.textContent).toContain(detachedText(3));
    expect(rows('detached')[0]?.textContent).toContain('987 characters of text');
    expect(rows('set-aside').map((row) => row.textContent)).toEqual([`${FIRST}Size: 2.0 KBRemove`, `${SECOND}Size: 5.0 MBRemove`]);
    expect(rows('set-aside-all')[0]?.textContent).toContain('2 set-aside stores');
    expect(rows('set-aside-all')[0]?.textContent).toContain(formatBytes(2048 + 5 * 1024 * 1024));
  });

  it('says a size it was not given is unknown', async () => {
    storage = { ...storage, bytes: null };
    await open();
    expect(rows('store')[0]?.textContent).toContain('Size unknown');
  });

  it('says so when the sizes could not be read, and still shows the data folder', async () => {
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return Promise.resolve(channel === 'conversations:storage' ? { ok: false, error: 'internal' } : { ok: true, value: null });
    });
    await open();
    expect(section().textContent).toContain(STORAGE_UNREAD_TEXT);
    fireEvent.click(within(section()).getByRole('button', { name: 'Show data folder' }));
    await settle();
    expect(acted()).toEqual([['shell:showDataFolder', null]]);
    expect(section().textContent).toContain('The data folder was opened.');
  });

  it('asks again when the app state’s count of chats without a session changes', async () => {
    await open();
    storage = { ...storage, detached: { count: 2, textUnits: 40 } };
    act(() => { showState({ conversations: { status: { kind: 'ok' }, detached: 2 } }); });
    await settle();
    expect(asked('conversations:storage')).toHaveLength(2);
    expect(rows('detached')[0]?.textContent).toContain(detachedText(2));
  });

  it('formats sizes in steps of 1024', () => {
    expect([0, 512, 1024, 1536, 1024 * 1024, 5.25 * 1024 * 1024 * 1024].map(formatBytes)).toEqual(['0 B', '512 B', '1.0 KB', '1.5 KB', '1.0 MB', '5.3 GB']);
  });
});

describe('removing the chats without a session (V11; C23, C32)', () => {
  const WITH_CHATS: Partial<ShownState> = { conversations: { status: { kind: 'ok' }, detached: 3 } };
  beforeEach(() => {
    storage = { ...storage, detached: { count: 3, textUnits: 987 } };
  });

  it('asks first, saying how many go, then removes them and measures again', async () => {
    showDetached({ id: '0d0d0d0d-0000-4000-8000-000000000001', name: 'Plan the trip', createdAt: 1 });
    await open(WITH_CHATS);
    fireEvent.click(within(rows('detached')[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: `Remove ${detachedText(3)}?` });
    expect(dialog.textContent).toContain(removeDetachedText(3));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(acted()).toEqual([]);
    fireEvent.click(within(rows('detached')[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    storage = { ...storage, detached: { count: 0, textUnits: 0 } };
    await confirm(`Remove ${detachedText(3)}?`);
    expect(acted()).toEqual([['conversations:removeDetached', { all: true }]]);
    expect(asked('conversations:storage')).toHaveLength(2);
    expect(rows('detached')).toEqual([]);
    // One of them was shown in the chat region: it lets go of it.
    expect(useDetached.getState().shown).toBeNull();
  });

  it.each(['records-refused', 'conversations-refused', 'storage-failed'] as const)('says nothing went when main refuses as %s, and leaves the rest as it is', async (reason) => {
    answers['conversations:removeDetached'] = { status: 'refused', reason };
    storage = { ...storage, setAside: [{ name: FIRST, bytes: 2048 }], attachments: null };
    await open(WITH_CHATS);
    fireEvent.click(within(rows('detached')[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    await confirm(`Remove ${detachedText(3)}?`);
    expect(within(section()).getByRole('status').textContent).toBe(removeDetachedFailedText(3));
    expect(rows('detached')[0]?.textContent).toContain(detachedText(3));
    expect(rows('set-aside')).toHaveLength(1);
  });

  it('says so when the removal could not be asked for at all', async () => {
    await open(WITH_CHATS);
    bridge.setInvoke((channel) => Promise.resolve(channel === 'conversations:storage' ? { ok: true, value: storage } : channel === 'plans:storage' ? { ok: true, value: plans } : { ok: false, error: 'internal' }));
    fireEvent.click(within(rows('detached')[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    await confirm(`Remove ${detachedText(3)}?`);
    expect(within(section()).getByRole('status').textContent).toBe(removeDetachedFailedText(3));
  });

  it('is not offered while records are refused: the chats are still counted and measured', async () => {
    await open({ ...WITH_CHATS, recordsStatus: { kind: 'refused', cause: 'newer' } });
    expect(rows('detached')[0]?.textContent).toContain(detachedText(3));
    expect(rows('detached')[0]?.textContent).toContain('987 characters of text');
    expect(within(rows('detached')[0] as HTMLElement).queryByRole('button')).toBeNull();
  });
});

describe('the set-aside stores (V19; C41)', () => {
  beforeEach(() => {
    storage = { ...storage, setAside: [{ name: FIRST, bytes: 2048 }, { name: SECOND, bytes: 4096 }], attachments: { count: 0, bytes: 0 } };
  });

  it('removes one by name, after a confirmation naming the file that goes', async () => {
    await open();
    fireEvent.click(within(section()).getByRole('button', { name: `Remove ${SECOND}` }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this set-aside store?' });
    expect(dialog.textContent).toContain(SECOND);
    expect(dialog.textContent).not.toContain(FIRST);
    expect(dialog.textContent).toContain('with the -wal and -shm files SQLite kept beside it');
    expect(dialog.textContent).toContain('No other file is touched.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(acted()).toEqual([]);
    fireEvent.click(within(section()).getByRole('button', { name: `Remove ${SECOND}` }));
    answers['conversations:removeSetAside'] = { status: 'saved', removed: 1, failed: 0 };
    storage = { ...storage, setAside: [{ name: FIRST, bytes: 2048 }], attachments: null };
    await confirm('Remove this set-aside store?');
    expect(acted()).toEqual([['conversations:removeSetAside', { names: [SECOND] }]]);
    expect(asked('conversations:storage')).toHaveLength(2);
    expect(rows('set-aside').map((row) => row.textContent)).toEqual([`${FIRST}Size: 2.0 KBRemove`]);
    // One store left: nothing to remove "all" of.
    expect(rows('set-aside-all')).toEqual([]);
    expect(within(section()).queryByRole('status')).toBeNull();
  });

  it('removes all of them by the names its confirmation gave', async () => {
    await open();
    fireEvent.click(within(rows('set-aside-all')[0] as HTMLElement).getByRole('button', { name: 'Remove all' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove 2 set-aside stores?' });
    expect(dialog.textContent).toContain(FIRST);
    expect(dialog.textContent).toContain(SECOND);
    answers['conversations:removeSetAside'] = { status: 'saved', removed: 2, failed: 0 };
    storage = { ...storage, setAside: [] };
    await confirm('Remove 2 set-aside stores?');
    expect(acted()).toEqual([['conversations:removeSetAside', { names: [FIRST, SECOND] }]]);
    expect(rows('set-aside')).toEqual([]);
  });

  it('says how many could not be removed, and shows what is left', async () => {
    await open();
    fireEvent.click(within(rows('set-aside-all')[0] as HTMLElement).getByRole('button', { name: 'Remove all' }));
    answers['conversations:removeSetAside'] = { status: 'saved', removed: 1, failed: 1 };
    storage = { ...storage, setAside: [{ name: SECOND, bytes: 4096 }] };
    await confirm('Remove 2 set-aside stores?');
    expect(within(section()).getByRole('status').textContent).toBe(setAsideFailedText(1));
    expect(setAsideFailedText(2)).toContain('2 set-aside stores');
    expect(rows('set-aside').map((row) => row.textContent)).toEqual([`${SECOND}Size: 4.0 KBRemove`]);
    // The store in use is as it was.
    expect(rows('store')[0]?.textContent).toContain('3.0 MB');
  });

  it('says nothing went when main refuses, or cannot be asked', async () => {
    answers['conversations:removeSetAside'] = { status: 'refused', reason: 'storage-failed' };
    await open();
    fireEvent.click(within(section()).getByRole('button', { name: `Remove ${FIRST}` }));
    await confirm('Remove this set-aside store?');
    expect(within(section()).getByRole('status').textContent).toBe(SET_ASIDE_REFUSED_TEXT);
    expect(rows('set-aside')).toHaveLength(2);
    bridge.setInvoke((channel) => Promise.resolve(channel === 'conversations:storage' ? { ok: true, value: storage } : channel === 'plans:storage' ? { ok: true, value: plans } : { ok: false, error: 'internal' }));
    fireEvent.click(within(section()).getByRole('button', { name: `Remove ${FIRST}` }));
    await confirm('Remove this set-aside store?');
    expect(within(section()).getByRole('status').textContent).toBe(SET_ASIDE_REFUSED_TEXT);
  });
});

describe('while the conversation store is refused (V19; C33, C42)', () => {
  const REFUSED: ConversationsState = { status: { kind: 'refused', cause: 'damaged' }, detached: 0 };
  beforeEach(() => {
    storage = { status: REFUSED.status, bytes: 4096, detached: { count: 0, textUnits: 0 }, setAside: [{ name: FIRST, bytes: 2048 }], attachments: null };
  });

  it('says why, with the file unchanged, and offers no removal of chats', async () => {
    await open({ conversations: REFUSED });
    const { cause, remedy } = explain('conversations', 'damaged');
    expect(section().textContent).toContain(unchangedText('conversations'));
    expect(section().textContent).toContain(`${cause} ${remedy}`);
    // A database, not a file to edit by hand.
    expect(remedy).not.toMatch(/by hand/);
    expect(rows('detached')).toEqual([]);
    // What was set aside before is still counted, and can still go: no chat of the refused store is in it.
    expect(rows('set-aside')).toHaveLength(1);
    expect(rows('store')[0]?.textContent).toContain('4.0 KB');
  });

  it('offers no removal of chats even if main counts some', async () => {
    storage = { ...storage, detached: { count: 2, textUnits: 10 } };
    await open({ conversations: REFUSED });
    expect(within(rows('detached')[0] as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('starts fresh only after a confirmation that says where the files go, then shows where they went and measures again', async () => {
    const kept = `D:\\data\\${SECOND}`;
    answers['conversations:startFresh'] = { status: 'done', keptAs: kept };
    await open({ conversations: REFUSED });
    fireEvent.click(within(section()).getByRole('button', { name: 'Start fresh…' }));
    const dialog = screen.getByRole('dialog', { name: 'Start fresh?' });
    expect(dialog.textContent).toContain(startFreshText('conversations'));
    expect(startFreshText('conversations')).toContain('conversations.sqlite-wal');
    expect(startFreshText('conversations')).toContain('conversations.set-aside.<date and time>.sqlite');
    expect(startFreshText('conversations')).toContain('Your sessions stay listed.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(acted()).toEqual([]);
    fireEvent.click(within(section()).getByRole('button', { name: 'Start fresh…' }));
    storage = { status: { kind: 'ok' }, bytes: 8192, detached: { count: 0, textUnits: 0 }, setAside: [{ name: FIRST, bytes: 2048 }, { name: SECOND, bytes: 4096 }], attachments: { count: 0, bytes: 0 } };
    await confirm('Start fresh?', 'Start fresh');
    expect(acted()).toEqual([['conversations:startFresh', null]]);
    expect(asked('conversations:storage')).toHaveLength(2);
    expect(section().textContent).toContain(kept);
    expect(section().textContent).not.toContain(unchangedText('conversations'));
    expect(rows('set-aside')).toHaveLength(2);
  });

  it('says so when the files could not be moved, and keeps the note', async () => {
    await open({ conversations: REFUSED });
    bridge.setInvoke((channel) => Promise.resolve(channel === 'conversations:storage' ? { ok: true, value: storage } : channel === 'plans:storage' ? { ok: true, value: plans } : { ok: false, error: 'internal' }));
    fireEvent.click(within(section()).getByRole('button', { name: 'Start fresh…' }));
    await confirm('Start fresh?', 'Start fresh');
    expect(section().textContent).toContain('fat-g could not move the files. Nothing was changed.');
    expect(section().textContent).toContain(unchangedText('conversations'));
  });
});

// M22b (V8's automated part; C21, C73, C75): the plans' row — their count and size, Show plans
// folder, which main names, and Remove all behind a confirmation that says decisions are cancelled first.
describe('the plans (M22b; C21, C75)', () => {
  it('says how many there are and their size, and opens the plans folder main names', async () => {
    plans = { count: 3, bytes: 2048, orphans: 0 };
    await open();
    expect(asked('plans:storage')).toEqual([null]);
    expect(rows('plans')[0]?.textContent).toContain('3 plans');
    expect(rows('plans')[0]?.textContent).toContain(formatBytes(2048));
    fireEvent.click(within(section()).getByRole('button', { name: 'Show plans folder' }));
    await settle();
    expect(acted()).toEqual([['shell:showDataFolder', { folder: 'plans' }]]);
  });

  it('removes every plan after a confirmation, then measures again', async () => {
    plans = { count: 2, bytes: 10, orphans: 0 };
    answers['plans:remove'] = { status: 'removed', removed: 2, settled: 1 };
    await open();
    fireEvent.click(within(rows('plans')[0] as HTMLElement).getByRole('button', { name: 'Remove all' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove all 2 plans?' });
    expect(dialog.textContent).toContain('cancelled first');
    await confirm('Remove all 2 plans?');
    expect(acted()).toEqual([['plans:remove', { all: true }]]);
    expect(asked('plans:storage')).toHaveLength(2);
  });

  it('offers no Remove all with no plan, and says so when a plan is being written', async () => {
    await open();
    expect(within(rows('plans')[0] as HTMLElement).queryByRole('button', { name: 'Remove all' })).toBeNull();
    cleanup();
    plans = { count: 1, bytes: 10, orphans: 0 };
    answers['plans:remove'] = { status: 'refused', reason: 'writing' };
    await open();
    fireEvent.click(within(rows('plans')[0] as HTMLElement).getByRole('button', { name: 'Remove all' }));
    await confirm('Remove the plan?');
    expect(section().textContent).toContain('still being written');
  });
});
