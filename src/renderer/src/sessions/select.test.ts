// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A press on a session in the Pet (decision 0010): main pushes `sessions:reveal` to this page, which
// opens the session as a pointer press on its capsule does.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { sessionEntry, sessionsState, SUMMARIES } from '../../../../tests/support/sessions';
import { usePromptFocus } from '../chat/prompt-focus';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { connectReveal } from './select';

let bridge: FakeBridge;
let requests: unknown[];
let disconnect: () => void;
const entry = sessionEntry('Waits on you', SUMMARIES.questions);

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: { status: 'saved' } });
  });
  useAppState.setState({ snapshot: { ...sampleSnapshot(2), sessions: sessionsState([entry]) }, error: null });
  usePromptFocus.setState({ sessionId: null, serial: 0 });
  disconnect = connectReveal();
});
afterEach(() => disconnect());

const settle = async (): Promise<void> => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

describe('connectReveal', () => {
  it('selects the session the Pet named, then hands its prompt the keyboard', async () => {
    bridge.push('sessions:reveal', { id: entry.record.id });
    await settle();
    expect(requests).toEqual([['sessions:select', { id: entry.record.id }]]);
    expect(usePromptFocus.getState().sessionId).toBe(entry.record.id);
  });

  it('leaves the keyboard where it is when main refuses', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: { status: 'refused', reason: 'not-found' } }));
    bridge.push('sessions:reveal', { id: entry.record.id });
    await settle();
    expect(usePromptFocus.getState().sessionId).toBeNull();
  });
});
