// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9 (docs/planning/_archive/M23.md; C54, C89): the drain on its own — one claim at a time, held while its send
// is answered; a wait lets the claim go and leaves the queue as it was; a pause holds the queue until
// Resume; and an answer that comes after the queue was dropped changes nothing. And a held Send now:
// into the turn as soon as that takes a message, or as the next prompt once the session is idle.
import { describe, expect, it, vi } from 'vitest';
import { NO_INTENT } from '@shared/contracts/composer';
import { createQueueDrain, type QueuedInput, type QueueSent } from './queue';

const SESSION = 'session-1';
const entry = (id: string): QueuedInput => ({ id, text: `Message ${id}`, intent: NO_INTENT, attachmentIds: [] });

function setup(waits: readonly string[] = ['running', 'not-steerable']) {
  let queue: QueuedInput[] = [entry('a'), entry('b')];
  let idle = true;
  let steerable = false;
  const answers: ((sent: QueueSent) => void)[] = [];
  const steers: string[] = [];
  const sends: string[] = [];
  const changed = vi.fn();
  const answering = (kind: string[], sent: QueuedInput): Promise<QueueSent> => {
    kind.push(sent.id);
    return new Promise<QueueSent>((resolve) => { answers.push((answer) => { if (answer.status === 'sent') queue = queue.filter((held) => held.id !== sent.id); resolve(answer); }); });
  };
  const drain = createQueueDrain({
    first: (_id, among) => (among === undefined ? queue[0] : queue.find((held) => among.has(held.id))) ?? null,
    idle: () => idle,
    steerable: () => steerable,
    send: (_id, sent) => answering(sends, sent),
    steer: (_id, sent) => answering(steers, sent),
    waits: (_id, reason) => waits.includes(reason),
    changed,
  });
  return {
    drain, answers, changed, steers, sends,
    set idle(value: boolean) { idle = value; },
    set steerable(value: boolean) { steerable = value; },
    queue: () => queue,
    put(...ids: string[]) { queue = [...ids.map(entry), ...queue]; },
  };
}

const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });

describe('the drain (V9; C54, C89)', () => {
  it('claims the first entry once, and holds it until its send is answered; a wake meanwhile runs once that answer is in', async () => {
    const s = setup();
    s.drain.wake(SESSION);
    s.drain.wake(SESSION);
    expect(s.answers).toHaveLength(1);
    expect(s.drain.sending(SESSION)).toBe('a');
    s.answers[0]?.({ status: 'sent' });
    await flush();
    expect(s.queue().map((held) => held.id)).toEqual(['b']);
    expect(s.drain.sending(SESSION)).toBe('b');
    s.answers[1]?.({ status: 'sent' });
    await flush();
    expect(s.drain.sending(SESSION)).toBeNull();
  });

  it('claims nothing while the session is not idle', () => {
    const s = setup();
    s.idle = false;
    s.drain.wake(SESSION);
    expect(s.answers).toEqual([]);
  });

  it('lets a wait’s claim go and leaves the queue as it was, unpaused', async () => {
    const s = setup();
    s.drain.wake(SESSION);
    s.answers[0]?.({ status: 'refused', reason: 'running' });
    await flush();
    expect([s.drain.sending(SESSION), s.drain.paused(SESSION)]).toEqual([null, null]);
    s.drain.wake(SESSION);
    expect(s.answers).toHaveLength(2);
  });

  it('pauses on any other refusal, claims nothing until Resume, and Resume claims again', async () => {
    const s = setup();
    s.drain.wake(SESSION);
    s.answers[0]?.({ status: 'refused', reason: 'not-installed' });
    await flush();
    expect(s.drain.paused(SESSION)).toEqual({ reason: 'not-installed' });
    s.drain.wake(SESSION);
    expect(s.answers).toHaveLength(1);
    expect(s.drain.resume(SESSION)).toBe(true);
    expect(s.answers).toHaveLength(2);
    expect(s.drain.resume(SESSION)).toBe(false);
  });

  it('takes no answer that comes after its queue was dropped', async () => {
    const s = setup();
    s.drain.wake(SESSION);
    s.drain.forget(SESSION);
    s.answers[0]?.({ status: 'refused', reason: 'not-installed' });
    await flush();
    expect(s.drain.paused(SESSION)).toBeNull();
  });
});

describe('a held Send now in the drain', () => {
  it('waits while the turn takes no message, and goes into it as soon as it does, ahead of what was queued', async () => {
    const s = setup();
    s.idle = false;
    s.put('now');
    s.drain.hold(SESSION, 'now');
    s.drain.wake(SESSION);
    expect(s.answers).toEqual([]);
    s.steerable = true;
    s.drain.wake(SESSION);
    expect([s.steers, s.sends]).toEqual([['now'], []]);
    s.answers[0]?.({ status: 'sent' });
    await flush();
    expect(s.drain.held(SESSION).size).toBe(0);
    expect(s.queue().map((held) => held.id)).toEqual(['a', 'b']);
    // What was queued still waits for the session to be idle.
    s.drain.wake(SESSION);
    expect(s.answers).toHaveLength(1);
  });

  it('goes as the next prompt once the session is idle, if the turn never took a message', async () => {
    const s = setup();
    s.put('now');
    s.drain.hold(SESSION, 'now');
    s.drain.wake(SESSION);
    expect([s.steers, s.sends]).toEqual([[], ['now']]);
    s.answers[0]?.({ status: 'sent' });
    await flush();
    expect(s.drain.held(SESSION).size).toBe(0);
  });

  it('stays held where the turn could not take it after all, and goes at the next wake', async () => {
    const s = setup();
    s.idle = false;
    s.steerable = true;
    s.put('now');
    s.drain.hold(SESSION, 'now');
    s.drain.wake(SESSION);
    s.answers[0]?.({ status: 'refused', reason: 'not-steerable' });
    await flush();
    expect([s.drain.held(SESSION).has('now'), s.drain.paused(SESSION)]).toEqual([true, null]);
    s.drain.wake(SESSION);
    expect(s.steers).toEqual(['now', 'now']);
  });

  it('is not held back by a pause of the queue behind it', async () => {
    const s = setup();
    s.drain.wake(SESSION);
    s.answers[0]?.({ status: 'refused', reason: 'not-installed' });
    await flush();
    s.put('now');
    s.drain.hold(SESSION, 'now');
    s.drain.wake(SESSION);
    expect(s.sends).toEqual(['a', 'now']);
  });

  it('goes as any queued message where it asks a plan turn or a skill, which is never sent now', () => {
    const s = setup();
    s.idle = false;
    s.steerable = true;
    s.put('plan');
    s.drain.hold(SESSION, 'plan');
    const held = s.queue()[0];
    if (held !== undefined) (held as { intent: QueuedInput['intent'] }).intent = { plan: true, skill: null };
    s.drain.wake(SESSION);
    expect(s.answers).toEqual([]);
    expect(s.drain.held(SESSION).size).toBe(0);
  });

  it('is forgotten with its queue', () => {
    const s = setup();
    s.drain.hold(SESSION, 'a');
    s.drain.forget(SESSION);
    expect(s.drain.held(SESSION).size).toBe(0);
  });
});
