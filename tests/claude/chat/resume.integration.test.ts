// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9 (docs/planning/_archive/M16.md; C25, C26, C50, C68, C86, C90): a saved Claude session, resumed by another
// process, on the real adapter and process layer against the replay fake. The resume itself, the
// sign of a session Claude no longer has, and a launch that fails without it.
import { afterEach, describe, expect, it } from 'vitest';
import { noticeWords, removeUnsure } from '@shared/contracts/chat';
import { CHAT_FIXED_ARGS, claudeHarness, type Harness, processGone, READING, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const options = (h: Harness) => ({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING });

/** One completed turn of a new session, closed: its reference. */
async function saved(h: Harness): Promise<string> {
  const first = watch(h.facet.start(options(h)));
  first.send(h.prompts.t1);
  await first.ended('turn-1');
  const reference = first.reference();
  if (reference === undefined) throw new Error('no reference was reported');
  await first.session.close();
  await processGone(h, first.session);
  return reference;
}

describe('resume (V9; C25)', () => {
  it('resumes the conversation in a new process, with `--resume` and the reference in its folder, and reports no second reference', async () => {
    const h = harness = await claudeHarness();
    const reference = await saved(h);
    const again = watch(h.facet.resume({ ...options(h), reference }));
    // Nothing is launched until the next prompt.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.only().entry.launches).toHaveLength(1);

    again.send(h.prompts.t1, 2);
    expect(await again.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    const { id, entry } = h.only();
    expect(id).toBe(reference);
    expect(entry.launches).toHaveLength(2);
    expect(entry.launches[1]).toMatchObject({ cwd: h.project, resume: reference });
    expect(entry.launches[1]?.args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low', '--resume', reference]);
    expect(entry.launches[0]?.pid).not.toBe(entry.launches[1]?.pid);
    expect(again.events.some((event) => event.type === 'session-started')).toBe(false);
    // It sends nothing of the earlier conversation: the turn's own text, once (C50).
    expect(again.events.filter((event) => event.type === 'message')).toHaveLength(1);
    expect(entry.turns).toEqual(['m19-t1-basic', 'm19-t1-basic']);
  });

  it('resumes after a process that was lost during a turn, too: the next session picks the conversation up (C86, C90)', async () => {
    const h = harness = await claudeHarness();
    h.control({ exitDuringTurn: 1 });
    const first = watch(h.facet.start(options(h)));
    first.send(h.prompts.t1);
    expect(await first.ended('turn-1')).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
    await first.session.closed;
    const reference = first.reference() as string;
    expect(typeof reference).toBe('string');
    const again = watch(h.facet.resume({ ...options(h), reference }));
    again.send(h.prompts.t1, 2);
    expect(await again.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    expect(h.only().entry.launches.map((launch) => launch.resume)).toEqual([null, reference]);
  });

  it('checks the resumed launch’s reply, and writes no prompt when it reports another permission mode', async () => {
    const h = harness = await claudeHarness();
    const reference = await saved(h);
    h.control({ otherMode: 'reply' });
    const again = watch(h.facet.resume({ ...options(h), reference }));
    again.send(h.prompts.t1, 2);
    expect(await again.ended('turn-2')).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'failed', reported: false, failure: 'not-read-only' });
    expect(h.only().entry.turns).toEqual(['m19-t1-basic']);
  });
});

describe('a resume that cannot be made (V9; C26, C68)', () => {
  it('offers the removal for the sign of a session Claude no longer has, and writes no prompt', async () => {
    const h = harness = await claudeHarness();
    const again = watch(h.facet.resume({ ...options(h), reference: '11111111-1111-4111-8111-111111111111' }));
    again.send(h.prompts.t1, 2);
    expect(await again.ended('turn-2')).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'failed', reported: false, failure: 'session-not-reopened' });
    expect(again.notices()).toEqual(['session-not-reopened']);
    // The fake held no such session and took no prompt: nothing was made for it.
    expect(h.sessions()).toEqual({});
    await expect(again.session.closed).resolves.toEqual({ ok: true });
    // No text of the CLI's is in the notice: the frame's own words are never read.
    expect(JSON.stringify(again.events)).not.toContain('No conversation found');
  });

  it('offers it on that frame whatever else the CLI says, for a session the fake does hold too', async () => {
    const h = harness = await claudeHarness();
    const reference = await saved(h);
    h.control({ resumeMissing: 1 });
    const again = watch(h.facet.resume({ ...options(h), reference }));
    again.send(h.prompts.t1, 2);
    expect(await again.ended('turn-2')).toMatchObject({ outcome: 'failed', reported: false, failure: 'session-not-reopened' });
    expect(h.only().entry.turns).toEqual(['m19-t1-basic']);
    // The next resume, with nothing in its way, opens: the offer did not say the conversation was gone.
    const third = watch(h.facet.resume({ ...options(h), reference }));
    third.send(h.prompts.t1, 3);
    expect(await third.ended('turn-3')).toMatchObject({ outcome: 'completed' });
  });

  it('offers none for a launch that fails without that sign: the start failed at its reopening', async () => {
    const h = harness = await claudeHarness();
    const reference = await saved(h);
    h.control({ launchFails: 1 });
    const again = watch(h.facet.resume({ ...options(h), reference }));
    again.send(h.prompts.t1, 2);
    expect(await again.ended('turn-2')).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'failed', reported: false, failure: 'start-failed' });
    expect(again.events.find((event) => event.type === 'notice')).toEqual({ type: 'notice', kind: 'start-failed', turnId: 'turn-2', step: 'reopen' });
  });

  it('is worded for a chat that fat-g saved: the conversation may still exist, the saved chat stays readable, and a removal deletes it (C68)', () => {
    const offer = noticeWords('session-not-reopened', 'Claude');
    expect(offer).toContain('It may have been deleted in Claude, or something else may have gone wrong.');
    expect(offer).toContain('The chat fat-g saved stays readable.');
    expect(removeUnsure('Claude')).toContain('fat-g cannot tell for sure that this conversation is gone');
    expect(removeUnsure('Claude')).toContain('deletes the chat fat-g saved');
  });
});
