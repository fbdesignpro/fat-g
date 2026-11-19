// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V11, V20, V27, V30, V31, V34 and the adapter's part of V3 (docs/planning/_archive/M22.md, Design 6, 8, 11;
// C5–C8, C11–C13, C21, C22, C45–C47, C67–C69, C71, C74, C76, C90, C91): a Claude chat session under a
// mode, on the real adapter and process layer against the replay fake — the launch each mode gets
// and what confirms it, the one change the CLI makes on a live process, a request to act and its
// decisions, the session grant and its end, and a line over the limit. The requests are K2's own,
// as tests/fixtures/claude/captures/ holds them, and a fault is a captured frame with one named
// change (tests/fixtures/claude/replay.mjs). Every wait is on an event of the session's, or on what
// the fake noted of what it was sent. What main does with these events is tests/sessions/'s.
//
// Its last part runs K5's captures (round 3), each under the mode it was taken under: the turns
// Auto reviewed, Berserk and Edits ok let run with no request, and the resumes of a session that
// was launched under Berserk.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import { chatFixedArgs } from '../../../src/main/providers/claude/chat-launch';
import { CLAUDE_MODE_IDS, CLAUDE_MODES, claudeModeAvailability } from '../../../src/main/providers/claude/chat-modes';
import type { ClaudeChatSession } from '../../../src/main/providers/claude/chat-session';
import { DENY_MESSAGE, USER_DENY_MESSAGE } from '../../../src/main/providers/claude/chat-wire';
import { claudeHarness, eventually, type Harness, type HarnessOptions, processGone, under, watch, type Watched } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness, mode = 'ask-first') => watch(h.facet.start(under(h, mode)));
const resume = (h: Harness, reference: string, mode = 'ask-first') => watch(h.facet.resume({ ...under(h, mode), reference }));
const claude = (s: Watched): ClaudeChatSession => s.session as ClaudeChatSession;
const of = <T extends AgentEvent['type']>(s: Watched, type: T): Extract<AgentEvent, { type: T }>[] => s.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
const valid = (s: Watched): void => { for (const event of s.events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 160)).toBe(true); };
/** The session's nth request to act, once it has been raised. */
const raised = async (s: Watched, nth = 1): Promise<Extract<AgentEvent, { type: 'approval-raised' }>> => {
  await s.until(() => of(s, 'approval-raised').length >= nth);
  return of(s, 'approval-raised')[nth - 1] as Extract<AgentEvent, { type: 'approval-raised' }>;
};
const resolved = (s: Watched, requestId: string, reason: string) => s.until((event) => event.type === 'approval-resolved' && event.requestId === requestId && event.reason === reason);
/** A file in the session's folder as the captures name one: with the separator they were taken with, on every system. */
const named = (h: Harness, name: string): string => `${h.project}\\${name}`;
const made = (h: Harness, name: string): string | null => (existsSync(path.join(h.project, name)) ? readFileSync(path.join(h.project, name), 'utf8') : null);
/** The activity a tool use opened, and how it ended. */
const activity = (s: Watched, itemId: string) => ({ started: of(s, 'activity-started').find((event) => event.itemId === itemId), ended: of(s, 'activity-ended').find((event) => event.itemId === itemId) });
const SESSION_RULE = (command: string) => ({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: command }], behavior: 'allow', destination: 'session' });

describe('the launch each mode gets, and what confirms it (V2, V34; C5, C45, C47)', () => {
  it('starts each mode’s process with its own permission mode and tools and no other flag, and confirms the mode by fat-g’s id before the turn', async () => {
    const h = await open();
    for (const [n, id] of CLAUDE_MODE_IDS.entries()) {
      const s = start(h, id);
      s.send(h.prompts.t1);
      expect(await s.ended('turn-1'), id).toMatchObject({ outcome: 'completed', reported: true });
      const launch = Object.values(h.sessions())[n]?.launches[0];
      expect(launch?.args, id).toEqual([...chatFixedArgs(CLAUDE_MODES[id]), '--model', 'sonnet', '--effort', 'low']);
      expect([launch?.mode, launch?.tools], id).toEqual([CLAUDE_MODES[id].native, [...CLAUDE_MODES[id].tools]]);
      expect(launch?.args.filter((arg) => /skip-permissions/.test(arg)), id).toEqual([]);
      // Confirmed once, from the launch's reply: the mode's id, and never the CLI's word.
      expect(s.confirmed, id).toEqual([id]);
      expect(JSON.stringify(s.events), id).not.toMatch(/acceptEdits|bypassPermissions/);
      valid(s);
      await s.session.close();
    }
    expect(h.markers()).toEqual([]);
  });

  it('is what the facet and the descriptor say: five modes, each usable, the three changes the CLI makes on a live process, and no set-up step', async () => {
    const h = await open();
    const declared = h.provider.descriptor.capabilities.permissions;
    expect(declared?.modes.map((mode) => mode.id)).toEqual([...CLAUDE_MODE_IDS]);
    // The fallback for a chat nothing chose a mode for: Auto reviewed (decision 0027, item 7).
    expect([declared?.fallback, declared?.setup]).toEqual(['auto-reviewed', null]);
    expect(h.facet.modes?.()).toEqual(claudeModeAvailability());
    expect(h.facet.modes?.().every((mode) => mode.available)).toBe(true);
    expect([h.facet.transition?.('ask-first', 'edits-ok'), h.facet.transition?.('ask-first', 'read-only'), h.facet.transition?.('berserk', 'ask-first')]).toEqual(['idle', 'restart', 'restart']);
    expect(h.facet.sandbox).toBeUndefined();
  });

  it('fails the start and sends nothing when the launch’s reply reports another policy than the mode’s, with the word it reported (C46)', async () => {
    const h = await open();
    h.control({ otherMode: 'reply' });
    for (const [n, [id, reported]] of ([['ask-first', 'acceptEdits'], ['edits-ok', 'default'], ['berserk', 'acceptEdits']] as const).entries()) {
      const s = start(h, id);
      s.send(h.prompts.t1);
      expect(await s.ended('turn-1'), id).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' });
      expect(of(s, 'notice'), id).toEqual([{ type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail: reported }]);
      expect(s.confirmed, id).toEqual([]);
      await processGone(h, s.session);
      // The process was started, and no prompt reached it.
      expect(Object.values(h.sessions())[n]?.turns, id).toEqual([]);
    }
  });

  it('ends the process as overruled when a turn’s `init` names another mode than the one in force (C5, C7)', async () => {
    const h = await open();
    h.control({ initOtherMode: 1 });
    const s = start(h, 'edits-ok');
    s.send(h.prompts.t1);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-overruled' });
    expect(s.notices()).toEqual(['start-overruled']);
    expect(s.confirmed).toEqual(['edits-ok']);
    await processGone(h, s.session);
  });
});

describe('a command, approved once and then denied (V11, V27; C8, C12, C13, C76)', () => {
  it('raises K2’s request as its card’s view, runs the command at Approve once, and asks again for the same command in the next turn', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.approve);
    const first = await raised(s);
    expect(first).toEqual({
      type: 'approval-raised', turnId: 'turn-1', requestId: first.requestId, sourceId: first.sourceId,
      request: {
        kind: 'command', tool: 'Bash', summary: 'touch bash-once.txt', folder: null, targets: [named(h, 'bash-once.txt')], outside: false, reason: 'Create empty file bash-once.txt',
        // The rule as the CLI offered it would be saved; a folder and a mode it offered beside it are never sent.
        authority: [{ kind: 'saved-rule', mode: null }, { kind: 'folder', mode: null }, { kind: 'mode', mode: 'edits-ok' }],
        detail: { kind: 'command', command: 'touch bash-once.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'touch bash-once.txt' }, modeThatWouldStop: null, cut: false,
      },
    });
    // The action's own activity stands under the same tool use, and nothing has run: no decision was made.
    expect(activity(s, first.sourceId)).toMatchObject({ started: { activityType: 'command', summary: 'touch bash-once.txt' }, ended: undefined });
    expect([made(h, 'bash-once.txt'), h.only().entry.answers]).toEqual([null, []]);

    await expect(claude(s).decide(first.requestId, 'approve')).resolves.toBe(true);
    await resolved(s, first.requestId, 'confirmed');
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    // The input as it came, and nothing beside it: no rule, no mode, no folder.
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'allow', message: null, error: null, updatedInput: { command: 'touch bash-once.txt', description: 'Create empty file bash-once.txt' } }]);
    expect(activity(s, first.sourceId).ended).toMatchObject({ status: 'completed' });
    // The fake made the file, in its project and nowhere else.
    expect(made(h, 'bash-once.txt')).toBe('');
    expect(h.only().entry.grants).toEqual([]);

    // Leave given once is one use (K2): the same command asks again.
    s.send(h.prompts.approveAgain, 2);
    const second = await raised(s, 2);
    expect(second).toMatchObject({ turnId: 'turn-2', request: first.request });
    expect(second.requestId).not.toBe(first.requestId);
    await expect(claude(s).decide(second.requestId, 'deny')).resolves.toBe(true);
    await resolved(s, second.requestId, 'confirmed');
    // Denied in the user's name: the action's activity ends declined by them, not failed, and the turn goes on to its own end (C13, C76).
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    expect(activity(s, second.sourceId).ended).toMatchObject({ status: 'declined', declinedBy: 'user', output: USER_DENY_MESSAGE });
    expect(h.only().entry.answers[1]).toEqual({ subtype: 'success', behavior: 'deny', message: USER_DENY_MESSAGE, error: null });
    valid(s);
    expect(s.notices()).toEqual([]);
    expect(h.markers()).toEqual([]);
    // Nothing was answered but at the user's word: two requests, two decisions.
    expect(h.only().entry.answers).toHaveLength(2);
  });

  it('refuses the request under the reading mode, as before there were modes: denied in fat-g’s words, the notice, no card, no file', async () => {
    const h = await open();
    const s = start(h, 'read-only');
    s.send(h.prompts.approve);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(of(s, 'approval-raised')).toEqual([]);
    expect(s.notices()).toEqual(['request-refused']);
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'deny', message: DENY_MESSAGE, error: null }]);
    expect(made(h, 'bash-once.txt')).toBeNull();
    // Refused by fat-g, not declined by the user: the tool's activity ends as its error result reads.
    expect(of(s, 'activity-ended').filter((event) => event.status === 'declined')).toEqual([]);
  });

  it('lets a Stop with a request pending end the turn as interrupted, with no decision sent and no file made (K2)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.approve);
    const asked = await raised(s);
    s.session.stop();
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    // The CLI's own cancel is the Stop's: no word of the request — main's sweep settles its card at the turn's end.
    expect(of(s, 'approval-resolved')).toEqual([]);
    expect([h.only().entry.answers, made(h, 'bash-once.txt')]).toEqual([[], null]);
    await expect(claude(s).decide(asked.requestId, 'approve')).resolves.toBe(false);
    expect(h.only().entry.answers).toEqual([]);
  });
});

describe('the session grant (V11, V27; C21, C22, C59, C68, C69, C86)', () => {
  it('sends the CLI’s own rule at the session’s scope with the allow, alone; the same command then runs unasked in that process, and asks again in the next', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.grant);
    const asked = await raised(s);
    expect(asked.request).toMatchObject({ choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'touch bash-session.txt' } });
    await expect(claude(s).decide(asked.requestId, 'approve-session')).resolves.toBe(true);
    await resolved(s, asked.requestId, 'confirmed');
    await s.ended('turn-1');
    const { id, entry } = h.only();
    // Exactly that one update (C69): the rule as the CLI wrote it, at the session's scope — though the CLI offered it at one that saves it.
    expect(entry.answers).toEqual([{ subtype: 'success', behavior: 'allow', message: null, error: null, updatedInput: { command: 'touch bash-session.txt', description: 'Create empty file bash-session.txt' }, updatedPermissions: [SESSION_RULE('touch bash-session.txt')] }]);
    expect(entry.grants).toEqual([{ toolName: 'Bash', ruleContent: 'touch bash-session.txt' }]);
    expect(h.markers()).toEqual([]);
    expect(made(h, 'bash-session.txt')).toBe('');

    // The next turn, in the same process: the CLI matches its own rule, and nothing is asked (K2). fat-g answered nothing.
    s.send(h.prompts.grantAgain, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    expect(of(s, 'approval-raised')).toHaveLength(1);
    expect(h.only().entry.answers).toHaveLength(1);
    const ran = of(s, 'activity-started').filter((event) => event.turnId === 'turn-2' && event.activityType === 'command');
    expect(ran).toHaveLength(1);
    expect(activity(s, ran[0]?.itemId ?? '').ended).toMatchObject({ status: 'completed' });

    // The grant ends with its process (C86): closed, and resumed in a new one, the same command asks again — nothing was sent again by itself.
    await s.session.close();
    await processGone(h, s.session);
    const again = resume(h, id);
    again.send(h.prompts.grantAgain, 3);
    const asks = await raised(again);
    expect(asks.request).toMatchObject({ kind: 'command', summary: 'touch bash-session.txt', grant: { covers: 'touch bash-session.txt' } });
    expect(h.only().entry.answers).toHaveLength(1);
    await expect(claude(again).decide(asks.requestId, 'approve')).resolves.toBe(true);
    expect(await again.ended('turn-3')).toMatchObject({ outcome: 'completed', reported: true });
    expect(h.only().entry.launches.map((launch) => launch.resume)).toEqual([null, id]);
    valid(again);
  });

  it('names the session’s scope though the request offered the rule at another, and offers no grant where the CLI offered none: a file change, whose only offer is a mode', async () => {
    const h = await open();
    h.control({ grantSuggestsOther: true });
    const s = start(h);
    s.send(h.prompts.grant);
    const asked = await raised(s);
    await expect(claude(s).decide(asked.requestId, 'approve-session')).resolves.toBe(true);
    await s.ended('turn-1');
    expect(h.only().entry.answers[0]?.updatedPermissions).toEqual([SESSION_RULE('touch bash-session.txt')]);
    // The fake marks any update that is not one rule at the session's scope: none was sent.
    expect(h.markers()).toEqual([]);
    expect(JSON.stringify(h.only().entry.answers)).not.toMatch(/userSettings|localSettings|projectSettings/);
  });
});

describe('file changes (V11, V27; C9, C48, C56)', () => {
  it('shows each of K2’s four whole — a file’s content, an edit by match with its scope, one outside every root said so — and the fake makes each once allowed', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.files);
    const inside = named(h, 'made-inside.txt');
    const views: unknown[] = [];
    for (let nth = 1; nth <= 4; nth += 1) {
      const asked = await raised(s, nth);
      views.push(asked.request);
      // No rule is offered for a file (C21): no session grant, and the mode that would stop the question is named where it is the only offer.
      expect(asked.request, `#${nth}`).toMatchObject({ kind: 'file-change', choices: ['approve', 'deny'], grant: null, reason: null, cut: false });
      await expect(claude(s).decide(asked.requestId, 'approve'), `#${nth}`).resolves.toBe(true);
      await resolved(s, asked.requestId, 'confirmed');
    }
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(views).toMatchObject([
      { tool: 'Write', summary: 'made-inside.txt', targets: [inside], outside: false, modeThatWouldStop: 'edits-ok', detail: { kind: 'changes', changes: [{ path: inside, kind: 'write', text: 'alpha', replace: null, all: null }] } },
      { tool: 'Edit', summary: 'made-inside.txt', targets: [inside], outside: false, modeThatWouldStop: 'edits-ok', detail: { kind: 'changes', changes: [{ path: inside, kind: 'update', text: 'beta', replace: 'alpha', all: false }] } },
      { tool: 'Write', outside: false, modeThatWouldStop: 'edits-ok', detail: { kind: 'changes', changes: [{ kind: 'write', text: 'gamma' }] } },
      // Outside every root: said, and a folder is offered beside the mode, so no mode is named as the one that would stop it.
      { tool: 'Write', outside: true, modeThatWouldStop: null, authority: [{ kind: 'mode', mode: 'edits-ok' }, { kind: 'folder', mode: null }], detail: { kind: 'changes', changes: [{ kind: 'write', text: 'delta' }] } },
    ]);
    valid(s);
    // The fake wrote each in its project: the first file made, then changed by the edit.
    expect(made(h, 'made-inside.txt')).toBe('beta');
    expect([made(h, 'made-in-added-root.txt'), made(h, 'made-outside.txt')]).toEqual(['gamma', 'delta']);
    expect(h.only().entry.writes.map((file) => path.basename(file))).toEqual(['made-inside.txt', 'made-inside.txt', 'made-in-added-root.txt', 'made-outside.txt']);
    // Each allow sent its request's own input back, and no update.
    expect(h.only().entry.answers.map((answer) => [answer.behavior, Object.keys(answer.updatedInput ?? {}).sort(), answer.updatedPermissions])).toEqual([
      ['allow', ['content', 'file_path'], undefined], ['allow', ['file_path', 'new_string', 'old_string', 'replace_all'], undefined], ['allow', ['content', 'file_path'], undefined], ['allow', ['content', 'file_path'], undefined],
    ]);
    // Four cards, four edits of the session's own, each completed.
    expect(of(s, 'activity-started').filter((event) => event.activityType === 'edit').map((event) => activity(s, event.itemId).ended?.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it('refuses a change past a bound with a notice that names the bound and its size, and the turn goes on: forty edits, and a content of 1,048,577 units', async () => {
    for (const [control, bound, size] of [['targetsForty', 'targets', 40], ['writeOverBound', 'detail', 1_048_577]] as const) {
      const h = await open();
      h.control({ [control]: true });
      const s = start(h);
      s.send(h.prompts.approve);
      expect(await s.ended('turn-1'), control).toMatchObject({ outcome: 'completed', reported: true });
      expect(of(s, 'approval-raised'), control).toEqual([]);
      expect(of(s, 'notice'), control).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound, size }]);
      expect(h.only().entry.answers, control).toEqual([{ subtype: 'success', behavior: 'deny', message: DENY_MESSAGE, error: null }]);
      expect(h.only().entry.writes, control).toEqual([]);
      valid(s);
      await harness?.dispose();
      harness = undefined;
    }
  });
});

describe('a worker’s request (V11; C11, C97)', () => {
  it('is raised under the worker, though it comes before the worker’s own frame, and its command runs once approved (K2)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.worker);
    const asked = await raised(s);
    const worker = of(s, 'worker-started')[0]?.workerId;
    expect(worker).toBeDefined();
    expect(asked).toMatchObject({ turnId: 'turn-1', workerId: worker, request: { kind: 'command', summary: 'touch worker-made.txt', grant: { covers: 'touch worker-made.txt' } } });
    await expect(claude(s).decide(asked.requestId, 'approve')).resolves.toBe(true);
    await resolved(s, asked.requestId, 'confirmed');
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    // The worker's own activity, under the worker, completed.
    expect(activity(s, asked.sourceId)).toMatchObject({ started: { workerId: worker, activityType: 'command' }, ended: { workerId: worker, status: 'completed' } });
    expect(made(h, 'worker-made.txt')).toBe('');
    valid(s);
  });
});

describe('a change of mode on the live process (V20, V30; C5, C74, C90)', () => {
  /** A session with one turn behind it, and nothing running. */
  const idle = async (h: Harness, mode = 'ask-first'): Promise<Watched> => {
    const s = start(h, mode);
    s.send(h.prompts.t1);
    await s.ended('turn-1');
    return s;
  };

  it('moves from Ask first to Edits ok with no restart, runs K2’s three steps there with no request, and asks again once moved back', async () => {
    const h = await open();
    const s = await idle(h);
    await expect(claude(s).setMode('edits-ok')).resolves.toEqual({ confirmed: true });
    expect(s.confirmed).toEqual(['ask-first', 'edits-ok']);
    expect(h.only().entry.modes).toEqual([{ mode: 'acceptEdits', turn: false, answered: 'success' }]);
    // The same process: nothing was launched for the change.
    expect(h.only().entry.launches).toHaveLength(1);

    s.send(h.prompts.edits, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    // A file change and two commands, and no card (K2): the mode lets them run, and fat-g was asked nothing.
    expect(of(s, 'approval-raised')).toEqual([]);
    expect(of(s, 'activity-started').filter((event) => event.turnId === 'turn-2' && ['edit', 'command'].includes(event.activityType)).map((event) => event.activityType)).toEqual(['edit', 'command', 'command']);
    expect(h.only().entry.answers).toEqual([]);

    await expect(claude(s).setMode('ask-first')).resolves.toEqual({ confirmed: true });
    expect(s.confirmed).toEqual(['ask-first', 'edits-ok', 'ask-first']);
    s.send(h.prompts.restored, 3);
    const asked = await raised(s);
    expect(asked).toMatchObject({ turnId: 'turn-3', request: { kind: 'file-change', tool: 'Write', summary: 'made-after-the-restore.txt', modeThatWouldStop: 'edits-ok' } });
    await expect(claude(s).decide(asked.requestId, 'deny')).resolves.toBe(true);
    await s.ended('turn-3');
    expect(h.only().entry.modes.map((set) => [set.mode, set.answered])).toEqual([['acceptEdits', 'success'], ['default', 'success']]);
    expect(s.notices()).toEqual([]);
    expect(h.running('chat')).toHaveLength(1);
    valid(s);
  });

  it('confirms the change however the reply and its status frame come: in one chunk as K2 saw them, in two, and the frame first', async () => {
    for (const control of [{}, { statusApart: true }, { statusFirst: true }]) {
      const h = await open();
      const s = await idle(h);
      h.control(control);
      const what = JSON.stringify(control);
      await expect(claude(s).setMode('auto-reviewed'), what).resolves.toEqual({ confirmed: true });
      // The status frame is read whenever it comes: it names the mode now in force, or the target still waited for.
      await eventually(() => claude(s).counts.modesReported === 1, 10_000, 'the status frame');
      expect(s.confirmed, what).toEqual(['ask-first', 'auto-reviewed']);
      // And the next turn runs under the new mode: its `init` names it, and is taken.
      h.control({});
      s.send(h.prompts.t1, 2);
      expect(await s.ended('turn-2'), what).toMatchObject({ outcome: 'completed', reported: true });
      expect([s.notices(), h.running('chat').length], what).toEqual([[], 1]);
      await harness?.dispose();
      harness = undefined;
    }
  });

  it('ends the process when the status frame names another mode than the target, and when the reply does not confirm a target its status frame named', async () => {
    for (const [control, outcome] of [[{ statusOther: true }, 'either'], [{ modeReplyOther: true }, { confirmed: false, detail: 'plan' }]] as const) {
      const h = await open();
      const s = await idle(h);
      h.control(control);
      const what = JSON.stringify(control);
      const change = await claude(s).setMode('edits-ok');
      // A frame that names another mode may be read before the reply is, or after it confirmed: either way the process is ended.
      if (outcome !== 'either') expect(change, what).toEqual(outcome);
      await processGone(h, s.session);
      expect(of(s, 'notice').at(-1), what).toEqual({ type: 'notice', kind: 'policy-mismatch', detail: 'plan' });
      valid(s);
      await harness?.dispose();
      harness = undefined;
    }
  });

  it('leaves the mode as it was when the CLI refuses the change, and the session goes on under it', async () => {
    const h = await open();
    const s = await idle(h);
    h.control({ modeRefused: 1 });
    await expect(claude(s).setMode('edits-ok')).resolves.toEqual({ confirmed: false, detail: null });
    expect(s.confirmed).toEqual(['ask-first']);
    expect(h.only().entry.modes).toEqual([{ mode: 'acceptEdits', turn: false, answered: 'error' }]);
    s.send(h.prompts.t1, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    expect([s.notices(), h.running('chat').length]).toEqual([[], 1]);
  });

  it('sends no change with a turn running, none into Berserk or the reading mode, and none out of either: the fake was sent nothing (C74)', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.approve);
    await raised(s);
    await expect(claude(s).setMode('edits-ok')).resolves.toEqual({ confirmed: false, detail: null });
    s.session.stop();
    await s.ended('turn-1');
    for (const to of ['berserk', 'read-only', 'ask-first', 'sandbox-ok']) await expect(claude(s).setMode(to), to).resolves.toEqual({ confirmed: false, detail: null });
    expect(h.only().entry.modes).toEqual([]);
    await s.session.close();
    for (const from of ['berserk', 'read-only']) {
      const other = await idle(h, from);
      for (const to of ['ask-first', 'edits-ok', 'auto-reviewed']) await expect(claude(other).setMode(to), `${from} → ${to}`).resolves.toEqual({ confirmed: false, detail: null });
      await other.session.close();
    }
    expect(Object.values(h.sessions()).flatMap((entry) => entry.modes)).toEqual([]);
    expect(h.markers()).toEqual([]);
  });
});

describe('a request delivered again, taken back, or lost (V11, V31; C11, C91)', () => {
  it('raises one card for a request delivered twice, and writes the decision once for each delivery', async () => {
    const h = await open();
    h.control({ approvalTwice: true });
    const s = start(h);
    s.send(h.prompts.approve);
    const asked = await raised(s);
    await eventually(() => claude(s).counts.approvals.repeated === 1, 10_000, 'the second delivery');
    await expect(claude(s).decide(asked.requestId, 'approve')).resolves.toBe(true);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed' });
    expect(of(s, 'approval-raised')).toHaveLength(1);
    expect(h.only().entry.answers.map((answer) => answer.behavior)).toEqual(['allow', 'allow']);
    expect(claude(s).counts.changed).toBe(0);
  });

  it('refuses another command that comes under the id it holds, on the wire, and withdraws the card as changed: nothing of the second payload is an event, and the first is never allowed', async () => {
    const h = await open();
    h.control({ approvalChanged: true });
    const s = start(h);
    s.send(h.prompts.approve);
    const asked = await raised(s);
    await resolved(s, asked.requestId, 'changed');
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(of(s, 'approval-raised')).toHaveLength(1);
    expect(of(s, 'approval-resolved')).toEqual([{ type: 'approval-resolved', requestId: asked.requestId, reason: 'changed' }]);
    // Denied for both deliveries, in fat-g's words; the hold is gone, and no decision can still allow what was first shown.
    expect(h.only().entry.answers.map((answer) => [answer.behavior, answer.message])).toEqual([['deny', DENY_MESSAGE], ['deny', DENY_MESSAGE]]);
    await expect(claude(s).decide(asked.requestId, 'approve')).resolves.toBe(false);
    expect([claude(s).counts.changed, made(h, 'bash-once.txt')]).toEqual([1, null]);
    // The one card shown is the first payload's; of the second there is nothing.
    expect(of(s, 'approval-raised')[0]?.request.detail).toEqual({ kind: 'command', command: 'touch bash-once.txt' });
    expect(JSON.stringify(s.events)).not.toMatch(/and-something-else/);
    valid(s);
  });

  it('says `withdrawn` when the CLI takes the request back and goes on, and refuses one that comes after the turn’s `result`', async () => {
    const h = await open();
    h.control({ approvalCancel: true });
    const s = start(h);
    s.send(h.prompts.approve);
    const asked = await raised(s);
    await resolved(s, asked.requestId, 'withdrawn');
    await s.ended('turn-1');
    expect(h.only().entry.answers).toEqual([]);
    await expect(claude(s).decide(asked.requestId, 'approve')).resolves.toBe(false);

    h.control({ approvalLate: true });
    s.send(h.prompts.approveAgain, 2);
    await s.ended('turn-2');
    await eventually(() => h.only().entry.answers.length === 1, 10_000, 'the late request’s refusal');
    expect(of(s, 'approval-raised')).toHaveLength(1);
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'deny', message: DENY_MESSAGE, error: null }]);
    expect(s.notices()).toEqual(['request-refused']);
  });

  it('says `dropped` for a request the process ended with, before the end made for the loss, and for a decision the process did not take', async () => {
    const h = await open();
    h.control({ exitWhileApproving: 1 });
    const s = start(h);
    s.send(h.prompts.approve);
    const asked = await raised(s);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' });
    const kinds = s.events.map((event) => (event.type === 'approval-resolved' ? `approval-resolved:${event.reason}` : event.type === 'notice' ? `notice:${event.kind}` : event.type));
    expect(kinds.slice(kinds.indexOf('approval-resolved:dropped'))).toEqual(['approval-resolved:dropped', 'notice:connection-lost', 'turn-ended']);
    await expect(claude(s).decide(asked.requestId, 'approve')).resolves.toBe(false);
    await harness?.dispose();

    const other = await open();
    other.control({ exitAtDecision: 1 });
    const t = start(other);
    t.send(other.prompts.approve);
    const second = await raised(t);
    // The process ends as the decision's line is written: the write did not go, and the promise says so.
    await expect(claude(t).decide(second.requestId, 'approve')).resolves.toBe(false);
    await resolved(t, second.requestId, 'dropped');
    expect(await t.ended('turn-1')).toMatchObject({ outcome: 'failed', failure: 'connection-lost' });
    expect(made(other, 'bash-once.txt')).toBeNull();
  });

  it('ends the denied command’s activity as declined by a rule when the user’s own configuration refuses it, with no request made (C76)', async () => {
    const h = await open();
    h.control({ deniedByRule: true });
    const s = start(h);
    s.send(h.prompts.approve);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(of(s, 'approval-raised')).toEqual([]);
    const command = of(s, 'activity-started').find((event) => event.activityType === 'command');
    expect(of(s, 'activity-ended').filter((event) => event.itemId === command?.itemId)).toEqual([{ type: 'activity-ended', turnId: 'turn-1', itemId: command?.itemId, status: 'declined', declinedBy: 'rule' }]);
    // fat-g was asked nothing and answered nothing, and counted no result of an unopened item.
    expect([h.only().entry.answers, claude(s).counts.dropped['unopened-item'], s.notices()]).toEqual([[], 0, []]);
    valid(s);
  });

  it('shows K2’s own turn under its rules: one command a rule allowed ran with no card, and the one a rule denied is declined by it', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.inherited);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(of(s, 'approval-raised')).toEqual([]);
    const commands = of(s, 'activity-started').filter((event) => event.activityType === 'command');
    expect(commands.map((event) => event.summary)).toEqual(['touch allowed-by-rule.txt', 'touch denied-by-rule.txt']);
    expect(commands.map((event) => activity(s, event.itemId).ended)).toMatchObject([{ status: 'completed' }, { status: 'declined', declinedBy: 'rule' }]);
    expect(h.only().entry.answers).toEqual([]);
  });
});

describe('a line over the limit (V3, V11; C67, C71)', () => {
  it('refuses a request by the id read from its line, with a notice naming the line’s size, and the turn goes on to its own end', async () => {
    const h = await open();
    h.control({ requestOverLine: true });
    const s = start(h);
    s.send(h.prompts.approve);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(of(s, 'approval-raised')).toEqual([]);
    const [notice] = of(s, 'notice');
    expect(of(s, 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'line', size: expect.any(Number) as number }]);
    expect(notice?.size).toBeGreaterThan(4 * 1024 * 1024);
    expect(h.only().entry.answers).toEqual([{ subtype: 'success', behavior: 'deny', message: DENY_MESSAGE, error: null }]);
    expect(claude(s).counts.refused).toEqual({ 'oversized-request': 1 });
    expect(claude(s).counts.dropped.oversized).toBe(1);
    expect(h.running('chat')).toHaveLength(1);
    // Nothing of the line is in an event or a log: no content, no path, only its size.
    expect(JSON.stringify(h.diagnostics())).not.toMatch(/xxxx/);
    valid(s);
  });

  it('stops the turn for a request whose id is past the line’s first bytes: nothing could answer it, so nothing is left waiting on it', async () => {
    const h = await open();
    h.control({ requestOverLineNoId: true });
    const s = start(h);
    s.send(h.prompts.approve);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true });
    expect(of(s, 'notice')).toEqual([{ type: 'notice', kind: 'line-too-long', turnId: 'turn-1', size: expect.any(Number) as number }]);
    expect(of(s, 'approval-raised')).toEqual([]);
    expect([h.only().entry.answers, h.only().entry.interrupts.length, made(h, 'bash-once.txt')]).toEqual([[], 1, null]);
    // No process was closed for the line: the session takes its next prompt.
    expect(h.running('chat')).toHaveLength(1);
    h.control({});
    s.send(h.prompts.t1, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    valid(s);
  });
});

describe('what the fake’s scratch project holds (V11; C35)', () => {
  it('is changed by an allowed request alone, inside the project: a denied one, a refused one and a stopped one leave it as it was', async () => {
    const h = await open();
    writeFileSync(path.join(h.project, 'kept.txt'), 'as it was');
    const s = start(h);
    s.send(h.prompts.approve);
    const asked = await raised(s);
    await claude(s).decide(asked.requestId, 'deny');
    await s.ended('turn-1');
    expect([made(h, 'bash-once.txt'), made(h, 'kept.txt'), h.only().entry.writes]).toEqual([null, 'as it was', []]);
    s.send(h.prompts.approveAgain, 2);
    const again = await raised(s, 2);
    await claude(s).decide(again.requestId, 'approve');
    await s.ended('turn-2');
    expect([made(h, 'bash-once.txt'), made(h, 'kept.txt')]).toEqual(['', 'as it was']);
    expect(h.only().entry.writes).toEqual([path.join(h.project, 'bash-once.txt')]);
  });
});

// K5's captures (round 3 of M22; V11, V34; C74, C94, C96, C97): a turn under each mode that lets
// things run with no request, on the real adapter, under the mode it was captured under. What K5
// showed is what the chat is told: the actions as activities that ran, and no card for any of them.
describe('what a mode lets run with no request, as K5 saw it (V11, V34; C74, C94, C96, C97)', () => {
  /** Every event a card, or a refusal, would be made of: none of them comes where nothing was asked. */
  const cardMaking = (s: Watched): AgentEvent[] => s.events.filter((event) => event.type === 'approval-raised' || event.type === 'approval-resolved' || event.type === 'question-raised' || event.type === 'question-resolved' || event.type === 'notice');
  /** The session's activities of a turn, each as its type, its line and how it ended; a worker's with the worker it names. */
  const ran = (s: Watched, types: readonly string[]) => of(s, 'activity-started').filter((event) => types.includes(event.activityType)).map((event) => ({ type: event.activityType, summary: event.summary, workerId: event.workerId, status: activity(s, event.itemId).ended?.status, endedFor: activity(s, event.itemId).ended?.workerId }));

  it('under Auto reviewed: K5’s four steps run with no request and no card, a file written outside every root among them, each told as it ran (C96)', async () => {
    const h = await open();
    const s = start(h, 'auto-reviewed');
    s.send(h.prompts.auto);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    // The launch K5's capture was taken under, confirmed as the mode's id from its reply.
    expect([h.only().entry.launches[0]?.mode, s.confirmed]).toEqual(['auto', ['auto-reviewed']]);
    // Nothing reached fat-g for what Claude decided by itself: no request, no card, no notice, and no frame of a review to count.
    expect(cardMaking(s)).toEqual([]);
    expect(h.only().entry.answers).toEqual([]);
    expect([claude(s).counts.refused, claude(s).counts.approvals, claude(s).counts.changed]).toEqual([{}, { repeated: 0, unheld: 0 }, 0]);
    // The four steps, as the chat's record of what ran: the file in the folder, the two commands, and the file outside every root.
    expect(ran(s, ['edit', 'command'])).toEqual([
      { type: 'edit', summary: 'made-under-auto.txt', workerId: undefined, status: 'completed', endedFor: undefined },
      { type: 'command', summary: 'touch bash-under-auto.txt', workerId: undefined, status: 'completed', endedFor: undefined },
      { type: 'command', summary: 'node --version', workerId: undefined, status: 'completed', endedFor: undefined },
      { type: 'edit', summary: 'made-outside-under-auto.txt', workerId: undefined, status: 'completed', endedFor: undefined },
    ]);
    // The write outside every root, whole as an activity keeps a change: its path and its content, with no word that anything was asked.
    const outside = of(s, 'activity-started').find((event) => event.summary === 'made-outside-under-auto.txt');
    expect(outside).toMatchObject({ turnId: 'turn-1', activityType: 'edit', name: 'Write', changes: [{ path: named(h, 'made-outside-under-auto.txt'), kind: 'write', text: 'delta' }] });
    expect(of(s, 'activity-ended').some((event) => event.status === 'declined' || event.status === 'failed')).toBe(false);
    valid(s);
    // The fake changes a file for an allowed request alone: a turn that asked nothing left its project as it was.
    expect([h.only().entry.writes, h.markers()]).toEqual([[], []]);
  });

  it('under Berserk: the same four steps run with no request, launched by the mode’s word alone and no flag that bypasses permissions (C47)', async () => {
    const h = await open();
    const s = start(h, 'berserk');
    s.send(h.prompts.bypass);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    const [launch] = h.only().entry.launches;
    expect([launch?.mode, s.confirmed]).toEqual(['bypassPermissions', ['berserk']]);
    expect(launch?.args).toEqual([...chatFixedArgs(CLAUDE_MODES.berserk), '--model', 'sonnet', '--effort', 'low']);
    expect(launch?.args.filter((arg) => /skip-permissions/.test(arg))).toEqual([]);
    expect(cardMaking(s)).toEqual([]);
    expect(h.only().entry.answers).toEqual([]);
    expect(ran(s, ['edit', 'command']).map((step) => [step.type, step.summary, step.status])).toEqual([
      ['edit', 'made-under-bypass.txt', 'completed'], ['command', 'touch bash-under-bypass.txt', 'completed'], ['command', 'node --version', 'completed'], ['edit', 'made-outside-under-bypass.txt', 'completed'],
    ]);
    // No word of the CLI's for the mode is in what the session told.
    expect(JSON.stringify(s.events)).not.toMatch(/bypassPermissions/);
    valid(s);
  });

  it('out of Berserk is a new process: the session resumed under Ask first and under Edits ok reports that mode, as K5’s two resumes did, and no change into Berserk is ever sent there (C74)', async () => {
    const h = await open();
    const s = start(h, 'berserk');
    s.send(h.prompts.bypass);
    await s.ended('turn-1');
    const { id } = h.only();
    // No change on the live process leads out of Berserk or into it: the facet answers a restart, and the session sends nothing.
    for (const other of ['ask-first', 'edits-ok', 'auto-reviewed', 'read-only']) expect([h.facet.transition?.('berserk', other), h.facet.transition?.(other, 'berserk')], other).toEqual(['restart', 'restart']);
    await expect(claude(s).setMode('ask-first')).resolves.toEqual({ confirmed: false, detail: null });
    await s.session.close();
    await processGone(h, s.session);

    // Resumed under Ask first: K5's resume under the CLI's default word reported it, and the start's check takes it.
    const asking = resume(h, id, 'ask-first');
    asking.send(h.prompts.t1, 2);
    expect(await asking.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    expect(asking.confirmed).toEqual(['ask-first']);
    expect(asking.notices()).toEqual([]);
    // K5 saw the CLI refuse a change into its bypass mode in that process. fat-g never asks for one: nothing was sent.
    await expect(claude(asking).setMode('berserk')).resolves.toEqual({ confirmed: false, detail: null });
    expect(h.only().entry.modes).toEqual([]);
    // And the process asks again, as one under Ask first does: K2's command is a card.
    asking.send(h.prompts.approve, 3);
    const asked = await raised(asking);
    expect(asked).toMatchObject({ turnId: 'turn-3', request: { kind: 'command', summary: 'touch bash-once.txt' } });
    await expect(claude(asking).decide(asked.requestId, 'deny')).resolves.toBe(true);
    await asking.ended('turn-3');
    await asking.session.close();
    await processGone(h, asking.session);

    // Resumed under Edits ok: K5's other resume reported that word, and each turn's `init` names it.
    const editing = resume(h, id, 'edits-ok');
    editing.send(h.prompts.t1, 4);
    expect(await editing.ended('turn-4')).toMatchObject({ outcome: 'completed', reported: true });
    expect([editing.confirmed, editing.notices()]).toEqual([['edits-ok'], []]);
    // One session of the CLI's, three processes: the first able to bypass permissions, and neither of the two after it.
    expect(h.only().entry.launches.map((launch) => [launch.mode, launch.resume, launch.args.some((arg) => /skip-permissions/.test(arg))])).toEqual([
      ['bypassPermissions', null, false], ['default', id, false], ['acceptEdits', id, false],
    ]);
    expect(h.markers()).toEqual([]);
    valid(asking);
    valid(editing);
  });

  it('under Edits ok: a sub-agent’s file change and its command run with no request, each the worker’s own activity under the worker’s id (C97)', async () => {
    const h = await open();
    const s = start(h, 'edits-ok');
    s.send(h.prompts.workerEdits);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect([h.only().entry.launches[0]?.mode, s.confirmed]).toEqual(['acceptEdits', ['edits-ok']]);
    const [worker] = of(s, 'worker-started');
    expect(worker).toBeDefined();
    // A worker runs under its session's mode (C97): what Edits ok lets the session do with no card, it lets the worker do.
    expect(cardMaking(s)).toEqual([]);
    expect(h.only().entry.answers).toEqual([]);
    expect(ran(s, ['edit', 'command'])).toEqual([
      { type: 'edit', summary: 'worker-wrote.txt', workerId: worker?.workerId, status: 'completed', endedFor: worker?.workerId },
      { type: 'command', summary: 'touch worker-mode-made.txt', workerId: worker?.workerId, status: 'completed', endedFor: worker?.workerId },
    ]);
    // In the turn that started the worker, and the worker ended with its report.
    expect(of(s, 'activity-started').filter((event) => event.workerId === worker?.workerId).every((event) => event.turnId === 'turn-1')).toBe(true);
    expect(of(s, 'worker-ended')).toEqual([{ type: 'worker-ended', workerId: worker?.workerId, outcome: 'completed' }]);
    valid(s);
  });
});
