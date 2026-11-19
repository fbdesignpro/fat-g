// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '@shared/contracts/conversation';
import { DELIVERY_STATES } from '@shared/contracts/composer';
import { raisedPlan } from '@shared/contracts/interaction';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { sampleCatalog } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { sessionClockState } from '../sessions/session-clock';
import { chatActivity, chatApproval, chatCard, chatItem, chatTurn } from '../test/chat';
import { prefsSnapshot } from '../test/prefs';
import { MessageList } from './MessageList';
import { SpeakerBar, type SpeakerBarProps } from './SpeakerBar';
import { takePresentation, useChatPresentation } from './presentation-store';
import { speakerRuns } from './speakers';
import type { ChatView } from './window';

const ID = 'session';
const bar: SpeakerBarProps = { speaker: { role: 'assistant', model: 'unlisted' }, modelName: 'A model', defaultModel: 'unlisted', sessionId: ID, providerId: 'claude', timer: { running: true, since: 10_000, elapsedMs: null } };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(12_000);
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  useAppState.setState({ snapshot: { ...sampleSnapshot(1), catalog: sampleCatalog(['claude']) } });
  useChatPresentation.setState({ sessionId: null, value: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const view = (items: ChatView['items'], turns: readonly ConversationTurn[], latest = true): ChatView => ({ items, turns: new Map(turns.map((turn) => [turn.id, turn])), latest, older: null, history: { state: 'unsupported', olderUnread: false, earlierMissing: false }, storage: 'ok', change: { serial: 1, kind: 'latest' }, loaded: null, arrivals: 0, newer: false, ended: null, asked: null });

describe('speaker identity and timing', () => {
  it('shows only adjoining bolts for the recorded tier and updates memoized bars', () => {
    const { container, rerender } = render(<SpeakerBar {...bar} speed={{ id: 'priority', name: 'Fast' }} />);
    const mark = () => container.querySelector('[data-speaker-speed]');
    expect(mark()?.textContent).toBe('\u26a1');
    expect(mark()?.getAttribute('title')).toContain('requested');
    expect(container.querySelector('[data-speaker-name]')?.textContent).toBe('A model');
    rerender(<SpeakerBar {...bar} speed={{ id: 'express', name: 'Ultra fast' }} />);
    expect(mark()?.textContent).toBe('\u26a1\u26a1\u26a1');
    expect(mark()?.getAttribute('aria-label')).toBe('Ultra fast requested');
    rerender(<SpeakerBar {...bar} speed={null} />);
    expect(mark()).toBeNull();
    rerender(<SpeakerBar {...bar} speaker={{ role: 'user', model: null }} speed={{ id: 'fast', name: 'Fast' }} />);
    expect(mark()).toBeNull();
  });

  it('uses each saved turn for historical, partial and pending replies without inheriting the current selection', () => {
    const turns = [chatTurn('fast', { speed: { id: 'priority', name: 'Fast' } }), chatTurn('ultra', { speed: { id: 'express', name: 'Ultra fast' } }), chatTurn('unknown')];
    const items = turns.map((turn) => chatItem(ID, 'assistant', `Reply ${turn.id}`, { turnId: turn.id, state: 'partial' }));
    const props = { busy: false, modelName: 'A model', providerName: 'Claude', sessionId: ID, providerId: 'claude', modelKey: 'unlisted', onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const { container, rerender } = render(<MessageList {...props} view={view(items, turns)} />);
    expect([...container.querySelectorAll('[data-speaker-speed]')].map((el) => el.textContent)).toEqual(['\u26a1', '\u26a1\u26a1\u26a1']);
    rerender(<MessageList {...props} workerId="child" view={view(items, turns)} />);
    expect(container.querySelector('[data-speaker-speed]')).toBeNull();
    rerender(<MessageList {...props} busy view={view([chatItem(ID, 'user', 'Question', { turnId: 'ultra' })], [chatTurn('ultra', { state: 'running', speed: turns[1]!.speed })])} />);
    expect(container.querySelector('[data-speaker-speed]')?.textContent).toBe('\u26a1\u26a1\u26a1');
  });

  it('puts queue attribution on the user bar and updates it when the source changes', () => {
    const direct = chatItem(ID, 'user', 'Direct', { id: 'direct' });
    const queued = chatItem(ID, 'user', 'Queued', { id: 'queued', fromQueue: true });
    const runs = speakerRuns([[direct], [queued]], 'unlisted');
    const speaker = runs.get(queued.id);
    expect(speaker?.fromQueue).toBe(true);
    const { container, rerender } = render(<SpeakerBar {...bar} speaker={speaker!} />);
    expect(container.querySelector('[data-speaker-name]')?.textContent).toBe('You (from queue)');
    rerender(<SpeakerBar {...bar} speaker={{ role: 'user', model: null }} />);
    expect(container.querySelector('[data-speaker-name]')?.textContent).toBe('You');
  });

  it('labels system notices with a decorative information icon and no turn counter or clock subscription', () => {
    const { container } = render(<SpeakerBar {...bar} speaker={{ role: 'notice', model: null }} />);
    expect(screen.getByText('fat-g')).toBeTruthy();
    expect(screen.getByText('i').getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-turn-counter], [data-avatar]')).toBeNull();
    expect(sessionClockState().subscribers).toBe(0);
  });
  it('starts a bar per identity and turn, with tools sharing the preceding model’s run', () => {
    const user = chatItem(ID, 'user', 'q', { turnId: 't1' });
    const answer = chatItem(ID, 'assistant', 'a', { turnId: 't1', model: 'other' });
    const tool = chatActivity(ID, 't1', { type: 'read' });
    const next = chatItem(ID, 'assistant', 'b', { turnId: 't2', model: 'other' });
    expect([...speakerRuns([[user], [answer], [tool], [next]], 'default').keys()]).toEqual([user.id, answer.id, next.id]);
  });

  it('marks the message that answers an async card as an answer, in a bar of its own', () => {
    const user = chatItem(ID, 'user', 'q', { turnId: 't1', time: { receivedAt: 1000, providerAt: null } });
    const card = chatCard(ID, 't1', { mode: 'async', outcome: 'answered', settledAt: 5000, answeredBy: 't1' });
    const passed = chatCard(ID, 't1', { mode: 'async', outcome: 'passed', settledAt: 6000 });
    const reply = chatItem(ID, 'user', 'Which?\nThis one', { turnId: 't1', time: { receivedAt: 5000, providerAt: null } });
    const later = chatItem(ID, 'user', 'more', { turnId: 't1', time: { receivedAt: 6000, providerAt: null } });
    const runs = speakerRuns([[user], [card], [passed], [reply], [later]], 'default');
    expect(runs.get(user.id)).toEqual({ role: 'user', model: null });
    expect(runs.get(reply.id)).toEqual({ role: 'user', model: null, answer: true });
    expect(runs.get(later.id)).toEqual({ role: 'user', model: null });
    render(<SpeakerBar {...bar} speaker={{ role: 'user', model: null, answer: true }} />);
    expect(screen.getByText('You (answer to question)')).toBeTruthy();
  });

  it.each(DELIVERY_STATES)('derives the interactive header from persisted delivery %s', (state) => {
    const prompt = chatItem(ID, 'user', 'Start', { turnId: 't1' });
    const message = chatItem(ID, 'user', 'Also this', { turnId: 't1', delivery: { state, detail: null } });
    const runs = speakerRuns([[prompt], [message]], 'default');
    const interactive = state !== 'next-prompt' && state !== 'not-sent';
    expect(runs.get(prompt.id)).toEqual({ role: 'user', model: null });
    // Consecutive ordinary messages share their bar; an interactive message gets its own label.
    expect(runs.get(message.id)).toEqual(interactive ? { role: 'user', model: null, interactive: true, ...(state === 'sent' ? { pendingReceipt: true } : {}), ...(state === 'taken' ? { received: true } : {}) } : undefined);
    render(<SpeakerBar {...bar} speaker={runs.get(message.id) ?? runs.get(prompt.id)!} />);
    const label = state === 'sent' ? 'You (sent, not read yet)' : state === 'taken' ? 'You (received by model)' : 'You';
    expect(screen.getByText(label).getAttribute('title')).toBe(label);
  });

  it('updates the player header when an interactive delivery is settled or falls back to a later turn', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: 'Player' } }) });
    const message = chatItem(ID, 'user', 'Also the tests', { turnId: 't1', delivery: { state: 'sent', detail: null } });
    const props = { busy: false, modelName: 'A model', providerName: 'Claude', sessionId: ID, providerId: 'claude', modelKey: 'unlisted', onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const { container, rerender } = render(<MessageList {...props} view={view([message], [chatTurn('t1')])} />);
    const label = () => container.querySelector('[data-speaker-role="user"] [data-speaker-name]');
    expect(label()?.textContent).toBe('Player (sent, not read yet)');
    expect(label()?.getAttribute('title')).toBe('Player (sent, not read yet)');
    rerender(<MessageList {...props} view={view([{ ...message, delivery: { state: 'taken', detail: null } }], [chatTurn('t1')])} />);
    expect(label()?.textContent).toBe('Player (received by model)');
    expect(label()?.getAttribute('title')).toBe('Player (received by model)');
    rerender(<MessageList {...props} view={view([{ ...message, turnId: 't2', delivery: { state: 'next-prompt', detail: null } }], [chatTurn('t2')])} />);
    expect(label()?.textContent).toBe('Player');
  });

  it('appends the receipt marker after the answer-to-question label', () => {
    render(<SpeakerBar {...bar} speaker={{ role: 'user', model: null, answer: true, interactive: true, received: true }} />);
    expect(screen.getByText('You (answer to question) (received by model)')).toBeTruthy();
  });

  it('counts through waits, freezes at the recorded total and unsubscribes when finished', () => {
    const { container, rerender } = render(<SpeakerBar {...bar} />);
    expect(container.querySelector('[data-turn-counter]')?.textContent).toBe('2s');
    act(() => { vi.advanceTimersByTime(200_000); });
    expect(container.querySelector('[data-turn-counter]')?.textContent).toBe('3m22s');
    rerender(<SpeakerBar {...bar} timer={{ running: false, since: 10_000, elapsedMs: 202_500 }} />);
    expect(sessionClockState().subscribers).toBe(0);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(container.querySelector('[data-turn-counter]')?.textContent).toBe('3m22s');
  });

  it('uses the username for user bars, with no user avatar or counter, even when it matches the model', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: 'A model' } }) });
    const { container, rerender } = render(<SpeakerBar {...bar} speaker={{ role: 'user', model: null }} />);
    expect(screen.getByText('A model')).toBeTruthy();
    expect(container.querySelector('[data-speaker-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-avatar], [data-turn-counter]')).toBeNull();
    act(() => { usePrefs.setState({ snapshot: prefsSnapshot() }); });
    expect(screen.getByText('You')).toBeTruthy();
    rerender(<SpeakerBar {...bar} timer={{ running: false, since: null, elapsedMs: null }} />);
    expect(screen.getByLabelText('Elapsed time unavailable')).toBeTruthy();
  });

  it('uses main’s unlisted-model avatar and rejects stale refreshes without replacing message elements', () => {
    const avatar = { ref: { origin: 'user' as const, family: 'Faces', avatar: 'Other' }, portrait: 'portrait-first', small: null };
    takePresentation(ID, { revision: 1, models: { unlisted: avatar }, workers: {} });
    const { container } = render(<SpeakerBar {...bar} />);
    const image = () => container.querySelector('img')?.getAttribute('src');
    expect(image()).toContain('portrait-first');
    act(() => { takePresentation(ID, { revision: 2, models: { unlisted: { ...avatar, portrait: 'portrait-rescan' } }, workers: {} }); });
    act(() => { takePresentation(ID, { revision: 1, models: { unlisted: avatar }, workers: {} }); });
    expect(image()).toContain('portrait-rescan');
  });

  it('shows a pending model bar before text, then one progress indicator through tools, until the turn ends', () => {
    const prompt = chatItem(ID, 'user', 'q', { turnId: 't' });
    const turn = chatTurn('t', { state: 'running', outcome: null });
    const props = { busy: false, modelName: 'A model', providerName: 'Claude', sessionId: ID, providerId: 'claude', modelKey: 'unlisted', onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const { container, rerender } = render(<MessageList {...props} view={view([prompt], [turn])} />);
    expect(container.querySelectorAll('[data-speaker]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-turn-progress] span')).toHaveLength(3);
    const tool = chatActivity(ID, 't', { type: 'read', status: 'running' });
    rerender(<MessageList {...props} view={view([prompt, tool], [turn])} />);
    expect(container.querySelectorAll('[data-turn-progress]')).toHaveLength(1);
    rerender(<MessageList {...props} view={view([prompt, tool], [turn], false)} />);
    expect(container.querySelector('[data-turn-progress]')).toBeNull();
    rerender(<MessageList {...props} view={view([prompt, tool], [chatTurn('t')])} />);
    expect(container.querySelector('[data-turn-progress]')).toBeNull();
  });

  it.each([
    ['question', () => chatCard(ID, 't')],
    ['approval', () => chatApproval(ID, 't')],
    ['plan', () => chatItem(ID, 'assistant', '', { turnId: 't', kind: 'interaction', interaction: raisedPlan({ planId: 'plan', version: 1, came: 'made', request: true }) })],
  ] as const)('hides progress while a %s waits for the user, then resumes when it settles', (_kind, makeRequest) => {
    const prompt = chatItem(ID, 'user', 'q', { turnId: 't' });
    const request = makeRequest();
    const turn = chatTurn('t', { state: 'running', outcome: null, time: { ...chatTurn('t').time, acceptedAt: 10_000 } });
    const props = { busy: false, modelName: 'A model', providerName: 'Claude', onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const { container, rerender } = render(<MessageList {...props} view={view([prompt, request], [turn])} />);
    expect(container.querySelector('[data-turn-progress]')).toBeNull();
    expect(container.querySelector('[data-turn-counter]')?.textContent).toBe('2s');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelector('[data-turn-counter]')?.textContent).toBe('3s');
    const settled = { ...request, interaction: request.interaction === null ? null : { ...request.interaction, outcome: 'withdrawn' as const } };
    rerender(<MessageList {...props} view={view([prompt, settled], [turn])} />);
    expect(container.querySelector('[data-turn-progress]')).not.toBeNull();
  });

  it('keeps progress for an async question only while its model is still working', () => {
    const question = chatCard(ID, 't', { mode: 'async' });
    const props = { busy: false, modelName: 'A model', providerName: 'Codex', onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const { container, rerender } = render(<MessageList {...props} view={view([question], [chatTurn('t', { state: 'running', outcome: null })])} />);
    expect(container.querySelector('[data-turn-progress]')).not.toBeNull();
    rerender(<MessageList {...props} view={view([question], [chatTurn('t')])} />);
    expect(container.querySelector('[data-turn-progress]')).toBeNull();
  });

  it('keeps progress while a plan is being written or completed without holding its turn', () => {
    const plan = chatItem(ID, 'assistant', '', { turnId: 't', kind: 'interaction', interaction: raisedPlan({ planId: 'plan', version: 1, came: 'made', request: false, writing: true }) });
    const props = { busy: false, modelName: 'A model', providerName: 'Codex', onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const turn = chatTurn('t', { state: 'running', outcome: null });
    const { container, rerender } = render(<MessageList {...props} view={view([plan], [turn])} />);
    expect(container.querySelector('[data-turn-progress]')).not.toBeNull();
    const ready = { ...plan, interaction: raisedPlan({ planId: 'plan', version: 1, came: 'made', request: false }) };
    rerender(<MessageList {...props} view={view([ready], [turn])} />);
    expect(container.querySelector('[data-turn-progress]')).not.toBeNull();
    rerender(<MessageList {...props} view={view([ready], [chatTurn('t')])} />);
    expect(container.querySelector('[data-turn-progress]')).toBeNull();
  });

  it('keeps a worker’s timer and indicator running after the parent turn ends, except during its own requests', () => {
    const answer = chatItem(ID, 'assistant', 'work', { turnId: 'parent', workerId: 'w' });
    const worker = chatActivity(ID, 'parent', { type: 'worker', status: 'running', workerId: 'w' }, { time: { receivedAt: 10_000, providerAt: null } });
    const props = { busy: false, modelName: 'A model', providerName: 'Claude', workerId: 'w', worker, onShowEarlier: vi.fn(), onShowLatest: vi.fn() };
    const others = [chatCard(ID, 'parent'), chatCard(ID, 'parent', {}, { workerId: 'other' })];
    const { container, rerender } = render(<MessageList {...props} view={view([answer, ...others], [chatTurn('parent')])} />);
    expect(container.querySelector('[data-turn-counter]')?.textContent).toBe('2s');
    expect(container.querySelector('[data-turn-progress]')).not.toBeNull();
    const question = chatCard(ID, 'parent', {}, { workerId: 'w' });
    rerender(<MessageList {...props} view={view([answer, ...others, question], [chatTurn('parent')])} />);
    expect(container.querySelector('[data-turn-progress]')).toBeNull();
    const resolved = { ...question, interaction: question.interaction === null ? null : { ...question.interaction, outcome: 'withdrawn' as const } };
    rerender(<MessageList {...props} view={view([answer, ...others, resolved], [chatTurn('parent')])} />);
    expect(container.querySelector('[data-turn-progress]')).not.toBeNull();
  });
});
