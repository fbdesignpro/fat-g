// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Claude adapter's chat sessions against the replay fake, through the real process layer
// (docs/planning/_archive/M16.md, Verification): what tests/claude/chat/ shares. No test here uses the real
// CLI (S10): the fake is Node running tests/fixtures/fake-claude-cli.mjs.
//
// The fake's files — its control file, its process ledger, each process's environment — are in a
// fixture folder made per harness, and its session file beside it; it is told of the session file
// through the environment this process's children inherit.
//
// Since M22 (docs/planning/_archive/M22.md, Design 6, 11) a session is started under a mode. M16–M21's tests
// start theirs under the reading mode, which is the launch they always had (`READING`), and watch
// the events they always did: the mode's confirmations are kept apart (`watch`). M22's own tests
// start a session under a mode that acts (`under`).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { DiagnosticEvent } from '@shared/provider-kit/logger';
import type { LifecycleTrace } from '@shared/provider-kit/lifecycle-trace';
import type { InstanceEnvironment } from '@shared/provider-kit/process';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { ProviderSession, SessionFacet, SessionStart } from '@shared/provider-kit/sessions';
import { createProcessServices } from '../../../src/main/process';
import { createClaudeProvider } from '../../../src/main/providers/claude';
import { chatFixedArgs, type ChatTimings } from '../../../src/main/providers/claude/chat-launch';
import { READING_MODE } from '../../../src/main/providers/claude/chat-modes';
import { CLAUDE_INSTANCES } from '../../../src/main/providers/claude/descriptor';
import { CLAUDE_CHILD_ENVIRONMENT } from '../../../src/main/providers/claude/environment';
import { removeFolder } from '../../process/remove-folder';

import { eventually, watch as watchSession, type Watched } from '../../sessions/watch';

export { eventually } from '../../sessions/watch';

/** The reading mode's launch (M22, C45): the fixed arguments every session had before there were modes. */
export const CHAT_FIXED_ARGS = chatFixedArgs(READING_MODE);

/** What a start names beside its folder, its model and its effort (M22): the reading mode, and a process key, which the adapter keeps and reads nothing of. */
export const READING: Pick<SessionStart, 'mode' | 'processKey'> = { mode: 'read-only', processKey: 'process-of-a-test' };

/** A session's start in the harness's project, under a mode (M22). */
export const under = (h: Pick<Harness, 'project'>, mode: string, patch: Partial<SessionStart> = {}): SessionStart => ({ folder: h.project, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], mode, processKey: 'process-of-a-test', ...patch });

/** A watched session, and the modes it confirmed, by fat-g's id for each, in their order (M22, C2). */
export interface WatchedChat extends Watched {
  readonly confirmed: string[];
}
export type { WatchedChat as Watched };

/**
 * A session with its events collected. The mode's own confirmations — the one a launch's first
 * check brings, and the one a confirmed change does — carry the mode alone, and are kept apart in
 * `confirmed`, so that `events` holds what a session told before there were modes. A
 * `steer-changed` is left out too: steer.integration.test.ts reads those.
 */
export function watch(session: ProviderSession): WatchedChat {
  const confirmed: string[] = [];
  // A session is a set of closures: one whose subscription leaves the confirmations out is the same session.
  const apart: ProviderSession = { ...session, subscribe: (listener) => session.subscribe((event) => { if (event.type === 'in-force' && event.mode !== undefined && event.model === undefined) confirmed.push(event.mode); else if (event.type !== 'steer-changed') listener(event); }) };
  return { ...watchSession(apart), confirmed };
}

// Real processes, and many of them when the whole suite runs at once: every wait here is on an
// event, never on a guess at how long something takes, and a test may take its time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE = path.resolve('tests/fixtures/fake-claude-cli.mjs');
const CAPTURES = path.resolve('tests/fixtures/claude/captures');

/** A capture's own prompt — its first, or its `nth` (M22: one of K2's has a turn a prompt) — as the fake compares it: with the folder it runs in for `<scratch>` (C79). */
export function promptOf(name: string, folder: string, nth = 0): string {
  const capture = JSON.parse(readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8')) as { frames: { dir: string; frame: { type?: string; uuid?: string; message?: { content?: unknown } } }[] };
  const prompt = capture.frames.filter((entry) => entry.dir === 'send' && entry.frame.type === 'user')[nth];
  const text = prompt?.frame.message?.content;
  if (typeof text !== 'string' || typeof prompt?.frame.uuid !== 'string') throw new Error(`${name} has no prompt that carries an id`);
  return text.replaceAll('<scratch>', folder);
}

/** The captures' prompts, for a session that runs in `folder`. */
export const prompts = (folder: string) => ({
  t1: promptOf('m16-t1-basic', folder), t3: promptOf('m16-t3-subagent', folder), t4: promptOf('m16-t4-interrupt', folder), t5: promptOf('m16-t5-error', folder),
  /** A command the CLI answers by itself and fat-g passes as written (M20b, C57; K2): `/exit`. */
  command: promptOf('m20b-cmd-exit', folder),
  /** One fat-g answers itself, and never sends (M20b, C55): `/model haiku`, the prompt M16's capture was taken with while the launch still turned the CLI's commands off. */
  intercepted: promptOf('m16-command-refused', folder),
  early: promptOf('m16-chat-early-interrupt', folder), self: promptOf('m16-self-turn', folder), request: promptOf('m16-chat-request', folder),
  /** K17's second prompt, written while its worker still runs. */
  ok: 'Reply with the single word ok. Use no tools.',
  /** M19's K2: an answer of 267 deltas in Markdown, and the two prompts of a first answer cut by force. */
  markdown: promptOf('m19-markdown', folder), cut: promptOf('m19-cut-cut', folder), cutResumed: promptOf('m19-cut-resumed', folder),
  /**
   * M21's K1: a question answered from one of two options, one that takes several of three, two in
   * one request, and the prompt K1 sent the session it resumed after its process was killed with a
   * question pending. K1's Stop and K1's kill share the first one's prompt.
   */
  question: promptOf('m21-question-one', folder), questionMulti: promptOf('m21-question-multi', folder), questionTwo: promptOf('m21-question-two', folder), questionDecline: promptOf('m100b-question-decline', folder), goOn: promptOf('m21-question-killed-resumed', folder),
  /**
   * M22's K2, each a turn that asks leave to act: a command, and the same command asked again; a
   * command for a session grant, and that command again — which runs unasked in a process that holds
   * the grant, and asks in one that does not; four file changes; a worker's command; three steps under
   * Edits ok that ask nothing, and the file change K2 stopped; and the turn a rule allowed one command
   * of and denied another.
   */
  approve: promptOf('m22-approve-once', folder), approveAgain: promptOf('m22-approve-once', folder, 1),
  grant: promptOf('m22-approve-session', folder), grantAgain: promptOf('m22-approve-session', folder, 1),
  files: promptOf('m22-approve-files', folder), worker: promptOf('m22-approve-worker', folder),
  edits: promptOf('m22-mode-accept-edits', folder), restored: promptOf('m22-mode-accept-edits', folder, 1), inherited: promptOf('m22-inherited', folder),
  /**
   * M22's K5, each a turn that asks nothing, under the mode it was captured under: four steps under
   * Auto reviewed and the same four under Berserk, a file outside every root among them, and a
   * sub-agent's file and command under Edits ok.
   */
  auto: promptOf('m22-mode-auto', folder), bypass: promptOf('m22-mode-bypass-main', folder), workerEdits: promptOf('m22-mode-worker', folder),
});

/**
 * What the fake replays for the five prompts M16's captures and M19's share (M19, C55): K2's
 * capture, which holds the reply's stream events. A session's entry names its turns by these.
 */
export const REPLAYED = { t1: 'm19-t1-basic', t3: 'm19-t3-subagent', t4: 'm19-t4-interrupt', t5: 'm19-t5-error', command: 'm20b-cmd-exit' } as const;

/** K2's seven commands that pass as written (M20b, C57, C58), by capture: each capture's one prompt is the command. */
export const PASSED_COMMANDS = ['m20b-cmd-btw', 'm20b-cmd-compact', 'm20b-cmd-exit', 'm20b-cmd-login', 'm20b-cmd-logout', 'm20b-cmd-quit', 'm20b-cmd-resume'] as const;

/** A session as the fake's session file has it: what was asked of it, for a test to read. */
export interface SessionEntry {
  readonly cwd: string | null;
  readonly kept: boolean;
  readonly turns: readonly string[];
  readonly interrupts: readonly { readonly inputOpen: boolean; readonly turn: boolean; readonly workers: number }[];
  /** `mode`, `tools` (M22): the permission mode and the tool list the launch named, in the CLI's own words. */
  readonly launches: readonly { readonly pid: number; readonly args: readonly string[]; readonly cwd: string; readonly config: string | null; readonly model: string; readonly effort: string | null; readonly resume: string | null; readonly addDirs: readonly string[]; readonly mode: string; readonly tools: readonly string[] }[];
  readonly efforts: readonly unknown[];
  /** fat-g's replies to the CLI's requests: an `allow`'s with the input it sent back (M21, C50), and with the one update a session grant sends (M22, C69). */
  readonly answers: readonly { readonly subtype: string | null; readonly behavior: string | null; readonly message: string | null; readonly error: string | null; readonly updatedInput?: Readonly<Record<string, unknown>>; readonly updatedPermissions?: readonly Readonly<Record<string, unknown>>[] }[];
  /** The changes of mode it was sent (M22): the CLI's word for the mode, whether a turn ran, and how it was answered. */
  readonly modes: readonly { readonly mode: string; readonly turn: boolean; readonly answered: 'success' | 'error' | 'none' }[];
  /** The session rules the fake recorded (M22). */
  readonly grants: readonly { readonly toolName: string; readonly ruleContent: string | null }[];
  /** The paths the fake made or changed in its scratch project (M22). */
  readonly writes: readonly string[];
  /** The `detail` of each context request it was sent (decision 0033). */
  readonly contexts: readonly (string | null)[];
}

export interface Harness {
  readonly dir: string;
  /** A folder a session may start in, and a second one beside it, as a project's other root. */
  readonly project: string;
  readonly second: string;
  /** The fake's own folder: its control file, its ledger, each process's environment. */
  readonly fixture: string;
  readonly services: ReturnType<typeof createProcessServices>;
  /** The first instance's adapter, detected, with its facet. */
  readonly provider: AgentProvider;
  readonly facet: SessionFacet;
  readonly context: ProviderContext;
  readonly prompts: ReturnType<typeof prompts>;
  /** Another adapter, in a scope of its own: an added instance when `instance` is given. */
  adapter(instance?: InstanceEnvironment): Promise<{ provider: AgentProvider; facet: SessionFacet; context: ProviderContext }>;
  control(value: Record<string, unknown>): void;
  /** The sessions the fakes started, by their id. */
  sessions(): Record<string, SessionEntry>;
  /** The one session there is, with its id. */
  only(): { readonly id: string; readonly entry: SessionEntry };
  /** Every process the fakes recorded, by role, and which of them are still running. */
  ledger(): { readonly pid: number; readonly role: string }[];
  pids(role?: string): number[];
  running(role?: string): number[];
  /** What a recorded process inherited: every name of interest, and the values tests assert. */
  env(role: string, pid: number): { readonly names: readonly string[]; readonly values: Readonly<Record<string, string>> };
  /** The marker files the fake leaves for what must never happen. */
  markers(): string[];
  diagnostics(): DiagnosticEvent[];
  dispose(): Promise<void>;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export interface HarnessOptions {
  readonly trace?: LifecycleTrace;
  readonly timings?: Partial<ChatTimings>;
  /** What the fakes inherit, beside the session file and a short gap. */
  readonly env?: Record<string, string>;
  /**
   * Windows only: the adapter finds the fake behind a `.cmd` shim, as an npm install of the CLI is
   * one, so its launches go through the process layer's shim rules (C20).
   */
  readonly shim?: boolean;
}

export async function claudeHarness(options: HarnessOptions = {}): Promise<Harness> {
  // The real path: the fake names its folder as its own process reports it.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'fatg-claude-chat-')));
  const project = path.join(dir, 'project');
  const second = path.join(dir, 'second');
  const fixture = path.join(dir, 'fixture');
  for (const folder of [project, second, fixture]) mkdirSync(folder);
  const sessionsFile = path.join(dir, 'chat-sessions.json');
  const controlFile = path.join(fixture, 'control.json');
  writeFileSync(controlFile, '{}');
  // What the fakes inherit. Set before the process services read the environment, and taken back after.
  const inherited: Record<string, string> = { FATG_SMOKE_CLAUDE_SESSIONS: sessionsFile, FATG_SMOKE_CLAUDE_GAP_MS: '1', ...options.env };
  const saved = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  let services: ReturnType<typeof createProcessServices>;
  try { services = createProcessServices(path.join(dir, 'data'), { protectedVariables: [CLAUDE_INSTANCES.variable], trace: options.trace }); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const adapters: AgentProvider[] = [];
  // The shim runs Node on the fake with its fixture folder, and hands on whatever it was given.
  const shim = path.join(dir, 'claude.cmd');
  if (options.shim === true) writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE}" --fixture-dir "${fixture}" %*\r\n`);
  async function adapter(instance?: InstanceEnvironment): Promise<{ provider: AgentProvider; facet: SessionFacet; context: ProviderContext }> {
    const context = services.createContext(CLAUDE_CHILD_ENVIRONMENT, instance);
    const provider = createClaudeProvider(context, { argsPrefix: options.shim === true ? [] : [FAKE, '--fixture-dir', fixture], ...(options.timings === undefined ? {} : { chatTimings: options.timings }) });
    adapters.push(provider);
    const detection = await provider.detect({ override: options.shim === true ? shim : process.execPath, knownDirs: [] }, new AbortController().signal);
    if (detection.kind !== 'found') throw new Error(`the fake was not detected: ${detection.kind}`);
    if (provider.sessions === undefined) throw new Error('the Claude adapter has no session facet');
    return { provider, facet: provider.sessions, context };
  }
  const first = await adapter();
  const ledger = (): { pid: number; role: string }[] => {
    try { return readFileSync(path.join(fixture, 'pids'), 'utf8').trim().split('\n').filter(Boolean).map((line) => ({ pid: Number(line.split(' ')[0]), role: String(line.split(' ')[1]) })); } catch { return []; }
  };
  const pids = (role?: string): number[] => ledger().filter((entry) => role === undefined || entry.role === role).map((entry) => entry.pid);
  const sessions = (): Record<string, SessionEntry> => { try { return (JSON.parse(readFileSync(sessionsFile, 'utf8')) as { sessions: Record<string, SessionEntry> }).sessions; } catch { return {}; } };
  return {
    dir, project, second, fixture, services, provider: first.provider, facet: first.facet, context: first.context, prompts: prompts(project), adapter,
    control: (value) => writeFileSync(controlFile, JSON.stringify(value)),
    sessions,
    only() {
      const entries = Object.entries(sessions());
      if (entries.length !== 1) throw new Error(`expected one session of the fake's, found ${entries.length}`);
      const [id, entry] = entries[0] as [string, SessionEntry];
      return { id, entry };
    },
    ledger, pids,
    running: (role) => pids(role).filter(alive),
    env: (role, pid) => JSON.parse(readFileSync(path.join(fixture, `env-${role}-${pid}.json`), 'utf8')) as { names: string[]; values: Record<string, string> },
    markers: () => readdirSync(fixture).filter((name) => ['prompts', 'overlaps', 'sdk-markers', 'unexpected-args', 'prompt-without-id', 'unexpected-chat-request', 'cli-request-accepted', 'unexpected-permission-update'].includes(name)),
    diagnostics: () => services.diagnostics.snapshot(),
    async dispose() {
      await Promise.all(adapters.map((provider) => provider.dispose().catch(() => undefined)));
      await services.killAll();
      for (const pid of pids()) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
      await removeFolder(dir);
    },
  };
}

/**
 * The session is over and its process is gone. Whether the tree's end was confirmed at once is the
 * process layer's own tests' to show (tests/process/): a forced end on a busy machine can be
 * confirmed a moment late, and what a session does with either answer is tested on a scripted process.
 */
export async function processGone(h: Harness, session: { readonly closed: Promise<unknown> }, remaining = 0): Promise<void> {
  await session.closed;
  await eventually(() => h.running('chat').length <= remaining, 15_000, 'the session’s process ending');
}
