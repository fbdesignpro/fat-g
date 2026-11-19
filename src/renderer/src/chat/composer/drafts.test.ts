// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7 (docs/planning/_archive/M23.md; C31, C86): a draft's text in the page — gathered for 300 ms and handed over
// at the page's revision, never written over by a late answer, kept where typed after a Send, handed
// over at main's ask before the page goes, and before a switch to another session.
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_SEND_MS, EMPTY_COMPOSER, NO_INTENT } from '@shared/contracts/composer';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sessionEntry, SUMMARIES } from '../../../../../tests/support/sessions';
import { selectSession } from '../../sessions/select';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { draftOf, useChatDrafts } from '../chat-store';
import { usePromptTypes } from '../prompt-type-store';
import { choosePlan, composerOf, connectDrafts, editDraft, inputOf, inputTaken, takeComposer } from './composer-store';

const A = project('Calamari');
const ONE = sessionEntry('First', SUMMARIES.idle, { projectId: A.id });
const TWO = sessionEntry('Second', SUMMARIES.idle, { projectId: A.id });
const ID = ONE.record.id;

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  useChatDrafts.setState({ drafts: {} });
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: channel === 'drafts:flushed' ? { status: 'answered' } : { status: 'saved', draft: EMPTY_COMPOSER.draft } });
  });
});
afterEach(() => { vi.useRealTimers(); });

const drafts = () => requests.filter(([channel]) => channel === 'chat:draft').map(([, request]) => request);
const composerAt = (revision: number, text: string) => ({ ...EMPTY_COMPOSER, draft: { ...EMPTY_COMPOSER.draft, revision, text } });

describe('a draft’s text in the page (V7; C31, C86)', () => {
  it('hands over the latest text once, 300 ms after the last change, at the page’s revision', async () => {
    vi.useFakeTimers();
    editDraft(ID, 'H');
    editDraft(ID, 'He');
    await vi.advanceTimersByTimeAsync(DRAFT_SEND_MS - 1);
    editDraft(ID, 'Hello');
    await vi.advanceTimersByTimeAsync(DRAFT_SEND_MS - 1);
    expect(drafts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(drafts()).toEqual([{ sessionId: ID, op: 'text', revision: 3, prompt: 'Hello', intent: NO_INTENT }]);
  });

  it('takes main’s draft where its revision is at or past the page’s, and never over newer typing', () => {
    takeComposer(ID, 1, composerAt(4, 'From main'));
    expect(draftOf(ID)).toBe('From main');
    editDraft(ID, 'From main, and more');
    // A late answer at the revision before: the typing stays.
    takeComposer(ID, 2, composerAt(4, 'From main'));
    expect(draftOf(ID)).toBe('From main, and more');
    expect(composerOf(ID).revision).toBe(5);
  });

  it('keeps text typed after a Send pressed, as the next draft’s start', () => {
    editDraft(ID, 'Look at this');
    const taken = inputOf(ID);
    editDraft(ID, 'Look at this and that');
    inputTaken(ID, taken);
    expect(draftOf(ID)).toBe('and that');
  });

  it('keeps Plan as the draft’s: handed over with it, pressed again from main’s draft after a restart, and kept through a Send (C87)', async () => {
    vi.useFakeTimers();
    choosePlan(ID, true);
    expect(usePromptTypes.getState().types).toEqual({ [ID]: 'plan' });
    await vi.advanceTimersByTimeAsync(DRAFT_SEND_MS);
    expect(drafts()).toEqual([{ sessionId: ID, op: 'text', revision: 1, prompt: '', intent: { plan: true, skill: null } }]);
    const taken = inputOf(ID);
    expect(taken.intent.plan).toBe(true);
    inputTaken(ID, taken);
    expect(composerOf(ID).intent.plan).toBe(true);
    // A new page — a restart — presses it from main's draft.
    bridge = installFakeBridge();
    usePromptTypes.setState({ types: {} });
    takeComposer(ID, 1, { ...EMPTY_COMPOSER, draft: { ...EMPTY_COMPOSER.draft, revision: 3, intent: { plan: true, skill: null } } });
    expect(usePromptTypes.getState().types).toEqual({ [ID]: 'plan' });
  });

  it('hands every unsent draft over at main’s ask, then answers it with its token', async () => {
    const stop = connectDrafts();
    editDraft(ID, 'Typed just before the quit');
    editDraft(TWO.record.id, 'And in another chat');
    await act(async () => {
      bridge.push('drafts:flush', { token: 7 });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(requests.map(([channel]) => channel)).toEqual(['chat:draft', 'chat:draft', 'drafts:flushed']);
    expect(drafts()).toEqual([
      { sessionId: ID, op: 'text', revision: 1, prompt: 'Typed just before the quit', intent: NO_INTENT },
      { sessionId: TWO.record.id, op: 'text', revision: 1, prompt: 'And in another chat', intent: NO_INTENT },
    ]);
    expect(requests.at(-1)).toEqual(['drafts:flushed', { token: 7 }]);
    // With nothing unsent, the ask is answered at once.
    await act(async () => {
      bridge.push('drafts:flush', { token: 8 });
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(requests.at(-1)).toEqual(['drafts:flushed', { token: 8 }]);
    stop();
  });

  it('hands the departing session’s unsent text over before a switch, and switches at once with none', async () => {
    act(() => { showState({ projects: [A], sessions: [ONE, TWO], selectedId: ID }); });
    editDraft(ID, 'Half a thought');
    await selectSession(TWO.record.id);
    expect(requests.map(([channel]) => channel)).toEqual(['chat:draft', 'sessions:select']);
    expect(requests[0]?.[1]).toMatchObject({ sessionId: ID, op: 'text', prompt: 'Half a thought' });
    requests.length = 0;
    await selectSession(TWO.record.id);
    expect(requests.map(([channel]) => channel)).toEqual(['sessions:select']);
  });
});
