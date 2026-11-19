// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V34 (docs/planning/_archive/M16.md, Design 8; C51, C53, C79, C80) and V19 (docs/planning/_archive/M19.md, Design 9;
// C55, C56): the Claude replay fake's chat session, started here as a plain child, for the launch
// that asks for partial messages. Its turns are M19's K2 captures, with a reply's stream events. Every frame it sends is a received frame of a capture file but for
// ids, times and the folder; other arguments exit as before; the prompt chooses the capture, and
// only one whose prompt carries an id is a turn; it waits where the capture shows fat-g sending;
// another process resumes what the first began; and each control changes one named thing.
// V11 (docs/planning/_archive/M22.md, Design 6 and 11; C35) adds the launch to what a frame may differ by: a
// process reports the permission mode and the tools of the launch it was started under, one of five.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCodeSpanPath } from '@shared/contracts/files';
import { removeFolder } from '../process/remove-folder';
import { APPROVAL_CAPTURES, APPROVAL_RESUMED, ASIDE_TURN_CAPTURES, BYPASS_RESUMED, CHAT_FIXED_ARGS, CHAT_LAUNCHES, chatFixedArgs, COMMAND_CAPTURES, DECLINE_CAPTURES, M23_CAPTURES, EXECUTION_TOOLS, MODE_CAPTURES, MODES_SET, parseChatArgs, QUESTION_CAPTURES, QUESTION_KILLED, QUESTION_STOP, READING_TOOLS, SIDE_CAPTURES, STREAM_CAPTURES, TURN_CAPTURES, WHOLE_CAPTURES } from '../fixtures/claude/replay.mjs';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Json = Record<string, unknown>;

const FAKE = path.resolve('tests/fixtures/fake-claude-cli.mjs');
const CAPTURES = path.resolve('tests/fixtures/claude/captures');
const MIB = 1024 * 1024;
/** The private-looking text the fake plants where nothing of it may be read (decision 0033's `contextPrivate`). */
const SENTINEL = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/fake-cli-constants.json'), 'utf8')) as { sentinel: string }).sentinel;
interface Captured { readonly index: number; readonly dir: string; readonly ms: number; readonly frame: Json }
const capture = (name: string): { frames: Captured[] } => JSON.parse(readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8')) as never;
const captureFiles = (): Map<string, string> => new Map(readdirSync(CAPTURES).filter((name) => name.endsWith('.json')).map((name) => [name, readFileSync(path.join(CAPTURES, name), 'utf8')]));
const atStart = captureFiles();
afterAll(() => {
  // A fault changes a frame as it is sent: no capture file is ever written (C80).
  expect(captureFiles()).toEqual(atStart);
});

const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);
const firstPrompt = (name: string): Captured => capture(name).frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'user') as Captured;
/** The prompt's own id in a prompt-carrying capture, or undefined. */
const promptAlias = (name: string): unknown => firstPrompt(name).frame['uuid'];
/** A UUID as fat-g makes one for a user's message. */
const PROMPT_ID = (n: number): string => `99999999-9999-4999-8999-00000000000${n}`;

// ── Masking: what "but for ids, times and the folder" means ───────────────────────────────────
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ALIAS = /<[a-z][a-z-]*-\d+>/g;
const TIME_KEYS = new Set(['end_time', 'start_time', 'request_sent_wall_ms']);
function mask(value: unknown, folder: string, key?: string): unknown {
  if (typeof value === 'string') return key === 'timestamp' ? '<time>' : value.replaceAll(folder, '<scratch>').replace(UUID, '<id>').replace(ALIAS, '<id>');
  if (typeof value === 'number' && key !== undefined && TIME_KEYS.has(key)) return 0;
  if (Array.isArray(value)) return value.map((item) => mask(item, folder));
  if (value !== null && typeof value === 'object') {
    const block = value as Json;
    const file = at(block, 'input', 'file_path');
    const native = path.sep === '/' && block['type'] === 'tool_use' && block['name'] === 'Read' && typeof file === 'string' && file.startsWith('<scratch>\\')
      ? { ...block, input: { ...(block['input'] as Json), file_path: file.replaceAll('\\', '/') } } : block;
    return Object.fromEntries(Object.entries(native).map(([name, item]) => [mask(name, folder) as string, mask(item, folder, name)]));
  }
  return value;
}
/**
 * The launch (M22): a fourth thing a frame may differ from its capture's by. An `init` names the mode
 * in force and the launch's tools — the built-in names, which lead its list, compare as one, and the
 * `mcp__` names after them are the capture's own — and the `initialize` reply names the launch's
 * word. What each names is held by the launch's own tests, below.
 */
function launchMasked(frame: Json): Json {
  if (frame['type'] !== 'system' || frame['subtype'] !== 'init' || !Array.isArray(frame['tools'])) return frame;
  const tools = frame['tools'] as string[];
  const configured = tools.findIndex((name) => name.startsWith('mcp__'));
  return { ...frame, permissionMode: '<mode>', tools: ['<tools>', ...(configured === -1 ? [] : tools.slice(configured))] };
}
/** A frame as it compares. A reply's request id is the request's own, fat-g's or the capture's, so it is masked too. */
function masked(frame: Json, folder: string): Json {
  const response = frame['response'];
  if (frame['type'] !== 'control_response' || response === null || typeof response !== 'object') return mask(launchMasked(frame), folder) as Json;
  const inner = (response as Json)['response'];
  const launched = inner !== null && typeof inner === 'object' && 'current_permission_mode' in inner ? { response: { ...(inner as Json), current_permission_mode: '<mode>' } } : {};
  return mask({ ...frame, response: { ...(response as Json), request_id: '<id>', ...launched } }, folder) as Json;
}
const comparable = (frame: Json, folder: string): string => JSON.stringify(masked(frame, folder));
const captured = new Set<string>();
for (const name of atStart.keys()) {
  for (const { dir, frame } of capture(name.replace(/\.json$/, '')).frames) if (dir === 'recv') captured.add(comparable(frame, '<never>'));
}
/** The paths at which two values differ. */
function differences(a: unknown, b: unknown, at = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) => differences((a as Json)[key], (b as Json)[key], at === '' ? key : `${at}.${key}`));
  }
  return [at];
}

// ── The fake as a child ───────────────────────────────────────────────────────────────────────
interface Fake {
  readonly pid: number;
  readonly lines: Json[];
  /** The raw length of each line, in bytes. */
  readonly sizes: number[];
  /** The read that completed each line, by its number: the lines of one write come in one read. */
  readonly reads: number[];
  /** The first 512 bytes of each line, as they were written. */
  readonly heads: string[];
  send(value: Json): void;
  /** `initialize`, as fat-g sends it: resolves with the reply. */
  initialize(): Promise<Json>;
  prompt(text: string, n?: number): void;
  interrupt(): string;
  /** `set_permission_mode`, as fat-g sends it: the request's id. */
  setMode(mode: string): string;
  next(match: (line: Json) => boolean, timeoutMs?: number): Promise<Json>;
  /** Resolves with what arrived during `ms`: nothing, where the fake waits. */
  during(ms: number): Promise<Json[]>;
  readonly closed: Promise<number | null>;
  end(): Promise<number | null>;
  exited(): boolean;
  /** Writes one line, and resolves with whether the fake's input took it whole: false where the fake ended first. */
  written(value: Json): Promise<boolean>;
}
const open: ChildProcessWithoutNullStreams[] = [];
let dir: string;
let project: string;
let fixture: string;
let sessionsFile: string;

function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC|FATG_SMOKE_)/i.test(name)) env[name] = value;
  return { ...env, FATG_SMOKE_CLAUDE_SESSIONS: sessionsFile, FATG_SMOKE_CLAUDE_GAP_MS: '1', ...extra };
}

const chatArgs = (extra: readonly string[] = ['--model', 'sonnet', '--effort', 'low']): string[] => [...CHAT_FIXED_ARGS, ...extra];

function start(args: readonly string[] = chatArgs(), extra: Record<string, string> = {}): Fake {
  const child = spawn(process.execPath, [FAKE, '--fixture-dir', fixture, ...args], { cwd: project, env: environment(extra), windowsHide: true });
  open.push(child);
  const lines: Json[] = [];
  const sizes: number[] = [];
  const reads: number[] = [];
  const heads: string[] = [];
  let wake: (() => void)[] = [];
  let buffer = Buffer.alloc(0);
  let nextRequest = 0;
  let read = 0;
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errors = (errors + chunk).slice(-2000); });
  // A fake that ends while a line is written to it refuses the rest: that is the write's to say, and no failure of this process.
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk: Buffer) => {
    read += 1;
    buffer = Buffer.concat([buffer, chunk]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        lines.push(JSON.parse(line.toString('utf8')) as Json);
        sizes.push(line.length + 1);
        reads.push(read);
        heads.push(line.subarray(0, 512).toString('utf8'));
      } catch { /* not a frame */ }
    }
    for (const resolve of wake.splice(0)) resolve();
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => { for (const wakeUp of wake.splice(0)) wakeUp(); wake = []; resolve(code); }));
  const describeLine = (line: Json): string => `${String(line['type'])}${typeof line['subtype'] === 'string' ? `/${line['subtype']}` : ''}${typeof line['state'] === 'string' ? `/${line['state']}` : ''}`;
  const fake: Fake = {
    pid: child.pid ?? -1, lines, sizes, reads, heads, closed,
    setMode(mode) {
      const id = `fatg_${++nextRequest}`;
      fake.send({ type: 'control_request', request_id: id, request: { subtype: 'set_permission_mode', mode } });
      return id;
    },
    send: (value) => { child.stdin.write(`${JSON.stringify(value)}\n`); },
    initialize() {
      const id = `fatg_${++nextRequest}`;
      fake.send({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
      return fake.next((line) => line['type'] === 'control_response' && at(line, 'response', 'request_id') === id);
    },
    prompt(text, n = 1) { fake.send({ type: 'user', uuid: PROMPT_ID(n), message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }); },
    interrupt() {
      const id = `fatg_${++nextRequest}`;
      fake.send({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } });
      return id;
    },
    async next(match, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = lines.find(match);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no matching line; got ${lines.map(describeLine).join(', ')}`);
        if (child.exitCode !== null) throw new Error(`the fake exited (${String(child.exitCode)}) before a matching line; got ${lines.map(describeLine).join(', ')}: ${errors}`);
        await new Promise<void>((resolve) => { wake.push(resolve); setTimeout(resolve, 50); });
      }
    },
    async during(ms) {
      const before = lines.length;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return lines.slice(before);
    },
    end: () => { child.stdin.end(); return closed; },
    exited: () => child.exitCode !== null,
    written: (value) => new Promise<boolean>((resolve) => {
      if (child.stdin.destroyed || !child.stdin.writable) { resolve(false); return; }
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => resolve(error === null || error === undefined));
    }),
  };
  return fake;
}

/** A chat session's process, opened as fat-g opens one. */
async function session(args?: readonly string[], extra?: Record<string, string>): Promise<Fake> {
  const fake = start(args, extra);
  await fake.initialize();
  return fake;
}

const setControl = (value: Json): void => writeFileSync(path.join(fixture, 'control.json'), JSON.stringify(value));
interface SessionEntry {
  readonly cwd: string | null; readonly kept: boolean; readonly turns: string[];
  readonly interrupts: { inputOpen: boolean; turn: boolean; workers: number }[];
  readonly launches: { pid: number; args: string[]; cwd: string; config: string | null; model: string; effort: string | null; resume: string | null; addDirs: string[]; mode: string; tools: string[] }[];
  readonly efforts: unknown[];
  readonly answers: { subtype: string | null; behavior: string | null; message: string | null; error: string | null; updatedInput?: Json; updatedPermissions?: unknown }[];
  /** M22: each `set_permission_mode` received, the session rules recorded, and the paths the fake made or changed. */
  readonly modes: { mode: string | null; turn: boolean; answered: 'success' | 'error' | 'none' }[];
  readonly grants: { toolName: string; ruleContent: string }[];
  readonly writes: string[];
  /** Decision 0033: the `detail` of each context request received. */
  readonly contexts: (string | null)[];
}
const sessions = (): Record<string, SessionEntry> => { try { return (JSON.parse(readFileSync(sessionsFile, 'utf8')) as { sessions: Record<string, SessionEntry> }).sessions; } catch { return {}; } };
const onlySession = (): [string, SessionEntry] => {
  const entries = Object.entries(sessions());
  if (entries.length !== 1) throw new Error(`expected one session, found ${entries.length}`);
  return entries[0] as [string, SessionEntry];
};
const ledger = (): { pid: number; role: string }[] => { try { return readFileSync(path.join(fixture, 'pids'), 'utf8').trim().split('\n').filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), role: String(line.split(' ')[1]) })); } catch { return []; } };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const promptOf = (name: string): string => String(at(firstPrompt(name).frame, 'message', 'content')).replaceAll('<scratch>', project);
/** Every prompt a capture holds, in order: one of K2's (M22) has a turn for each. */
const promptFrames = (name: string): Captured[] => capture(name).frames.filter((entry) => entry.dir === 'send' && entry.frame['type'] === 'user');
const promptsOf = (name: string): string[] => promptFrames(name).map((entry) => String(at(entry.frame, 'message', 'content')).replaceAll('<scratch>', project));
const isType = (type: string, subtype?: string) => (line: Json): boolean => line['type'] === type && (subtype === undefined || line['subtype'] === subtype || line['state'] === subtype);
const isResult = isType('result');
/** A frame by its most telling word: a lifecycle frame's state, a system frame's subtype, else its type. */
const kindOf = (line: Json): string => (line['type'] === 'command_lifecycle' ? String(line['state']) : line['type'] === 'system' ? String(line['subtype']) : String(line['type']));
const ownAssistant = (line: Json): boolean => line['type'] === 'assistant' && line['parent_tool_use_id'] === null;
const isStream = (line: Json, event?: string): boolean => line['type'] === 'stream_event' && (event === undefined || at(line, 'event', 'type') === event);
const isTextDelta = (line: Json): boolean => isStream(line, 'content_block_delta') && at(line, 'event', 'delta', 'type') === 'text_delta';
const ownText = (line: Json): boolean => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'text';
/** A capture's received frames after its first prompt, as they compare. */
const expected = (name: string): string[] => capture(name).frames.filter((entry) => entry.dir === 'recv' && entry.index > firstPrompt(name).index).map((entry) => comparable(entry.frame, '<never>'));
const sent = (fake: Fake, from = 1): string[] => fake.lines.slice(from).map((line) => comparable(line, project));
const capturedHas = (line: Json): boolean => captured.has(comparable(line, project));
const readControlFile = (): Json => JSON.parse(readFileSync(path.join(fixture, 'control.json'), 'utf8')) as Json;

beforeEach(() => {
  // The real path: the fake names its folder as its own process reports it.
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fatg-claude-replay-')));
  project = path.join(dir, 'project');
  fixture = path.join(dir, 'fixture');
  mkdirSync(project);
  mkdirSync(fixture);
  sessionsFile = path.join(dir, 'chat-sessions.json');
  setControl({});
});
afterEach(async () => {
  for (const child of open.splice(0)) { if (child.exitCode === null) child.kill('SIGKILL'); }
  for (const { pid } of ledger()) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  await removeFolder(dir);
});

describe('the arguments a chat session starts for (C51)', () => {
  it('are the fixed list, then a model, an optional effort, an optional resume and any number of other folders', () => {
    // M22: the launch's mode and its tools are told with them. The fixed list as it was is the reading launch's.
    const reading = { mode: 'default', tools: ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion'] };
    expect(parseChatArgs([...CHAT_FIXED_ARGS, '--model', 'opus[1m]'])).toEqual({ model: 'opus[1m]', effort: null, resume: null, addDirs: [], ...reading });
    expect(parseChatArgs([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'high', '--resume', 'abc', '--add-dir', 'D:\\one', '--add-dir', '/two'])).toEqual({ model: 'sonnet', effort: 'high', resume: 'abc', addDirs: ['D:\\one', '/two'], ...reading });
    expect(parseChatArgs([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--add-dir', 'x'])).toEqual({ model: 'sonnet', effort: null, resume: null, addDirs: ['x'], ...reading });
    const refused: string[][] = [
      [...CHAT_FIXED_ARGS],
      [...CHAT_FIXED_ARGS, '--effort', 'low', '--model', 'sonnet'],
      [...CHAT_FIXED_ARGS, '--model', 'sonnet', '--resume', 'abc', '--effort', 'low'],
      [...CHAT_FIXED_ARGS, '--model', 'sonnet', '--add-dir', 'x', '--resume', 'abc'],
      [...CHAT_FIXED_ARGS, '--model'],
      [...CHAT_FIXED_ARGS.slice(0, -1), '--model', 'sonnet'],
      [...CHAT_FIXED_ARGS.slice(1), '--model', 'sonnet'],
      ['--model', 'sonnet', ...CHAT_FIXED_ARGS],
      // M21 (C16, C50): five tools, the fifth the one that asks the user; a sixth, or the four of the launch before it, is another launch.
      CHAT_FIXED_ARGS.map((arg) => (arg === 'Read,Glob,Grep,Agent,AskUserQuestion' ? 'Read,Glob,Grep,Agent,AskUserQuestion,Write' : arg)).concat('--model', 'sonnet'),
      CHAT_FIXED_ARGS.map((arg) => (arg === 'Read,Glob,Grep,Agent,AskUserQuestion' ? 'Read,Glob,Grep,Agent' : arg)).concat('--model', 'sonnet'),
      CHAT_FIXED_ARGS.map((arg) => (arg === 'default' ? 'acceptEdits' : arg)).concat('--model', 'sonnet'),
    ];
    expect(CHAT_FIXED_ARGS[CHAT_FIXED_ARGS.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Agent,AskUserQuestion');
    // M19 (C55): the launch asks for partial messages, and the fake starts for that launch alone.
    expect(CHAT_FIXED_ARGS.at(-1)).toBe('--include-partial-messages');
    refused.push(CHAT_FIXED_ARGS.filter((arg) => arg !== '--include-partial-messages').concat('--model', 'sonnet'));
    // M20b (C54, C61): the launch that turned the CLI's commands off is no longer the app's, wherever the flag stands.
    expect(CHAT_FIXED_ARGS).not.toContain('--disable-slash-commands');
    refused.push([...CHAT_FIXED_ARGS.slice(0, -1), '--disable-slash-commands', '--include-partial-messages', '--model', 'sonnet']);
    for (const flag of ['--disable-slash-commands', '--no-session-persistence', '--include-partial-messages', '--fork-session', '--strict-mcp-config', '--replay-user-messages', '--include-hook-events', '--dangerously-skip-permissions', '--print']) refused.push([...CHAT_FIXED_ARGS, '--model', 'sonnet', flag]);
    for (const [flag, value] of [['--session-id', 'abc'], ['--name', 'a session'], ['--fallback-model', 'haiku'], ['--settings', '{}'], ['--mcp-config', 'x.json'], ['--allowedTools', 'Write']] as const) refused.push([...CHAT_FIXED_ARGS, '--model', 'sonnet', flag, value]);
    for (const args of refused) expect(parseChatArgs(args), args.slice(CHAT_FIXED_ARGS.length - 1).join(' ')).toBeNull();
  });

  it('are those under one of five launches, a mode’s word and a tool list at the two places the fixed list held them (M22)', () => {
    expect(READING_TOOLS).toBe('Read,Glob,Grep,Agent,AskUserQuestion');
    // The three that act, the two of the web, and the plan's tool since M22b (C8).
    expect(EXECUTION_TOOLS).toBe('Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,WebFetch,WebSearch,ExitPlanMode');
    expect(CHAT_LAUNCHES.map((launch) => [launch.mode, launch.tools])).toEqual([
      ['default', READING_TOOLS], ['default', EXECUTION_TOOLS], ['acceptEdits', EXECUTION_TOOLS], ['auto', EXECUTION_TOOLS], ['bypassPermissions', EXECUTION_TOOLS],
    ]);
    // The list with no argument is the reading launch's, and the one there always was; each is frozen.
    expect([...chatFixedArgs()]).toEqual([...CHAT_FIXED_ARGS]);
    expect(Object.isFrozen(CHAT_FIXED_ARGS) && Object.isFrozen(chatFixedArgs('auto', EXECUTION_TOOLS)) && Object.isFrozen(CHAT_LAUNCHES) && CHAT_LAUNCHES.every((launch) => Object.isFrozen(launch))).toBe(true);
    const modeAt = CHAT_FIXED_ARGS.indexOf('--permission-mode') + 1;
    const toolsAt = CHAT_FIXED_ARGS.indexOf('--tools') + 1;
    for (const { mode, tools } of CHAT_LAUNCHES) {
      const fixed = chatFixedArgs(mode, tools);
      // Nothing of the list changes but the two values.
      expect(fixed.map((arg, index) => (index === modeAt || index === toolsAt ? null : arg)), mode).toEqual(CHAT_FIXED_ARGS.map((arg, index) => (index === modeAt || index === toolsAt ? null : arg)));
      expect([fixed[modeAt - 1], fixed[modeAt], fixed[toolsAt - 1], fixed[toolsAt]], mode).toEqual(['--permission-mode', mode, '--tools', tools]);
      expect(parseChatArgs([...fixed, '--model', 'sonnet']), mode).toEqual({ model: 'sonnet', effort: null, resume: null, addDirs: [], mode, tools: tools.split(',') });
      expect(parseChatArgs([...fixed, '--model', 'opus', '--effort', 'high', '--resume', 'abc', '--add-dir', 'x']), mode).toEqual({ model: 'opus', effort: 'high', resume: 'abc', addDirs: ['x'], mode, tools: tools.split(',') });
      // The per-session arguments are held under each launch as they were under the one.
      expect(parseChatArgs([...fixed]), mode).toBeNull();
      expect(parseChatArgs([...fixed, '--effort', 'low', '--model', 'sonnet']), mode).toBeNull();
      expect(parseChatArgs([...fixed, '--model', 'sonnet', '--dangerously-skip-permissions']), mode).toBeNull();
      expect(parseChatArgs([...fixed.slice(0, -1), '--model', 'sonnet']), mode).toBeNull();
    }
    // Any other pair is no launch: a mode that asks nothing with the reading tools, a word fat-g has no mode for, a
    // word in another case, a twelfth tool, the list before the web's two, the eight in another order, seven of them, and no word or no list at all.
    const others: (readonly [string, string])[] = [
      ['acceptEdits', READING_TOOLS], ['auto', READING_TOOLS], ['bypassPermissions', READING_TOOLS],
      ['dontAsk', EXECUTION_TOOLS], ['plan', EXECUTION_TOOLS], ['plan', READING_TOOLS], ['Default', EXECUTION_TOOLS], ['default ', EXECUTION_TOOLS], ['', EXECUTION_TOOLS],
      ['default', `${EXECUTION_TOOLS},NotebookEdit`], ['bypassPermissions', `${EXECUTION_TOOLS},NotebookEdit`], ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,ExitPlanMode'],
      ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,WebSearch,WebFetch,ExitPlanMode'], ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Edit,Write'],
      ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write'], ['acceptEdits', `${READING_TOOLS},Bash`], ['default', ''], ['default', 'Bash,Write,Edit'],
    ];
    for (const [mode, tools] of others) expect(parseChatArgs([...chatFixedArgs(mode, tools), '--model', 'sonnet']), `${mode} ${tools}`).toBeNull();
    // And neither value may be told twice, or elsewhere.
    expect(parseChatArgs([...chatFixedArgs('default', EXECUTION_TOOLS), '--model', 'sonnet', '--permission-mode', 'bypassPermissions'])).toBeNull();
    expect(parseChatArgs([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--tools', EXECUTION_TOOLS])).toBeNull();
  });

  it('exits 64 and says so for any other stream-json launch, as before, and a prompt on the command line is one', async () => {
    const others = [
      [...CHAT_FIXED_ARGS], chatArgs(['--model', 'sonnet', '--no-session-persistence']), chatArgs(['--model', 'sonnet', 'Say hello.']),
      // M22: a pair that is none of the five, and one of the five with a flag more.
      [...chatFixedArgs('acceptEdits', READING_TOOLS), '--model', 'sonnet'], [...chatFixedArgs('dontAsk', EXECUTION_TOOLS), '--model', 'sonnet'],
      [...chatFixedArgs('default', `${EXECUTION_TOOLS},NotebookEdit`), '--model', 'sonnet'], [...chatFixedArgs('bypassPermissions', EXECUTION_TOOLS), '--model', 'sonnet', '--dangerously-skip-permissions'],
    ];
    for (const args of others) {
      const fake = start(args);
      expect(await fake.closed, args.join(' ')).toBe(64);
      expect(fake.lines).toEqual([]);
      expect(existsSync(path.join(fixture, 'unexpected-args'))).toBe(true);
    }
    // Nothing of a chat session was begun for them.
    expect(sessions()).toEqual({});
    expect(ledger().filter((entry) => entry.role === 'chat')).toEqual([]);
  });
});

describe('what a chat session of the fake sends (C51, C79)', () => {
  it('names only captures whose prompt carries an id as turns, T1 among them', () => {
    expect([...STREAM_CAPTURES]).toEqual(['m19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt', 'm19-t5-error', 'm19-command-refused', 'm19-markdown', 'm19-cut-cut', 'm19-cut-resumed', 'm19b-line', 'm19b-readme', 'm19b-space']);
    expect([...WHOLE_CAPTURES]).toEqual(['m16-chat-early-interrupt', 'm16-self-turn', 'm16-chat-request']);
    // M20b (C61): K1's two turns — the one a session is given something to hold by, and the long one a
    // side question is asked during — and K2's seven commands, each a turn the CLI answers.
    expect([...ASIDE_TURN_CAPTURES]).toEqual(['m20b-seed', 'm20b-during']);
    expect([...COMMAND_CAPTURES]).toEqual(['m20b-cmd-exit', 'm20b-cmd-quit', 'm20b-cmd-resume', 'm20b-cmd-login', 'm20b-cmd-logout', 'm20b-cmd-btw', 'm20b-cmd-compact']);
    // M21 (C50): K1's five that are turns — a question answered from an option, one that takes several, two in
    // one request, the worker told to ask, and the prompt that resumed a session whose process was killed.
    expect([...QUESTION_CAPTURES]).toEqual(['m21-question-one', 'm21-question-multi', 'm21-question-two', 'm21-question-worker', 'm21-question-killed-resumed']);
    // M22 (C35): K2's six that are turns; `it('names K2’s six…')` below holds their turns and the one left out.
    expect([...APPROVAL_CAPTURES]).toEqual(['m22-approve-once', 'm22-approve-session', 'm22-approve-files', 'm22-approve-worker', 'm22-mode-accept-edits', 'm22-inherited']);
    // M22, round 3: K5's three that are turns, under the modes that ask nothing; `it('names K5’s three…')` below holds them and the two resumes left out.
    expect([...MODE_CAPTURES]).toEqual(['m22-mode-auto', 'm22-mode-bypass-main', 'm22-mode-worker']);
    // M100b (C31): K1's one, a question the user skipped.
    expect([...DECLINE_CAPTURES]).toEqual(['m100b-question-decline']);
    // M23 (C23, C42, C43): K2's four that are turns — an image, a frame during a turn of text alone, one during tool calls, and the held frame a Stop drops. The image at the bound shares the first's prompt.
    expect([...M23_CAPTURES]).toEqual(['m23-claude-image', 'm23-claude-steer-text', 'm23-claude-steer-tool', 'm23-claude-stop-held']);
    expect([...TURN_CAPTURES]).toEqual([...STREAM_CAPTURES, ...WHOLE_CAPTURES, ...ASIDE_TURN_CAPTURES, ...COMMAND_CAPTURES, ...QUESTION_CAPTURES, ...APPROVAL_CAPTURES, ...MODE_CAPTURES, ...DECLINE_CAPTURES, ...M23_CAPTURES]);
    // K5's two resumes hold no prompt, and are no turn a prompt could choose.
    for (const name of Object.values(BYPASS_RESUMED)) expect(TURN_CAPTURES, name).not.toContain(name);
    // K2's captures were taken under the launch a chat session has, and hold a reply's stream events; K20's hold none.
    for (const name of STREAM_CAPTURES) expect((capture(name) as unknown as { launch: { args: string[] } }).launch.args, name).toContain('--include-partial-messages');
    for (const name of WHOLE_CAPTURES) expect(capture(name).frames.some((entry) => entry.frame['type'] === 'stream_event'), name).toBe(false);
    // The five whose prompts are M16's own are replayed in K20's place: one prompt, one capture.
    for (const [streamed, whole] of [['m19-t1-basic', 'm16-t1-basic'], ['m19-t3-subagent', 'm16-t3-subagent'], ['m19-t4-interrupt', 'm16-t4-interrupt'], ['m19-t5-error', 'm16-t5-error'], ['m19-command-refused', 'm16-command-refused']] as const) {
      expect(promptOf(streamed), streamed).toBe(promptOf(whole));
      expect(TURN_CAPTURES).not.toContain(whole);
    }
    expect(new Set(TURN_CAPTURES.map((name) => promptOf(name))).size).toBe(TURN_CAPTURES.length);
    // M22: one of K2's captures with several prompts has a turn a prompt, so every prompt that chooses a turn is
    // counted, K2's later ones with the first of each capture: 37 captures, 40 turns, 40 prompts, K5's three among them.
    const choosing = TURN_CAPTURES.flatMap((name) => (APPROVAL_CAPTURES.includes(name) ? promptsOf(name) : [promptOf(name)]));
    expect(choosing).toHaveLength(TURN_CAPTURES.length + 3);
    expect(new Set(choosing).size).toBe(choosing.length);
    // The third exclusion (M22, C21): K2's resumed session was asked with the second prompt of the session that
    // was granted its command, so it is no turn a prompt alone could choose: which of the two is replayed goes by
    // whether the process holds that rule.
    expect(APPROVAL_RESUMED).toBe('m22-approve-resumed');
    expect(promptsOf(APPROVAL_RESUMED)).toEqual([promptsOf('m22-approve-session')[1]]);
    expect(TURN_CAPTURES).not.toContain(APPROVAL_RESUMED);
    expect(choosing.filter((prompt) => prompt === promptOf(APPROVAL_RESUMED))).toHaveLength(1);
    // The two exclusions (M21, C50): K1's Stop and K1's kill were taken with the prompt of the question
    // that was answered, so neither is a turn a prompt could choose. The first is the tail of an
    // interrupt that comes while a question waits, and the second what `exitWhileAsking` replays.
    expect([QUESTION_STOP, QUESTION_KILLED]).toEqual(['m21-question-stop', 'm21-question-killed-first']);
    for (const shared of [QUESTION_STOP, QUESTION_KILLED]) {
      expect(promptOf(shared), shared).toBe(promptOf('m21-question-one'));
      expect(typeof promptAlias(shared), shared).toBe('string');
      expect(TURN_CAPTURES, shared).not.toContain(shared);
    }
    // And they are the only M21 captures left out: the seven are these five and those two.
    expect([...atStart.keys()].filter((name) => name.startsWith('m21-question-')).map((name) => name.replace(/\.json$/, '')).sort()).toEqual([...QUESTION_CAPTURES, QUESTION_STOP, QUESTION_KILLED].sort());
    for (const name of TURN_CAPTURES) expect(typeof promptAlias(name), name).toBe('string');
    // M10's T7, and the M16 captures taken before prompts carried one, are no turn.
    for (const name of ['t7-declined', 'm16-resume', 'm16-outside-asked', 'm16-worker-interrupt', 'm16-stop-hook']) {
      expect(promptAlias(name), name).toBeUndefined();
      expect(TURN_CAPTURES).not.toContain(name);
    }
  });

  it('answers `initialize` with the captured reply, and a new session’s process with nothing before it', async () => {
    const fake = start();
    expect(await fake.during(150)).toEqual([]);
    const reply = await fake.initialize();
    expect(captured.has(comparable(reply, project))).toBe(true);
    expect(at(reply, 'response', 'response', 'current_permission_mode')).toBe('default');
    expect(await fake.end()).toBe(0);
  });

  for (const name of ['m19-t1-basic', 'm19-t3-subagent', 'm19-t5-error', 'm19-command-refused', 'm19-markdown', 'm19-cut-resumed']) {
    it(`replays ${name} for its own prompt: the capture’s frames after the prompt, in their order, but for ids, times and the folder`, async () => {
      const fake = await session();
      fake.prompt(promptOf(name));
      await fake.next(isType('command_lifecycle', name === 'm19-t5-error' ? 'cancelled' : 'completed'));
      await fake.during(60);
      expect(sent(fake)).toEqual(expected(name));
      for (const line of fake.lines) expect(captured.has(comparable(line, project)), String(line['type'])).toBe(true);
      // The ids are fat-g's and this process's: the prompt's own on its lifecycle frames, one session id throughout.
      const [id, entry] = onlySession();
      expect(fake.lines.filter(isType('command_lifecycle')).map((line) => line['command_uuid'])).toEqual(fake.lines.filter(isType('command_lifecycle')).map(() => PROMPT_ID(1)));
      expect(new Set(fake.lines.slice(1).map((line) => line['session_id']))).toEqual(new Set([id]));
      expect(at(fake.lines.find(isType('system', 'init')), 'cwd')).toBe(project);
      expect(entry).toMatchObject({ kept: true, turns: [name], cwd: project });
      expect(await fake.end()).toBe(0);
    });
  }

  it('replays T1 for any other prompt, and the next prompt in the same process is another turn of the same session', async () => {
    const fake = await session();
    fake.prompt('Something no capture holds.', 1);
    await fake.next(isType('command_lifecycle', 'completed'));
    fake.prompt(promptOf('m19-command-refused'), 2);
    await fake.next((line) => isType('command_lifecycle', 'completed')(line) && line['command_uuid'] === PROMPT_ID(2));
    expect(sent(fake)).toEqual([...expected('m19-t1-basic'), ...expected('m19-command-refused').slice(0, -1)]);
    expect(onlySession()[1].turns).toEqual(['m19-t1-basic', 'm19-command-refused']);
    expect(fake.lines.filter(isType('system', 'init')).map((line) => line['session_id'])).toEqual([onlySession()[0], onlySession()[0]]);
  });

  it('replays no turn for a prompt that carries no id, and says so', async () => {
    const fake = await session();
    fake.send({ type: 'user', message: { role: 'user', content: promptOf('m19-t1-basic') }, parent_tool_use_id: null, session_id: '' });
    expect(await fake.during(200)).toEqual([]);
    expect(existsSync(path.join(fixture, 'prompt-without-id'))).toBe(true);
    expect(onlySession()[1]).toMatchObject({ kept: false, turns: [] });
  });

  it('says so when it is sent a request a chat session never sends', async () => {
    // M22 (C74): `set_permission_mode` is one a chat session sends from here on, and is no longer among them.
    const fake = await session();
    for (const subtype of ['set_model', 'get_settings', 'get_usage', 'mcp_message', 'list_permission_rules']) fake.send({ type: 'control_request', request_id: `x-${subtype}`, request: { subtype } });
    expect(await fake.during(200)).toEqual([]);
    expect(existsSync(path.join(fixture, 'unexpected-chat-request'))).toBe(true);
  });

  it('records itself under a role of its own, takes no account’s lock and notes no prompt: those stay a usage session’s', async () => {
    const fake = await session();
    const other = await session();
    fake.prompt(promptOf('m19-t1-basic'));
    other.prompt(promptOf('m19-t1-basic'));
    await Promise.all([fake.next(isResult), other.next(isResult)]);
    expect(ledger().map((entry) => entry.role)).toEqual(['chat', 'chat']);
    expect(ledger().map((entry) => entry.pid).sort()).toEqual([fake.pid, other.pid].sort());
    for (const name of ['prompts', 'overlaps', 'session.lock', 'sdk-markers', 'unexpected-args']) expect(existsSync(path.join(fixture, name)), name).toBe(false);
    const environmentFile = JSON.parse(readFileSync(path.join(fixture, `env-chat-${fake.pid}.json`), 'utf8')) as { names: string[] };
    expect(Array.isArray(environmentFile.names)).toBe(true);
  });
});

describe('where the capture shows fat-g sending, the fake waits (C79)', () => {
  it('waits for T4’s interrupt, then ends the turn as the capture does', async () => {
    const fake = await session();
    fake.prompt(promptOf('m19-t4-interrupt'));
    // K2's interrupt came while a text was being written: after its first delta.
    await fake.next(isTextDelta);
    expect(await fake.during(200)).toEqual([]);
    const id = fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    expect(sent(fake)).toEqual(expected('m19-t4-interrupt'));
    // The reply is to fat-g's own request.
    expect(at(fake.lines.find((line) => line['type'] === 'control_response' && at(line, 'response', 'request_id') === id), 'response', 'subtype')).toBe('success');
    expect(at(fake.lines.find(isResult), 'is_error')).toBe(true);
    expect(onlySession()[1].interrupts).toEqual([{ inputOpen: true, turn: true, workers: 0 }]);
  });

  it('waits for K22’s interrupt before it sends anything of the turn: a Stop before `init`', async () => {
    const fake = await session();
    fake.prompt(promptOf('m16-chat-early-interrupt'));
    expect(await fake.during(200)).toEqual([]);
    fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    await fake.during(60);
    expect(sent(fake)).toEqual(expected('m16-chat-early-interrupt'));
    // `queued` and `started` before the reply and the `init`; no frame from a model.
    expect(fake.lines.slice(1, 5).map(kindOf)).toEqual(['queued', 'started', 'control_response', 'init']);
    expect(fake.lines.some((line) => line['type'] === 'assistant')).toBe(false);
  });

  it('takes an interrupt that came before the replay reached it', async () => {
    const fake = await session();
    fake.prompt(promptOf('m19-t4-interrupt'));
    fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    expect(sent(fake)).toEqual(expected('m19-t4-interrupt'));
  });

  it('waits for the answer to K23’s request, notes it, and goes on to the turn’s completed end', async () => {
    const fake = await session();
    fake.prompt(promptOf('m16-chat-request'));
    const request = await fake.next(isType('control_request'));
    expect(at(request, 'request', 'subtype')).toBe('can_use_tool');
    expect(await fake.during(200)).toEqual([]);
    fake.send({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response: { behavior: 'deny', message: 'This action is not available in this session.' } } });
    await fake.next(isType('command_lifecycle', 'completed'));
    expect(sent(fake)).toEqual(expected('m16-chat-request'));
    expect(onlySession()[1].answers).toEqual([{ subtype: 'success', behavior: 'deny', message: 'This action is not available in this session.', error: null }]);
    expect(at(fake.lines.find(isResult), 'is_error')).toBe(false);
  });

  it('waits for K17’s second prompt, runs it as its own turn, and then plays the turn the CLI starts by itself', async () => {
    const fake = await session();
    fake.prompt(promptOf('m16-self-turn'), 1);
    await fake.next(isResult);
    expect(await fake.during(200)).toEqual([]);
    fake.prompt('Reply with the single word ok. Use no tools.', 2);
    await fake.next((line) => isType('system', 'task_notification')(line));
    await fake.next((line) => isResult(line) && fake.lines.filter(isResult).length === 3);
    await fake.during(60);
    expect(sent(fake)).toEqual(expected('m16-self-turn'));
    // Each prompt's lifecycle frames name its own id; the last `init` follows no `started`.
    const lifecycle = fake.lines.filter(isType('command_lifecycle')).map((line) => `${String(line['command_uuid'])} ${String(line['state'])}`);
    expect(lifecycle).toEqual([`${PROMPT_ID(1)} queued`, `${PROMPT_ID(1)} started`, `${PROMPT_ID(1)} completed`, `${PROMPT_ID(2)} queued`, `${PROMPT_ID(2)} started`, `${PROMPT_ID(2)} completed`]);
    expect(fake.lines.filter(isType('system', 'init'))).toHaveLength(3);
    expect(onlySession()[1].turns).toEqual(['m16-self-turn']);
  });
});

describe('an interrupt during a turn whose capture shows none (C79)', () => {
  const tail = (name: string, from: (frame: Json) => boolean): string[] => {
    const frames = capture(name).frames.filter((entry) => entry.dir === 'recv');
    return frames.slice(frames.findIndex((entry) => from(entry.frame))).map((entry) => comparable(entry.frame, '<never>'));
  };
  const isReplyTo = (requestId: string) => (frame: Json): boolean => frame['type'] === 'control_response' && at(frame, 'response', 'request_id') === requestId;

  it('is answered with T4’s frames from its reply on', async () => {
    const fake = await session();
    setControl({ holdResult: 5000 });
    fake.prompt(promptOf('m19-t1-basic'));
    await fake.next(ownText);
    // The reply's own end follows its frame; the `result` after it is held.
    await fake.next((line) => isStream(line, 'message_stop') && fake.lines.filter((entry) => isStream(entry, 'message_stop')).length === 2);
    const before = fake.lines.length;
    fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    expect(sent(fake, before)).toEqual(tail('m16-t4-interrupt', isReplyTo('m10-2')));
    // The turn's own `result` never comes: the interrupted end is its end.
    expect(fake.lines.filter(isResult)).toHaveLength(1);
    expect(at(fake.lines.find(isResult), 'is_error')).toBe(true);
    expect(fake.lines.at(-1)).toMatchObject({ type: 'command_lifecycle', state: 'cancelled', command_uuid: PROMPT_ID(1) });
  });

  it('closes an open worker first, by K11’s two frames, under the worker’s own id', async () => {
    // The replay's gaps are the capture's own up to 300 ms, and not the 1 ms of the other tests: the worker's
    // closing frames come two seconds after its progress in the capture, so the interrupt, sent on seeing
    // that progress, reaches the fake long before the replay would send them itself.
    const fake = await session(undefined, { FATG_SMOKE_CLAUDE_GAP_MS: '300' });
    setControl({ workerNoClose: true, holdResult: 5000 });
    fake.prompt(promptOf('m19-t3-subagent'));
    const started = await fake.next(isType('system', 'task_started'), 20_000);
    await fake.next(isType('system', 'task_progress'), 20_000);
    setControl({});
    const id = fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    // From the interrupt's own reply on: a frame of the worker's that was on its way when the interrupt
    // was written comes before that reply, and is the capture's own.
    const after = fake.lines.slice(fake.lines.findIndex(isReplyTo(id)));
    expect(after.map(kindOf)).toEqual(['control_response', 'task_updated', 'task_notification', 'user', 'user', 'result', 'cancelled']);
    expect(after.slice(1, 3).map((line) => comparable(line, project))).toEqual(capture('m16-worker-interrupt').frames.filter((entry) => ['task_updated', 'task_notification'].includes(String(entry.frame['subtype']))).map((entry) => comparable(entry.frame, '<never>')));
    expect(after.slice(1, 3).map((line) => line['task_id'])).toEqual([started['task_id'], started['task_id']]);
    expect([at(after[1], 'patch', 'status'), after[2]?.['status']]).toEqual(['killed', 'stopped']);
    expect(onlySession()[1].interrupts).toEqual([{ inputOpen: true, turn: true, workers: 1 }]);
  });

  it('is answered with K22’s frames when the turn’s `init` has not gone out, without a frame sent twice', async () => {
    const fake = await session(undefined, { FATG_SMOKE_CLAUDE_GAP_MS: '400' });
    fake.prompt(promptOf('m19-t1-basic'));
    await fake.next(isType('command_lifecycle', 'queued'));
    fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    const kinds = fake.lines.slice(1).map(kindOf);
    expect(kinds.filter((kind) => kind === 'queued')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'started')).toHaveLength(1);
    expect(kinds.slice(-4)).toEqual(['init', 'user', 'result', 'cancelled']);
    expect(fake.lines.some((line) => line['type'] === 'assistant')).toBe(false);
    for (const line of fake.lines) expect(captured.has(comparable(line, project)), String(line['type'])).toBe(true);
  });

  it('answers one with no turn to interrupt, and sends nothing after the reply', async () => {
    const fake = await session();
    const id = fake.interrupt();
    const reply = await fake.next(isReplyTo(id));
    expect(captured.has(comparable(reply, project))).toBe(true);
    expect(await fake.during(150)).toEqual([]);
  });
});

describe('sessions kept between processes (C53)', () => {
  it('a second process resumes what the first began: K2’s reply, and an `init` that names the id it was resumed by', async () => {
    const first = await session();
    first.prompt(promptOf('m19-t1-basic'));
    await first.next(isType('command_lifecycle', 'completed'));
    const [id] = onlySession();
    expect(await first.end()).toBe(0);

    const again = start(chatArgs(['--model', 'sonnet', '--effort', 'low', '--resume', id, '--add-dir', path.join(dir, 'second')]));
    const reply = await again.initialize();
    const resumeReply = capture('m16-resume').frames.find((entry) => entry.index === 1) as Captured;
    expect(comparable(reply, project)).toBe(comparable(resumeReply.frame, '<never>'));
    // It sends nothing of the earlier conversation.
    expect(await again.during(150)).toEqual([]);
    again.prompt(promptOf('m19-t1-basic'), 2);
    await again.next(isType('command_lifecycle', 'completed'));
    expect(at(again.lines.find(isType('system', 'init')), 'session_id')).toBe(id);
    const [, entry] = onlySession();
    expect(entry.turns).toEqual(['m19-t1-basic', 'm19-t1-basic']);
    expect(entry.launches.map((launch) => [launch.pid, launch.resume, launch.cwd, launch.model, launch.effort, launch.addDirs])).toEqual([
      [first.pid, null, project, 'sonnet', 'low', []],
      [again.pid, id, project, 'sonnet', 'low', [path.join(dir, 'second')]],
    ]);
    expect(entry.launches[1]?.args).toEqual(chatArgs(['--model', 'sonnet', '--effort', 'low', '--resume', id, '--add-dir', path.join(dir, 'second')]));
  });

  it('gives a resume of an id it does not hold K3’s frame, before any reply, and exits with code 1', async () => {
    const unknown = '11111111-1111-4111-8111-111111111111';
    const fake = start(chatArgs(['--model', 'sonnet', '--resume', unknown]));
    fake.send({ type: 'control_request', request_id: 'fatg_1', request: { subtype: 'initialize' } });
    expect(await fake.closed).toBe(1);
    expect(fake.lines).toHaveLength(1);
    const missing = capture('m16-resume-failures-missing').frames.find((entry) => entry.dir === 'recv') as Captured;
    expect(comparable(fake.lines[0] as Json, project)).toBe(comparable(missing.frame, '<never>'));
    expect(fake.lines[0]).toMatchObject({ type: 'result', is_error: true, num_turns: 0, session_id: unknown });
    expect(sessions()).toEqual({});
  });

  it('keeps no session that was given no prompt, as the CLI keeps none', async () => {
    const first = await session();
    const [id, entry] = onlySession();
    expect(entry.kept).toBe(false);
    await first.end();
    const again = start(chatArgs(['--model', 'sonnet', '--resume', id]));
    expect(await again.closed).toBe(1);
    expect(again.lines.map((line) => line['type'])).toEqual(['result']);
  });

  it('notes the configuration folder a session’s process was given, as a value', async () => {
    const config = path.join(dir, 'account-two');
    const fake = await session(undefined, { CLAUDE_CONFIG_DIR: config });
    expect(onlySession()[1].launches).toMatchObject([{ pid: fake.pid, config }]);
    // The folder is a key and nothing more: the fake made nothing in it.
    expect(existsSync(config)).toBe(false);
  });
});

describe('the controls: a captured frame with one named change (C80)', () => {
  /** Runs one T-capture's turn to a frame, and answers that frame with the capture's own. */
  const turnTo = async (name: string, until: (line: Json) => boolean, control: Json): Promise<{ fake: Fake; line: Json }> => {
    setControl(control);
    const fake = await session();
    fake.prompt(promptOf(name));
    return { fake, line: await fake.next(until) };
  };
  const original = (name: string, match: (frame: Json) => boolean): Json => masked((capture(name).frames.find((entry) => entry.dir === 'recv' && match(entry.frame)) as Captured).frame, '<never>');

  it('exitDuringLaunch, launchFails: the process ends before it answers', async () => {
    setControl({ exitDuringLaunch: 1 });
    const first = start();
    first.send({ type: 'control_request', request_id: 'fatg_1', request: { subtype: 'initialize' } });
    expect(await first.closed).toBe(3);
    expect(first.lines).toEqual([]);
    // Taken once: the next launch answers.
    const second = await session();
    await second.end();

    setControl({ launchFails: 1 });
    const third = start();
    expect(await third.closed).toBe(1);
    expect(third.lines).toEqual([]);
  });

  it('resumeMissing: K3’s frame and exit, for a session it holds', async () => {
    const first = await session();
    first.prompt(promptOf('m19-t1-basic'));
    await first.next(isResult);
    const [id] = onlySession();
    await first.end();
    setControl({ resumeMissing: 1 });
    const again = start(chatArgs(['--model', 'sonnet', '--resume', id]));
    expect(await again.closed).toBe(1);
    expect(again.lines).toMatchObject([{ type: 'result', is_error: true, num_turns: 0, session_id: id }]);
    // The session is still held: the next resume opens.
    const third = start(chatArgs(['--model', 'sonnet', '--resume', id]));
    await third.initialize();
  });

  it('exitDuringTurn, exitWithWorker, exitAfterTurnWithWorker: the process ends there', async () => {
    const during = await turnTo('m19-t1-basic', ownAssistant, { exitDuringTurn: 1 });
    expect(await during.fake.closed).toBe(3);
    expect(during.fake.lines.some(isResult)).toBe(false);

    const withWorker = await turnTo('m19-t3-subagent', isType('system', 'task_started'), { exitWithWorker: 1 });
    expect(await withWorker.fake.closed).toBe(3);
    expect(withWorker.fake.lines.some(isType('system', 'task_notification'))).toBe(false);
    expect(withWorker.fake.lines.some(isResult)).toBe(false);

    const outlives = await turnTo('m16-self-turn', isResult, { exitAfterTurnWithWorker: 1 });
    expect(await outlives.fake.closed).toBe(3);
    // The turn ended, and its worker had not.
    expect(outlives.fake.lines.some(isType('system', 'task_started'))).toBe(true);
    expect(outlives.fake.lines.some(isType('system', 'task_notification'))).toBe(false);
    // A turn whose worker ended with it is not that case: T3 goes on to its closing frame.
    const ordinary = await turnTo('m19-t3-subagent', isType('command_lifecycle', 'completed'), { exitAfterTurnWithWorker: 1 });
    expect(ordinary.fake.exited()).toBe(false);
  });

  it('otherMode: the reply, or the `init`, names another permission mode, and nothing else changes', async () => {
    // M22: the mode a report names is its launch's, and compares as one (`masked`): the fault is in the word
    // itself, and nothing else of the frame differs from its capture's.
    setControl({ otherMode: 'reply' });
    const first = start();
    const reply = await first.initialize();
    expect(differences(masked(reply, project), original('m16-t1-basic', (frame) => frame['type'] === 'control_response'))).toEqual([]);
    expect(at(reply, 'response', 'response', 'current_permission_mode')).toBe('acceptEdits');

    const { line } = await turnTo('m19-t1-basic', isType('system', 'init'), { otherMode: 'init' });
    expect(differences(masked(line, project), original('m19-t1-basic', isType('system', 'init')))).toEqual([]);
    expect(line['permissionMode']).toBe('acceptEdits');
    // Under a launch whose own word is that one, the other is `default`: a report never names its own by a fault.
    const edits = [...chatFixedArgs('acceptEdits', EXECUTION_TOOLS), '--model', 'sonnet'];
    setControl({ otherMode: 'reply' });
    expect(at(await start(edits).initialize(), 'response', 'response', 'current_permission_mode')).toBe('default');
    setControl({ otherMode: 'init' });
    const under = await session(edits);
    under.prompt(promptOf('m19-t1-basic'));
    expect((await under.next(isType('system', 'init')))['permissionMode']).toBe('default');
  });

  it('otherTool: the `init` offers one tool more', async () => {
    const { line } = await turnTo('m19-t1-basic', isType('system', 'init'), { otherTool: true });
    expect(differences(masked(line, project), original('m19-t1-basic', isType('system', 'init')))).toEqual(['tools']);
    const tools = line['tools'] as string[];
    // M22: the launch's own five, as an `init` names them, and one outside them, after the configured ones.
    expect(tools.filter((tool) => !tool.startsWith('mcp__'))).toEqual(['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read', 'Write']);
    expect(tools.at(-1)).toBe('Write');
    // Under a launch that has `Write`, the tool outside it is another.
    setControl({ otherTool: true });
    const acting = await session([...chatFixedArgs('default', EXECUTION_TOOLS), '--model', 'sonnet']);
    acting.prompt(promptOf('m19-t1-basic'));
    const offered = (await acting.next(isType('system', 'init')))['tools'] as string[];
    expect(offered.filter((tool) => !tool.startsWith('mcp__'))).toEqual(['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write', 'NotebookEdit']);
  });

  it('hang: the named step never answers, and the others do', async () => {
    setControl({ hang: 'initialize' });
    const launch = start();
    launch.send({ type: 'control_request', request_id: 'fatg_1', request: { subtype: 'initialize' } });
    expect(await launch.during(250)).toEqual([]);
    expect(launch.exited()).toBe(false);

    setControl({ hang: 'effort' });
    const effort = await session();
    effort.send({ type: 'control_request', request_id: 'fatg_9', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } } });
    expect(await effort.during(250)).toEqual([]);
    expect(onlySessionOf(effort.pid).efforts).toEqual([{ effortLevel: 'high' }]);

    setControl({ hang: 'started' });
    const started = await session();
    started.prompt(promptOf('m19-t1-basic'));
    expect(await started.during(250)).toEqual([]);
    expect(onlySessionOf(started.pid)).toMatchObject({ kept: true, turns: ['hang'] });

    setControl({ hang: 'stop' });
    const stop = await session();
    stop.prompt(promptOf('m19-t4-interrupt'));
    await stop.next(isTextDelta);
    stop.interrupt();
    expect(await stop.during(250)).toEqual([]);
    expect(onlySessionOf(stop.pid).interrupts).toHaveLength(1);
  });

  // Decision 0033: how full the context is, as M10's discovery capture has the CLI answer it.
  it('answers a context request of the summary detail with M10’s reply under fat-g’s id, and notes its detail', async () => {
    const fake = await session();
    fake.send({ type: 'control_request', request_id: 'fatg_4', request: { subtype: 'get_context_usage', detail: 'summary' } });
    const reply = await fake.next((line) => at(line, 'response', 'request_id') === 'fatg_4');
    expect(at(reply, 'response', 'subtype')).toBe('success');
    expect([at(reply, 'response', 'response', 'totalTokens'), at(reply, 'response', 'response', 'maxTokens'), at(reply, 'response', 'response', 'autoCompactThreshold')]).toEqual([23_605, 1_000_000, 967_000]);
    expect(onlySession()[1].contexts).toEqual(['summary']);
    expect(existsSync(path.join(fixture, 'unexpected-chat-request'))).toBe(false);
  });

  it('marks a context request of another detail, refuses one under `contextRefused`, holds one under `hang: context`, and plants the sentinel under `contextPrivate`', async () => {
    const full = await session();
    full.send({ type: 'control_request', request_id: 'fatg_5', request: { subtype: 'get_context_usage', detail: 'full' } });
    await full.next((line) => at(line, 'response', 'request_id') === 'fatg_5');
    expect(readFileSync(path.join(fixture, 'unexpected-chat-request'), 'utf8')).toBe(String(full.pid));

    setControl({ contextRefused: true });
    const refused = await session();
    refused.send({ type: 'control_request', request_id: 'fatg_6', request: { subtype: 'get_context_usage', detail: 'summary' } });
    expect(at(await refused.next((line) => at(line, 'response', 'request_id') === 'fatg_6'), 'response', 'subtype')).toBe('error');

    setControl({ hang: 'context' });
    const held = await session();
    held.send({ type: 'control_request', request_id: 'fatg_7', request: { subtype: 'get_context_usage', detail: 'summary' } });
    expect(await held.during(250)).toEqual([]);
    expect(onlySessionOf(held.pid).contexts).toEqual(['summary']);

    setControl({ contextPrivate: true });
    const exposed = await session();
    exposed.send({ type: 'control_request', request_id: 'fatg_8', request: { subtype: 'get_context_usage', detail: 'summary' } });
    const reply = JSON.stringify(await exposed.next((line) => at(line, 'response', 'request_id') === 'fatg_8'));
    for (const key of ['memoryFiles', 'mcpTools', 'agents', 'skillFrontmatter', 'toolCallsByType', 'attachmentsByType']) expect(reply).toContain(`"${key}":[{`);
    expect(reply.split(SENTINEL).length - 1).toBeGreaterThanOrEqual(8);
  });

  it('answers an effort change with the captured reply, and notes the one key it was sent', async () => {
    const fake = await session();
    fake.send({ type: 'control_request', request_id: 'fatg_7', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'medium' } } });
    const reply = await fake.next((line) => at(line, 'response', 'request_id') === 'fatg_7');
    expect(reply).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'fatg_7' } });
    expect(captured.has(comparable(reply, project))).toBe(true);
    expect(onlySession()[1].efforts).toEqual([{ effortLevel: 'medium' }]);
  });

  it('turnNeverEnds: `result` and the closing frame are withheld, and every frame before them comes', async () => {
    const { fake } = await turnTo('m19-t1-basic', (line) => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'text', { turnNeverEnds: true });
    await fake.during(250);
    expect(sent(fake)).toEqual(expected('m19-t1-basic').slice(0, -2));
    expect(fake.exited()).toBe(false);
  });

  it('holdResult: the turn’s text comes, and its `result` that long after', async () => {
    const { fake } = await turnTo('m19-t1-basic', ownText, { holdResult: 700 });
    // The reply's own end follows its frame at once; the `result` is what is held.
    await fake.next((line) => isStream(line, 'message_stop') && fake.lines.filter((entry) => isStream(entry, 'message_stop')).length === 2);
    const shown = Date.now();
    expect(await fake.during(300)).toEqual([]);
    await fake.next(isResult);
    expect(Date.now() - shown).toBeGreaterThanOrEqual(600);
    await fake.next(isType('command_lifecycle', 'completed'));
    expect(sent(fake)).toEqual(expected('m19-t1-basic'));
  });

  it('workerNoClose, workerFailed: T3’s worker, its closing frames withheld, or naming a failed status', async () => {
    const open = await turnTo('m19-t3-subagent', isType('command_lifecycle', 'completed'), { workerNoClose: true });
    expect(open.fake.lines.some(isType('system', 'task_started'))).toBe(true);
    expect(open.fake.lines.filter((line) => isType('system', 'task_updated')(line) || isType('system', 'task_notification')(line))).toEqual([]);
    expect(sent(open.fake)).toEqual(expected('m19-t3-subagent').filter((frame) => !/"subtype":"task_(updated|notification)"/.test(frame)));

    const failed = await turnTo('m19-t3-subagent', isType('command_lifecycle', 'completed'), { workerFailed: true });
    const updated = failed.fake.lines.find(isType('system', 'task_updated')) as Json;
    const notified = failed.fake.lines.find(isType('system', 'task_notification')) as Json;
    expect(differences(masked(updated, project), original('m19-t3-subagent', isType('system', 'task_updated')))).toEqual(['patch.status']);
    expect(differences(masked(notified, project), original('m19-t3-subagent', isType('system', 'task_notification')))).toEqual(['status']);
    expect([at(updated, 'patch', 'status'), notified['status']]).toEqual(['failed', 'failed']);
  });

  it('oversize: a tool’s result, or `result`, padded past the line limit, and the frames after it still come', async () => {
    const tool = await turnTo('m19-t1-basic', isType('command_lifecycle', 'completed'), { oversize: 'toolResult' });
    const big = tool.fake.lines.findIndex((line) => line['type'] === 'user');
    // Past a session's line limit, 4 MiB (M20a, C16).
    expect(tool.fake.sizes[big]).toBeGreaterThan(4 * MIB);
    expect(tool.fake.sizes.filter((size) => size > MIB)).toHaveLength(1);
    expect(differences(masked(tool.fake.lines[big] as Json, project), original('m19-t1-basic', (frame) => frame['type'] === 'user'))).toEqual(['message.content']);
    // Padded with quotes, after the captured text: nothing of it is changed, and JSON's escaping
    // doubles each on the line, so two mebibytes of them make a line of over four (M20a, C52).
    const whole = String(at(original('m19-t1-basic', (frame) => frame['type'] === 'user'), 'message', 'content', 0, 'content'));
    const padded = String(at(tool.fake.lines[big], 'message', 'content', 0, 'content'));
    expect(padded.startsWith(whole)).toBe(true);
    expect(padded.slice(whole.length)).toMatch(/^"+$/);
    expect(padded.length).toBeLessThan(3 * MIB);

    const result = await turnTo('m19-t1-basic', isType('command_lifecycle', 'completed'), { oversize: 'result' });
    const end = result.fake.lines.findIndex(isResult);
    expect(result.fake.sizes[end]).toBeGreaterThan(4 * MIB);
    expect(differences(masked(result.fake.lines[end] as Json, project), original('m19-t1-basic', isResult))).toEqual(['result']);
    // The closing frame follows it, as small as ever.
    expect(result.fake.sizes.at(-1)).toBeLessThan(400);
  });

  it('longText: a text past its bound, in a frame under the line limit', async () => {
    const { fake } = await turnTo('m19-t1-basic', isType('command_lifecycle', 'completed'), { longText: true });
    const index = fake.lines.findIndex((line) => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'text');
    const text = String(at(fake.lines[index], 'message', 'content', 0, 'text'));
    expect(text).toHaveLength(100_001);
    expect(text.trimEnd()).toBe('The cat is called Biscuit.');
    expect(fake.sizes[index]).toBeLessThan(MIB);
    expect(differences(masked(fake.lines[index] as Json, project), original('m19-t1-basic', (frame) => ownAssistant(frame) && at(frame, 'message', 'content', 0, 'type') === 'text'))).toEqual(['message.content']);
  });

  it('a descendant, in each of its three behaviours', async () => {
    const descendantOf = async (mode: string): Promise<{ fake: Fake; child: number }> => {
      const fake = await session(undefined, { FATG_SMOKE_CLAUDE_DESCENDANT: mode });
      const child = await vi.waitFor(() => {
        const found = ledger().filter((entry) => entry.role === 'chat-descendant').at(-1);
        if (found === undefined || !alive(found.pid)) throw new Error('no descendant yet');
        return found.pid;
      }, { timeout: 10_000 });
      return { fake, child };
    };
    // 1: it ends when the fake does, its input closed.
    const cooperative = await descendantOf('1');
    await cooperative.fake.end();
    await vi.waitFor(() => expect(alive(cooperative.child)).toBe(false), { timeout: 10_000 });
    // ignore: it outlives the fake.
    const ignoring = await descendantOf('ignore');
    await ignoring.fake.end();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(ignoring.child)).toBe(true);
    // hold: it outlives the fake too, with the fake's output still open.
    const holding = await descendantOf('hold');
    holding.fake.send({ type: 'noop' });
    const ended = await Promise.race([holding.fake.end().then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('open'), 600))]);
    expect(ended).toBe('open');
    expect(alive(holding.child)).toBe(true);
    // afterEach ends both, by their recorded pids.
  });
});

/** The entry of the one session a process launched. */
function onlySessionOf(pid: number): SessionEntry {
  const found = Object.values(sessions()).find((entry) => entry.launches.some((launch) => launch.pid === pid));
  if (found === undefined) throw new Error(`no session of process ${pid}`);
  return found;
}

// ── M19: a reply as it is written ─────────────────────────────────────────────────────────────
// V19 (docs/planning/_archive/M19.md, Design 9; C55, C56): K2's captures replayed frame for frame, and each
// control on the turn's answer, the last text of the session's own.
describe('a reply as it is written (M19: V19; C55, C56)', () => {
  /** One turn of a capture, to its closing frame, under a control. */
  const turn = async (name: string, control: Json, end: 'completed' | 'cancelled' = 'completed', waitMs?: number): Promise<Fake> => {
    setControl(control);
    const fake = await session();
    fake.prompt(promptOf(name));
    await fake.next(isType('command_lifecycle', end), waitMs);
    await fake.during(60);
    return fake;
  };
  const recv = (name: string): Captured[] => capture(name).frames.filter((entry) => entry.dir === 'recv' && entry.index > firstPrompt(name).index);
  const textDeltas = (fake: Fake): Json[] => fake.lines.filter(isTextDelta);
  const answerFrame = (fake: Fake): Json => fake.lines.filter(ownText).at(-1) as Json;
  const textOf = (line: Json | undefined): string => String(at(line, 'message', 'content', 0, 'text'));
  const deltaText = (line: Json): string => String(at(line, 'event', 'delta', 'text'));

  it('sends every stream event of a capture, a text’s deltas in order before the frame that completes it', async () => {
    const fake = await turn('m19-markdown', {});
    expect(sent(fake)).toEqual(expected('m19-markdown'));
    const deltas = textDeltas(fake);
    expect(deltas).toHaveLength(267);
    expect(deltas.map(deltaText).join('')).toBe(textOf(answerFrame(fake)));
    expect(fake.lines.indexOf(answerFrame(fake))).toBeGreaterThan(fake.lines.indexOf(deltas.at(-1) as Json));
    // Every one of them names the session's own reply: none is a worker's.
    expect(fake.lines.filter((line) => isStream(line)).every((line) => line['parent_tool_use_id'] === null)).toBe(true);
    // One id for the reply, from its start to its frame.
    expect(at(fake.lines.find((line) => isStream(line, 'message_start')), 'event', 'message', 'id')).toBe(at(answerFrame(fake), 'message', 'id'));
  });

  it('waits for T4’s interrupt while its text is written, and sends the frame that holds what was written', async () => {
    setControl({});
    const fake = await session();
    fake.prompt(promptOf('m19-t4-interrupt'));
    await fake.next(isTextDelta);
    expect(fake.lines.some(ownText)).toBe(false);
    fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    expect(sent(fake)).toEqual(expected('m19-t4-interrupt'));
    expect(textOf(answerFrame(fake))).toBe(textDeltas(fake).map(deltaText).join(''));
    // No end of the reply follows an interrupt: its frame, then the turn's own end.
    expect(fake.lines.slice(fake.lines.indexOf(answerFrame(fake))).some((line) => isStream(line))).toBe(false);
  });

  it('ends its process where the capture of a reply cut by force ends, and a second process resumes that session', async () => {
    setControl({});
    const fake = await session();
    fake.prompt(promptOf('m19-cut-cut'));
    expect(await fake.closed).toBe(3);
    expect(sent(fake)).toEqual(expected('m19-cut-cut'));
    // Cut during its first text: deltas, and no frame, no `result`, no closing frame.
    expect(textDeltas(fake).length).toBeGreaterThan(10);
    expect(fake.lines.some(ownAssistant)).toBe(false);
    expect(fake.lines.some(isResult)).toBe(false);
    const [id, entry] = onlySession();
    expect(entry).toMatchObject({ kept: true, turns: ['m19-cut-cut'] });
    // Resumed by the id its `init` named: the second prompt of K2's pair is answered.
    const again = start(chatArgs(['--model', 'sonnet', '--effort', 'low', '--resume', id]));
    await again.initialize();
    again.prompt(promptOf('m19-cut-resumed'), 2);
    await again.next(isType('command_lifecycle', 'completed'));
    expect(at(again.lines.find(isType('system', 'init')), 'session_id')).toBe(id);
    expect(onlySession()[1].turns).toEqual(['m19-cut-cut', 'm19-cut-resumed']);
  });

  describe('the controls, each one named change to the answer (C56)', () => {
    it('wholeDiffers: the answer’s frame carries another text than its deltas brought, and nothing else changes', async () => {
      const fake = await turn('m19-t3-subagent', { wholeDiffers: true });
      const streamed = textDeltas(fake).map(deltaText);
      const frames = fake.lines.filter(ownText);
      // The commentary before the worker is as captured; the answer's frame alone differs.
      expect(frames.map(textOf)).toEqual([String(at(recv('m19-t3-subagent').filter((entry) => ownText(entry.frame))[0]?.frame, 'message', 'content', 0, 'text')), `${String(at(recv('m19-t3-subagent').filter((entry) => ownText(entry.frame))[1]?.frame, 'message', 'content', 0, 'text'))} (as completed)`]);
      expect(streamed.join('')).toBe(recv('m19-t3-subagent').filter((entry) => isTextDelta(entry.frame)).map((entry) => deltaText(entry.frame)).join(''));
      expect(sent(fake).filter((line) => !line.includes('(as completed)'))).toEqual(expected('m19-t3-subagent').filter((_, index) => !sent(fake)[index]?.includes('(as completed)')));
    });

    it('noCompletion: the answer’s frame is withheld, and the turn’s end is not', async () => {
      const fake = await turn('m19-t1-basic', { noCompletion: true });
      expect(fake.lines.some(ownText)).toBe(false);
      expect(textDeltas(fake).length).toBe(2);
      expect(at(fake.lines.find(isResult), 'is_error')).toBe(false);
      expect(sent(fake)).toEqual(expected('m19-t1-basic').filter((frame) => !(frame.includes('"type":"assistant"') && frame.includes('"type":"text"'))));
    });

    it('exitBetweenDeltas: the process ends after the answer’s second text delta, taken once', async () => {
      setControl({ exitBetweenDeltas: 1 });
      const fake = await session();
      fake.prompt(promptOf('m19-t3-subagent'));
      expect(await fake.closed).toBe(3);
      // The commentary's deltas are not the answer's: they all came, and its frame with them.
      expect(fake.lines.filter(ownText)).toHaveLength(1);
      const answerDeltas = textDeltas(fake).slice(textDeltas(fake).length - 2);
      expect(fake.lines.at(-1)).toBe(answerDeltas[1]);
      expect(fake.lines.some(isResult)).toBe(false);
      // The next process is not ended.
      const again = await turn('m19-t1-basic', readControlFile());
      expect(again.exited()).toBe(false);
    });

    it('deltaOfWorker: every text delta of the answer names a worker’s tool use, and the frame that completes it is the session’s own', async () => {
      const fake = await turn('m19-t1-basic', { deltaOfWorker: true });
      expect(textDeltas(fake).length).toBe(2);
      expect(textDeltas(fake).every((line) => typeof line['parent_tool_use_id'] === 'string')).toBe(true);
      // Its start and its block's start are the session's own, as captured.
      expect(fake.lines.filter((line) => isStream(line, 'content_block_start')).every((line) => line['parent_tool_use_id'] === null)).toBe(true);
      expect(answerFrame(fake)['parent_tool_use_id']).toBeNull();
    });

    it('deltaAfterComplete: the answer’s last text delta is sent again after the frame that completed it', async () => {
      const fake = await turn('m19-t1-basic', { deltaAfterComplete: true });
      const frame = fake.lines.indexOf(answerFrame(fake));
      const late = fake.lines[frame + 1] as Json;
      expect(isTextDelta(late)).toBe(true);
      const before = textDeltas(fake).filter((line) => fake.lines.indexOf(line) < frame);
      expect(comparable(late, project)).toBe(comparable(before.at(-1) as Json, project));
      expect(textDeltas(fake)).toHaveLength(before.length + 1);
    });

    // 267 deltas of 20 000 units are five megabytes through a pipe: Windows CI took 5 s, then past 10.
    it('deltasPastBound: every text delta of the answer is padded to 20 000 units, after its captured text', { timeout: 40_000 }, async () => {
      const fake = await turn('m19-markdown', { deltasPastBound: true }, 'completed', 25_000);
      const deltas = textDeltas(fake).map(deltaText);
      expect(deltas).toHaveLength(267);
      expect(deltas.every((text) => text.length === 20_000)).toBe(true);
      expect(deltas.map((text) => text.trimEnd()).join('').length).toBeGreaterThan(2_000);
      // The frame that completes it is the capture's own: the whole message is the authority.
      expect(textOf(answerFrame(fake))).toBe(String(at(recv('m19-markdown').find((entry) => ownText(entry.frame))?.frame, 'message', 'content', 0, 'text')));
    });

    it('noDeltas: the answer’s reply sends no stream event, so it arrives whole; a reply before it streams as captured', async () => {
      const fake = await turn('m19-t3-subagent', { noDeltas: true });
      const captured = recv('m19-t3-subagent');
      const commentary = String(at(captured.filter((entry) => ownText(entry.frame))[0]?.frame, 'message', 'content', 0, 'text'));
      // The commentary's deltas came; none of the answer's did.
      expect(textDeltas(fake).map(deltaText).join('')).toBe(commentary);
      expect(fake.lines.filter((line) => isStream(line, 'message_start'))).toHaveLength(1);
      expect(fake.lines.filter(ownText).map(textOf)).toEqual(captured.filter((entry) => ownText(entry.frame)).map((entry) => String(at(entry.frame, 'message', 'content', 0, 'text'))));
      for (const line of fake.lines) expect(capturedHas(line), String(line['type'])).toBe(true);
    });

    it('answerText: the answer is the text given — its first text delta brings all of it, no other is sent, and its frame holds the same', async () => {
      const given = '# A title\n\n<script>never run</script> and [a link](javascript:void 0)';
      const fake = await turn('m19-t3-subagent', { answerText: given });
      const commentary = String(at(recv('m19-t3-subagent').filter((entry) => ownText(entry.frame))[0]?.frame, 'message', 'content', 0, 'text'));
      expect(textDeltas(fake).map(deltaText).join('')).toBe(commentary + given);
      expect(textDeltas(fake).filter((line) => deltaText(line) === given)).toHaveLength(1);
      expect(fake.lines.filter(ownText).map(textOf)).toEqual([commentary, given]);
      expect(at(fake.lines.find(isResult), 'is_error')).toBe(false);
    });
  });
});

// ── M19b ──────────────────────────────────────────────────────────────────────────────────────
// V15 (docs/planning/_archive/M19b.md, Design 10; C46): K2's captures, whose answers name a file. Claude named
// its file in a code span each time, twice by its bare name, and wrote no link and no folder.
describe('an answer that names a file (M19b: V15; C46)', () => {
  const NAMES = ['m19b-line', 'm19b-readme', 'm19b-space'] as const;
  const turn = async (name: string): Promise<Fake> => {
    const fake = await session();
    fake.prompt(promptOf(name));
    await fake.next(isType('command_lifecycle', 'completed'));
    await fake.during(60);
    return fake;
  };
  const answer = (fake: Fake): string => String(at(fake.lines.filter(ownText).at(-1), 'message', 'content', 0, 'text'));
  /** The code spans of a text that the page reads as a path. */
  const paths = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '').filter((span) => readCodeSpanPath(span) !== null);

  it('are three more stream captures, each chosen by a prompt of its own that names no folder', () => {
    expect([...STREAM_CAPTURES].slice(-3)).toEqual([...NAMES]);
    for (const name of NAMES) {
      expect(String(at(firstPrompt(name).frame, 'message', 'content')), name).not.toContain('<scratch>');
      expect(typeof promptAlias(name), name).toBe('string');
    }
  });

  it.each(NAMES)('replays %s for its prompt, every frame from its capture file but for ids, times and the folder', async (name) => {
    const fake = await turn(name);
    expect(sent(fake)).toEqual(expected(name));
    expect(fake.lines.every(capturedHas)).toBe(true);
    expect(JSON.stringify(fake.lines)).not.toMatch(/<scratch>|<session-\d+>/);
    // The answer's deltas, in order, bring what its completing frame holds.
    const reply = at(fake.lines.filter(ownText).at(-1), 'message', 'id');
    let current: unknown = null;
    const written = fake.lines.filter((line) => {
      if (isStream(line, 'message_start')) current = at(line, 'event', 'message', 'id');
      return current === reply && isTextDelta(line);
    }).map((line) => String(at(line, 'event', 'delta', 'text'))).join('');
    expect(written).toBe(answer(fake));
    expect(onlySession()[1].turns).toEqual([name]);
  });

  it('names its file in a code span each time, twice by a bare name: what the page reads as a path', async () => {
    const named: Record<string, string[]> = {};
    for (const name of NAMES) named[name] = paths(answer(await turn(name)));
    expect(named).toEqual({ 'm19b-line': ['src/tides.js:12'], 'm19b-readme': ['README.md'], 'm19b-space': ['harbour-log.md'] });
  });

  it('writes no link and no folder in any of the three answers', async () => {
    for (const name of NAMES) {
      const text = answer(await turn(name));
      expect(text, name).not.toMatch(/\]\(/);
      expect(text, name).not.toContain(project);
      expect(text, name).not.toContain(path.basename(dir));
    }
  });
});

// ── M20a: what a session does between its messages ────────────────────────────────────────────

describe('what a session does between its messages (M20a: V14; C51, C52)', () => {
  const T1 = 'm19-t1-basic';
  /** One capture's turn to its closing frame, under a control. */
  const turn = async (name: string, control: Json = {}): Promise<Fake> => {
    setControl(control);
    const fake = await session();
    fake.prompt(promptOf(name));
    await fake.next(isType('command_lifecycle', 'completed'), 30_000);
    await fake.during(60);
    return fake;
  };
  const original = (name: string, match: (frame: Json) => boolean): Json => masked((capture(name).frames.find((entry) => entry.dir === 'recv' && match(entry.frame)) as Captured).frame, '<never>');
  /** The session's own tool use, and its result: what each fault changes. */
  const ownTool = (line: Json): boolean => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'tool_use';
  const ownResult = (line: Json): boolean => line['type'] === 'user' && line['parent_tool_use_id'] === null && at(line, 'message', 'content', 0, 'type') === 'tool_result';
  const resultText = (line: Json | undefined): string => String(at(line, 'message', 'content', 0, 'content'));
  const whole = (): string => resultText(original(T1, ownResult)).replaceAll('<scratch>', project);

  it('replays the captures that hold a tool’s use and its result, and a worker’s frames, each frame from its capture file', async () => {
    // M19's (C51): no capture was taken again, the installed CLI being the captures' own (K2).
    for (const [name, tools, results, workers] of [[T1, 1, 1, 0], ['m19-t3-subagent', 1, 1, 3]] as const) {
      const fake = await turn(name);
      expect(sent(fake), name).toEqual(expected(name));
      expect(fake.lines.every(capturedHas), name).toBe(true);
      expect(fake.lines.filter(ownTool), name).toHaveLength(tools);
      expect(fake.lines.filter(ownResult), name).toHaveLength(results);
      // A worker's own frames name the tool use that started it.
      expect(fake.lines.filter((line) => (line['type'] === 'assistant' || line['type'] === 'user') && typeof line['parent_tool_use_id'] === 'string'), name).toHaveLength(workers);
      await fake.end();
    }
    // The attempted launch that failed is M16's capture, whose prompt carries no id: no turn of the
    // fake's, and read by the mapper's own tests from its file. Its result carries the error flag, as the CLI sent it.
    expect(at(original('m16-background-disabled', ownResult), 'message', 'content', 0, 'is_error')).toBe(true);
  }, 120_000);

  it('toolUnknown: the first tool’s name is one the adapter does not know, and its result still names its use', async () => {
    const fake = await turn(T1, { toolUnknown: true });
    const used = fake.lines.find(ownTool);
    expect(at(used, 'message', 'content', 0, 'name')).toBe('ALaterTool');
    expect(differences(masked(used as Json, project), original(T1, ownTool))).toEqual(['message.content']);
    expect(at(fake.lines.find(ownResult), 'message', 'content', 0, 'tool_use_id')).toBe(at(used, 'message', 'content', 0, 'id'));
    // The result, and every frame after it, is the capture's own.
    expect(fake.lines.filter((line) => !ownTool(line)).every(capturedHas)).toBe(true);
  });

  it('noToolResult: the first tool’s result is withheld, and the turn ends all the same', async () => {
    const fake = await turn(T1, { noToolResult: true });
    expect(fake.lines.filter(ownTool)).toHaveLength(1);
    expect(fake.lines.filter(ownResult)).toEqual([]);
    expect(fake.lines.filter(ownText)).toHaveLength(1);
    expect(fake.lines.filter(isResult)).toHaveLength(1);
    expect(fake.lines.every(capturedHas)).toBe(true);
  });

  it('toolError: the first tool’s result carries the error flag, and nothing else of it is changed', async () => {
    const fake = await turn(T1, { toolError: true });
    const result = fake.lines.find(ownResult);
    expect(at(result, 'message', 'content', 0, 'is_error')).toBe(true);
    expect(resultText(result)).toBe(whole());
    expect(differences(masked(result as Json, project), original(T1, ownResult))).toEqual(['message.content']);
    expect(fake.lines.filter((line) => !ownResult(line)).every(capturedHas)).toBe(true);
  });

  it('longText toolResult: the first tool’s result is past its bound, its last words still there, in a frame under the line limit', async () => {
    const fake = await turn(T1, { longText: 'toolResult' });
    const index = fake.lines.findIndex(ownResult);
    const text = resultText(fake.lines[index]);
    expect(text.startsWith(whole())).toBe(true);
    expect(text).toHaveLength(whole().length + 20_000 + 'THE END'.length);
    expect(text.endsWith('THE END')).toBe(true);
    expect(fake.sizes[index]).toBeLessThan(MIB);
    // The answer's own text is as captured: this fault pads no message.
    expect(fake.lines.filter((line) => !ownResult(line)).every(capturedHas)).toBe(true);
  });

  it('quotedResult: a megabyte of quotes makes a line of over two, under a session’s limit', async () => {
    const fake = await turn(T1, { quotedResult: true });
    const index = fake.lines.findIndex(ownResult);
    const text = resultText(fake.lines[index]);
    expect(text.startsWith(whole())).toBe(true);
    expect(text.slice(whole().length)).toMatch(/^"{1000000,}$/);
    expect(fake.sizes[index]).toBeGreaterThan(2 * MIB);
    expect(fake.sizes[index]).toBeLessThan(4 * MIB);
    expect(fake.sizes.filter((bytes) => bytes > MIB)).toHaveLength(1);
  });

  it('changes a worker’s own tool and result in nothing: each fault is on the session’s first tool use alone', async () => {
    const fake = await turn('m19-t3-subagent', { toolUnknown: true, toolError: true });
    const theirs = fake.lines.filter((line) => (line['type'] === 'assistant' || line['type'] === 'user') && typeof line['parent_tool_use_id'] === 'string');
    expect(theirs).toHaveLength(3);
    expect(theirs.every(capturedHas)).toBe(true);
    expect(at(fake.lines.find(ownTool), 'message', 'content', 0, 'name')).toBe('ALaterTool');
  }, 60_000);
});

// ── M20b: a side question, and the CLI's own commands (V14; C61, C62) ─────────────────────────
describe('a question beside a session, and a command of the CLI’s (M20b: V14; C54, C61, C62)', () => {
  /** A capture's side questions, in the order they were sent: the request, and what came back under its id. */
  function sides(name: string): { readonly request: Json; readonly received: Json[] }[] {
    const all = capture(name).frames;
    return all.filter((entry) => entry.dir === 'send' && at(entry.frame, 'request', 'subtype') === 'side_question').map((sentFrame) => {
      const id = sentFrame.frame['request_id'];
      const received = all.filter((entry) => entry.dir === 'recv' && (entry.frame['request_id'] === id || at(entry.frame, 'response', 'request_id') === id)).map((entry) => entry.frame);
      return { request: at(sentFrame.frame, 'request') as Json, received };
    });
  }
  const question = (name: string, nth = 0): string => String((sides(name)[nth] as { request: Json }).request['question']).replaceAll('<scratch>', project);
  /** Sends a side question as fat-g does: the capture's own request, under an id of fat-g's. */
  function askSide(fake: Fake, name: string, n: number, nth = 0): string {
    const id = `fatg_side_${n}`;
    const { request } = sides(name)[nth] as { request: Json };
    fake.send({ type: 'control_request', request_id: id, request: { ...request, question: question(name, nth) } });
    return id;
  }
  const replyTo = (id: string) => (line: Json): boolean => line['type'] === 'control_response' && at(line, 'response', 'request_id') === id;
  const progressOf = (id: string) => (line: Json): boolean => line['type'] === 'system' && line['subtype'] === 'control_request_progress' && line['request_id'] === id;
  const asked = (): { question: string; history: unknown; turn: boolean }[] => (onlySession()[1] as unknown as { sides: { question: string; history: unknown; turn: boolean }[] }).sides;
  /** A frame as it compares, a progress frame's request id masked as a reply's is: it is fat-g's here, and the capture's there. */
  const sideComparable = (frame: Json, folder: string): string => comparable(frame['subtype'] === 'control_request_progress' ? { ...frame, request_id: '<id>' } : frame, folder);
  const capturedSides = new Set(SIDE_CAPTURES.flatMap((name) => capture(name).frames.filter((entry) => entry.dir === 'recv').map((entry) => sideComparable(entry.frame, '<never>'))));
  /** A line the fake sent is some capture's frame, but for ids, times and the folder. */
  const known = (line: Json): boolean => capturedHas(line) || capturedSides.has(sideComparable(line, project));

  it('names K1’s five side questions and two turns, and K2’s seven commands, each chosen by a text no other has', () => {
    expect([...SIDE_CAPTURES]).toEqual(['m20b-idle', 'm20b-during', 'm20b-two', 'm20b-followup', 'm20b-cancel']);
    const questions = SIDE_CAPTURES.flatMap((name) => sides(name).map((side) => String(side.request['question'])));
    expect(new Set(questions).size).toBe(questions.length);
    expect(SIDE_CAPTURES.map((name) => sides(name).length)).toEqual([1, 1, 2, 1, 1]);
    // Taken under the launch a chat session has now: without the flag that turned the commands off.
    for (const name of [...SIDE_CAPTURES, ...ASIDE_TURN_CAPTURES, ...COMMAND_CAPTURES]) {
      const args = (capture(name) as unknown as { launch: { args: string[] } }).launch.args;
      expect(args, name).not.toContain('--disable-slash-commands');
      expect(args, name).toContain('--include-partial-messages');
    }
    // And the one taken with it shows why it went: the side question is refused there.
    expect((capture('m20b-flagged') as unknown as { launch: { args: string[] } }).launch.args).toContain('--disable-slash-commands');
    expect(SIDE_CAPTURES).not.toContain('m20b-flagged');
    expect(TURN_CAPTURES).not.toContain('m20b-flagged');
  });

  for (const name of ['m20b-idle', 'm20b-followup']) {
    it(`answers ${name}’s side question from its capture: the progress frame, then the reply, each a captured frame but for ids`, async () => {
      const fake = await session();
      const before = fake.lines.length;
      const id = askSide(fake, name, 1);
      await fake.next(replyTo(id));
      const told = fake.lines.slice(before);
      expect(told.map(kindOf)).toEqual(['control_request_progress', 'control_response']);
      expect(told[0]).toMatchObject({ request_id: id, status: 'started' });
      expect(at(told[1], 'response', 'subtype')).toBe('success');
      for (const line of told) expect(known(line), kindOf(line)).toBe(true);
      // The capture's own frames for that question, in their order.
      expect(told.map((line) => sideComparable(line, project))).toEqual((sides(name)[0] as { received: Json[] }).received.map((frame) => sideComparable(frame, '<never>')));
      // No turn was made of it, and the session is kept as it was: a question beside it is none of its turns.
      expect(onlySession()[1]).toMatchObject({ turns: [], kept: false });
      expect(asked()).toEqual([{ question: question(name), history: (sides(name)[0] as { request: Json }).request['history'] ?? null, turn: false }]);
      expect(await fake.end()).toBe(0);
    });
  }

  it('answers two asked at once, each under its own id, and one asked while a turn is replayed without changing a frame of the turn', async () => {
    const fake = await session();
    const one = askSide(fake, 'm20b-two', 1, 0);
    const two = askSide(fake, 'm20b-two', 2, 1);
    await Promise.all([fake.next(replyTo(one)), fake.next(replyTo(two))]);
    expect(fake.lines.filter(progressOf(one))).toHaveLength(1);
    expect(fake.lines.filter(progressOf(two))).toHaveLength(1);
    for (const line of fake.lines) expect(known(line), kindOf(line)).toBe(true);
    // During a turn: T1 is replayed, and the side question is answered beside it.
    const from = fake.lines.length;
    fake.prompt(promptOf('m19-t1-basic'));
    const during = askSide(fake, 'm20b-during', 3);
    await Promise.all([fake.next(isType('command_lifecycle', 'completed')), fake.next(replyTo(during))]);
    await fake.during(60);
    const told = fake.lines.slice(from);
    const ofSide = (line: Json): boolean => progressOf(during)(line) || replyTo(during)(line);
    expect(told.filter((line) => !ofSide(line)).map((line) => comparable(line, project))).toEqual(expected('m19-t1-basic'));
    expect(told.filter(ofSide).map(kindOf)).toEqual(['control_request_progress', 'control_response']);
    expect(asked().map((side) => side.turn)).toEqual([false, false, true]);
    expect(onlySession()[1].turns).toEqual(['m19-t1-basic']);
  });

  it('answers a cancel of a question that waits with the capture’s error reply, and a cancel of nothing with nothing', async () => {
    const fake = await session();
    // Its capture shows it cancelled: the fake sends its progress frame and waits.
    const id = askSide(fake, 'm20b-cancel', 1);
    await fake.next(progressOf(id));
    expect(await fake.during(150)).toEqual([]);
    fake.send({ type: 'control_cancel_request', request_id: id });
    const reply = await fake.next(replyTo(id));
    expect(at(reply, 'response')).toEqual({ subtype: 'error', request_id: id, error: 'Side question cancelled' });
    expect(capturedHas(reply)).toBe(true);
    fake.send({ type: 'control_cancel_request', request_id: 'no-such-request' });
    fake.send({ type: 'control_cancel_request', request_id: id });
    expect(await fake.during(150)).toEqual([]);
    expect((onlySession()[1] as unknown as { cancels: unknown[] }).cancels).toEqual([{ waiting: true }, { waiting: false }, { waiting: false }]);
  });

  describe('the controls, each one named change (C62)', () => {
    /** The reply the fake gives m20b-idle's question under a control, and the capture's own reply. */
    async function faulted(control: Json): Promise<{ readonly reply: Json; readonly own: Json; readonly fake: Fake }> {
      setControl(control);
      const fake = await session();
      const id = askSide(fake, 'm20b-idle', 1);
      const reply = await fake.next(replyTo(id));
      const own = (sides('m20b-idle')[0] as { received: Json[] }).received.find((frame) => frame['type'] === 'control_response') as Json;
      return { reply, own, fake };
    }

    it('sideRefused: the question is answered with the error reply at once, with no progress frame, once', async () => {
      const { reply, fake } = await faulted({ sideRefused: 1 });
      expect(at(reply, 'response', 'subtype')).toBe('error');
      expect(fake.lines.some((line) => line['subtype'] === 'control_request_progress')).toBe(false);
      expect(capturedHas(reply)).toBe(true);
      // Taken once: the next question is answered.
      const next = askSide(fake, 'm20b-idle', 2);
      expect(at(await fake.next(replyTo(next)), 'response', 'subtype')).toBe('success');
    });

    it.each([
      ['null', 'response.response.response', null],
      ['synthetic', 'response.response.synthetic', true],
    ] as const)('sideReply %s: the reply differs from the capture’s at one path alone', async (fault, changedAt, value) => {
      const { reply, own } = await faulted({ sideReply: fault });
      expect(differences(masked(reply, project), masked(own, '<never>'))).toEqual([changedAt]);
      expect(at(reply, ...changedAt.split('.'))).toBe(value);
    });

    it('sideReply fallback: the reply names another model as the one that answered, and nothing else of it changes', async () => {
      const { reply, own } = await faulted({ sideReply: 'fallback' });
      expect(differences(masked(reply, project), masked(own, '<never>'))).toEqual(['response.response.refusal_fallback']);
      expect(at(reply, 'response', 'response', 'refusal_fallback')).toEqual({ original_model: 'claude-sonnet-5', fallback_model: 'claude-haiku-5' });
    });

    it('hang side: the question gets its progress frame and no reply, until it is cancelled', async () => {
      setControl({ hang: 'side' });
      const fake = await session();
      const id = askSide(fake, 'm20b-idle', 1);
      await fake.next(progressOf(id));
      expect(await fake.during(200)).toEqual([]);
      fake.send({ type: 'control_cancel_request', request_id: id });
      expect(at(await fake.next(replyTo(id)), 'response', 'subtype')).toBe('error');
    });

    it('hang cancel: a cancel is never answered, and the reply comes when it would have: a success after a Stop', async () => {
      setControl({ hang: 'cancel', holdSide: 300 });
      const fake = await session();
      const id = askSide(fake, 'm20b-idle', 1);
      await fake.next(progressOf(id));
      fake.send({ type: 'control_cancel_request', request_id: id });
      const reply = await fake.next(replyTo(id), 5_000);
      expect(at(reply, 'response', 'subtype')).toBe('success');
    });

    it('strayProgress: one more progress frame, for a request that was never made, and nothing else changes', async () => {
      setControl({ strayProgress: 1 });
      const fake = await session();
      const before = fake.lines.length;
      const id = askSide(fake, 'm20b-idle', 1);
      await fake.next(replyTo(id));
      const told = fake.lines.slice(before);
      expect(told.map((line) => [kindOf(line), line['request_id'] ?? at(line, 'response', 'request_id')])).toEqual([['control_request_progress', id], ['control_request_progress', 'no-such-request'], ['control_response', id]]);
    });
  });

  for (const name of COMMAND_CAPTURES) {
    it(`replays ${name} for its own prompt, a command the CLI answers: the capture’s frames after the prompt, but for ids, times and the folder`, async () => {
      const fake = await session();
      const prompt = promptOf(name);
      expect(prompt).toMatch(/^\/[a-z]+(\s|$)/);
      fake.prompt(prompt);
      await fake.next(isType('command_lifecycle', 'completed'));
      await fake.during(60);
      expect(sent(fake)).toEqual(expected(name));
      for (const line of fake.lines) expect(capturedHas(line), String(line['type'])).toBe(true);
      expect(onlySession()[1]).toMatchObject({ turns: [name] });
      expect(await fake.end()).toBe(0);
    });
  }

  it('says so when it is sent a request a chat session never sends, a side question and its cancel being two it does send', async () => {
    const fake = await session();
    const id = askSide(fake, 'm20b-idle', 1);
    await fake.next(replyTo(id));
    fake.send({ type: 'control_cancel_request', request_id: id });
    await fake.during(100);
    expect(existsSync(path.join(fixture, 'unexpected-chat-request'))).toBe(false);
  });
});

// ── M21: a question the CLI asks (V12; C50, C51) ──────────────────────────────────────────────
describe('a question the CLI asks (M21: V12; C50, C51)', () => {
  const ONE = 'm21-question-one';
  const ASKED = ['m21-question-one', 'm21-question-multi', 'm21-question-two'] as const;
  const isAsk = (line: Json): boolean => line['type'] === 'control_request' && at(line, 'request', 'subtype') === 'can_use_tool' && at(line, 'request', 'tool_name') === 'AskUserQuestion';
  const isCancel = (line: Json): boolean => line['type'] === 'control_cancel_request';
  const ownUse = (line: Json): boolean => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'tool_use';
  const resultOf = (toolUseId: unknown) => (line: Json): boolean => line['type'] === 'user' && at(line, 'message', 'content', 0, 'type') === 'tool_result' && at(line, 'message', 'content', 0, 'tool_use_id') === toolUseId;
  const original = (name: string, match: (frame: Json) => boolean): Json => masked((capture(name).frames.find((entry) => entry.dir === 'recv' && match(entry.frame)) as Captured).frame, '<never>');
  /** What the capture's spike sent back with its `allow`: the request's input, and the answers. */
  const sentBack = (name: string): Json => at(capture(name).frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'control_response')?.frame, 'response', 'response', 'updatedInput') as Json;
  /** The capture's own reply to its question, under the id this fake's request came with. */
  const allow = (name: string, request: Json): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response: { behavior: 'allow', updatedInput: sentBack(name) } } });
  /** A question's turn up to its request, under a control. */
  const asking = async (name: string = ONE, control: Json = {}): Promise<{ fake: Fake; request: Json }> => {
    setControl(control);
    const fake = await session();
    fake.prompt(promptOf(name));
    return { fake, request: await fake.next(isAsk) };
  };
  const completed = async (fake: Fake): Promise<void> => { await fake.next(isType('command_lifecycle', 'completed')); await fake.during(60); };
  const requestAt = (frames: readonly string[]): number => frames.findIndex((frame) => frame.includes('"type":"control_request"'));

  it.each(ASKED)('replays %s for its own prompt: it waits at the question for fat-g’s reply, then plays the capture’s frames after it, each a captured frame but for ids, times and the folder', async (name) => {
    const { fake, request } = await asking(name);
    // Nothing until the reply: the turn is held, as the CLI holds it.
    expect(await fake.during(200)).toEqual([]);
    const upTo = sent(fake);
    expect(upTo).toEqual(expected(name).slice(0, requestAt(expected(name)) + 1));
    // The request names the tool use of the frame before it, under ids of this process's own.
    const used = fake.lines.filter(ownUse).at(-1);
    expect(at(request, 'request', 'tool_use_id')).toBe(at(used, 'message', 'content', 0, 'id'));
    expect(at(request, 'request', 'input')).toEqual(at(used, 'message', 'content', 0, 'input'));
    expect(String(request['request_id'])).toMatch(UUID);
    fake.send(allow(name, request));
    await completed(fake);
    expect(sent(fake)).toEqual(expected(name));
    for (const line of fake.lines) expect(capturedHas(line), kindOf(line)).toBe(true);
    // The question's result names the same tool use, and the turn went on to read what was chosen.
    expect(fake.lines.some(resultOf(at(request, 'request', 'tool_use_id')))).toBe(true);
    expect(at(fake.lines.find(isResult), 'is_error')).toBe(false);
    // What fat-g sent back is noted whole: the request's input as it came, with the answers.
    expect(onlySession()[1]).toMatchObject({ kept: true, turns: [name] });
    expect(onlySession()[1].answers).toEqual([{ subtype: 'success', behavior: 'allow', message: null, error: null, updatedInput: sentBack(name) }]);
    expect(await fake.end()).toBe(0);
  });

  it.each(['m21-question-worker', 'm21-question-killed-resumed'])('replays %s for its own prompt, which asks nothing: the capture’s frames after the prompt, but for ids, times and the folder', async (name) => {
    const fake = await session();
    fake.prompt(promptOf(name));
    await completed(fake);
    expect(sent(fake)).toEqual(expected(name));
    for (const line of fake.lines) expect(capturedHas(line), kindOf(line)).toBe(true);
    expect(fake.lines.some(isAsk)).toBe(false);
    expect(onlySession()[1]).toMatchObject({ turns: [name], answers: [] });
  }, 60_000);

  it('answers an interrupt that comes while a question waits with K1’s Stop: the cancel that names the request, the error result, the `result` and the closing frame', async () => {
    const { fake, request } = await asking();
    const before = fake.lines.length;
    const id = fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    await fake.during(60);
    const tail = fake.lines.slice(before);
    // The capture's frames from its interrupt on, in their order.
    const stop = capture(QUESTION_STOP).frames;
    const interrupted = stop.find((entry) => entry.dir === 'send' && at(entry.frame, 'request', 'subtype') === 'interrupt') as Captured;
    expect(tail.map((line) => comparable(line, project))).toEqual(stop.filter((entry) => entry.dir === 'recv' && entry.index > interrupted.index).map((entry) => comparable(entry.frame, '<never>')));
    expect(tail.map(kindOf)).toEqual(['control_cancel_request', 'control_response', 'user', 'user', 'result', 'cancelled']);
    // Each names this turn's own: its request, fat-g's interrupt, its tool use, its prompt.
    expect(tail[0]).toEqual({ type: 'control_cancel_request', request_id: request['request_id'] });
    expect(at(tail[1], 'response', 'request_id')).toBe(id);
    expect(at(tail[2], 'message', 'content', 0)).toMatchObject({ type: 'tool_result', is_error: true, tool_use_id: at(request, 'request', 'tool_use_id') });
    expect(at(tail[4], 'is_error')).toBe(true);
    expect(tail[5]).toMatchObject({ command_uuid: PROMPT_ID(1) });
    // What came before it is the answered question's own turn, up to its request: the two share a prompt.
    expect(sent(fake).slice(0, before - 1)).toEqual(expected(ONE).slice(0, requestAt(expected(ONE)) + 1));
    for (const line of fake.lines) expect(capturedHas(line), kindOf(line)).toBe(true);
    expect(onlySession()[1]).toMatchObject({ turns: [ONE], answers: [], interrupts: [{ inputOpen: true, turn: true, workers: 0 }] });
    // The process is up for the next prompt.
    fake.prompt(promptOf('m21-question-killed-resumed'), 2);
    await fake.next((line) => isType('command_lifecycle', 'completed')(line) && line['command_uuid'] === PROMPT_ID(2));
  });

  it('answers an interrupt that comes once the question was answered as it answers any turn’s: T4’s frames, and no cancel', async () => {
    const { fake, request } = await asking(ONE, { holdResult: 5000 });
    fake.send(allow(ONE, request));
    await fake.next(ownText);
    await fake.next((line) => isStream(line, 'message_stop') && fake.lines.filter((entry) => isStream(entry, 'message_stop')).length === 3);
    fake.interrupt();
    await fake.next(isType('command_lifecycle', 'cancelled'));
    expect(fake.lines.some(isCancel)).toBe(false);
    expect(at(fake.lines.find(isResult), 'is_error')).toBe(true);
  });

  describe('the controls, each one named change (C51)', () => {
    it('questionTwice: the request is delivered again under the same id, and one reply lets the turn go on', async () => {
      const { fake, request } = await asking(ONE, { questionTwice: true });
      await fake.during(100);
      const asked = fake.lines.filter(isAsk);
      expect(asked).toHaveLength(2);
      expect(asked[1]).toEqual(asked[0]);
      expect(fake.lines.indexOf(asked[1] as Json)).toBe(fake.lines.indexOf(asked[0] as Json) + 1);
      // fat-g gives each delivery the same reply: the first resumes the turn, the second is noted.
      fake.send(allow(ONE, request));
      fake.send(allow(ONE, request));
      await completed(fake);
      const again = fake.lines.indexOf(asked[1] as Json);
      expect(sent(fake).filter((_, index) => index !== again - 1)).toEqual(expected(ONE));
      expect(onlySession()[1].answers).toHaveLength(2);
    });

    it('questionWorker: the request names a worker no worker is, and nothing else of it changes', async () => {
      const { fake, request } = await asking(ONE, { questionWorker: true });
      expect(differences(masked(request, project), original(ONE, isAsk))).toEqual(['request.agent_id']);
      expect(at(request, 'request', 'agent_id')).toBe('no-such-worker');
      expect(fake.lines.some(isType('system', 'task_started'))).toBe(false);
      expect(fake.lines.filter((line) => !isAsk(line)).every(capturedHas)).toBe(true);
    });

    it('questionLate: the request comes after the turn’s `result`, and nothing waited for a reply to it', async () => {
      setControl({ questionLate: true });
      const fake = await session();
      fake.prompt(promptOf(ONE));
      // No reply is sent: the turn runs to its end by itself.
      await completed(fake);
      const kinds = fake.lines.map(kindOf);
      expect(kinds.filter((kind) => kind === 'control_request')).toHaveLength(1);
      expect(kinds.slice(-3)).toEqual(['result', 'control_request', 'completed']);
      const frames = expected(ONE);
      const request = frames[requestAt(frames)] as string;
      const rest = frames.filter((frame) => frame !== request);
      expect(sent(fake)).toEqual([...rest.slice(0, -1), request, ...rest.slice(-1)]);
      // A reply to it changes nothing: it is noted, and no frame follows.
      fake.send({ type: 'control_response', response: { subtype: 'success', request_id: fake.lines.find(isAsk)?.['request_id'], response: { behavior: 'deny', message: 'This action is not available in this session.' } } });
      expect(await fake.during(150)).toEqual([]);
      expect(onlySession()[1].answers).toEqual([{ subtype: 'success', behavior: 'deny', message: 'This action is not available in this session.', error: null }]);
    });

    it('questionCancel: K1’s cancel frame, naming the request, in place of the wait for a reply; the turn goes on as its capture does', async () => {
      const { fake, request } = await asking(ONE, { questionCancel: true });
      await completed(fake);
      const cancels = fake.lines.filter(isCancel);
      expect(cancels).toEqual([{ type: 'control_cancel_request', request_id: request['request_id'] }]);
      expect(fake.lines.indexOf(cancels[0] as Json)).toBe(fake.lines.indexOf(request) + 1);
      expect(capturedHas(cancels[0] as Json)).toBe(true);
      // But for that one frame, the capture's own, with no reply of fat-g's.
      expect(sent(fake).filter((_, index) => index !== fake.lines.indexOf(cancels[0] as Json) - 1)).toEqual(expected(ONE));
      expect(onlySession()[1].answers).toEqual([]);
    });

    it('questionResultError: the question’s tool result carries the error flag, and nothing else of it is changed', async () => {
      const { fake, request } = await asking(ONE, { questionResultError: true });
      fake.send(allow(ONE, request));
      await completed(fake);
      const toolUse = at(request, 'request', 'tool_use_id');
      const result = fake.lines.find(resultOf(toolUse)) as Json;
      expect(at(result, 'message', 'content', 0, 'is_error')).toBe(true);
      expect(differences(masked(result, project), original(ONE, (frame) => frame['type'] === 'user'))).toEqual(['message.content']);
      expect({ ...(at(result, 'message', 'content', 0) as Json), is_error: undefined, tool_use_id: undefined }).toEqual({ ...(at(original(ONE, (frame) => frame['type'] === 'user'), 'message', 'content', 0) as Json), is_error: undefined, tool_use_id: undefined });
      // The read's own result, later in the turn, is as captured.
      expect(fake.lines.filter((line) => line !== result).every(capturedHas)).toBe(true);
    });

    it('questionsTwenty: the request holds 20 questions, its first numbered, and nothing else of it changes', async () => {
      const { request } = await asking(ONE, { questionsTwenty: true });
      expect(differences(masked(request, project), original(ONE, isAsk))).toEqual(['request.input.questions']);
      const questions = at(request, 'request', 'input', 'questions') as Json[];
      const [first] = at(original(ONE, isAsk), 'request', 'input', 'questions') as [Json];
      expect(questions).toHaveLength(20);
      expect(questions.map((question) => question['question'])).toEqual(Array.from({ length: 20 }, (_, n) => `${String(first['question'])} (${n + 1})`));
      expect(questions.every((question) => JSON.stringify({ ...question, question: null }) === JSON.stringify({ ...first, question: null }))).toBe(true);
    });

    it('optionsNine: the request’s first question holds nine options, its own two first, and nothing else of it changes', async () => {
      const { request } = await asking(ONE, { optionsNine: true });
      expect(differences(masked(request, project), original(ONE, isAsk))).toEqual(['request.input.questions']);
      const [question] = at(request, 'request', 'input', 'questions') as [{ question: string; options: { label: string }[] }];
      const [first] = at(original(ONE, isAsk), 'request', 'input', 'questions') as [{ question: string; options: { label: string }[] }];
      expect(question.question).toBe(first.question);
      expect(question.options).toHaveLength(9);
      expect(question.options.slice(0, 2)).toEqual(first.options);
      expect(question.options.slice(2).map((option) => option.label)).toEqual(['option-3', 'option-4', 'option-5', 'option-6', 'option-7', 'option-8', 'option-9']);
      expect(new Set(question.options.map((option) => option.label)).size).toBe(9);
    });

    it('exitWhileAsking: K1’s kill is replayed for the shared prompt, the process ends with the request pending, and a second process resumes that session and asks nothing', async () => {
      setControl({ exitWhileAsking: 1 });
      const fake = await session();
      fake.prompt(promptOf(ONE));
      expect(await fake.closed).toBe(3);
      expect(sent(fake)).toEqual(expected(QUESTION_KILLED));
      for (const line of fake.lines) expect(capturedHas(line), kindOf(line)).toBe(true);
      // Its request went out, and nothing ended the turn.
      expect(fake.lines.filter(isAsk)).toHaveLength(1);
      expect(fake.lines.some(isResult)).toBe(false);
      expect(fake.lines.some(isCancel)).toBe(false);
      const [id, entry] = onlySession();
      expect(entry).toMatchObject({ kept: true, turns: [QUESTION_KILLED], answers: [] });
      // Resumed by the id its `init` named: K1's second prompt is answered in text, with no request.
      const again = start(chatArgs(['--model', 'sonnet', '--effort', 'low', '--resume', id]));
      await again.initialize();
      again.prompt(promptOf('m21-question-killed-resumed'), 2);
      await again.next(isType('command_lifecycle', 'completed'));
      await again.during(60);
      expect(sent(again)).toEqual(expected('m21-question-killed-resumed'));
      expect(again.lines.some(isAsk)).toBe(false);
      expect(onlySession()[1].turns).toEqual([QUESTION_KILLED, 'm21-question-killed-resumed']);
      // Taken once: the same prompt is the answered question's again.
      expect(readControlFile()).toEqual({ exitWhileAsking: 0 });
      again.prompt(promptOf(ONE), 3);
      await again.next(isAsk);
      expect(again.exited()).toBe(false);
    });

    it('exitAtAnswer: the request’s input is padded, and the process ends at the first bytes of the answer that sends it back, the rest of its line refused', async () => {
      const { fake, request } = await asking(ONE, { exitAtAnswer: 1 });
      // The capture's own request, but for the padding its input carries; and its own frames before it.
      expect(differences(masked(request, project), original(ONE, isAsk))).toEqual(['request.input.padding']);
      expect(String(at(request, 'request', 'input', 'padding'))).toMatch(/^x{900000}$/);
      expect(fake.lines.filter((line) => line !== request).every(capturedHas)).toBe(true);
      expect(fake.exited()).toBe(false);
      // The answer sends the input back, as fat-g's does: a line under the megabyte one write may queue, and far over what a pipe takes at once.
      const reply = { type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response: { behavior: 'allow', updatedInput: { ...(at(request, 'request', 'input') as Json), answers: at(sentBack(ONE), 'answers') } } } };
      expect(JSON.stringify(reply).length).toBeGreaterThan(900_000);
      expect(JSON.stringify(reply).length).toBeLessThan(MIB);
      // Its line is refused where it is written: the process ended at its first bytes.
      expect(await fake.written(reply)).toBe(false);
      expect(await fake.closed).toBe(3);
      // Nothing of the answer was taken, and nothing followed the request.
      expect(fake.lines.at(-1)).toBe(request);
      expect(onlySessionOf(fake.pid).answers).toEqual([]);
      // Taken once: the next process asks as the capture does, and takes its answer.
      expect(readControlFile()).toEqual({ exitAtAnswer: 0 });
      const next = await session();
      next.prompt(promptOf(ONE));
      const asked = await next.next(isAsk);
      expect(at(asked, 'request', 'input', 'padding')).toBeUndefined();
      expect(await next.written(allow(ONE, asked))).toBe(true);
      await next.next(isType('command_lifecycle', 'completed'));
    });

    describe('workerAsks: an open worker’s question, which K1 did not see (C21)', () => {
      const SELF = 'm16-self-turn';
      const ofWorker = (line: Json): boolean => typeof line['parent_tool_use_id'] === 'string' && at(line, 'message', 'content', 0, 'name') === 'AskUserQuestion';

      it.each(['during', 'after'] as const)('%s: the answered question’s tool use and request, each naming the worker, around the turn’s `result`; its result follows fat-g’s reply', async (when) => {
        setControl({ workerAsks: when });
        const fake = await session();
        fake.prompt(promptOf(SELF));
        const started = await fake.next(isType('system', 'task_started'));
        const request = await fake.next(isAsk);
        await fake.next(isResult);
        await fake.during(100);
        const used = fake.lines.find(ofWorker) as Json;
        // Before the `result`, or after it; the tool use first, then the request.
        const place = [fake.lines.indexOf(used), fake.lines.indexOf(request), fake.lines.findIndex(isResult)];
        expect(place).toEqual(when === 'during' ? [place[2] as number - 2, place[2] as number - 1, place[2]] : [place[2] as number + 1, place[2] as number + 2, place[2]]);
        // K1's own frames, but for the worker each names: by the tool use that started it, and by its task id.
        expect(differences(masked(used, project), original(ONE, ownUse))).toEqual(['parent_tool_use_id']);
        expect(differences(masked(request, project), original(ONE, isAsk))).toEqual(['request.agent_id']);
        expect(used['parent_tool_use_id']).toBe(started['tool_use_id']);
        expect(at(request, 'request', 'agent_id')).toBe(started['task_id']);
        expect(at(request, 'request', 'tool_use_id')).toBe(at(used, 'message', 'content', 0, 'id'));
        // The turn's own replay is as it was: it waits for K17's second prompt, and no result of the question's comes by itself.
        expect(fake.lines.filter((line) => line !== used && line !== request).every(capturedHas)).toBe(true);
        expect(fake.lines.some(resultOf(at(request, 'request', 'tool_use_id')))).toBe(false);
        fake.send(allow(ONE, request));
        const result = await fake.next(resultOf(at(request, 'request', 'tool_use_id')));
        expect(differences(masked(result, project), original(ONE, (frame) => frame['type'] === 'user'))).toEqual(['parent_tool_use_id']);
        expect(result['parent_tool_use_id']).toBe(started['tool_use_id']);
        expect(onlySession()[1].answers).toMatchObject([{ behavior: 'allow', updatedInput: sentBack(ONE) }]);
        // Asked once a process: K17's later `result` frames bring no second question.
        fake.prompt('Reply with the single word ok. Use no tools.', 2);
        await fake.next((line) => isResult(line) && fake.lines.filter(isResult).length === 3);
        expect(fake.lines.filter(isAsk)).toHaveLength(1);
      });

      it('unconfirmed: it asks after the `result`, and no result follows fat-g’s reply: the worker’s progress frame does, K17’s own', async () => {
        setControl({ workerAsks: 'unconfirmed' });
        const fake = await session();
        fake.prompt(promptOf(SELF));
        const started = await fake.next(isType('system', 'task_started'));
        const request = await fake.next(isAsk);
        expect(fake.lines.indexOf(request)).toBeGreaterThan(fake.lines.findIndex(isResult));
        await fake.during(100);
        const before = fake.lines.length;
        fake.send(allow(ONE, request));
        const next = await fake.next((line) => fake.lines.indexOf(line) >= before);
        expect(await fake.during(250)).toEqual([]);
        // One frame, the capture's own but for ids: the worker goes on, and says nothing of its question.
        expect(fake.lines.slice(before)).toEqual([next]);
        expect(next).toMatchObject({ type: 'system', subtype: 'task_progress', task_id: started['task_id'], tool_use_id: started['tool_use_id'] });
        expect(capturedHas(next)).toBe(true);
        expect(fake.lines.some(resultOf(at(request, 'request', 'tool_use_id')))).toBe(false);
        expect(onlySession()[1].answers).toHaveLength(1);
      });

      it('asks nothing where no worker is open at the turn’s `result`: T1, and T3 whose worker ended with its turn', async () => {
        for (const name of ['m19-t1-basic', 'm19-t3-subagent']) {
          setControl({ workerAsks: 'after' });
          const fake = await session();
          fake.prompt(promptOf(name));
          await completed(fake);
          expect(sent(fake), name).toEqual(expected(name));
          await fake.end();
        }
      }, 60_000);
    });
  });
});

// ── M22: a launch, the mode in force, and a request for a tool (V11; C5, C7, C21, C35) ────────
describe('a launch, its mode, and a request for a tool (M22: V11; C5, C7, C21, C35)', () => {
  const ONCE = 'm22-approve-once';
  const GRANTED = 'm22-approve-session';
  const FILES = 'm22-approve-files';
  const WORKER = 'm22-approve-worker';
  const EDITS = 'm22-mode-accept-edits';
  const INHERITED = 'm22-inherited';
  const T1 = 'm19-t1-basic';
  /** fat-g's two messages for a deny (Design 6): its own refusal, which is the captures' text byte for byte, and the user's. */
  const REFUSAL = 'This action is not available in this session.';
  const DENIED = 'The user denied this action in fat-g';
  /** A launch's tools as an `init` names them, in the captures' own order. */
  const REPORTED: Record<string, string[]> = {
    [READING_TOOLS]: ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read'],
    [EXECUTION_TOOLS]: ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'],
  };
  /** M22's captures were taken under the eight tools that came before the plan's (M22b, C8), and their `init`s name those. */
  const EIGHT = 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit';
  const REPORTED_EIGHT = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
  const launch = (mode = 'default', tools: string = EXECUTION_TOOLS, extra: readonly string[] = ['--model', 'sonnet', '--effort', 'low']): string[] => [...chatFixedArgs(mode, tools), ...extra];
  /** A process as fat-g opens one under a mode that asks: `default`, with the tools that act. */
  const acting = (control: Json = {}, mode = 'default'): Promise<Fake> => { setControl(control); return session(launch(mode)); };
  const isApproval = (line: Json): boolean => line['type'] === 'control_request' && at(line, 'request', 'subtype') === 'can_use_tool' && at(line, 'request', 'tool_name') !== 'AskUserQuestion';
  const isCancel = (line: Json): boolean => line['type'] === 'control_cancel_request';
  const isInit = isType('system', 'init');
  const isStatus = (line: Json): boolean => line['type'] === 'system' && line['subtype'] === 'status' && 'permissionMode' in line;
  const isClosing = (n: number) => (line: Json): boolean => line['type'] === 'command_lifecycle' && line['command_uuid'] === PROMPT_ID(n) && (line['state'] === 'completed' || line['state'] === 'cancelled');
  const replyTo = (id: string) => (line: Json): boolean => line['type'] === 'control_response' && at(line, 'response', 'request_id') === id;
  const resultOf = (toolUseId: unknown) => (line: Json): boolean => line['type'] === 'user' && at(line, 'message', 'content', 0, 'type') === 'tool_result' && at(line, 'message', 'content', 0, 'tool_use_id') === toolUseId;
  const isReplyEnd = (line: Json): boolean => isStream(line) && line['parent_tool_use_id'] === null && ['content_block_stop', 'message_delta', 'message_stop'].includes(String(at(line, 'event', 'type')));
  const builtIn = (line: Json): string[] => (line['tools'] as string[]).filter((name) => !name.startsWith('mcp__'));
  const configured = (line: Json): string[] => (line['tools'] as string[]).filter((name) => name.startsWith('mcp__'));
  /** A capture's first `init`, as it was taken. */
  const initOf = (name: string): Json => (capture(name).frames.find((entry) => entry.dir === 'recv' && isInit(entry.frame)) as Captured).frame;
  const inProject = (value: unknown): unknown => (typeof value === 'string' ? value.replaceAll('<scratch>', project)
    : Array.isArray(value) ? value.map(inProject)
      : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, inProject(item)])) : value);
  const cmp = (entries: readonly Captured[]): string[] => entries.map((entry) => comparable(entry.frame, '<never>'));
  const one = (entry: Captured): string => comparable(entry.frame, '<never>');
  /** A frame as it compares with the launch left in it: what a test of the launch itself reads. */
  const plain = (frame: Json, folder: string): Json => mask(frame['type'] === 'control_response' ? { ...frame, response: { ...(frame['response'] as Json), request_id: '<id>' } } : frame, folder) as Json;
  const original = (name: string, match: (frame: Json) => boolean): Json => masked((capture(name).frames.find((entry) => entry.dir === 'recv' && match(entry.frame)) as Captured).frame, '<never>');
  /** The first line that matches, at or after a line of the fake's own. */
  const from = (fake: Fake, start: number, match: (line: Json) => boolean): Promise<Json> => fake.next((line) => fake.lines.indexOf(line) >= start && match(line));

  /** One turn of a capture: what was sent and received from its prompt to the closing frame that names it. */
  function turnOf(name: string, n = 0): Captured[] {
    const first = promptFrames(name)[n] as Captured;
    const frames = capture(name).frames;
    const closing = frames.find((entry) => entry.index > first.index && entry.dir === 'recv' && entry.frame['type'] === 'command_lifecycle' && entry.frame['command_uuid'] === first.frame['uuid'] && (entry.frame['state'] === 'completed' || entry.frame['state'] === 'cancelled')) as Captured;
    return frames.filter((entry) => entry.index > first.index && entry.index <= closing.index);
  }
  const received = (name: string, n = 0): Captured[] => turnOf(name, n).filter((entry) => entry.dir === 'recv');
  /**
   * A turn's received frames around its first request: up to it; the ends of the reply that was being
   * written when it went out, which come whatever is decided; the tool's result; and the rest.
   */
  function around(name: string, n = 0): { upTo: Captured[]; ends: Captured[]; result: Captured; end: Captured[] } {
    const frames = received(name, n);
    const asked = frames.findIndex((entry) => isApproval(entry.frame));
    const rest = frames.slice(asked + 1);
    const started = rest.findIndex((entry) => isStream(entry.frame, 'message_start') && entry.frame['parent_tool_use_id'] === null);
    const ends = rest.filter((entry, index) => isReplyEnd(entry.frame) && (started === -1 || index < started));
    const result = rest.find((entry) => resultOf(at(frames[asked]?.frame, 'request', 'tool_use_id'))(entry.frame)) as Captured;
    return { upTo: frames.slice(0, asked + 1), ends, result, end: rest.filter((entry) => !ends.includes(entry) && entry !== result) };
  }

  const answerTo = (request: Json, response: Json): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response } });
  /** fat-g's decisions (Design 6): the input as it came; the same with the CLI's own rules, for this session; and a deny with its message. */
  const allow = (request: Json, more: Json = {}): Json => answerTo(request, { behavior: 'allow', updatedInput: at(request, 'request', 'input'), ...more });
  const sessionGrant = (request: Json): Json[] => (at(request, 'request', 'permission_suggestions') as Json[]).filter((entry) => entry['type'] === 'addRules').map((entry) => ({ ...entry, destination: 'session' }));
  const allowForSession = (request: Json): Json => allow(request, { updatedPermissions: sessionGrant(request) });
  const deny = (request: Json, message: string = REFUSAL): Json => answerTo(request, { behavior: 'deny', message });
  /** A turn up to its first request. */
  const asking = (fake: Fake, prompt: string, n = 1): Promise<Json> => { const start = fake.lines.length; fake.prompt(prompt, n); return from(fake, start, isApproval); };
  /** The nth request of a process, once it has come. */
  const request = async (fake: Fake, nth: number): Promise<Json> => { await fake.next(() => fake.lines.filter(isApproval).length >= nth); return fake.lines.filter(isApproval)[nth - 1] as Json; };
  const ended = async (fake: Fake, n = 1): Promise<void> => { await fake.next(isClosing(n)); await fake.during(60); };
  /** A file of the project as a capture names it — the folder, then the separator the capture was taken with — and as the fake notes one it wrote. */
  const named = (name: string): string => `${project}\\${name}`;
  const wrote = (...names: string[]): string[] => names.map((name) => path.join(project, name));
  const files = (): string[] => readdirSync(project).sort();
  const made = (name: string): string | null => { try { return readFileSync(path.join(project, name), 'utf8'); } catch { return null; } };
  const marker = (): string => path.join(fixture, 'unexpected-permission-update');
  const notes = (fake: Fake): SessionEntry => onlySessionOf(fake.pid);

  /**
   * One turn of a capture, sent what its capture shows sent, each when the frames before it have
   * come: the capture's own reply to a request, under the request's own id, or its interrupt.
   */
  async function replayed(fake: Fake, name: string, n = 0, promptN = 1): Promise<Json[]> {
    const start = fake.lines.length;
    const turn = turnOf(name, n);
    fake.prompt(promptsOf(name)[n] as string, promptN);
    for (const entry of turn.filter((item) => item.dir === 'send')) {
      const before = turn.filter((item) => item.dir === 'recv' && item.index < entry.index).length;
      await fake.next(() => fake.lines.length - start >= before);
      if (entry.frame['type'] === 'control_response') {
        const asked = fake.lines.slice(start).filter(isApproval).at(-1) as Json;
        fake.send({ type: 'control_response', response: { ...(inProject(entry.frame['response']) as Json), request_id: asked['request_id'] } });
      } else if (at(entry.frame, 'request', 'subtype') === 'interrupt') fake.interrupt();
    }
    await from(fake, start, isClosing(promptN));
    await fake.during(60);
    return fake.lines.slice(start);
  }
  const compared = (lines: readonly Json[]): string[] => lines.map((line) => comparable(line, project));

  it('names K2’s six that are turns, each of their nine prompts a turn of its own, and the two captures beside them that are none', () => {
    expect(APPROVAL_CAPTURES.map((name) => promptFrames(name).length)).toEqual([2, 2, 1, 1, 2, 1]);
    expect([APPROVAL_RESUMED, MODES_SET]).toEqual(['m22-approve-resumed', 'm22-modes-set']);
    expect(promptFrames(APPROVAL_RESUMED)).toHaveLength(1);
    expect(promptFrames(MODES_SET)).toEqual([]);
    for (const name of [...APPROVAL_CAPTURES, APPROVAL_RESUMED]) {
      // Taken under the launch with the eight tools, in the mode that asks.
      const { args } = (capture(name) as unknown as { launch: { args: string[] } }).launch;
      expect([args[args.indexOf('--permission-mode') + 1], args[args.indexOf('--tools') + 1]], name).toEqual(['default', EIGHT]);
      for (const [n, prompt] of promptFrames(name).entries()) {
        // Every prompt carries an id, and its turn is the frames up to the closing frame that names it.
        expect(typeof prompt.frame['uuid'], name).toBe('string');
        expect(received(name, n).at(-1)?.frame, name).toMatchObject({ type: 'command_lifecycle', command_uuid: prompt.frame['uuid'] });
        expect(received(name, n).filter((entry) => entry.frame['type'] === 'command_lifecycle').map((entry) => entry.frame['state']).slice(0, 2), name).toEqual(['queued', 'started']);
      }
    }
    // What each turn asks for, and what its capture answered: the request's tool, then `allow`, `deny`, or `stop` where an interrupt came in an answer's place.
    const shown = (name: string, n: number): string[] => turnOf(name, n).filter((entry) => entry.dir === 'recv' && isApproval(entry.frame)).map((asked) => {
      const answer = turnOf(name, n).find((entry) => entry.dir === 'send' && at(entry.frame, 'response', 'request_id') === asked.frame['request_id']);
      const updates = at(answer?.frame, 'response', 'response', 'updatedPermissions') as Json[] | undefined;
      return `${String(at(asked.frame, 'request', 'tool_name'))} ${answer === undefined ? 'stop' : String(at(answer.frame, 'response', 'response', 'behavior'))}${updates === undefined ? '' : ` ${updates.map((update) => `${String(update['type'])}@${String(update['destination'])}`).join(',')}`}`;
    });
    expect(Object.fromEntries([...APPROVAL_CAPTURES, APPROVAL_RESUMED].flatMap((name) => promptFrames(name).map((_, n) => [n === 0 ? name : `${name}#${n + 1}`, shown(name, n)])))).toEqual({
      'm22-approve-once': ['Bash allow'], 'm22-approve-once#2': ['Bash deny'],
      'm22-approve-session': ['Bash allow addRules@session'], 'm22-approve-session#2': [],
      'm22-approve-files': ['Write allow', 'Edit allow', 'Write allow', 'Write allow'],
      'm22-approve-worker': ['Bash allow'],
      'm22-mode-accept-edits': [], 'm22-mode-accept-edits#2': ['Write stop'],
      'm22-inherited': [],
      'm22-approve-resumed': ['Bash allow addRules@localSettings'],
    });
    // The tools an `init` names under each launch are the captures' own: M21's under five tools, K2's under eight.
    expect(builtIn(initOf('m21-question-one'))).toEqual(REPORTED[READING_TOOLS]);
    for (const name of [...APPROVAL_CAPTURES, APPROVAL_RESUMED]) expect(builtIn(initOf(name)), name).toEqual(REPORTED_EIGHT);
  });

  describe('what a process reports is its launch’s (C5, C7, C45)', () => {
    it.each(CHAT_LAUNCHES.map((entry) => [entry.mode, entry.tools] as const))('launched under %s with %s: `initialize` names the word, and every `init` the word and the tools, the capture’s configured ones after them', async (mode, tools) => {
      const fake = start(launch(mode, tools));
      const reply = await fake.initialize();
      // The captured reply, that one field set.
      const own = (capture('m16-t1-basic').frames.find((entry) => entry.index === 1) as Captured).frame;
      expect(at(reply, 'response', 'response', 'current_permission_mode')).toBe(mode);
      expect(differences(plain(reply, project), plain(own, '<never>'))).toEqual(mode === 'default' ? [] : ['response.response.current_permission_mode']);
      // And the word is the one K2's launch under that mode answered with.
      if (mode !== 'default') expect(at(capture(`m22-modes-launch-${mode}`).frames.find((entry) => entry.index === 1)?.frame, 'response', 'response', 'current_permission_mode')).toBe(mode);
      // Two turns: each `init` says the same.
      fake.prompt(promptOf(T1), 1);
      await ended(fake, 1);
      fake.prompt(promptOf('m19-command-refused'), 2);
      await ended(fake, 2);
      const inits = fake.lines.filter(isInit);
      expect(inits).toHaveLength(2);
      for (const [n, name] of [T1, 'm19-command-refused'].entries()) {
        const captured = initOf(name);
        expect(inits[n]?.['permissionMode'], name).toBe(mode);
        // The launch's own names, then the capture's configured ones, each under an id of this process's.
        expect(builtIn(inits[n] as Json), name).toEqual(REPORTED[tools]);
        expect(mask(inits[n]?.['tools'], project), name).toEqual(mask([...(REPORTED[tools] as string[]), ...configured(captured)], '<never>'));
        expect(configured(captured), name).toHaveLength(8);
        // Nothing else of the frame is another's than its capture's.
        expect(differences(plain(inits[n] as Json, project), plain(captured, '<never>')), name).toEqual(mode === 'default' ? ['tools'] : ['tools', 'permissionMode']);
      }
      expect(sent(fake)).toEqual([...expected(T1), ...expected('m19-command-refused')]);
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(notes(fake).launches).toMatchObject([{ pid: fake.pid, mode, tools: tools.split(','), args: launch(mode, tools), model: 'sonnet', effort: 'low' }]);
      expect(await fake.end()).toBe(0);
    });

    it('a process that resumes a session names its own launch’s word, whatever the first was launched under', async () => {
      const first = await session();
      first.prompt(promptOf(T1));
      await ended(first);
      const [id] = onlySession();
      await first.end();
      const again = start(launch('acceptEdits', EXECUTION_TOOLS, ['--model', 'sonnet', '--resume', id]));
      const reply = await again.initialize();
      const resumed = (capture('m16-resume').frames.find((entry) => entry.index === 1) as Captured).frame;
      expect(differences(plain(reply, project), plain(resumed, '<never>'))).toEqual(['response.response.current_permission_mode']);
      expect(at(reply, 'response', 'response', 'current_permission_mode')).toBe('acceptEdits');
      again.prompt(promptOf(T1), 2);
      expect(await from(again, 1, isInit)).toMatchObject({ permissionMode: 'acceptEdits', session_id: id });
      expect(onlySession()[1].launches.map((entry) => [entry.mode, entry.tools.length, entry.resume])).toEqual([['default', 5, null], ['acceptEdits', 11, id]]);
    });

    it('replays M16’s to M21’s turns as it did, under every launch: a request it is refused, and a question it is answered', async () => {
      const sentBack = at(capture('m21-question-one').frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'control_response')?.frame, 'response', 'response', 'updatedInput') as Json;
      for (const { mode, tools } of CHAT_LAUNCHES) {
        setControl({});
        const fake = await session(launch(mode, tools));
        // K23's request, for a read outside the folder: refused in fat-g's words, it is the capture's own turn, as it was.
        fake.send(deny(await asking(fake, promptOf('m16-chat-request'), 1)));
        await ended(fake, 1);
        const start = fake.lines.length;
        fake.prompt(promptOf('m21-question-one'), 2);
        const asked = await from(fake, start, (line) => at(line, 'request', 'tool_name') === 'AskUserQuestion');
        fake.send(answerTo(asked, { behavior: 'allow', updatedInput: sentBack }));
        await ended(fake, 2);
        expect(sent(fake), mode).toEqual([...expected('m16-chat-request'), ...expected('m21-question-one')]);
        expect(fake.lines.every(capturedHas), mode).toBe(true);
        expect(notes(fake), mode).toMatchObject({ turns: ['m16-chat-request', 'm21-question-one'], writes: [], grants: [], modes: [] });
        expect(await fake.end(), mode).toBe(0);
      }
      expect(readdirSync(project)).toEqual([]);
    }, 120_000);
  });

  describe('a mode set with `set_permission_mode` (C5, C74, C90)', () => {
    /** What K2's capture shows received for the nth set to that mode: its reply, and its status frame where it has one. */
    function shown(mode: string, nth = 0, name: string = MODES_SET): Captured[] {
      const frames = capture(name).frames;
      const set = frames.filter((entry) => entry.dir === 'send' && at(entry.frame, 'request', 'subtype') === 'set_permission_mode' && at(entry.frame, 'request', 'mode') === mode)[nth] as Captured;
      const next = frames.find((entry) => entry.dir === 'send' && entry.index > set.index);
      return frames.filter((entry) => entry.dir === 'recv' && entry.index > set.index && (next === undefined || entry.index < next.index));
    }
    /** A set, to its reply and whatever came with it or soon after. */
    async function set(fake: Fake, mode: string): Promise<{ id: string; lines: Json[] }> {
      const start = fake.lines.length;
      const id = fake.setMode(mode);
      await from(fake, start, replyTo(id));
      await fake.during(120);
      return { id, lines: fake.lines.slice(start) };
    }
    /**
     * The mode in force, as the next turn's `init` names it: the turn of a command the CLI answers by
     * itself, seven frames, the last of them a rate-limit frame that follows its closing one.
     */
    async function inForce(fake: Fake, n: number): Promise<unknown> {
      const start = fake.lines.length;
      fake.prompt(promptOf('m19-command-refused'), n);
      const init = await from(fake, start, isInit);
      await from(fake, start, isClosing(n));
      await from(fake, start, isType('rate_limit_event'));
      return init['permissionMode'];
    }
    const sameRead = (fake: Fake, lines: readonly Json[]): boolean => new Set(lines.map((line) => fake.reads[fake.lines.indexOf(line)])).size === 1;

    it('is answered as K2’s capture shows: the reply and the status frame that names the mode, in one write, and that mode is in force from then on', async () => {
      // The capture's own: a reply and a frame for a change, in the same millisecond.
      expect(shown('acceptEdits').map((entry) => [kindOf(entry.frame), entry.ms])).toEqual([['control_response', 1410], ['status', 1410]]);
      const fake = await acting();
      for (const [n, mode] of ['acceptEdits', 'auto', 'default', 'plan', 'dontAsk'].entries()) {
        const { id, lines } = await set(fake, mode);
        expect(compared(lines), mode).toEqual(cmp(shown(mode)));
        expect(lines, mode).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: id, response: { mode } } }, { type: 'system', subtype: 'status', status: null, permissionMode: mode, uuid: lines[1]?.['uuid'], session_id: onlySession()[0] }]);
        // One write: the two lines came in one read.
        expect(sameRead(fake, lines), mode).toBe(true);
        expect(await inForce(fake, n + 1), mode).toBe(mode);
      }
      expect(notes(fake).modes).toEqual(['acceptEdits', 'auto', 'default', 'plan', 'dontAsk'].map((mode) => ({ mode, turn: false, answered: 'success' })));
      expect(existsSync(path.join(fixture, 'unexpected-chat-request'))).toBe(false);
      expect(fake.lines.every(capturedHas)).toBe(true);
    });

    it('a set to the mode in force gets the reply and no status frame', async () => {
      const fake = await acting();
      // The launch's own word, as the capture's last set shows it.
      const same = await set(fake, 'default');
      expect(compared(same.lines)).toEqual(cmp(shown('default', 4)));
      expect(same.lines.map(kindOf)).toEqual(['control_response']);
      // And a word set twice: the second time, the reply alone.
      expect((await set(fake, 'acceptEdits')).lines.map(kindOf)).toEqual(['control_response', 'status']);
      const again = await set(fake, 'acceptEdits');
      expect(again.lines).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: again.id, response: { mode: 'acceptEdits' } } }]);
      expect(await inForce(fake, 1)).toBe('acceptEdits');
      expect(notes(fake).modes.map((entry) => entry.answered)).toEqual(['success', 'success', 'success']);
    });

    it('`bypassPermissions` is refused with the capture’s error in a process not launched with it, and changes nothing; in one launched with it, it is left and entered again', async () => {
      const fake = await acting({}, 'acceptEdits');
      const refused = await set(fake, 'bypassPermissions');
      expect(compared(refused.lines)).toEqual(cmp(shown('bypassPermissions')));
      expect(refused.lines).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: refused.id, error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions' } }]);
      expect(await inForce(fake, 1)).toBe('acceptEdits');
      expect(notes(fake).modes).toEqual([{ mode: 'bypassPermissions', turn: false, answered: 'error' }]);
      await fake.end();

      // K2's launch under that mode: out of it and in again, each with its status frame.
      const bypass = await acting({}, 'bypassPermissions');
      const out = await set(bypass, 'default');
      expect(compared(out.lines)).toEqual(cmp(shown('default', 0, 'm22-modes-launch-bypassPermissions')));
      expect(await inForce(bypass, 1)).toBe('default');
      const back = await set(bypass, 'bypassPermissions');
      expect(compared(back.lines)).toEqual(cmp(shown('bypassPermissions', 0, 'm22-modes-launch-bypassPermissions')));
      expect(back.lines.map(kindOf)).toEqual(['control_response', 'status']);
      expect(await inForce(bypass, 2)).toBe('bypassPermissions');
      expect(notes(bypass).modes.map((entry) => entry.answered)).toEqual(['success', 'success']);
    });

    it('is answered while a turn runs too, and notes that one was: fat-g sends none then', async () => {
      const fake = await acting({ holdResult: 5000 });
      fake.prompt(promptOf(T1));
      await fake.next(ownText);
      const { lines } = await set(fake, 'acceptEdits');
      expect(lines.filter((line) => line['type'] === 'control_response' || isStatus(line)).map(kindOf)).toEqual(['control_response', 'status']);
      expect(notes(fake).modes).toEqual([{ mode: 'acceptEdits', turn: true, answered: 'success' }]);
    });

    it('a word no capture shows set, or none, is not answered: it is marked as a request a chat session never sends', async () => {
      const fake = await acting();
      fake.setMode('everything');
      fake.send({ type: 'control_request', request_id: 'fatg_x', request: { subtype: 'set_permission_mode' } });
      expect(await fake.during(200)).toEqual([]);
      expect(readFileSync(path.join(fixture, 'unexpected-chat-request'), 'utf8')).toBe(String(fake.pid));
      expect(notes(fake).modes).toEqual([{ mode: 'everything', turn: false, answered: 'none' }, { mode: null, turn: false, answered: 'none' }]);
      expect(await inForce(fake, 1)).toBe('default');
    });

    describe('the controls, each one named change (C35)', () => {
      const reply = (): Json => masked((shown('acceptEdits')[0] as Captured).frame, '<never>');
      const status = (): Json => masked((shown('acceptEdits')[1] as Captured).frame, '<never>');

      it('modeReplyOther: the reply names `plan` in place of the mode asked for, and its status frame names the mode asked for', async () => {
        const fake = await acting({ modeReplyOther: true });
        const { lines } = await set(fake, 'acceptEdits');
        expect(lines.map(kindOf)).toEqual(['control_response', 'status']);
        expect(differences(masked(lines[0] as Json, project), reply())).toEqual(['response.response.mode']);
        expect(at(lines[0], 'response', 'response', 'mode')).toBe('plan');
        expect(masked(lines[1] as Json, project)).toEqual(status());
        expect(sameRead(fake, lines)).toBe(true);
        // What the CLI did is what its frame says: the mode asked for is in force.
        expect(await inForce(fake, 1)).toBe('acceptEdits');
        // A set to the mode in force has its reply alone, and that names another too.
        const same = await set(fake, 'acceptEdits');
        expect(same.lines.map((line) => at(line, 'response', 'response', 'mode'))).toEqual(['plan']);
      });

      it('statusApart: the reply and the status frame in two writes, the frame after a gap; a number is the gap', async () => {
        const fake = await acting({ statusApart: true });
        const begun = fake.lines.length;
        const first = await from(fake, begun, replyTo(fake.setMode('acceptEdits')));
        const second = await from(fake, begun, isStatus);
        expect(fake.lines.slice(begun)).toEqual([first, second]);
        expect([first, second].map((line) => masked(line, project))).toEqual([reply(), status()]);
        // Two writes: the frame came in a later read than the reply did.
        expect(fake.reads[fake.lines.indexOf(second)]).toBeGreaterThan(fake.reads[fake.lines.indexOf(first)] as number);
        // The mode is in force as soon as the set is taken: what comes apart is what is reported.
        expect(await inForce(fake, 1)).toBe('acceptEdits');
        // A number is the gap; and the word stays until the file is rewritten: each set is answered so.
        setControl({ statusApart: 700 });
        const start = fake.lines.length;
        const id = fake.setMode('auto');
        await from(fake, start, replyTo(id));
        expect(await fake.during(250)).toEqual([]);
        expect(await from(fake, start, isStatus)).toMatchObject({ permissionMode: 'auto' });
        expect(fake.lines.slice(start).map(kindOf)).toEqual(['control_response', 'status']);
        expect(await inForce(fake, 2)).toBe('auto');
      });

      it('statusFirst: the status frame before the reply, in one write', async () => {
        const fake = await acting({ statusFirst: true });
        const { lines } = await set(fake, 'acceptEdits');
        expect(lines.map((line) => masked(line, project))).toEqual([status(), reply()]);
        expect(sameRead(fake, lines)).toBe(true);
        expect(await inForce(fake, 1)).toBe('acceptEdits');
      });

      it('statusOther: the status frame names `plan`, and the reply is as captured', async () => {
        const fake = await acting({ statusOther: true });
        const { lines } = await set(fake, 'acceptEdits');
        expect(masked(lines[0] as Json, project)).toEqual(reply());
        expect(differences(masked(lines[1] as Json, project), status())).toEqual(['permissionMode']);
        expect(lines[1]?.['permissionMode']).toBe('plan');
        expect(sameRead(fake, lines)).toBe(true);
        expect(await inForce(fake, 1)).toBe('acceptEdits');
      });

      it('modeRefused: a set is answered with the capture’s error reply, whatever the mode, and changes nothing; taken once', async () => {
        const fake = await acting({ modeRefused: 1 });
        const refused = await set(fake, 'acceptEdits');
        expect(compared(refused.lines)).toEqual(cmp(shown('bypassPermissions')));
        expect(at(refused.lines[0], 'response', 'subtype')).toBe('error');
        expect(await inForce(fake, 1)).toBe('default');
        expect(readControlFile()).toEqual({ modeRefused: 0 });
        expect((await set(fake, 'acceptEdits')).lines.map(kindOf)).toEqual(['control_response', 'status']);
        expect(await inForce(fake, 2)).toBe('acceptEdits');
        expect(notes(fake).modes).toEqual([{ mode: 'acceptEdits', turn: false, answered: 'error' }, { mode: 'acceptEdits', turn: false, answered: 'success' }]);
      });

      it('hang mode: a set is never answered, and changes nothing', async () => {
        const fake = await acting({ hang: 'mode' });
        fake.setMode('acceptEdits');
        expect(await fake.during(250)).toEqual([]);
        expect(notes(fake).modes).toEqual([{ mode: 'acceptEdits', turn: false, answered: 'none' }]);
        expect(existsSync(path.join(fixture, 'unexpected-chat-request'))).toBe(false);
        setControl({});
        expect(await inForce(fake, 1)).toBe('default');
      });

      it('initOtherMode: the next `init` names another mode than the one in force, once', async () => {
        const fake = await acting({ initOtherMode: 1 });
        fake.prompt(promptOf(T1), 1);
        const first = await fake.next(isInit);
        // Its own capture's frame but for the word: under `default`, `acceptEdits`.
        expect(first['permissionMode']).toBe('acceptEdits');
        expect(differences(masked(first, project), original(T1, isInit))).toEqual([]);
        expect(builtIn(first)).toEqual(REPORTED[EXECUTION_TOOLS]);
        await ended(fake, 1);
        expect(readControlFile()).toEqual({ initOtherMode: 0 });
        expect(await inForce(fake, 2)).toBe('default');
        // With `acceptEdits` in force, the other is `default`.
        await set(fake, 'acceptEdits');
        setControl({ initOtherMode: 1 });
        expect(await inForce(fake, 3)).toBe('default');
        expect(await inForce(fake, 4)).toBe('acceptEdits');
      });
    });
  });

  describe('K2’s captures, each replayed for its own prompts with its own answers (C35)', () => {
    it('m22-approve-once: a command allowed once, which makes its file, and asked for again in the next turn and denied', async () => {
      const fake = await acting();
      const first = await replayed(fake, ONCE, 0, 1);
      // It waited at the request, which names the tool use of the frame before it, under ids of this process's own.
      const asked = first.find(isApproval) as Json;
      expect(at(asked, 'request', 'tool_use_id')).toBe(at(first.filter(ownAssistant).at(-2), 'message', 'content', 0, 'id'));
      expect(at(asked, 'request')).toMatchObject({ tool_name: 'Bash', input: { command: 'touch bash-once.txt' }, blocked_path: named('bash-once.txt') });
      expect(compared(first)).toEqual(cmp(received(ONCE, 0)));
      // Allowed: the file is there, made by the fake in the folder it was started in.
      expect(made('bash-once.txt')).toBe('');
      const second = await replayed(fake, ONCE, 1, 2);
      expect(compared(second)).toEqual(cmp(received(ONCE, 1)));
      // No rule was granted: the same command was asked for again, by a request of its own.
      expect(second.filter(isApproval)).toHaveLength(1);
      expect(at(second.find(isApproval), 'request', 'input')).toEqual(at(asked, 'request', 'input'));
      expect(second.find(isApproval)?.['request_id']).not.toBe(asked['request_id']);
      // Denied: an error result with fat-g's own words, the model's line, and a turn that ends well.
      expect(at(second.find(resultOf(at(second.find(isApproval), 'request', 'tool_use_id'))), 'message', 'content', 0)).toMatchObject({ is_error: true, content: REFUSAL });
      expect(second.find(isResult)).toMatchObject({ is_error: false, subtype: 'success' });
      // But for ids, times, the folder and the launch, every frame of the two turns is its capture's.
      expect(sent(fake)).toEqual([...cmp(received(ONCE, 0)), ...cmp(received(ONCE, 1))]);
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(JSON.stringify(fake.lines)).not.toMatch(/<scratch>|<session-\d+>|<tool-use-\d+>|<request-\d+>/);
      expect(notes(fake)).toMatchObject({
        turns: [ONCE, `${ONCE}#2`], writes: wrote('bash-once.txt'), grants: [], modes: [],
        answers: [{ subtype: 'success', behavior: 'allow', message: null, error: null, updatedInput: at(asked, 'request', 'input') }, { subtype: 'success', behavior: 'deny', message: REFUSAL, error: null }],
      });
      expect(files()).toEqual(['bash-once.txt']);
      expect(await fake.end()).toBe(0);
    });

    it('a second prompt alone chooses its own turn, in any process: under the reading launch, the request refused as fat-g refuses one there', async () => {
      // The launch that offers no `Bash`: fat-g's own refusal is the capture's answer.
      const fake = await session();
      const turn = await replayed(fake, ONCE, 1);
      expect(compared(turn)).toEqual(cmp(received(ONCE, 1)));
      expect(builtIn(turn.find(isInit) as Json)).toEqual(REPORTED[READING_TOOLS]);
      expect(notes(fake)).toMatchObject({ turns: [`${ONCE}#2`], writes: [] });
      expect(readdirSync(project)).toEqual([]);
    });

    it('m22-approve-session, and m22-approve-resumed: a rule for this session lets the command run unasked in that process, and a process that resumes the session is asked again', async () => {
      const fake = await acting();
      const first = await replayed(fake, GRANTED, 0, 1);
      expect(compared(first)).toEqual(cmp(received(GRANTED, 0)));
      const asked = first.find(isApproval) as Json;
      // The reply the capture shows: the allow, with the CLI's own rule sent back for the session.
      expect(notes(fake).answers).toEqual([{ subtype: 'success', behavior: 'allow', message: null, error: null, updatedInput: at(asked, 'request', 'input'), updatedPermissions: sessionGrant(asked) }]);
      expect(notes(fake).grants).toEqual([{ toolName: 'Bash', ruleContent: 'touch bash-session.txt' }]);
      // The shared prompt, in the process that holds the rule: `-session`'s second turn, which shows no request.
      const second = await replayed(fake, GRANTED, 1, 2);
      expect(compared(second)).toEqual(cmp(received(GRANTED, 1)));
      expect(second.some(isApproval)).toBe(false);
      expect(at(second.find(isResult), 'is_error')).toBe(false);
      const [id, entry] = onlySession();
      expect(entry).toMatchObject({ turns: [GRANTED, `${GRANTED}#2`], writes: wrote('bash-session.txt') });
      expect(existsSync(marker())).toBe(false);
      expect(await fake.end()).toBe(0);

      // The same prompt in a process that resumed the session: it holds no rule, and `-resumed`'s turn asks again.
      const again = start(launch('default', EXECUTION_TOOLS, ['--model', 'sonnet', '--effort', 'low', '--resume', id]));
      await again.initialize();
      expect(promptsOf(APPROVAL_RESUMED)[0]).toBe(promptsOf(GRANTED)[1]);
      const resumed = await replayed(again, APPROVAL_RESUMED, 0, 3);
      expect(compared(resumed)).toEqual(cmp(received(APPROVAL_RESUMED)));
      expect(resumed.filter(isApproval)).toHaveLength(1);
      // That capture's `init` shows no configured tool: its list is the launch's alone.
      expect(resumed.find(isInit)?.['tools']).toEqual(REPORTED[EXECUTION_TOOLS]);
      expect(again.lines.every(capturedHas)).toBe(true);
      // Its own answer is the suggestion as the CLI wrote it, at `localSettings`, which K2 saw written into the
      // project: nothing fat-g sends. It is allowed, noted and marked, and it records no rule and writes no settings.
      expect(readFileSync(marker(), 'utf8')).toBe(String(again.pid));
      const after = onlySession()[1];
      expect(after.turns).toEqual([GRANTED, `${GRANTED}#2`, APPROVAL_RESUMED]);
      expect(after.grants).toEqual([{ toolName: 'Bash', ruleContent: 'touch bash-session.txt' }]);
      expect(at(after.answers.at(-1), 'updatedPermissions', 0, 'destination')).toBe('localSettings');
      // The file was there already: nothing was made or changed.
      expect(after.writes).toEqual(wrote('bash-session.txt'));
      expect(files()).toEqual(['bash-session.txt']);
    });

    it('m22-approve-files: a file written, edited, and two more written, each asked for and allowed, each change made in the folder', async () => {
      const fake = await acting();
      const turn = await replayed(fake, FILES);
      expect(compared(turn)).toEqual(cmp(received(FILES)));
      expect(fake.lines.every(capturedHas)).toBe(true);
      const asked = turn.filter(isApproval);
      expect(asked.map((line) => at(line, 'request', 'tool_name'))).toEqual(['Write', 'Edit', 'Write', 'Write']);
      // Each names the tool use of the `assistant` frame before it.
      const used = turn.filter((line) => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'tool_use').map((line) => at(line, 'message', 'content', 0, 'id'));
      expect(asked.map((line) => at(line, 'request', 'tool_use_id'))).toEqual(used);
      // The capture's three folders were one to its publisher, and are one here: the folder the fake was started in.
      expect(asked.map((line) => at(line, 'request', 'input', 'file_path'))).toEqual(['made-inside.txt', 'made-inside.txt', 'made-in-added-root.txt', 'made-outside.txt'].map(named));
      expect(at(asked[3], 'request', 'decision_reason_type')).toBe('workingDir');
      expect([made('made-inside.txt'), made('made-in-added-root.txt'), made('made-outside.txt')]).toEqual(['beta', 'gamma', 'delta']);
      expect(notes(fake)).toMatchObject({ turns: [FILES], grants: [], writes: wrote('made-inside.txt', 'made-inside.txt', 'made-in-added-root.txt', 'made-outside.txt') });
      expect(notes(fake).answers.map((answer) => answer.behavior)).toEqual(['allow', 'allow', 'allow', 'allow']);
      expect(files()).toEqual(['made-in-added-root.txt', 'made-inside.txt', 'made-outside.txt']);
    });

    it('m22-approve-worker: the request names the worker by its task, and comes before the worker’s own frame; allowed, the worker’s frames follow', async () => {
      const fake = await acting();
      const turn = await replayed(fake, WORKER);
      expect(compared(turn)).toEqual(cmp(received(WORKER)));
      expect(fake.lines.every(capturedHas)).toBe(true);
      const started = turn.find(isType('system', 'task_started')) as Json;
      const asked = turn.find(isApproval) as Json;
      // By the worker's task id, which is not the id of the `Agent` tool use that started it.
      expect(at(asked, 'request', 'agent_id')).toBe(started['task_id']);
      expect(at(asked, 'request', 'agent_id')).not.toBe(started['tool_use_id']);
      // Its tool use is the worker's own, in a frame that follows the request.
      const used = turn.find((line) => line['type'] === 'assistant' && at(line, 'message', 'content', 0, 'id') === at(asked, 'request', 'tool_use_id')) as Json;
      expect(used['parent_tool_use_id']).toBe(started['tool_use_id']);
      expect(turn.indexOf(used)).toBe(turn.indexOf(asked) + 1);
      expect(turn.find(resultOf(at(asked, 'request', 'tool_use_id')))).toMatchObject({ parent_tool_use_id: started['tool_use_id'] });
      expect(made('worker-made.txt')).toBe('');
      expect(notes(fake)).toMatchObject({ turns: [WORKER], writes: wrote('worker-made.txt') });
    }, 60_000);

    it('m22-mode-accept-edits: a turn under Accept edits that asks for nothing, and after the mode is set back, a `Write` that asks and is stopped', async () => {
      const fake = await acting();
      const changed = fake.setMode('acceptEdits');
      await fake.next(replyTo(changed));
      await fake.next(isStatus);
      const first = await replayed(fake, EDITS, 0, 1);
      expect(compared(first)).toEqual(cmp(received(EDITS, 0)));
      expect(first.some(isApproval)).toBe(false);
      expect(first.find(isInit)?.['permissionMode']).toBe('acceptEdits');
      // Its tools ran with no request, and a tool use that no reply allowed changes no file of the fake's.
      expect(first.filter((line) => ownAssistant(line) && at(line, 'message', 'content', 0, 'type') === 'tool_use').map((line) => at(line, 'message', 'content', 0, 'name'))).toEqual(['Write', 'Bash', 'Bash']);
      expect(readdirSync(project)).toEqual([]);
      const back = fake.setMode('default');
      await fake.next(replyTo(back));
      const second = await replayed(fake, EDITS, 1, 2);
      expect(compared(second)).toEqual(cmp(received(EDITS, 1)));
      expect(second.find(isInit)?.['permissionMode']).toBe('default');
      // The Stop came while the request waited: the cancel names it, and the result the tool use, as an error.
      const asked = second.find(isApproval) as Json;
      expect(second.filter(isCancel)).toEqual([{ type: 'control_cancel_request', request_id: asked['request_id'] }]);
      expect(at(second.find(resultOf(at(asked, 'request', 'tool_use_id'))), 'message', 'content', 0, 'is_error')).toBe(true);
      expect(second.find(isResult)).toMatchObject({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_tools' });
      expect(second.at(-1)).toMatchObject({ type: 'command_lifecycle', state: 'cancelled', command_uuid: PROMPT_ID(2) });
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(notes(fake)).toMatchObject({ turns: [EDITS, `${EDITS}#2`], writes: [], answers: [], modes: [{ mode: 'acceptEdits', turn: false, answered: 'success' }, { mode: 'default', turn: false, answered: 'success' }], interrupts: [{ inputOpen: true, turn: true, workers: 0 }] });
      expect(readdirSync(project)).toEqual([]);
      // The capture's own second set of `default`, to the mode in force: a reply alone.
      const start = fake.lines.length;
      const same = fake.setMode('default');
      await fake.next(replyTo(same));
      expect(await fake.during(120)).toEqual([]);
      expect(compared(fake.lines.slice(start))).toEqual(cmp(capture(EDITS).frames.filter((entry) => entry.dir === 'recv').slice(-1)));
    });

    it('m22-inherited: a rule that allows, a rule that denies and a configured tool, each with no request: nothing is asked of fat-g', async () => {
      const fake = await acting();
      const turn = await replayed(fake, INHERITED);
      expect(compared(turn)).toEqual(cmp(received(INHERITED)));
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(turn.some(isApproval)).toBe(false);
      // The denial is the CLI's own frame, naming the tool use and the rule as its reason, with an error result after it.
      const denied = turn.find(isType('system', 'permission_denied')) as Json;
      expect(denied).toMatchObject({ tool_name: 'Bash', decision_reason_type: 'rule' });
      expect(at(turn.find(resultOf(denied['tool_use_id'])), 'message', 'content', 0, 'is_error')).toBe(true);
      // Its `init` lists the project's own configured tool after the others, under the launch's built-in ones.
      expect(configured(turn.find(isInit) as Json)).toHaveLength(9);
      expect(builtIn(turn.find(isInit) as Json)).toEqual(REPORTED[EXECUTION_TOOLS]);
      expect(notes(fake)).toMatchObject({ turns: [INHERITED], writes: [], answers: [] });
      expect(readdirSync(project)).toEqual([]);
    });
  });

  describe('a request goes by fat-g’s reply, whatever its capture’s own answer was (C35)', () => {
    it('denied where the capture allowed: the error result, the model’s line, the `result` and the closing frame of K2’s denial, and no file', async () => {
      const allowed = around(ONCE, 0);
      const refused = around(ONCE, 1);
      const fake = await acting();
      const asked = await asking(fake, promptsOf(ONCE)[0] as string);
      expect(await fake.during(150)).toEqual([]);
      fake.send(deny(asked));
      await ended(fake);
      // This turn's own frames to the request; then the denial's result, the ends of the reply this turn was
      // writing, and the denial's own end.
      expect(sent(fake)).toEqual([...cmp(allowed.upTo), one(refused.result), ...cmp(allowed.ends), ...cmp(refused.end)]);
      expect(fake.lines.every(capturedHas)).toBe(true);
      // Each names this turn's own: its tool use, its prompt.
      const result = fake.lines.filter(resultOf(at(asked, 'request', 'tool_use_id')));
      expect(result).toHaveLength(1);
      expect(at(result[0], 'message', 'content', 0)).toEqual({ type: 'tool_result', content: REFUSAL, is_error: true, tool_use_id: at(asked, 'request', 'tool_use_id') });
      expect(fake.lines.filter(isType('command_lifecycle')).map((line) => [line['command_uuid'], line['state']])).toEqual([[PROMPT_ID(1), 'queued'], [PROMPT_ID(1), 'started'], [PROMPT_ID(1), 'completed']]);
      expect(at(fake.lines.find(isResult), 'permission_denials', 0, 'tool_use_id')).toBe(at(asked, 'request', 'tool_use_id'));
      expect(new Set(fake.lines.slice(1).map((line) => line['session_id']).filter((id) => id !== undefined))).toEqual(new Set([onlySession()[0]]));
      expect(notes(fake)).toMatchObject({ writes: [], answers: [{ behavior: 'deny', message: REFUSAL }] });
      expect(readdirSync(project)).toEqual([]);
    });

    it('a deny’s result holds the reply’s own message, as the CLI echoes it: the user’s denial differs from the capture’s frame in that text alone', async () => {
      const refused = around(ONCE, 1);
      const fake = await acting();
      fake.send(deny(await asking(fake, promptsOf(ONCE)[0] as string), DENIED));
      await ended(fake);
      const result = fake.lines.find((line) => line['type'] === 'user' && at(line, 'message', 'content', 0, 'is_error') === true) as Json;
      expect(differences(masked(result, project), masked(refused.result.frame, '<never>'))).toEqual(['message.content', 'tool_use_result']);
      expect([at(result, 'message', 'content', 0, 'content'), result['tool_use_result']]).toEqual([DENIED, `Error: ${DENIED}`]);
      expect(fake.lines.filter((line) => line !== result).every(capturedHas)).toBe(true);
      // And where the capture's own answer was the deny, its own result carries the message the same way.
      const again = await acting();
      again.send(deny(await asking(again, promptsOf(ONCE)[1] as string), DENIED));
      await ended(again);
      const own = again.lines.find((line) => line['type'] === 'user' && at(line, 'message', 'content', 0, 'is_error') === true) as Json;
      expect([at(own, 'message', 'content', 0, 'content'), own['tool_use_result']]).toEqual([DENIED, `Error: ${DENIED}`]);
      expect(sent(again).filter((_, index) => again.lines[index + 1] !== own)).toEqual(cmp(received(ONCE, 1)).filter((frame) => frame !== one(refused.result)));
      // A reply that is no allow at all is a deny, with the capture's own text.
      const failed = await acting();
      const asked = await asking(failed, promptsOf(ONCE)[0] as string);
      failed.send({ type: 'control_response', response: { subtype: 'error', request_id: asked['request_id'], error: 'no' } });
      await ended(failed);
      expect(sent(failed)).toEqual([...cmp(around(ONCE, 0).upTo), one(refused.result), ...cmp(around(ONCE, 0).ends), ...cmp(refused.end)]);
      expect(notes(failed).answers).toEqual([{ subtype: 'error', behavior: null, message: null, error: 'no' }]);
    });

    it('allowed where the capture denied: the tool’s result and the turn’s end of K2’s allowed command, and the file is made', async () => {
      const allowed = around(ONCE, 0);
      const refused = around(ONCE, 1);
      const fake = await acting();
      const asked = await asking(fake, promptsOf(ONCE)[1] as string);
      fake.send(allow(asked));
      await ended(fake);
      expect(sent(fake)).toEqual([...cmp(refused.upTo), ...cmp(refused.ends), one(allowed.result), ...cmp(allowed.end)]);
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(at(fake.lines.find(resultOf(at(asked, 'request', 'tool_use_id'))), 'message', 'content', 0)).toMatchObject({ content: '(Bash completed with no output)', is_error: false });
      expect(fake.lines.filter(isType('command_lifecycle')).every((line) => line['command_uuid'] === PROMPT_ID(1))).toBe(true);
      expect(made('bash-once.txt')).toBe('');
      expect(notes(fake)).toMatchObject({ turns: [`${ONCE}#2`], writes: wrote('bash-once.txt') });
    });

    it('goes so for any capture’s request, M16’s K23 among them: its refused read, allowed, ends as K2’s allowed command does, and its own rule for the session lets it pass unasked', async () => {
      const own = expected('m16-chat-request');
      const upTo = own.slice(0, own.findIndex((frame) => frame.includes('"type":"control_request"')) + 1);
      const allowed = around(ONCE, 0);
      const fake = await acting();
      const asked = await asking(fake, promptOf('m16-chat-request'), 1);
      expect(at(asked, 'request', 'tool_name')).toBe('Read');
      // K23's own suggestion is a rule for the session already: sent back as it came, it is taken.
      fake.send(allowForSession(asked));
      await ended(fake, 1);
      // A capture of whole messages has no reply's ends to send: the result, and the turn's end.
      expect(sent(fake)).toEqual([...upTo, one(allowed.result), ...cmp(allowed.end)]);
      expect(fake.lines.every(capturedHas)).toBe(true);
      // A read changes no file; the rule is this process's, and the same read is not asked for again.
      expect(notes(fake)).toMatchObject({ writes: [], grants: [{ toolName: 'Read', ruleContent: `/${project}/**` }] });
      const begun = fake.lines.length;
      fake.prompt(promptOf('m16-chat-request'), 2);
      await ended(fake, 2);
      expect(sent(fake, begun)).toEqual([...upTo.slice(0, -1), one(allowed.result), ...cmp(allowed.end)]);
      expect(existsSync(marker())).toBe(false);
      expect(files()).toEqual([]);
    });

    it('allowed or denied where the capture shows a Stop: a `Write`’s own result, naming the file this one wrote, or the denial', async () => {
      const stopped = around(EDITS, 1);
      const written = around(FILES);
      const fake = await acting();
      const asked = await asking(fake, promptsOf(EDITS)[1] as string);
      // The ends of the reply came before the wait, as the capture has them.
      await fake.next(() => fake.lines.length >= 1 + stopped.upTo.length + stopped.ends.length);
      expect(await fake.during(150)).toEqual([]);
      fake.send(allow(asked));
      await ended(fake);
      const file = named('made-after-the-restore.txt');
      const result = fake.lines.find(resultOf(at(asked, 'request', 'tool_use_id'))) as Json;
      // K2's result for an allowed `Write`, but for the file and the content it names.
      expect(differences(masked(result, project), masked(written.result.frame, '<never>'))).toEqual(['message.content', 'tool_use_result.filePath', 'tool_use_result.content']);
      expect(at(result, 'message', 'content', 0, 'content')).toBe(String(at(written.result.frame, 'message', 'content', 0, 'content')).replace('<scratch>\\made-inside.txt', file));
      expect(result['tool_use_result']).toMatchObject({ type: 'create', filePath: file, content: 'gamma' });
      expect(sent(fake).filter((_, index) => fake.lines[index + 1] !== result)).toEqual([...cmp(stopped.upTo), ...cmp(stopped.ends), ...cmp(around(ONCE, 0).end)]);
      expect(fake.lines.indexOf(result)).toBe(1 + stopped.upTo.length + stopped.ends.length);
      expect(fake.lines.some(isCancel)).toBe(false);
      expect(made('made-after-the-restore.txt')).toBe('gamma');
      expect(notes(fake)).toMatchObject({ turns: [`${EDITS}#2`], writes: wrote('made-after-the-restore.txt'), interrupts: [] });

      const other = await acting();
      const again = await asking(other, promptsOf(EDITS)[1] as string);
      await other.next(() => other.lines.length >= 1 + stopped.upTo.length + stopped.ends.length);
      other.send(deny(again));
      await ended(other);
      expect(sent(other)).toEqual([...cmp(stopped.upTo), ...cmp(stopped.ends), one(around(ONCE, 1).result), ...cmp(around(ONCE, 1).end)]);
      expect(other.lines.every(capturedHas)).toBe(true);
      expect(notes(other).writes).toEqual([]);
    });

    it('a denial ends the turn there: the second of four requests denied leaves the first change made and asks for no third', async () => {
      const fake = await acting();
      fake.prompt(promptOf(FILES));
      fake.send(allow(await request(fake, 1)));
      const edit = await request(fake, 2);
      fake.send(deny(edit, DENIED));
      await ended(fake);
      expect(fake.lines.filter(isApproval)).toHaveLength(2);
      expect(made('made-inside.txt')).toBe('alpha');
      expect(files()).toEqual(['made-inside.txt']);
      expect(fake.lines.filter(isResult)).toHaveLength(1);
      expect(fake.lines.at(-1)).toMatchObject({ type: 'command_lifecycle', state: 'completed', command_uuid: PROMPT_ID(1) });
      // The ends of the reply that asked for the edit come once, after the refusal.
      const after = fake.lines.slice(fake.lines.indexOf(edit) + 1);
      const own = received(FILES);
      const asked = own.filter((entry) => isApproval(entry.frame))[1] as Captured;
      const ends = own.slice(own.indexOf(asked) + 1, own.findIndex((entry) => resultOf(at(asked.frame, 'request', 'tool_use_id'))(entry.frame))).filter((entry) => isReplyEnd(entry.frame));
      expect(ends.map((entry) => at(entry.frame, 'event', 'type'))).toEqual(['message_delta', 'message_stop']);
      expect(compared(after).slice(1)).toEqual([...cmp(ends), ...cmp(around(ONCE, 1).end)]);
      expect(at(after[0], 'message', 'content', 0)).toMatchObject({ is_error: true, content: DENIED, tool_use_id: at(edit, 'request', 'tool_use_id') });
      expect(notes(fake).writes).toEqual(wrote('made-inside.txt'));
    });

    it('a worker’s request denied: the turn goes on as captured, the worker told of the refusal in place of its tool’s result', async () => {
      const fake = await acting();
      const asked = await asking(fake, promptOf(WORKER));
      fake.send(deny(asked, DENIED));
      await ended(fake);
      const started = fake.lines.find(isType('system', 'task_started')) as Json;
      const result = fake.lines.find(resultOf(at(asked, 'request', 'tool_use_id'))) as Json;
      // K2's error result, naming the worker by the tool use that started it, with fat-g's message.
      expect(differences(masked(result, project), masked(around(ONCE, 1).result.frame, '<never>'))).toEqual(['message.content', 'parent_tool_use_id', 'tool_use_result']);
      expect(result['parent_tool_use_id']).toBe(started['tool_use_id']);
      expect(at(result, 'message', 'content', 0)).toMatchObject({ is_error: true, content: DENIED });
      // Every other frame is the capture's own, in its order: the worker closes, and the turn completes.
      const own = received(WORKER);
      const at39 = own.findIndex((entry) => resultOf(at(own.find((item) => isApproval(item.frame))?.frame, 'request', 'tool_use_id'))(entry.frame));
      expect(sent(fake).filter((_, index) => index !== at39)).toEqual(cmp(own).filter((_, index) => index !== at39));
      expect(fake.lines.indexOf(result)).toBe(at39 + 1);
      expect(fake.lines.filter(isType('system', 'task_notification'))).toHaveLength(1);
      expect(made('worker-made.txt')).toBeNull();
      expect(notes(fake).writes).toEqual([]);
    }, 60_000);
  });

  describe('a rule for this session (C21, C69)', () => {
    it('granted with an allow, it lets every later request for that command pass unasked in that process, and another command is asked for; a new process asks again', async () => {
      const allowed = around(ONCE, 0);
      const refused = around(ONCE, 1);
      const fake = await acting();
      const first = await asking(fake, promptsOf(ONCE)[0] as string, 1);
      fake.send(allowForSession(first));
      await ended(fake, 1);
      expect(sent(fake)).toEqual(cmp(received(ONCE, 0)));
      expect(notes(fake).grants).toEqual([{ toolName: 'Bash', ruleContent: 'touch bash-once.txt' }]);
      expect(notes(fake).answers[0]?.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch bash-once.txt' }], behavior: 'allow', destination: 'session' }]);
      // The same prompt again: its own frames, less the request and the wait.
      let begun = fake.lines.length;
      fake.prompt(promptsOf(ONCE)[0] as string, 2);
      await ended(fake, 2);
      expect(sent(fake, begun)).toEqual(cmp(received(ONCE, 0)).filter((frame) => frame !== one(allowed.upTo.at(-1) as Captured)));
      // The second prompt, whose capture shows the request denied: unasked, and run as an allowed one is.
      begun = fake.lines.length;
      fake.prompt(promptsOf(ONCE)[1] as string, 3);
      await ended(fake, 3);
      expect(sent(fake, begun)).toEqual([...cmp(refused.upTo.slice(0, -1)), ...cmp(refused.ends), one(allowed.result), ...cmp(allowed.end)]);
      expect(fake.lines.filter(isApproval)).toHaveLength(1);
      // Another command is asked for as ever.
      const other = await asking(fake, promptsOf(GRANTED)[0] as string, 4);
      expect(at(other, 'request', 'input', 'command')).toBe('touch bash-session.txt');
      fake.send(deny(other));
      await ended(fake, 4);
      expect(fake.lines.every(capturedHas)).toBe(true);
      // The file was made once, by the allow: a `touch` of a file that is there changes nothing.
      const [id, entry] = onlySession();
      expect(entry.writes).toEqual(wrote('bash-once.txt'));
      expect(existsSync(marker())).toBe(false);
      expect(await fake.end()).toBe(0);

      // A process that resumed the session holds no rule: the command is asked for again.
      const again = start(launch('default', EXECUTION_TOOLS, ['--model', 'sonnet', '--effort', 'low', '--resume', id]));
      await again.initialize();
      const asked = await asking(again, promptsOf(ONCE)[0] as string, 5);
      expect(at(asked, 'request', 'input', 'command')).toBe('touch bash-once.txt');
      // And the prompt two captures share is `-resumed`'s there, and in a process of a session of its own.
      again.send(allow(asked));
      await ended(again, 5);
      await asking(again, promptsOf(GRANTED)[1] as string, 6);
      expect(notes(again).turns.at(-1)).toBe(APPROVAL_RESUMED);
      const fresh = await acting();
      await asking(fresh, promptsOf(GRANTED)[1] as string, 1);
      expect(notes(fresh).turns).toEqual([APPROVAL_RESUMED]);
    });

    it('anything else under `updatedPermissions` records no rule and is marked; the request is allowed all the same', async () => {
      const wrong: (readonly [string, (rule: Json, suggestions: Json[]) => unknown])[] = [
        ['the destination the CLI wrote', (rule) => [{ ...rule, destination: 'localSettings' }]],
        ['the user’s settings', (rule) => [{ ...rule, destination: 'userSettings' }]],
        ['the project’s settings', (rule) => [{ ...rule, destination: 'projectSettings' }]],
        ['a second entry beside the rule', (rule, suggestions) => [rule, suggestions.find((entry) => entry['type'] === 'setMode')]],
        ['another type', (_, suggestions) => [suggestions.find((entry) => entry['type'] === 'setMode')]],
        ['a rule that denies', (rule) => [{ ...rule, behavior: 'deny' }]],
        ['no entry', () => []],
        ['a key more', (rule) => [{ ...rule, replace: true }]],
        ['a rule with no content', (rule) => [{ ...rule, rules: [{ toolName: 'Bash' }] }]],
      ];
      const fake = await acting();
      for (const [n, [what, make]] of wrong.entries()) {
        const asked = await asking(fake, promptsOf(ONCE)[0] as string, n);
        const [rule] = sessionGrant(asked) as [Json];
        const updates = make(rule, at(asked, 'request', 'permission_suggestions') as Json[]);
        fake.send(allow(asked, { updatedPermissions: updates }));
        await ended(fake, n);
        expect(readFileSync(marker(), 'utf8'), what).toBe(String(fake.pid));
        rmSync(marker());
        expect(notes(fake).answers.at(-1)?.updatedPermissions, what).toEqual(updates);
        expect(notes(fake).grants, what).toEqual([]);
        expect(made('bash-once.txt'), what).toBe('');
      }
      // Each turn asked: nothing of them was taken for a rule.
      expect(fake.lines.filter(isApproval)).toHaveLength(wrong.length);
      // The one it does take, and a plain allow, write no marker.
      fake.send(allowForSession(await asking(fake, promptsOf(GRANTED)[0] as string, wrong.length)));
      await fake.next(isClosing(wrong.length));
      expect(existsSync(marker())).toBe(false);
      expect(notes(fake).grants).toEqual([{ toolName: 'Bash', ruleContent: 'touch bash-session.txt' }]);
    }, 60_000);
  });

  describe('the change an allowed request makes, in the folder the fake was started in and nowhere else (C35)', () => {
    /** K2's four file requests, each answered with an allow that sends back that input: what the CLI runs is what the reply holds. */
    async function fileTurn(inputs: readonly ((own: Json) => Json)[]): Promise<Fake> {
      const fake = await acting();
      fake.prompt(promptOf(FILES));
      for (const [n, change] of inputs.entries()) {
        const asked = await request(fake, n + 1);
        fake.send(answerTo(asked, { behavior: 'allow', updatedInput: change(at(asked, 'request', 'input') as Json) }));
      }
      await ended(fake);
      return fake;
    }
    const same = (own: Json): Json => own;

    it('a `Write` writes the content the reply sent back, and an `Edit` replaces the first passage or, under `replace_all`, every one', async () => {
      // A `$&` in the new text is the text itself: no pattern of a replacement.
      const first = await fileTurn([(own) => ({ ...own, content: 'alpha, alpha and alpha' }), (own) => ({ ...own, new_string: 'b$&' }), same, same]);
      expect(made('made-inside.txt')).toBe('b$&, alpha and alpha');
      expect(notes(first).writes).toEqual(wrote('made-inside.txt', 'made-inside.txt', 'made-in-added-root.txt', 'made-outside.txt'));
      // The frames are the capture's own whatever was sent back: the replay tells what K2 saw.
      expect(sent(first)).toEqual(cmp(received(FILES)));
      await first.end();
      await removeFolder(project);
      mkdirSync(project);

      const every = await fileTurn([(own) => ({ ...own, content: 'alpha, alpha and alpha' }), (own) => ({ ...own, new_string: 'b$&', replace_all: true }), same, same]);
      expect(made('made-inside.txt')).toBe('b$&, b$& and b$&');
      await every.end();
      await removeFolder(project);
      mkdirSync(project);

      // An `Edit` whose passage the file does not hold, and one of a file that is not there, change nothing and note nothing.
      const none = await fileTurn([same, (own) => ({ ...own, old_string: 'omega' }), (own) => ({ ...own, file_path: named('made-nowhere.txt') }), (own) => ({ ...own, file_path: named(path.join('a', 'b', 'made-deep.txt')) })]);
      expect(made('made-inside.txt')).toBe('alpha');
      // A `Write` makes the folders its file lies in, inside the project.
      expect(made(path.join('a', 'b', 'made-deep.txt'))).toBe('delta');
      expect(files()).toEqual(['a', 'made-inside.txt', 'made-nowhere.txt']);
      expect(notes(none).writes).toEqual(wrote('made-inside.txt', 'made-nowhere.txt', path.join('a', 'b', 'made-deep.txt')));
    }, 60_000);

    it('a `touch` makes its file where there is none, once; another command makes nothing', async () => {
      const fake = await acting();
      const first = await asking(fake, promptsOf(ONCE)[0] as string, 1);
      fake.send(allow(first));
      await ended(fake, 1);
      expect(made('bash-once.txt')).toBe('');
      // The same command again, allowed again: the file is there, and nothing is noted a second time.
      writeFileSync(path.join(project, 'bash-once.txt'), 'kept');
      fake.send(allow(await asking(fake, promptsOf(ONCE)[0] as string, 2)));
      await ended(fake, 2);
      expect(made('bash-once.txt')).toBe('kept');
      // A quoted name, as a shell takes one; and a command that is no `touch` of one file.
      for (const [n, command] of ['touch "with a space.txt"', 'touch one.txt two.txt', 'node --version', 'touch one.txt && echo done', 'echo touch three.txt'].entries()) {
        const asked = await asking(fake, promptsOf(ONCE)[0] as string, n + 3);
        fake.send(answerTo(asked, { behavior: 'allow', updatedInput: { ...(at(asked, 'request', 'input') as Json), command } }));
        await ended(fake, n + 3);
      }
      expect(files()).toEqual(['bash-once.txt', 'with a space.txt']);
      expect(notes(fake).writes).toEqual(wrote('bash-once.txt', 'with a space.txt'));
    }, 60_000);

    it('writes nothing outside that folder: a path beside it, above it, on another root or the folder itself', async () => {
      // A file beside the project that an `Edit` would change, and a folder whose name begins with the project's.
      const beside = path.join(dir, 'beside.txt');
      writeFileSync(beside, 'alpha');
      const fake = await fileTurn([
        (own) => ({ ...own, file_path: path.join(dir, 'outside.txt') }),
        (own) => ({ ...own, file_path: beside }),
        (own) => ({ ...own, file_path: path.join(`${project}-other`, 'deep', 'outside.txt') }),
        (own) => ({ ...own, file_path: path.join('..', 'relative.txt') }),
      ]);
      // The turn went on as an allowed one does: the fake's frames are its capture's, and nothing was written.
      expect(sent(fake)).toEqual(cmp(received(FILES)));
      expect(notes(fake).answers.map((answer) => answer.behavior)).toEqual(['allow', 'allow', 'allow', 'allow']);
      expect(notes(fake).writes).toEqual([]);
      await fake.end();

      const other = await acting();
      for (const [n, command] of [`touch ${path.join('..', 'touched.txt')}`, `touch ${path.join(dir, 'touched.txt')}`, 'touch ..', 'touch .', `touch ${project}`].entries()) {
        const asked = await asking(other, promptsOf(ONCE)[0] as string, n);
        other.send(answerTo(asked, { behavior: 'allow', updatedInput: { ...(at(asked, 'request', 'input') as Json), command } }));
        await ended(other, n);
      }
      // And a `Write` of the folder itself.
      const asked = await asking(other, promptsOf(EDITS)[1] as string, 9);
      other.send(answerTo(asked, { behavior: 'allow', updatedInput: { file_path: project, content: 'x' } }));
      await ended(other, 9);
      expect(notes(other).writes).toEqual([]);
      expect(readFileSync(beside, 'utf8')).toBe('alpha');
      expect(files()).toEqual([]);
      // The folder above the project holds what the test made, and the fakes' own session file.
      expect(readdirSync(dir).sort()).toEqual(['beside.txt', 'chat-sessions.json', 'fixture', 'project']);
      expect(existsSync(`${project}-other`)).toBe(false);
    }, 60_000);

    it('makes no change for a request it is not answered an allow: denied, stopped, or left waiting', async () => {
      const fake = await acting();
      fake.send(deny(await asking(fake, promptsOf(ONCE)[0] as string, 1)));
      await ended(fake, 1);
      await asking(fake, promptsOf(ONCE)[0] as string, 2);
      fake.interrupt();
      await ended(fake, 2);
      await asking(fake, promptsOf(EDITS)[1] as string, 3);
      await fake.during(200);
      expect(files()).toEqual([]);
      expect(notes(fake).writes).toEqual([]);
    });
  });

  describe('an interrupt while a request waits (C13, C35)', () => {
    /** K2's Stop with a request pending: the frames after its interrupt. */
    const stopTail = (): Captured[] => {
      const turn = turnOf(EDITS, 1);
      const interrupted = turn.find((entry) => entry.dir === 'send' && at(entry.frame, 'request', 'subtype') === 'interrupt') as Captured;
      return turn.filter((entry) => entry.dir === 'recv' && entry.index > interrupted.index);
    };

    it('is answered with K2’s Stop: the cancel that names the request, the reply, the error result, the `result` and the closing frame', async () => {
      const fake = await acting();
      const asked = await asking(fake, promptsOf(ONCE)[0] as string);
      const before = fake.lines.length;
      const id = fake.interrupt();
      await ended(fake);
      const tail = fake.lines.slice(before);
      expect(compared(tail)).toEqual(cmp(stopTail()));
      expect(tail.map(kindOf)).toEqual(['control_cancel_request', 'control_response', 'user', 'user', 'result', 'cancelled']);
      // Each names this turn's own: its request, fat-g's interrupt, its tool use, its prompt.
      expect(tail[0]).toEqual({ type: 'control_cancel_request', request_id: asked['request_id'] });
      expect(at(tail[1], 'response', 'request_id')).toBe(id);
      expect(at(tail[2], 'message', 'content', 0)).toMatchObject({ type: 'tool_result', is_error: true, tool_use_id: at(asked, 'request', 'tool_use_id') });
      expect(at(tail[4], 'is_error')).toBe(true);
      expect(tail[5]).toMatchObject({ command_uuid: PROMPT_ID(1) });
      // What came before it is the turn's own, up to its request: the ends of the reply never come.
      expect(sent(fake).slice(0, before - 1)).toEqual(cmp(around(ONCE, 0).upTo));
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(notes(fake)).toMatchObject({ turns: [ONCE], answers: [], writes: [], interrupts: [{ inputOpen: true, turn: true, workers: 0 }] });
      expect(files()).toEqual([]);
      // A reply that comes after the Stop is noted, and changes nothing; the process is up for the next prompt.
      fake.send(allow(asked));
      expect(await fake.during(150)).toEqual([]);
      expect(files()).toEqual([]);
      fake.send(deny(await asking(fake, promptsOf(ONCE)[1] as string, 2)));
      await ended(fake, 2);
      expect(sent(fake, fake.lines.indexOf(tail[5] as Json) + 1)).toEqual(cmp(received(ONCE, 1)));
    });

    it('closes a worker whose request waits, by K11’s two frames, after the reply', async () => {
      const fake = await acting();
      const asked = await asking(fake, promptOf(WORKER));
      const started = fake.lines.find(isType('system', 'task_started')) as Json;
      const before = fake.lines.length;
      fake.interrupt();
      await ended(fake);
      const tail = fake.lines.slice(before);
      expect(tail.map(kindOf)).toEqual(['control_cancel_request', 'control_response', 'task_updated', 'task_notification', 'user', 'user', 'result', 'cancelled']);
      expect(tail[0]).toEqual({ type: 'control_cancel_request', request_id: asked['request_id'] });
      expect(tail.slice(2, 4).map((line) => line['task_id'])).toEqual([started['task_id'], started['task_id']]);
      expect(compared(tail.filter((_, index) => index !== 2 && index !== 3))).toEqual(cmp(stopTail()));
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(notes(fake).interrupts).toEqual([{ inputOpen: true, turn: true, workers: 1 }]);
      expect(files()).toEqual([]);
    }, 60_000);

    it('once the request was decided, is answered as any turn’s is: T4’s frames, and no cancel', async () => {
      const fake = await acting({ holdResult: 5000 });
      fake.send(allow(await asking(fake, promptsOf(ONCE)[0] as string)));
      await fake.next(ownText);
      await fake.next((line) => isStream(line, 'message_stop') && fake.lines.filter((entry) => isStream(entry, 'message_stop')).length === 2);
      fake.interrupt();
      await fake.next(isType('command_lifecycle', 'cancelled'));
      expect(fake.lines.some(isCancel)).toBe(false);
      expect(at(fake.lines.find(isResult), 'is_error')).toBe(true);
      expect(made('bash-once.txt')).toBe('');
    });
  });

  describe('the controls, each one named change to a request (C35)', () => {
    const P1 = (): string => promptsOf(ONCE)[0] as string;
    const ownRequest = (name: string = ONCE): Json => original(name, isApproval);
    /** The keys of the request at which two frames differ, whatever differs under each. */
    const keysOf = (paths: readonly string[]): string[] => [...new Set(paths.map((at) => at.split('.').slice(0, 2).join('.')))];

    it('approvalTwice: the request is delivered again, identical, under the same id, and one reply decides it', async () => {
      const fake = await acting({ approvalTwice: true });
      const asked = await asking(fake, P1());
      await fake.during(100);
      const both = fake.lines.filter(isApproval);
      expect(both).toHaveLength(2);
      expect(both[1]).toEqual(both[0]);
      expect(fake.lines.indexOf(both[1] as Json)).toBe(fake.lines.indexOf(both[0] as Json) + 1);
      expect(masked(asked, project)).toEqual(ownRequest());
      // fat-g answers the one it holds, and writes that answer again for the repeat: the first decides, the second is noted.
      fake.send(allow(asked));
      fake.send(allow(asked));
      await ended(fake);
      const again = fake.lines.indexOf(both[1] as Json);
      expect(sent(fake).filter((_, index) => index !== again - 1)).toEqual(cmp(received(ONCE, 0)));
      expect(notes(fake)).toMatchObject({ writes: wrote('bash-once.txt') });
      expect(notes(fake).answers).toHaveLength(2);
    });

    it('approvalChanged: the request is delivered again under the same id with another command, and the refusal fat-g answers that with ends the turn as a denial', async () => {
      const fake = await acting({ approvalChanged: true });
      const asked = await asking(fake, P1());
      await fake.during(100);
      const both = fake.lines.filter(isApproval);
      expect(both).toHaveLength(2);
      expect(both[0]).toBe(asked);
      expect(masked(asked, project)).toEqual(ownRequest());
      // The second differs from the first in its input alone, and there in the command alone.
      expect(differences(both[1], both[0])).toEqual(['request.input.command']);
      expect(at(both[1], 'request', 'input', 'command')).not.toBe(at(asked, 'request', 'input', 'command'));
      expect(both[1]?.['request_id']).toBe(asked['request_id']);
      fake.send(deny(asked));
      await ended(fake);
      expect(compared(fake.lines.slice(fake.lines.indexOf(both[1] as Json) + 1))).toEqual([one(around(ONCE, 1).result), ...cmp(around(ONCE, 0).ends), ...cmp(around(ONCE, 1).end)]);
      expect(notes(fake).writes).toEqual([]);
      expect(files()).toEqual([]);
      // A file change's other input is another content, or another new text.
      const other = await acting({ approvalChanged: true });
      other.prompt(promptOf(FILES));
      await other.next(() => other.lines.filter(isApproval).length === 2);
      const [write, changed] = other.lines.filter(isApproval) as [Json, Json];
      expect(differences(changed, write)).toEqual(['request.input.content']);
      expect(changed['request_id']).toBe(write['request_id']);
    });

    it('approvalWorker: the request names a worker no worker is, and nothing else of it changes', async () => {
      const fake = await acting({ approvalWorker: true });
      const asked = await asking(fake, P1());
      expect(differences(masked(asked, project), ownRequest())).toEqual(['request.agent_id']);
      expect(at(asked, 'request', 'agent_id')).toBe('no-such-worker');
      expect(fake.lines.some(isType('system', 'task_started'))).toBe(false);
      expect(fake.lines.filter((line) => line !== asked).every(capturedHas)).toBe(true);
    });

    it('approvalLate: the request comes after the turn’s `result`, nothing waited for a reply to it, and no change was made', async () => {
      const fake = await acting({ approvalLate: true });
      fake.prompt(P1());
      await ended(fake);
      expect(fake.lines.map(kindOf).slice(-3)).toEqual(['result', 'control_request', 'completed']);
      const frames = cmp(received(ONCE, 0));
      const asked = one(around(ONCE, 0).upTo.at(-1) as Captured);
      const rest = frames.filter((frame) => frame !== asked);
      expect(sent(fake)).toEqual([...rest.slice(0, -1), asked, ...rest.slice(-1)]);
      expect(files()).toEqual([]);
      // A reply to it is noted, and changes nothing.
      fake.send(allow(fake.lines.find(isApproval) as Json));
      expect(await fake.during(150)).toEqual([]);
      expect(notes(fake)).toMatchObject({ writes: [], answers: [{ behavior: 'allow' }] });
      expect(files()).toEqual([]);
    });

    it('approvalCancel: K2’s cancel frame, naming the request, in place of the wait; the turn goes on as its capture does, and no change is made', async () => {
      const fake = await acting({ approvalCancel: true });
      const asked = await asking(fake, P1());
      await ended(fake);
      const cancels = fake.lines.filter(isCancel);
      expect(cancels).toEqual([{ type: 'control_cancel_request', request_id: asked['request_id'] }]);
      expect(fake.lines.indexOf(cancels[0] as Json)).toBe(fake.lines.indexOf(asked) + 1);
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(sent(fake).filter((_, index) => index !== fake.lines.indexOf(cancels[0] as Json) - 1)).toEqual(cmp(received(ONCE, 0)));
      expect(notes(fake)).toMatchObject({ answers: [], writes: [] });
      // A decision that comes for a request the CLI took back is noted, and no more.
      fake.send(allow(asked));
      expect(await fake.during(150)).toEqual([]);
      expect(files()).toEqual([]);
    });

    it('approvalLate and approvalCancel leave the turn whose capture shows a Stop in an answer’s place as it is: it waits', async () => {
      for (const control of [{ approvalLate: true }, { approvalCancel: true }]) {
        const fake = await acting(control);
        const asked = await asking(fake, promptsOf(EDITS)[1] as string);
        await fake.next(() => fake.lines.length >= 1 + around(EDITS, 1).upTo.length + around(EDITS, 1).ends.length);
        expect(await fake.during(150)).toEqual([]);
        expect(fake.lines.some(isCancel)).toBe(false);
        fake.send(allow(asked));
        await ended(fake);
        expect(made('made-after-the-restore.txt')).toBe('gamma');
        await fake.end();
        rmSync(path.join(project, 'made-after-the-restore.txt'));
      }
    });

    it('exitWhileApproving: the process ends once the request is out, with it pending; taken once', async () => {
      const fake = await acting({ exitWhileApproving: 1 });
      fake.prompt(P1());
      expect(await fake.closed).toBe(3);
      expect(sent(fake)).toEqual(cmp(around(ONCE, 0).upTo));
      expect(isApproval(fake.lines.at(-1) as Json)).toBe(true);
      expect(fake.lines.every(capturedHas)).toBe(true);
      const [id, entry] = onlySession();
      expect(entry).toMatchObject({ kept: true, turns: [ONCE], answers: [], writes: [] });
      expect(readControlFile()).toEqual({ exitWhileApproving: 0 });
      // A second process resumes that session, and is asked for the command again.
      const again = start(launch('default', EXECUTION_TOOLS, ['--model', 'sonnet', '--resume', id]));
      await again.initialize();
      await asking(again, P1(), 2);
      expect(again.exited()).toBe(false);
    });

    it('exitAtDecision: the request’s input is padded, and the process ends at the first bytes of the decision that sends it back', async () => {
      const fake = await acting({ exitAtDecision: 1 });
      const asked = await asking(fake, P1());
      expect(differences(masked(asked, project), ownRequest())).toEqual(['request.input.padding']);
      expect(String(at(asked, 'request', 'input', 'padding'))).toMatch(/^x{900000}$/);
      expect(fake.lines.filter((line) => line !== asked).every(capturedHas)).toBe(true);
      expect(fake.exited()).toBe(false);
      // fat-g's allow sends the input back as it came: a line under the megabyte one write may queue, and far over what a pipe takes at once.
      const decision = allow(asked);
      expect(JSON.stringify(decision).length).toBeGreaterThan(900_000);
      expect(JSON.stringify(decision).length).toBeLessThan(MIB);
      expect(await fake.written(decision)).toBe(false);
      expect(await fake.closed).toBe(3);
      // Nothing of the decision was taken: no answer noted, no file made, no frame after the request.
      expect(fake.lines.at(-1)).toBe(asked);
      expect(notes(fake)).toMatchObject({ answers: [], writes: [] });
      expect(files()).toEqual([]);
      expect(readControlFile()).toEqual({ exitAtDecision: 0 });
      const next = await acting(readControlFile());
      const plainly = await asking(next, P1());
      expect(at(plainly, 'request', 'input', 'padding')).toBeUndefined();
      expect(await next.written(allow(plainly))).toBe(true);
      await ended(next);
    });

    it('targetsForty: the request becomes a `MultiEdit` of one file with forty edits', async () => {
      const fake = await acting({ targetsForty: true });
      const asked = await asking(fake, P1());
      expect(keysOf(differences(masked(asked, project), ownRequest()))).toEqual(['request.tool_name', 'request.display_name', 'request.input']);
      expect(at(asked, 'request')).toMatchObject({ tool_name: 'MultiEdit', display_name: 'MultiEdit' });
      const input = at(asked, 'request', 'input') as { file_path: string; edits: { old_string: string; new_string: string; replace_all: boolean }[] };
      expect(Object.keys(input)).toEqual(['file_path', 'edits']);
      expect(path.dirname(input.file_path)).toBe(project);
      expect(input.edits).toHaveLength(40);
      expect(new Set(input.edits.map((edit) => edit.old_string)).size).toBe(40);
      expect(input.edits.every((edit) => edit.new_string !== edit.old_string && edit.replace_all === false)).toBe(true);
      // A file change's own file is the one it names.
      const other = await acting({ targetsForty: true });
      const write = await asking(other, promptOf(FILES));
      expect(at(write, 'request', 'input', 'file_path')).toBe(named('made-inside.txt'));
      expect(at(write, 'request', 'input', 'edits')).toHaveLength(40);
      // Allowed, a tool the fake has no change for writes nothing.
      fake.send(allow(asked));
      await ended(fake);
      expect(notes(fake).writes).toEqual([]);
    });

    it('writeOverBound: the request becomes a `Write` whose content is one unit past the bound, in a line under the limit; a `Write`’s own keeps its file', async () => {
      const fake = await acting({ writeOverBound: true });
      const asked = await asking(fake, P1());
      expect(keysOf(differences(masked(asked, project), ownRequest()))).toEqual(['request.tool_name', 'request.display_name', 'request.input']);
      expect(at(asked, 'request', 'tool_name')).toBe('Write');
      expect(Object.keys(at(asked, 'request', 'input') as Json)).toEqual(['file_path', 'content']);
      expect(String(at(asked, 'request', 'input', 'content'))).toHaveLength(1_048_577);
      expect(fake.sizes[fake.lines.indexOf(asked)]).toBeLessThan(2 * MIB);
      // Refused by its id, as fat-g refuses one past a bound: the turn ends as a denied one does, and nothing was written.
      fake.send(deny(asked));
      await ended(fake);
      expect(at(fake.lines.find(isResult), 'is_error')).toBe(false);
      expect(files()).toEqual([]);

      const other = await acting({ writeOverBound: true });
      const write = await asking(other, promptOf(FILES));
      expect(differences(masked(write, project), ownRequest(FILES))).toEqual(['request.input.content']);
      expect(at(write, 'request', 'input', 'file_path')).toBe(named('made-inside.txt'));
      expect(String(at(write, 'request', 'input', 'content'))).toHaveLength(1_048_577);
    });

    it('requestOverLine: the request is a `Write` whose line is over 4 MiB, its id among the line’s first bytes', async () => {
      const fake = await acting({ requestOverLine: true });
      const asked = await asking(fake, P1());
      const index = fake.lines.indexOf(asked);
      expect(fake.sizes[index]).toBeGreaterThan(4 * MIB);
      expect(fake.sizes.filter((size) => size > MIB)).toHaveLength(1);
      // The line's keys in the CLI's own order: the kind, the id, then the request with its subtype first.
      expect(Object.keys(asked)).toEqual(['type', 'request_id', 'request']);
      expect(fake.heads[index]).toMatch(/^\{"type":"control_request","request_id":"[0-9a-f-]{36}","request":\{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":\{"file_path":"/);
      expect(keysOf(differences(masked(asked, project), ownRequest()))).toEqual(['request.tool_name', 'request.display_name', 'request.input']);
      // Refused by the id read from those bytes: the turn goes on to a denied end.
      fake.send(deny(asked));
      await ended(fake);
      expect(compared(fake.lines.slice(index + 1))).toEqual([one(around(ONCE, 1).result), ...cmp(around(ONCE, 0).ends), ...cmp(around(ONCE, 1).end)]);
      expect(files()).toEqual([]);
    });

    it('requestOverLineNoId: the same line with its id written after the request, past the first 512 bytes; a Stop ends its turn', async () => {
      const fake = await acting({ requestOverLineNoId: true });
      const asked = await asking(fake, P1());
      const index = fake.lines.indexOf(asked);
      expect(fake.sizes[index]).toBeGreaterThan(4 * MIB);
      expect(Object.keys(asked)).toEqual(['type', 'request', 'request_id']);
      expect(fake.heads[index]).toMatch(/^\{"type":"control_request","request":\{"subtype":"can_use_tool","tool_name":"Write"/);
      expect(fake.heads[index]).not.toContain('request_id');
      expect(Buffer.byteLength(fake.heads[index] as string)).toBe(512);
      expect(String(asked['request_id'])).toMatch(UUID);
      // The same request as the one with its id first, but for where the id is written.
      const other = await acting({ requestOverLine: true });
      const first = await asking(other, P1());
      expect(masked({ type: asked['type'], request_id: asked['request_id'], request: asked['request'] }, project)).toEqual(masked(first, project));
      // Nothing can answer a request whose id was not read: fat-g stops the turn, and the CLI takes the request back.
      const before = fake.lines.length;
      fake.interrupt();
      await ended(fake);
      expect(fake.lines.slice(before).map(kindOf)).toEqual(['control_cancel_request', 'control_response', 'user', 'user', 'result', 'cancelled']);
      expect(fake.lines[before]).toEqual({ type: 'control_cancel_request', request_id: asked['request_id'] });
    });

    it('grantSuggestsOther: the request’s `addRules` suggestion names the user’s settings; sent back for the session, its rule is taken', async () => {
      const fake = await acting({ grantSuggestsOther: true });
      const asked = await asking(fake, P1(), 1);
      expect(differences(masked(asked, project), ownRequest())).toEqual(['request.permission_suggestions']);
      const suggestions = at(asked, 'request', 'permission_suggestions') as Json[];
      const own = at(ownRequest(), 'request', 'permission_suggestions') as Json[];
      expect(suggestions.map((entry) => [entry['type'], entry['destination']])).toEqual([['addRules', 'userSettings'], ['addDirectories', 'session'], ['setMode', 'session']]);
      expect(own.map((entry) => [entry['type'], entry['destination']])).toEqual([['addRules', 'localSettings'], ['addDirectories', 'session'], ['setMode', 'session']]);
      expect(differences(masked(suggestions[0] as Json, project), own[0])).toEqual(['destination']);
      // The reply names the session all the same, and no other destination: the rule is this process's.
      fake.send(allowForSession(asked));
      await ended(fake, 1);
      expect(existsSync(marker())).toBe(false);
      expect(notes(fake).grants).toEqual([{ toolName: 'Bash', ruleContent: 'touch bash-once.txt' }]);
      const begun = fake.lines.length;
      fake.prompt(P1(), 2);
      await ended(fake, 2);
      expect(fake.lines.slice(begun).some(isApproval)).toBe(false);
      // A request with no such suggestion is as captured.
      const other = await acting({ grantSuggestsOther: true });
      expect(masked(await asking(other, promptOf(FILES)), project)).toEqual(ownRequest(FILES));
    });

    it('deniedByRule: in place of the request, K2’s `permission_denied` frame naming this turn’s tool use, then its error result; no request, and the turn ends as a denied one does', async () => {
      const ruled = received(INHERITED);
      const denial = ruled.find((entry) => entry.frame['subtype'] === 'permission_denied') as Captured;
      const refusal = ruled.find((entry) => resultOf(denial.frame['tool_use_id'])(entry.frame)) as Captured;
      const fake = await acting({ deniedByRule: true });
      fake.prompt(P1());
      await ended(fake);
      const allowed = around(ONCE, 0);
      expect(sent(fake)).toEqual([...cmp(allowed.upTo.slice(0, -1)), one(denial), one(refusal), ...cmp(allowed.ends), ...cmp(around(ONCE, 1).end)]);
      expect(fake.lines.every(capturedHas)).toBe(true);
      expect(fake.lines.some(isApproval)).toBe(false);
      // The frame names the tool use of the `assistant` frame before it, and exactly one result names it too.
      const used = at(fake.lines.filter(ownAssistant).find((line) => at(line, 'message', 'content', 0, 'type') === 'tool_use'), 'message', 'content', 0, 'id');
      const denied = fake.lines.find(isType('system', 'permission_denied')) as Json;
      expect(denied).toMatchObject({ tool_name: 'Bash', tool_use_id: used, decision_reason_type: 'rule' });
      expect(fake.lines.filter(resultOf(used))).toHaveLength(1);
      expect(at(fake.lines.find(resultOf(used)), 'message', 'content', 0, 'is_error')).toBe(true);
      expect(fake.lines.indexOf(fake.lines.find(resultOf(used)) as Json)).toBe(fake.lines.indexOf(denied) + 1);
      expect(fake.lines.at(-1)).toMatchObject({ type: 'command_lifecycle', state: 'completed' });
      expect(notes(fake)).toMatchObject({ answers: [], writes: [] });
      expect(files()).toEqual([]);
      // For another tool the frame names that tool, and differs from K2's in that alone.
      const other = await acting({ deniedByRule: true });
      other.prompt(promptOf(FILES));
      await ended(other);
      const forWrite = other.lines.find(isType('system', 'permission_denied')) as Json;
      expect(differences(masked(forWrite, project), masked(denial.frame, '<never>'))).toEqual(['tool_name']);
      expect(forWrite['tool_name']).toBe('Write');
      expect(other.lines.some(isApproval)).toBe(false);
      expect(other.lines.filter(isResult)).toHaveLength(1);
      // A worker's: its turn goes on as captured, the worker told so in place of its tool's result.
      const worker = await acting({ deniedByRule: true });
      worker.prompt(promptOf(WORKER));
      await ended(worker);
      const started = worker.lines.find(isType('system', 'task_started')) as Json;
      const theirs = worker.lines.find(isType('system', 'permission_denied')) as Json;
      const told = worker.lines[worker.lines.indexOf(theirs) + 1] as Json;
      expect(differences(masked(told, project), masked(refusal.frame, '<never>'))).toEqual(['parent_tool_use_id']);
      expect([told['parent_tool_use_id'], at(told, 'message', 'content', 0, 'tool_use_id')]).toEqual([started['tool_use_id'], theirs['tool_use_id']]);
      expect(worker.lines.filter(isType('system', 'task_notification'))).toHaveLength(1);
      expect(worker.lines.some(isApproval)).toBe(false);
    }, 60_000);

    it('the faults of a question and of a request for another tool do not meet: each falls on its own', async () => {
      const sentBack = at(capture('m21-question-one').frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'control_response')?.frame, 'response', 'response', 'updatedInput') as Json;
      const fake = await acting({ approvalTwice: true, approvalWorker: true, deniedByRule: true, targetsForty: true });
      fake.prompt(promptOf('m21-question-one'));
      const asked = await fake.next((line) => at(line, 'request', 'tool_name') === 'AskUserQuestion');
      fake.send(answerTo(asked, { behavior: 'allow', updatedInput: sentBack }));
      await ended(fake);
      expect(sent(fake)).toEqual(expected('m21-question-one'));
      const other = await acting({ questionTwice: true, questionWorker: true, questionCancel: true, questionLate: true, questionsTwenty: true });
      other.send(allow(await asking(other, P1())));
      await ended(other);
      expect(sent(other)).toEqual(cmp(received(ONCE, 0)));
    });
  });

  // K5 (round 3 of M22; C74, C94, C96, C97): the turns under the modes that ask nothing, and the two
  // resumes of the session the `bypassPermissions` turn began.
  describe('K5’s turns, which ask nothing, and its resumes of a session launched under `bypassPermissions` (C74, C94, C96, C97)', () => {
    const AUTO = 'm22-mode-auto';
    const BYPASSED = 'm22-mode-bypass-main';
    const WORKERS = 'm22-mode-worker';
    /** The word each was taken under. */
    const UNDER: Record<string, string> = { [AUTO]: 'auto', [BYPASSED]: 'bypassPermissions', [WORKERS]: 'acceptEdits' };
    const launchOf = (name: string): string[] => (capture(name) as unknown as { launch: { args: string[] } }).launch.args;
    const argOf = (name: string, flag: string): string | undefined => launchOf(name)[launchOf(name).indexOf(flag) + 1];
    const replyOf = (name: string): Json => (capture(name).frames.find((entry) => entry.index === 1) as Captured).frame;
    const resuming = (word: string, id: string): string[] => launch(word, EXECUTION_TOOLS, ['--model', 'sonnet', '--effort', 'low', '--resume', id]);
    /** A session launched under `bypassPermissions` and given K5's turn there, its process ended: what K5's two resumes followed. */
    const bypassed = async (): Promise<string> => {
      const first = await session(launch('bypassPermissions'));
      await replayed(first, BYPASSED);
      const [id] = onlySession();
      expect(await first.end()).toBe(0);
      return id;
    };

    it('names K5’s three that are turns, each one turn with no request in it, taken under the launch it is replayed under, and the two resumes beside them that are none', () => {
      expect([...MODE_CAPTURES]).toEqual([AUTO, BYPASSED, WORKERS]);
      expect({ ...BYPASS_RESUMED }).toEqual({ default: 'm22-mode-bypass-resumed-default', acceptEdits: 'm22-mode-bypass-resumed-acceptEdits' });
      for (const name of MODE_CAPTURES) {
        expect(TURN_CAPTURES, name).toContain(name);
        expect(promptFrames(name), name).toHaveLength(1);
        expect(typeof promptAlias(name), name).toBe('string');
        expect([argOf(name, '--permission-mode'), argOf(name, '--tools')], name).toEqual([UNDER[name], EIGHT]);
        // No flag that bypasses permissions was passed for any of them: the mode's word alone (C47).
        expect(launchOf(name).filter((arg) => /skip-permissions/.test(arg)), name).toEqual([]);
        // Nothing was asked and nothing answered: after the prompt the capture holds no frame fat-g sent.
        expect(turnOf(name).filter((entry) => entry.dir === 'send'), name).toEqual([]);
        expect(received(name).filter((entry) => entry.frame['type'] === 'control_request' || entry.frame['type'] === 'control_cancel_request' || (entry.frame['type'] === 'system' && entry.frame['subtype'] === 'permission_denied')), name).toEqual([]);
        expect([initOf(name)['permissionMode'], builtIn(initOf(name))], name).toEqual([UNDER[name], REPORTED_EIGHT]);
        expect(received(name).at(-1)?.frame, name).toMatchObject({ type: 'command_lifecycle', state: 'completed' });
      }
      // What each ran, the session's own tool uses and a worker's, in their order: a file outside every root among the first two's.
      const used = (name: string): string[] => received(name).filter((entry) => entry.frame['type'] === 'assistant' && at(entry.frame, 'message', 'content', 0, 'type') === 'tool_use').map((entry) => `${entry.frame['parent_tool_use_id'] === null ? '' : 'worker:'}${String(at(entry.frame, 'message', 'content', 0, 'name'))}`);
      expect(MODE_CAPTURES.map(used)).toEqual([['Write', 'Bash', 'Bash', 'Write'], ['Write', 'Bash', 'Bash', 'Write'], ['Agent', 'worker:Write', 'worker:Bash']]);
      const written = (name: string): string[] => received(name).flatMap((entry) => { const file = at(entry.frame, 'message', 'content', 0, 'input', 'file_path'); return entry.frame['type'] === 'assistant' && typeof file === 'string' ? [file.replace('<scratch>\\', '')] : []; });
      expect(MODE_CAPTURES.map(written)).toEqual([['made-under-auto.txt', 'made-outside-under-auto.txt'], ['made-under-bypass.txt', 'made-outside-under-bypass.txt'], ['worker-wrote.txt']]);
      // The two resumes hold no prompt: each reopened the bypass turn's session under its own word, and reported that word.
      for (const [word, name] of Object.entries(BYPASS_RESUMED)) {
        expect(promptFrames(name), name).toEqual([]);
        expect(TURN_CAPTURES, name).not.toContain(name);
        expect([argOf(name, '--permission-mode'), argOf(name, '--tools'), launchOf(name).includes('--resume')], name).toEqual([word, EIGHT, true]);
        expect(at(replyOf(name), 'response', 'response', 'current_permission_mode'), name).toBe(word);
      }
      // Under `default` a set to `bypassPermissions` was sent and refused, with the words K2 saw; under `acceptEdits` nothing was sent after the launch.
      expect(capture(BYPASS_RESUMED.default).frames.slice(2).map((entry) => [entry.dir, at(entry.frame, 'request', 'mode') ?? at(entry.frame, 'response', 'error')])).toEqual([
        ['send', 'bypassPermissions'], ['recv', 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions'],
      ]);
      expect(capture(BYPASS_RESUMED.acceptEdits).frames).toHaveLength(2);
    });

    it.each(Object.entries(UNDER))('replays %s for its own prompt under %s: every frame its capture’s, its `init` the capture’s own, no request sent, and no file changed', async (name, word) => {
      const fake = await session(launch(word));
      const lines = await replayed(fake, name);
      expect(compared(lines)).toEqual(cmp(received(name)));
      expect(fake.lines.every(capturedHas)).toBe(true);
      // Under the launch it was taken under, the launch's substitution changes nothing of the `init` but its tools, which the plan's tool joined after it was taken (M22b, C8).
      expect(differences(plain(lines.find(isInit) as Json, project), plain(initOf(name), '<never>'))).toEqual(['tools']);
      expect(builtIn(lines.find(isInit) as Json)).toEqual(REPORTED[EXECUTION_TOOLS]);
      expect(lines.some((line) => isApproval(line) || isCancel(line))).toBe(false);
      // The fake was sent nothing but the prompt, and changed nothing: a turn that runs with no request makes no file of the fake's.
      expect(notes(fake)).toMatchObject({ turns: [name], answers: [], writes: [], grants: [], modes: [], interrupts: [] });
      expect(notes(fake).launches).toMatchObject([{ mode: word, tools: EXECUTION_TOOLS.split(',') }]);
      expect(files()).toEqual([]);
      expect(await fake.end()).toBe(0);
    }, 60_000);

    it('replays a K5 turn under another launch all the same, its `init` naming that launch’s word: the prompt chooses the turn, and the mode gates nothing', async () => {
      const fake = await session(launch('default'));
      const lines = await replayed(fake, AUTO);
      expect(lines.find(isInit)).toMatchObject({ permissionMode: 'default' });
      expect(differences(plain(lines.find(isInit) as Json, project), plain(initOf(AUTO), '<never>'))).toEqual(['tools', 'permissionMode']);
      expect(compared(lines)).toEqual(cmp(received(AUTO)));
      expect(lines.some(isApproval)).toBe(false);
    });

    it('answers the resume of a session that was launched under `bypassPermissions` with K5’s own reply for the word it is resumed under, whole', async () => {
      const id = await bypassed();
      for (const [word, name] of Object.entries(BYPASS_RESUMED)) {
        const again = start(resuming(word, id));
        const reply = await again.initialize();
        // Nothing of it is another capture's: K5's reply for that word, under the request's own id.
        expect(differences(plain(reply, project), plain(replyOf(name), '<never>')), word).toEqual([]);
        expect(at(reply, 'response', 'response', 'current_permission_mode'), word).toBe(word);
        expect(capturedHas(reply), word).toBe(true);
        // It sends nothing of the earlier conversation, and its next turn's `init` names its own word and the session it resumed.
        expect(await again.during(150), word).toEqual([]);
        again.prompt(promptOf(T1), 2);
        expect(await from(again, 1, isInit), word).toMatchObject({ permissionMode: word, session_id: id });
        await ended(again, 2);
        expect(await again.end(), word).toBe(0);
      }
      expect(onlySession()[1].launches.map((entry) => [entry.mode, entry.resume])).toEqual([['bypassPermissions', null], ['default', id], ['acceptEdits', id]]);
    }, 60_000);

    it('refuses a set to `bypassPermissions` in that resume under `default` with K5’s own error reply, and changes nothing: out of it, the word is a launch’s alone (C74)', async () => {
      const id = await bypassed();
      const again = start(resuming('default', id));
      await again.initialize();
      const begun = again.lines.length;
      const refusal = await from(again, begun, replyTo(again.setMode('bypassPermissions')));
      const theirs = capture(BYPASS_RESUMED.default).frames.find((entry) => entry.dir === 'recv' && at(entry.frame, 'response', 'subtype') === 'error') as Captured;
      expect(comparable(refusal, project)).toBe(comparable(theirs.frame, '<never>'));
      expect(at(refusal, 'response', 'error')).toBe('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
      // No status frame, and the mode in force is the launch's still: the next turn's `init` names `default`.
      expect(await again.during(150)).toEqual([]);
      again.prompt(promptOf(T1), 2);
      expect(await from(again, begun, isInit)).toMatchObject({ permissionMode: 'default' });
      expect(onlySession()[1].modes).toEqual([{ mode: 'bypassPermissions', turn: false, answered: 'error' }]);
    });

    it('answers every other resume as it did: one of a session never launched under `bypassPermissions`, one under a word K5 did not resume under, and one with the reading tools', async () => {
      const resumeReply = replyOf('m16-resume');
      const plainly = async (launched: string[], args: (id: string) => string[], word: string): Promise<void> => {
        const first = await session(launched);
        first.prompt(promptOf(T1));
        await ended(first);
        const id = Object.entries(sessions()).find(([, entry]) => entry.launches.some((made) => made.pid === first.pid))?.[0] as string;
        expect(await first.end()).toBe(0);
        const again = start(args(id));
        const reply = await again.initialize();
        expect(differences(plain(reply, project), plain(resumeReply, '<never>')), word).toEqual(word === 'default' ? [] : ['response.response.current_permission_mode']);
        expect(at(reply, 'response', 'response', 'current_permission_mode'), word).toBe(word);
        expect(await again.end(), word).toBe(0);
      };
      // Launched under `default` and resumed under `default` with the eight tools: no bypass before it.
      await plainly(launch('default'), (id) => resuming('default', id), 'default');
      // Launched under `bypassPermissions`, and resumed under `auto`, which K5 did not do: M16's reply, that word set.
      await plainly(launch('bypassPermissions'), (id) => resuming('auto', id), 'auto');
      // And resumed with the reading tools, under `default`: no launch of K5's.
      await plainly(launch('bypassPermissions'), (id) => [...chatFixedArgs('default', READING_TOOLS), '--model', 'sonnet', '--effort', 'low', '--resume', id], 'default');
    }, 60_000);
  });
});
