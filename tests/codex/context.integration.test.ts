// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0033: how full a Codex session's context is, on the real adapter and process layer
// against the replay fake — each thread's token report as K1's captures hold them, the session's own
// thread read and a sub-agent's never.
import { afterEach, describe, expect, it } from 'vitest';
import { ContextReadingSchema } from '@shared/contracts/sessions';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { codexHarness, type Harness, PROMPTS, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));

describe('a Codex session’s context (decision 0033)', () => {
  it('says its own thread’s reports, each the last call’s whole count against the model’s window, with no line', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t1);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    const last = await session.reading((reading) => reading.used > 0);
    expect(last.window).toBe(258_400);
    expect(last).not.toHaveProperty('compactAt');
    expect(last.lastCall?.output).toBeGreaterThan(0);
    for (const reading of session.readings) expect(ContextReadingSchema.safeParse(reading).success).toBe(true);
    // None reaches the events a chat is made of.
    expect(session.types()).not.toContain('context');
  });

  it('never says a sub-agent’s report as the session’s', async () => {
    const h = harness = await codexHarness();
    const session = start(h);
    session.send(PROMPTS.t3);
    await session.ended('turn-1');
    // K1's worker capture: the session's own thread counted 16,909 to 17,099, its worker 16,716 and 16,811.
    await session.reading((reading) => reading.used === 17_099);
    expect(session.readings.map((reading) => reading.used)).toEqual([16_909, 16_951, 16_997, 17_099]);
    expect((session.session as CodexSession).counts.context).toEqual({ read: 4, skipped: 2 });
  });
});
