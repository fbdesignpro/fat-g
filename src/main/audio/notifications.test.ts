// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { defaultPreferences, type PreferencesSnapshot } from '@shared/contracts/prefs';
import { createAudioCues } from './cues';
import { allowsReady, createAudioNotifications } from './notifications';
import { ATTENTION_KINDS } from '@shared/contracts/sessions';

function setup() {
  const emit = vi.fn();
  let ready = true; let active = true;
  const pending: (() => void)[] = [];
  const notifications = createAudioNotifications({ emit, canReady: () => ready, active: () => active, defer: (work) => { pending.push(work); } });
  return { notifications, emit, ready: (value: boolean) => { ready = value; }, active: (value: boolean) => { active = value; }, flush: () => { for (const work of pending.splice(0)) work(); } };
}

describe('live notification identity and precedence', () => {
  it('uses Ready only for an ordinary idle reply, regardless of whether it was acknowledged', () => {
    for (const kind of ATTENTION_KINDS) {
      for (const acknowledged of [true, false]) {
        expect(allowsReady({ status: 'idle', attention: { kind, count: 1, acknowledged } }, false, false)).toBe(kind === 'ready');
      }
    }
    const summary = { status: 'idle', attention: { kind: 'ready', count: 1, acknowledged: true } } as const;
    expect(allowsReady(summary, true, false)).toBe(false);
    expect(allowsReady(summary, false, true)).toBe(false);
    expect(allowsReady({ ...summary, status: 'running' }, false, false)).toBe(false);
    expect(allowsReady({ ...summary, planWait: 'review' }, false, false)).toBe(false);
    expect(allowsReady(undefined, false, false)).toBe(false);
  });
  it('does not announce construction, and defers Ready until all result state is settled', () => {
    const { notifications, emit, ready, flush } = setup();
    expect(emit).not.toHaveBeenCalled();
    notifications.ended('s', 'one', 'completed');
    ready(false); notifications.review('review', 1); flush();
    expect(emit.mock.calls).toEqual([['reviewReady']]);
    ready(true); notifications.ended('s', 'two', 'completed'); flush();
    notifications.ended('s', 'two', 'completed'); flush();
    expect(emit.mock.calls).toEqual([['reviewReady'], ['turnFinished']]);
  });
  it('announces each question or approval card once, including independent workers and sessions', () => {
    const { notifications, emit } = setup();
    notifications.request('s', 'card-one', 'question'); notifications.request('s', 'card-one', 'question');
    notifications.request('s', 'worker-card', 'question'); notifications.request('other', 'card-one', 'question');
    notifications.request('s', 'approval', 'approval'); notifications.request('s', 'approval', 'approval');
    expect(emit.mock.calls).toEqual([['question'], ['question'], ['question'], ['approval']]);
  });
  it('suppresses Ready when a turn leaves another kind of attention', () => {
    const { notifications, emit, ready, flush } = setup(); ready(false);
    notifications.request('s', 'async-card', 'question');
    notifications.ended('s', 'question-turn', 'completed'); flush();
    notifications.plan('plan', 1); notifications.ended('s', 'plan-turn', 'completed'); flush();
    expect(emit.mock.calls).toEqual([['question'], ['planReady']]);
  });
  it('deduplicates shared plan versions and review rounds, even if an older signal arrives later', () => {
    const { notifications, emit } = setup();
    notifications.plan('plan', 1); notifications.plan('plan', 1); notifications.plan('plan', 2); notifications.plan('plan', 1);
    notifications.review('review', 1); notifications.review('review', 1); notifications.review('review', 2);
    expect(emit.mock.calls).toEqual([['planReady'], ['planReady'], ['reviewReady'], ['reviewReady']]);
  });
  it('uses Error for failed turns and leaves stopped and interrupted turns silent', () => {
    const { notifications, emit, flush } = setup();
    notifications.ended('s', 'failed', 'failed'); notifications.ended('s', 'failed', 'failed');
    notifications.ended('s', 'stop', 'stopped'); notifications.ended('s', 'interrupt', 'interrupted'); flush();
    expect(emit.mock.calls).toEqual([['error']]);
  });
  it('drops deferred work when a session is removed or shutdown begins', () => {
    const { notifications, emit, active, flush } = setup();
    notifications.ended('s', 'done', 'completed'); notifications.forgetSession('s'); flush();
    notifications.ended('s', 'error', 'failed'); active(false); flush();
    notifications.request('s', 'new-card', 'question'); notifications.plan('p', 1); notifications.review('r', 1);
    expect(emit).not.toHaveBeenCalled();
  });
  it('does not replay notifications muted or disabled when they arrived', () => {
    const snapshot: PreferencesSnapshot = { rev: 0, values: defaultPreferences(), status: { kind: 'ok' }, instances: {}, providerIssues: {} };
    const push = vi.fn();
    const emit = createAudioCues({ prefs: () => snapshot, idFor: () => 'a'.repeat(64), push });
    const notifications = createAudioNotifications({ emit, canReady: () => true, active: () => true, defer: (work) => work() });
    snapshot.values.audio.muted = true; notifications.request('s', 'muted', 'question');
    snapshot.values.audio.muted = false; notifications.request('s', 'muted', 'question');
    snapshot.values.audio.sounds.error = null; notifications.ended('s', 'failed', 'failed');
    snapshot.values.audio.sounds.error = 'error.wav'; notifications.ended('s', 'failed', 'failed');
    expect(push).not.toHaveBeenCalled();
  });
});
