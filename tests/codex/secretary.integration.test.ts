// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary on Codex end to end (docs/planning/_archive/M26.md, Design 3; Verification): the production
// adapter's facet, the real process layer and the fake app-server, which replays M26's K2 capture.
// No installed CLI, account or credential is involved.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TITLE_TASK } from '../../src/main/sessions/secretary/title';
import { codexHarness, eventually, type Harness } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

interface Frame { readonly dir: string; readonly frame: { readonly method?: string; readonly params?: { readonly input?: readonly { readonly text: string }[]; readonly model?: string } } }
const k2 = (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m26-codex-config-off.json'), 'utf8')) as { frames: Frame[] }).frames;
const sentTurn = k2.find((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start')?.frame.params;
/** What K2 sent as its turn's text: the title task's input for the spike's first prompt. */
const TEXT = sentTurn?.input?.[0]?.text ?? '';

describe('the secretary on Codex, through the real process layer (M26)', () => {
  it('answers K2’s title from one app-server in the probe folder, on one thread started read-only with `never`, and ends the process', async () => {
    harness = await codexHarness();
    const h = harness;
    const secretary = h.facet.secretary;
    if (secretary === undefined) throw new Error('the Codex facet has no secretary');
    expect(TEXT.startsWith('The first message of the session:')).toBe(true);
    const before = Object.keys(h.threads()).length;
    const answer = await secretary({ instructions: TITLE_TASK.instructions, text: TEXT, model: sentTurn?.model ?? 'gpt-6-luna', effort: 'low' }, new AbortController().signal);
    expect(answer).toEqual({ kind: 'answered', text: 'Disable Submit Until Login Fields Are Filled' });
    expect(TITLE_TASK.parse(answer.kind === 'answered' ? answer.text : '')).toBe('Disable Submit Until Login Fields Are Filled');
    const threads = Object.values(h.threads());
    expect(threads).toHaveLength(before + 1);
    const thread = threads.at(-1);
    expect(thread?.opens).toEqual([{ method: 'thread/start', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: null }]);
    expect(path.basename(String(thread?.cwd))).toBe('probe-cwd');
    // The process is gone once the answer is given: only the instance's own connection runs.
    await eventually(() => h.running().length <= 1);
  });

  it('ends a process whose turn never starts when the request is let go of', async () => {
    harness = await codexHarness();
    const h = harness;
    const secretary = h.facet.secretary;
    if (secretary === undefined) throw new Error('the Codex facet has no secretary');
    h.control({ hang: 'send' });
    const running = h.running().length;
    const controller = new AbortController();
    const answer = secretary({ instructions: TITLE_TASK.instructions, text: TEXT, model: 'gpt-6-luna', effort: null }, controller.signal);
    await eventually(() => Object.values(h.threads()).some((thread) => thread.opens?.length === 1 && path.basename(String(thread.cwd)) === 'probe-cwd'));
    controller.abort();
    expect(await answer).toEqual({ kind: 'failed', reason: 'aborted' });
    await eventually(() => h.running().length <= running);
  });
});
