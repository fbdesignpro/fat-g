// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15 (docs/planning/_archive/M16.md; S2, C43, C74): the two providers, each through its own adapter and the
// real process layer against its replay fake, come out of the shared code in the same shapes. Four
// captures of each — a basic turn, a worker, an interrupt, a failure — are run through the app's
// own session side, and what the page reads of them is compared: the items, the turn, the summary.
//
// Nothing in src/shared, src/main/sessions/ or the conversation store names a provider, so what
// differs between the two can only be what their adapters report. Those differences are the CLIs'
// own, and each is listed here, under DIFFERENCES, with the test that holds it:
//
//   1. The reference. Codex names its thread as the turn starts; Claude's session is named at its
//      first frame from a model (C87), so later in the turn, and not at all in a turn no model
//      answered — after which the session still reads as not started.
//   2. The answer. Codex labels its last message `final` as it sends it; Claude's texts all come as
//      commentary, and the turn's end names which was the answer (C74). The stored item is the same.
//   3. The user's message. Codex echoes it under an id of its own; Claude echoes nothing, so the
//      item keeps fat-g's id alone.
//   4. The turn's own id. Codex gives one; Claude's turn is bounded by the prompt's id, fat-g's (C75).
//   5. What is in force. Both say the mode their process confirmed (M22, C2). Claude also says
//      which model answers; Codex's captures say nothing more here.
//   6. A worker's label. Claude gives each worker a description; Codex's are numbered.
//   7. The earlier conversation. Codex's can be read back; Claude's is `unsupported` (C49).
//
// How many texts a model writes before its answer, and how many actions it takes, is each capture's
// own content, not its mapping's: commentary and actions are held to their place in the turn, not
// counted.
//
// V20 (docs/planning/_archive/M19.md; C3, C4, C14, C15): a message told as it is written. Whether a provider
// streams is no capability and no branch of the shared code: an adapter that sends `message-delta`
// events has its messages opened, grown and completed, and what the page is pushed and reads is the
// same from both. Both providers' captures are streamed ones (M19: K1 for Codex, K2 for Claude).
// What differs is again the CLIs' own:
//
//   8. A streamed message's id. Codex names the item as it starts; Claude names a reply, and a text
//      is that reply's id with its block's index.
//   9. A message's phase while it is written. Codex says `final` as its answer starts. Claude
//      says none: it names the answer at the turn's end (difference 2), so a text that is still
//      coming is neither yet, and is drawn as an answer is (M19, C79). Whole, it is commentary.
//  10. An interrupted answer's last frame. Codex sends no whole message for one. Claude sends the
//      frame with what it had written, which fat-g takes for the text alone (M19, C80). Either
//      way the answer stays as it was received, unfinished: what the page shows is the same.
//
// V15 (docs/planning/_archive/M20a.md; C26): what a session does between its messages, and what its worker
// does. Both providers' captures give the same item — the same fields, the same body, started and
// then ended, pushed as it runs — and a worker's work is filed under the worker's id by both, with
// the item that started it in the session's own chat. How many things a model does in a turn is each
// capture's own content, as its commentary is. What differs is again the CLIs' own:
//
//  11. An activity's name. Claude's is its tool's; Codex's is its item's type.
//  12. An activity's times. Codex says when an item started and how long it took, so its duration
//      is the provider's; Claude says neither, and the duration is fat-g's own, between the tool's
//      use and its result.
//  13. How a file is read. Codex runs a command, which has a line as its input and an exit code;
//      Claude uses its `Read` tool, whose input names the file and whose result is the output.
//  14. A worker's item. Claude's is its `Agent` tool use: told at the tool use, with what the
//      worker is asked as its input, told again once the CLI names the worker it started (M20a,
//      C21, C23), and ended at the first of the worker's two closing frames and again by its
//      notification, which brings the worker's report as its output (C22). Codex's names its
//      worker's thread from its start: told once, with no input, and ended once.
//      Codex's session also waits for its worker by an item of its own; Claude's has none.
//  15. The checklist. Codex's alone, and only where the user's own configuration enables its tool
//      (C24); Claude's launch offers no tool for one (C25).
//  16. How Codex announces a worker, by the model (M20a, C70; K3). The captures compared here are
//      of a model that sends a `subAgentActivity`; another starts one through a collab tool call,
//      which is then the worker's item, told at the call's start with what the worker is asked
//      and again at its completion, which names the worker — as Claude's `Agent` tool use is
//      (difference 14). Held by tests/codex/activity.integration.test.ts, on K3's capture.
//
// V15 (docs/planning/_archive/M20b.md; C24–C26): a question asked beside a session. Both providers' captures
// give the same course through their adapters and main — a turn of the aside's own, its question,
// an answer, an end the provider reported — the same items and the same turn as the page reads
// them, and leave the session's own conversation, its record and its summary as they were. What
// differs is what each route allows, and each descriptor declares it (C24):
//
//  17. An aside's answer as it arrives. Codex's side thread writes it as a session's is written,
//      so the page is pushed its text in pieces; Claude's side question answers whole, so the page
//      is pushed the one item. `streamed` says which.
//  18. What an aside did. Codex's side thread may read, and what it read is an activity of the
//      aside's own; Claude's side question takes no tool. `tools` says which.
//  19. The model that answered. Claude's reply may name another than the session's, which its
//      message then carries; Codex's side thread runs on the session's own.
//
// V13 (docs/planning/_archive/M21.md; C30): a question a session asks as a request. Both providers' captures
// give the same course through their adapters and main — raised under its turn, a card that waits
// with the session's attention on it, answered from the card, the CLI's own word that it took the
// answer, the turn completing; and, stopped while it waits, withdrawn by its turn's end — and the
// same item and the same turn as the page reads them. What a question asks is each capture's own.
// What differs is again each CLI's own, and the first is declared (C30):
//
//  20. How a provider asks. Claude asks by a request alone. Codex also asks in a message, and ends
//      its turn: a card that waits for nothing, answered by a prompt. `questions` says which.
//  21. What carries a question, and the CLI's word for an answer it took. Claude's is its tool's
//      use, and the word is that tool's result; Codex's is an item of its turn, and the word is a
//      notification of its own. Either way the card is confirmed by one event.
//
// V11 (docs/planning/_archive/M22.md; C35): an action a session asks leave for. Both providers' captures give
// the same course through their adapters and main — the mode its process confirmed, a request
// raised under its turn at the action it is for, a card that waits with the session's attention on
// it, decided from the card, the decision written, then delivered, then confirmed by the CLI's own
// word, the action run or declined at the user's word, the turn completing; stopped while it waits,
// withdrawn by its turn's end; and, granted for the session, listed as the session's grant while its
// process lives, with the next request it covers unasked — and the same item, turn and summary as
// the page reads them. Each chat here has Ask first as the user's default, the mode the captures were
// taken under: the providers' fallback is Auto reviewed (decision 0027, item 7), which
// asks for nothing. What a request asks leave for is each capture's own. What differs is each CLI's:
//
//  22. What a command's request names. Codex names the folder it would run in, and nothing else of
//      it; Claude names no folder: it gives the paths the command names, and the model's own
//      reason for it.
//  23. Which kinds a grant covers. Claude offers its rule for the session with a command, and the
//      grant covers that rule's own words; Codex's command lists no such choice in K1's capture,
//      and its file change does: the grant covers the file. Neither is offered where its CLI did
//      not offer it (C68).
//  24. What else the CLI's own offers would grant. Claude's request brings a saved rule, a folder
//      and a mode among its suggestions; Codex's command an amendment to its saved rules, and its
//      file change nothing. Each is said on the card and never sent back (C22, C56).
//  25. A stopped request's action. Claude ends its tool's use as failed; Codex says nothing more of
//      its item, which reads unfinished. Either way the card is withdrawn by its turn's end.
//  26. Where the reviewer stands. Codex names who answers its requests at every start, resume and
//      turn, and its Auto reviewed is a reviewer of its own in the user's place; Claude's is a mode
//      of the CLI's, with no frame of a review. Held by each adapter's own tests
//      (tests/codex/approval.integration.test.ts, tests/claude/chat/approval.integration.test.ts):
//      no request of either reaches main under it, so nothing of it is compared here.
//
// V7 (docs/planning/_archive/M22b.md; C10, C14, C15, C55): a plan. Both providers' captures give the same course
// through their adapters and main — a plan turn sent with its flag under the chat's mode, unchanged,
// a version of the plan in the plan store, whole, and a line of the chat's that waits for its decision,
// with the session's attention PLAN READY — and the same line as the page reads it. What a plan says
// is each capture's own. What differs is each CLI's own, and the descriptor says under which modes:
//
//  27. How a plan arrives. Claude's comes whole, in its `ExitPlanMode` request, which holds its turn:
//      the decision is taken while the turn runs. Codex's is an item its turn writes, delta by delta,
//      and the turn ends: the decision is taken after it.
//  28. How Execute goes. Claude's is the request's answer, and the turn goes on; Codex's is a turn of
//      its own, in fat-g's words, naming `default` — as every later turn of a thread that planned does.
//
// V11 (docs/planning/_archive/M23.md; C21, C24, C36, C38, C42, C60, C63): images, a message sent into a running
// turn, and the commands. The shared code passes each the same way; what differs is each CLI's own:
//
//  29. How an image goes. Claude's frame carries its bytes as base64; Codex's input names its path
//      under fat-g's folder, which Codex reads itself.
//  30. What a steer says at once. Codex's reply names the turn the message joined: Taken. Claude takes
//      the frame and says later, by its lifecycle, whether the turn took it at a tool boundary or ran
//      it as its next turn: Sent, then Taken; and only Claude has a held message a Stop drops.
//  31. Where the commands come from. Claude's process lists its commands and skills, once it has run;
//      Codex lists a folder's skills on the instance's connection, each chosen by a selector, and no
//      command of its own.
//  32. How full the context is (decision 0033). Claude is asked, and says where it compacts and what
//      the context holds by part; Codex reports each call by itself, and says neither. Both go to
//      the summary alone, as the same reading.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileName } from '@shared/contracts/activity';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { AsideCapability } from '@shared/contracts/aside';
import type { ChatAsideRead, ChatPush, ChatRead, ChatWorkerRead } from '@shared/contracts/chat';
import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import { type ApprovalChoice, approvalOf, outcomeWords, planOf, questionOf } from '@shared/contracts/interaction';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { ProviderSession, SessionFacet } from '@shared/provider-kit/sessions';
import { CHAT_TOOLS } from '../../src/main/providers/claude/chat-launch';
import { claudeHarness } from '../claude/chat/harness';
import { codexHarness, PROMPTS, promptOf } from '../codex/harness';
import { promptOf as claudePromptOf } from '../claude/chat/harness';
import { type App, launchApp, placeRecords, S, sessionEntry, storedSession, until } from './app';
import { collect } from './facet-contract';

type Kind = 'basic' | 'worker' | 'interrupt' | 'failure';
const CAPTURE = { basic: 't1', worker: 't3', interrupt: 't4', failure: 't5' } as const;
/**
 * The mode the captures were taken under, every chat's here as the user's default: the providers'
 * fallback is Auto reviewed (decision 0027, item 7), which these replays do not confirm.
 */
const CAPTURED_MODE = (): string => 'ask-first';

interface Run {
  readonly events: readonly AgentEvent[];
  readonly read: ChatRead;
  /** Every push of the session's chat, in order. */
  readonly pushes: readonly ChatPush[];
  readonly summary: NonNullable<ReturnType<App['summary']>>;
  readonly record: Record<string, unknown>;
  /** What the page reads of each worker the turn started, by the worker's id (M20a, C22). */
  readonly workers: readonly ChatWorkerRead[];
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });

/**
 * The facet, with every event of every session it makes kept, in order — but `steer-changed`, a word
 * to main of when its turn takes a message, which each CLI's frames bring at their own moment.
 */
function recording(facet: SessionFacet, events: AgentEvent[]): SessionFacet {
  const tap = (session: ProviderSession): ProviderSession => { session.subscribe((event) => { if (event.type !== 'steer-changed') events.push(event); }); return session; };
  return { ...facet, start: (options) => tap(facet.start(options)), resume: (options) => tap(facet.resume(options)) };
}

/** One capture, as a first turn of a new session, through the app's session side. */
async function run(kind: Kind, provider: AgentProvider, facet: SessionFacet, dir: string, folder: string, prompt: string, model: string): Promise<Run> {
  const { id } = provider.descriptor;
  const data = path.join(dir, 'records');
  placeRecords(data, folder, id, [sessionEntry(1, id, { model })]);
  const events: AgentEvent[] = [];
  const recorded = recording(facet, events);
  const app = launchApp({ dir: data, descriptor: provider.descriptor, facet: () => recorded, userDefault: CAPTURED_MODE });
  disposers.push(() => app.quit());
  expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  if (kind === 'interrupt') {
    // Thinking is immediate (M105); these captures interrupt work after a provider frame.
    await until(() => { const action = app.summary(1)?.action; return action != null && action.kind !== 'thinking'; }, 'the turn’s first provider action', 20_000);
    expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
  }
  await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 30_000);
  await app.service.settled();
  const summary = app.summary(1);
  const record = storedSession(data, 1);
  if (summary === undefined || record === undefined) throw new Error('the session is not listed');
  const workers = events.flatMap((event) => (event.type === 'worker-started' ? [event.workerId] : [])).flatMap((workerId) => { const read = app.runtime.readWorker(S(1), workerId); return read.status === 'read' ? [read] : []; });
  return { events, read: app.read(1), pushes: [...app.pushes], summary, record, workers };
}

async function both(kind: Kind): Promise<{ codex: Run; claude: Run }> {
  const codexSide = await codexHarness();
  disposers.push(() => codexSide.dispose());
  const claudeSide = await claudeHarness();
  disposers.push(() => claudeSide.dispose());
  const capture = CAPTURE[kind];
  const codex = await run(kind, codexSide.provider, codexSide.facet, codexSide.dir, codexSide.project, PROMPTS[capture], 'gpt-6-astra');
  const claude = await run(kind, claudeSide.provider, claudeSide.facet, claudeSide.dir, claudeSide.project, claudeSide.prompts[capture], 'sonnet');
  return { codex, claude };
}

// ── What is compared ──────────────────────────────────────────────────────────────────────────

/** A turn's events as both providers must give them: the answer settled (2), and without the reference (1), the echo (3) and what is in force (5). */
function course(events: readonly AgentEvent[]): string[] {
  const answer = events.flatMap((event) => (event.type === 'turn-ended' && event.answerItemId !== undefined ? [event.answerItemId] : []))[0];
  const out: string[] = [];
  for (const event of events) {
    if (event.type === 'turn-started') out.push('turn-started');
    // Commentary is each capture's own: held to its place by the test below, not counted here. What a
    // worker says is the worker's (M20a, C20): the session's own messages are the turn's course.
    else if (event.type === 'message') { if (event.role === 'assistant' && event.workerId === undefined && (event.itemId === answer || event.phase === 'final')) out.push('answer'); }
    else if (event.type === 'worker-started') out.push('worker-started');
    else if (event.type === 'worker-ended') out.push(`worker-ended:${event.outcome}`);
    else if (event.type === 'notice') out.push(`notice:${event.kind}:${typeof event.detail}`);
    else if (event.type === 'turn-ended') out.push(`turn-ended:${event.outcome}:${event.reported ? 'reported' : 'own'}:${event.failure ?? 'none'}`);
  }
  return out;
}

/** The fields of an event of each type both providers send, without the ones a difference above names. */
// A worker's model and agent definition (M106, C14, C15, C20): Claude's old captures name the definition, and neither the model.
const NATIVE: Readonly<Record<string, readonly string[]>> = { 'turn-started': ['providerTurnId'], 'turn-ended': ['answerItemId'], 'worker-started': ['description', 'model', 'agentType'] };
const COMPARED = ['turn-started', 'session-started', 'message', 'notice', 'worker-started', 'worker-ended', 'turn-ended'] as const;
function fields(events: readonly AgentEvent[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const type of COMPARED) {
    const keys = new Set(events.filter((event) => event.type === type && (event.type !== 'message' || (event.role === 'assistant' && event.workerId === undefined))).flatMap((event) => Object.keys(event)));
    for (const native of NATIVE[type] ?? []) keys.delete(native);
    if (keys.size > 0) out[type] = [...keys].sort();
  }
  return out;
}

interface ItemShape { readonly kind: string; readonly role: string | null; readonly phase: string | null; readonly notice: string | null; readonly origin: string; readonly blocks: readonly string[]; readonly detail: string; readonly fields: readonly string[]; readonly named: string }

/**
 * The chat's items as the page reads them, each by what it is. Of the assistant's texts, the answer
 * alone: its commentary is left out, and so is a text its Stop cut, which says no phase (M19, C79) —
 * each is its capture's own content, and so is what the session did between them (M20a), which
 * `activities` compares by its shape.
 */
function items(read: ChatRead): ItemShape[] {
  return read.items.filter((item) => item.kind !== 'activity' && (item.role !== 'assistant' || item.phase === 'final')).map((item) => ({
    kind: item.kind, role: item.role, phase: item.phase, notice: item.notice, origin: item.origin, blocks: item.blocks.map((block) => block.type),
    detail: typeof item.detail, fields: Object.keys(item).sort(),
    // The provider's id for an item of its own; the user's message is difference 3.
    named: item.role === 'user' ? 'the user’s' : typeof item.providerItemId,
  }));
}

/** The turn as the page reads it: its place, its state, its end, and which of its times are known. */
function turns(read: ChatRead): unknown[] {
  return read.turns.map((turn) => ({ place: turn.place, origin: turn.origin, state: turn.state, outcome: turn.outcome, gap: turn.gap, times: Object.fromEntries(Object.entries(turn.time).map(([key, value]) => [key, value === null ? 'none' : 'known'])) }));
}

/** What the session list shows of it once the turn is over. */
function outcome(result: Run): unknown {
  const { summary, record } = result;
  return {
    attention: summary.attention === null ? null : { kind: summary.attention.kind, count: summary.attention.count }, activeWorkers: summary.activeWorkers, action: summary.action, turnStartedAt: summary.turnStartedAt,
    agents: summary.agents.map((agent) => ({ number: agent.number, state: agent.state, finished: agent.finishedAt !== null })),
    lastTurn: (record['lastTurn'] as { outcome: string } | null)?.outcome ?? null, nameSource: record['nameSource'],
  };
}

const EXPECTED: Readonly<Record<Kind, { readonly course: readonly string[]; readonly items: readonly string[]; readonly outcome: string; readonly attention: string }>> = {
  basic: { course: ['turn-started', 'answer', 'turn-ended:completed:reported:none'], items: ['user', 'assistant:final'], outcome: 'completed', attention: 'ready' },
  worker: { course: ['turn-started', 'worker-started', 'worker-ended:completed', 'answer', 'turn-ended:completed:reported:none'], items: ['user', 'assistant:final'], outcome: 'completed', attention: 'ready' },
  interrupt: { course: ['turn-started', 'turn-ended:interrupted:reported:none'], items: ['user'], outcome: 'interrupted', attention: 'ready' },
  failure: { course: ['turn-started', 'notice:turn-failed:string', 'turn-ended:failed:reported:turn-failed'], items: ['user', 'turn-failed'], outcome: 'failed', attention: 'error' },
};

describe('the two providers, in the same shapes (V15; S2, C43)', () => {
  it.each(['basic', 'worker', 'interrupt', 'failure'] as const)('%s: the same course of events, items, turn and summary from each', async (kind) => {
    const { codex, claude } = await both(kind);
    const expected = EXPECTED[kind];

    // The turn's course, through each adapter.
    expect(course(codex.events)).toEqual(expected.course);
    expect(course(claude.events)).toEqual(expected.course);
    // An event of a type both sent has the same fields from each. A type one capture has and the
    // other has not — a commentary, or the reference of a turn no model answered — is its own.
    const shared = (mine: Record<string, string[]>, theirs: Record<string, string[]>) => Object.fromEntries(Object.entries(mine).filter(([type]) => type in theirs));
    expect(shared(fields(claude.events), fields(codex.events))).toEqual(shared(fields(codex.events), fields(claude.events)));
    expect(Object.keys(shared(fields(claude.events), fields(codex.events)))).toEqual(expect.arrayContaining(['turn-started', 'turn-ended']));

    // What the page reads of it.
    expect(items(claude.read)).toEqual(items(codex.read));
    expect(items(codex.read).map((item) => (item.role === 'assistant' ? `assistant:${item.phase}` : item.role ?? item.notice))).toEqual(expected.items);
    expect(turns(claude.read)).toEqual(turns(codex.read));
    expect(turns(codex.read)).toMatchObject([{ place: 1, state: 'ended', outcome: expected.outcome }]);

    // What the session list shows of it.
    expect(outcome(claude)).toEqual(outcome(codex));
    expect(outcome(codex)).toMatchObject({ attention: { kind: expected.attention }, lastTurn: expected.outcome, activeWorkers: 0, action: null });

    // What it did is in its chat as items of the session's own, none left running under its ended turn (M20a, C29).
    for (const side of [codex, claude]) {
      expect(side.read.items.every((item) => item.workerId === null)).toBe(true);
      // Ended, or left unfinished by a Stop: an item its provider completes after its turn's end is completed then (C6).
      expect(side.read.items.filter((item) => item.kind === 'activity').every((item) => item.state !== 'streaming' && item.activity?.status !== 'running')).toBe(true);
    }

    // Commentary, where a capture has any, is before the answer and never after it; an action is inside its turn.
    for (const side of [codex, claude]) {
      const phases = side.read.items.filter((item) => item.role === 'assistant').map((item) => item.phase);
      expect(phases.slice(0, -1).every((phase) => phase === 'commentary')).toBe(true);
      const types = side.events.map((event) => event.type);
      if (types.includes('action-changed')) {
        expect(types.indexOf('action-changed')).toBeGreaterThan(types.indexOf('turn-started'));
        expect(types.lastIndexOf('action-changed')).toBeLessThan(types.indexOf('turn-ended'));
      }
    }
  }, 120_000);
});

// ── M19: a message told as it is written ──────────────────────────────────────────────────────

/** What the page was pushed of one item, in order: each push by its kind, an item's with its state. */
function pushesOf(pushes: readonly ChatPush[], itemId: string): string[] {
  return pushes.flatMap((push) => ('item' in push && push.item.id === itemId ? [`item:${push.item.state}`] : 'partial' in push && push.partial.itemId === itemId ? ['partial'] : []));
}
/** The same, with a run of partial pushes as one: how many there are is each capture's own length. */
const shapeOf = (kinds: readonly string[]): string[] => kinds.filter((kind, index) => kind !== 'partial' || kinds[index - 1] !== 'partial');

/** The text the page holds of an item after every push of it: the item pushes' own, and each partial's piece put after what it follows. */
function pushedText(pushes: readonly ChatPush[], itemId: string): { readonly text: string; readonly gaps: number } {
  let text = '';
  let gaps = 0;
  for (const push of pushes) {
    if ('item' in push && push.item.id === itemId) text = itemText(push.item);
    else if ('partial' in push && push.partial.itemId === itemId) {
      // A piece that does not follow what the page holds is one the page would read again for.
      if (push.partial.before !== text.length) gaps += 1;
      text = text.slice(0, push.partial.before) + push.partial.append;
    }
  }
  return { text, gaps };
}

describe('a message told as it is written, by both (M19: V20; C3, C4, C14, C15)', () => {
  /** How one item reached the page: opened as it is written, any number of pieces, then complete. */
  function reached(side: Run, itemId: string): { readonly first: string | undefined; readonly last: string | undefined; readonly between: readonly string[] } {
    const kinds = shapeOf(pushesOf(side.pushes, itemId));
    return { first: kinds[0], last: kinds.at(-1), between: kinds.slice(1, -1) };
  }

  it.each(['basic', 'worker'] as const)('%s: each provider’s messages open, grow and complete, and the page is pushed and reads the same of both', async (kind) => {
    const { codex, claude } = await both(kind);

    for (const [name, side] of [['codex', codex], ['claude', claude]] as const) {
      // Each message is told in deltas, opened before its first text and completed by its whole message.
      // The session's own: a worker's messages are told the same way, under its id (M20a, C20), and reach its tab.
      const deltas = side.events.flatMap((event) => (event.type === 'message-delta' && event.workerId === undefined ? [event] : []));
      const wholes = side.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' && event.workerId === undefined ? [event] : []));
      expect(wholes.length, name).toBeGreaterThan(0);
      for (const whole of wholes) {
        const mine = deltas.filter((delta) => delta.itemId === whole.itemId);
        // Its phase as far as the provider knows it at its opening: the whole message's, or none said yet (difference 9).
        expect(mine[0], name).toMatchObject({ text: '' });
        expect([whole.phase, null], name).toContain(mine[0]?.phase);
        expect(mine.map((delta) => delta.text).join(''), name).toBe(whole.text);
        expect(side.events.indexOf(whole), name).toBeGreaterThan(side.events.indexOf(mine.at(-1) as AgentEvent));
      }
      // As the page was pushed it: streaming at its opening, its pieces, then complete — never partial,
      // every turn here having ended as its provider said. How many pieces there are is each capture's
      // own length against the 50 ms between two pushes: a short text can complete before any.
      for (const item of side.read.items.filter((entry) => entry.role === 'assistant')) {
        const { first, last, between } = reached(side, item.id);
        expect([first, last], name).toEqual(['item:streaming', 'item:complete']);
        expect(between.every((push) => push === 'partial'), name).toBe(true);
        // The pieces follow one another with nothing missing, and the whole message's text is what stands.
        expect(pushedText(side.pushes, item.id), name).toEqual({ text: itemText(item), gaps: 0 });
        expect(item.state, name).toBe('complete');
      }
    }

    // The answer reached the page the same way from each, and reads the same at the end.
    const answer = (side: Run) => side.read.items.findLast((item) => item.role === 'assistant');
    expect([reached(claude, answer(claude)?.id ?? '').first, reached(claude, answer(claude)?.id ?? '').last]).toEqual([reached(codex, answer(codex)?.id ?? '').first, reached(codex, answer(codex)?.id ?? '').last]);
    expect(answer(claude)).toMatchObject({ phase: 'final', state: 'complete' });
    expect(answer(codex)).toMatchObject({ phase: 'final', state: 'complete' });
    expect(items(claude.read)).toEqual(items(codex.read));
    const told = (side: Run) => side.read.items.filter((item) => item.kind !== 'activity' && item.phase !== 'commentary').map((item) => item.state);
    expect(told(claude)).toEqual(told(codex));
    expect(turns(claude.read)).toEqual(turns(codex.read));
  }, 120_000);

  it('DIFFERENCES 8 and 9: whose id a streamed message has, and its phase while it is written', async () => {
    const { codex, claude } = await both('basic');
    const opening = (side: Run) => side.events.filter((event) => event.type === 'message-delta' && event.text === '');
    // Claude: the reply's id and the block's index, and no phase said while it is written; whole, commentary, until the end names the answer.
    expect(opening(claude).every((event) => event.type === 'message-delta' && /#\d+$/.test(event.itemId) && event.phase === null)).toBe(true);
    expect(claude.events.filter((event) => event.type === 'message-delta').every((event) => event.type === 'message-delta' && event.phase === null)).toBe(true);
    expect(claude.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [event.phase] : []))).toEqual(['commentary']);
    expect(claude.events.find((event) => event.type === 'turn-ended')).toMatchObject({ answerItemId: opening(claude).at(-1)?.type === 'message-delta' ? (opening(claude).at(-1) as { itemId: string }).itemId : '' });
    // Codex: the item's own id, and `final` from its answer's start.
    expect(opening(codex).some((event) => event.type === 'message-delta' && event.itemId.includes('#'))).toBe(false);
    expect(opening(codex).at(-1)).toMatchObject({ phase: 'final' });
    expect(codex.events.find((event) => event.type === 'turn-ended')).not.toHaveProperty('answerItemId');
  }, 120_000);

  it('interrupt: no answer is named by either, and a text the Stop cut is left unfinished, never completed (DIFFERENCE 10)', async () => {
    const { codex, claude } = await both('interrupt');
    for (const side of [codex, claude]) {
      expect(side.read.items.filter((item) => item.role === 'assistant' && item.phase === 'final')).toEqual([]);
      // Nothing is left being written, and no whole message came for a text that was.
      expect(side.read.items.some((item) => item.state === 'streaming')).toBe(false);
      const cut = side.read.items.filter((item) => item.role === 'assistant' && item.state !== 'complete');
      expect(cut.every((item) => item.state === 'partial')).toBe(true);
      for (const item of cut) expect(pushesOf(side.pushes, item.id)).not.toContain('item:complete');
    }
    // Claude's capture was writing a text when its Stop came: the CLI's frame with it is taken for the
    // text alone, and it stays unfinished, with no phase (C79, C80). Codex's was stopped before any text.
    expect(claude.read.items.filter((item) => item.role === 'assistant').map((item) => [item.phase, item.state])).toEqual([[null, 'partial']]);
    expect(codex.read.items.filter((item) => item.role === 'assistant' && item.state !== 'complete')).toEqual([]);
  }, 120_000);
});

describe('DIFFERENCES: what each CLI says in its own way (V15; C74, C75, C87)', () => {
  const types = (side: Run): string[] => side.events.map((event) => event.type);
  const of = <T extends AgentEvent['type']>(side: Run, type: T): Extract<AgentEvent, { type: T }>[] => side.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);

  it('32, on a basic turn: both readings reach the summary in one shape; Claude’s with its line and its parts, Codex’s with neither', async () => {
    const { codex, claude } = await both('basic');
    for (const side of [codex, claude]) {
      expect(side.summary.context?.used).toBeGreaterThan(0);
      expect(side.events.some((event) => event.type === 'context')).toBe(true);
    }
    expect(claude.summary.context?.compactAt).toBe(967_000);
    expect(claude.summary.context?.parts?.length).toBeGreaterThan(0);
    expect(codex.summary.context).not.toHaveProperty('compactAt');
    expect(codex.summary.context).not.toHaveProperty('parts');
    // Nothing of it is the chat's: no item, and no push, says it.
    for (const side of [codex, claude]) expect(JSON.stringify(side.read)).not.toContain('compactAt');
  });

  it('1 to 5 and 7, on a basic turn: when the reference comes, how the answer is told, and whose ids the turn and the user’s message have', async () => {
    const { codex, claude } = await both('basic');

    // 1. Codex: with the turn's start. Claude: at its first frame from a model, before anything of that frame is shown.
    expect(types(codex).indexOf('session-started')).toBe(types(codex).indexOf('turn-started') + 1);
    expect(types(claude).indexOf('session-started')).toBeGreaterThan(types(claude).indexOf('turn-started'));
    expect(types(claude).indexOf('session-started')).toBeLessThan(Math.min(...['action-changed', 'message'].map((type) => types(claude).indexOf(type)).filter((index) => index >= 0)));
    // Either way the record holds it once the turn is over.
    for (const side of [codex, claude]) expect(side.record['reference']).toBe(of(side, 'session-started')[0]?.reference);

    // 2. Codex labels the answer as it sends it, and its end names none; Claude's end names it.
    expect(of(codex, 'message').filter((event) => event.role === 'assistant').at(-1)?.phase).toBe('final');
    expect(of(codex, 'turn-ended')[0]?.answerItemId).toBeUndefined();
    const texts = of(claude, 'message').filter((event) => event.role === 'assistant');
    expect(texts.every((event) => event.phase === 'commentary')).toBe(true);
    expect(of(claude, 'turn-ended')[0]?.answerItemId).toBe(texts.at(-1)?.itemId);
    // The stored answer is the same thing in both.
    for (const side of [codex, claude]) expect(side.read.items.at(-1)).toMatchObject({ role: 'assistant', phase: 'final' });

    // 3. The user's message: echoed by Codex under its own id, never by Claude.
    expect(of(codex, 'message').filter((event) => event.role === 'user')).toHaveLength(1);
    expect(of(claude, 'message').filter((event) => event.role === 'user')).toHaveLength(0);
    expect(typeof codex.read.items[0]?.providerItemId).toBe('string');
    expect(claude.read.items[0]?.providerItemId).toBeNull();

    // 4. The turn's own id.
    expect(typeof of(codex, 'turn-started')[0]?.providerTurnId).toBe('string');
    expect(of(claude, 'turn-started')[0]?.providerTurnId).toBeUndefined();

    // 5. What is in force. Each says the mode its process confirmed, by fat-g's id for it, before the
    // turn (M22, C2): the one thing both say here. Claude then says which model answers; Codex says no more.
    const inForce = (side: Run) => of(side, 'in-force').map((event) => ({ mode: event.mode, model: typeof event.model }));
    expect(inForce(claude)).toEqual([{ mode: 'ask-first', model: 'undefined' }, { mode: undefined, model: 'string' }]);
    expect(inForce(codex)).toEqual([{ mode: 'ask-first', model: 'undefined' }]);

    // 7. The earlier conversation.
    expect(codex.read.history.state).toBe('checked');
    expect(claude.read.history.state).toBe('unsupported');
  }, 120_000);

  it('1, on a turn no model answered: Codex’s session is named all the same, Claude’s is not, and reads as not started', async () => {
    const { codex, claude } = await both('failure');
    expect(types(codex)).toContain('session-started');
    expect(types(claude)).not.toContain('session-started');
    expect(typeof codex.record['reference']).toBe('string');
    expect(claude.record['reference']).toBeNull();
    expect(codex.summary.status).toBe('idle');
    expect(claude.summary.status).toBe('not-started');
  }, 120_000);

  it('6, on a worker: Claude’s is shown under its own description, Codex’s under its number', async () => {
    const { codex, claude } = await both('worker');
    expect(of(codex, 'worker-started')[0]?.description).toBeUndefined();
    expect(typeof of(claude, 'worker-started')[0]?.description).toBe('string');
    expect(codex.summary.agents[0]?.label).toBe('Worker 1');
    expect(claude.summary.agents[0]?.label).toBe(of(claude, 'worker-started')[0]?.description);
    // No text of a worker is in either chat: every message is the user's or the session's own (C36),
    // and every item the session's (M20a, C22).
    for (const side of [codex, claude]) {
      expect(side.read.items.filter((item) => item.kind !== 'activity').every((item) => item.role === 'user' || item.role === 'assistant')).toBe(true);
      expect(side.read.items.every((item) => item.workerId === null)).toBe(true);
    }
  }, 120_000);
});

// ── M20a: what a session does, and what its worker does ───────────────────────────────────────

/** An activity as the page reads it, by what it is: the item's fields and its body's. What it holds — a name, a line, an input — is each CLI's own. */
function activities(items: readonly ConversationItem[]): unknown[] {
  return items.filter((item) => item.kind === 'activity').map((item) => ({
    kind: item.kind, role: item.role, phase: item.phase, notice: item.notice, origin: item.origin, state: item.state, blocks: item.blocks.length,
    fields: Object.keys(item).sort(), body: Object.keys(item.activity ?? {}).sort(), type: item.activity?.type, status: item.activity?.status,
    summary: typeof item.activity?.summary, duration: typeof item.activity?.duration?.ms, named: typeof item.providerItemId,
  }));
}
/** The fields every provider gives of an activity's two events; the rest are each type's own, and each CLI's (11 to 13). */
const STARTED = ['type', 'turnId', 'itemId', 'activityType', 'name', 'summary'];
const ENDED = ['type', 'turnId', 'itemId', 'status'];

describe('what a session does between its messages, by both (M20a: V15; C26)', () => {
  const of = <T extends AgentEvent['type']>(side: Run, type: T): Extract<AgentEvent, { type: T }>[] => side.events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
  const done = (side: Run): ConversationItem[] => side.read.items.filter((item) => item.kind === 'activity');

  it('basic: a read is the same item from each, started and then ended, and pushed as it runs', async () => {
    const { codex, claude } = await both('basic');
    expect(activities(claude.read.items)).toEqual(activities(codex.read.items));
    expect(activities(codex.read.items)).toMatchObject([{ kind: 'activity', role: null, notice: null, origin: 'local', state: 'complete', type: 'read', status: 'completed', duration: 'number', named: 'string' }]);
    for (const [name, side] of [['codex', codex], ['claude', claude]] as const) {
      // One start and one end of it, each with the fields every provider gives, the end under the start's id.
      const [started] = of(side, 'activity-started');
      const [ended] = of(side, 'activity-ended');
      expect([of(side, 'activity-started').length, of(side, 'activity-ended').length], name).toEqual([1, 1]);
      expect(Object.keys(started ?? {}), name).toEqual(expect.arrayContaining(STARTED));
      expect(Object.keys(ended ?? {}), name).toEqual(expect.arrayContaining(ENDED));
      expect(ended?.itemId, name).toBe(started?.itemId);
      expect(started?.workerId ?? ended?.workerId, name).toBeUndefined();
      // The item it is filed as has the provider's id for it, between the turn's start and its end.
      const [item] = done(side);
      expect(item?.providerItemId, name).toBe(started?.itemId);
      expect(side.events.indexOf(started as AgentEvent), name).toBeGreaterThan(side.events.findIndex((event) => event.type === 'turn-started'));
      expect(side.events.indexOf(ended as AgentEvent), name).toBeLessThan(side.events.findIndex((event) => event.type === 'turn-ended'));
      // As the page was pushed it, by shape and not by order (C26): as it runs, then ended.
      expect([...new Set(pushesOf(side.pushes, item?.id ?? ''))].sort(), name).toEqual(['item:complete', 'item:streaming']);
      // Before the answer in the chat, as it was in the turn.
      expect(side.read.items.indexOf(item as ConversationItem), name).toBeLessThan(side.read.items.findIndex((entry) => entry.phase === 'final'));
    }
  }, 120_000);

  it('worker: each files its worker’s work under the worker’s id, with the item that started it in the session’s own chat', async () => {
    const { codex, claude } = await both('worker');
    for (const [name, side] of [['codex', codex], ['claude', claude]] as const) {
      const [worker] = of(side, 'worker-started');
      // The session's own chat has the one item that started it, paired with the worker and ended as the worker ended.
      const launched = done(side).filter((item) => item.activity?.type === 'worker');
      expect(launched, name).toHaveLength(1);
      expect(launched[0], name).toMatchObject({ workerId: null, state: 'complete', activity: { status: 'completed', workerId: worker?.workerId } });
      // Its label is the agent list's (M14, C113).
      expect(launched[0]?.activity?.summary, name).toBe(side.summary.agents[0]?.label);
      // What the worker did and said is read by its id, and names it; none of it is in the session's chat.
      expect(side.workers, name).toHaveLength(1);
      const [theirs] = side.workers;
      expect(theirs, name).toMatchObject({ workerId: worker?.workerId, worker: { id: launched[0]?.id }, older: null });
      expect(theirs?.items.length, name).toBeGreaterThan(0);
      expect(theirs?.items.every((item) => item.workerId === worker?.workerId && (item.kind === 'activity' || item.role === 'assistant')), name).toBe(true);
      expect(theirs?.items.every((item) => item.state === 'complete'), name).toBe(true);
      expect(side.read.items.some((item) => theirs?.items.some((other) => other.id === item.id)), name).toBe(false);
      // In the turn that started it.
      expect(theirs?.turns.map((turn) => turn.id), name).toEqual([side.read.turns[0]?.id]);
      // Every event of the worker's names it, and that turn.
      const events = side.events.filter((event) => 'workerId' in event && event.workerId !== undefined && event.type !== 'worker-started' && event.type !== 'worker-ended' && event.type !== 'worker-progressed' && event.type !== 'worker-model');
      expect(events.length, name).toBeGreaterThan(0);
      const turnId = of(side, 'turn-started')[0]?.turnId;
      expect(events.every((event) => 'workerId' in event && event.workerId === worker?.workerId && 'turnId' in event && event.turnId === turnId), name).toBe(true);
    }
    // The same shapes from each: the item that started the worker, and each kind of item the worker's read holds.
    const launch = (side: Run) => activities(done(side).filter((item) => item.activity?.type === 'worker'));
    expect(launch(claude)).toEqual(launch(codex));
    const kinds = (side: Run) => Object.fromEntries(side.workers[0]?.items.map((item) => [item.kind === 'activity' ? 'activity' : `message:${item.phase === null ? 'none' : 'said'}`, Object.keys(item).sort()]) ?? []);
    const shared = (mine: Record<string, string[]>, theirs: Record<string, string[]>) => Object.fromEntries(Object.entries(mine).filter(([kind]) => kind in theirs));
    expect(shared(kinds(claude), kinds(codex))).toEqual(shared(kinds(codex), kinds(claude)));
    expect(Object.keys(shared(kinds(claude), kinds(codex))).length).toBeGreaterThan(0);
  }, 120_000);

  it('DIFFERENCES 11 to 13: an activity’s name, its times, and how a file is read', async () => {
    const { codex, claude } = await both('basic');
    const [mine] = done(codex);
    const [theirs] = done(claude);
    // 11. The item's type, and the tool's name.
    expect(mine?.activity?.name).toBe('commandExecution');
    expect(theirs?.activity?.name).toBe('Read');
    // 12. Codex's own start and duration; fat-g's between Claude's two frames.
    expect(of(codex, 'activity-ended')[0]).toMatchObject({ durationMs: expect.any(Number) as number });
    expect(mine?.activity?.duration?.provenance).toBe('provider');
    expect(of(claude, 'activity-started')[0]?.providerAt ?? of(claude, 'activity-ended')[0]?.durationMs).toBeUndefined();
    expect(theirs?.activity?.duration?.provenance).toBe('local');
    expect(theirs?.time.providerAt).toBeNull();
    // 13. A command, with its line and its exit code; a tool, with its input and its result.
    expect(mine?.activity).toMatchObject({ input: expect.stringContaining('sample.txt') as string, exitCode: 0 });
    expect(theirs?.activity).toMatchObject({ input: expect.stringContaining('file_path') as string, exitCode: null, output: expect.stringContaining('Biscuit') as string });
    // Either way the file it read is named, for the control that opens it (C38).
    // By its last part, whichever separator the CLI wrote on the system its capture was taken on.
    for (const item of [mine, theirs]) expect(item?.activity?.files.map((file) => fileName(file.path))).toEqual(['sample.txt']);
  }, 120_000);

  it('DIFFERENCE 14: Claude’s worker item is told at its tool use and again once paired, with what the worker is asked, and its notification brings the report; Codex’s is told once, paired from its start', async () => {
    const { codex, claude } = await both('worker');
    const launches = (side: Run) => of(side, 'activity-started').filter((event) => event.activityType === 'worker' && event.workerId === undefined);
    const worker = (side: Run) => of(side, 'worker-started')[0]?.workerId;
    expect(launches(codex).map((event) => event.pairedWorkerId)).toEqual([worker(codex)]);
    expect(launches(codex)[0]?.input).toBeUndefined();
    // Claude's is told a third time once its worker's first frame names the model it runs on (M106, C14); Codex's names it at the start, where it does.
    expect(launches(claude).map((event) => event.pairedWorkerId)).toEqual([undefined, worker(claude), worker(claude)]);
    expect(typeof launches(claude)[2]?.model).toBe('string');
    expect(of(claude, 'worker-model').map((event) => event.workerId)).toEqual([worker(claude)]);
    expect(of(codex, 'worker-model')).toEqual([]);
    expect(new Set(launches(claude).map((event) => event.itemId)).size).toBe(1);
    expect(typeof launches(claude)[0]?.input).toBe('string');
    // Either way one item, ended as its worker ended and before the worker's own end is told (M20a, C23).
    const ends = (side: Run) => of(side, 'activity-ended').filter((event) => event.itemId === launches(side)[0]?.itemId);
    for (const side of [codex, claude]) {
      expect(ends(side)[0]?.status).toBe('completed');
      expect(side.events.indexOf(ends(side)[0] as AgentEvent)).toBeLessThan(side.events.findIndex((event) => event.type === 'worker-ended'));
    }
    expect(ends(codex)).toHaveLength(1);
    // Claude's second closing frame, the notification, ends it again with the worker's report and the CLI's duration.
    expect(ends(claude).map((event) => [event.status, typeof event.output])).toEqual([['completed', 'undefined'], ['completed', 'string']]);
    const item = (side: Run) => done(side).find((entry) => entry.activity?.type === 'worker');
    expect(typeof item(claude)?.activity?.output).toBe('string');
    expect(item(codex)?.activity?.output).toBeNull();
    // And a Codex session waits for its worker by an item of its own, which Claude's has none of.
    expect(done(codex).some((entry) => entry.activity?.type === 'wait')).toBe(true);
    expect(done(claude).some((entry) => entry.activity?.type === 'wait')).toBe(false);
  }, 120_000);

  it('DIFFERENCE 15: a checklist is Codex’s, where the user’s configuration enables its tool; Claude’s launch offers none', async () => {
    // No capture of either has one under the launches fat-g makes: Codex's tool is off unless the
    // user's own configuration enables it (tests/codex/activity.integration.test.ts runs that one).
    for (const kind of ['basic', 'worker'] as const) {
      const { codex, claude } = await both(kind);
      for (const side of [codex, claude]) expect(of(side, 'activity-started').some((event) => event.activityType === 'checklist')).toBe(false);
    }
    expect(CHAT_TOOLS).not.toContain('TodoWrite');
  }, 240_000);
});

// ── M20b: a question beside a session ─────────────────────────────────────────────────────────

describe('a question asked beside a session, by both (M20b: V15; C24–C26)', () => {
  const ASIDE = 'a51de000-0000-4000-8000-000000000001';
  interface Captured { readonly index?: number; readonly dir: string; readonly frame: { id?: number; method?: string; request?: { subtype?: string; question?: string }; params?: { threadId?: string; input?: { text: string }[] }; result?: { thread?: { id?: string } } } }
  const frames = (provider: 'claude' | 'codex', name: string): Captured[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures', provider, 'captures', `${name}.json`), 'utf8')) as { frames: Captured[] }).frames;
  /** K1's side question of an idle session, for the folder the session runs in. */
  const claudeQuestion = (folder: string): string => String(frames('claude', 'm20b-idle').find((entry) => entry.dir === 'send' && entry.frame.request?.subtype === 'side_question')?.frame.request?.question).replaceAll('<scratch>', folder);
  /** K3's question to a side thread, of the capture named: the one that answered at once, or the one whose side thread read a file. */
  function codexQuestion(name: string): string {
    const all = frames('codex', name);
    const forks = all.filter((entry) => entry.dir === 'send' && entry.frame.method === 'thread/fork').map((entry) => entry.frame.id);
    const children = new Set(all.flatMap((entry) => (entry.dir === 'recv' && forks.includes(entry.frame.id) && typeof entry.frame.result?.thread?.id === 'string' ? [entry.frame.result.thread.id] : [])));
    return String(all.find((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start' && children.has(entry.frame.params?.threadId ?? ''))?.frame.params?.input?.[0]?.text);
  }

  interface Asked {
    readonly capability: AsideCapability;
    /** The session's chat, its record and its summary before the ask, and after the aside's turn ended. */
    readonly before: { readonly read: ChatRead; readonly record: Record<string, unknown>; readonly summary: unknown };
    readonly after: { readonly read: ChatRead; readonly record: Record<string, unknown>; readonly summary: unknown };
    readonly aside: ChatAsideRead;
    /** The events that name the aside, and those that do not, from the ask on. */
    readonly events: readonly AgentEvent[];
    readonly own: readonly AgentEvent[];
    /** The pushes that name the aside. */
    readonly pushes: readonly ChatPush[];
  }

  /** A session that holds one turn, asked one question beside it, through the app's session side. */
  async function asked(provider: AgentProvider, facet: SessionFacet, dir: string, folder: string, prompt: string, model: string, question: string): Promise<Asked> {
    const { id } = provider.descriptor;
    const data = path.join(dir, 'records');
    placeRecords(data, folder, id, [sessionEntry(1, id, { model })]);
    const events: AgentEvent[] = [];
    const app = launchApp({ dir: data, descriptor: provider.descriptor, facet: () => recording(facet, events), userDefault: CAPTURED_MODE });
    disposers.push(() => app.quit());
    expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
    await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 30_000);
    await app.service.settled();
    // Claude refreshes its context after the turn ends (0033). Wait for the fixture's whole
    // reading before taking the baseline, so that reply cannot look like a change from the aside.
    if (id === 'claude') await until(() => app.summary(1)?.context?.used === 23_605, 'the post-turn context reading');
    const state = () => ({ read: app.read(1), record: storedSession(data, 1) as Record<string, unknown>, summary: app.summary(1) });
    const before = state();
    const from = events.length;
    const pushed = app.pushes.length;
    expect(await app.runtime.ask({ sessionId: S(1), asideId: ASIDE, text: question })).toEqual({ status: 'accepted', asideId: ASIDE });
    const read = (): ChatAsideRead | null => { const answer = app.runtime.readAside(S(1), ASIDE); return answer.status === 'read' ? answer : null; };
    await until(() => { const answer = read(); return answer !== null && !answer.aside.running && answer.turns.length === 1 && answer.turns[0]?.state === 'ended'; }, 'the aside’s turn ending', 30_000);
    await app.service.settled();
    const told = events.slice(from);
    const named = (event: AgentEvent): boolean => 'asideId' in event && event.asideId === ASIDE;
    return {
      capability: provider.descriptor.capabilities.asides, before, after: state(), aside: read() as ChatAsideRead,
      events: told.filter(named), own: told.filter((event) => !named(event)), pushes: app.pushes.slice(pushed).filter((push) => push.asideId === ASIDE),
    };
  }

  async function bothAsked(codexCapture = 'm20b-fork-followup'): Promise<{ codex: Asked; claude: Asked }> {
    const codexSide = await codexHarness();
    disposers.push(() => codexSide.dispose());
    const claudeSide = await claudeHarness();
    disposers.push(() => claudeSide.dispose());
    const codex = await asked(codexSide.provider, codexSide.facet, codexSide.dir, codexSide.project, PROMPTS.t1, 'gpt-6-astra', codexQuestion(codexCapture));
    const claude = await asked(claudeSide.provider, claudeSide.facet, claudeSide.dir, claudeSide.project, claudeSide.prompts.t1, 'sonnet', claudeQuestion(claudeSide.project));
    return { codex, claude };
  }

  /** An aside's course as both providers must give it: a turn, an answer, an end. What it did on the way, and how its text arrived, is each route's own. */
  const asideCourse = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => {
    if (event.type === 'turn-started') return ['turn-started'];
    if (event.type === 'message' && event.role === 'assistant' && event.phase === 'final') return ['answer'];
    if (event.type === 'notice') return [`notice:${event.kind}`];
    if (event.type === 'turn-ended') return [`turn-ended:${event.outcome}:${event.reported ? 'reported' : 'own'}:${event.failure ?? 'none'}`];
    return [];
  });
  /** An aside's items as its tab reads them, each by what it is: its question, and its answer. What a side thread did, and said on the way, is left out here and looked at below. */
  const asideItems = (read: ChatAsideRead): unknown[] => read.items.filter((item) => item.kind !== 'activity' && (item.role !== 'assistant' || item.phase === 'final')).map((item) => ({
    kind: item.kind, role: item.role, phase: item.phase, notice: item.notice, origin: item.origin, state: item.state, conversation: item.conversationId === ASIDE ? 'the aside’s' : 'another', workerId: item.workerId,
    blocks: item.blocks.map((block) => block.type), fields: Object.keys(item).sort(), text: itemText(item).trim() === '' ? 'empty' : 'some',
  }));

  it('the same course, items and turn from each: a turn of the aside’s own, its question, an answer, an end the provider reported', async () => {
    const { codex, claude } = await bothAsked();
    const course = ['turn-started', 'answer', 'turn-ended:completed:reported:none'];
    expect(asideCourse(codex.events)).toEqual(course);
    expect(asideCourse(claude.events)).toEqual(course);
    // Every event of it names the aside's own turn, from each.
    for (const side of [codex, claude]) expect(new Set(side.events.flatMap((event) => ('turnId' in event ? [event.turnId] : []))).size).toBe(1);
    // What its tab reads: the question as it was typed, then the answer, under one ended turn.
    expect(asideItems(claude.aside)).toEqual(asideItems(codex.aside));
    expect(asideItems(codex.aside)).toMatchObject([{ role: 'user', origin: 'local', text: 'some' }, { role: 'assistant', phase: 'final', state: 'complete', text: 'some' }]);
    expect(turns({ turns: claude.aside.turns } as ChatRead)).toMatchObject([{ place: 1, state: 'ended', outcome: 'completed' }]);
    expect(turns({ turns: codex.aside.turns } as ChatRead)).toMatchObject([{ place: 1, state: 'ended', outcome: 'completed' }]);
    // The aside itself, as its read answers it: asked freely, titled by its question, no longer running.
    for (const side of [codex, claude]) expect(side.aside.aside).toMatchObject({ id: ASIDE, source: null, running: false });
    expect(Object.keys(claude.aside.aside).sort()).toEqual(Object.keys(codex.aside.aside).sort());
    // Both were pushed its question and its answer as items that name it, under the session's id.
    for (const side of [codex, claude]) {
      const pushedItems = side.pushes.flatMap((push) => ('item' in push ? [push.item] : []));
      expect(pushedItems.filter((item) => item.role === 'user')).toHaveLength(1);
      expect(pushedItems.some((item) => item.role === 'assistant' && item.phase === 'final' && item.state === 'complete')).toBe(true);
      expect(side.pushes.every((push) => push.sessionId === S(1))).toBe(true);
    }
  }, 120_000);

  it('the session’s own conversation, its record and its summary are as they were, from each: nothing of an aside is the session’s (C4, C33)', async () => {
    const { codex, claude } = await bothAsked();
    for (const side of [codex, claude]) {
      expect(side.after.read.items).toEqual(side.before.read.items);
      expect(side.after.read.turns).toEqual(side.before.read.turns);
      expect(side.after.record).toEqual(side.before.record);
      expect(side.after.summary).toEqual(side.before.summary);
      // But for its list of asides, which names this one — by a marker with no text of it.
      expect(side.before.read.asides).toEqual([]);
      expect(side.after.read.asides).toMatchObject([{ id: ASIDE, source: null, running: false }]);
      // No event of the session's own was told for it: no turn, no reference, no status.
      expect(side.own).toEqual([]);
    }
    expect(Object.keys(claude.after.read.asides[0] ?? {}).sort()).toEqual(Object.keys(codex.after.read.asides[0] ?? {}).sort());
  }, 120_000);

  it('DIFFERENCES 17 to 19: how the answer arrives, what the aside did, and whose model answered — each as its descriptor declares', async () => {
    // Codex's capture here is the one whose side thread read a file to answer.
    const { codex, claude } = await bothAsked('m20b-fork-read');
    expect(codex.capability).toEqual({ followUp: true, streamed: true, tools: 'read-only' });
    expect(claude.capability).toEqual({ followUp: true, streamed: false, tools: 'none' });
    // 17. Codex's answer is pushed as it is written: opened while it streams, then complete, with as many
    // pieces between as its length gives against the 50 ms between two pushes — a short one completes
    // before any, so their number is no part of this. Claude's is pushed whole, once.
    const answers = (side: Asked) => side.aside.items.filter((item) => item.kind === 'message' && item.role === 'assistant');
    const reached = (side: Asked): string[][] => answers(side).map((item) => shapeOf(pushesOf(side.pushes, item.id)));
    expect(answers(codex).length).toBeGreaterThan(0);
    for (const kinds of reached(codex)) {
      expect([kinds[0], kinds.at(-1)]).toEqual(['item:streaming', 'item:complete']);
      expect(kinds.slice(1, -1).every((kind) => kind === 'partial')).toBe(true);
    }
    expect(reached(claude)).toEqual([['item:complete']]);
    expect(codex.events.some((event) => event.type === 'message-delta')).toBe(true);
    expect(claude.events.some((event) => event.type === 'message-delta')).toBe(false);
    // 18. What Codex's side thread read is an activity of the aside's own, ended; Claude's side question did nothing.
    const did = (side: Asked) => side.aside.items.filter((item) => item.kind === 'activity');
    expect(did(codex).length).toBeGreaterThan(0);
    expect(did(codex).every((item) => item.conversationId === ASIDE && item.workerId === null && item.activity?.status !== 'running')).toBe(true);
    expect(did(claude)).toEqual([]);
    expect(claude.events.some((event) => event.type === 'activity-started')).toBe(false);
    // And none of it is among the session's own items.
    expect(codex.after.read.items.filter((item) => item.kind === 'activity')).toEqual(codex.before.read.items.filter((item) => item.kind === 'activity'));
    // 19. Neither capture's answer names another model: each is labelled by the session's own.
    for (const side of [codex, claude]) expect(side.aside.items.every((item) => item.model === null)).toBe(true);
    // The course is the same all the same.
    expect(asideCourse(codex.events)).toEqual(asideCourse(claude.events));
  }, 120_000);
});

describe('a question a session asks as a request, by both (M21: V13; C30)', () => {
  interface Asked {
    readonly capability: string;
    readonly events: readonly AgentEvent[];
    /** The card while it waited, with the session's summary then; and the same card once the session came to rest. */
    readonly pending: ConversationItem;
    readonly waiting: ReturnType<App['summary']>;
    readonly settled: ConversationItem;
    readonly read: ChatRead;
    readonly pushes: readonly ChatPush[];
    readonly summary: ReturnType<App['summary']>;
    readonly record: Record<string, unknown>;
  }
  // A question's card: Codex's capture is a plan turn, whose plan is a line of its own since M22b (C14), an interaction too.
  const cardsOf = (read: ChatRead): ConversationItem[] => read.items.filter((item) => questionOf(item) !== null);

  /**
   * A turn that asks, as a first turn of a new session through the app's session side: answered
   * from its card with the last option of each question, as each capture was, or stopped while it waits.
   */
  async function asked(provider: AgentProvider, facet: SessionFacet, dir: string, folder: string, prompt: string, model: string, how: 'answer' | 'stop'): Promise<Asked> {
    const { id } = provider.descriptor;
    const data = path.join(dir, 'records');
    placeRecords(data, folder, id, [sessionEntry(1, id, { model })]);
    const events: AgentEvent[] = [];
    const app = launchApp({ dir: data, descriptor: provider.descriptor, facet: () => recording(facet, events), userDefault: CAPTURED_MODE });
    disposers.push(() => app.quit());
    expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
    const pending = await until(() => cardsOf(app.read(1))[0], 'the card', 30_000);
    const waiting = app.summary(1);
    if (how === 'stop') expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    else expect(await app.runtime.answer(S(1), pending.id, (questionOf(pending)?.questions ?? []).map((question, place) => ({ question: place, options: [question.options.length - 1], text: null })))).toEqual({ status: 'answered' });
    await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 30_000);
    await app.service.settled();
    const read = app.read(1);
    const settled = cardsOf(read)[0];
    const record = storedSession(data, 1);
    if (settled === undefined || record === undefined) throw new Error('the card or the session is gone');
    return { capability: provider.descriptor.capabilities.questions, events, pending, waiting, settled, read, pushes: [...app.pushes], summary: app.summary(1), record };
  }

  async function bothAsked(how: 'answer' | 'stop'): Promise<{ codex: Asked; claude: Asked }> {
    const codexSide = await codexHarness();
    disposers.push(() => codexSide.dispose());
    const claudeSide = await claudeHarness();
    disposers.push(() => claudeSide.dispose());
    // K2's turn that asks through a request, which the fake plays for its prompt under the app's ordinary turn (C24); and K1's.
    const codex = await asked(codexSide.provider, codexSide.facet, codexSide.dir, codexSide.project, PROMPTS.plan, 'gpt-6-astra', how);
    const claude = await asked(claudeSide.provider, claudeSide.facet, claudeSide.dir, claudeSide.project, claudeSide.prompts.question, 'sonnet', how);
    return { codex, claude };
  }

  /** A question's course as both providers must give it: raised in its turn, what became of it, the turn's end. What the turn said and did around it is each capture's own. */
  const questionCourse = (events: readonly AgentEvent[]): string[] => events.flatMap((event) => {
    if (event.type === 'turn-started') return ['turn-started'];
    if (event.type === 'question-raised') return [`question-raised:${event.workerId === undefined ? 'the session’s' : 'a worker’s'}`];
    if (event.type === 'question-resolved') return [`question-resolved:${event.reason}`];
    if (event.type === 'notice') return [`notice:${event.kind}`];
    if (event.type === 'turn-ended') return [`turn-ended:${event.outcome}:${event.reported ? 'reported' : 'own'}:${event.failure ?? 'none'}`];
    return [];
  });
  /** The keys of each question event, from each. */
  const questionFields = (events: readonly AgentEvent[]): Record<string, string[]> => Object.fromEntries(events.filter((event) => event.type === 'question-raised' || event.type === 'question-resolved').map((event) => [event.type, Object.keys(event).sort()]));
  /** The card as the page reads it, by what it is: its fields, its body's, and what became of it. What it asks is its capture's own, held to its shape alone. */
  const cardShape = (item: ConversationItem): unknown => {
    const body = questionOf(item);
    return {
      kind: item.kind, role: item.role, phase: item.phase, notice: item.notice, origin: item.origin, state: item.state, workerId: item.workerId, named: typeof item.providerItemId,
      blocks: item.blocks.map((block) => block.type), fields: Object.keys(item).sort(), body: Object.keys(item.interaction ?? {}).sort(),
      mode: body?.mode, outcome: body?.outcome, withdrawnBy: body?.withdrawnBy, answeredBy: body?.answeredBy, cut: body?.cut,
      answers: (body?.answers ?? null)?.map((answer) => (answer === null ? null : { chosen: answer.options.length, text: answer.text, secret: answer.secret })) ?? null,
      settled: body?.settledAt === null ? 'none' : 'known', confirmed: body?.confirmedAt === null ? 'none' : 'known',
      questions: (body?.questions ?? []).map((question) => ({ fields: Object.keys(question).sort(), multiple: question.multiple, secret: question.secret, option: [...new Set(question.options.map((option) => Object.keys(option).sort().join()))] })),
    };
  };
  /** Each push of the card, by what it said of it. */
  const cardPushes = (side: Asked): string[] => side.pushes.flatMap((push) => ('item' in push && push.item.id === side.pending.id ? [`${push.item.interaction?.outcome ?? 'none'}:${push.item.interaction?.confirmedAt === null ? 'unmarked' : 'marked'}`] : []));
  const words = (item: ConversationItem): string | null => (item.interaction === null ? null : outcomeWords(item.interaction, false));
  const shown = (summary: Asked['summary']): unknown => ({ status: summary?.status, attention: summary?.attention === null || summary === undefined ? null : { kind: summary.attention.kind, count: summary.attention.count }, action: summary?.action ?? null });

  it('answered: the same course, card, turn and summary from each — raised under its turn, waiting with the attention on it, answered from the card, confirmed by the CLI, the turn completing', async () => {
    const { codex, claude } = await bothAsked('answer');
    const course = ['turn-started', 'question-raised:the session’s', 'question-resolved:confirmed', 'turn-ended:completed:reported:none'];
    expect(questionCourse(codex.events)).toEqual(course);
    expect(questionCourse(claude.events)).toEqual(course);
    expect(questionFields(claude.events)).toEqual(questionFields(codex.events));
    expect(questionFields(codex.events)).toEqual({ 'question-raised': ['cut', 'questions', 'requestId', 'sourceId', 'turnId', 'type'], 'question-resolved': ['reason', 'requestId', 'type'] });

    // While it waited: one card of the session's own, pending, and the session asking in fat-g's words.
    expect(cardShape(claude.pending)).toEqual(cardShape(codex.pending));
    expect(cardShape(codex.pending)).toMatchObject({ kind: 'interaction', role: null, origin: 'local', workerId: null, named: 'string', mode: 'blocking', outcome: 'pending', answers: null, settled: 'none', confirmed: 'none', cut: false });
    for (const side of [codex, claude]) expect(shown(side.waiting)).toEqual({ status: 'running', attention: { kind: 'question', count: 1 }, action: { kind: 'asking', label: 'Asking a question', detail: null } });

    // Answered: by the place of what was chosen, with the CLI's own word that it took it.
    expect(cardShape(claude.settled)).toEqual(cardShape(codex.settled));
    expect(cardShape(codex.settled)).toMatchObject({ outcome: 'answered', answers: [{ chosen: 1, text: null, secret: false }], settled: 'known', confirmed: 'known', withdrawnBy: null });
    for (const side of [codex, claude]) {
      expect(words(side.settled)).toBe('Answered');
      // The page was pushed the card as it waited, as it was answered, and with its mark.
      expect(cardPushes(side)).toEqual(['pending:unmarked', 'answered:unmarked', 'answered:marked']);
      // One card, of the turn that asked, after the prompt that asked.
      expect(cardsOf(side.read)).toHaveLength(1);
      expect(side.settled.turnId).toBe(side.read.items[0]?.turnId);
      expect(side.read.items[0]).toMatchObject({ kind: 'message', role: 'user' });
      expect(side.read.waiting).toEqual([]);
    }
    expect(turns(claude.read)).toEqual(turns(codex.read));
    expect(turns(codex.read)).toMatchObject([{ place: 1, state: 'ended', outcome: 'completed' }]);
    for (const side of [codex, claude]) {
      // Codex's capture is a plan turn (M21's K2), and its plan waits for a decision since M22b: PLAN READY in READY's place (C27).
      expect(shown(side.summary)).toMatchObject({ status: 'idle', attention: { kind: side === codex ? 'plan' : 'ready' }, action: null });
      expect((side.record['lastTurn'] as { outcome?: string } | null)?.outcome).toBe('completed');
    }
  }, 120_000);

  it('stopped while it waits: neither says what became of the request, and each card is withdrawn by its turn’s end (C22, C27)', async () => {
    const { codex, claude } = await bothAsked('stop');
    const course = ['turn-started', 'question-raised:the session’s', 'turn-ended:interrupted:reported:none'];
    expect(questionCourse(codex.events)).toEqual(course);
    expect(questionCourse(claude.events)).toEqual(course);
    expect(cardShape(claude.settled)).toEqual(cardShape(codex.settled));
    expect(cardShape(codex.settled)).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn', answers: null, settled: 'known', confirmed: 'none' });
    for (const side of [codex, claude]) {
      expect(words(side.settled)).toBe('Withdrawn: the reply ended');
      expect(cardPushes(side)).toEqual(['pending:unmarked', 'withdrawn:unmarked']);
      expect(side.read.waiting).toEqual([]);
      expect((side.record['lastTurn'] as { outcome?: string } | null)?.outcome).toBe('interrupted');
    }
    expect(turns(claude.read)).toEqual(turns(codex.read));
    expect(turns(codex.read)).toMatchObject([{ place: 1, state: 'ended', outcome: 'interrupted' }]);
    expect(shown(claude.summary)).toEqual(shown(codex.summary));
    expect(shown(codex.summary)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
  }, 120_000);

  it('DIFFERENCES 20 and 21: how each asks, as its descriptor declares, and what carries its question', async () => {
    const { codex, claude } = await bothAsked('answer');
    // 20. Claude asks by a request alone; Codex also in a message.
    expect(claude.capability).toBe('blocking');
    expect(codex.capability).toBe('both');
    // 21. Claude's question stands at its tool's use, which is no activity (M21, C19): the turn's
    // other tool, its read, is. Codex's stands at an item of its turn.
    const raisedBy = (side: Asked) => side.events.flatMap((event) => (event.type === 'question-raised' ? [event.sourceId] : []))[0];
    for (const side of [codex, claude]) {
      expect(side.settled.providerItemId).toBe(raisedBy(side));
      expect(side.read.items.some((item) => item.kind === 'activity' && item.providerItemId === raisedBy(side))).toBe(false);
      expect(side.events.some((event) => event.type === 'activity-started' && event.itemId === raisedBy(side))).toBe(false);
    }

    // And the mode one alone has: asked in a message, Codex's turn ends, and its card waits for nothing.
    const codexSide = await codexHarness();
    disposers.push(() => codexSide.dispose());
    const data = path.join(codexSide.dir, 'records');
    placeRecords(data, codexSide.project, 'codex', [sessionEntry(1, 'codex', { model: 'gpt-6-astra' })]);
    const app = launchApp({ dir: data, descriptor: codexSide.provider.descriptor, facet: () => codexSide.facet, userDefault: CAPTURED_MODE });
    disposers.push(() => app.quit());
    expect(await app.runtime.send(S(1), PROMPTS.asks)).toEqual({ status: 'accepted' });
    await until(() => !app.service.isRunning(S(1)) && cardsOf(app.read(1)).length === 1, 'the turn that asks in a message ending with its card', 30_000);
    const [card] = cardsOf(app.read(1));
    expect(card?.interaction).toMatchObject({ mode: 'async', outcome: 'open', answers: null });
    expect(app.summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    // The card follows the message that asked, whose id it stands at; no request was made for it.
    const at = app.read(1).items.findIndex((item) => item.id === card?.id);
    expect(app.read(1).items[at - 1]).toMatchObject({ kind: 'message', role: 'assistant', providerItemId: card?.providerItemId });
    // Neither capture of a request made a card of this mode.
    for (const side of [codex, claude]) expect(cardsOf(side.read).every((item) => questionOf(item)?.mode === 'blocking')).toBe(true);
  }, 180_000);
});

describe('an action a session asks leave for, by both (M22: V11; C35)', () => {
  interface Leave {
    readonly events: readonly AgentEvent[];
    /** The card while it waited, with the session's summary then; and the same card once the session came to rest. */
    readonly pending: ConversationItem;
    readonly waiting: ReturnType<App['summary']>;
    readonly settled: ConversationItem;
    /** The chat once the first turn was over. */
    readonly read: ChatRead;
    readonly pushes: readonly ChatPush[];
    readonly summary: ReturnType<App['summary']>;
    readonly record: Record<string, unknown>;
    /** After a later prompt for what the session's grant covers: the chat then, and what its turn told. Null where none was sent. */
    readonly again: { readonly read: ChatRead; readonly events: readonly AgentEvent[] } | null;
  }
  const cardsOf = (read: ChatRead): ConversationItem[] => read.items.filter((item) => approvalOf(item) !== null);

  /**
   * A turn that asks leave, as a first turn of a new session through the app's session side, under
   * the mode the hierarchy gives a chat nothing chose one for: decided from its card, or stopped
   * while it waits; and, where `again` is given, the prompt that asks for what the grant covers.
   */
  async function asked(provider: AgentProvider, facet: SessionFacet, dir: string, folder: string, prompt: string, model: string, how: ApprovalChoice | 'stop', again?: string): Promise<Leave> {
    const { id } = provider.descriptor;
    const data = path.join(dir, 'records');
    placeRecords(data, folder, id, [sessionEntry(1, id, { model })]);
    const events: AgentEvent[] = [];
    const app = launchApp({ dir: data, descriptor: provider.descriptor, facet: () => recording(facet, events), userDefault: CAPTURED_MODE });
    disposers.push(() => app.quit());
    expect(app.read(1).mode).toEqual({ id: 'ask-first', source: 'user' });
    expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
    const pending = await until(() => cardsOf(app.read(1))[0], 'the card', 30_000);
    const waiting = app.summary(1);
    if (how === 'stop') expect(app.runtime.stop(S(1))).toEqual({ status: 'stopping' });
    else expect(app.runtime.decide(S(1), pending.id, how)).toEqual({ status: 'decided' });
    await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 30_000);
    await app.service.settled();
    const read = app.read(1);
    const settled = cardsOf(read)[0];
    const record = storedSession(data, 1);
    if (settled === undefined || record === undefined) throw new Error('the card or the session is gone');
    const first = { events: [...events], pending, waiting, settled, read, pushes: [...app.pushes], summary: app.summary(1), record };
    if (again === undefined) return { ...first, again: null };
    expect(await app.runtime.send(S(1), again)).toEqual({ status: 'accepted' });
    await until(() => !app.service.isRunning(S(1)), 'the session coming to rest again', 30_000);
    await app.service.settled();
    return { ...first, again: { read: app.read(1), events: events.slice(first.events.length) } };
  }

  /** K1's command and K2's, each asked once; or K1's file change and K2's command, each one its CLI offers a grant for, with the prompt that asks for the same again. */
  async function bothAsked(how: ApprovalChoice | 'stop'): Promise<{ codex: Leave; claude: Leave }> {
    const codexSide = await codexHarness();
    disposers.push(() => codexSide.dispose());
    const claudeSide = await claudeHarness();
    disposers.push(() => claudeSide.dispose());
    const granted = how === 'approve-session';
    const codex = await asked(codexSide.provider, codexSide.facet, codexSide.dir, codexSide.project, granted ? PROMPTS.file : PROMPTS.command, 'gpt-6-astra', how, granted ? PROMPTS.fileAgain : undefined);
    const claude = await asked(claudeSide.provider, claudeSide.facet, claudeSide.dir, claudeSide.project, granted ? claudeSide.prompts.grant : claudeSide.prompts.approve, 'sonnet', how, granted ? claudeSide.prompts.grantAgain : undefined);
    return { codex, claude };
  }

  /**
   * A request's course as both providers must give it: the mode its process confirmed, the request
   * raised in its turn, what became of it, how its action ended where the provider said, the turn's
   * end. What the turn said and did around it is each capture's own.
   */
  const leaveCourse = (events: readonly AgentEvent[]): string[] => {
    const actions = new Set(events.flatMap((event) => (event.type === 'approval-raised' ? [event.sourceId] : [])));
    return events.flatMap((event) => {
      if (event.type === 'in-force' && event.mode !== undefined) return [`in-force:${event.mode}`];
      if (event.type === 'turn-started') return ['turn-started'];
      if (event.type === 'approval-raised') return [`approval-raised:${event.workerId === undefined ? 'the session’s' : 'a worker’s'}`];
      if (event.type === 'approval-resolved') return [`approval-resolved:${event.reason}`];
      if (event.type === 'activity-started' && actions.has(event.itemId)) return ['action-started'];
      if (event.type === 'activity-ended' && actions.has(event.itemId)) return [`action-ended:${event.status}:${event.declinedBy ?? 'no one'}`];
      if (event.type === 'notice') return [`notice:${event.kind}`];
      if (event.type === 'turn-ended') return [`turn-ended:${event.outcome}:${event.reported ? 'reported' : 'own'}:${event.failure ?? 'none'}`];
      return [];
    });
  };
  /** The keys of each approval event, from each. */
  const leaveFields = (events: readonly AgentEvent[]): Record<string, string[]> => Object.fromEntries(events.filter((event) => event.type === 'approval-raised' || event.type === 'approval-resolved').map((event) => [event.type, Object.keys(event).sort()]));
  const known = (at: number | null | undefined): string => (at === null || at === undefined ? 'none' : 'known');
  /** The card as the page reads it, by what it is: its fields, its body's, its request's, and what became of it. What it asks leave for is its capture's own, held to its shape alone. */
  const cardShape = (item: ConversationItem): unknown => {
    const body = approvalOf(item);
    return {
      kind: item.kind, role: item.role, phase: item.phase, notice: item.notice, origin: item.origin, state: item.state, workerId: item.workerId, named: typeof item.providerItemId,
      blocks: item.blocks.map((block) => block.type), fields: Object.keys(item).sort(), body: Object.keys(item.interaction ?? {}).sort(),
      request: Object.keys(body?.request ?? {}).sort(), cut: body?.request.cut, outcome: body?.outcome, withdrawnBy: body?.withdrawnBy, delivered: body?.delivered,
      decided: known(body?.decidedAt), settled: known(body?.settledAt), confirmed: known(body?.confirmedAt),
      grant: body === null || body.grant === null ? null : { fields: Object.keys(body.grant).sort(), live: body.grant.live },
    };
  };
  /** Each push of the card, by what it said of it: its outcome, whether its reply had gone, and the CLI's mark. */
  const cardPushes = (side: Leave): string[] => side.pushes.flatMap((push) => {
    if (!('item' in push) || push.item.id !== side.pending.id) return [];
    const body = approvalOf(push.item);
    return [`${body?.outcome ?? 'none'}:${body?.delivered === null ? 'unsent' : body?.delivered === true ? 'delivered' : 'not taken'}:${body?.confirmedAt === null ? 'unmarked' : 'marked'}`];
  });
  const words = (item: ConversationItem): string | null => (item.interaction === null ? null : outcomeWords(item.interaction, false));
  const shown = (summary: Leave['summary']): unknown => ({ status: summary?.status, mode: summary?.mode, attention: summary?.attention === null || summary === undefined ? null : { kind: summary.attention.kind, count: summary.attention.count }, action: summary?.action ?? null });
  /** The action's own item: the activity the card stands for, by the id both carry. */
  const actionOf = (side: Leave, read: ChatRead = side.read): ConversationItem | undefined => read.items.find((item) => item.kind === 'activity' && item.providerItemId === side.settled.providerItemId);
  /** The mode each turn ran under (C83). */
  const modes = (read: ChatRead): (string | null)[] => read.turns.map((turn) => turn.mode);

  it.each(['approve', 'deny'] as const)('decided by %s: the same course, card, turn and summary from each — raised under its turn at its action, waiting with the attention on it, decided from the card, delivered, confirmed by the CLI, the turn completing', async (how) => {
    const { codex, claude } = await bothAsked(how);
    const course = ['in-force:ask-first', 'turn-started', 'action-started', 'approval-raised:the session’s', 'approval-resolved:confirmed', how === 'approve' ? 'action-ended:completed:no one' : 'action-ended:declined:user', 'turn-ended:completed:reported:none'];
    expect(leaveCourse(codex.events)).toEqual(course);
    expect(leaveCourse(claude.events)).toEqual(course);
    expect(leaveFields(claude.events)).toEqual(leaveFields(codex.events));
    expect(leaveFields(codex.events)).toEqual({ 'approval-raised': ['request', 'requestId', 'sourceId', 'turnId', 'type'], 'approval-resolved': ['reason', 'requestId', 'type'] });

    // While it waited: one card of the session's own, pending, the request whole, and the session waiting in fat-g's words under the mode its process confirmed.
    expect(cardShape(claude.pending)).toEqual(cardShape(codex.pending));
    expect(cardShape(codex.pending)).toMatchObject({ kind: 'interaction', role: null, origin: 'local', workerId: null, named: 'string', outcome: 'pending', cut: false, delivered: null, decided: 'none', settled: 'none', confirmed: 'none', grant: null });
    for (const side of [codex, claude]) expect(shown(side.waiting)).toEqual({ status: 'running', mode: 'ask-first', attention: { kind: 'approval', count: 1 }, action: { kind: 'approving', label: 'Waiting for your approval', detail: null } });

    // Decided: written, then delivered, then marked by the CLI's own word — three pushes after the one that showed it.
    const outcome = how === 'approve' ? 'approved' : 'denied';
    expect(cardShape(claude.settled)).toEqual(cardShape(codex.settled));
    expect(cardShape(codex.settled)).toMatchObject({ outcome, delivered: true, decided: 'known', confirmed: 'known', withdrawnBy: null, grant: null });
    for (const side of [codex, claude]) {
      expect(words(side.settled)).toBe(how === 'approve' ? 'Approved once' : 'Denied');
      expect(cardPushes(side)).toEqual(['pending:unsent:unmarked', `${outcome}:unsent:unmarked`, `${outcome}:delivered:unmarked`, `${outcome}:delivered:marked`]);
      // One card, of the turn that asked, standing just after the action it is for; and that action ran, or was declined at the user's word.
      expect(cardsOf(side.read)).toHaveLength(1);
      const at = side.read.items.findIndex((item) => item.id === side.settled.id);
      expect(side.read.items[at - 1]).toBe(actionOf(side));
      expect(actionOf(side)?.turnId).toBe(side.settled.turnId);
      expect(actionOf(side)?.activity).toMatchObject(how === 'approve' ? { type: 'command', status: 'completed', declinedBy: null } : { type: 'command', status: 'declined', declinedBy: 'user' });
      expect(side.read.waiting).toEqual([]);
      expect(side.read.grants).toEqual([]);
      expect(modes(side.read)).toEqual(['ask-first']);
    }
    expect(turns(claude.read)).toEqual(turns(codex.read));
    expect(turns(codex.read)).toMatchObject([{ place: 1, state: 'ended', outcome: 'completed' }]);
    for (const side of [codex, claude]) {
      expect(shown(side.summary)).toMatchObject({ status: 'idle', mode: 'ask-first', attention: { kind: 'ready' }, action: null });
      expect((side.record['lastTurn'] as { outcome?: string } | null)?.outcome).toBe('completed');
    }
  }, 120_000);

  it('stopped while it waits: neither says what became of the request, and each card is withdrawn by its turn’s end with nothing sent (C11)', async () => {
    const { codex, claude } = await bothAsked('stop');
    const withoutAction = (events: readonly AgentEvent[]): string[] => leaveCourse(events).filter((step) => !step.startsWith('action-ended'));
    const course = ['in-force:ask-first', 'turn-started', 'action-started', 'approval-raised:the session’s', 'turn-ended:interrupted:reported:none'];
    expect(withoutAction(codex.events)).toEqual(course);
    expect(withoutAction(claude.events)).toEqual(course);
    expect(cardShape(claude.settled)).toEqual(cardShape(codex.settled));
    expect(cardShape(codex.settled)).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn', delivered: null, decided: 'none', settled: 'known', confirmed: 'none', grant: null });
    for (const side of [codex, claude]) {
      expect(words(side.settled)).toBe('Withdrawn: the reply ended');
      expect(cardPushes(side)).toEqual(['pending:unsent:unmarked', 'withdrawn:unsent:unmarked']);
      expect(side.read.waiting).toEqual([]);
      expect(actionOf(side)?.activity?.status).not.toBe('completed');
      expect((side.record['lastTurn'] as { outcome?: string } | null)?.outcome).toBe('interrupted');
    }
    expect(turns(claude.read)).toEqual(turns(codex.read));
    expect(turns(codex.read)).toMatchObject([{ place: 1, state: 'ended', outcome: 'interrupted' }]);
    expect(shown(claude.summary)).toEqual(shown(codex.summary));
    expect(shown(codex.summary)).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
  }, 120_000);

  it('granted for the session: the same card and the same listed grant from each, live with its process, and the next request it covers unasked (C21, C57)', async () => {
    const { codex, claude } = await bothAsked('approve-session');
    const course = ['in-force:ask-first', 'turn-started', 'action-started', 'approval-raised:the session’s', 'approval-resolved:confirmed', 'action-ended:completed:no one', 'turn-ended:completed:reported:none'];
    expect(leaveCourse(codex.events)).toEqual(course);
    expect(leaveCourse(claude.events)).toEqual(course);
    // Offered by each request itself, and by nothing of fat-g's.
    for (const side of [codex, claude]) {
      expect(approvalOf(side.pending)?.request.choices).toEqual(['approve', 'approve-session', 'deny']);
      expect(approvalOf(side.pending)?.request.grant?.covers.trim()).not.toBe('');
    }
    expect(cardShape(claude.settled)).toEqual(cardShape(codex.settled));
    expect(cardShape(codex.settled)).toMatchObject({ outcome: 'approved-session', delivered: true, decided: 'known', confirmed: 'known', grant: { fields: ['covers', 'live', 'processKey'], live: true } });
    for (const side of [codex, claude]) {
      expect(words(side.settled)).toBe('Approved for this session');
      expect(cardPushes(side)).toEqual(['pending:unsent:unmarked', 'approved-session:unsent:unmarked', 'approved-session:delivered:unmarked', 'approved-session:delivered:marked']);
      // Listed for the session by its card's id, in the words the request gave for what it covers, confirmed by the CLI.
      expect(side.read.grants).toEqual([{ itemId: side.settled.id, covers: approvalOf(side.pending)?.request.grant?.covers, decidedAt: approvalOf(side.settled)?.decidedAt, confirmed: true, live: true }]);
      // The next prompt for the same: a turn of the same process that asks nothing, its action run; the grant is live still, and no key of a process reaches the page's list.
      const again = side.again;
      if (again === null) throw new Error('the second prompt was not sent');
      expect(leaveCourse(again.events)).toEqual(['turn-started', 'turn-ended:completed:reported:none']);
      expect(cardsOf(again.read)).toHaveLength(1);
      expect(again.read.grants).toEqual(side.read.grants);
      expect(again.read.items.filter((item) => item.kind === 'activity' && item.turnId === again.read.turns[1]?.id).every((item) => item.activity?.status === 'completed')).toBe(true);
      expect(modes(again.read)).toEqual(['ask-first', 'ask-first']);
      expect(JSON.stringify(again.read.grants)).not.toContain('processKey');
    }
    expect(turns(claude.again?.read ?? claude.read)).toEqual(turns(codex.again?.read ?? codex.read));
  }, 180_000);

  it('DIFFERENCES 22 to 25: what each request names, which kinds a grant covers, what else its CLI offered, and a stopped request’s action', async () => {
    const once = await bothAsked('approve');
    const request = (side: Leave) => approvalOf(side.pending)?.request;
    // 22. Codex names the folder its command would run in, and no path and no reason; Claude names no folder, the paths and the model's reason.
    expect(request(once.codex)).toMatchObject({ kind: 'command', targets: [], reason: null });
    expect(typeof request(once.codex)?.folder).toBe('string');
    expect(request(once.claude)).toMatchObject({ kind: 'command', folder: null });
    expect(request(once.claude)?.targets.length).toBeGreaterThan(0);
    expect(typeof request(once.claude)?.reason).toBe('string');
    // 23. Claude's command is eligible for its session rule; K1's Codex command lists no such choice.
    expect(request(once.claude)?.choices).toEqual(['approve', 'approve-session', 'deny']);
    expect(request(once.codex)).toMatchObject({ choices: ['approve', 'deny'], grant: null });
    // 24. What else each CLI offered, said and never sent back: each kind once, a mode by fat-g's id for it.
    expect(request(once.claude)?.authority).toEqual([{ kind: 'saved-rule', mode: null }, { kind: 'folder', mode: null }, { kind: 'mode', mode: 'edits-ok' }]);
    expect(request(once.codex)?.authority).toEqual([{ kind: 'saved-rule', mode: null }]);

    // 23, again: Codex's file change is eligible, and its grant covers the file; Claude's covers its rule's words. 24: a file change of Codex's offers nothing else.
    const granted = await bothAsked('approve-session');
    expect(request(granted.codex)).toMatchObject({ kind: 'file-change', authority: [], detail: { kind: 'changes' } });
    expect(request(granted.codex)?.targets).toEqual([request(granted.codex)?.grant?.covers]);
    expect(request(granted.claude)).toMatchObject({ kind: 'command', detail: { kind: 'command', command: request(granted.claude)?.grant?.covers } });
    expect(actionOf(granted.codex)?.activity?.type).toBe('edit');
    expect(actionOf(granted.claude)?.activity?.type).toBe('command');

    // 25. Stopped: Claude ends its tool's use as failed; Codex's item is told no end, and reads unfinished.
    const stopped = await bothAsked('stop');
    const ends = (side: Leave): string[] => side.events.flatMap((event) => (event.type === 'activity-ended' && event.itemId === side.settled.providerItemId ? [event.status] : []));
    expect(ends(stopped.claude)).toEqual(['failed']);
    expect(ends(stopped.codex)).toEqual([]);
    expect(actionOf(stopped.claude)?.activity?.status).toBe('failed');
    expect(actionOf(stopped.codex)?.activity?.status).toBe('unfinished');
  }, 300_000);
});

describe('a plan, by both (M22b: V7; C10, C14, C15, C55)', () => {
  const lineOf = (read: ChatRead): ConversationItem | undefined => read.items.filter((item) => planOf(item) !== null).at(-1);
  /** A plan turn through the app's session side, under Ask first, its requests for leave denied as a user may: once its line waits. */
  async function planned(provider: AgentProvider, facet: SessionFacet, dir: string, folder: string, prompt: string, model: string): Promise<{ readonly app: App; readonly line: ConversationItem; readonly events: AgentEvent[] }> {
    const { id } = provider.descriptor;
    const data = path.join(dir, 'records');
    placeRecords(data, folder, id, [sessionEntry(1, id, { model })]);
    const events: AgentEvent[] = [];
    const app = launchApp({ dir: data, descriptor: provider.descriptor, facet: () => recording(facet, events), userDefault: CAPTURED_MODE });
    disposers.push(() => app.quit());
    expect(await app.runtime.send(S(1), prompt, { plan: true })).toEqual({ status: 'accepted' });
    const denied = new Set<string>();
    const line = await until(() => {
      for (const card of app.read(1).items.filter((item) => approvalOf(item)?.outcome === 'pending' && !denied.has(item.id))) { denied.add(card.id); app.runtime.decide(S(1), card.id, 'deny'); }
      const found = lineOf(app.read(1));
      return found !== undefined && planOf(found)?.outcome === 'pending' ? found : undefined;
    }, 'the plan’s line', 60_000);
    return { app, line, events };
  }

  it('makes a version and a line of the same shape from each, under the chat’s mode, with PLAN READY on the session; DIFFERENCES 27 and 28', async () => {
    const codexSide = await codexHarness();
    disposers.push(() => codexSide.dispose());
    codexSide.control({ sandboxState: 'ready' });
    const claudeSide = await claudeHarness();
    disposers.push(() => claudeSide.dispose());
    const codex = await planned(codexSide.provider, codexSide.facet, codexSide.dir, codexSide.project, promptOf('m22b-codex-chain'), 'gpt-6-luna');
    const claude = await planned(claudeSide.provider, claudeSide.facet, claudeSide.dir, claudeSide.project, claudePromptOf('m22b-plan-ask-first', claudeSide.project), 'sonnet');
    for (const side of [codex, claude]) {
      const body = planOf(side.line);
      expect(body).toMatchObject({ kind: 'plan', version: 1, came: 'made', outcome: 'pending' });
      const plan = side.app.planStore.get(body?.planId ?? '');
      expect(plan?.versions).toMatchObject([{ version: 1, state: 'complete', cause: 'plan-turn', sessionId: S(1) }]);
      expect(side.app.read(1).turns[0]).toMatchObject({ mode: 'ask-first' });
      expect(side.app.runtime.planPending(S(1))).toBe(true);
    }
    // 27: Claude's arrives in a request while its turn runs; Codex's as an item, its turn over.
    expect(planOf(claude.line)?.request).toBe(true);
    expect(planOf(codex.line)?.request).toBe(false);
    expect(claude.events.some((event) => event.type === 'plan-raised')).toBe(true);
    expect(codex.events.filter((event) => event.type === 'plan-delta').length).toBeGreaterThan(1);
    await until(() => !codex.app.service.isRunning(S(1)), 'Codex’s turn over', 30_000);
    expect(codex.app.summary(1)?.attention).toMatchObject({ kind: 'plan' });
    expect(claude.app.summary(1)?.attention).toMatchObject({ kind: 'plan' });
    // 28: Execute is Claude's request's answer; Codex's a turn of its own.
    expect(await claude.app.runtime.decidePlan(S(1), claude.line.id, 'execute')).toEqual({ status: 'decided' });
    expect(await codex.app.runtime.decidePlan(S(1), codex.line.id, 'execute')).toEqual({ status: 'decided' });
    expect(claude.app.read(1).turns).toHaveLength(1);
    expect(codex.app.read(1).turns).toHaveLength(2);
    for (const side of [codex, claude]) expect(planOf(lineOf(side.app.read(1)) as ConversationItem)?.outcome).toBe('executed');
  }, 180_000);
});

describe('a message sent into a running turn, by both (M23: V11; C36, C38, C42)', () => {
  it('DIFFERENCE 30: Codex’s reply names the turn at once; Claude takes the frame, and its lifecycle says the turn took it', async () => {
    const codex = await codexHarness();
    const claude = await claudeHarness();
    try {
      const start = (folder: string, model: string) => ({ folder, model, effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' });
      const codexSession = codex.facet.start(start(codex.project, 'gpt-6-luna'));
      const codexSeen = collect(codexSession);
      codexSession.send({ turnId: 'turn-1', prompt: promptOf('m23-codex-steer'), effort: 'low', speed: null, messageId: 'message-1' });
      await codexSeen.first((event): event is Extract<AgentEvent, { type: 'turn-started' }> => event.type === 'turn-started', 'Codex’s turn start');
      expect(await codexSession.steer?.({ turnId: 'turn-1', messageId: 'steer-1', prompt: 'Also say STEERED.' })).toEqual({ kind: 'taken' });
      const claudeSession = claude.facet.start(start(claude.project, 'sonnet'));
      const claudeSeen = collect(claudeSession);
      claudeSession.send({ turnId: 'turn-1', prompt: claudePromptOf('m23-claude-steer-tool', claude.project), effort: 'low', speed: null, messageId: 'message-1' });
      await claudeSeen.first((event): event is Extract<AgentEvent, { type: 'in-force' }> => event.type === 'in-force' && event.model !== undefined, 'Claude’s init');
      expect(await claudeSession.steer?.({ turnId: 'turn-1', messageId: 'steer-1', prompt: claudePromptOf('m23-claude-steer-tool', claude.project, 1) })).toEqual({ kind: 'handed' });
      expect(await claudeSeen.first((event): event is Extract<AgentEvent, { type: 'delivery' }> => event.type === 'delivery', 'Claude’s word of the message')).toEqual({ type: 'delivery', messageId: 'steer-1', state: 'taken' });
      await Promise.all([codexSeen.ended('turn-1'), claudeSeen.ended('turn-1')]);
      await Promise.all([codexSession.close(), claudeSession.close()]);
    } finally {
      await Promise.all([codex.dispose(), claude.dispose()]);
    }
  });
});
