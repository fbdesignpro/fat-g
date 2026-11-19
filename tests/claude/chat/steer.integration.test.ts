// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, V11, the Claude adapter's part on its replay fake (docs/planning/_archive/M23.md; C36, C42, C43, C72; K2):
// a message written while a turn runs, through the real adapter and process layer, as K2's
// captures have it — run as the CLI's next turn after a turn of text alone, folded into a turn with
// tool calls at its next tool boundary, and dropped by a Stop that asks `cancel_queued`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { ProviderSession, SessionStart } from '@shared/provider-kit/sessions';
import { collect, type Collected } from '../../sessions/facet-contract';
import { claudeHarness, type Harness, promptOf } from './harness';

let h: Harness;
beforeEach(async () => { h = await claudeHarness(); });
afterEach(async () => { await h.dispose(); });

const start = (folder: string): SessionStart => ({ folder, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' });
const isInit = (event: AgentEvent): event is Extract<AgentEvent, { type: 'in-force' }> => event.type === 'in-force' && event.turnId === 'turn-1' && event.model !== undefined;

/** A turn of the capture's first prompt, up to its `init`: Send now is offered from there. */
async function running(capture: string): Promise<{ session: ProviderSession; told: Collected }> {
  const session = h.facet.start(start(h.project));
  const told = collect(session);
  session.send({ turnId: 'turn-1', prompt: promptOf(capture, h.project), effort: 'low', speed: null, messageId: 'message-1' });
  await told.first(isInit, 'the turn’s init');
  expect(session.steerState?.()).toBe('open');
  return { session, told };
}

const steer = (capture: string) => ({ turnId: 'turn-1', messageId: 'steer-1', prompt: promptOf(capture, h.project, 1) });

describe('an image on Claude, against the replay fake (V5, V11; C21, C23; K2)', () => {
  it('takes a prompt of a text and an image as K2’s turn, and completes it', async () => {
    const session = h.facet.start(start(h.project));
    const told = collect(session);
    const capture = 'm23-claude-image';
    const text = 'An image is attached. Say in one short sentence which colour fills its left half and which fills its right half. Use no tools.';
    session.send({ turnId: 'turn-1', prompt: text, effort: 'low', speed: null, messageId: 'message-1', attachments: [{ mediaType: 'image/png', path: 'unused', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }] });
    await told.ended('turn-1');
    expect(told.events.filter((event) => event.type === 'turn-ended').map((event) => event.type === 'turn-ended' && event.outcome)).toEqual(['completed']);
    expect(h.only().entry.turns).toEqual([capture]);
    await session.close();
  });
});

describe('Send now on Claude, against the replay fake (V8, V11; C42, C43; K2)', () => {
  it('runs a frame written during a turn of text alone as the CLI’s next turn, with its own end', async () => {
    const { session, told } = await running('m23-claude-steer-text');
    expect(await session.steer?.(steer('m23-claude-steer-text'))).toEqual({ kind: 'handed' });
    await told.ended('turn-1');
    await told.ended('steer-1:turn');
    expect(told.events.filter((event) => event.type === 'held-turn-started')).toEqual([{ type: 'held-turn-started', turnId: 'steer-1:turn', messageId: 'steer-1' }]);
    expect(told.events.filter((event) => event.type === 'turn-ended').map((event) => event.type === 'turn-ended' && [event.turnId, event.outcome])).toEqual([['turn-1', 'completed'], ['steer-1:turn', 'completed']]);
    expect(told.events.filter((event) => event.type === 'delivery')).toEqual([]);
    await session.close();
  });

  it('folds a frame written during tool calls into the turn at its next tool boundary, with one end', async () => {
    const { session, told } = await running('m23-claude-steer-tool');
    expect(await session.steer?.(steer('m23-claude-steer-tool'))).toEqual({ kind: 'handed' });
    await told.ended('turn-1');
    expect(told.events.filter((event) => event.type === 'delivery')).toEqual([{ type: 'delivery', messageId: 'steer-1', state: 'taken' }]);
    expect(told.events.filter((event) => event.type === 'held-turn-started')).toEqual([]);
    expect(told.events.filter((event) => event.type === 'turn-ended')).toHaveLength(1);
    await session.close();
  });

  it('drops a held frame with a Stop that asks cancel_queued: cancelled, and nothing runs after', async () => {
    const { session, told } = await running('m23-claude-stop-held');
    expect(await session.steer?.(steer('m23-claude-stop-held'))).toEqual({ kind: 'handed' });
    session.stop();
    await told.ended('turn-1');
    expect(told.events.filter((event) => event.type === 'delivery')).toEqual([{ type: 'delivery', messageId: 'steer-1', state: 'cancelled' }]);
    expect(told.events.filter((event) => event.type === 'turn-ended').map((event) => event.type === 'turn-ended' && event.outcome)).toEqual(['interrupted']);
    expect(told.events.filter((event) => event.type === 'held-turn-started')).toEqual([]);
    await session.close();
  });
});
