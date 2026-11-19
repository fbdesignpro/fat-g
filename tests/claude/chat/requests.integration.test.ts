// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V32 (docs/planning/_archive/M16.md; C22, C64, C85): a request from the CLI during a turn, on the real adapter
// and process layer against the replay fake. The request is K23's: a read outside every root, asked
// for under the launch's own tool list. fat-g grants nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { DENY_MESSAGE } from '../../../src/main/providers/claude/chat-wire';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { claudeHarness, type Harness, READING, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));

describe('a request from the CLI (V32)', () => {
  it('is answered `deny` with fat-g’s fixed words; the turn goes on to its completed end, with one notice', async () => {
    const h = harness = await claudeHarness();
    const s = start(h);
    s.send(h.prompts.request);
    const end = await s.ended('turn-1');
    expect(end).toMatchObject({ outcome: 'completed', reported: true });
    // What the fake received from fat-g for its request: the denial, word for word.
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'deny', message: DENY_MESSAGE, error: null }]);
    expect(h.only().entry.turns).toEqual(['m16-chat-request']);
    expect(s.notices()).toEqual(['request-refused']);
    expect(s.events.find((event) => event.type === 'notice')).toEqual({ type: 'notice', kind: 'request-refused', turnId: 'turn-1' });
    // The model then said what happened, and that text is the turn's answer.
    const texts = s.events.flatMap((event) => (event.type === 'message' ? [event] : []));
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toContain('The read was refused');
    expect(end.answerItemId).toBe(texts[0]?.itemId);
  });

  it('is counted under its own name, in the session’s counts and in the diagnostics, with nothing of what it asked for', async () => {
    const h = harness = await claudeHarness();
    const s = start(h);
    s.send(h.prompts.request);
    await s.ended('turn-1');
    expect((s.session as ClaudeChatSession).counts.refused).toEqual({ can_use_tool: 1 });
    const refused = h.diagnostics().filter((event) => event.type === 'request-refused');
    // The name with its underscore, not `other` (C85).
    expect(refused).toEqual([{ type: 'request-refused', method: 'can_use_tool' }]);
    const logged = JSON.stringify(h.diagnostics());
    for (const absent of ['second.txt', 'file_path', 'Read', 'decision_reason', 'workingDir']) expect(logged, absent).not.toContain(absent);
    // And nothing of the request is in an event. The read the model asked for is the session's own
    // item, with the path it named (M20a, C18): that is conversation content, and in no other event.
    const work = new Set(['action-changed', 'activity-started', 'activity-ended']);
    expect(JSON.stringify(s.events.filter((event) => !work.has(event.type)))).not.toContain('second.txt');
    expect(JSON.stringify(s.events)).not.toContain('decision_reason');
  });

  it('shows one notice a turn, however many turns ask', async () => {
    const h = harness = await claudeHarness();
    const s = start(h);
    s.send(h.prompts.request, 1);
    await s.ended('turn-1');
    s.send(h.prompts.request, 2);
    await s.ended('turn-2');
    expect(s.events.flatMap((event) => (event.type === 'notice' ? [[event.kind, event.turnId]] : []))).toEqual([['request-refused', 'turn-1'], ['request-refused', 'turn-2']]);
    expect((s.session as ClaudeChatSession).counts.refused).toEqual({ can_use_tool: 2 });
    expect(h.only().entry.answers.map((answer) => answer.behavior)).toEqual(['deny', 'deny']);
  });
});
