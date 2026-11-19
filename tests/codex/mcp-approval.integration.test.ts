// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's leave to run an MCP tool (decision 0018), on the real adapter and process layer against
// the replay fake, which replays spikes/codex-mcp's turns by their prompts (codex-cli 0.164.0): an
// MCP elicitation of the approval kind, placed on the call it asks for and shown as a card, its
// choice written as the elicitation's answer; a server's own form still refused. No test here uses
// the real CLI. What fat-g wrote is read from what the fake noted with the thread.
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { codexHarness, type Harness, promptOf, type ThreadEntry, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

const MODEL = 'gpt-6-luna';
const ACCEPT = { action: 'accept', content: null, _meta: null };
const start = (h: Harness, mode: string): Watched => watch(h.facet.start({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode, processKey: 'process-1' }));
const codex = (session: Watched): CodexSession => session.session as CodexSession;
const of = <T extends AgentEvent['type']>(session: Watched, type: T) => session.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
async function nth<T extends AgentEvent['type']>(session: Watched, type: T, n = 1): Promise<Extract<AgentEvent, { type: T }>> {
  await session.until(() => of(session, type).length >= n, 30_000);
  return of(session, type)[n - 1] as Extract<AgentEvent, { type: T }>;
}
const thread = (h: Harness): ThreadEntry => { const [found] = Object.values(h.threads()); if (found === undefined) throw new Error('the fake has no thread'); return found; };
const mcpEnds = (session: Watched) => of(session, 'activity-ended').filter((event) => event.output?.startsWith('stamp') === true || event.status !== 'completed');
const valid = (session: Watched): void => { for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true); };

describe('leave to run an MCP tool (decision 0018)', () => {
  it('Ask first: each call of a tool with no annotations is a card, shown as its activity names it, and each Approve once is `accept`', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(promptOf('codex-mcp-approval-once'));
    const first = await nth(session, 'approval-raised');
    expect(first.request).toMatchObject({ kind: 'tool', tool: 'mcpToolCall', summary: expect.stringMatching(/: stamp$/) as unknown, detail: { kind: 'input', text: JSON.stringify({ label: 'first' }, null, 2) }, choices: ['approve', 'approve-session', 'deny'] });
    // The card stands for the call it asks for: its activity's id.
    expect(of(session, 'activity-started').map((event) => event.itemId)).toContain(first.sourceId);
    await expect(codex(session).decide(first.requestId, 'approve')).resolves.toBe(true);
    const second = await nth(session, 'approval-raised', 2);
    expect(second.request.detail).toEqual({ kind: 'input', text: JSON.stringify({ label: 'second' }, null, 2) });
    await codex(session).decide(second.requestId, 'approve');
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).replies).toEqual([{ id: 0, result: ACCEPT }, { id: 1, result: ACCEPT }]);
    expect(session.notices()).toEqual([]);
    valid(session);
  });

  it('Approve for this session: the same tool runs again with no card, and another tool of the server asks', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(promptOf('codex-mcp-approval-session'));
    const first = await nth(session, 'approval-raised');
    expect(first.request.grant).toEqual({ covers: first.request.summary });
    await codex(session).decide(first.requestId, 'approve-session');
    const other = await nth(session, 'approval-raised', 2);
    expect(other.request.summary).toMatch(/: stamp_other$/);
    await codex(session).decide(other.requestId, 'approve');
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toHaveLength(2);
    expect(thread(h).replies).toEqual([{ id: 0, result: { action: 'accept', content: null, _meta: { persist: 'session' } } }, { id: 1, result: ACCEPT }]);
    valid(session);
  });

  it('Deny: `decline`, and the call ends declined by the user', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(promptOf('codex-mcp-approval-deny'));
    const raised = await nth(session, 'approval-raised');
    await codex(session).decide(raised.requestId, 'deny');
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).replies).toEqual([{ id: 0, result: { action: 'decline', content: null, _meta: null } }]);
    expect(mcpEnds(session)).toMatchObject([{ itemId: raised.sourceId, status: 'declined', declinedBy: 'user' }]);
    valid(session);
  });

  it('a Stop with the card pending: the turn ends interrupted, and nothing is written for the request', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(promptOf('codex-mcp-approval-stop'));
    const raised = await nth(session, 'approval-raised');
    session.session.stop();
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    await expect(codex(session).decide(raised.requestId, 'approve')).resolves.toBe(false);
    expect(thread(h).replies).toBeUndefined();
  });

  it('Read only + allowed MCP: a tool its server marks as safe runs with no request, and Codex refuses the other itself', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'read-only');
    session.send(promptOf('codex-mcp-annotated-read-only'));
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(thread(h).replies).toBeUndefined();
    const calls = of(session, 'activity-started').filter((event) => event.activityType === 'mcp').map((event) => [event.summary.split(': ')[1], of(session, 'activity-ended').find((end) => end.itemId === event.itemId)?.status]);
    expect(calls).toEqual([['note', 'completed'], ['stamp', 'failed']]);
  });

  it('an MCP server’s own form is refused as before: "method not found", the notice, and no card', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(promptOf('codex-mcp-server-form'));
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(thread(h).replies).toEqual([{ id: 0, error: { code: -32601, message: 'Method not found' } }]);
    expect(session.notices()).toEqual(['request-refused']);
  });
});
