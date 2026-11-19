// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReadRequest, ChatSendResult } from '@shared/contracts/chat';
import type { ModelPreset } from '@shared/contracts/presets';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { openTab, resetTabs } from '../artifacts/tabs-store';
import { useChatDrafts } from '../chat/chat-store';
import { showDetached } from '../chat/detached-store';
import { selectSession } from '../sessions/select';
import { closeSettings, openSettings, useSettings } from '../settings/settings-store';
import { Shell } from '../shell/Shell';
import { usePrefs } from '../state/prefs-store';
import { fakeChat } from '../test/chat';
import { installDialogStandIn } from '../test/dialog';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { closeNewSession, openNewSession, useNewSession } from './new-session-store';

const A = project('fat-g', { providers: ['codex'] });
const B = project('website', { providers: ['codex'] });
const OLD = sessionEntry('Previous conversation', SUMMARIES.idle, { projectId: A.id, providerId: 'codex' });
const providers = [sampleProvider({ id: 'codex', displayName: 'Codex' })];
let entries: SessionEntry[];
let selected: string | null;
let requests: [InvokeChannel, unknown][];
let sendAnswer: ChatSendResult;
let catalog = sampleCatalog(['codex']);
const publish = () => showState({ projects: [A, B], sessions: entries, selectedId: selected, providers, catalog });
const input = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Codex' });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const calls = (channel: InvokeChannel) => requests.filter(([kind]) => kind === channel).map(([, request]) => request);

beforeEach(() => {
  installDialogStandIn();
  const bridge = installFakeBridge();
  closeNewSession();
  useNewSession.setState({ sent: new Set() });
  closeSettings();
  resetTabs();
  showDetached(null);
  useChatDrafts.setState({ drafts: {} });
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  entries = [OLD]; selected = OLD.record.id; requests = [];
  sendAnswer = { status: 'accepted' }; catalog = sampleCatalog(['codex']);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    if (channel === 'sessions:create') {
      const { projectId, preset } = request as { projectId: string; preset: ModelPreset };
      const entry = sessionEntry(`Draft ${entries.length}`, SUMMARIES.notStarted, { projectId, ...preset });
      entries = [...entries, entry]; selected = entry.record.id; publish();
      return Promise.resolve({ ok: true, value: { status: 'saved', id: entry.record.id } });
    }
    if (channel === 'sessions:select') { selected = (request as { id: string }).id; publish(); }
    if (channel === 'sessions:remove') {
      const { id } = request as { id: string };
      entries = entries.filter((entry) => entry.record.id !== id);
      if (selected === id) selected = OLD.record.id;
      publish();
    }
    if (channel === 'sessions:setDraftPreset') {
      const { id, preset } = request as { id: string; preset: ModelPreset };
      entries = entries.map((entry) => entry.record.id === id ? { ...entry, record: { ...entry.record, ...preset } } : entry);
      publish();
    }
    const value = channel === 'chat:read' ? fakeChat((request as ChatReadRequest).sessionId).read(request as ChatReadRequest)
      : channel === 'chat:send' ? sendAnswer : channel === 'plans:list' ? { status: 'listed', plans: [] } : { status: 'saved' };
    return Promise.resolve({ ok: true, value });
  });
  publish();
});
afterEach(() => { cleanup(); closeNewSession(); });

async function open() {
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'New session in fat-g' }));
  await waitFor(() => expect(input()).toBeTruthy());
}

describe('the initial new-chat visit', () => {
  it('shows a matching preset above the prompt and removes it when the selection changes', async () => {
    await open();
    const record = entries.find((entry) => entry.record.id === useNewSession.getState().sessionId)!.record;
    const saved = { providerId: record.providerId, instanceId: record.instanceId, model: record.model, effort: record.effort, speed: record.speed, name: 'Careful' };
    const other = { ...saved, effort: saved.effort === 'high' ? 'low' : 'high' };
    act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ presets: { '11111111-2222-4333-8444-555555555555': saved }, recentModels: [other] }) }); });
    expect(screen.getByText('Preset: Careful').parentElement).toBe(input().parentElement);
    expect(screen.getByText('Preset: Careful').compareDocumentPosition(input()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'Recent' })).getByRole('button'));
    await waitFor(() => expect(screen.queryByText('Preset: Careful')).toBeNull());
    await act(async () => { await selectSession(OLD.record.id); });
    expect(screen.queryByText('Preset: Careful')).toBeNull();
  });

  it.each(['recent', 'preset'] as const)('applies a %s to the same draft and focuses the end of its preserved input', async (kind) => {
    const preset: ModelPreset = { providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null };
    const saved = { ...preset, effort: 'low', name: 'Careful' };
    usePrefs.setState({ snapshot: prefsSnapshot({ recentModels: [saved, preset], presets: { '11111111-2222-4333-8444-555555555555': saved } }) });
    await open();
    const id = useNewSession.getState().sessionId;
    fireEvent.change(input(), { target: { value: 'Keep this draft' } });
    input().setSelectionRange(2, 4);
    Object.defineProperty(input(), 'scrollHeight', { configurable: true, value: 600 });
    input().scrollTop = 0;
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Presets' }).compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const capsule = kind === 'recent' ? within(recent).getByRole('button')
      : within(screen.getByRole('region', { name: 'Presets' })).getByRole('button', { name: /^Careful:/ });
    capsule.focus();
    fireEvent.click(capsule);
    await settle();
    expect(calls('sessions:setDraftPreset')).toEqual([{ id, preset: kind === 'recent' ? preset : { ...preset, effort: 'low' } }]);
    expect(calls('sessions:create')).toHaveLength(1);
    expect(calls('prefs:patch')).toHaveLength(kind === 'recent' ? 0 : 1);
    expect(input().value).toBe('Keep this draft');
    expect(document.activeElement).toBe(input());
    expect([input().selectionStart, input().selectionEnd]).toEqual([input().value.length, input().value.length]);
    expect(input().scrollTop).toBe(600);
    expect(within(recent).getByRole('button').getAttribute('aria-pressed')).toBe(String(kind === 'recent'));
    expect(within(screen.getByRole('region', { name: 'Presets' })).getByRole('button', { name: /^Careful:/ }).getAttribute('aria-pressed')).toBe(String(kind === 'preset'));
  });
  it('replaces the previous panes/title, creates once, and refocuses on repeated +', async () => {
    await open();
    expect(screen.getByRole('main', { name: 'New chat in fat-g' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'fat-g // new chat' }).textContent).toBe('fat-g // new chat');
    expect(screen.getByRole('region', { name: 'Session' }).textContent).toBe('');
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    const id = useNewSession.getState().sessionId;
    fireEvent.click(screen.getByRole('button', { name: 'New session in fat-g' }));
    await settle();
    expect(useNewSession.getState().sessionId).toBe(id);
    expect(calls('sessions:create')).toHaveLength(1);
    expect(calls('chat:send')).toHaveLength(0);
    expect(document.activeElement).toBe(input());
  });

  it('retains the draft after refusal and leaves the screen only after an accepted Send', async () => {
    await open();
    fireEvent.change(input(), { target: { value: 'Please keep my prompt' } });
    sendAnswer = { status: 'refused', reason: 'storage-failed' };
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    expect(input().value).toBe('Please keep my prompt');
    expect(useNewSession.getState().sessionId).not.toBeNull();
    expect(document.querySelector('[data-chat-window]')).toBeNull();
    sendAnswer = { status: 'accepted' };
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(useNewSession.getState().projectId).toBeNull());
    expect(screen.getByRole('group', { name: 'Messages' })).toBeTruthy();
    expect(document.querySelector('[data-chat-window]')?.hasAttribute('data-reveal')).toBe(true);
  });

  it('shows the chat without a wipe when Creation animation is None', async () => {
    const appearance = prefsSnapshot().values.appearance;
    usePrefs.setState({ snapshot: prefsSnapshot({ appearance: { ...appearance, creationAnimation: 'none' } }) });
    await open();
    fireEvent.change(input(), { target: { value: 'Show this at once' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('main', { name: 'New chat in fat-g' })).toBeNull());
    expect(screen.getByRole('group', { name: 'Messages' })).toBeTruthy();
    expect(document.querySelector('[data-chat-window]')?.hasAttribute('data-reveal')).toBe(false);
  });

  it('flushes on leaving for another project and reopens the saved draft on the same screen', async () => {
    await open();
    const id = useNewSession.getState().sessionId!;
    fireEvent.change(input(), { target: { value: 'Continue me later' } });
    fireEvent.click(screen.getByRole('button', { name: 'New session in website' }));
    await waitFor(() => expect(screen.getByRole('main', { name: 'New chat in website' })).toBeTruthy());
    await settle();
    expect(calls('sessions:create')).toHaveLength(2);
    expect(calls('chat:draft')).toContainEqual(expect.objectContaining({ sessionId: id, prompt: 'Continue me later' }));
    await act(async () => { await selectSession(id); });
    expect(screen.getByRole('main', { name: 'New chat in fat-g' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Messages' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Session' }).textContent).toBe('');
    expect(input().value).toBe('Continue me later');
    expect(calls('sessions:create')).toHaveLength(2);
    await act(async () => { await selectSession(OLD.record.id); });
    expect(screen.queryByRole('main', { name: 'New chat in fat-g' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Messages' })).toBeTruthy();
  });

  it.each(['same project', 'other project', 'existing session'])('keeps the typed draft when leaving for %s', async (destination) => {
    await open();
    const id = useNewSession.getState().sessionId!;
    // A real provisional record has no name until the secretary answers.
    act(() => { entries = entries.map((entry) => entry.record.id === id ? { ...entry, record: { ...entry.record, name: null, nameSource: null } } : entry); publish(); });
    fireEvent.change(input(), { target: { value: 'Continue this later' } });
    expect(document.querySelector(`[data-select-session="${id}"]`)?.textContent).toBe('New session: Continue this later');
    if (destination === 'existing session') await act(async () => { await selectSession(OLD.record.id); });
    else fireEvent.click(screen.getByRole('button', { name: `New session in ${destination === 'same project' ? 'fat-g' : 'website'}` }));
    await settle();
    if (destination !== 'existing session') await waitFor(() => expect(calls('sessions:create')).toHaveLength(2));
    expect(calls('sessions:describeDraft')).toContainEqual({ id, text: 'Continue this later' });
    expect(calls('chat:draft')).toContainEqual(expect.objectContaining({ sessionId: id, prompt: 'Continue this later' }));
    expect(calls('sessions:remove')).not.toContainEqual({ id });
    expect(calls('chat:send')).toHaveLength(0);
    await act(async () => { await selectSession(id); });
    expect(input().value).toBe('Continue this later');
  });

  it('cancels an unsent session beside Send and offers no cancellation after first Send', async () => {
    await open();
    const id = useNewSession.getState().sessionId!;
    fireEvent.change(input(), { target: { value: 'Discard this' } });
    expect(screen.getByRole('button', { name: 'Cancel new session' }).textContent).toBe('Cancel');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel new session' }));
    await waitFor(() => expect(calls('sessions:remove')).toContainEqual({ id, draftOnly: true }));
    expect(screen.queryByRole('main', { name: 'New chat in fat-g' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New session in fat-g' }));
    await waitFor(() => expect(input()).toBeTruthy());
    await settle();
    fireEvent.change(input(), { target: { value: 'Send this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel new session' })).toBeNull());
  });

  it('shows a revisited draft as a chat once its Send is accepted, or while an image of it is open', async () => {
    await open();
    const id = useNewSession.getState().sessionId!;
    fireEvent.change(input(), { target: { value: 'Back again' } });
    await act(async () => { await selectSession(OLD.record.id); });
    await act(async () => { await selectSession(id); });
    expect(screen.getByRole('main', { name: 'New chat in fat-g' })).toBeTruthy();
    act(() => { openTab(id, 'image', 'test-reference'); });
    expect(screen.queryByRole('main', { name: 'New chat in fat-g' })).toBeNull();
    expect(document.querySelector('[data-chat-window]')?.hasAttribute('data-reveal')).toBe(false);
    act(() => { resetTabs(); });
    expect(screen.getByRole('main', { name: 'New chat in fat-g' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('main', { name: 'New chat in fat-g' })).toBeNull());
    expect(screen.getByRole('group', { name: 'Messages' })).toBeTruthy();
    expect(document.querySelector('[data-chat-window]')?.hasAttribute('data-reveal')).toBe(true);
  });

  it('applies picker changes to the same id, keeps text, and cancels pending choices', async () => {
    await open();
    const id = useNewSession.getState().sessionId;
    fireEvent.change(input(), { target: { value: 'Keep this text' } });
    fireEvent.click(screen.getByRole('button', { name: /Choose model:/ }));
    let picker = screen.getByRole('dialog', { name: 'Choose model' });
    fireEvent.click(within(picker).getByRole('radio', { name: 'High' }));
    fireEvent.keyDown(picker, { key: 'Escape' });
    expect(calls('sessions:setDraftPreset')).toHaveLength(0);
    expect(useNewSession.getState().sessionId).toBe(id);
    fireEvent.click(screen.getByRole('button', { name: /Choose model:/ }));
    picker = screen.getByRole('dialog', { name: 'Choose model' });
    fireEvent.click(within(picker).getByRole('radio', { name: 'High' }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls('sessions:setDraftPreset')).toEqual([{ id, preset: { providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null } }]);
    expect(calls('sessions:create')).toHaveLength(1);
    expect(calls('prefs:patch')).toHaveLength(0);
    expect(input().value).toBe('Keep this text');
    expect(document.activeElement).toBe(input());
    fireEvent.click(screen.getByRole('button', { name: /Choose model:/ }));
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'fat-g // new chat' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls('sessions:setDraftPreset')).toHaveLength(1);
  });

  it('offers account preferences without a selector when no models exist, retaining the draft through refresh', async () => {
    catalog = sampleCatalog([]); publish();
    render(<Shell />);
    act(() => openNewSession(A.id));
    await settle();
    expect(screen.getByRole('status').textContent).toContain('No models detected.');
    expect(screen.queryByRole('button', { name: /Choose model/ })).toBeNull();
    expect(calls('sessions:create')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(useSettings.getState()).toMatchObject({ open: true, tab: 'accounts', target: { section: 'accounts' } });
    act(() => { closeSettings(); catalog = sampleCatalog(['codex']); publish(); });
    await waitFor(() => expect(input()).toBeTruthy());
    fireEvent.change(input(), { target: { value: 'Keep this while refreshing' } });
    act(() => { catalog = sampleCatalog([]); publish(); });
    expect(screen.queryByRole('button', { name: /Choose model/ })).toBeNull();
    expect(input().value).toBe('Keep this while refreshing');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    act(() => { catalog = sampleCatalog(['codex']); publish(); });
    expect(screen.getByRole('button', { name: /Choose model:/ })).toBeTruthy();
    expect(input().value).toBe('Keep this while refreshing');
    expect(calls('sessions:create')).toHaveLength(1);
  });

  it('keeps the initial visit through Settings', async () => {
    await open();
    const id = useNewSession.getState().sessionId;
    act(() => openSettings());
    expect(useNewSession.getState().sessionId).toBe(id);
    act(() => closeSettings());
    expect(screen.getByRole('main', { name: 'New chat in fat-g' })).toBeTruthy();
  });

  it.each(['image', 'plan'])('opens the normal session/artifact view for a %s', async (kind) => {
    await open();
    act(() => { openTab(useNewSession.getState().sessionId!, kind, 'test-reference'); });
    await settle();
    expect(useNewSession.getState().projectId).toBeNull();
    expect(screen.getByRole('region', { name: 'Artifacts' })).toBeTruthy();
    expect(document.querySelector('[data-chat-window]')).not.toBeNull();
  });
});
