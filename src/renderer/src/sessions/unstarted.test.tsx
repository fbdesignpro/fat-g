// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the selection leaves behind in a session no turn has run (docs/planning/_archive/M26.md, round 2):
// nothing typed and no name, and it goes; text in its composer, and the secretary is asked what the
// text is about. The page's work, since the draft is the page's own.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { SUMMARIES, sessionEntry } from '../../../../tests/support/sessions';
import { setDraft, useChatDrafts } from '../chat/chat-store';
import { takeComposer } from '../chat/composer/composer-store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { hasCapsule, useUnstartedSessions } from './unstarted';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: { status: 'saved' } });
  });
  useChatDrafts.setState({ drafts: {} });
});
afterEach(cleanup);

const A = project('Calamari');
const B = project('website');
const fresh = (name: string | null = null, nameSource: 'user' | 'generated' | null = name === null ? null : 'generated') =>
  sessionEntry(name, SUMMARIES.notStarted, { projectId: A.id, nameSource, createdAt: Date.UTC(2020, 0, 22, 12, 0) });
const other = sessionEntry('Elsewhere', SUMMARIES.idle, { projectId: B.id });

function Watcher() {
  useUnstartedSessions();
  return null;
}

/** Selects a session, with both of them listed, and lets the effects run. */
const select = async (sessions: readonly SessionEntry[], selectedId: string | null) => {
  await act(async () => {
    showState({ projects: [A, B], sessions, selectedId });
    await Promise.resolve();
  });
};

describe('a session left before its first turn (M26, round 2)', () => {
  it('removes one with nothing typed and no name when the selection moves away', async () => {
    const entry = fresh();
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    expect(requests).toEqual([]);
    await select([entry, other], other.record.id);
    expect(requests).toEqual([['sessions:remove', { id: entry.record.id }]]);
  });

  it('asks the secretary about the draft instead, and asks again only when the text has changed', async () => {
    const entry = fresh();
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    setDraft(entry.record.id, '  Set up the login form  ');
    await select([entry, other], other.record.id);
    expect(requests).toEqual([['sessions:describeDraft', { id: entry.record.id, text: 'Set up the login form' }]]);
    // Back into it and away again with the same text: nothing is sent twice.
    await select([entry, other], entry.record.id);
    await select([entry, other], other.record.id);
    expect(requests).toHaveLength(1);
    setDraft(entry.record.id, 'Set up the login form and its test');
    await select([entry, other], entry.record.id);
    await select([entry, other], other.record.id);
    expect(requests).toEqual([
      ['sessions:describeDraft', { id: entry.record.id, text: 'Set up the login form' }],
      ['sessions:describeDraft', { id: entry.record.id, text: 'Set up the login form and its test' }],
    ]);
  });

  it('sends no more of a draft than a name is written from', async () => {
    const entry = fresh();
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    setDraft(entry.record.id, 'x'.repeat(2500));
    await select([entry, other], other.record.id);
    expect(requests).toHaveLength(1);
    expect((requests[0]?.[1] as { text: string }).text).toHaveLength(2000);
  });

  it('keeps a session that has a name, and asks nothing for it with nothing typed', async () => {
    const entry = fresh('setting things up');
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    await select([entry, other], other.record.id);
    expect(requests).toEqual([]);
  });

  it('leaves a session that has run alone, whatever stands in its composer', async () => {
    const started = sessionEntry(null, SUMMARIES.idle, { projectId: A.id });
    await select([started, other], started.record.id);
    render(<Watcher />);
    setDraft(started.record.id, 'A prompt in the making');
    await select([started, other], other.record.id);
    expect(requests).toEqual([]);
  });

  // M23 (V17; C83): a draft of images alone, or a queued message, keeps the session.
  it('keeps one whose draft or queue main says holds something, and gives it a capsule', async () => {
    const entry: SessionEntry = { ...fresh(), content: true };
    expect(hasCapsule(entry, '')).toBe(true);
    expect(hasCapsule(fresh(), '')).toBe(false);
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    await select([entry, other], other.record.id);
    expect(requests).toEqual([]);
  });

  it('keeps one whose composer holds an image the page has, though main has not said so yet', async () => {
    const entry = fresh();
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    const image = { id: 'use-1', hash: 'a'.repeat(64), mediaType: 'image/png' as const, bytes: 10, width: 1, height: 1, name: null };
    takeComposer(entry.record.id, 1, { draft: { revision: 1, text: '', intent: { plan: false, skill: null }, attachments: [image] }, queue: { entries: [], paused: null }, steer: 'wait' });
    await select([entry, other], other.record.id);
    expect(requests).toEqual([]);
  });

  it('asks nothing for a session that is no longer listed: it was removed', async () => {
    const entry = fresh();
    await select([entry, other], entry.record.id);
    render(<Watcher />);
    await select([other], null);
    expect(requests).toEqual([]);
  });
});
