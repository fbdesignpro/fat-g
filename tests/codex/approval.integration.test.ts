// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V7, V11, V21, V27, V31, V34, the adapter's part (docs/planning/_archive/M22.md, Design 3, 4, 7, 8, 11;
// C4, C7, C8, C13, C21, C64, C67–C71, C76, C91, C95, C96): a session under a mode, and the requests
// for leave it holds, on the real adapter and process layer against the replay fake, which replays
// K1's, K4's and K6's turns by their prompts. No test here uses the real CLI.
//
// What the fake was sent is read from what it noted with the thread: what each start and each turn
// named of a policy, each reply to a request, and each change it made in its project folder for an
// accepted one. Every wait is on the event it waits for.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ApprovalChoice } from '@shared/contracts/interaction';
import type { CodexSession } from '../../src/main/providers/codex/session';
import { codexHarness, type Harness, PROMPTS, type ThreadEntry, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

const MODEL = 'gpt-6-luna';
const NOT_FOUND = { code: -32601, message: 'Method not found' };
const WORKSPACE = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
const READ_ONLY = { type: 'readOnly', networkAccess: false };
const start = (h: Harness, mode: string | null, key = 'process-1'): Watched => watch(h.facet.start({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode, processKey: key }));
const resume = (h: Harness, mode: string | null, reference: string, key = 'process-2'): Watched => watch(h.facet.resume({ folder: h.project, model: MODEL, effort: 'low', speed: null, otherFolders: [], mode, processKey: key, reference }));
const codex = (session: Watched): CodexSession => session.session as CodexSession;
const decide = (session: Watched, requestId: string, choice: ApprovalChoice | null): Promise<boolean> => codex(session).decide(requestId, choice);
const of = <T extends AgentEvent['type']>(session: Watched, type: T) => session.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
/** The `n`th event of a type, once it has come. */
async function nth<T extends AgentEvent['type']>(session: Watched, type: T, n = 1): Promise<Extract<AgentEvent, { type: T }>> {
  await session.until(() => of(session, type).length >= n, 30_000);
  return of(session, type)[n - 1] as Extract<AgentEvent, { type: T }>;
}
const resolutions = (session: Watched): string[] => session.events.flatMap((event) => (event.type === 'approval-resolved' || event.type === 'question-resolved' ? [`${event.type}:${event.reason}:${event.requestId}`] : []));
const thread = (h: Harness): ThreadEntry => { const [found] = Object.values(h.threads()); if (found === undefined) throw new Error('the fake has no thread'); return found; };
const inProject = (h: Harness, name: string): string | null => (existsSync(path.join(h.project, name)) ? readFileSync(path.join(h.project, name), 'utf8') : null);
const valid = (session: Watched): void => { for (const event of session.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true); };

describe('a session under a mode (V2, V7; C4, C7, C64, C70)', () => {
  it('Ask first on an account with no sandbox: names its sandbox, policy and reviewer, takes read-only for it, and names that again on the turn (C4, C7)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    expect(thread(h).opens).toEqual([{ method: 'thread/start', sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' }]);
    // The thread has the read-only sandbox, as K1's account reported: the turn names that, and not what was asked for.
    expect(thread(h).policies).toEqual([{ approvalPolicy: 'untrusted', sandboxPolicy: READ_ONLY, approvalsReviewer: 'user' }]);
    expect(of(session, 'in-force')).toEqual([{ type: 'in-force', mode: 'ask-first' }]);
    expect(session.types().indexOf('in-force')).toBeLessThan(session.types().indexOf('turn-started'));
    // And the account is now known to have none: Ask first says so, and the two that need one are unavailable.
    const modes = Object.fromEntries((h.facet.modes?.() ?? []).map((mode) => [mode.id, mode]));
    expect(modes['ask-first']).toMatchObject({ available: true, unconfined: true, places: null });
    expect(modes['sandbox-ok']).toMatchObject({ available: false, reason: 'needs-setup' });
    await decide(session, raised.requestId, 'deny');
    expect((await session.ended('turn-1')).outcome).toBe('completed');
  });

  it('Read only: named and reported as it always was, the turn naming the read-only sandbox again and no reviewer; a request is declined at once (C45, C70)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'read-only');
    session.send(PROMPTS.command);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).opens).toEqual([{ method: 'thread/start', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: null }]);
    expect(thread(h).policies).toEqual([{ approvalPolicy: 'never', sandboxPolicy: READ_ONLY, approvalsReviewer: null }]);
    expect(of(session, 'in-force')).toEqual([{ type: 'in-force', mode: 'read-only' }]);
    // The request never becomes a card: declined on the wire, with the notice, and the item ends declined by no one.
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(thread(h).replies).toEqual([{ id: 0, result: { decision: 'decline' } }]);
    expect(session.notices()).toEqual(['request-refused']);
    const declined = of(session, 'activity-ended').filter((event) => event.status === 'declined');
    expect(declined).toHaveLength(1);
    expect(declined[0]).not.toHaveProperty('declinedBy');
    expect(inProject(h, 'k1-once.txt')).toBeNull();
    valid(session);
  });

  it('Sandbox ok on an account with a sandbox: the turn names again the reply’s own sandbox, policy and reviewer, as K4’s did (C7, C65)', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready' });
    const session = start(h, 'sandbox-ok');
    session.send(PROMPTS.outside);
    const raised = await nth(session, 'approval-raised');
    expect(thread(h).opens).toEqual([{ method: 'thread/start', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }]);
    expect(thread(h).policies).toEqual([{ approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE, approvalsReviewer: 'user' }]);
    // The places the reply reported, told for the account: the temporary folders with the folder, no other root, no network.
    const modes = Object.fromEntries((h.facet.modes?.() ?? []).map((mode) => [mode.id, mode]));
    expect(modes['sandbox-ok']?.places).toEqual({ temporary: true, roots: [], network: false });
    expect(raised.request).toMatchObject({ kind: 'file-change', choices: ['approve', 'approve-session', 'deny'] });
    // K4 declined it, and so does the user: the item ends declined, and no file is made.
    await expect(decide(session, raised.requestId, 'deny')).resolves.toBe(true);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'activity-ended').filter((event) => event.status === 'declined')).toEqual([expect.objectContaining({ itemId: raised.sourceId, declinedBy: 'user' })]);
    expect(thread(h).changes).toBeUndefined();
  });

  it.each(['sandbox-ok', 'auto-reviewed'] as const)('%s on an account with no sandbox: the reply reports read-only, nothing is sent after it, and the turn fails as a policy mismatch with what was reported (C4, C46)', async (mode) => {
    const h = harness = await codexHarness();
    const session = start(h, mode);
    session.send(PROMPTS.outside);
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' });
    expect(of(session, 'notice')).toEqual([{ type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail: `sandbox: readOnly; approvalPolicy: on-request; approvalsReviewer: ${mode === 'sandbox-ok' ? 'user' : 'auto_review'}` }]);
    expect(of(session, 'in-force')).toEqual([]);
    await expect(session.session.closed).resolves.toEqual({ ok: true });
    // The start was made, and no turn was: nothing was sent after the reply.
    expect(thread(h).opens).toHaveLength(1);
    expect(thread(h).policies).toBeUndefined();
    expect(thread(h).kept).toBe(false);
    valid(session);
  });

  it.each([
    ['startOtherPolicy', 'ask-first', 'sandbox: workspaceWrite; approvalPolicy: on-request; approvalsReviewer: user'],
    ['startOtherReviewer', 'sandbox-ok', 'sandbox: workspaceWrite; approvalPolicy: on-request; approvalsReviewer: auto_review'],
    ['startOtherSandbox', 'berserk', 'sandbox: readOnly; approvalPolicy: never; approvalsReviewer: user'],
  ] as const)('%s: a reply that reports another one than %s named fails the turn before any prompt, and the next start, which reports as named, runs (C7, C46, C70)', async (fault, mode, detail) => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready', [fault]: 1 });
    const refused = start(h, mode);
    refused.send(PROMPTS.t1);
    expect((await refused.ended('turn-1')).failure).toBe('policy-mismatch');
    expect(of(refused, 'notice')).toEqual([{ type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail }]);
    await refused.session.closed;
    const next = start(h, mode, 'process-2');
    next.send(PROMPTS.t1);
    expect((await next.ended('turn-1')).outcome).toBe('completed');
    expect(of(next, 'in-force')).toEqual([{ type: 'in-force', mode }]);
  });

  it('Auto reviewed: Codex’s own reviewer answers, no request reaches fat-g, and its three frames are counted and nothing more (C96)', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready' });
    const session = start(h, 'auto-reviewed');
    session.send(PROMPTS.reviewed);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).opens).toEqual([{ method: 'thread/start', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }]);
    expect(thread(h).policies).toEqual([{ approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE, approvalsReviewer: 'auto_review' }]);
    expect(codex(session).counts.reviews).toBe(3);
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(session.notices()).toEqual([]);
    expect(thread(h).replies).toBeUndefined();
    // The reviewed change's own item is the chat's record, and nothing of the review's words is in an event.
    expect(of(session, 'activity-started').filter((event) => event.activityType === 'edit')).toHaveLength(1);
    expect(JSON.stringify(session.events)).not.toMatch(/Automatic approval review|riskLevel/);
    valid(session);
  });

  it('Berserk: full access and never, no reviewer named at the start or on the turn, and nothing asks (C4, C70, C93)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'berserk');
    session.send(PROMPTS.berserk);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).opens).toEqual([{ method: 'thread/start', sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: null }]);
    expect(thread(h).policies).toEqual([{ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, approvalsReviewer: null }]);
    expect(of(session, 'in-force')).toEqual([{ type: 'in-force', mode: 'berserk' }]);
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(of(session, 'activity-ended').every((event) => event.status === 'completed')).toBe(true);
  });

  it('changes a thread’s mode in one way alone: the process closed, and a resume in a fresh one that names the new mode, its reply held to it (C64)', async () => {
    const h = harness = await codexHarness();
    h.control({ sandboxState: 'ready' });
    const first = start(h, 'read-only');
    first.send(PROMPTS.t1);
    expect((await first.ended('turn-1')).outcome).toBe('completed');
    const reference = first.reference() as string;
    await first.session.close();
    const second = resume(h, 'sandbox-ok', reference);
    second.send(PROMPTS.t1, 2);
    expect((await second.ended('turn-2')).outcome).toBe('completed');
    const entry = h.threads()[reference];
    expect(entry?.opens).toEqual([{ method: 'thread/start', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: null }, { method: 'thread/resume', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }]);
    // Two processes, and each turn names its own process's reply.
    expect(entry?.launches.map((launch) => launch.pid)).toHaveLength(2);
    expect(new Set(entry?.launches.map((launch) => launch.pid)).size).toBe(2);
    expect(entry?.policies).toEqual([{ approvalPolicy: 'never', sandboxPolicy: READ_ONLY, approvalsReviewer: null }, { approvalPolicy: 'on-request', sandboxPolicy: WORKSPACE, approvalsReviewer: 'user' }]);
    expect(of(second, 'in-force')).toEqual([{ type: 'in-force', mode: 'sandbox-ok' }]);
  });
});

describe('a request for leave, from its card to the CLI (V11, V21, V27; C8, C13, C21, C68, C69, C76)', () => {
  it('a command, approved once: shown whole, answered `accept`, the change made by the fake, and Codex’s word its confirmation', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    expect(raised).toMatchObject({ turnId: 'turn-1', requestId: 'n:0' });
    expect(raised.workerId).toBeUndefined();
    expect(raised.request).toMatchObject({ kind: 'command', tool: 'commandExecution', folder: h.project, targets: [], outside: false, reason: null, authority: [{ kind: 'saved-rule', mode: null }], choices: ['approve', 'deny'], grant: null, cut: false });
    expect(raised.request.detail).toEqual({ kind: 'command', command: raised.request.summary });
    expect(raised.request.summary).toContain('echo k1 > k1-once.txt');
    // The card and the action's own activity share the item.
    expect(of(session, 'activity-started').some((event) => event.itemId === raised.sourceId && event.activityType === 'command')).toBe(true);
    // Held: nothing is written until the user decides.
    expect(thread(h).replies).toBeUndefined();
    expect(inProject(h, 'k1-once.txt')).toBeNull();
    await expect(decide(session, raised.requestId, 'approve')).resolves.toBe(true);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).replies).toEqual([{ id: 0, result: { decision: 'accept' } }]);
    expect(resolutions(session)).toEqual(['approval-resolved:confirmed:n:0']);
    // The fake made the change, in its project folder and nowhere else.
    expect(inProject(h, 'k1-once.txt')).toBe('k1\n');
    expect(thread(h).changes).toEqual([{ file: 'k1-once.txt', kind: 'command' }]);
    expect(of(session, 'activity-ended').find((event) => event.itemId === raised.sourceId)).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(session.notices()).toEqual([]);
    valid(session);
  });

  it('asks again for the same command in the next turn: an approval is one use; and a Deny ends the action declined, by the user', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    await decide(session, (await nth(session, 'approval-raised')).requestId, 'approve');
    await session.ended('turn-1');
    session.send(PROMPTS.commandAgain, 2);
    const again = await nth(session, 'approval-raised', 2);
    // Codex numbers its requests for the life of its process.
    expect(again.requestId).toBe('n:1');
    expect(again.turnId).toBe('turn-2');
    await expect(decide(session, again.requestId, 'deny')).resolves.toBe(true);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    expect(thread(h).replies).toEqual([{ id: 0, result: { decision: 'accept' } }, { id: 1, result: { decision: 'decline' } }]);
    expect(of(session, 'activity-ended').find((event) => event.itemId === again.sourceId)).toEqual(expect.objectContaining({ status: 'declined', declinedBy: 'user' }));
    expect(of(session, 'activity-ended').find((event) => event.itemId === again.sourceId)).not.toHaveProperty('exitCode');
    expect(resolutions(session)).toEqual(['approval-resolved:confirmed:n:0', 'approval-resolved:confirmed:n:1']);
    // One change, the approved one's.
    expect(thread(h).changes).toHaveLength(1);
  });

  it('denies where K1 accepted, and approves where K1 declined: the reply decides, and the action’s item ends by it', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const first = await nth(session, 'approval-raised');
    await decide(session, first.requestId, 'deny');
    await session.ended('turn-1');
    expect(of(session, 'activity-ended').find((event) => event.itemId === first.sourceId)).toMatchObject({ status: 'declined', declinedBy: 'user' });
    expect(inProject(h, 'k1-once.txt')).toBeNull();
    session.send(PROMPTS.commandAgain, 2);
    const second = await nth(session, 'approval-raised', 2);
    await decide(session, second.requestId, 'approve');
    await session.ended('turn-2');
    expect(of(session, 'activity-ended').find((event) => event.itemId === second.sourceId)).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(inProject(h, 'k1-once.txt')).toBe('k1\n');
  });

  it('a file change, approved for this session: shown from the item it kept, answered `acceptForSession`, and the same file’s next change is not asked for (C21, C68, C69)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.file);
    const raised = await nth(session, 'approval-raised');
    const file = path.join(h.project, 'k1-same.txt');
    // The fake spells the capture's path with the folder it was given and the capture's own separator.
    const named = `${h.project}\\k1-same.txt`;
    expect(raised.request).toEqual({
      kind: 'file-change', tool: 'fileChange', summary: expect.stringContaining('k1-same.txt') as string, folder: null, targets: [named], outside: false, reason: null, authority: [],
      detail: { kind: 'changes', changes: [{ path: named, kind: 'add', text: 'alpha\n', replace: null, all: null }] },
      choices: ['approve', 'approve-session', 'deny'], grant: { covers: named }, modeThatWouldStop: null, cut: false,
    });
    await expect(decide(session, raised.requestId, 'approve-session')).resolves.toBe(true);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).replies).toEqual([{ id: 0, result: { decision: 'acceptForSession' } }]);
    expect(readFileSync(file, 'utf8')).toBe('alpha\n');
    // K1: a later change to the same file ran with no request, in the same process.
    session.send(PROMPTS.fileAgain, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toHaveLength(1);
    expect(thread(h).replies).toHaveLength(1);
    expect(of(session, 'activity-ended').filter((event) => event.changes !== undefined).map((event) => event.status)).toEqual(['completed', 'completed']);
    // The granted change was made, by the fake alone, in its project folder.
    expect(readFileSync(file, 'utf8')).toBe('beta\n');
    expect(thread(h).changes).toEqual([{ file: 'k1-same.txt', kind: 'add' }, { file: 'k1-same.txt', kind: 'update' }]);
    valid(session);
  });

  it('asks again for that file once the process is another: a session’s grant ends with its process, and nothing is sent again by itself (C21, C86)', async () => {
    const h = harness = await codexHarness();
    const first = start(h, 'ask-first');
    first.send(PROMPTS.file);
    await decide(first, (await nth(first, 'approval-raised')).requestId, 'approve-session');
    await first.ended('turn-1');
    const reference = first.reference() as string;
    await first.session.close();
    const second = resume(h, 'ask-first', reference);
    second.send(PROMPTS.fileAgain, 2);
    // The same change, in a fresh process: asked for, as K1's resumed process was.
    const raised = await nth(second, 'approval-raised');
    expect(raised.request).toMatchObject({ kind: 'file-change', targets: [`${h.project}\\k1-same.txt`] });
    expect(raised.request.detail).toMatchObject({ kind: 'changes', changes: [{ kind: 'update' }] });
    // Nothing was written for it until the user decided: the first process's grant was not sent again.
    expect(h.threads()[reference]?.replies).toHaveLength(1);
    await decide(second, raised.requestId, 'approve');
    expect((await second.ended('turn-2')).outcome).toBe('completed');
    expect(h.threads()[reference]?.replies).toEqual([{ id: 0, result: { decision: 'acceptForSession' } }, { id: 0, result: { decision: 'accept' } }]);
    expect(inProject(h, 'k1-same.txt')).toBe('beta\n');
  });

  it('three files, each asked for in turn: approved, denied, approved — two are made, and each item ends by its own decision (C95)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.files);
    const choices: ApprovalChoice[] = ['approve', 'deny', 'approve'];
    const items: string[] = [];
    for (const [index, choice] of choices.entries()) {
      const raised = await nth(session, 'approval-raised', index + 1);
      expect(raised.requestId).toBe(`n:${String(index)}`);
      items.push(raised.sourceId);
      await expect(decide(session, raised.requestId, choice)).resolves.toBe(true);
    }
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).replies?.map((reply) => ('result' in reply ? (reply.result as { decision: string }).decision : 'error'))).toEqual(['accept', 'decline', 'accept']);
    expect(items.map((itemId) => of(session, 'activity-ended').find((event) => event.itemId === itemId)?.status)).toEqual(['completed', 'declined', 'completed']);
    expect(thread(h).changes).toHaveLength(2);
    expect(resolutions(session)).toEqual(['approval-resolved:confirmed:n:0', 'approval-resolved:confirmed:n:1', 'approval-resolved:confirmed:n:2']);
    valid(session);
  });

  it('a worker’s request names the worker, under the turn that started it, and its decision goes to the worker’s command (C11)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.workerCommand);
    const raised = await nth(session, 'approval-raised');
    const [worker] = of(session, 'worker-started');
    expect(raised).toMatchObject({ turnId: 'turn-1', workerId: worker?.workerId, request: { kind: 'command' } });
    await expect(decide(session, raised.requestId, 'approve')).resolves.toBe(true);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'activity-ended').find((event) => event.itemId === raised.sourceId)).toMatchObject({ workerId: worker?.workerId, status: 'completed' });
    expect(inProject(h, 'k1-worker.txt')).toBe('k1\n');
  });

  it('a Stop with a request pending: the turn ends interrupted as Codex reports it, nothing is written for the request, and no change is made (C13)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    session.session.stop();
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    // The hold went with its turn: main's sweep settles the card, and a late press writes nothing.
    await expect(decide(session, raised.requestId, 'approve')).resolves.toBe(false);
    expect(thread(h).replies).toBeUndefined();
    expect(resolutions(session)).toEqual([]);
    expect(inProject(h, 'k1-once.txt')).toBeNull();
    // The process goes on: the next turn runs on it.
    session.send(PROMPTS.t1, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    expect(thread(h).launches).toHaveLength(1);
  });

  it('refuses a request main cannot place: the error reply, the notice, and the action declined', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    await expect(decide(session, raised.requestId, null)).resolves.toBe(true);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(thread(h).replies).toEqual([{ id: 0, error: NOT_FOUND }]);
    expect(session.notices()).toEqual(['request-refused']);
    // Declined, and not by the user: fat-g refused it.
    const end = of(session, 'activity-ended').find((event) => event.itemId === raised.sourceId);
    expect(end).toMatchObject({ status: 'declined' });
    expect(end).not.toHaveProperty('declinedBy');
  });
});

describe('each fault of a request for leave (V11, V27, V31; C9, C11, C22, C48, C56, C67, C68, C71, C91)', () => {
  it('approvalTwice: the same request again opens nothing more, and its one decision answers it', async () => {
    const h = harness = await codexHarness();
    h.control({ approvalTwice: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    await decide(session, raised.requestId, 'approve');
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toHaveLength(1);
    expect(codex(session).counts.approvals.repeated).toBe(1);
    expect(thread(h).replies).toHaveLength(1);
  });

  it('approvalChanged: the same id with another command is refused under that id, the first card withdrawn as changed, and nothing of the second shown (C91)', async () => {
    const h = harness = await codexHarness();
    h.control({ approvalChanged: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    await session.until((event) => event.type === 'approval-resolved');
    expect(resolutions(session)).toEqual([`approval-resolved:changed:${raised.requestId}`]);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toHaveLength(1);
    expect(thread(h).replies).toEqual([{ id: 0, error: NOT_FOUND }]);
    expect(codex(session).counts.changed).toBe(1);
    expect(JSON.stringify(session.events)).not.toContain('--changed');
    await expect(decide(session, raised.requestId, 'approve')).resolves.toBe(false);
    expect(inProject(h, 'k1-once.txt')).toBeNull();
  });

  it.each([
    ['approvalWorker', 'a thread that is no one’s'],
    ['approvalLate', 'a turn that has ended'],
  ])('%s: a request that names %s is refused on the wire, with the notice, and no card', async (fault) => {
    const h = harness = await codexHarness();
    h.control({ [fault]: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    await session.until((event) => event.type === 'notice' && event.kind === 'request-refused');
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(codex(session).counts.refused).toEqual({ 'item/commandExecution/requestApproval': 1 });
    expect(resolutions(session)).toEqual([]);
  });

  it('approvalResolvedEarly: Codex takes the request back, and its card is withdrawn with nothing written', async () => {
    const h = harness = await codexHarness();
    h.control({ approvalResolvedEarly: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(resolutions(session)).toEqual([`approval-resolved:withdrawn:${raised.requestId}`]);
    expect(thread(h).replies).toBeUndefined();
  });

  it('exitWhileApproving: a process lost with a request pending says it dropped, before the turn’s own end', async () => {
    const h = harness = await codexHarness();
    h.control({ exitWhileApproving: 1 });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'failed', failure: 'connection-lost', reported: false });
    const [raised] = of(session, 'approval-raised');
    expect(resolutions(session)).toEqual([`approval-resolved:dropped:${String(raised?.requestId)}`]);
    expect(session.types().indexOf('approval-resolved')).toBeLessThan(session.types().indexOf('turn-ended'));
    await expect(session.session.closed).resolves.toEqual({ ok: true });
  });

  // A decision's line is a few bytes, which a pipe takes whole: its write goes, and what a process
  // lost at that moment never gives is its word for it. The write a process refuses is the unit
  // test's (session.test.ts), on a scripted connection.
  it('exitAtDecision: a process lost as the decision is written took the write and never confirmed it — true, no `confirmed`, and no `dropped` for a decision that was sent (C12, C70)', async () => {
    const h = harness = await codexHarness();
    h.control({ exitAtDecision: 1 });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    await expect(decide(session, raised.requestId, 'approve')).resolves.toBe(true);
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'failed', failure: 'connection-lost', reported: false });
    await expect(session.session.closed).resolves.toEqual({ ok: true });
    // Decided and written: the process's end lets it go with no event, and nothing ever confirmed it.
    expect(resolutions(session)).toEqual([]);
    expect(codex(session).counts.approvals.unwritten).toBe(0);
    // The fake ended before it read the line: it noted no reply, and made no change.
    expect(thread(h).replies).toBeUndefined();
    expect(inProject(h, 'k1-once.txt')).toBeNull();
  });

  it('changeOverBound: a change past 1,048,576 units is refused on the wire with its size, never shown cut (C48)', async () => {
    const h = harness = await codexHarness();
    h.control({ changeOverBound: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.file);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(of(session, 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'detail', size: 1_048_577 }]);
    expect(thread(h).replies).toEqual([{ id: 0, error: NOT_FOUND }]);
    valid(session);
  });

  it('changesTwentyOne: a change of twenty-one files is one card, whole, with every file a target', async () => {
    const h = harness = await codexHarness();
    h.control({ changesTwentyOne: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.file);
    const raised = await nth(session, 'approval-raised');
    expect(raised.request.targets).toHaveLength(21);
    expect(raised.request.detail.kind === 'changes' && raised.request.detail.changes.length).toBe(21);
    expect(raised.request.cut).toBe(false);
    await decide(session, raised.requestId, 'deny');
    await session.ended('turn-1');
  });

  it('requestOverLine: a request in a line over the limit is refused by the id read from it, with the line’s size, and the turn goes on (C67)', async () => {
    const h = harness = await codexHarness();
    h.control({ requestOverLine: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    expect(await session.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    const [notice] = of(session, 'notice');
    expect(notice).toMatchObject({ kind: 'request-refused', turnId: 'turn-1', bound: 'line' });
    expect(notice?.size).toBeGreaterThan(4 * 1024 * 1024);
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(thread(h).replies).toEqual([{ id: 0, error: NOT_FOUND }]);
    expect(codex(session).counts.oversized).toEqual({ refused: 1, stopped: 0 });
    expect(thread(h).interrupts).toEqual([]);
    valid(session);
  });

  it('requestOverLineNoId: where the id cannot be read, the turn is stopped with the notice, and nothing is left waiting (C71)', async () => {
    const h = harness = await codexHarness();
    h.control({ requestOverLineNoId: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    expect(await session.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    const [notice] = of(session, 'notice');
    expect(notice).toMatchObject({ kind: 'line-too-long', turnId: 'turn-1' });
    expect(notice?.size).toBeGreaterThan(4 * 1024 * 1024);
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(thread(h).replies).toBeUndefined();
    expect(thread(h).interrupts).toEqual([{ inputOpen: true, worker: false }]);
    expect(codex(session).counts.oversized).toEqual({ refused: 0, stopped: 1 });
    // The process was not closed for the line: the next turn runs on it.
    h.control({});
    session.send(PROMPTS.t1, 2);
    expect((await session.ended('turn-2')).outcome).toBe('completed');
    expect(thread(h).launches).toHaveLength(1);
  });

  it('fileChangeUnheld: a file change’s request that names an item never started is refused, and nothing is read from disk to fill it (C9)', async () => {
    const h = harness = await codexHarness();
    h.control({ fileChangeUnheld: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.file);
    expect((await session.ended('turn-1')).outcome).toBe('completed');
    expect(of(session, 'approval-raised')).toEqual([]);
    expect(of(session, 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    expect(thread(h).replies).toEqual([{ id: 0, error: NOT_FOUND }]);
  });

  it('grantRootNamed: a file change that asks for a root gets no session grant, the root told as a folder it would grant (C56, C68)', async () => {
    const h = harness = await codexHarness();
    h.control({ grantRootNamed: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.file);
    const raised = await nth(session, 'approval-raised');
    expect(raised.request).toMatchObject({ choices: ['approve', 'deny'], grant: null, authority: [{ kind: 'folder', mode: null }] });
    // A choice the view does not list is never written: refused, with the error reply.
    await expect(decide(session, raised.requestId, 'approve-session')).resolves.toBe(true);
    await session.ended('turn-1');
    expect(thread(h).replies).toEqual([{ id: 0, error: NOT_FOUND }]);
  });

  it('commandForSession: a command whose own list holds the session’s decision offers the grant by its command, and writes `acceptForSession` (C68)', async () => {
    const h = harness = await codexHarness();
    h.control({ commandForSession: true });
    const session = start(h, 'ask-first');
    session.send(PROMPTS.command);
    const raised = await nth(session, 'approval-raised');
    expect(raised.request).toMatchObject({ choices: ['approve', 'approve-session', 'deny'], grant: { covers: raised.request.summary } });
    // Codex's amendment stays an authority it would grant, and is still no choice (C22).
    expect(raised.request.authority).toEqual([{ kind: 'saved-rule', mode: null }]);
    await decide(session, raised.requestId, 'approve-session');
    await session.ended('turn-1');
    expect(thread(h).replies).toEqual([{ id: 0, result: { decision: 'acceptForSession' } }]);
  });

  it('never writes Codex’s amendment, whatever is decided: every reply is one of three decisions, or the error (C22)', async () => {
    const h = harness = await codexHarness();
    const session = start(h, 'ask-first');
    for (const [index, [prompt, choice]] of ([[PROMPTS.command, 'approve'], [PROMPTS.commandAgain, 'deny'], [PROMPTS.file, 'approve-session'], [PROMPTS.command, null]] as const).entries()) {
      session.send(prompt, index + 1);
      await decide(session, (await nth(session, 'approval-raised', index + 1)).requestId, choice);
      await session.ended(`turn-${String(index + 1)}`);
    }
    const sent = JSON.stringify(thread(h).replies);
    expect(thread(h).replies).toHaveLength(4);
    expect(sent).not.toMatch(/Amendment|execpolicy|grantRoot|cancel/i);
    expect(thread(h).replies?.map((reply) => ('result' in reply ? reply.result : reply.error))).toEqual([{ decision: 'accept' }, { decision: 'decline' }, { decision: 'acceptForSession' }, NOT_FOUND]);
  });
});
