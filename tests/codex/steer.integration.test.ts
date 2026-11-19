// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V8, V10, V11, the Codex adapter's part on its replay fake (docs/planning/_archive/M23.md; C24, C36, C38, C39,
// C63, C72; K1): through the real adapter and process layer, as K1's captures have them — an
// image's turn with its `localImage` input, a steer joining the running turn and taken by its reply, a
// steer once the turn is over refused with nothing sent, and a folder's skills read on the instance's
// own connection, each a row with a selector and no path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { SessionStart } from '@shared/provider-kit/sessions';
import { collect } from '../sessions/facet-contract';
import { codexHarness, type Harness, promptOf } from './harness';

let h: Harness;
beforeEach(async () => { h = await codexHarness(); });
afterEach(async () => { await h.dispose(); });

const start = (folder: string): SessionStart => ({ folder, model: 'gpt-6-luna', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' });
const isStarted = (event: AgentEvent): event is Extract<AgentEvent, { type: 'turn-started' }> => event.type === 'turn-started' && event.turnId === 'turn-1';

describe('an image on Codex, against the replay fake (V5, V11; C24)', () => {
  it('sends the image as a localImage input with its text, and K1’s turn completes', async () => {
    const session = h.facet.start(start(h.project));
    const told = collect(session);
    session.send({ turnId: 'turn-1', prompt: promptOf('m23-codex-image'), effort: 'low', speed: null, messageId: 'message-1', attachments: [{ mediaType: 'image/png', path: `${h.dir}\\attachments\\a.png`, bytes: new Uint8Array([1]) }] });
    await told.ended('turn-1');
    expect(told.events.filter((event) => event.type === 'turn-ended').map((event) => event.type === 'turn-ended' && event.outcome)).toEqual(['completed']);
    await session.close();
  });
});

describe('Send now on Codex, against the replay fake (V8, V11; C36, C38, C39)', () => {
  it('joins the running turn: the reply names it, and the turn goes on to its one end', async () => {
    const session = h.facet.start(start(h.project));
    const told = collect(session);
    session.send({ turnId: 'turn-1', prompt: promptOf('m23-codex-steer'), effort: 'low', speed: null, messageId: 'message-1' });
    await told.first(isStarted, 'the turn’s start');
    expect(session.steerState?.()).toBe('open');
    expect(await session.steer?.({ turnId: 'turn-1', messageId: 'steer-1', prompt: 'Also say STEERED.' })).toEqual({ kind: 'taken' });
    await told.ended('turn-1');
    expect(told.events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
    // Once the turn is over, nothing is written: the message is the next prompt's (C40).
    expect(session.steerState?.()).toBe('wait');
    expect(await session.steer?.({ turnId: 'turn-1', messageId: 'steer-2', prompt: 'Too late' })).toEqual({ kind: 'turn-over' });
    const thread = Object.values(h.threads()).find((entry) => (entry as { steers?: unknown[] }).steers !== undefined) as { steers: { expectedTurnId: string | null; input: (string | null)[] | null }[] } | undefined;
    expect(thread?.steers).toHaveLength(1);
    expect(thread?.steers[0]?.input).toEqual(['text']);
    await session.close();
  });
});

describe('Codex’s skills, against the replay fake (V10, V11; C63)', () => {
  it('reads a folder’s skills on the instance’s connection: rows under Skills with selectors, and no path', async () => {
    const rows = await h.facet.commands?.(h.project, new AbortController().signal);
    expect(rows?.length).toBeGreaterThan(2);
    expect(rows?.every((row) => row.group === 'skills' && /^[0-9a-f]{32}$/.test(row.selector ?? ''))).toBe(true);
    expect(rows?.filter((row) => row.name === 'm23-marker')).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(h.project);
  });
});
