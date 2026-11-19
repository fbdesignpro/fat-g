// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7, V57 (docs/planning/_archive/M15.md; C24, C25, C129): resuming a session in a new process, and a resume
// that Codex refuses, against the replay fake. The record's side of it — the reference kept when
// its write fails (V41) — is in src/main/sessions/runtime.test.ts. A refused resume's end is the
// adapter's own, not reported (docs/planning/_archive/M18.md, V26; C59).
import { afterEach, describe, expect, it } from 'vitest';
import { codexHarness, type Harness, PROMPTS, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const options = (h: Harness) => ({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' });

/** A session with one completed turn, closed: its reference, and the process it ran on. */
async function started(h: Harness): Promise<{ reference: string; pid: number }> {
  const session = watch(h.facet.start(options(h)));
  session.send(PROMPTS.saved);
  await session.ended('turn-1');
  const reference = session.reference() as string;
  await session.session.close();
  return { reference, pid: h.threads()[reference]?.launches[0]?.pid as number };
}

describe('resume (V7)', () => {
  it('resumes the thread in a new process, checks its reply, then sends the prompt, with no second reference', async () => {
    const h = harness = await codexHarness();
    const { reference, pid } = await started(h);
    const session = watch(h.facet.resume({ ...options(h), reference }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Nothing is launched until the next prompt.
    expect(h.threads()[reference]?.launches).toHaveLength(1);

    session.send(PROMPTS.resume, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    const thread = h.threads()[reference];
    expect(thread?.launches).toHaveLength(2);
    expect(thread?.launches[1]?.pid).not.toBe(pid);
    expect(thread?.turns).toEqual(['m15-saved', 'm15-resume']);
    expect(thread?.cwd).toBe(h.project);
    expect(session.types()).not.toContain('session-started');
    expect(session.events.filter((event) => event.type === 'message' && event.role === 'assistant' && event.phase === 'final')).toHaveLength(1);
    expect(Object.keys(h.threads())).toEqual([reference]);
  });

  it('resumes after a lost process too: the next session picks the thread up where its record left it', async () => {
    const h = harness = await codexHarness();
    const first = watch(h.facet.start(options(h)));
    first.send(PROMPTS.saved);
    await first.ended('turn-1');
    const reference = first.reference() as string;
    h.control({ exitDuringTurn: 1 });
    first.send(PROMPTS.t1, 2);
    expect((await first.ended('turn-2')).failure).toBe('connection-lost');
    await first.session.closed;

    const again = watch(h.facet.resume({ ...options(h), reference }));
    again.send(PROMPTS.resume, 3);
    expect((await again.ended('turn-3')).outcome).toBe('completed');
    expect(h.threads()[reference]?.launches).toHaveLength(2);
  });

  it('checks the resume’s reply, and sends no prompt when it reports another sandbox', async () => {
    const h = harness = await codexHarness();
    const { reference } = await started(h);
    h.control({ otherSandbox: 'sandbox' });
    const session = watch(h.facet.resume({ ...options(h), reference }));
    session.send(PROMPTS.resume, 2);
    expect((await session.ended('turn-2')).failure).toBe('not-read-only');
    expect(h.threads()[reference]?.turns).toEqual(['m15-saved']);
  });
});

describe('a refused resume (V57; C129)', () => {
  it('offers the removal for a thread that no longer exists, and sends no prompt', async () => {
    const h = harness = await codexHarness();
    const session = watch(h.facet.resume({ ...options(h), reference: '11111111-1111-4111-8111-111111111111' }));
    session.send(PROMPTS.t1);
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'session-not-reopened' });
    expect(session.events.filter((event) => event.type === 'notice')).toEqual([{ type: 'notice', kind: 'session-not-reopened', turnId: 'turn-1' }]);
    expect(Object.values(h.threads()).flatMap((thread) => thread.turns)).toEqual([]);
    await expect(session.session.closed).resolves.toEqual({ ok: true });
  });

  it('offers it on the same code whatever the message: the adapter reads no text of the CLI’s', async () => {
    const h = harness = await codexHarness();
    const { reference } = await started(h);
    h.control({ resumeRefused: 'malformed' });
    const session = watch(h.facet.resume({ ...options(h), reference }));
    session.send(PROMPTS.resume, 2);
    expect((await session.ended('turn-2')).failure).toBe('session-not-reopened');
    expect(session.notices()).toEqual(['session-not-reopened']);
    // Nothing of the refusal's own words left the connection.
    expect(JSON.stringify(session.events)).not.toMatch(/invalid session id|rollout/);
    expect(JSON.stringify(h.services.diagnostics.snapshot())).not.toMatch(/invalid session id|rollout/);
  });

  it('offers none on another code: the start failed at its reopening, and the record stays', async () => {
    const h = harness = await codexHarness();
    const { reference } = await started(h);
    h.control({ resumeRefused: 'otherCode' });
    const session = watch(h.facet.resume({ ...options(h), reference }));
    session.send(PROMPTS.resume, 2);
    expect((await session.ended('turn-2')).failure).toBe('start-failed');
    expect(session.events.find((event) => event.type === 'notice')).toEqual({ type: 'notice', kind: 'start-failed', turnId: 'turn-2', step: 'reopen' });
    // It can be sent again: the thread is still there.
    h.control({});
    const again = watch(h.facet.resume({ ...options(h), reference }));
    again.send(PROMPTS.resume, 3);
    expect((await again.ended('turn-3')).outcome).toBe('completed');
  });
});
