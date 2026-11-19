// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V21, V56 (docs/planning/_archive/M15.md; C70–C74, C115, C127, C128): the replay fake, started here as a
// plain child. Every frame it sends for a session is a received frame of a capture file but for ids,
// times and the folder; the prompt chooses the capture; it waits where the capture shows fat-g
// sending; another process resumes what the first began; and each control does what it names.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAddress, readCodeSpanPath, readTarget } from '@shared/contracts/files';
import { removeFolder } from '../process/remove-folder';
import { ASIDE_INSTRUCTIONS } from '@shared/contracts/aside';
import { answerPrompt, fromMessageQuestions } from '@shared/contracts/interaction';
import { MEDIA_SESSION_LINE_BYTES } from '@shared/provider-kit/ndjson';
import { OPTED_OUT_DELTAS } from '../../src/main/providers/codex/methods';
import { FORK_CAPTURES, FORK_TURN_CAPTURES, PERMISSION_CAPTURES, PLAN_CAPTURES, QUESTION_CAPTURES } from '../fixtures/codex/replay.mjs';

type Json = Record<string, unknown>;
const CODEX = path.resolve('tests/fixtures/fake-codex-cli.mjs');
const CAPTURES = path.resolve('tests/fixtures/codex/captures');
const capture = (name: string): { frames: { index: number; dir: string; ms: number; frame: Json }[] } => JSON.parse(readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8')) as never;
const promptOf = (name: string): string => {
  const start = capture(name).frames.find((f) => f.dir === 'send' && f.frame['method'] === 'turn/start');
  return (start?.frame['params'] as { input: [{ text: string }] }).input[0].text;
};
const PROMPT = { t1: promptOf('t1-basic'), t3: promptOf('t3-subagent'), t4: promptOf('t4-interrupt'), t5: promptOf('t5-error'), t6: promptOf('t6-question'), saved: promptOf('m15-saved'), resume: promptOf('m15-resume'), workerInterrupt: promptOf('m15-worker-interrupt'), outlive: promptOf('m15-worker-outlives-turn'), output: promptOf('m15-large-output') };
const OPT_OUT = ['item/agentMessage/delta'];
/** The id a prompt is sent with: the app makes a UUID. */
const CLIENT_ID = '99999999-9999-4999-8999-999999999999';
const MIB = 1024 * 1024;

const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);

// ── Masking: what "but for ids, times and the folder" means ───────────────────────────────────
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ALIAS = /<[a-z][a-z-]*-\d+>/g;
const SECONDS = new Set(['startedAt', 'completedAt', 'createdAt', 'updatedAt', 'recencyAt']);
function mask(value: unknown, folder: string, key?: string): unknown {
  if (typeof value === 'string') return value.replaceAll(folder, '<scratch>').replace(UUID, '<id>').replace(ALIAS, '<id>');
  if (typeof value === 'number' && key !== undefined && (/AtMs$/.test(key) || SECONDS.has(key))) return 0;
  if (Array.isArray(value)) return value.map((item) => mask(item, folder));
  // A key that is an id, as a collab call's agents' states are by thread (M20a, K3), is masked as an id is.
  if (value !== null && typeof value === 'object') {
    const item = value as Json;
    const file = item['path'];
    const native = path.sep === '/' && item['type'] === 'read' && typeof file === 'string' && file.startsWith('<scratch>\\')
      ? { ...item, path: file.replaceAll('\\', '/') } : item;
    return Object.fromEntries(Object.entries(native).map(([k, v]) => [k.replace(UUID, '<id>').replace(ALIAS, '<id>'), mask(v, folder, k)]));
  }
  return value;
}
/** A frame as it compares: a reply's id is the request's own, so it is left out. */
const comparable = (frame: Json, folder: string): string => {
  const rest = Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'id'));
  return JSON.stringify(mask('method' in frame ? frame : rest, folder));
};
const captured = new Set<string>();
for (const file of readdirSync(CAPTURES).filter((name) => name.endsWith('.json'))) {
  for (const { dir, frame } of capture(file.replace(/\.json$/, '')).frames) if (dir === 'recv') captured.add(comparable(frame, '<never>'));
}

// ── The fake as a child ───────────────────────────────────────────────────────────────────────
interface Fake {
  readonly pid: number;
  readonly lines: Json[];
  /** Each stdout chunk as it arrived, to see what came in one write. */
  readonly chunks: string[];
  send(value: Json): void;
  request(method: string, params?: Json, timeoutMs?: number): Promise<Json>;
  next(match: (line: Json) => boolean, timeoutMs?: number): Promise<Json>;
  closed: Promise<number | null>;
  end(): Promise<number | null>;
  exited(): boolean;
}
const open: ChildProcessWithoutNullStreams[] = [];
let dir: string;
let threads: string;
let control: string;
let ledger: string;

function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^(CODEX_HOME|FATG_SMOKE_)/i.test(name)) env[name] = value;
  return { ...env, FATG_SMOKE_CODEX_THREADS: threads, FATG_SMOKE_CODEX_CONTROL: control, FATG_SMOKE_PIDS: ledger, FATG_SMOKE_CODEX_GAP_MS: '1', ...extra };
}

function start(extra: Record<string, string> = {}): Fake {
  const child = spawn(process.execPath, [CODEX, 'app-server'], { env: environment(extra), windowsHide: true });
  open.push(child);
  const lines: Json[] = [];
  const chunks: string[] = [];
  let wake: (() => void)[] = [];
  let fragments: string[] = [];
  let nextId = 0;
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-2000); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    chunks.push(chunk);
    // Scan each chunk once and join only complete lines. Rescanning a growing 32 MiB
    // fault frame for every pipe chunk makes this harness quadratic on CI runners.
    let start = 0;
    let newline: number;
    while ((newline = chunk.indexOf('\n', start)) !== -1) {
      fragments.push(chunk.slice(start, newline));
      const line = fragments.join('');
      fragments = [];
      start = newline + 1;
      try { lines.push(JSON.parse(line) as Json); } catch { /* not a frame */ }
    }
    if (start < chunk.length) fragments.push(chunk.slice(start));
    for (const resolve of wake.splice(0)) resolve();
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => { for (const wakeUp of wake.splice(0)) wakeUp(); wake = []; resolve(code); }));
  const fake: Fake = {
    pid: child.pid ?? -1, lines, chunks, closed,
    send: (value) => { child.stdin.write(`${JSON.stringify(value)}\n`); },
    async next(match, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find(match);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no matching line; got ${lines.map((line) => (typeof line['method'] === 'string' ? line['method'] : 'a reply')).join(', ')}`);
        if (child.exitCode !== null) throw new Error(`the fake exited (${String(child.exitCode)}) before a matching line: ${errors}`);
        await new Promise<void>((resolve) => { wake.push(resolve); setTimeout(resolve, 50); });
      }
    },
    request(method, params, timeoutMs) {
      const id = ++nextId;
      fake.send(params === undefined ? { id, method } : { id, method, params });
      return fake.next((line) => line['id'] === id && line['method'] === undefined, timeoutMs);
    },
    end: () => { child.stdin.end(); return closed; },
    exited: () => child.exitCode !== null,
  };
  return fake;
}

/** A session's process, its handshake made as fat-g makes it. */
async function session(extra: Record<string, string> = {}): Promise<Fake> {
  const fake = start(extra);
  await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: OPT_OUT } });
  fake.send({ method: 'initialized' });
  return fake;
}

const folder = (): string => path.join(dir, 'project');
async function startThread(fake: Fake): Promise<{ reply: Json; id: string }> {
  const reply = await fake.request('thread/start', { cwd: folder(), sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-astra' });
  return { reply, id: String(at(reply, 'result', 'thread', 'id')) };
}
const turnStart = (fake: Fake, threadId: string, text: string, extra: Json = {}): Promise<Json> =>
  fake.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], model: 'gpt-6-astra', effort: 'low', clientUserMessageId: CLIENT_ID, ...extra });
const sessionEnd = (threadId: string) => (line: Json): boolean => line['method'] === 'turn/completed' && at(line, 'params', 'threadId') === threadId;
const setControl = (value: Json): void => writeFileSync(control, JSON.stringify(value));
const threadFile = (): Record<string, { interrupts: unknown[]; historyReads?: unknown[] }> => (JSON.parse(readFileSync(threads, 'utf8')) as { threads: Record<string, { interrupts: unknown[]; historyReads?: unknown[] }> }).threads;
const pids = (): number[] => { try { return readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0])); } catch { return []; } };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const items = (fake: Fake, type: string): Json[] => fake.lines.filter((line) => line['method'] === 'item/completed' && at(line, 'params', 'item', 'type') === type);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-replay-'));
  threads = path.join(dir, 'threads.json');
  control = path.join(dir, 'control.json');
  ledger = path.join(dir, 'pids');
  setControl({});
});
afterEach(async () => {
  for (const child of open.splice(0)) { if (child.exitCode === null) child.kill(); }
  for (const pid of pids()) { if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } }
  await removeFolder(dir);
});

describe('the replay sends only captured frames (C70)', () => {
  it('every frame of a start, a turn, a worker’s turn, a resume and the history reads is in a capture file but for ids, times and the folder', async () => {
    const first = await session();
    const { id } = await startThread(first);
    await turnStart(first, id, PROMPT.saved);
    await first.next(sessionEnd(id));
    await turnStart(first, id, 'Anything else at all.');
    await first.next((line) => sessionEnd(id)(line) && first.lines.filter(sessionEnd(id)).length === 2);
    await turnStart(first, id, PROMPT.t3);
    await first.next(() => first.lines.filter(sessionEnd(id)).length === 3);
    await first.end();

    const second = await session();
    await second.request('thread/resume', { threadId: id, cwd: folder(), sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true });
    await turnStart(second, id, PROMPT.resume);
    await second.next(sessionEnd(id));
    await second.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full' });
    const page = await second.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full' });
    await second.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'summary', cursor: at(page, 'result', 'nextCursor') as string });
    await second.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded' });
    await second.request('thread/resume', { threadId: '00000000-0000-4000-8000-000000000000', cwd: folder() });
    await second.end();

    // The handshake's reply is the fake's own, as before M15.
    const sent = [...first.lines, ...second.lines].filter((line) => at(line, 'result', 'platformFamily') === undefined);
    expect(sent.length).toBeGreaterThan(80);
    const strangers = sent.filter((line) => !captured.has(comparable(line, folder())));
    expect(strangers.map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
    // The folder it was given is in what it sent, and no placeholder is.
    expect(JSON.stringify(sent)).toContain(JSON.stringify(folder()).slice(1, -1));
    expect(JSON.stringify(sent)).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
  });
});

describe('the prompt chooses the capture (C71)', () => {
  it('replays a capture for its own prompt, and T1 for any other', async () => {
    const fake = await session();
    const { id } = await startThread(fake);
    await turnStart(fake, id, 'What is the weather?');
    await fake.next(sessionEnd(id));
    const answers = items(fake, 'agentMessage').map((line) => at(line, 'params', 'item', 'text'));
    const t1 = capture('t1-basic').frames.filter((f) => f.frame['method'] === 'item/completed' && at(f.frame, 'params', 'item', 'type') === 'agentMessage').map((f) => at(f.frame, 'params', 'item', 'text'));
    expect(answers).toEqual(t1);

    await turnStart(fake, id, PROMPT.t5);
    const failed = await fake.next((line) => sessionEnd(id)(line) && at(line, 'params', 'turn', 'status') === 'failed');
    expect(at(failed, 'params', 'turn', 'error', 'message')).toContain('m10-no-such-model');
  });

  it('gives the echo the id the prompt was sent with, where the capture’s echo carries one', async () => {
    const fake = await session();
    const { id } = await startThread(fake);
    await turnStart(fake, id, PROMPT.saved, { clientUserMessageId: 'my-message-id' });
    expect(CLIENT_ID).not.toBe('my-message-id');
    await fake.next(sessionEnd(id));
    expect(items(fake, 'userMessage').map((line) => at(line, 'params', 'item', 'clientId'))).toEqual(['my-message-id']);
  });
});

describe('timing and waiting (C72)', () => {
  it('waits where the capture shows fat-g sending: T4 does not end until its interrupt arrives', async () => {
    const fake = await session();
    const { id } = await startThread(fake);
    const reply = await turnStart(fake, id, PROMPT.t4);
    const turnId = at(reply, 'result', 'turn', 'id');
    await fake.next((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'type') === 'commandExecution');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.lines.some(sessionEnd(id))).toBe(false);
    await fake.request('turn/interrupt', { threadId: id, turnId });
    const end = await fake.next(sessionEnd(id));
    expect(at(end, 'params', 'turn', 'status')).toBe('interrupted');
    expect(at(end, 'params', 'turn', 'id')).toBe(turnId);
    // T4's late item still follows the turn's end.
    await fake.next((line) => line['method'] === 'item/completed' && at(line, 'params', 'item', 'type') === 'commandExecution');
    expect(threadFile()[id]?.interrupts).toEqual([{ inputOpen: true, worker: false }]);
  });

  it('refuses an interrupt before the turn has started, as traced, and takes one once it has', async () => {
    setControl({ hang: 'send' });
    const fake = await session();
    const { id } = await startThread(fake);
    fake.send({ id: 90, method: 'turn/start', params: { threadId: id, input: [{ type: 'text', text: PROMPT.t1 }] } });
    const refused = await fake.request('turn/interrupt', { threadId: id, turnId: 'not-started' });
    expect(refused['error']).toEqual({ code: -32600, message: 'no active turn to interrupt' });

    // Keep T1 active until this test interrupts it; on a busy runner its short replay can
    // otherwise finish before the test receives turn/started.
    setControl({ turnNeverEnds: true });
    const reply = await turnStart(fake, id, PROMPT.t1);
    await fake.next((line) => line['method'] === 'turn/started');
    const taken = await fake.request('turn/interrupt', { threadId: id, turnId: at(reply, 'result', 'turn', 'id') });
    expect(taken['error']).toBeUndefined();
    expect(at(await fake.next(sessionEnd(id)), 'params', 'turn', 'status')).toBe('interrupted');
  });

  it('writes the turn/start reply and the frames after it as one chunk, on `oneChunk` (C110)', async () => {
    setControl({ oneChunk: 1 });
    const fake = await session();
    const { id } = await startThread(fake);
    fake.chunks.length = 0;
    const reply = await turnStart(fake, id, PROMPT.t3);
    await fake.next(sessionEnd(id));
    const chunk = fake.chunks.join('');
    const first = fake.chunks.find((part) => part.includes(`"id":${String(reply['id'])},"result"`)) ?? '';
    // The reply, the worker's announcement, the worker's own frames and the turn's end: one write.
    expect(first).toContain('"subAgentActivity"');
    expect(first).toContain('"turn/completed"');
    expect(first.length).toBe(chunk.length);
  });
});

describe('resume and history (C73, C127)', () => {
  it('a second process resumes a thread the first began, by the thread file where the environment says', async () => {
    const first = await session();
    const { id } = await startThread(first);
    await turnStart(first, id, PROMPT.t1);
    await first.next(sessionEnd(id));
    await first.end();
    expect(Object.keys(threadFile())).toEqual([id]);

    const second = await session();
    const resumed = await second.request('thread/resume', { threadId: id, cwd: folder(), sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true });
    expect(at(resumed, 'result', 'thread', 'id')).toBe(id);
    expect(at(resumed, 'result', 'thread', 'turns')).toEqual([]);
    expect(at(resumed, 'result', 'sandbox')).toEqual({ type: 'readOnly', networkAccess: false });
    expect(at(resumed, 'result', 'approvalPolicy')).toBe('never');
  });

  it('refuses the resume of a thread given no turn, and of an id it never saw, as Codex does a missing one', async () => {
    const first = await session();
    const { id } = await startThread(first);
    await first.end();
    const second = await session();
    for (const threadId of [id, '11111111-1111-4111-8111-111111111111']) {
      const refused = await second.request('thread/resume', { threadId, cwd: folder() });
      expect(refused['error']).toEqual({ code: -32600, message: `no rollout found for thread id ${threadId}` });
    }
    const read = await second.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full' });
    expect(at(read, 'error', 'code')).toBe(-32600);
  });

  it('reads history in pages, with the ids its live turns carried', async () => {
    const fake = await session();
    const { id } = await startThread(fake);
    await turnStart(fake, id, PROMPT.saved);
    await fake.next(sessionEnd(id));
    const live = [...items(fake, 'userMessage'), ...items(fake, 'agentMessage')].map((line) => at(line, 'params', 'item', 'id'));

    const all = await fake.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full' });
    const turns = at(all, 'result', 'data') as { items: { id: string; type: string }[] }[];
    expect(turns).toHaveLength(2);
    expect(at(all, 'result', 'nextCursor')).toBeNull();
    // Newest first: the saved turn is the older one, and its items are the live ones.
    const history = (turns[1] as { items: { id: string; type: string }[] }).items.filter((item) => item.type !== 'commandExecution').map((item) => item.id);
    expect(history).toEqual(live);

    const one = await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full' });
    expect(at(one, 'result', 'data')).toHaveLength(1);
    const cursor = at(one, 'result', 'nextCursor') as string;
    expect(typeof cursor).toBe('string');
    const older = await fake.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full', cursor });
    expect(at(older, 'result', 'data', 0, 'id')).toBe(at(all, 'result', 'data', 1, 'id'));
    const summary = await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'summary' });
    expect((at(summary, 'result', 'data', 0, 'items') as { type: string }[]).map((item) => item.type)).toEqual(['userMessage', 'agentMessage']);
    const bare = await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded' });
    expect(at(bare, 'result', 'data', 0, 'items')).toEqual([]);
    expect(at(bare, 'result', 'nextCursor')).toBe(cursor);
    // Each request is noted with its thread, in order, as an interrupt is (M18): a test reads there what the fake was asked for.
    expect(threadFile()[id]?.historyReads).toEqual([{ view: 'full', limit: 8, cursor: false }, { view: 'full', limit: 1, cursor: false }, { view: 'full', limit: 8, cursor: true }, { view: 'summary', limit: 1, cursor: false }, { view: 'notLoaded', limit: 1, cursor: false }]);
  });
});

describe('the controls (C74, C115)', () => {
  it.each(['exitDuringStart', 'exitDuringTurn'] as const)('%s: the process ends at that point', async (name) => {
    setControl({ [name]: 1 });
    const fake = await session();
    if (name === 'exitDuringStart') fake.send({ id: 50, method: 'thread/start', params: { cwd: folder() } });
    else { const { id } = await startThread(fake); await turnStart(fake, id, PROMPT.t1); }
    expect(await fake.closed).toBe(3);
    expect(fake.lines.some((line) => line['method'] === 'turn/completed')).toBe(false);
  });

  it('exitWithWorker and exitAfterTurnWithWorker: the process ends with a worker open', async () => {
    setControl({ exitWithWorker: 1 });
    const first = await session();
    const started = await startThread(first);
    await turnStart(first, started.id, PROMPT.t3);
    expect(await first.closed).toBe(3);
    expect(first.lines.some((line) => at(line, 'params', 'item', 'type') === 'subAgentActivity')).toBe(true);
    expect(first.lines.some(sessionEnd(started.id))).toBe(false);

    setControl({ exitAfterTurnWithWorker: 1 });
    const second = await session();
    const next = await startThread(second);
    await turnStart(second, next.id, PROMPT.outlive);
    expect(await second.closed).toBe(3);
    expect(second.lines.filter(sessionEnd(next.id))).toHaveLength(1);
    expect(second.lines.some((line) => at(line, 'params', 'item', 'kind') === 'completed')).toBe(false);
  });

  it.each([['sandbox', { type: 'workspaceWrite', writableRoots: [], networkAccess: false }, 'never'], ['network', { type: 'readOnly', networkAccess: true }, 'never'], ['policy', { type: 'readOnly', networkAccess: false }, 'on-request']] as const)(
    'otherSandbox %s: the start reply reports another one', async (kind, sandbox, policy) => {
      setControl({ otherSandbox: kind });
      const fake = await session();
      const { reply } = await startThread(fake);
      expect(at(reply, 'result', 'sandbox')).toEqual(sandbox);
      expect(at(reply, 'result', 'approvalPolicy')).toBe(policy);
    });

  it.each([['handshake', 'initialize'], ['open', 'thread/start'], ['reopen', 'thread/resume'], ['send', 'turn/start'], ['history', 'thread/turns/list']] as const)('hang %s: %s never answers', async (step, method) => {
    setControl({ hang: step });
    const fake = step === 'handshake' ? start() : await session();
    fake.send({ id: 70, method, params: { threadId: 'x', cwd: folder(), capabilities: { optOutNotificationMethods: OPT_OUT }, input: [{ type: 'text', text: 'x' }] } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.lines.some((line) => line['id'] === 70)).toBe(false);
    // The account reads are untouched: another connection's handshake still answers.
    const other = start();
    expect(at(await other.request('initialize', { clientInfo: { name: 'fat_g' } }), 'result', 'platformFamily')).toBe('fixture');
  });

  it('turnNeverEnds: the turn’s end and the status change are withheld; hang stop: an interrupt gets no answer', async () => {
    setControl({ turnNeverEnds: true, hang: 'stop' });
    const fake = await session();
    const { id } = await startThread(fake);
    const reply = await turnStart(fake, id, PROMPT.t1);
    await fake.next((line) => at(line, 'params', 'item', 'phase') === 'final_answer' && line['method'] === 'item/completed');
    fake.send({ id: 71, method: 'turn/interrupt', params: { threadId: id, turnId: at(reply, 'result', 'turn', 'id') } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.lines.some(sessionEnd(id))).toBe(false);
    expect(fake.lines.some((line) => line['method'] === 'thread/status/changed' && at(line, 'params', 'status', 'type') === 'idle')).toBe(false);
    expect(fake.lines.some((line) => line['id'] === 71)).toBe(false);
  });

  it('refuseInterrupt: an interrupt during a turn is refused, and the turn runs on', async () => {
    setControl({ refuseInterrupt: true });
    const fake = await session();
    const { id } = await startThread(fake);
    const reply = await turnStart(fake, id, PROMPT.t1);
    await fake.next((line) => line['method'] === 'turn/started');
    const refused = await fake.request('turn/interrupt', { threadId: id, turnId: at(reply, 'result', 'turn', 'id') });
    expect(at(refused, 'error', 'code')).toBe(-32600);
    expect(at(await fake.next(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
  });

  it('approvalRequest: T7’s request is sent during the turn, and resolved once it is answered', async () => {
    setControl({ approvalRequest: 1 });
    const fake = await session();
    const { id } = await startThread(fake);
    await turnStart(fake, id, PROMPT.t1);
    const request = await fake.next((line) => line['method'] === 'item/commandExecution/requestApproval');
    expect(at(request, 'params', 'threadId')).toBe(id);
    expect(fake.lines.some((line) => line['method'] === 'serverRequest/resolved')).toBe(false);
    fake.send({ id: request['id'], result: { decision: 'decline' } });
    await fake.next((line) => line['method'] === 'serverRequest/resolved');
    expect(at(await fake.next(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
  });

  it('workerNoClose, workerNoTurnEnd and workerTurnFailed change T3’s worker’s end, each in its one way', async () => {
    const run = async (controls: Json) => {
      setControl(controls);
      const fake = await session();
      const { id } = await startThread(fake);
      await turnStart(fake, id, PROMPT.t3);
      await fake.next(sessionEnd(id));
      const closing = fake.lines.filter((line) => at(line, 'params', 'item', 'type') === 'subAgentActivity' && at(line, 'params', 'item', 'kind') === 'completed').length;
      const workerEnds = fake.lines.filter((line) => line['method'] === 'turn/completed' && at(line, 'params', 'threadId') !== id).map((line) => at(line, 'params', 'turn', 'status'));
      await fake.end();
      return { closing, workerEnds };
    };
    expect(await run({})).toEqual({ closing: 2, workerEnds: ['completed'] });
    expect(await run({ workerNoClose: true })).toEqual({ closing: 0, workerEnds: ['completed'] });
    expect(await run({ workerNoTurnEnd: true })).toEqual({ closing: 2, workerEnds: [] });
    expect(await run({ workerTurnFailed: true })).toEqual({ closing: 2, workerEnds: ['failed'] });
  });

  it('oversize: the named frame is padded past the line limit', async () => {
    const size = (line: Json | undefined): number => Buffer.byteLength(JSON.stringify(line ?? null));
    setControl({ oversize: 'toolOutput' });
    let fake = await session();
    let { id } = await startThread(fake);
    await turnStart(fake, id, PROMPT.t1);
    await fake.next(sessionEnd(id));
    expect(size(items(fake, 'commandExecution')[0])).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
    expect(size(fake.lines.find(sessionEnd(id)))).toBeLessThan(MIB);
    await fake.end();

    setControl({ oversize: 'turnCompleted' });
    fake = await session();
    ({ id } = await startThread(fake));
    await turnStart(fake, id, PROMPT.t1);
    expect(size(await fake.next(sessionEnd(id)))).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
    expect(size(items(fake, 'commandExecution')[0])).toBeLessThan(MIB);
    // The status still leaves `active`: what C89 reads when the end itself is lost.
    expect(fake.lines.some((line) => line['method'] === 'thread/status/changed' && at(line, 'params', 'status', 'type') === 'idle')).toBe(true);

    setControl({ oversize: 'historyPage' });
    expect(size(await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded' }))).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
    setControl({ oversize: 'historyTurn' });
    expect(size(await fake.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full' }))).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
    expect(size(await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'full' }))).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
    const summary = await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'summary' });
    expect(size(summary)).toBeLessThan(MIB);
    // Older turns are behind it, and readable.
    expect(size(await fake.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full', cursor: at(summary, 'result', 'nextCursor') as string }))).toBeLessThan(MIB);
    setControl({ oversize: 'historyTurnSummary' });
    expect(size(await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'summary' }))).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
    expect(size(await fake.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded' }))).toBeLessThan(MIB);
    await fake.end();

    setControl({ oversize: 'reply' });
    fake = await session();
    expect(size((await startThread(fake)).reply)).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
  }, 90_000);

  it('resumeRefused: the captured refusal of an id that is not one, and the same with another code (C129)', async () => {
    const first = await session();
    const { id } = await startThread(first);
    await turnStart(first, id, PROMPT.t1);
    await first.next(sessionEnd(id));
    setControl({ resumeRefused: 'malformed' });
    const same = await first.request('thread/resume', { threadId: id, cwd: folder() });
    expect(at(same, 'error', 'code')).toBe(-32600);
    expect(String(at(same, 'error', 'message'))).toMatch(/^invalid session id/);
    setControl({ resumeRefused: 'otherCode' });
    const other = await first.request('thread/resume', { threadId: id, cwd: folder() });
    expect(at(other, 'error', 'code')).toBe(-32000);
    expect(at(other, 'error', 'message')).toBe(at(same, 'error', 'message'));
  });

  it('longText: the named string is padded past its bound, its frame staying under the line limit (C115)', async () => {
    const text = (line: Json | undefined): string => String(at(line, 'params', 'item', 'text'));
    setControl({ longText: 'answer' });
    let fake = await session();
    let { id } = await startThread(fake);
    await turnStart(fake, id, PROMPT.t1);
    await fake.next(sessionEnd(id));
    const messages = items(fake, 'agentMessage');
    expect(text(messages.find((line) => at(line, 'params', 'item', 'phase') === 'final_answer'))).toHaveLength(100_001);
    expect(text(messages.find((line) => at(line, 'params', 'item', 'phase') === 'commentary')).length).toBeLessThan(2_000);
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(MIB);

    setControl({ longText: 'commentary' });
    await turnStart(fake, id, PROMPT.t1);
    await fake.next(() => fake.lines.filter(sessionEnd(id)).length === 2);
    expect(text(items(fake, 'agentMessage').findLast((line) => at(line, 'params', 'item', 'phase') === 'commentary'))).toHaveLength(2_050);

    setControl({ longText: 'historyItem' });
    const page = await fake.request('thread/turns/list', { threadId: id, limit: 8, itemsView: 'full' });
    const answers = (at(page, 'result', 'data') as { items: { type: string; phase?: string; text?: string }[] }[]).flatMap((turn) => turn.items.filter((item) => item.phase === 'final_answer'));
    expect(answers.map((item) => item.text?.length)).toEqual([100_001, 100_001]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(MIB);
    await fake.end();

    setControl({ longText: 'question' });
    fake = await session();
    ({ id } = await startThread(fake));
    await turnStart(fake, id, PROMPT.t6);
    const asked = await fake.next((line) => line['method'] === 'item/completed' && Array.isArray(at(line, 'params', 'item', 'questions')));
    const questions = at(asked, 'params', 'item', 'questions') as { title: string; options: string[] }[];
    expect(questions).toHaveLength(17);
    expect(questions[0]?.options).toHaveLength(9);
    expect(questions[0]?.title).toHaveLength(501);
  });
});

describe('the descendant (C49, C114, C128)', () => {
  it('starts with a session’s thread, records itself, and ends when the fake’s input closes', async () => {
    const fake = await session({ FATG_SMOKE_CODEX_DESCENDANT: '1' });
    await startThread(fake);
    await expect.poll(() => pids().length, { timeout: 5000 }).toBe(2);
    const [root, child] = [fake.pid, pids().find((pid) => pid !== fake.pid) as number];
    expect(alive(child)).toBe(true);
    await fake.end();
    await expect.poll(() => alive(child) || alive(root), { timeout: 5000 }).toBe(false);
  });

  it('`hold` keeps the fake’s output open after the fake has ended, until it is ended itself', async () => {
    const fake = await session({ FATG_SMOKE_CODEX_DESCENDANT: 'hold' });
    await startThread(fake);
    await expect.poll(() => pids().length, { timeout: 5000 }).toBe(2);
    const child = pids().find((pid) => pid !== fake.pid) as number;
    let closed = false;
    void fake.closed.then(() => { closed = true; });
    void fake.end();
    await expect.poll(() => fake.exited(), { timeout: 5000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The root has exited, and its pipes have not closed: what makes a cleanup unconfirmed.
    expect(closed).toBe(false);
    expect(alive(child)).toBe(true);
    // It ignores SIGTERM, as `ignore` does: on POSIX only a kill ends it.
    process.kill(child, 'SIGKILL');
    await fake.closed;
  });

  it('`ignore` outlives the fake, its closed input ignored', async () => {
    const fake = await session({ FATG_SMOKE_CODEX_DESCENDANT: 'ignore' });
    await startThread(fake);
    await expect.poll(() => pids().length, { timeout: 5000 }).toBe(2);
    const child = pids().find((pid) => pid !== fake.pid) as number;
    await fake.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(child)).toBe(true);
    process.kill(child, 'SIGKILL');
    await expect.poll(() => alive(child), { timeout: 5000 }).toBe(false);
  });

  it('starts no descendant for the account reads', async () => {
    const fake = start({ FATG_SMOKE_CODEX_DESCENDANT: '1' });
    await fake.request('initialize', { clientInfo: { name: 'fat_g' } });
    fake.send({ method: 'initialized' });
    await fake.request('account/read', { refreshToken: false });
    expect(pids()).toEqual([fake.pid]);
  });
});

// ── M19: a message's deltas ───────────────────────────────────────────────────────────────────
// V19 (docs/planning/_archive/M19.md; C54, C56): the fake sends a delta frame only to a handshake that does
// not opt out of it, each from one of K1's capture files, and each new control changes one named
// thing as it is sent.
describe('a message’s deltas (M19: V19; C54, C56)', () => {
  const DELTA = 'item/agentMessage/delta';
  const STREAM = { answer: promptOf('m19-answer'), worker: promptOf('m19-worker'), interrupt: promptOf('m19-interrupt'), markdown: promptOf('m19-markdown') };
  /** A session's process whose handshake keeps the agent message's delta, as fat-g's does since M19. */
  async function streaming(optOut: readonly string[] = OPTED_OUT_DELTAS): Promise<Fake> {
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...optOut] } });
    fake.send({ method: 'initialized' });
    return fake;
  }
  const deltas = (fake: Fake): Json[] => fake.lines.filter((line) => line['method'] === DELTA);
  const completedMessages = (fake: Fake): Json[] => items(fake, 'agentMessage');
  /** The capture's own received frames of one method, as they compare. */
  const capturedOf = (name: string, method: string): string[] => capture(name).frames.filter((f) => f.dir === 'recv' && f.frame['method'] === method).map((f) => comparable(f.frame, '<never>'));
  /** One turn of `prompt` on a new thread, to its end. */
  async function turn(fake: Fake, prompt: string): Promise<string> {
    const { id } = await startThread(fake);
    await turnStart(fake, id, prompt);
    await fake.next(sessionEnd(id), 30_000);
    return id;
  }
  /** The id of the session's final answer, by its `item/started`. */
  const answerOf = (fake: Fake, threadId: string): string => String(at(fake.lines.find((line) => line['method'] === 'item/started' && at(line, 'params', 'threadId') === threadId && at(line, 'params', 'item', 'phase') === 'final_answer'), 'params', 'item', 'id'));

  it('keeps the same prompts under one name each: T1’s and T3’s are K1’s first and third', () => {
    expect(STREAM.answer).toBe(PROMPT.t1);
    expect(STREAM.worker).toBe(PROMPT.t3);
    expect(new Set(Object.values(STREAM)).size).toBe(4);
  });

  it('sends no delta to a handshake that opts out of it: T1’s prompt replays T1, whole, as before', async () => {
    for (const optOut of [OPT_OUT, [...OPTED_OUT_DELTAS, DELTA]]) {
      const fake = await streaming(optOut);
      await turn(fake, PROMPT.t1);
      expect(deltas(fake)).toEqual([]);
      const t1 = capture('t1-basic').frames.filter((f) => f.frame['method'] === 'item/completed' && at(f.frame, 'params', 'item', 'type') === 'agentMessage').map((f) => at(f.frame, 'params', 'item', 'text'));
      expect(completedMessages(fake).map((line) => at(line, 'params', 'item', 'text'))).toEqual(t1);
      await fake.end();
    }
  });

  it('sends K1’s deltas to a handshake that keeps them, every frame from a capture file but for ids, times and the folder', async () => {
    const fake = await streaming();
    const id = await turn(fake, STREAM.answer);
    // The capture's own 19 deltas, in its order, and its two whole messages.
    expect(deltas(fake).map((line) => comparable(line, folder()))).toEqual(capturedOf('m19-answer', DELTA));
    expect(deltas(fake)).toHaveLength(19);
    expect(deltas(fake).every((line) => at(line, 'params', 'threadId') === id)).toBe(true);
    const texts = capture('m19-answer').frames.filter((f) => f.frame['method'] === 'item/completed' && at(f.frame, 'params', 'item', 'type') === 'agentMessage').map((f) => at(f.frame, 'params', 'item', 'text'));
    expect(completedMessages(fake).map((line) => at(line, 'params', 'item', 'text'))).toEqual(texts);
    // Each delta names the item its `item/started` named, and the turn the reply named.
    const reply = fake.lines.find((line) => at(line, 'result', 'turn', 'id') !== undefined);
    expect(new Set(deltas(fake).map((line) => at(line, 'params', 'turnId')))).toEqual(new Set([at(reply, 'result', 'turn', 'id')]));
    const opened = fake.lines.filter((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'type') === 'agentMessage').map((line) => at(line, 'params', 'item', 'id'));
    expect(new Set(deltas(fake).map((line) => at(line, 'params', 'itemId')))).toEqual(new Set(opened));

    const sent = fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined);
    expect(sent.filter((line) => !captured.has(comparable(line, folder()))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
    await fake.end();
  });

  it('sends a worker’s deltas on the worker’s own thread and turn, and a long answer’s 840', async () => {
    const fake = await streaming();
    const id = await turn(fake, STREAM.worker);
    expect(deltas(fake)).toHaveLength(57);
    expect(deltas(fake).filter((line) => at(line, 'params', 'threadId') !== id)).toHaveLength(20);
    expect(deltas(fake).map((line) => comparable(line, folder()))).toEqual(capturedOf('m19-worker', DELTA));
    await fake.end();

    const long = await streaming();
    await turn(long, STREAM.markdown);
    expect(deltas(long)).toHaveLength(840);
    expect(deltas(long).map((line) => at(line, 'params', 'delta')).join('')).toBe(at(completedMessages(long)[0], 'params', 'item', 'text'));
    expect(long.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined && !captured.has(comparable(line, folder())))).toEqual([]);
    await long.end();
  });

  it('replays a capture of whole items for any other prompt, also to a handshake that keeps the delta', async () => {
    const fake = await streaming();
    await turn(fake, 'What is the weather?');
    expect(deltas(fake)).toEqual([]);
    expect(completedMessages(fake)).toHaveLength(2);
    await fake.end();
  });

  it('sends no frame of any method the handshake opted out of', async () => {
    const fake = await streaming([...OPTED_OUT_DELTAS, 'thread/tokenUsage/updated', 'account/rateLimits/updated']);
    await turn(fake, STREAM.answer);
    expect(fake.lines.filter((line) => line['method'] === 'thread/tokenUsage/updated' || line['method'] === 'account/rateLimits/updated')).toEqual([]);
    expect(deltas(fake)).toHaveLength(19);
    await fake.end();
  });

  it('waits for the interrupt where K1’s capture shows it: five deltas, no completing frame, and the turn ends interrupted', async () => {
    const fake = await streaming();
    const { id } = await startThread(fake);
    const reply = await turnStart(fake, id, STREAM.interrupt);
    await fake.next(() => deltas(fake).length === 5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.lines.some(sessionEnd(id))).toBe(false);
    await fake.request('turn/interrupt', { threadId: id, turnId: at(reply, 'result', 'turn', 'id') as string });
    const ended = await fake.next(sessionEnd(id));
    expect(at(ended, 'params', 'turn', 'status')).toBe('interrupted');
    expect(deltas(fake)).toHaveLength(5);
    expect(completedMessages(fake)).toEqual([]);
    await fake.end();
  });

  describe('the controls, each one named change (C56)', () => {
    it('wholeDiffers: the answer’s completing frame carries another text than its deltas', async () => {
      setControl({ wholeDiffers: true });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      const answer = answerOf(fake, id);
      const streamed = deltas(fake).filter((line) => at(line, 'params', 'itemId') === answer).map((line) => at(line, 'params', 'delta')).join('');
      const whole = completedMessages(fake).find((line) => at(line, 'params', 'item', 'id') === answer);
      expect(at(whole, 'params', 'item', 'text')).toBe(`${streamed} (as completed)`);
      // Nothing else changed: the deltas are the capture's own.
      expect(deltas(fake).map((line) => comparable(line, folder()))).toEqual(capturedOf('m19-answer', DELTA));
    });

    it('answerText: the answer is the text given — its first delta brings all of it, no other is sent, and the completing frame holds the same', async () => {
      const given = '# A title\n\n<script>never run</script> and [a link](javascript:void 0)';
      setControl({ answerText: given });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      const answer = answerOf(fake, id);
      expect(deltas(fake).filter((line) => at(line, 'params', 'itemId') === answer).map((line) => at(line, 'params', 'delta'))).toEqual([given]);
      expect(at(completedMessages(fake).find((line) => at(line, 'params', 'item', 'id') === answer), 'params', 'item', 'text')).toBe(given);
      // The commentary before it is the capture's own, deltas and all.
      const others = deltas(fake).filter((line) => at(line, 'params', 'itemId') !== answer);
      expect(others.length).toBeGreaterThan(0);
      expect(others.map((line) => comparable(line, folder()))).toEqual(capturedOf('m19-answer', DELTA).slice(0, others.length));
      expect(at(fake.lines.find(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
    });

    it('noCompletion: the answer’s completing frame is withheld, and the turn’s end is not', async () => {
      setControl({ noCompletion: true });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      expect(completedMessages(fake).map((line) => at(line, 'params', 'item', 'phase'))).toEqual(['commentary']);
      expect(deltas(fake)).toHaveLength(19);
      expect(at(fake.lines.find(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
    });

    it('noDeltas: the answer’s deltas are withheld, so it arrives whole; the commentary’s are sent', async () => {
      setControl({ noDeltas: true });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      const answer = answerOf(fake, id);
      expect(deltas(fake)).toHaveLength(12);
      expect(deltas(fake).some((line) => at(line, 'params', 'itemId') === answer)).toBe(false);
      expect(completedMessages(fake).map((line) => at(line, 'params', 'item', 'phase'))).toEqual(['commentary', 'final_answer']);
    });

    it.each([['deltaOtherThread', 'threadId'], ['deltaOtherTurn', 'turnId']] as const)('%s: every delta names another, and nothing else of it changes', async (name, field) => {
      setControl({ [name]: true });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      const reply = fake.lines.find((line) => at(line, 'result', 'turn', 'id') !== undefined);
      const own = field === 'threadId' ? id : at(reply, 'result', 'turn', 'id');
      expect(deltas(fake)).toHaveLength(19);
      expect(deltas(fake).every((line) => at(line, 'params', field) !== own)).toBe(true);
      // Masked, each is still the captured frame: only an id differs.
      expect(deltas(fake).map((line) => comparable(line, folder()))).toEqual(capturedOf('m19-answer', DELTA));
    });

    it('deltaAfterComplete: the answer’s last delta is sent once more, after its completing frame', async () => {
      setControl({ deltaAfterComplete: true });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      const answer = answerOf(fake, id);
      expect(deltas(fake)).toHaveLength(20);
      const done = fake.lines.findIndex((line) => line['method'] === 'item/completed' && at(line, 'params', 'item', 'id') === answer);
      const late = fake.lines.slice(done + 1).filter((line) => line['method'] === DELTA);
      expect(late).toHaveLength(1);
      expect(late[0]).toEqual(fake.lines.slice(0, done).filter((line) => line['method'] === DELTA).at(-1));
    });

    it('deltasPastBound: each of the answer’s deltas is padded to 20 000 units, and no other frame changes', async () => {
      setControl({ deltasPastBound: true });
      const fake = await streaming();
      const id = await turn(fake, STREAM.answer);
      const answer = answerOf(fake, id);
      const sizes = deltas(fake).map((line) => [at(line, 'params', 'itemId') === answer, String(at(line, 'params', 'delta')).length] as const);
      expect(sizes.filter(([mine]) => mine).map(([, size]) => size)).toEqual(Array.from({ length: 7 }, () => 20_000));
      expect(sizes.filter(([mine]) => !mine).every(([, size]) => size < 100)).toBe(true);
      // The padding is spaces after the captured text: trimmed, each is the capture's own delta.
      const trimmed = deltas(fake).map((line) => (at(line, 'params', 'itemId') === answer ? { ...line, params: { ...(line['params'] as Json), delta: String(at(line, 'params', 'delta')).replace(/ +$/, (spaces) => (spaces.length > 1000 ? '' : spaces)) } } : line));
      expect(trimmed.map((line) => comparable(line, folder())).length).toBe(19);
      expect(completedMessages(fake)).toHaveLength(2);
    });

    it('exitBetweenDeltas: the process ends after the answer’s second delta', async () => {
      setControl({ exitBetweenDeltas: 1 });
      const fake = await streaming();
      const { id } = await startThread(fake);
      await turnStart(fake, id, STREAM.answer);
      expect(await fake.closed).toBe(3);
      const answer = answerOf(fake, id);
      expect(deltas(fake).filter((line) => at(line, 'params', 'itemId') === answer)).toHaveLength(2);
      expect(fake.lines.some(sessionEnd(id))).toBe(false);
      expect(completedMessages(fake).map((line) => at(line, 'params', 'item', 'phase'))).toEqual(['commentary']);
    });
  });
});

// ── M19b ──────────────────────────────────────────────────────────────────────────────────────
// V15 (docs/planning/_archive/M19b.md, Design 10; C46): K2's captures, whose answers name a file. Codex wrote
// a file's address with forward slashes, the folder's own among them, once with a slash before the
// drive; the fake puts the folder back the same way in the agent's messages, so that what goes out
// is what the CLI sent.
describe('an answer that names a file (M19b: V15; C46)', () => {
  const DELTA = 'item/agentMessage/delta';
  const NAMES = ['m19b-line', 'm19b-readme', 'm19b-space'] as const;
  const forward = (): string => folder().replaceAll('\\', '/');
  /** A frame as it compares, the folder taken out in either spelling. */
  const compared = (line: Json): string => comparable(JSON.parse(JSON.stringify(line).replaceAll(forward(), '<scratch>')) as Json, folder());
  /** Every capture's prompt, by its file. */
  const prompts = readdirSync(CAPTURES).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''))
    .flatMap((name) => { const sent = capture(name).frames.find((f) => f.dir === 'send' && f.frame['method'] === 'turn/start'); return sent === undefined ? [] : [[name, String(at(sent.frame, 'params', 'input', 0, 'text'))] as const]; });

  async function turn(name: string): Promise<{ fake: Fake; id: string }> {
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const { id } = await startThread(fake);
    await turnStart(fake, id, promptOf(name));
    await fake.next(sessionEnd(id), 30_000);
    return { fake, id };
  }
  const answer = (fake: Fake): string => String(at(items(fake, 'agentMessage').find((line) => at(line, 'params', 'item', 'phase') === 'final_answer'), 'params', 'item', 'text'));
  const deltasOf = (fake: Fake, itemId: unknown): string => fake.lines.filter((line) => line['method'] === DELTA && at(line, 'params', 'itemId') === itemId).map((line) => String(at(line, 'params', 'delta'))).join('');

  it('are three captures, each chosen by a prompt no other capture has', () => {
    for (const name of NAMES) expect(prompts.filter(([, prompt]) => prompt === promptOf(name)).map(([file]) => file), name).toEqual([name]);
    expect(new Set(NAMES.map((name) => promptOf(name))).size).toBe(3);
  });

  it.each(NAMES)('replays %s for its prompt, every frame from a capture file but for ids, times and the folder', async (name) => {
    const { fake, id } = await turn(name);
    const sent = fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined);
    expect(sent.filter((line) => !captured.has(compared(line))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
    // The capture's own deltas, in its order: what they bring is the answer its completing frame holds.
    const own = capture(name).frames.filter((f) => f.dir === 'recv' && f.frame['method'] === DELTA);
    expect(fake.lines.filter((line) => line['method'] === DELTA)).toHaveLength(own.length);
    const final = items(fake, 'agentMessage').find((line) => at(line, 'params', 'item', 'phase') === 'final_answer');
    expect(deltasOf(fake, at(final, 'params', 'item', 'id'))).toBe(answer(fake));
    expect(threadFile()[id]).toMatchObject({ turns: [name] });
    await fake.end();
  });

  it('holds 55, 92 and 62 deltas, as the captures do', () => {
    expect(NAMES.map((name) => capture(name).frames.filter((f) => f.dir === 'recv' && f.frame['method'] === DELTA).length)).toEqual([55, 92, 62]);
  });

  it('writes the folder with forward slashes in a file’s address, after the slash the CLI put before a drive', async () => {
    const line = await turn('m19b-line');
    expect(answer(line.fake)).toBe(`\`nextHighTide\` is defined in [src/tides.js:12](/${forward()}/src/tides.js:12).`);
    // The capture's deltas hold the folder as one piece, and the pieces of a path that came after it empty: the redaction's.
    expect(line.fake.lines.filter((entry) => entry['method'] === DELTA && at(entry, 'params', 'delta') === forward())).toHaveLength(1);
    await line.fake.end();
    const readme = await turn('m19b-readme');
    expect(answer(readme.fake)).toContain(`[Tide tools’ README](${forward()}/README.md)`);
    expect(answer(readme.fake)).not.toContain('\\');
    await readme.fake.end();
  });

  it('names its file by an address the page reads as a file of this system, at the line the answer gives', async () => {
    const { fake } = await turn('m19b-line');
    const address = /\]\(([^)]+)\)/.exec(answer(fake))?.[1] ?? '';
    expect(readAddress(address, process.platform)).toBe('local');
    const target = readTarget(address, process.platform)?.tries[0];
    expect(target?.line).toBe(12);
    expect(path.resolve(target?.path ?? '')).toBe(path.join(folder(), 'src', 'tides.js'));
    await fake.end();
  });

  it('leaves the folder as it is wherever the CLI wrote it the system’s own way: a command it ran', async () => {
    const { fake } = await turn('m19b-readme');
    const commands = fake.lines.filter((line) => at(line, 'params', 'item', 'type') === 'commandExecution').map((line) => JSON.stringify(at(line, 'params', 'item')));
    expect(commands.length).toBeGreaterThan(0);
    // Where it names the folder at all, it is the folder as the thread was given it.
    for (const command of commands.filter((text) => text.includes(path.basename(dir)))) expect(command).toContain(JSON.stringify(folder()).slice(1, -1));
    await fake.end();
  });

  it('names a file in bold beside its folder in a code span, in the third: a name the page reads as a code span’s (C64)', async () => {
    const { fake } = await turn('m19b-space');
    expect(answer(fake)).toContain('**harbour-log.md**');
    // The name in bold is what makes this answer openable: a bare name with a listed ending, looked up (C55, C64).
    expect(readCodeSpanPath('harbour-log.md')).toEqual({ path: 'harbour-log.md', line: null, column: null });
    const spans = [...answer(fake).matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    expect(spans).toEqual(['field notes']);
    expect(spans.map((span) => readCodeSpanPath(span))).toEqual([null]);
    await fake.end();
  });
});

// ── M20a: what a session does between its messages ────────────────────────────────────────────

describe('what a session does between its messages (M20a: V14; C51, C52)', () => {
  const PLAN = 'turn/plan/updated';
  const NAMES = ['m20a-steps-main', 'm20a-steps-tracked-main', 'm20a-steps-tool-main', 'm20a-steps-tool-on-main'] as const;
  /** Each capture with the control it is replayed under: the last was taken with the checklist tool switched on. */
  const RUNS: readonly (readonly [(typeof NAMES)[number], Json])[] = [['m20a-steps-main', {}], ['m20a-steps-tracked-main', {}], ['m20a-steps-tool-main', {}], ['m20a-steps-tool-on-main', { planTool: true }]];
  const forward = (): string => folder().replaceAll('\\', '/');
  /** A frame as it compares, the folder taken out in either spelling. */
  const compared = (line: Json): string => comparable(JSON.parse(JSON.stringify(line).replaceAll(forward(), '<scratch>')) as Json, folder());
  const size = (line: Json | undefined): number => Buffer.byteLength(JSON.stringify(line ?? null));
  const received = (name: string, method: string, type?: string): { frame: Json }[] => capture(name).frames.filter((f) => f.dir === 'recv' && f.frame['method'] === method && (type === undefined || at(f.frame, 'params', 'item', 'type') === type));
  const sentOf = (fake: Fake, method: string, type?: string): Json[] => fake.lines.filter((line) => line['method'] === method && (type === undefined || at(line, 'params', 'item', 'type') === type));

  /** One turn of `prompt` on a new thread of a session whose handshake is fat-g's own, to its end. */
  async function turn(prompt: string, controls: Json = {}): Promise<{ fake: Fake; id: string }> {
    setControl(controls);
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const { id } = await startThread(fake);
    await turnStart(fake, id, prompt);
    await fake.next(sessionEnd(id), 60_000);
    return { fake, id };
  }
  /** The turn's first command, by its `item/started`: what each fault changes. */
  const firstCommand = (fake: Fake): unknown => at(sentOf(fake, 'item/started').find((line) => ['commandExecution', 'aLaterItemType'].includes(String(at(line, 'params', 'item', 'type')))), 'params', 'item', 'id');
  const completionOf = (fake: Fake, itemId: unknown): Json | undefined => sentOf(fake, 'item/completed').find((line) => at(line, 'params', 'item', 'id') === itemId);

  it('are four captures and three prompts: the one that asks for the checklist tool by name was taken with the tool off, and again with it on', () => {
    expect(new Set(NAMES.map((name) => promptOf(name))).size).toBe(3);
    expect(promptOf('m20a-steps-tool-main')).toBe(promptOf('m20a-steps-tool-on-main'));
    // What each holds, as K1 recorded it: commands and reasoning in all, the checklist's notifications in the last alone.
    expect(NAMES.map((name) => [received(name, 'item/completed', 'commandExecution').length, received(name, 'item/completed', 'reasoning').length, received(name, PLAN).length])).toEqual([[5, 1, 0], [5, 1, 0], [4, 2, 0], [4, 0, 5]]);
    expect(at(received('m20a-steps-tool-main', 'turn/completed')[0]?.frame, 'params', 'turn', 'status')).toBe('failed');
  });

  it.each(RUNS)('replays %s for its prompt, every frame from a capture file but for ids, times and the folder', async (name, controls) => {
    const { fake, id } = await turn(promptOf(name), controls);
    const sent = fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined);
    expect(sent.filter((line) => !captured.has(compared(line))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
    // The capture's own items, each started and completed, and its checklist's notifications.
    for (const type of ['commandExecution', 'reasoning']) {
      expect(sentOf(fake, 'item/started', type), type).toHaveLength(received(name, 'item/started', type).length);
      expect(sentOf(fake, 'item/completed', type), type).toHaveLength(received(name, 'item/completed', type).length);
    }
    expect(sentOf(fake, PLAN).map((line) => compared(line))).toEqual(received(name, PLAN).map((f) => comparable(f.frame, '<never>')));
    expect(sentOf(fake, PLAN).every((line) => at(line, 'params', 'threadId') === id)).toBe(true);
    expect(threadFile()[id]).toMatchObject({ turns: [name] });
    await fake.end();
  }, 90_000);

  it('answers the prompt that asks for the checklist tool from the capture taken with it off, unless `planTool` says the user’s configuration enables it', async () => {
    const off = await turn(promptOf('m20a-steps-tool-on-main'));
    expect(sentOf(off.fake, PLAN)).toEqual([]);
    // As captured: its commands ran, and the turn failed at the server.
    expect(at(off.fake.lines.find(sessionEnd(off.id)), 'params', 'turn', 'status')).toBe('failed');
    expect(sentOf(off.fake, 'error')).toHaveLength(1);
    expect(threadFile()[off.id]).toMatchObject({ turns: ['m20a-steps-tool-main'] });
    await off.fake.end();

    const on = await turn(promptOf('m20a-steps-tool-on-main'), { planTool: true });
    expect(sentOf(on.fake, PLAN)).toHaveLength(5);
    // The whole list each time, each step with its text and its status.
    for (const line of sentOf(on.fake, PLAN)) expect((at(line, 'params', 'plan') as { step: string; status: string }[]).map((step) => [typeof step.step, ['pending', 'inProgress', 'completed'].includes(step.status)])).toEqual(Array.from({ length: 4 }, () => ['string', true]));
    expect(at(on.fake.lines.find(sessionEnd(on.id)), 'params', 'turn', 'status')).toBe('completed');
    expect(threadFile()[on.id]).toMatchObject({ turns: ['m20a-steps-tool-on-main'] });
    await on.fake.end();
  }, 120_000);

  it('itemUnknown: the turn’s first command is of a type the adapter does not know, on both of its frames, and no other item is changed', async () => {
    const { fake } = await turn(promptOf('m20a-steps-main'), { itemUnknown: true });
    expect(sentOf(fake, 'item/started', 'aLaterItemType')).toHaveLength(1);
    expect(sentOf(fake, 'item/completed', 'aLaterItemType')).toHaveLength(1);
    expect(at(sentOf(fake, 'item/completed', 'aLaterItemType')[0], 'params', 'item', 'id')).toBe(at(sentOf(fake, 'item/started', 'aLaterItemType')[0], 'params', 'item', 'id'));
    expect(sentOf(fake, 'item/completed', 'commandExecution')).toHaveLength(4);
    // One named change: with its type put back, each frame is the capture's own.
    for (const line of [...sentOf(fake, 'item/started', 'aLaterItemType'), ...sentOf(fake, 'item/completed', 'aLaterItemType')]) {
      const restored = { ...line, params: { ...(line['params'] as Json), item: { ...(at(line, 'params', 'item') as Json), type: 'commandExecution' } } };
      expect(captured.has(compared(restored))).toBe(true);
    }
    await fake.end();
  }, 90_000);

  it('noItemCompletion: the first command’s completion never comes, and the turn ends all the same', async () => {
    const { fake, id } = await turn(promptOf('m20a-steps-main'), { noItemCompletion: true });
    const first = firstCommand(fake);
    expect(completionOf(fake, first)).toBeUndefined();
    expect(sentOf(fake, 'item/completed', 'commandExecution')).toHaveLength(4);
    expect(at(fake.lines.find(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
    await fake.end();
  }, 90_000);

  it('longText toolOutput: the first command’s output is past its bound, its last words still there, in a frame under the line limit', async () => {
    const { fake } = await turn(promptOf('m20a-steps-main'), { longText: 'toolOutput' });
    const completed = completionOf(fake, firstCommand(fake));
    const output = String(at(completed, 'params', 'item', 'aggregatedOutput'));
    expect(output.length).toBeGreaterThan(20_000);
    expect(output.endsWith('THE END')).toBe(true);
    expect(size(completed)).toBeLessThan(MIB);
    // No other command's output is changed.
    expect(sentOf(fake, 'item/completed', 'commandExecution').filter((line) => String(at(line, 'params', 'item', 'aggregatedOutput')).endsWith('THE END'))).toHaveLength(1);
    await fake.end();
  }, 90_000);

  it('quotedOutput: a megabyte of quotes makes a line of over two, under a session’s limit; oversize toolOutput makes one over it', async () => {
    const quoted = await turn(promptOf('m20a-steps-main'), { quotedOutput: true });
    const line = completionOf(quoted.fake, firstCommand(quoted.fake));
    expect(String(at(line, 'params', 'item', 'aggregatedOutput'))).toMatch(/"{1000000,}$/);
    expect(size(line)).toBeGreaterThan(2 * MIB);
    expect(size(line)).toBeLessThan(4 * MIB);
    await quoted.fake.end();

    const over = await turn(promptOf('m20a-steps-main'), { oversize: 'toolOutput' });
    const sizes = sentOf(over.fake, 'item/completed', 'commandExecution').map((entry) => size(entry));
    // Each escaped line exceeds Codex's media envelope while the raw output fits inside it.
    expect(sizes.every((bytes) => bytes > MEDIA_SESSION_LINE_BYTES)).toBe(true);
    expect(String(at(sentOf(over.fake, 'item/completed', 'commandExecution')[0], 'params', 'item', 'aggregatedOutput')).length).toBeLessThan(MEDIA_SESSION_LINE_BYTES);
    await over.fake.end();
  }, 120_000);

  it('a worker’s item after its turn’s end is a capture’s own, and no fault: the worker’s thread still sends items once the session’s turn is over', async () => {
    const { fake, id } = await turn(PROMPT.outlive);
    const end = fake.lines.findIndex(sessionEnd(id));
    await fake.next((line) => fake.lines.indexOf(line) > end && line['method'] === 'item/completed' && at(line, 'params', 'threadId') !== id, 30_000);
    const late = fake.lines.slice(end + 1).filter((line) => (line['method'] === 'item/started' || line['method'] === 'item/completed') && at(line, 'params', 'threadId') !== id);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((line) => captured.has(compared(line)))).toBe(true);
    await fake.end();
  }, 90_000);
});

// ── M20a, round 3 (K3): a sub-agent started through the `spawnAgent` collab tool ──────────────
describe('a sub-agent a spawn call starts (M20a: K3; C51, C70)', () => {
  const NAME = 'm20a-collab-spawn';
  const forward = (): string => folder().replaceAll('\\', '/');
  const compared = (line: Json): string => comparable(JSON.parse(JSON.stringify(line).replaceAll(forward(), '<scratch>')) as Json, folder());
  const prompts = readdirSync(CAPTURES).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''))
    .flatMap((name) => { const sent = capture(name).frames.find((f) => f.dir === 'send' && f.frame['method'] === 'turn/start'); return sent === undefined ? [] : [[name, String(at(sent.frame, 'params', 'input', 0, 'text'))] as const]; });

  it('is one capture, chosen by a prompt no other capture has, and holds no `subAgentActivity`', () => {
    expect(prompts.filter(([, prompt]) => prompt === promptOf(NAME)).map(([file]) => file)).toEqual([NAME]);
    const received = capture(NAME).frames.filter((f) => f.dir === 'recv');
    expect(received.some((f) => at(f.frame, 'params', 'item', 'type') === 'subAgentActivity')).toBe(false);
    expect(received.filter((f) => f.frame['method'] === 'item/completed' && at(f.frame, 'params', 'item', 'type') === 'collabAgentToolCall').map((f) => at(f.frame, 'params', 'item', 'tool'))).toEqual(['spawnAgent', 'wait']);
  });

  it('replays it for its prompt, every frame from a capture file but for ids, times and the folder, the worker’s frames on a thread of the worker’s own', async () => {
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const { id } = await startThread(fake);
    await turnStart(fake, id, promptOf(NAME));
    await fake.next(sessionEnd(id), 60_000);
    const sent = fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined);
    expect(sent.filter((line) => !captured.has(compared(line))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>|<worker-\d+>/);
    // The spawn call's completion names the worker's thread, which is no thread of the session's; the worker's own turn runs on it.
    const spawned = fake.lines.find((line) => line['method'] === 'item/completed' && at(line, 'params', 'item', 'tool') === 'spawnAgent');
    const worker = at(spawned, 'params', 'item', 'receiverThreadIds', 0);
    expect(typeof worker).toBe('string');
    expect(worker).not.toBe(id);
    expect(Object.keys(at(spawned, 'params', 'item', 'agentsStates') as object)).toEqual([worker]);
    expect(fake.lines.filter((line) => line['method'] === 'turn/completed').map((line) => at(line, 'params', 'threadId'))).toEqual([worker, id]);
    expect(fake.lines.filter((line) => line['method'] === 'item/completed' && at(line, 'params', 'threadId') === worker).map((line) => at(line, 'params', 'item', 'type'))).toEqual(['userMessage', 'reasoning', 'agentMessage', 'commandExecution', 'agentMessage']);
    // The wait that follows names the same thread, and reads it completed.
    const waited = fake.lines.find((line) => line['method'] === 'item/completed' && at(line, 'params', 'item', 'tool') === 'wait');
    expect(at(waited, 'params', 'item', 'agentsStates', String(worker), 'status')).toBe('completed');
    expect(threadFile()[id]).toMatchObject({ turns: [NAME] });
    await fake.end();
  }, 90_000);

  it('workerTurnFailed: the worker’s own turn ends failed, and nothing else of the capture is changed', async () => {
    setControl({ workerTurnFailed: true });
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const { id } = await startThread(fake);
    await turnStart(fake, id, promptOf(NAME));
    await fake.next(sessionEnd(id), 60_000);
    expect(fake.lines.filter((line) => line['method'] === 'turn/completed').map((line) => [at(line, 'params', 'threadId') === id ? 'session' : 'worker', at(line, 'params', 'turn', 'status')])).toEqual([['worker', 'failed'], ['session', 'completed']]);
    await fake.end();
  }, 90_000);
});

// ── M20b: an aside's side thread (V14; C61, C62) ──────────────────────────────────────────────
describe('a side thread forked for a question beside a session (M20b: V14; C19, C61, C62)', () => {
  const forward = (): string => folder().replaceAll('\\', '/');
  const compared = (line: Json): string => comparable(JSON.parse(JSON.stringify(line).replaceAll(forward(), '<scratch>')) as Json, folder());
  /** A capture's side threads: the forks it sent, and each question it sent to one. */
  function forks(name: string): { readonly sent: Json[]; readonly children: Set<string>; readonly questions: string[] } {
    const all = capture(name).frames;
    const sentForks = all.filter((f) => f.dir === 'send' && f.frame['method'] === 'thread/fork');
    const ids = sentForks.map((f) => f.frame['id']);
    const children = new Set(all.flatMap((f) => (f.dir === 'recv' && f.frame['method'] === undefined && ids.includes(f.frame['id']) && typeof at(f.frame, 'result', 'thread', 'id') === 'string' ? [String(at(f.frame, 'result', 'thread', 'id'))] : [])));
    const questions = all.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start' && children.has(String(at(f.frame, 'params', 'threadId')))).map((f) => String(at(f.frame, 'params', 'input', 0, 'text')));
    return { sent: sentForks.map((f) => f.frame['params'] as Json), children, questions };
  }
  /** The fork fat-g sends (C19): exactly these fields, the newest ended turn named where there is one. */
  const forkParams = (threadId: string, lastTurnId?: string): Json => ({
    threadId, ...(lastTurnId === undefined ? {} : { lastTurnId }), ephemeral: true, excludeTurns: true, cwd: folder(), sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: ASIDE_INSTRUCTIONS, model: 'gpt-6-astra',
  });
  /** A session that holds one ended turn, with Codex's own id for it. Its handshake is fat-g's own: an agent message's deltas are kept. */
  async function held(): Promise<{ fake: Fake; id: string; turnId: string }> {
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const { id } = await startThread(fake);
    const started = await turnStart(fake, id, PROMPT.t1);
    await fake.next(sessionEnd(id), 60_000);
    return { fake, id, turnId: String(at(started, 'result', 'turn', 'id')) };
  }
  const childOf = (reply: Json): string => String(at(reply, 'result', 'thread', 'id'));
  const ofThread = (fake: Fake, threadId: string): Json[] => fake.lines.filter((line) => at(line, 'params', 'threadId') === threadId || at(line, 'params', 'thread', 'id') === threadId);
  interface Noted { forks?: Json[]; asides?: { capture: string; text: string }[]; asideInterrupts?: unknown[] }
  const noted = (id: string): Noted => threadFile()[id] as unknown as Noted;

  it('names K3’s seven captures, two of them turns a side thread is asked during, and every fork in them is sent with the fields the app may send', () => {
    expect([...FORK_CAPTURES]).toEqual(['m20b-fork-seed', 'm20b-fork-only', 'm20b-fork-followup', 'm20b-fork-during', 'm20b-fork-two', 'm20b-fork-read', 'm20b-fork-again']);
    expect([...FORK_TURN_CAPTURES]).toEqual(['m20b-fork-seed', 'm20b-fork-during']);
    const allowed = ['approvalPolicy', 'cwd', 'developerInstructions', 'ephemeral', 'excludeTurns', 'lastTurnId', 'model', 'sandbox', 'threadId'];
    for (const name of FORK_CAPTURES) {
      const { sent } = forks(name);
      expect(sent.length, name).toBeGreaterThan(0);
      for (const params of sent) {
        expect(Object.keys(params).filter((key) => !allowed.includes(key)), name).toEqual([]);
        expect(params, name).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: ASIDE_INSTRUCTIONS });
      }
    }
    // A fork taken while no turn had ended names none (C69).
    expect(forks('m20b-fork-seed').sent.some((params) => !('lastTurnId' in params))).toBe(true);
  });

  it('answers a fork with the captured reply — a thread of its own, read-only, asked for no approval — and notes every field it was sent', async () => {
    const { fake, id, turnId } = await held();
    const reply = await fake.request('thread/fork', forkParams(id, turnId));
    const child = childOf(reply);
    expect(child).not.toBe(id);
    expect(at(reply, 'result', 'sandbox', 'type')).toBe('readOnly');
    expect(at(reply, 'result', 'approvalPolicy')).toBe('never');
    expect(captured.has(compared(reply))).toBe(true);
    expect(noted(id).forks).toEqual([forkParams(id, turnId)]);
    // A second fork is a second thread; a fork of a thread the process does not have is refused as a resume of one is.
    expect(childOf(await fake.request('thread/fork', forkParams(id, turnId)))).not.toBe(child);
    expect(at(await fake.request('thread/fork', forkParams('00000000-0000-4000-8000-000000000000')), 'error')).toBeDefined();
    await fake.end();
  }, 90_000);

  for (const name of ['m20b-fork-followup', 'm20b-fork-read']) {
    it(`replays ${name}’s side thread for its question: every frame from a capture file but for ids, times and the folder, on the side thread alone`, async () => {
      const { fake, id, turnId } = await held();
      const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
      const before = fake.lines.length;
      const [question] = forks(name).questions as [string];
      const started = await turnStart(fake, child, question);
      expect(at(started, 'result', 'turn', 'id')).toBeDefined();
      await fake.next(sessionEnd(child), 60_000);
      const told = fake.lines.slice(before);
      expect(told.filter((line) => !captured.has(compared(line))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
      expect(JSON.stringify(told)).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
      // Every notification of it names the side thread, and none the session's own.
      expect(told.filter((line) => typeof line['method'] === 'string' && at(line, 'params', 'threadId') !== undefined).map((line) => at(line, 'params', 'threadId') === child)).not.toContain(false);
      expect(ofThread({ ...fake, lines: told }, id)).toEqual([]);
      // Its answer is written as a session's is: deltas, then the whole message.
      expect(told.some((line) => line['method'] === 'item/agentMessage/delta')).toBe(true);
      expect(told.filter((line) => line['method'] === 'turn/completed').map((line) => at(line, 'params', 'turn', 'status'))).toEqual(['completed']);
      expect(noted(id).asides?.map((aside) => [aside.capture, aside.text])).toEqual([[name, question]]);
      await fake.end();
    }, 90_000);
  }

  it('shows the file a side thread read as a command of the side thread’s own, in the capture that has one', async () => {
    const { fake, id, turnId } = await held();
    const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
    await turnStart(fake, child, (forks('m20b-fork-read').questions as [string])[0]);
    await fake.next(sessionEnd(child), 60_000);
    const did = ofThread(fake, child).filter((line) => line['method'] === 'item/completed').map((line) => at(line, 'params', 'item', 'type'));
    expect(did).toContain('commandExecution');
    expect(did.at(-1)).toBe('agentMessage');
    await fake.end();
  }, 90_000);

  it('plays a side thread’s turn beside a turn of the session’s, each frame on its own thread, and leaves the session’s as its capture has it', async () => {
    const { fake, id, turnId } = await held();
    const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
    const before = fake.lines.length;
    await turnStart(fake, id, PROMPT.t1);
    await turnStart(fake, child, (forks('m20b-fork-followup').questions as [string])[0]);
    await Promise.all([fake.next((line) => fake.lines.indexOf(line) >= before && sessionEnd(id)(line), 60_000), fake.next(sessionEnd(child), 60_000)]);
    const told = fake.lines.slice(before);
    const own = told.filter((line) => at(line, 'params', 'threadId') === id);
    const childs = told.filter((line) => at(line, 'params', 'threadId') === child);
    // The session's second turn is the same frames as its first, in their order: the side thread changed none.
    const first = fake.lines.slice(0, before).filter((line) => at(line, 'params', 'threadId') === id && typeof line['method'] === 'string' && line['method'] !== 'thread/started');
    expect(own.map((line) => line['method'])).toEqual(first.map((line) => line['method']));
    expect(childs.length).toBeGreaterThan(0);
    for (const line of [...own, ...childs]) expect(captured.has(compared(line)), String(line['method'])).toBe(true);
    await fake.end();
  }, 120_000);

  it('answers an interrupt of a side thread’s turn, and ends that turn interrupted: the session’s thread is told nothing', async () => {
    setControl({ hang: 'childSend' });
    const { fake, id, turnId } = await held();
    const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
    setControl({});
    const before = fake.lines.length;
    const started = await turnStart(fake, child, (forks('m20b-fork-two').questions as [string, string])[1]);
    const childTurn = String(at(started, 'result', 'turn', 'id'));
    await fake.next((line) => line['method'] === 'turn/started' && at(line, 'params', 'threadId') === child, 30_000);
    await fake.request('turn/interrupt', { threadId: child, turnId: childTurn });
    const ended = await fake.next(sessionEnd(child), 30_000);
    expect(at(ended, 'params', 'turn', 'status')).toBe('interrupted');
    expect(fake.lines.slice(before).filter((line) => at(line, 'params', 'threadId') === id)).toEqual([]);
    expect(noted(id).asideInterrupts).toHaveLength(1);
    expect(threadFile()[id]?.interrupts).toEqual([]);
    await fake.end();
  }, 90_000);

  describe('the controls, each one named change (C62)', () => {
    it('forkRefused: the fork is answered with an error, once; hang fork: it is never answered', async () => {
      const { fake, id, turnId } = await held();
      setControl({ forkRefused: 1 });
      expect(at(await fake.request('thread/fork', forkParams(id, turnId)), 'error')).toBeDefined();
      expect(at(await fake.request('thread/fork', forkParams(id, turnId)), 'result', 'thread', 'id')).toBeDefined();
      setControl({ hang: 'fork' });
      const before = fake.lines.length;
      fake.send({ id: 9_001, method: 'thread/fork', params: forkParams(id, turnId) });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fake.lines.slice(before)).toEqual([]);
      // Noted all the same: it was sent.
      expect(noted(id).forks).toHaveLength(3);
      await fake.end();
    }, 90_000);

    it.each([
      ['sandbox', ['result.sandbox']],
      ['network', ['result.sandbox.networkAccess']],
      ['policy', ['result.approvalPolicy']],
    ] as const)('forkOther %s: the fork’s reply differs from the captured one at that one place', async (other, paths) => {
      const { fake, id, turnId } = await held();
      const plain = await fake.request('thread/fork', forkParams(id, turnId));
      setControl({ forkOther: other });
      const changed = await fake.request('thread/fork', forkParams(id, turnId));
      const differing = (a: unknown, b: unknown, where = ''): string[] => {
        if (JSON.stringify(a) === JSON.stringify(b)) return [];
        if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differing((a as Json)[key], (b as Json)[key], where === '' ? key : `${where}.${key}`));
        return [where];
      };
      const masked = (reply: Json): unknown => JSON.parse(compared(reply));
      const found = differing(masked(plain), masked(changed));
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((where) => paths.some((allowed) => where === allowed || where.startsWith(`${allowed}.`)))).toBe(true);
      await fake.end();
    }, 90_000);

    it('oversize forkReply: the fork’s reply is one line past a session’s limit, and still a reply', async () => {
      const { fake, id, turnId } = await held();
      setControl({ oversize: 'forkReply' });
      const before = fake.chunks.join('').length;
      const reply = await fake.request('thread/fork', forkParams(id, turnId), 30_000);
      expect(at(reply, 'result', 'thread', 'id')).toBeDefined();
      expect(fake.chunks.join('').length - before).toBeGreaterThan(MEDIA_SESSION_LINE_BYTES);
      await fake.end();
    }, 90_000);

    it('childTurnFailed: the side thread’s turn ends failed, and nothing else of its capture is changed', async () => {
      const { fake, id, turnId } = await held();
      const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
      setControl({ childTurnFailed: true });
      await turnStart(fake, child, (forks('m20b-fork-followup').questions as [string])[0]);
      const ended = await fake.next(sessionEnd(child), 60_000);
      expect(at(ended, 'params', 'turn', 'status')).toBe('failed');
      await fake.end();
    }, 90_000);

    it('hang childStop: an interrupt of a side thread is never answered, and its turn does not end', async () => {
      setControl({ hang: 'childSend' });
      const { fake, id, turnId } = await held();
      const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
      setControl({ hang: 'childStop' });
      const started = await turnStart(fake, child, (forks('m20b-fork-two').questions as [string, string])[1]);
      await fake.next((line) => line['method'] === 'turn/started' && at(line, 'params', 'threadId') === child, 30_000);
      const before = fake.lines.length;
      fake.send({ id: 9_002, method: 'turn/interrupt', params: { threadId: child, turnId: at(started, 'result', 'turn', 'id') } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(fake.lines.slice(before).some((line) => line['id'] === 9_002)).toBe(false);
      expect(noted(id).asideInterrupts).toHaveLength(1);
      await fake.end();
    }, 90_000);

    it('exitDuringAside: the process ends as a side thread’s turn starts', async () => {
      const { fake, id, turnId } = await held();
      const child = childOf(await fake.request('thread/fork', forkParams(id, turnId)));
      setControl({ exitDuringAside: 1 });
      fake.send({ id: 9_003, method: 'turn/start', params: { threadId: child, input: [{ type: 'text', text: (forks('m20b-fork-followup').questions as [string])[0], text_elements: [] }], model: 'gpt-6-astra', effort: 'low', clientUserMessageId: CLIENT_ID } });
      expect(await fake.closed).not.toBe(0);
      expect(fake.lines.some((line) => line['method'] === 'turn/completed' && at(line, 'params', 'threadId') === child)).toBe(false);
    }, 90_000);
  });
});

// ── M21: a question (V12; C50, C51) ───────────────────────────────────────────────────────────
// K2's captures. The plan turn asked through a request, which the replay holds at until fat-g
// replies; two turns asked in a message, one of them answered by a second turn in fat-g's words; and
// the history read holds all five turns. The app sends no plan turn (decision 0018): the prompt
// alone chooses the capture, so every turn here is started as the app starts any.
describe('a question (M21: V12; C50, C51)', () => {
  const REQUEST = 'item/tool/requestUserInput';
  const RESOLVED = 'serverRequest/resolved';
  const DELTA = 'item/agentMessage/delta';
  const forward = (): string => folder().replaceAll('\\', '/');
  const compared = (line: Json): string => comparable(JSON.parse(JSON.stringify(line).replaceAll(forward(), '<scratch>')) as Json, folder());
  /** The prompt of a capture's `nth` turn. */
  const promptAt = (name: string, nth: number): string => String(at(capture(name).frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start')[nth]?.frame, 'params', 'input', 0, 'text'));
  const PLAN = promptOf('m21-codex-plan');
  const ASYNC = promptOf('m21-codex-async');
  const ANSWER = promptAt('m21-codex-async', 1);
  const TWO = promptOf('m21-codex-async-two');
  /** K2's request, and the reply K2 gave it. */
  const captured_ = capture('m21-codex-plan').frames;
  const REQUESTED = captured_.find((f) => f.dir === 'recv' && f.frame['method'] === REQUEST)?.frame as Json;
  const REPLIED = (captured_.find((f) => f.dir === 'send' && f.frame['method'] === undefined && f.frame['id'] === REQUESTED['id'])?.frame as Json)['result'] as Json;
  const QUESTION = at(REQUESTED, 'params', 'questions', 0) as { id: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] } & Json;
  /** K2's history read: the five turns of its one reply, newest first. */
  const HISTORY = (at(capture('m21-codex-history').frames.find((f) => f.dir === 'recv' && at(f.frame, 'result', 'data') !== undefined)?.frame, 'result', 'data') as (Json & { items: Json[] })[]);
  interface Noted { turns: string[]; starts?: Json[]; replies?: Json[]; historyReads?: Json[] }
  const noted = (id: string): Noted => threadFile()[id] as unknown as Noted;
  const sentOf = (fake: Fake): Json[] => fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined);
  const asked = (fake: Fake): Json[] => fake.lines.filter((line) => line['method'] === REQUEST);
  const messages = (fake: Fake): Json[] => items(fake, 'agentMessage');
  const strangers = (fake: Fake): string[] => sentOf(fake).filter((line) => !captured.has(compared(line))).map((line) => JSON.stringify(line).slice(0, 200));

  /** A session's process whose handshake is fat-g's own, with a thread. */
  async function own(controls: Json = {}): Promise<{ fake: Fake; id: string }> {
    setControl(controls);
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const { id } = await startThread(fake);
    return { fake, id };
  }
  /** One turn of `prompt` on `id`, to its end. */
  async function turn(fake: Fake, id: string, prompt: string): Promise<Json> {
    const ends = fake.lines.filter(sessionEnd(id)).length;
    const reply = await turnStart(fake, id, prompt);
    await fake.next(() => fake.lines.filter(sessionEnd(id)).length === ends + 1, 60_000);
    return reply;
  }
  /** The plan turn, up to its request. */
  async function planned(controls: Json = {}): Promise<{ fake: Fake; id: string; turnId: string; request: Json }> {
    const { fake, id } = await own(controls);
    const reply = await turnStart(fake, id, PLAN);
    const request = await fake.next((line) => line['method'] === REQUEST, 30_000);
    return { fake, id, turnId: String(at(reply, 'result', 'turn', 'id')), request };
  }

  it('names K2’s three captures that hold a turn, four prompts in all: the stopped plan turn shares the plan turn’s, and the async capture’s second is fat-g’s words for an answer', () => {
    expect([...QUESTION_CAPTURES]).toEqual(['m21-codex-plan', 'm21-codex-async', 'm21-codex-async-two']);
    expect(new Set([PLAN, ASYNC, ANSWER, TWO]).size).toBe(4);
    expect(promptOf('m21-codex-plan-stop')).toBe(PLAN);
    // What main writes for the card's second option (C26), from the questions the message carried.
    const carried = at(capture('m21-codex-async').frames.find((f) => f.frame['method'] === 'item/completed' && Array.isArray(at(f.frame, 'params', 'item', 'questions')))?.frame, 'params', 'item', 'questions') as { title: string; options: string[] }[];
    expect(answerPrompt(fromMessageQuestions(carried).questions, [{ options: [1], text: null }])).toBe(ANSWER);
    // No other capture is chosen by any of the four. M22b's skip and empty captures ask the plan
    // turn's question again with M21's own prompt, answered "No answer" and with an empty list (M22b,
    // C53): a fake that replays them tells them apart by the reply, not by the prompt.
    const others = readdirSync(CAPTURES).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, '')).filter((name) => !name.startsWith('m21-codex-') && !['m22b-codex-skip', 'm22b-codex-empty'].includes(name));
    for (const name of others) for (const f of capture(name).frames.filter((entry) => entry.dir === 'send' && entry.frame['method'] === 'turn/start')) expect([PLAN, ASYNC, ANSWER, TWO], name).not.toContain(at(f.frame, 'params', 'input', 0, 'text'));
  });

  it('replays the plan turn for its prompt, started as any turn is: it holds at the request until fat-g replies, then sends Codex’s word and the plan — every frame from a capture file', async () => {
    const { fake, id, turnId, request } = await planned();
    expect(request['id']).toBe(REQUESTED['id']);
    expect(at(request, 'params', 'threadId')).toBe(id);
    expect(at(request, 'params', 'turnId')).toBe(turnId);
    expect(at(request, 'params', 'questions')).toEqual(at(REQUESTED, 'params', 'questions'));
    // Held, as the CLI held its turn: nothing follows the request until its reply.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.lines.at(-1)).toBe(request);
    fake.send({ id: request['id'], result: REPLIED });
    await fake.next(sessionEnd(id), 30_000);
    const after = fake.lines.slice(fake.lines.indexOf(request) + 1).map((line) => (line['method'] === 'item/completed' ? `completed:${String(at(line, 'params', 'item', 'type'))}` : String(line['method']))).filter((method) => [RESOLVED, 'completed:plan', 'turn/completed'].includes(method));
    expect(after).toEqual([RESOLVED, 'completed:plan', 'turn/completed']);
    expect(at(fake.lines.find((line) => line['method'] === RESOLVED), 'params')).toEqual({ threadId: id, requestId: REQUESTED['id'] });
    expect(at(fake.lines.find(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
    expect(strangers(fake)).toEqual([]);
    expect(JSON.stringify(sentOf(fake))).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
    // Noted with the thread: what the turn was started with — no plan mode — and the reply fat-g gave.
    expect(noted(id)).toMatchObject({ turns: ['m21-codex-plan'], starts: [{ capture: 'm21-codex-plan', text: PLAN, model: 'gpt-6-astra', effort: 'low', mode: null }], replies: [{ id: REQUESTED['id'], result: REPLIED }] });
    await fake.end();
  }, 90_000);

  it('answers an interrupt while the request is held from the stopped plan turn’s capture: its reply, the turn interrupted, then Codex’s word for the request, which is never replied to', async () => {
    const { fake, id, turnId, request } = await planned();
    const before = fake.lines.length;
    const taken = await fake.request('turn/interrupt', { threadId: id, turnId });
    expect(taken['error']).toBeUndefined();
    const end = await fake.next(sessionEnd(id), 30_000);
    expect(at(end, 'params', 'turn', 'status')).toBe('interrupted');
    expect(at(end, 'params', 'turn', 'id')).toBe(turnId);
    const resolved = await fake.next((line) => line['method'] === RESOLVED, 30_000);
    // K2 (C27): Codex's word followed the turn's end.
    expect(fake.lines.indexOf(resolved)).toBeGreaterThan(fake.lines.indexOf(end));
    expect(at(resolved, 'params')).toEqual({ threadId: id, requestId: request['id'] });
    expect(fake.lines.slice(before).filter((line) => !captured.has(compared(line))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
    expect(noted(id).replies).toBeUndefined();
    expect(threadFile()[id]?.interrupts).toEqual([{ inputOpen: true, worker: false }]);
    // The plan is never written: the turn was over.
    expect(fake.lines.some((line) => at(line, 'params', 'item', 'type') === 'plan')).toBe(false);
    await fake.end();
  }, 90_000);

  it('replays the turns that asked in a message, each for its own prompt: the question and the empty message after it, and the turn that answered in fat-g’s words — every frame from a capture file', async () => {
    const { fake, id } = await own();
    await turn(fake, id, ASYNC);
    // The message that asks comes whole, with its questions and no delta; the one after it holds nothing.
    expect(fake.lines.filter((line) => line['method'] === DELTA)).toEqual([]);
    expect(messages(fake).map((line) => [String(at(line, 'params', 'item', 'text')).length > 0, at(line, 'params', 'item', 'delivery'), (at(line, 'params', 'item', 'questions') as unknown[] | null)?.length ?? null])).toEqual([[true, 'async', 1], [false, null, null]]);
    await turn(fake, id, ANSWER);
    expect(fake.lines.filter((line) => line['method'] === DELTA)).toHaveLength(capture('m21-codex-async').frames.filter((f) => f.dir === 'recv' && f.frame['method'] === DELTA).length);
    expect(messages(fake).slice(2).map((line) => at(line, 'params', 'item', 'phase'))).toEqual(['commentary', 'final_answer']);
    expect(items(fake, 'commandExecution')).toHaveLength(1);
    await turn(fake, id, TWO);
    expect((at(messages(fake).at(-2), 'params', 'item', 'questions') as unknown[]).length).toBe(2);
    expect(at(messages(fake).at(-1), 'params', 'item', 'text')).toBe('');
    expect(strangers(fake)).toEqual([]);
    expect(JSON.stringify(sentOf(fake))).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
    expect(noted(id)).toMatchObject({ turns: ['m21-codex-async', 'm21-codex-async#2', 'm21-codex-async-two'], starts: [{ capture: 'm21-codex-async', text: ASYNC }, { capture: 'm21-codex-async#2', text: ANSWER, model: 'gpt-6-astra', effort: 'low' }, { capture: 'm21-codex-async-two', text: TWO }] });
    await fake.end();
  }, 120_000);

  it('replays T1 for these prompts to a handshake that opts out of the delta, as for any prompt it does not stream', async () => {
    const fake = await session();
    const { id } = await startThread(fake);
    await turnStart(fake, id, PLAN);
    await fake.next(sessionEnd(id), 30_000);
    expect(asked(fake)).toEqual([]);
    expect(threadFile()[id]).toMatchObject({ turns: ['t1-basic'] });
  }, 60_000);

  describe('K2’s history, under `history: m21`', () => {
    const list = (fake: Fake, threadId: string, limit: number, itemsView: string, cursor?: string): Promise<Json> => fake.request('thread/turns/list', { threadId, limit, itemsView, ...(cursor === undefined ? {} : { cursor }) });
    const turnsOf = (page: Json): (Json & { id: string; items: Json[] })[] => at(page, 'result', 'data') as (Json & { id: string; items: Json[] })[];
    /** A turn as it compares: ids, times and the folder masked. */
    const turnShape = (value: Json): string => JSON.stringify(mask(JSON.parse(JSON.stringify(value).replaceAll(forward(), '<scratch>')), folder()));

    it('holds five turns: the two plan turns, the question, its answer and the two questions — and nothing of the request', () => {
      expect(HISTORY.map((entry) => [entry['status'], entry.items.map((item) => item['type'])])).toEqual([['completed', ['userMessage', 'agentMessage', 'agentMessage']], ['completed', ['userMessage', 'agentMessage', 'commandExecution', 'agentMessage']], ['completed', ['userMessage', 'agentMessage', 'agentMessage']], ['interrupted', ['userMessage']], ['completed', ['userMessage', 'plan']]]);
    });

    it('answers K2’s own read with K2’s reply, and gives a turn fat-g ran the ids it ran under, its prompt’s the one it was sent with', async () => {
      const { fake, id } = await own();
      const reply = await turn(fake, id, ASYNC);
      const live = { turn: at(reply, 'result', 'turn', 'id'), items: fake.lines.filter((line) => line['method'] === 'item/started' && at(line, 'params', 'threadId') === id).map((line) => at(line, 'params', 'item', 'id')) };
      expect(live.items).toHaveLength(3);
      setControl({ history: 'm21' });
      const all = await list(fake, id, 20, 'full');
      expect(captured.has(compared(all))).toBe(true);
      expect(at(all, 'result', 'nextCursor')).toBeNull();
      const turns = turnsOf(all);
      expect(turns).toHaveLength(5);
      // Newest first: the question's turn is the third, and it is the one that ran here.
      expect(turns[2]?.id).toBe(live.turn);
      expect(turns[2]?.items.map((item) => item['id'])).toEqual(live.items);
      expect(at(turns[2], 'items', 0, 'clientId')).toBe(CLIENT_ID);
      // Every other turn is one made elsewhere, under an id of its own, the same at each read.
      expect(new Set(turns.map((entry) => entry.id)).size).toBe(5);
      expect(turnsOf(await list(fake, id, 20, 'full')).map((entry) => [entry.id, entry.items.map((item) => item['id'])])).toEqual(turns.map((entry) => [entry.id, entry.items.map((item) => item['id'])]));
      // The turn that answered it, run now, is the history's second.
      const answering = await turn(fake, id, ANSWER);
      expect(at(answering, 'result', 'turn', 'id')).toBe(turns[1]?.id);
      await fake.end();
    }, 120_000);

    it('serves it in pages of the size asked for, newest first, from the turn a cursor names: each turn K2’s own, whole or without its items', async () => {
      const { fake, id } = await own();
      await turn(fake, id, 'Anything at all.');
      setControl({ history: 'm21' });
      const whole = turnsOf(await list(fake, id, 20, 'full'));
      const captured5 = new Set(HISTORY.map((entry) => turnShape(entry)));
      // The app's listing: eight turns without their items.
      const listing = await list(fake, id, 8, 'notLoaded');
      expect(turnsOf(listing).map((entry) => [entry.id, entry.items, entry['itemsView'], entry['status']])).toEqual(whole.map((entry) => [entry.id, [], 'notLoaded', entry['status']]));
      expect(at(listing, 'result', 'nextCursor')).toBeNull();
      // A walk of one turn at a time, by the cursor each page gives, reaches all five and then ends.
      const walked: (Json & { id: string })[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 6; page += 1) {
        const one = await list(fake, id, 1, 'full', cursor);
        walked.push(...turnsOf(one));
        const next = at(one, 'result', 'nextCursor');
        if (typeof next !== 'string') break;
        cursor = next;
      }
      expect(walked.map((entry) => entry.id)).toEqual(whole.map((entry) => entry.id));
      for (const entry of walked) expect(captured5.has(turnShape(entry)), entry.id).toBe(true);
      // Two at a time from the second turn on.
      const pair = await list(fake, id, 2, 'notLoaded', whole[1]?.id);
      expect(turnsOf(pair).map((entry) => entry.id)).toEqual([whole[2]?.id, whole[3]?.id]);
      expect(at(pair, 'result', 'nextCursor')).toBe(whole[3]?.id);
      // No capture holds a summary of these turns: one is refused, as any read no capture answers.
      expect(at(await list(fake, id, 1, 'summary'), 'error', 'code')).toBe(-32601);
      expect(noted(id).historyReads).toHaveLength(9);
      // Without the word the history is M15's, as before.
      setControl({});
      expect(turnsOf(await list(fake, id, 8, 'full'))).toHaveLength(2);
      await fake.end();
    }, 120_000);
  });

  describe('the controls, each one named change (C51)', () => {
    const NOT_FOUND = { code: -32601, message: 'Method not found' };
    /** The plan turn under `controls`, refused by fat-g where it asks, to its end. */
    async function refusedTurn(controls: Json): Promise<{ fake: Fake; id: string; request: Json }> {
      const { fake, id, request } = await planned(controls);
      fake.send({ id: request['id'], error: NOT_FOUND });
      await fake.next(sessionEnd(id), 30_000);
      return { fake, id, request };
    }
    const questionsOf = (request: Json): (typeof QUESTION)[] => at(request, 'params', 'questions') as (typeof QUESTION)[];

    it('questionTwice: the request is delivered a second time under the same id, and one reply is all it waits for', async () => {
      const { fake, id, request } = await planned({ questionTwice: true });
      await fake.next(() => asked(fake).length === 2, 30_000);
      expect(asked(fake)[1]).toEqual(request);
      fake.send({ id: request['id'], result: REPLIED });
      await fake.next(sessionEnd(id), 30_000);
      expect(asked(fake)).toHaveLength(2);
      expect(fake.lines.filter((line) => line['method'] === RESOLVED)).toHaveLength(1);
      expect(noted(id).replies).toHaveLength(1);
      expect(strangers(fake)).toEqual([]);
      await fake.end();
    }, 90_000);

    it('questionWorker: the request names a thread that is neither the session’s nor any worker’s, and nothing else of it changes', async () => {
      const { fake, id, request } = await refusedTurn({ questionWorker: true });
      expect(at(request, 'params', 'threadId')).not.toBe(id);
      expect(fake.lines.some((line) => at(line, 'params', 'thread', 'id') === at(request, 'params', 'threadId'))).toBe(false);
      // Masked, it is the captured request: only an id differs.
      expect(captured.has(compared(request))).toBe(true);
      expect(noted(id).replies).toEqual([{ id: request['id'], error: NOT_FOUND }]);
      await fake.end();
    }, 90_000);

    it('questionLate: the request comes after its turn’s end; the turn goes on without it, and Codex’s word for it is withheld', async () => {
      const { fake, id } = await own({ questionLate: true });
      await turnStart(fake, id, PLAN);
      const request = await fake.next((line) => line['method'] === REQUEST, 30_000);
      const end = fake.lines.find(sessionEnd(id));
      expect(end).toBeDefined();
      expect(fake.lines.indexOf(request)).toBeGreaterThan(fake.lines.indexOf(end as Json));
      expect(at(end, 'params', 'turn', 'status')).toBe('completed');
      expect(items(fake, 'plan')).toHaveLength(1);
      expect(fake.lines.some((line) => line['method'] === RESOLVED)).toBe(false);
      expect(captured.has(compared(request))).toBe(true);
      expect(asked(fake)).toHaveLength(1);
      await fake.end();
    }, 90_000);

    it('questionResolvedEarly: Codex takes the request back — its word follows at once, and the turn goes on to its end with no reply', async () => {
      const { fake, id, request } = await planned({ questionResolvedEarly: true });
      const end = await fake.next(sessionEnd(id), 30_000);
      const resolved = fake.lines.find((line) => line['method'] === RESOLVED) as Json;
      expect(at(resolved, 'params')).toEqual({ threadId: id, requestId: request['id'] });
      expect(fake.lines.indexOf(resolved)).toBeGreaterThan(fake.lines.indexOf(request));
      expect(fake.lines.indexOf(resolved)).toBeLessThan(fake.lines.indexOf(end));
      expect(at(end, 'params', 'turn', 'status')).toBe('completed');
      expect(noted(id).replies).toBeUndefined();
      expect(strangers(fake)).toEqual([]);
      await fake.end();
    }, 90_000);

    it('exitWhileAsking: the process ends once the request is out; set after that, it ends as fat-g’s reply arrives, before Codex’s word for it', async () => {
      const pending = await own({ exitWhileAsking: 1 });
      await turnStart(pending.fake, pending.id, PLAN);
      expect(await pending.fake.closed).toBe(3);
      expect(asked(pending.fake)).toHaveLength(1);
      expect(pending.fake.lines.some((line) => line['method'] === RESOLVED || sessionEnd(pending.id)(line))).toBe(false);

      const answered = await planned();
      setControl({ exitWhileAsking: 1 });
      answered.fake.send({ id: answered.request['id'], result: REPLIED });
      expect(await answered.fake.closed).toBe(3);
      // The reply was taken, and nothing came of it.
      expect(noted(answered.id).replies).toEqual([{ id: answered.request['id'], result: REPLIED }]);
      expect(answered.fake.lines.at(-1)).toBe(answered.request);
    }, 90_000);

    it('exitAtAnswer: the first option’s label is padded past what a pipe holds, and the process ends as the first bytes of an answer arrive, no line of it read', async () => {
      const { fake, id, request } = await planned({ exitAtAnswer: 1 });
      const [question] = questionsOf(request);
      const [first, second] = question?.options ?? [];
      expect(first?.label).toHaveLength(900_000);
      expect(first?.label.trimEnd()).toBe(QUESTION.options[0]?.label);
      // Nothing else of the request changes.
      expect({ ...request, params: { ...(request['params'] as Json), questions: [{ ...question, options: [{ ...first, label: first?.label.trimEnd() }, second] }] } }).toEqual({ ...request, params: { ...(request['params'] as Json), questions: at(REQUESTED, 'params', 'questions') } });
      expect(fake.exited()).toBe(false);
      // An answer that chooses it, as fat-g encodes one: the whole label. Its write is cut off, and fails.
      const child = open.at(-1) as ChildProcessWithoutNullStreams;
      child.stdin.on('error', () => { /* the write's own callback says so */ });
      const written = new Promise<string | null>((resolve) => { child.stdin.write(`${JSON.stringify({ id: request['id'], result: { answers: { [QUESTION.id]: { answers: [first?.label] } } } })}\n`, (error) => resolve(error === null || error === undefined ? null : ((error as NodeJS.ErrnoException).code ?? 'failed'))); });
      expect(await fake.closed).toBe(3);
      expect(await written).not.toBeNull();
      expect(noted(id).replies).toBeUndefined();
      expect(fake.lines.at(-1)).toBe(request);
    }, 90_000);

    it.each([
      ['questionsTwenty', 'twenty questions, the captured one under twenty ids', (questions: (typeof QUESTION)[]) => { expect(questions).toHaveLength(20); expect(new Set(questions.map((question) => question.id)).size).toBe(20); expect(questions.map((question) => ({ ...question, id: QUESTION.id }))).toEqual(Array.from({ length: 20 }, () => QUESTION)); }],
      ['optionsNineNoOther', 'nine options and no free text', (questions: (typeof QUESTION)[]) => { expect(questions).toHaveLength(1); expect(questions[0]?.options).toHaveLength(9); expect(questions[0]?.options.slice(0, 2)).toEqual(QUESTION.options); expect(new Set(questions[0]?.options.map((option) => option.label)).size).toBe(9); expect({ ...questions[0], options: QUESTION.options }).toEqual({ ...QUESTION, isOther: false }); }],
      ['optionsOnly', 'its two options and no free text', (questions: (typeof QUESTION)[]) => { expect(questions).toEqual([{ ...QUESTION, isOther: false }]); }],
      ['noOptionsNoOther', 'no option and no free text', (questions: (typeof QUESTION)[]) => { expect(questions).toEqual([{ ...QUESTION, isOther: false, options: [] }]); }],
      ['questionSecret', 'a secret', (questions: (typeof QUESTION)[]) => { expect(questions).toEqual([{ ...QUESTION, isSecret: true }]); }],
    ] as const)('%s: the request’s question is %s, and nothing else of the turn changes', async (name, _what, check) => {
      expect(QUESTION).toMatchObject({ isOther: true, isSecret: false });
      expect(QUESTION.options).toHaveLength(2);
      const { fake, request } = await refusedTurn({ [name]: true });
      check(questionsOf(request));
      // With its questions put back, the request is the capture's own; and every other frame is one.
      expect(captured.has(compared({ ...request, params: { ...(request['params'] as Json), questions: at(REQUESTED, 'params', 'questions') } }))).toBe(true);
      expect(sentOf(fake).filter((line) => line !== request && !captured.has(compared(line)))).toEqual([]);
      await fake.end();
    }, 90_000);

    it('longAsyncAnswer: the message that asks holds sixteen questions, the captured one repeated, and its text is as it was', async () => {
      const { fake, id } = await own({ longAsyncAnswer: true });
      await turn(fake, id, ASYNC);
      const [asking, trailer] = messages(fake);
      const carried = at(capture('m21-codex-async').frames.find((f) => f.frame['method'] === 'item/completed' && Array.isArray(at(f.frame, 'params', 'item', 'questions')))?.frame, 'params', 'item') as { text: string; questions: Json[] };
      expect(at(asking, 'params', 'item', 'questions')).toEqual(Array.from({ length: 16 }, () => carried.questions[0]));
      expect(at(asking, 'params', 'item', 'text')).toBe(carried.text);
      expect(at(trailer, 'params', 'item', 'text')).toBe('');
      // Sixteen answers of ten thousand units pass a prompt's bound of a hundred thousand (C26).
      expect(16 * 10_000).toBeGreaterThan(100_000);
      await fake.end();
    }, 90_000);

    it('historyPartialQuestion: the message that asks is never completed — one delta brings its text — and the history holds it whole, under the same id', async () => {
      const { fake, id } = await own({ historyPartialQuestion: true });
      const reply = await turn(fake, id, ASYNC);
      const opened = fake.lines.filter((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'type') === 'agentMessage').map((line) => String(at(line, 'params', 'item', 'id')));
      const [askingId, trailerId] = opened as [string, string];
      // Its completing frame is withheld; the empty message's is not, and the turn ends as it did.
      expect(messages(fake).map((line) => at(line, 'params', 'item', 'id'))).toEqual([trailerId]);
      const carried = at(capture('m21-codex-async').frames.find((f) => f.frame['method'] === 'item/completed' && Array.isArray(at(f.frame, 'params', 'item', 'questions')))?.frame, 'params', 'item') as { text: string; questions: Json[] };
      expect(fake.lines.filter((line) => line['method'] === DELTA).map((line) => line['params'])).toEqual([{ threadId: id, turnId: at(reply, 'result', 'turn', 'id'), itemId: askingId, delta: carried.text }]);
      expect(at(fake.lines.find(sessionEnd(id)), 'params', 'turn', 'status')).toBe('completed');
      // Every frame but that delta is a capture's own.
      expect(sentOf(fake).filter((line) => line['method'] !== DELTA && !captured.has(compared(line)))).toEqual([]);
      setControl({ historyPartialQuestion: true, history: 'm21' });
      const page = await fake.request('thread/turns/list', { threadId: id, limit: 20, itemsView: 'full' });
      const held = (at(page, 'result', 'data') as (Json & { id: string; items: Json[] })[]).find((entry) => entry.id === at(reply, 'result', 'turn', 'id'));
      expect(held?.items.find((item) => item['id'] === askingId)).toMatchObject({ type: 'agentMessage', text: carried.text, questions: carried.questions });
      await fake.end();
    }, 90_000);
  });
});

// ── M22: what a session may do ────────────────────────────────────────────────────────────────
// K1's, K4's and K6's captures (docs/planning/_archive/M22.md, Design 11; V11; C35): a start is answered with
// what it named, as the captures report it for the account's sandbox state; each turn is replayed by
// its own prompt and held at each request for leave until fat-g replies; the reply decides how the
// action's item ends and whether the fake makes the change; and readiness and the setup are answered
// as K6's were. A request's id is the process's own, so these tests compare frames with it left out.
describe('what a session may do (M22: V11; C35)', () => {
  const COMMAND = 'item/commandExecution/requestApproval';
  const FILE = 'item/fileChange/requestApproval';
  const RESOLVED = 'serverRequest/resolved';
  const READINESS = 'windowsSandbox/readiness';
  const SETUP = 'windowsSandbox/setupStart';
  const COMPLETED = 'windowsSandbox/setupCompleted';
  const MODEL = 'gpt-6-luna';
  const isRequest = (line: Json): boolean => line['method'] === COMMAND || line['method'] === FILE;
  /** A frame with what Codex numbers by its own process left out: a request's id, and the id its word for one names. */
  const unnumbered = (line: Json): Json => (isRequest(line) ? { ...line, id: 0 } : line['method'] === RESOLVED ? { ...line, params: { ...(line['params'] as Json), requestId: 0 } } : line);
  const comparedTo = (line: Json, dirName: string): string => comparable(unnumbered(line), dirName);
  const capturedUnnumbered = new Set<string>();
  for (const file of readdirSync(CAPTURES).filter((name) => name.endsWith('.json'))) {
    for (const { dir: direction, frame } of capture(file.replace(/\.json$/, '')).frames) if (direction === 'recv') capturedUnnumbered.add(comparedTo(frame, '<never>'));
  }
  const promptAt = (name: string, nth = 0): string => String(at(capture(name).frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start')[nth]?.frame, 'params', 'input', 0, 'text'));
  /** Every frame the fake sent but the handshake's reply and a start's or a resume's, which is made of two captures' and is held to them apart. */
  const sentOf = (fake: Fake): Json[] => fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined && at(line, 'result', 'thread') === undefined);
  const strangers = (fake: Fake): string[] => sentOf(fake).filter((line) => !capturedUnnumbered.has(comparedTo(line, folder()))).map((line) => JSON.stringify(line).slice(0, 220));
  const requests = (fake: Fake): Json[] => fake.lines.filter(isRequest);
  const completed = (fake: Fake, itemId: unknown): Json | undefined => fake.lines.find((line) => line['method'] === 'item/completed' && at(line, 'params', 'item', 'id') === itemId);
  interface Noted { turns: string[]; opens?: Json[]; policies?: Json[]; replies?: Json[]; changes?: Json[]; interrupts: Json[] }
  const noted = (id: string): Noted => threadFile()[id] as unknown as Noted;
  const sandboxNotes = (home = 'default'): { state?: string; asked?: { pid: number; method: string; params: unknown }[] } => ((JSON.parse(readFileSync(threads, 'utf8')) as { sandbox?: Record<string, { state?: string; asked?: { pid: number; method: string; params: unknown }[] }> }).sandbox?.[home] ?? {});
  const TRIPLES: Record<string, Json> = {
    'read-only': { sandbox: 'read-only', approvalPolicy: 'never' },
    'ask-first': { sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
    'sandbox-ok': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
    'auto-reviewed': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    berserk: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
  };
  const READ_ONLY = { type: 'readOnly', networkAccess: false };
  const WORKSPACE = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };

  /** A session's process whose handshake is fat-g's own, with a thread started under a mode's triple in the project folder. */
  async function under(mode: string, controls: Json = {}, extra: Record<string, string> = {}): Promise<{ fake: Fake; id: string; reply: Json }> {
    setControl(controls);
    mkdirSync(folder(), { recursive: true });
    const fake = start(extra);
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const reply = await fake.request('thread/start', { cwd: folder(), ...TRIPLES[mode], model: MODEL });
    return { fake, id: String(at(reply, 'result', 'thread', 'id')), reply };
  }
  const prompt = (fake: Fake, id: string, text: string, extra: Json = {}): Promise<Json> => fake.request('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }], model: MODEL, effort: 'low', clientUserMessageId: CLIENT_ID, ...extra });
  /** The `n`th request for leave of a process, once it is out. */
  const requested = (fake: Fake, n = 1): Promise<Json> => fake.next(() => requests(fake).length >= n, 30_000).then(() => requests(fake)[n - 1] as Json);
  const ended = (fake: Fake, id: string, n = 1): Promise<Json> => fake.next(() => fake.lines.filter(sessionEnd(id)).length >= n, 60_000).then(() => fake.lines.filter(sessionEnd(id))[n - 1] as Json);
  const decide = (fake: Fake, request: Json, decision: string): void => fake.send({ id: request['id'], result: { decision } });
  const inProject = (name: string): string | null => (existsSync(path.join(folder(), name)) ? readFileSync(path.join(folder(), name), 'utf8') : null);

  it('names the captures whose turns are turns by their prompts: each prompt its own, none another capture’s, and the override’s and the promptless ones left out', () => {
    const all = readdirSync(CAPTURES).filter((file) => file.startsWith('m22-codex-')).map((file) => file.replace(/\.json$/, ''));
    const withTurns = all.filter((name) => capture(name).frames.some((f) => f.dir === 'send' && f.frame['method'] === 'turn/start'));
    expect([...PERMISSION_CAPTURES].sort()).toEqual(withTurns.filter((name) => name !== 'm22-codex-override-main').sort());
    expect(PERMISSION_CAPTURES).toHaveLength(20);
    const prompts = PERMISSION_CAPTURES.flatMap((name) => capture(name).frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start').map((f) => String(at(f.frame, 'params', 'input', 0, 'text'))));
    expect(prompts).toHaveLength(24);
    expect(new Set(prompts).size).toBe(prompts.length);
    // No capture of an earlier milestone, and no question's, is chosen by any of them.
    const others = readdirSync(CAPTURES).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, '')).filter((name) => !PERMISSION_CAPTURES.includes(name));
    for (const name of others) for (const f of capture(name).frames.filter((entry) => entry.dir === 'send' && entry.frame['method'] === 'turn/start')) expect(prompts, name).not.toContain(at(f.frame, 'params', 'input', 0, 'text'));
  });

  describe('a start, by what it names and the account’s sandbox', () => {
    /** What a capture's start of exactly this triple was answered with. */
    const reportedIn = (names: string[], triple: Json): Json | undefined => {
      for (const name of names) {
        const frames = capture(name).frames;
        for (const sent of frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'thread/start')) {
          const named = sent.frame['params'] as Json;
          if (named['sandbox'] !== triple['sandbox'] || named['approvalPolicy'] !== triple['approvalPolicy'] || named['approvalsReviewer'] !== triple['approvalsReviewer']) continue;
          const result = at(frames.find((f) => f.dir === 'recv' && f.index > sent.index && f.frame['method'] === undefined && f.frame['id'] === sent.frame['id'])?.frame, 'result') as Json;
          return { sandbox: result['sandbox'], approvalPolicy: result['approvalPolicy'], approvalsReviewer: result['approvalsReviewer'] };
        }
      }
      return undefined;
    };

    it.each(Object.keys(TRIPLES))('answers %s’s start with the sandbox, the policy and the reviewer the captures report for it: with no sandbox, and with one set up', async (mode) => {
      const triple = TRIPLES[mode] as Json;
      for (const [state, names] of [['none', ['m22-codex-start', 'm22-codex-once']], ['ready', ['m22-codex-start-ready', 'm22-codex-ask-first-files']]] as const) {
        const { fake, reply } = await under(mode, { sandboxState: state });
        const expected = reportedIn([...names], triple);
        expect(expected, `${mode} ${state}`).toBeDefined();
        expect({ sandbox: at(reply, 'result', 'sandbox'), approvalPolicy: at(reply, 'result', 'approvalPolicy'), approvalsReviewer: at(reply, 'result', 'approvalsReviewer') }).toEqual(expected);
        // But for those three, the reply is the one every start is answered with.
        const base = await (async () => { const plain = await session(); const started = await startThread(plain); await plain.end(); return started.reply; })();
        const rest = (value: Json): string => comparable({ ...value, result: { ...(value['result'] as Json), sandbox: 0, approvalPolicy: 0, approvalsReviewer: 0 } }, folder());
        expect(rest(reply)).toBe(rest(base));
        await fake.end();
      }
    }, 120_000);

    it('reports a workspace sandbox as the read-only one on an account with none, which is what it answers unless told otherwise, and as itself once set up', async () => {
      const none = await under('ask-first');
      expect(at(none.reply, 'result', 'sandbox')).toEqual(READ_ONLY);
      expect(at(none.reply, 'result', 'approvalPolicy')).toBe('untrusted');
      await none.fake.end();
      const ready = await under('ask-first', { sandboxState: 'ready' });
      expect(at(ready.reply, 'result', 'sandbox')).toEqual(WORKSPACE);
      await ready.fake.end();
      const full = await under('berserk');
      expect(at(full.reply, 'result', 'sandbox')).toEqual({ type: 'dangerFullAccess' });
      expect(at(full.reply, 'result', 'approvalsReviewer')).toBe('user');
      await full.fake.end();
    });

    it('answers a resume the same way, and notes with the thread what each start, each resume and each turn named of a policy', async () => {
      const first = await under('ask-first', { sandboxState: 'ready' });
      await prompt(first.fake, first.id, PROMPT.t1, { approvalPolicy: 'untrusted', sandboxPolicy: WORKSPACE, approvalsReviewer: 'user' });
      await ended(first.fake, first.id);
      await first.fake.end();
      const second = await session();
      const resumed = await second.request('thread/resume', { threadId: first.id, cwd: folder(), ...TRIPLES['auto-reviewed'], excludeTurns: true });
      expect({ sandbox: at(resumed, 'result', 'sandbox'), approvalPolicy: at(resumed, 'result', 'approvalPolicy'), approvalsReviewer: at(resumed, 'result', 'approvalsReviewer') }).toEqual({ sandbox: WORKSPACE, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
      await turnStart(second, first.id, PROMPT.t1);
      await ended(second, first.id);
      expect(noted(first.id).opens).toEqual([{ method: 'thread/start', sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' }, { method: 'thread/resume', sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }]);
      // A turn that named none is noted as naming none.
      expect(noted(first.id).policies).toEqual([{ approvalPolicy: 'untrusted', sandboxPolicy: WORKSPACE, approvalsReviewer: 'user' }, { approvalPolicy: null, sandboxPolicy: null, approvalsReviewer: null }]);
      await second.end();
    });

    it.each([
      ['startOtherPolicy', 'ask-first', { approvalPolicy: 'on-request' }],
      ['startOtherPolicy', 'sandbox-ok', { approvalPolicy: 'never' }],
      ['startOtherReviewer', 'sandbox-ok', { approvalsReviewer: 'auto_review' }],
      ['startOtherReviewer', 'auto-reviewed', { approvalsReviewer: 'user' }],
      ['startOtherSandbox', 'ask-first', { sandbox: { type: 'dangerFullAccess' } }],
      ['startOtherSandbox', 'berserk', { sandbox: READ_ONLY }],
    ])('%s: %s’s start reply reports another one than was named, once for a count', async (fault, mode, other) => {
      const { fake, reply } = await under(mode, { sandboxState: 'ready', [fault]: 1 });
      expect(at(reply, 'result')).toMatchObject(other);
      // Taken: the next start is answered as named.
      const next = await fake.request('thread/start', { cwd: folder(), ...TRIPLES[mode], model: MODEL });
      expect(at(next, 'result')).not.toMatchObject(other);
      await fake.end();
    });
  });

  describe('a request for leave, held for fat-g’s reply', () => {
    it('replays K1’s command turn for its prompt: held at the request until the reply, then Codex’s word and the command’s end — every frame from a capture file, and the file made in the project folder', async () => {
      const { fake, id } = await under('ask-first');
      const reply = await prompt(fake, id, promptAt('m22-codex-once'));
      const request = await requested(fake);
      const K1 = capture('m22-codex-once').frames.find((f) => f.dir === 'recv' && f.frame['method'] === COMMAND)?.frame as Json;
      expect(request['id']).toBe(0);
      expect(at(request, 'params', 'threadId')).toBe(id);
      expect(at(request, 'params', 'turnId')).toBe(at(reply, 'result', 'turn', 'id'));
      expect(at(request, 'params', 'cwd')).toBe(folder());
      expect(at(request, 'params', 'availableDecisions')).toEqual(at(K1, 'params', 'availableDecisions'));
      // Held, as the CLI held its turn: nothing follows the request until its reply.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.lines.at(-1)).toBe(request);
      expect(inProject('k1-once.txt')).toBeNull();
      decide(fake, request, 'accept');
      await ended(fake, id);
      expect(at(fake.lines.find((line) => line['method'] === RESOLVED), 'params')).toEqual({ threadId: id, requestId: 0 });
      expect(at(completed(fake, at(request, 'params', 'itemId')), 'params', 'item')).toMatchObject({ status: 'completed', exitCode: 0 });
      expect(strangers(fake)).toEqual([]);
      expect(JSON.stringify(sentOf(fake))).not.toMatch(/<scratch>|<session-\d+>|<turn-\d+>|<item-\d+>/);
      expect(noted(id)).toMatchObject({ turns: ['m22-codex-once'], replies: [{ id: 0, result: { decision: 'accept' } }], changes: [{ file: 'k1-once.txt', kind: 'command' }] });
      expect(inProject('k1-once.txt')).toBe('k1\n');
      await fake.end();
    }, 90_000);

    it('ends the item declined where the reply declines what K1 accepted, as it started but for its status, and makes no change; an error reply is a decline', async () => {
      for (const reply of [{ result: { decision: 'decline' } }, { error: { code: -32601, message: 'Method not found' } }]) {
        const { fake, id } = await under('ask-first');
        await prompt(fake, id, promptAt('m22-codex-once'));
        const request = await requested(fake);
        fake.send({ id: request['id'], ...reply });
        await ended(fake, id);
        const itemId = at(request, 'params', 'itemId');
        const started = at(fake.lines.find((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'id') === itemId), 'params', 'item') as Json;
        expect(at(completed(fake, itemId), 'params', 'item')).toEqual({ ...started, status: 'declined' });
        // K1 declined this very command in its next turn: the item's end is that capture's own frame.
        expect(strangers(fake)).toEqual([]);
        expect(noted(id).changes).toBeUndefined();
        expect(inProject('k1-once.txt')).toBeNull();
        await fake.end();
      }
    }, 120_000);

    it('replays K1’s declined turn frame for frame where the reply declines, and ends the command completed where it accepts instead; a process numbers its requests from 0', async () => {
      const declined = await under('ask-first');
      await prompt(declined.fake, declined.id, promptAt('m22-codex-once', 1));
      const first = await requested(declined.fake);
      // K1's was its process's second request; this is this process's first.
      expect(first['id']).toBe(0);
      decide(declined.fake, first, 'decline');
      await ended(declined.fake, declined.id);
      expect(strangers(declined.fake)).toEqual([]);
      expect(at(completed(declined.fake, at(first, 'params', 'itemId')), 'params', 'item', 'status')).toBe('declined');
      // The same turn again in the same process: its request is the process's next.
      await prompt(declined.fake, declined.id, promptAt('m22-codex-once', 1));
      const second = await requested(declined.fake, 2);
      expect(second['id']).toBe(1);
      decide(declined.fake, second, 'accept');
      await ended(declined.fake, declined.id, 2);
      expect(at(declined.fake.lines.findLast((line) => line['method'] === RESOLVED), 'params', 'requestId')).toBe(1);
      expect(at(completed(declined.fake, at(second, 'params', 'itemId')), 'params', 'item')).toMatchObject({ status: 'completed', exitCode: 0, durationMs: 0 });
      expect(noted(declined.id).replies).toEqual([{ id: 0, result: { decision: 'decline' } }, { id: 1, result: { decision: 'accept' } }]);
      expect(inProject('k1-once.txt')).toBe('k1\n');
      await declined.fake.end();
    }, 120_000);

    it('grants a file for the session at `acceptForSession`: K1’s next change to it then plays with no request, in that process; in another, it asks, with the request K1’s resumed process got', async () => {
      const { fake, id } = await under('ask-first');
      await prompt(fake, id, promptAt('m22-codex-file-session-same-main'));
      const request = await requested(fake);
      expect(request['method']).toBe(FILE);
      expect(at(request, 'params')).toMatchObject({ threadId: id, reason: null, grantRoot: null });
      decide(fake, request, 'acceptForSession');
      await ended(fake, id);
      expect(inProject('k1-same.txt')).toBe('alpha\n');
      await prompt(fake, id, promptAt('m22-codex-file-session-same-main', 1));
      await ended(fake, id, 2);
      // As K1's own second turn: no request, and every frame from a capture file.
      expect(requests(fake)).toHaveLength(1);
      expect(strangers(fake)).toEqual([]);
      // The granted change is made too, as an accepted one is: the file now holds what K1's second turn wrote.
      expect(inProject('k1-same.txt')).toBe('beta\n');
      expect(noted(id)).toMatchObject({ turns: ['m22-codex-file-session-same-main', 'm22-codex-file-session-same-main#2'], replies: [{ id: 0, result: { decision: 'acceptForSession' } }], changes: [{ file: 'k1-same.txt', kind: 'add' }, { file: 'k1-same.txt', kind: 'update' }] });
      await fake.end();

      // A fresh process holds no grant: the same turn asks for the same file.
      const fresh = start();
      await fresh.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
      fresh.send({ method: 'initialized' });
      await fresh.request('thread/resume', { threadId: id, cwd: folder(), ...TRIPLES['ask-first'], excludeTurns: true });
      const turn = await prompt(fresh, id, promptAt('m22-codex-file-session-same-main', 1));
      const asked = await requested(fresh);
      const item = at(fresh.lines.find((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'type') === 'fileChange'), 'params', 'item') as Json;
      expect(at(asked, 'params')).toMatchObject({ threadId: id, turnId: at(turn, 'result', 'turn', 'id'), itemId: item['id'], reason: null, grantRoot: null });
      expect(asked['id']).toBe(0);
      decide(fresh, asked, 'accept');
      await ended(fresh, id);
      // The request, the thread's status around it and Codex's word are K1's resumed process's; the rest is the turn's own.
      expect(strangers(fresh)).toEqual([]);
      expect(at(completed(fresh, item['id']), 'params', 'item', 'status')).toBe('completed');
      expect(inProject('k1-same.txt')).toBe('beta\n');
      await fresh.end();
    }, 180_000);

    it('holds at each request of a turn that asks three times, and goes on by each reply', async () => {
      const { fake, id } = await under('ask-first');
      await prompt(fake, id, promptAt('m22-codex-files'));
      const items: unknown[] = [];
      for (const [index, decision] of ['accept', 'decline', 'accept'].entries()) {
        const request = await requested(fake, index + 1);
        expect(request['id']).toBe(index);
        items.push(at(request, 'params', 'itemId'));
        decide(fake, request, decision);
      }
      await ended(fake, id);
      expect(items.map((itemId) => at(completed(fake, itemId), 'params', 'item', 'status'))).toEqual(['completed', 'declined', 'completed']);
      expect(fake.lines.filter((line) => line['method'] === RESOLVED).map((line) => at(line, 'params', 'requestId'))).toEqual([0, 1, 2]);
      expect(noted(id).changes).toHaveLength(2);
      // One frame is not a capture's as it is: the declined item's end.
      expect(strangers(fake)).toHaveLength(1);
      await fake.end();
    }, 120_000);

    it('replays a worker’s request on the worker’s own thread and turn, as K1’s named them', async () => {
      const { fake, id } = await under('ask-first');
      await prompt(fake, id, promptAt('m22-codex-worker'));
      const request = await requested(fake);
      const worker = at(fake.lines.find((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'type') === 'subAgentActivity'), 'params', 'item', 'agentThreadId');
      expect(at(request, 'params', 'threadId')).toBe(worker);
      expect(worker).not.toBe(id);
      decide(fake, request, 'accept');
      await ended(fake, id);
      expect(strangers(fake)).toEqual([]);
      expect(inProject('k1-worker.txt')).toBe('k1\n');
      await fake.end();
    }, 120_000);

    it('answers an interrupt while a request is held from K1’s stopped turn: its reply, the turn interrupted, then Codex’s word for the request, which is never replied to', async () => {
      const { fake, id } = await under('ask-first');
      const reply = await prompt(fake, id, promptAt('m22-codex-once'));
      const request = await requested(fake);
      const before = fake.lines.length;
      const taken = await fake.request('turn/interrupt', { threadId: id, turnId: at(reply, 'result', 'turn', 'id') });
      expect(taken['error']).toBeUndefined();
      const end = await ended(fake, id);
      expect(at(end, 'params', 'turn', 'status')).toBe('interrupted');
      const resolved = await fake.next((line) => line['method'] === RESOLVED, 30_000);
      expect(fake.lines.indexOf(resolved)).toBeGreaterThan(fake.lines.indexOf(end));
      expect(at(resolved, 'params')).toEqual({ threadId: id, requestId: request['id'] });
      // The tail is that capture's first turn's alone: nothing of its second turn follows.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.lines.slice(before).filter((line) => line['method'] === 'turn/started')).toEqual([]);
      expect(fake.lines.slice(before).filter((line) => !capturedUnnumbered.has(comparedTo(line, folder()))).map((line) => JSON.stringify(line).slice(0, 200))).toEqual([]);
      expect(noted(id).replies).toBeUndefined();
      expect(noted(id).interrupts).toEqual([{ inputOpen: true, worker: false }]);
      expect(inProject('k1-once.txt')).toBeNull();
      await fake.end();
    }, 90_000);

    it('replays the turns that asked nothing as they are: under Codex’s own reviewer, with its three frames, and under full access', async () => {
      const reviewed = await under('auto-reviewed', { sandboxState: 'ready' });
      await prompt(reviewed.fake, reviewed.id, promptAt('m22-codex-auto-review-main'));
      await ended(reviewed.fake, reviewed.id);
      expect(requests(reviewed.fake)).toEqual([]);
      expect(reviewed.fake.lines.flatMap((line) => (['item/autoApprovalReview/started', 'guardianWarning', 'item/autoApprovalReview/completed'].includes(String(line['method'])) ? [line['method']] : []))).toEqual(['item/autoApprovalReview/started', 'guardianWarning', 'item/autoApprovalReview/completed']);
      expect(strangers(reviewed.fake)).toEqual([]);
      // Nobody accepted anything of fat-g's: the fake made no change.
      expect(noted(reviewed.id).changes).toBeUndefined();
      await reviewed.fake.end();
      const full = await under('berserk');
      await prompt(full.fake, full.id, promptAt('m22-codex-berserk-main'));
      await ended(full.fake, full.id);
      expect(requests(full.fake)).toEqual([]);
      expect(strangers(full.fake)).toEqual([]);
      await full.fake.end();
    }, 120_000);

    it('sends T7’s own request as it always did, and does not wait at it', async () => {
      const { fake, id } = await under('read-only');
      await prompt(fake, id, promptOf('t7-declined'));
      await ended(fake, id);
      expect(requests(fake)).toHaveLength(1);
      expect(noted(id).replies).toBeUndefined();
      await fake.end();
    }, 60_000);
  });

  describe('each fault of a request for leave', () => {
    /** K1's command turn, or its file turn, up to its request, under a control. */
    async function asking(controls: Json, which: 'command' | 'file' = 'command'): Promise<{ fake: Fake; id: string; turnId: string }> {
      const { fake, id } = await under('ask-first', controls);
      const reply = await prompt(fake, id, promptAt(which === 'command' ? 'm22-codex-once' : 'm22-codex-file-session-same-main'));
      return { fake, id, turnId: String(at(reply, 'result', 'turn', 'id')) };
    }

    it('approvalTwice: the request is delivered a second time, the same, under the same id', async () => {
      const { fake } = await asking({ approvalTwice: true });
      await requested(fake, 2);
      expect(requests(fake)[1]).toEqual(requests(fake)[0]);
      await fake.end();
    });

    it('approvalChanged: it is delivered a second time under the same id with another command, or — a file change’s — a reason it did not have', async () => {
      const command = await asking({ approvalChanged: true });
      await requested(command.fake, 2);
      const [first, second] = requests(command.fake) as [Json, Json];
      expect(second['id']).toBe(first['id']);
      expect(at(second, 'params', 'command')).toBe(`${String(at(first, 'params', 'command'))} --changed`);
      expect({ ...(second['params'] as Json), command: 0 }).toEqual({ ...(first['params'] as Json), command: 0 });
      await command.fake.end();
      const file = await asking({ approvalChanged: true }, 'file');
      await requested(file.fake, 2);
      expect(requests(file.fake).map((line) => at(line, 'params', 'reason'))).toEqual([null, 'changed']);
      await file.fake.end();
    });

    it('approvalWorker: it names a thread that is neither the session’s nor any worker’s', async () => {
      const { fake, id } = await asking({ approvalWorker: true });
      const request = await requested(fake);
      expect(at(request, 'params', 'threadId')).not.toBe(id);
      await fake.end();
    });

    it('approvalLate: it comes after its turn’s end, the turn having gone on without it, and Codex’s word for it is withheld', async () => {
      const { fake, id } = await asking({ approvalLate: true });
      const end = await ended(fake, id);
      const request = await requested(fake);
      expect(fake.lines.indexOf(request)).toBeGreaterThan(fake.lines.indexOf(end));
      expect(fake.lines.some((line) => line['method'] === RESOLVED)).toBe(false);
      await fake.end();
    });

    it('approvalResolvedEarly: Codex’s word for it follows at once, and the turn goes on without a reply', async () => {
      const { fake, id } = await asking({ approvalResolvedEarly: true });
      await ended(fake, id);
      const request = await requested(fake);
      expect(at(fake.lines.find((line) => line['method'] === RESOLVED), 'params', 'requestId')).toBe(request['id']);
      expect(noted(id).replies).toBeUndefined();
      await fake.end();
    });

    it('exitWhileApproving: the process ends once the request is out; set after that, as the reply arrives, before Codex’s word for it', async () => {
      const first = await asking({ exitWhileApproving: 1 });
      expect(await first.fake.closed).toBe(3);
      expect(requests(first.fake)).toHaveLength(1);
      const second = await asking({});
      const request = await requested(second.fake);
      setControl({ exitWhileApproving: 1 });
      decide(second.fake, request, 'accept');
      expect(await second.fake.closed).toBe(3);
      expect(second.fake.lines.some((line) => line['method'] === RESOLVED)).toBe(false);
      // The reply was read, and noted, before the process went.
      expect(noted(second.id).replies).toEqual([{ id: 0, result: { decision: 'accept' } }]);
    });

    it('exitAtDecision: the process ends as the first bytes of the decision arrive, before any line of it is read', async () => {
      const { fake, id } = await asking({ exitAtDecision: 1 });
      const request = await requested(fake);
      expect(fake.exited()).toBe(false);
      decide(fake, request, 'accept');
      expect(await fake.closed).toBe(3);
      expect(fake.lines.some((line) => line['method'] === RESOLVED)).toBe(false);
      expect(noted(id).replies).toBeUndefined();
      expect(inProject('k1-once.txt')).toBeNull();
    });

    it('requestOverLine: the request’s line passes a session’s limit, its id among its first bytes; requestOverLineNoId: the same, its id written after its parameters', async () => {
      const first = await asking({ requestOverLine: true });
      await requested(first.fake);
      const raw = first.fake.chunks.join('');
      const line = raw.split('\n').find((candidate) => candidate.includes(COMMAND)) ?? '';
      expect(Buffer.byteLength(line)).toBeGreaterThan(4 * MIB);
      expect(line.slice(0, 80)).toBe(`{"method":"${COMMAND}","id":0,"params":{"kind":"command","threadId":"${first.id}",`.slice(0, 80));
      await first.fake.end();
      const second = await asking({ requestOverLineNoId: true });
      await requested(second.fake);
      const other = second.fake.chunks.join('').split('\n').find((candidate) => candidate.includes(COMMAND)) ?? '';
      expect(Buffer.byteLength(other)).toBeGreaterThan(4 * MIB);
      expect(other.startsWith(`{"method":"${COMMAND}","params":{`)).toBe(true);
      expect(other.endsWith(',"id":0}')).toBe(true);
      // No id within what is read of such a line.
      expect(other.slice(0, 512)).not.toMatch(/"id":/);
      await second.fake.end();
    }, 120_000);

    it('fileChangeUnheld, grantRootNamed: a file change’s request names an item never started, or asks for a root; commandForSession: a command’s list holds the session’s decision', async () => {
      const unheld = await asking({ fileChangeUnheld: true }, 'file');
      const first = await requested(unheld.fake);
      expect(unheld.fake.lines.some((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'id') === at(first, 'params', 'itemId'))).toBe(false);
      await unheld.fake.end();
      const rooted = await asking({ grantRootNamed: true }, 'file');
      expect(at(await requested(rooted.fake), 'params', 'grantRoot')).toBe(folder());
      await rooted.fake.end();
      const listed = await asking({ commandForSession: true });
      const request = await requested(listed.fake);
      expect((at(request, 'params', 'availableDecisions') as unknown[]).slice(0, 2)).toEqual(['accept', 'acceptForSession']);
      expect(at(request, 'params', 'availableDecisions')).toHaveLength(4);
      await listed.fake.end();
    }, 120_000);

    it('changesTwentyOne, changeOverBound: a `fileChange` item holds twenty-one changes, or one past 1,048,576 units, on both of its frames', async () => {
      const many = await asking({ changesTwentyOne: true }, 'file');
      const request = await requested(many.fake);
      const changesOf = (fake: Fake, method: string): { path: string; diff: string }[] => at(fake.lines.find((line) => line['method'] === method && at(line, 'params', 'item', 'type') === 'fileChange'), 'params', 'item', 'changes') as { path: string; diff: string }[];
      expect(changesOf(many.fake, 'item/started')).toHaveLength(21);
      expect(new Set(changesOf(many.fake, 'item/started').map((change) => change.path)).size).toBe(21);
      decide(many.fake, request, 'accept');
      await ended(many.fake, many.id);
      expect(changesOf(many.fake, 'item/completed')).toHaveLength(21);
      // The change the fake makes is the capture's one file, whatever the control added.
      expect(noted(many.id).changes).toEqual([{ file: 'k1-same.txt', kind: 'add' }]);
      await many.fake.end();
      const big = await asking({ changeOverBound: true }, 'file');
      await requested(big.fake);
      expect(changesOf(big.fake, 'item/started')[0]?.diff).toHaveLength(1_048_577);
      await big.fake.end();
    }, 120_000);
  });

  describe('Codex’s own sandbox: readiness, and the setup', () => {
    /** A process whose handshake is the sandbox connection's: `clientInfo` alone. */
    async function connection(extra: Record<string, string> = {}): Promise<Fake> {
      const fake = start(extra);
      await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' } });
      fake.send({ method: 'initialized' });
      return fake;
    }
    const K6 = (name: string, method: string): Json => capture(name).frames.find((f) => f.dir === 'recv' && f.frame['method'] === method)?.frame as Json;

    it('answers readiness by the account’s sandbox state, with the captured reply, and notes each request with its process', async () => {
      const none = await connection();
      expect(await none.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      await none.end();
      setControl({ sandboxState: 'ready' });
      const ready = await connection();
      expect(await ready.request(READINESS)).toMatchObject({ result: { status: 'ready' } });
      await ready.end();
      expect(sandboxNotes().asked).toEqual([{ pid: none.pid, method: READINESS, params: null }, { pid: ready.pid, method: READINESS, params: null }]);
      expect(sandboxNotes().state).toBeUndefined();
    });

    it('answers the setup as K6’s approved one was: `started`, then Codex’s word after a gap; the account is set up for every process started after it, and not for its own', async () => {
      const fake = await connection();
      expect(await fake.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      const reply = await fake.request(SETUP, { mode: 'elevated', cwd: dir });
      expect(reply['result']).toEqual({ started: true });
      const completed = await fake.next((line) => line['method'] === COMPLETED);
      expect(at(completed, 'params')).toEqual(at(K6('m22-codex-setup', COMPLETED), 'params'));
      expect(at(completed, 'params')).toEqual({ mode: 'elevated', success: true, error: null });
      expect(fake.lines.indexOf(completed)).toBeGreaterThan(fake.lines.indexOf(reply));
      // K6: the process that ran the setup still answers that none is set up.
      expect(await fake.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      await fake.end();
      const later = await connection();
      expect(await later.request(READINESS)).toMatchObject({ result: { status: 'ready' } });
      // And a workspace start is then reported as one.
      expect(at(await later.request('thread/start', { cwd: folder(), ...TRIPLES['sandbox-ok'], model: MODEL }), 'result', 'sandbox')).toEqual(WORKSPACE);
      await later.end();
      expect(sandboxNotes().state).toBe('ready');
      expect(sandboxNotes().asked?.map((entry) => [entry.pid === fake.pid, entry.method, entry.params])).toEqual([[true, READINESS, null], [true, SETUP, { mode: 'elevated', cwd: dir }], [true, READINESS, null], [false, READINESS, null]]);
    });

    it('setupOutcome declined: K6’s declined setup, with its error, and the account stays as it was', async () => {
      setControl({ setupOutcome: 'declined' });
      const fake = await connection();
      expect((await fake.request(SETUP, { mode: 'elevated', cwd: dir }))['result']).toEqual({ started: true });
      const completed = await fake.next((line) => line['method'] === COMPLETED);
      expect(at(completed, 'params')).toEqual(at(K6('m22-codex-setup-declined', COMPLETED), 'params'));
      expect(at(completed, 'params', 'success')).toBe(false);
      await fake.end();
      const later = await connection();
      expect(await later.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      await later.end();
      expect(sandboxNotes().state).toBeUndefined();
    });

    it('setupOutcome never: no completion comes; drop: the process ends right after the reply', async () => {
      setControl({ setupOutcome: 'never' });
      const never = await connection();
      await never.request(SETUP, { mode: 'elevated', cwd: dir });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(never.lines.some((line) => line['method'] === COMPLETED)).toBe(false);
      expect(never.exited()).toBe(false);
      await never.end();
      setControl({ setupOutcome: 'drop' });
      const drop = await connection();
      expect((await drop.request(SETUP, { mode: 'elevated', cwd: dir }))['result']).toEqual({ started: true });
      expect(await drop.closed).toBe(3);
      expect(drop.lines.some((line) => line['method'] === COMPLETED)).toBe(false);
      expect(sandboxNotes().state).toBeUndefined();
    });

    it('setupRefused, setupNoStarted, setupNoReply: the request is refused, answered without `started`, or never answered — and nothing is set up', async () => {
      setControl({ setupRefused: true });
      const refused = await connection();
      expect((await refused.request(SETUP, { mode: 'elevated', cwd: dir }))['error']).toMatchObject({ code: -32600 });
      await refused.end();
      setControl({ setupNoStarted: true });
      const idle = await connection();
      expect((await idle.request(SETUP, { mode: 'elevated', cwd: dir }))['result']).toEqual({ started: false });
      await idle.end();
      setControl({ setupNoReply: true });
      const silent = await connection();
      silent.send({ id: 70, method: SETUP, params: { mode: 'elevated', cwd: dir } });
      // It answers what comes after: the request itself is the one left unanswered.
      expect(await silent.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      expect(silent.lines.some((line) => line['id'] === 70)).toBe(false);
      await silent.end();
      expect(sandboxNotes().state).toBeUndefined();
      expect(sandboxNotes().asked?.filter((entry) => entry.method === SETUP)).toHaveLength(3);
    });

    it('keeps each account’s sandbox apart, by the home its process was given; an account of the accounts file has its own', async () => {
      const homeA = path.join(dir, 'home-a');
      const homeB = path.join(dir, 'home-b');
      const a = await connection({ CODEX_HOME: homeA });
      await a.request(SETUP, { mode: 'elevated', cwd: dir });
      await a.next((line) => line['method'] === COMPLETED);
      await a.end();
      const again = await connection({ CODEX_HOME: homeA });
      expect(await again.request(READINESS)).toMatchObject({ result: { status: 'ready' } });
      await again.end();
      const b = await connection({ CODEX_HOME: homeB });
      expect(await b.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      await b.end();
      const first = await connection();
      expect(await first.request(READINESS)).toMatchObject({ result: { status: 'notConfigured' } });
      await first.end();
      expect(sandboxNotes(homeA).state).toBe('ready');
      expect(sandboxNotes(homeB).state).toBeUndefined();
      expect(sandboxNotes().state).toBeUndefined();
      // An entry of the accounts file says its own state.
      const accounts = path.join(dir, 'accounts.json');
      writeFileSync(accounts, JSON.stringify({ [homeB]: { state: 'subscription', sandbox: 'ready' } }));
      const listed = await connection({ CODEX_HOME: homeB, FATG_SMOKE_CODEX_ACCOUNTS: accounts });
      expect(await listed.request(READINESS)).toMatchObject({ result: { status: 'ready' } });
      await listed.end();
    });
  });
});

// ── M22b: plans ───────────────────────────────────────────────────────────────────────────────
// K2's captures (docs/planning/_archive/M22b.md, Design 8; V7; C13–C15, C48, C53, C55, C59, C61): a turn
// that names `collaborationMode` needs the experimental API on the handshake; the mode a turn names
// stays with its thread, across processes; a turn in plan mode plays a plan turn of K2's by its
// words and its thread's policy; `default` plays K2's Execute and resumed prompt; the reply to M21's
// plan turn's question chooses how it goes on; and each plan control does what it names.
describe('a plan (M22b: V7; C13–C15, C48, C53, C55, C59, C61)', () => {
  const MODEL = 'gpt-6-luna';
  const REQUEST = 'item/tool/requestUserInput';
  const RESOLVED = 'serverRequest/resolved';
  const PLAN_DELTA = 'item/plan/delta';
  const isLeave = (line: Json): boolean => line['method'] === 'item/commandExecution/requestApproval' || line['method'] === 'item/fileChange/requestApproval';
  const unnumbered = (line: Json): Json => (isLeave(line) || line['method'] === REQUEST ? { ...line, id: 0 } : line['method'] === RESOLVED ? { ...line, params: { ...(line['params'] as Json), requestId: 0 } } : line);
  const known = new Set<string>();
  for (const file of readdirSync(CAPTURES).filter((name) => name.endsWith('.json'))) {
    for (const { dir: direction, frame } of capture(file.replace(/\.json$/, '')).frames) if (direction === 'recv') known.add(comparable(unnumbered(frame), '<never>'));
  }
  const strangers = (fake: Fake): string[] => fake.lines.filter((line) => at(line, 'result', 'platformFamily') === undefined && at(line, 'result', 'thread') === undefined && line['error'] === undefined)
    .filter((line) => !known.has(comparable(unnumbered(line), folder()))).map((line) => JSON.stringify(line).slice(0, 220));
  const startsOf = (name: string): Json[] => capture(name).frames.filter((f) => f.dir === 'send' && f.frame['method'] === 'turn/start').map((f) => f.frame['params'] as Json);
  const wordsOf = (name: string, nth = 0): string => String(at(startsOf(name)[nth], 'input', 0, 'text'));
  const TRIPLES: Record<string, Json> = {
    'read-only': { sandbox: 'read-only', approvalPolicy: 'never' },
    'ask-first': { sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
    'sandbox-ok': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
    'auto-reviewed': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    berserk: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
  };
  const collaboration = (mode: string): Json => ({ collaborationMode: { mode, settings: { model: MODEL, reasoning_effort: 'low', developer_instructions: null } } });
  interface Noted { turns: string[]; starts?: Json[]; collaboration?: string; collaborations?: (Json | null)[]; replies?: Json[] }
  const noted = (id: string): Noted => threadFile()[id] as unknown as Noted;

  /** A session's process with fat-g's own handshake — the experimental API asked for, unless `plain` — and a thread under a mode's triple. */
  async function planning(mode: string, controls: Json = {}, plain = false): Promise<{ fake: Fake; id: string }> {
    setControl({ sandboxState: 'ready', ...controls });
    mkdirSync(folder(), { recursive: true });
    const fake = start();
    await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { ...(plain ? {} : { experimentalApi: true }), optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    fake.send({ method: 'initialized' });
    const reply = await fake.request('thread/start', { cwd: folder(), ...TRIPLES[mode], model: MODEL });
    return { fake, id: String(at(reply, 'result', 'thread', 'id')) };
  }
  const send = (fake: Fake, id: string, text: string, mode: string | null): Promise<Json> =>
    fake.request('turn/start', { threadId: id, input: [{ type: 'text', text, text_elements: [] }], model: MODEL, effort: 'low', clientUserMessageId: CLIENT_ID, ...(mode === null ? {} : collaboration(mode)) });
  const ended = (fake: Fake, id: string, n = 1): Promise<Json> => fake.next(() => fake.lines.filter(sessionEnd(id)).length >= n, 60_000).then(() => fake.lines.filter(sessionEnd(id))[n - 1] as Json);
  /** Every request for leave is declined as K2's were, until the turn's `n`th end. */
  async function declined(fake: Fake, id: string, n = 1): Promise<void> {
    const answered = new Set<unknown>();
    while (fake.lines.filter(sessionEnd(id)).length < n) {
      await fake.next(() => fake.lines.filter(sessionEnd(id)).length >= n || fake.lines.some((line) => isLeave(line) && !answered.has(line['id'])), 60_000);
      for (const line of fake.lines.filter((entry) => isLeave(entry) && !answered.has(entry['id']))) { answered.add(line['id']); fake.send({ id: line['id'], result: { decision: 'decline' } }); }
    }
  }
  /** The newest plan's completed text, and what its deltas brought. */
  function planned(fake: Fake): { readonly text: string; readonly deltas: string; readonly count: number } {
    const done = items(fake, 'plan').at(-1);
    const itemId = at(done, 'params', 'item', 'id');
    const deltas = fake.lines.filter((line) => line['method'] === PLAN_DELTA && at(line, 'params', 'itemId') === itemId).map((line) => String(at(line, 'params', 'delta')));
    return { text: String(at(done, 'params', 'item', 'text')), deltas: deltas.join(''), count: deltas.length };
  }

  it('names K2’s captures whose turns are plan turns, Execute and the resumed prompt; skip’s and empty’s are M21’s plan turn after a reply, and no turn of their own', () => {
    expect([...PLAN_CAPTURES]).toEqual(['m22b-codex-modes', 'm22b-codex-chain', 'm22b-codex-resumed-first', 'm22b-codex-resumed-resumed']);
    const all = readdirSync(CAPTURES).filter((file) => file.startsWith('m22b-codex-')).map((file) => file.replace(/\.json$/, '')).filter((name) => startsOf(name).length > 0);
    expect(all.filter((name) => !PLAN_CAPTURES.includes(name)).sort()).toEqual(['m22b-codex-empty', 'm22b-codex-skip']);
    for (const name of ['m22b-codex-skip', 'm22b-codex-empty']) expect(wordsOf(name)).toBe(promptOf('m21-codex-plan'));
    // What each turn named: the chain's plain prompt named nothing, its Execute and the resumed prompt `default`.
    expect(PLAN_CAPTURES.flatMap((name) => startsOf(name).map((params) => at(params, 'collaborationMode', 'mode') ?? null))).toEqual(['plan', 'plan', 'plan', 'plan', 'plan', null, 'default', 'plan', 'default']);
  });

  it('refuses a turn that names a collaboration mode to a handshake that did not ask for the experimental API, and plays one that names none as ever', async () => {
    const { fake, id } = await planning('read-only', {}, true);
    const refused = await send(fake, id, wordsOf('m22b-codex-modes'), 'plan');
    expect(refused['error']).toMatchObject({ code: -32600 });
    expect(fake.lines.some((line) => line['method'] === 'turn/started')).toBe(false);
    await send(fake, id, PROMPT.t1, null);
    await ended(fake, id);
    expect(noted(id).collaborations).toEqual([null]);
    await fake.end();
  }, 60_000);

  it('experimentalRefused: refuses a handshake that asks for the experimental API, and answers a plain one', async () => {
    setControl({ experimentalRefused: true });
    const fake = start();
    const asked = await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    expect(asked['error']).toMatchObject({ code: -32600 });
    const plain = await fake.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    expect(plain['result']).toBeDefined();
    await fake.end();
  });

  it.each([['ask-first', 'm22b-codex-chain', 0], ['sandbox-ok', 'm22b-codex-modes', 0], ['auto-reviewed', 'm22b-codex-modes', 1], ['berserk', 'm22b-codex-modes', 2]] as const)(
    'replays a plan turn under %s for its words, its plan streamed as K2 saw it and the completed text the deltas’ sum — every frame from a capture file', async (mode, name, nth) => {
      const { fake, id } = await planning(mode);
      const reply = await send(fake, id, wordsOf(name, nth), 'plan');
      await declined(fake, id);
      const plan = planned(fake);
      expect(plan.count).toBeGreaterThan(10);
      expect(plan.deltas).toBe(plan.text);
      // The plan's item opens with no text, and its deltas name it, its turn and its thread.
      const opened = fake.lines.find((line) => line['method'] === 'item/started' && at(line, 'params', 'item', 'type') === 'plan');
      expect(at(opened, 'params', 'item', 'text')).toBe('');
      expect(fake.lines.filter((line) => line['method'] === PLAN_DELTA).every((line) => at(line, 'params', 'threadId') === id && at(line, 'params', 'turnId') === at(reply, 'result', 'turn', 'id'))).toBe(true);
      // No turn of K2's under these modes wrote anything (K2).
      expect(readdirSync(folder())).toEqual([]);
      expect(strangers(fake)).toEqual([]);
      expect(noted(id)).toMatchObject({ collaboration: 'plan', collaborations: [collaboration('plan')['collaborationMode']], starts: [{ capture: nth === 0 ? name : `${name}#${nth + 1}`, mode: 'plan' }] });
      await fake.end();
    }, 90_000);

  it('plays a plan turn of other words as its policy’s first plan turn that asks nothing, and one with a block of fat-g’s as the chain’s feedback turn', async () => {
    const { fake, id } = await planning('sandbox-ok');
    await send(fake, id, 'Plan something no capture holds.', 'plan');
    await ended(fake, id);
    const block = 'Shorter, please.\n\n<fat-g-plan id="a1b2c3d4-0000-4000-8000-000000000001" version="1" token="0123456789ab">\n</fat-g-plan token="0123456789ab">';
    await send(fake, id, block, 'plan');
    await declined(fake, id, 2);
    expect(noted(id).starts?.map((entry) => entry['capture'])).toEqual(['m22b-codex-modes', 'm22b-codex-chain#2']);
    expect(planned(fake).deltas).toBe(planned(fake).text);
    expect(strangers(fake)).toEqual([]);
    await fake.end();
  }, 90_000);

  it('runs a turn that names no mode in the mode its thread was left in — the chain’s plain prompt, answered without implementing — and one naming default as any (C55)', async () => {
    const { fake, id } = await planning('ask-first');
    await send(fake, id, wordsOf('m22b-codex-chain'), 'plan');
    await declined(fake, id);
    const plans = items(fake, 'plan').length;
    await send(fake, id, PROMPT.t1, null);
    await declined(fake, id, 2);
    expect(noted(id).starts?.at(-1)).toMatchObject({ capture: 'm22b-codex-chain#3', mode: null });
    expect(noted(id).collaboration).toBe('plan');
    await send(fake, id, PROMPT.t1, 'default');
    await declined(fake, id, 3);
    expect(noted(id).collaboration).toBe('default');
    expect(noted(id).turns.at(-1)).not.toMatch(/^m22b-/);
    // And from there a turn that names nothing is a turn as any.
    await send(fake, id, PROMPT.t1, null);
    await declined(fake, id, 4);
    expect(noted(id).turns.at(-1)).not.toMatch(/^m22b-/);
    expect(items(fake, 'plan')).toHaveLength(plans);
    expect(noted(id).collaborations).toEqual([collaboration('plan')['collaborationMode'], null, collaboration('default')['collaborationMode'], null]);
    await fake.end();
  }, 120_000);

  it('plays Execute naming default as the chain’s, for fat-g’s words and for a block that executes; and the resumed thread’s plain prompt, its mode kept across processes', async () => {
    const first = await planning('ask-first');
    await send(first.fake, first.id, wordsOf('m22b-codex-resumed-first'), 'plan');
    await declined(first.fake, first.id);
    expect(noted(first.id).starts?.at(-1)).toMatchObject({ capture: 'm22b-codex-resumed-first' });
    await first.fake.end();
    // Another process resumes the thread: its mode is the one the first left it in.
    setControl({ sandboxState: 'ready' });
    const second = start();
    await second.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    second.send({ method: 'initialized' });
    await second.request('thread/resume', { threadId: first.id, cwd: folder(), ...TRIPLES['ask-first'] });
    expect(noted(first.id).collaboration).toBe('plan');
    await send(second, first.id, wordsOf('m22b-codex-resumed-resumed'), 'default');
    await declined(second, first.id);
    expect(noted(first.id).starts?.at(-1)).toMatchObject({ capture: 'm22b-codex-resumed-resumed', mode: 'default' });
    await send(second, first.id, 'Implement the plan you proposed.', 'default');
    await declined(second, first.id, 2);
    const brought = 'Implement the plan in the block below.\n\n<fat-g-plan id="a1b2c3d4-0000-4000-8000-000000000001" version="2" token="0123456789ab">\n# Plan\n</fat-g-plan token="0123456789ab">';
    await send(second, first.id, brought, 'default');
    await declined(second, first.id, 3);
    expect(noted(first.id).starts?.slice(-2).map((entry) => entry['capture'])).toEqual(['m22b-codex-chain#4', 'm22b-codex-chain#4']);
    expect(strangers(second)).toEqual([]);
    await second.end();
  }, 120_000);

  describe('M21’s plan turn’s question, by the reply (C53)', () => {
    const PLAN = promptOf('m21-codex-plan');
    /** The words of what each capture sent after its reply, as far as the turn's end: its methods and its items' types. */
    const after = (lines: readonly Json[]): string[] => lines.map((line) => (line['method'] === 'item/completed' || line['method'] === 'item/started' ? `${String(line['method'])}:${String(at(line, 'params', 'item', 'type'))}` : typeof line['method'] === 'string' ? line['method'] : 'reply'));
    function tailOf(name: string): string[] {
      const frames = capture(name).frames;
      const request = frames.find((f) => f.dir === 'recv' && f.frame['method'] === REQUEST);
      const replied = frames.find((f) => f.dir === 'send' && f.frame['method'] === undefined && f.frame['id'] === request?.frame['id']);
      const session = at(request?.frame, 'params', 'threadId');
      const tail: Json[] = [];
      for (const f of frames) {
        if (f.index <= (replied?.index ?? Infinity) || f.dir !== 'recv' || at(f.frame, 'params', 'threadId') !== session) continue;
        tail.push(f.frame);
        if (f.frame['method'] === 'turn/completed') break;
      }
      return after(tail);
    }
    async function asked(): Promise<{ fake: Fake; id: string; request: Json }> {
      const { fake, id } = await planning('read-only');
      await send(fake, id, PLAN, 'plan');
      const request = await fake.next((line) => line['method'] === REQUEST, 30_000);
      return { fake, id, request };
    }
    const since = (fake: Fake, request: Json): Json[] => fake.lines.slice(fake.lines.indexOf(request) + 1);

    it.each([['skip', 'm22b-codex-skip', (id: string) => ({ [id]: { answers: ['No answer'] } })], ['empty', 'm22b-codex-empty', () => ({})]] as const)(
      'goes on as K2’s %s did: its frames after its reply, Codex’s word naming this request, and no plan', async (_, name, answers) => {
        const { fake, id, request } = await asked();
        const questionId = String(at(request, 'params', 'questions', 0, 'id'));
        fake.send({ id: request['id'], result: { answers: answers(questionId) } });
        await ended(fake, id);
        expect(after(since(fake, request))).toEqual(tailOf(name));
        expect(at(since(fake, request).find((line) => line['method'] === RESOLVED), 'params')).toEqual({ threadId: id, requestId: request['id'] });
        expect(items(fake, 'plan')).toEqual([]);
        expect(strangers(fake)).toEqual([]);
        await fake.end();
      }, 90_000);

    it('goes on as M21’s own turn did for an answer, with its plan', async () => {
      const { fake, id, request } = await asked();
      fake.send({ id: request['id'], result: { answers: { [String(at(request, 'params', 'questions', 0, 'id'))]: { answers: ['notes-2.txt'] } } } });
      await ended(fake, id);
      expect(items(fake, 'plan')).toHaveLength(1);
      expect(noted(id).starts?.[0]).toMatchObject({ capture: 'm21-codex-plan', mode: 'plan' });
      await fake.end();
    }, 90_000);
  });

  describe('the plan’s controls (C59, C61)', () => {
    const WORDS = (): string => wordsOf('m22b-codex-modes');
    it('planWholeDiffers: the completion’s text is another than the deltas brought', async () => {
      const { fake, id } = await planning('sandbox-ok', { planWholeDiffers: true });
      await send(fake, id, WORDS(), 'plan');
      await ended(fake, id);
      const plan = planned(fake);
      expect(plan.text).toBe(`${plan.deltas} (as completed)`);
      await fake.end();
    }, 60_000);

    it('planLarge: a plan of over a mebibyte, its first delta carrying it, the deltas adding up to the completion', async () => {
      const { fake, id } = await planning('sandbox-ok', { planLarge: true });
      await send(fake, id, WORDS(), 'plan');
      await ended(fake, id);
      const plan = planned(fake);
      expect(plan.text.length).toBeGreaterThan(MIB);
      expect(plan.deltas).toBe(plan.text);
      expect(plan.text).toContain('\n- a line of padding');
      await fake.end();
    }, 60_000);

    it('planOverLine: the completion is a line past 4 MiB, its deltas as they were', async () => {
      const { fake, id } = await planning('sandbox-ok', { planOverLine: true });
      await send(fake, id, WORDS(), 'plan');
      await ended(fake, id);
      const done = items(fake, 'plan')[0];
      expect(JSON.stringify(done).length).toBeGreaterThan(4 * MIB);
      expect(planned(fake).text.startsWith(planned(fake).deltas)).toBe(true);
      await fake.end();
    }, 60_000);

    it('exitWhilePlanning: the process ends after the plan’s second delta', async () => {
      const { fake, id } = await planning('sandbox-ok', { exitWhilePlanning: 1 });
      await send(fake, id, WORDS(), 'plan');
      expect(await fake.closed).toBe(3);
      expect(fake.lines.filter((line) => line['method'] === PLAN_DELTA)).toHaveLength(2);
      expect(items(fake, 'plan')).toEqual([]);
    }, 60_000);

    it('collaborationRefused: a turn that names a mode is refused once, and the next is played', async () => {
      const { fake, id } = await planning('sandbox-ok', { collaborationRefused: 1 });
      expect((await send(fake, id, WORDS(), 'plan'))['error']).toMatchObject({ code: -32600 });
      await send(fake, id, WORDS(), 'plan');
      await ended(fake, id);
      expect(items(fake, 'plan')).toHaveLength(1);
      await fake.end();
    }, 60_000);
  });
});
