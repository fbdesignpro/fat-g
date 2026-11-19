// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0033: how full a Claude chat's context is, on the real adapter and process layer against
// the replay fake — the CLI asked at a turn's start and after its end, answered with M10's discovery
// reply, and the usage of the session's own calls counted between.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextReadingSchema } from '@shared/contracts/sessions';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { claudeHarness, type Harness, type HarnessOptions, READING, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness) => watch(h.facet.start({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], ...READING }));
const counts = (s: Watched) => (s.session as ClaudeChatSession).counts.context;
const SENTINEL = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/fake-cli-constants.json'), 'utf8')) as { sentinel: string }).sentinel;

describe('a Claude session’s context (decision 0033)', () => {
  it('asks at the turn’s start and after its end, with the summary detail, and says the reply’s reading and its own calls’ counts between', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t1);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed' });
    await s.reading((reading) => reading.used === 23_605 && s.readings.indexOf(reading) > 0);
    expect(h.only().entry.contexts).toEqual(['summary', 'summary']);
    expect(s.readings[0]).toEqual({
      used: 23_605, window: 1_000_000, compactAt: 967_000,
      parts: [{ label: 'System prompt', tokens: 3_183 }, { label: 'System tools', tokens: 18_363 }, { label: 'Skills', tokens: 2_059 }],
      messages: { toolCalls: 0, toolResults: 0, answers: 0, prompts: 0, attachments: 0, other: 0 },
    });
    // Between the two replies, the session's own calls: each with the reply's window and line.
    const between = s.readings.slice(1, -1);
    expect(between.length).toBeGreaterThan(0);
    for (const reading of between) expect(reading).toMatchObject({ window: 1_000_000, compactAt: 967_000, lastCall: expect.any(Object) as object });
    for (const reading of s.readings) expect(ContextReadingSchema.safeParse(reading).success).toBe(true);
    expect(counts(s)).toEqual({ asked: 2, read: 2, failed: 0 });
    expect(s.types()).not.toContain('context');
    expect(h.markers()).toEqual([]);
  });

  it('reads nothing of the paths and the configured names a reply holds', async () => {
    const h = await open();
    h.control({ contextPrivate: true });
    const s = start(h);
    s.send(h.prompts.t1);
    await s.ended('turn-1');
    await s.reading((reading) => reading.parts?.some((part) => part.label === 'Other') === true);
    for (const said of [s.readings, s.events, h.diagnostics()]) expect(JSON.stringify(said)).not.toContain(SENTINEL);
  });

  it('ends a turn on time whatever becomes of the request: unanswered, it is asked again at the next turn; refused, never again on that process', async () => {
    const h = await open();
    h.control({ hang: 'context' });
    const held = start(h);
    held.send(h.prompts.t1);
    expect(await held.ended('turn-1')).toMatchObject({ outcome: 'completed' });
    held.send(h.prompts.t1, 2);
    expect(await held.ended('turn-2')).toMatchObject({ outcome: 'completed' });
    expect(held.readings.every((reading) => reading.lastCall !== undefined)).toBe(true);
    expect(held.notices()).toEqual([]);

    h.control({ contextRefused: true });
    const refused = start(h);
    refused.send(h.prompts.t1);
    await refused.ended('turn-1');
    refused.send(h.prompts.t1, 2);
    await refused.ended('turn-2');
    expect([refused.readings, refused.notices(), counts(refused)]).toEqual([[], [], { asked: 1, read: 0, failed: 1 }]);
  });
});
