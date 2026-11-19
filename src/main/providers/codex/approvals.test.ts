// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V27, the adapter's part (docs/planning/_archive/M22.md, Design 4, 5, 7; C8, C9, C21, C22, C48, C56,
// C68, C69): Codex's two requests for leave as the one view a card shows, on the requests K1, K4 and
// K6 captured — the whole action, its targets, what its offers would grant, and its choices — and
// each choice as Codex's own decision. One that cannot be shown whole is refused, with the bound.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalRequestSchema, MAX_APPROVAL_CHANGE_UNITS, MAX_APPROVAL_DETAIL, MAX_APPROVAL_PATH, MAX_APPROVAL_REASON, MAX_APPROVAL_SUMMARY, MAX_APPROVAL_TARGETS, MAX_GRANT_COVERS, storedRequest } from '@shared/contracts/interaction';
import { buildApproval, buildMcpApproval, decisionOf, elicitationOf } from './approvals';
import { COMMAND_APPROVAL, FILE_APPROVAL, MCP_ELICITATION } from './methods';
import { isMcpApproval, type RawChange, type RawMcpCall, takeApprovalRequest, takeFileChange, type TakenCommandApproval, type TakenFileApproval, type TakenMcpApproval, takeMcpCall } from './session-schemas';

/** The two requests that name their item: an MCP tool's has tests of its own below. */
type TakenApproval = TakenCommandApproval | TakenFileApproval;
interface Frame { readonly index: number; readonly dir: 'send' | 'recv'; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown } }
const frames = (name: string): Frame[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: Frame[] }).frames;
/** A capture's `nth` request for leave, as it came, with the changes of the item it names where that item is a file change. */
function asked(name: string, nth = 0): { method: string; params: Record<string, unknown>; taken: TakenApproval; changes: readonly RawChange[] | undefined; answer: unknown } {
  const all = frames(name);
  const request = all.filter((f) => f.dir === 'recv' && (f.frame.method === COMMAND_APPROVAL || f.frame.method === FILE_APPROVAL))[nth];
  if (request?.frame.method === undefined || request.frame.params === undefined) throw new Error(`${name} has no such request`);
  const taken = takeApprovalRequest(request.frame.method, request.frame.params);
  if (taken === null || taken.kind === 'mcp-tool') throw new Error(`${name}: the request was not taken`);
  const item = all.flatMap((f) => (f.dir === 'recv' && f.index < request.index && f.frame.method === 'item/started' ? [takeFileChange(f.frame.params)] : [])).find((change) => change?.itemId === taken.itemId);
  const answer = all.find((f) => f.dir === 'send' && f.index > request.index && f.frame.method === undefined && f.frame.id === request.frame.id)?.frame.result;
  return { method: request.frame.method, params: request.frame.params, taken, changes: item?.changes, answer };
}
const view = (name: string, nth = 0) => { const { taken, changes } = asked(name, nth); const built = buildApproval(taken, changes); if (!built.ok) throw new Error(`${name}: refused`); return built.request; };

describe('a command’s request (V3; C8, C9, C22, C68)', () => {
  const once = asked('m22-codex-once');

  it('reads K1’s request as it came: whose it is, the whole invocation, its folder, and what its decisions offer', () => {
    expect(Object.keys(once.params).sort()).toEqual(['availableDecisions', 'command', 'commandActions', 'cwd', 'environmentId', 'itemId', 'kind', 'proposedExecpolicyAmendment', 'startedAtMs', 'threadId', 'turnId']);
    expect(once.taken).toEqual({ kind: 'command', threadId: '<session-1>', turnId: '<turn-3>', itemId: '<item-6>', reason: null, command: once.params['command'], cwd: '<scratch>', paths: [], forSession: false, authority: ['saved-rule'] });
    // K1's list every time: the one use, Codex's amendment to its own rules, and a cancel. No session grant, and no decline.
    expect((once.params['availableDecisions'] as unknown[]).map((decision) => (typeof decision === 'string' ? decision : Object.keys(decision as object)[0]))).toEqual(['accept', 'acceptWithExecpolicyAmendment', 'cancel']);
  });

  it('shows the whole command, its first line as the summary, and the folder it runs in', () => {
    const request = view('m22-codex-once');
    expect(request).toEqual({
      kind: 'command', tool: 'commandExecution', summary: once.params['command'], folder: '<scratch>', targets: [], outside: false, reason: null,
      authority: [{ kind: 'saved-rule', mode: null }], detail: { kind: 'command', command: once.params['command'] },
      choices: ['approve', 'deny'], grant: null, modeThatWouldStop: null, cut: false,
    });
    expect(String(once.params['command'])).toContain('echo k1 > k1-once.txt');
    expect(ApprovalRequestSchema.safeParse(request).success).toBe(true);
  });

  it('tells Codex’s amendment as an authority the request offers, and never lists it among the choices (C22, C56)', () => {
    for (const name of ['m22-codex-once', 'm22-codex-amendment', 'm22-codex-on-request', 'm22-codex-worker', 'm22-codex-sandbox-ask-write', 't7-declined']) {
      const request = view(name);
      expect(request.authority, name).toEqual([{ kind: 'saved-rule', mode: null }]);
      expect(request.choices, name).toEqual(['approve', 'deny']);
      expect(request.grant, name).toBeNull();
    }
  });

  it('offers the session’s grant only where the request’s own list holds it, worded by the command (C68)', () => {
    const listed = takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, availableDecisions: ['accept', 'acceptForSession', 'cancel'] }) as TakenApproval;
    const built = buildApproval(listed, undefined);
    expect(built.ok && built.request).toMatchObject({ choices: ['approve', 'approve-session', 'deny'], grant: { covers: once.params['command'] }, authority: [] });
    // A command too long to word a grant by is offered none: a grant is never worded by a cut text.
    const long = `echo ${'x'.repeat(MAX_GRANT_COVERS)}`;
    const cut = buildApproval(takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, command: long, availableDecisions: ['accept', 'acceptForSession'] }) as TakenApproval, undefined);
    expect(cut.ok && cut.request).toMatchObject({ choices: ['approve', 'deny'], grant: null, detail: { kind: 'command', command: long } });
  });

  it('reads what a decision would grant by its name alone: a saved rule, the network, or more than fat-g knows', () => {
    const authority = (availableDecisions: unknown, extra: Record<string, unknown> = {}) => (takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, proposedExecpolicyAmendment: null, ...extra, availableDecisions }) as Extract<TakenApproval, { kind: 'command' }>).authority;
    expect(authority(['accept', 'decline', 'cancel', 'acceptForSession'])).toEqual([]);
    expect(authority(['accept', { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.test', action: 'allow' } } }])).toEqual(['network']);
    expect(authority(['accept', 'somethingNew', { somethingElse: {} }, {}, 7])).toEqual(['other']);
    // With no list, what the request proposes is what it would offer.
    expect(authority(null, { proposedExecpolicyAmendment: ['echo'] })).toEqual(['saved-rule']);
    expect(authority(undefined, { proposedNetworkPolicyAmendments: [{ host: 'example.test', action: 'allow' }] })).toEqual(['network']);
    expect(authority(null)).toEqual([]);
  });

  it('lists the paths Codex read out of the command line, and carries the model’s reason, labelled the model’s by the page', () => {
    const taken = takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, reason: 'It writes the marker file.', commandActions: [{ type: 'read', name: 'a.txt', path: 'src/a.txt' }, { type: 'unknown', command: 'x' }, { type: 'read', path: '' }] }) as TakenApproval;
    const built = buildApproval(taken, undefined);
    expect(built.ok && built.request).toMatchObject({ targets: ['src/a.txt'], reason: 'It writes the marker file.' });
    const long = buildApproval(takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, reason: 'r'.repeat(MAX_APPROVAL_REASON + 50), command: `first line ${'s'.repeat(MAX_APPROVAL_SUMMARY)}\nsecond line` }) as TakenApproval, undefined);
    // A label is cut; the action itself never is.
    expect(long.ok && long.request.reason).toHaveLength(MAX_APPROVAL_REASON);
    expect(long.ok && long.request.summary).toHaveLength(MAX_APPROVAL_SUMMARY);
    expect(long.ok && long.request.detail).toEqual({ kind: 'command', command: `first line ${'s'.repeat(MAX_APPROVAL_SUMMARY)}\nsecond line` });
  });

  it('refuses one that names no command — a request for something else, which fat-g does not show — and one that is no such request (C9)', () => {
    for (const command of [undefined, null, '', '   ']) {
      const taken = takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, command });
      expect(taken === null ? { ok: false, over: null } : buildApproval(taken as TakenApproval, undefined), String(command)).toEqual({ ok: false, over: null });
    }
    for (const params of [null, 'x', {}, { ...once.params, threadId: '' }, { ...once.params, itemId: 7 }, { ...once.params, turnId: 'a\nb' }]) expect(takeApprovalRequest(COMMAND_APPROVAL, params)).toBeNull();
    expect(takeApprovalRequest('item/permissions/requestApproval', once.params)).toBeNull();
  });

  it('refuses a command past its bound, or with more targets or a longer path than a card takes, naming the size; never shows it cut (C9, C48)', () => {
    const built = (extra: Record<string, unknown>) => buildApproval(takeApprovalRequest(COMMAND_APPROVAL, { ...once.params, ...extra }) as TakenApproval, undefined);
    expect(built({ command: 'c'.repeat(MAX_APPROVAL_DETAIL) }).ok).toBe(true);
    expect(built({ command: 'c'.repeat(MAX_APPROVAL_DETAIL + 1) })).toEqual({ ok: false, over: { bound: 'detail', size: MAX_APPROVAL_DETAIL + 1 } });
    expect(built({ commandActions: Array.from({ length: MAX_APPROVAL_TARGETS + 1 }, (_, n) => ({ path: `file-${String(n)}` })) })).toEqual({ ok: false, over: { bound: 'targets', size: MAX_APPROVAL_TARGETS + 1 } });
    expect(built({ cwd: 'd'.repeat(MAX_APPROVAL_PATH + 1) })).toEqual({ ok: false, over: { bound: 'path', size: MAX_APPROVAL_PATH + 1 } });
    expect(built({ commandActions: [{ path: 'p'.repeat(MAX_APPROVAL_PATH + 7) }] })).toEqual({ ok: false, over: { bound: 'path', size: MAX_APPROVAL_PATH + 7 } });
  });
});

describe('a file change’s request (V3, V27; C8, C9, C21, C48, C68)', () => {
  const same = asked('m22-codex-file-session-same-main');

  it('names no file: K1’s holds the item, a null reason and a null root, and no list of decisions', () => {
    expect(Object.keys(same.params).sort()).toEqual(['grantRoot', 'itemId', 'reason', 'startedAtMs', 'threadId', 'turnId']);
    expect(same.taken).toEqual({ kind: 'file-change', threadId: '<session-1>', turnId: '<turn-3>', itemId: '<item-6>', reason: null, grantRoot: false });
    // The change is in the item started just before it.
    expect(same.changes).toEqual([{ path: '<scratch>\\k1-same.txt', kind: 'add', diff: 'alpha\n' }]);
  });

  it('shows the item’s changes whole, each with its path, its kind and its diff, and offers the session’s grant by the file (C21, C56, C68)', () => {
    const request = view('m22-codex-file-session-same-main');
    expect(request).toEqual({
      kind: 'file-change', tool: 'fileChange', summary: 'k1-same.txt', folder: null, targets: ['<scratch>\\k1-same.txt'], outside: false, reason: null, authority: [],
      // Codex gives a new file's content, or a diff: no change of its is an edit by match.
      detail: { kind: 'changes', changes: [{ path: '<scratch>\\k1-same.txt', kind: 'add', text: 'alpha\n', replace: null, all: null }] },
      choices: ['approve', 'approve-session', 'deny'], grant: { covers: '<scratch>\\k1-same.txt' }, modeThatWouldStop: null, cut: false,
    });
    expect(ApprovalRequestSchema.safeParse(request).success).toBe(true);
    // K1 answered it with the session's own decision.
    expect(same.answer).toEqual(decisionOf('approve-session'));
  });

  it('builds a card from every file change request the captures hold', () => {
    const names = ['m22-codex-files', 'm22-codex-ask-first-files', 'm22-codex-sandbox-files', 'm22-codex-reviewer-turn-main', 'm22-codex-auto-review-resumed', 'm22-codex-file-session-main', 'm22-codex-file-session-resumed', 'm22-codex-file-session-same-resumed', 'm22-codex-on-request'];
    let seen = 0;
    for (const name of names) {
      const requests = frames(name).filter((f) => f.dir === 'recv' && f.frame.method === FILE_APPROVAL).length;
      for (let nth = 0; nth < frames(name).filter((f) => f.dir === 'recv' && (f.frame.method === FILE_APPROVAL || f.frame.method === COMMAND_APPROVAL)).length; nth++) {
        const request = view(name, nth);
        if (request.kind !== 'file-change') continue;
        seen += 1;
        expect(request.detail.kind === 'changes' && request.detail.changes.length, name).toBe(1);
        expect(request.grant?.covers, name).toBe(request.targets[0]);
      }
      expect(requests, name).toBeGreaterThan(0);
    }
    expect(seen).toBeGreaterThanOrEqual(14);
  });

  it('words several files’ change by the first and how many more, and its grant by every path', () => {
    const changes: RawChange[] = [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b\n' }, { path: 'notes/new.md', kind: 'add', diff: 'hello' }, { path: 'gone.txt', kind: 'delete', diff: null }];
    const built = buildApproval(same.taken, changes);
    expect(built.ok && built.request).toMatchObject({
      summary: 'a.ts and 2 more', targets: ['src/a.ts', 'notes/new.md', 'gone.txt'], grant: { covers: 'src/a.ts, notes/new.md, gone.txt' },
      detail: { kind: 'changes', changes: [{ path: 'src/a.ts', kind: 'update', text: '@@ -1 +1 @@\n-a\n+b\n', replace: null, all: null }, { path: 'notes/new.md', kind: 'add', text: 'hello', replace: null, all: null }, { path: 'gone.txt', kind: 'delete', text: null, replace: null, all: null }] },
    });
  });

  it('makes no session grant of a request that asks for a root: said as a folder it would grant (C56, C68)', () => {
    const rooted = takeApprovalRequest(FILE_APPROVAL, { ...same.params, grantRoot: 'C:\\work' }) as TakenApproval;
    expect(rooted).toMatchObject({ grantRoot: true });
    const built = buildApproval(rooted, same.changes);
    expect(built.ok && built.request).toMatchObject({ choices: ['approve', 'deny'], grant: null, authority: [{ kind: 'folder', mode: null }] });
    // The root itself is no part of what is shown or sent back.
    expect(JSON.stringify(built)).not.toContain('C:\\\\work');
  });

  it('refuses one whose item the session does not hold, or holds with no change: nothing is read from disk to fill it (C9)', () => {
    expect(buildApproval(same.taken, undefined)).toEqual({ ok: false, over: null });
    expect(buildApproval(same.taken, [])).toEqual({ ok: false, over: null });
    expect(buildApproval(same.taken, [{ path: '', kind: 'add', diff: 'x' }])).toEqual({ ok: false, over: null });
  });

  it('shows a change whole up to 1,048,576 units, and refuses one past it with its size; never cut (C48)', () => {
    const half = 'x'.repeat(MAX_APPROVAL_CHANGE_UNITS / 2);
    const whole = buildApproval(same.taken, [{ path: 'a.txt', kind: 'add', diff: half }, { path: 'b.txt', kind: 'add', diff: half }]);
    expect(whole.ok && whole.request.detail.kind === 'changes' && whole.request.detail.changes.map((change) => change.text?.length)).toEqual([half.length, half.length]);
    expect(whole.ok && whole.request.cut).toBe(false);
    // What the store keeps of it is cut, and says so (C48): that is main's, from the same view.
    expect(whole.ok && storedRequest(whole.request).cut).toBe(true);
    expect(buildApproval(same.taken, [{ path: 'a.txt', kind: 'add', diff: half }, { path: 'b.txt', kind: 'add', diff: `${half}!` }])).toEqual({ ok: false, over: { bound: 'detail', size: MAX_APPROVAL_CHANGE_UNITS + 1 } });
    expect(buildApproval(same.taken, Array.from({ length: MAX_APPROVAL_TARGETS + 1 }, (_, n): RawChange => ({ path: `f${String(n)}.txt`, kind: 'add', diff: 'x' })))).toEqual({ ok: false, over: { bound: 'targets', size: MAX_APPROVAL_TARGETS + 1 } });
    expect(buildApproval(same.taken, [{ path: 'p'.repeat(MAX_APPROVAL_PATH + 1), kind: 'add', diff: 'x' }])).toEqual({ ok: false, over: { bound: 'path', size: MAX_APPROVAL_PATH + 1 } });
  });

  it('offers no grant where the paths would not fit their words whole, and still shows the change', () => {
    const changes = Array.from({ length: 3 }, (_, n): RawChange => ({ path: `${'d'.repeat(900)}/${String(n)}.txt`, kind: 'add', diff: 'x' }));
    const built = buildApproval(same.taken, changes);
    expect(built.ok && built.request).toMatchObject({ choices: ['approve', 'deny'], grant: null });
  });

  it('reads a `fileChange` item’s changes from its start frame alone, uncut, and nothing from any other item', () => {
    const big = 'd'.repeat(300_000);
    expect(takeFileChange({ threadId: 't', turnId: 'u', item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: 'a', kind: { type: 'update', move_path: null }, diff: big }, { path: 'b', kind: 'add' }, { path: 'c', kind: { type: 'rename' }, diff: null }] } }))
      .toEqual({ threadId: 't', itemId: 'f1', changes: [{ path: 'a', kind: 'update', diff: big }, { path: 'b', kind: 'add', diff: null }, { path: 'c', kind: 'other', diff: null }] });
    expect(takeFileChange({ threadId: 't', item: { type: 'fileChange', id: 'f2' } })).toEqual({ threadId: 't', itemId: 'f2', changes: [] });
    for (const params of [null, { threadId: 't', item: { type: 'commandExecution', id: 'c1' } }, { threadId: 't', item: { type: 'fileChange' } }, { item: { type: 'fileChange', id: 'f3' } }]) expect(takeFileChange(params)).toBeNull();
  });
});

describe('a choice, as Codex’s decision (V27; C13, C22, C69)', () => {
  it('writes exactly three decisions, fixed by the choice: the one use, the session’s own, and a decline', () => {
    expect(decisionOf('approve')).toEqual({ decision: 'accept' });
    expect(decisionOf('approve-session')).toEqual({ decision: 'acceptForSession' });
    expect(decisionOf('deny')).toEqual({ decision: 'decline' });
    // As K1 sent them, frame for frame.
    expect(asked('m22-codex-once', 0).answer).toEqual(decisionOf('approve'));
    expect(asked('m22-codex-once', 1).answer).toEqual(decisionOf('deny'));
    // Nothing of a rule Codex would save, a root or a cancel can be written from a choice.
    for (const choice of ['approve', 'approve-session', 'deny'] as const) expect(Object.keys(decisionOf(choice))).toEqual(['decision']);
  });
});

// Decision 0018: Codex's leave to run an MCP tool, on spikes/codex-mcp's captures (codex-cli 0.164.0).
describe('an MCP tool’s request (decision 0018)', () => {
  /** A capture's `nth` such request, as it came, and the call it is placed on: the started call with its server and arguments. */
  function mcpAsked(name: string, nth = 0): { params: Record<string, unknown>; taken: TakenMcpApproval; call: RawMcpCall; answer: unknown } {
    const all = frames(name);
    const request = all.filter((f) => f.dir === 'recv' && f.frame.method === MCP_ELICITATION)[nth];
    if (request?.frame.params === undefined) throw new Error(`${name} has no such request`);
    const taken = takeApprovalRequest(MCP_ELICITATION, request.frame.params);
    if (taken?.kind !== 'mcp-tool') throw new Error(`${name}: the request was not taken`);
    const call = all.flatMap((f) => (f.dir === 'recv' && f.index < request.index && f.frame.method === 'item/started' ? [takeMcpCall(f.frame.params)] : [])).filter((started) => started !== null).at(-1);
    if (call === undefined || call === null) throw new Error(`${name}: no call started before the request`);
    const answer = all.find((f) => f.dir === 'send' && f.index > request.index && f.frame.method === undefined && f.frame.id === request.frame.id)?.frame.result;
    return { params: request.frame.params, taken, call, answer };
  }
  const once = mcpAsked('codex-mcp-approval-once');

  it('reads K1’s request as it came: an elicitation of the approval kind that names its server and the arguments, never the item', () => {
    expect(Object.keys(once.params).sort()).toEqual(['_meta', 'message', 'mode', 'requestedSchema', 'serverName', 'threadId', 'turnId']);
    expect(isMcpApproval(once.params)).toBe(true);
    expect(once.taken).toEqual({ kind: 'mcp-tool', threadId: once.params['threadId'], turnId: once.params['turnId'], server: once.params['serverName'], params: { label: 'first' }, forSession: true, authority: ['saved-rule'] });
    expect(once.call).toMatchObject({ server: once.taken.server, tool: 'stamp', arguments: { label: 'first' } });
  });

  it('shows the server and tool as its activity names them, the arguments whole, and the session’s grant by that tool; `always` told, never a choice', () => {
    const built = buildMcpApproval(once.taken, once.call);
    expect(built).toEqual({
      ok: true,
      request: {
        kind: 'tool', tool: 'mcpToolCall', summary: `${once.taken.server}: stamp`, folder: null, targets: [], outside: false, reason: null, authority: [{ kind: 'saved-rule', mode: null }],
        detail: { kind: 'input', text: JSON.stringify({ label: 'first' }, null, 2) }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: `${once.taken.server}: stamp` }, modeThatWouldStop: null, cut: false,
      },
    });
    expect(built.ok && ApprovalRequestSchema.safeParse(built.request).success).toBe(true);
  });

  it('refuses arguments it cannot write out, and names the bound arguments past it are over', () => {
    expect(buildMcpApproval({ ...once.taken, params: { n: 1n } }, once.call)).toEqual({ ok: false, over: null });
    expect(buildMcpApproval({ ...once.taken, params: { text: 'x'.repeat(MAX_APPROVAL_DETAIL) } }, once.call)).toMatchObject({ ok: false, over: { bound: 'detail' } });
  });

  it('writes each choice as the elicitation’s answer K1 sent, and never `always`', () => {
    expect(once.answer).toEqual(elicitationOf('approve'));
    expect(mcpAsked('codex-mcp-approval-session').answer).toEqual(elicitationOf('approve-session'));
    expect(mcpAsked('codex-mcp-approval-deny').answer).toEqual(elicitationOf('deny'));
    for (const choice of ['approve', 'approve-session', 'deny'] as const) expect(JSON.stringify(elicitationOf(choice))).not.toContain('always');
  });

  it('takes no other elicitation: an MCP server’s own form is no request for leave', () => {
    const form = frames('codex-mcp-server-form').find((f) => f.dir === 'recv' && f.frame.method === MCP_ELICITATION)?.frame.params;
    expect(isMcpApproval(form)).toBe(false);
    expect(takeApprovalRequest(MCP_ELICITATION, form)).toBeNull();
    // One of the approval kind that names no turn cannot be placed, and is not taken.
    expect(isMcpApproval({ ...once.params, turnId: null })).toBe(true);
    expect(takeApprovalRequest(MCP_ELICITATION, { ...once.params, turnId: null })).toBeNull();
    expect(takeMcpCall({ threadId: 't', item: { type: 'commandExecution', id: 'i' } })).toBeNull();
  });
});
