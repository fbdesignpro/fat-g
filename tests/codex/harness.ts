// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Codex adapter against the replay fake, through the real process layer (docs/planning/_archive/M15.md,
// Verification): what tests/codex/ shares. No test here uses the real CLI (decision 0009, item 5).
//
// The fake is Node running tests/fixtures/fake-codex-cli.mjs. Its files — the thread file, the
// control file, the process ledger — are in a folder made per harness, and it is told of them
// through the environment this process's children inherit.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { LifecycleTrace } from '@shared/provider-kit/lifecycle-trace';
import type { InstanceEnvironment } from '@shared/provider-kit/process';
import type { AgentProvider } from '@shared/provider-kit/provider';
import type { HistoryFacet, SessionFacet } from '@shared/provider-kit/sessions';
import { createProcessServices } from '../../src/main/process';
import { createCodexProvider } from '../../src/main/providers/codex';
import { CODEX_INSTANCES } from '../../src/main/providers/codex/descriptor';
import type { SandboxTimings } from '../../src/main/providers/codex/sandbox';
import type { SessionTimings } from '../../src/main/providers/codex/session-process';
import { removeFolder } from '../process/remove-folder';

// Real processes, and many of them when the whole suite runs at once: every wait here is on an
// event, never on a guess at how long something takes, and a test may take its time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE = path.resolve('tests/fixtures/fake-codex-cli.mjs');
const CAPTURES = path.resolve('tests/fixtures/codex/captures');

/** A capture's own prompt: what makes the fake replay it (C71). */
export function promptOf(name: string, nth = 0): string {
  const capture = JSON.parse(readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8')) as { frames: { dir: string; frame: { method?: string; params?: { input?: { text: string }[] } } }[] };
  // A capture of several turns: each by its own prompt (M21, M22).
  const start = capture.frames.filter((frame) => frame.dir === 'send' && frame.frame.method === 'turn/start')[nth];
  const text = start?.frame.params?.input?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`${name} has no prompt ${String(nth + 1)}`);
  return text;
}

export const PROMPTS = {
  t1: promptOf('t1-basic'), t3: promptOf('t3-subagent'), t4: promptOf('t4-interrupt'), t5: promptOf('t5-error'), t6: promptOf('t6-question'),
  saved: promptOf('m15-saved'), resume: promptOf('m15-resume'), outlive: promptOf('m15-worker-outlives-turn'), workerInterrupt: promptOf('m15-worker-interrupt'),
  // K1's two own prompts (M19): an answer the capture shows interrupted, and a long Markdown answer.
  interrupted: promptOf('m19-interrupt'), markdown: promptOf('m19-markdown'),
  // K2's (M21): the turn that asks through a request, the one that asks in a message, and the one that asks two questions in one.
  plan: promptOf('m21-codex-plan'), asks: promptOf('m21-codex-async'), asksTwo: promptOf('m21-codex-async-two'),
  // K1's, K4's and K6's (M22): a command that asks, and the same again; a file that asks, and the change K1 made to it next;
  // three files, each asking; a worker's command; a file change under Sandbox ok; and the turns under the reviewer and under Berserk.
  command: promptOf('m22-codex-once'), commandAgain: promptOf('m22-codex-once', 1), file: promptOf('m22-codex-file-session-same-main'), fileAgain: promptOf('m22-codex-file-session-same-main', 1),
  files: promptOf('m22-codex-files'), workerCommand: promptOf('m22-codex-worker'), outside: promptOf('m22-codex-reviewer-turn-main'), reviewed: promptOf('m22-codex-auto-review-main'), berserk: promptOf('m22-codex-berserk-main'),
};

/**
 * The captures T1's and T3's prompts choose under the session handshake (M19, C54): it keeps an
 * agent message's deltas, so the fake replays K1's captures of those prompts, which hold them. The
 * other prompts choose captures of whole items, as before.
 */
export const STREAMED = { t1: 'm19-answer', t3: 'm19-worker' } as const;

export interface ThreadEntry {
  readonly cwd: string | null;
  readonly kept: boolean;
  readonly turns: readonly string[];
  readonly interrupts: readonly { readonly inputOpen: boolean; readonly worker: boolean }[];
  readonly launches: readonly { readonly pid: number; readonly args: readonly string[]; readonly cwd: string; readonly home: string | null }[];
  /** Each history request the fake got for the thread, in order (M18): which view, how many turns, and whether from a cursor. Absent until the first. */
  readonly historyReads?: readonly { readonly view: string; readonly limit: number | null; readonly cursor: boolean }[];
  /** What each start and resume of the thread named of a policy (M22). */
  readonly opens?: readonly { readonly method: string; readonly sandbox: string | null; readonly approvalPolicy: string | null; readonly approvalsReviewer: string | null }[];
  /** What each `turn/start` of the thread named of one: nulls where it named none. */
  readonly policies?: readonly { readonly approvalPolicy: unknown; readonly sandboxPolicy: unknown; readonly approvalsReviewer: unknown }[];
  /** Each reply fat-g gave to a request of the thread's turns, in order (M21, M22). */
  readonly replies?: readonly ({ readonly id: number; readonly result: unknown } | { readonly id: number; readonly error: unknown })[];
  /** Each change the fake made in its project folder for an accepted request (M22): the file's name there, and how. */
  readonly changes?: readonly { readonly file: string; readonly kind: string }[];
}

/** What the fakes noted of an account's sandbox (M22): its state once a setup made one, and each request of it, with the process that got it. */
export interface SandboxNotes {
  readonly state?: string;
  readonly asked?: readonly { readonly pid: number; readonly method: string; readonly params: unknown }[];
}

export interface Harness {
  readonly dir: string;
  /** A folder a session may start in. */
  readonly project: string;
  readonly services: ReturnType<typeof createProcessServices>;
  /** The first instance's adapter, detected, with its facet. */
  readonly provider: AgentProvider;
  readonly facet: SessionFacet;
  /** That facet's history member (M18, C6): Codex's descriptor says it has one. */
  readonly history: HistoryFacet;
  readonly context: ProviderContext;
  /** Another adapter, in a scope of its own: an added instance when `instance` is given. */
  adapter(instance?: InstanceEnvironment): Promise<{ provider: AgentProvider; facet: SessionFacet; context: ProviderContext }>;
  control(value: Record<string, unknown>): void;
  threads(): Record<string, ThreadEntry>;
  /** The notes of an account's sandbox: the first account's, or the one whose home is given. */
  sandbox(home?: string): SandboxNotes;
  /** Every process the fakes recorded, and which of them are still running. */
  pids(): number[];
  running(): number[];
  dispose(): Promise<void>;
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function codexHarness(options: { readonly trace?: LifecycleTrace; readonly timings?: Partial<SessionTimings>; readonly env?: Record<string, string>; /** False leaves the existing connection unconnected. */ readonly connect?: boolean; /** The system the adapter takes itself to run on (M22): Codex's sandbox setup is Windows' alone. */ readonly platform?: NodeJS.Platform; readonly sandboxTimings?: Partial<SandboxTimings> } = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'fatg-codex-'));
  const project = path.join(dir, 'project');
  mkdirSync(project);
  const files = { threads: path.join(dir, 'threads.json'), control: path.join(dir, 'control.json'), pids: path.join(dir, 'pids') };
  writeFileSync(files.control, '{}');
  // What the fakes inherit. Set before the process services read the environment, and taken back after.
  const inherited: Record<string, string> = { FATG_SMOKE_CODEX_THREADS: files.threads, FATG_SMOKE_CODEX_CONTROL: files.control, FATG_SMOKE_PIDS: files.pids, FATG_SMOKE_CODEX_GAP_MS: '1', ...options.env };
  const saved = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  let services: ReturnType<typeof createProcessServices>;
  try { services = createProcessServices(path.join(dir, 'data'), { protectedVariables: [CODEX_INSTANCES.variable], trace: options.trace }); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const adapters: AgentProvider[] = [];
  async function adapter(instance?: InstanceEnvironment): Promise<{ provider: AgentProvider; facet: SessionFacet; context: ProviderContext }> {
    const context = services.createContext(undefined, instance);
    const provider = createCodexProvider(context, { applicationVersion: '0.0.0-test', argsPrefix: [FAKE], requestTimeoutMs: 2_000, emptyRetryMs: 10, ...(options.timings === undefined ? {} : { sessionTimings: options.timings }), ...(options.platform === undefined ? {} : { platform: options.platform }), ...(options.sandboxTimings === undefined ? {} : { sandboxTimings: options.sandboxTimings }) });
    adapters.push(provider);
    const detection = await provider.detect({ override: process.execPath, knownDirs: [] }, new AbortController().signal);
    if (detection.kind !== 'found') throw new Error(`the fake was not detected: ${detection.kind}`);
    if (provider.sessions === undefined) throw new Error('the Codex adapter has no session facet');
    // As the app does at start: an account read, which connects the instance's existing connection.
    if (options.connect !== false) await provider.getAccount(new AbortController().signal);
    return { provider, facet: provider.sessions, context };
  }
  const first = await adapter();
  const { history } = first.facet;
  if (history === undefined) throw new Error('the Codex adapter’s facet has no history member');
  const pids = (): number[] => { try { return readFileSync(files.pids, 'utf8').trim().split('\n').filter(Boolean).map((line) => Number(line.split(' ')[0])); } catch { return []; } };
  return {
    dir, project, services, provider: first.provider, facet: first.facet, history, context: first.context, adapter,
    control: (value) => writeFileSync(files.control, JSON.stringify(value)),
    threads() { try { return (JSON.parse(readFileSync(files.threads, 'utf8')) as { threads: Record<string, ThreadEntry> }).threads; } catch { return {}; } },
    sandbox(home = 'default') { try { return (JSON.parse(readFileSync(files.threads, 'utf8')) as { sandbox?: Record<string, SandboxNotes> }).sandbox?.[home] ?? {}; } catch { return {}; } },
    pids,
    running: () => pids().filter(alive),
    async dispose() {
      await Promise.all(adapters.map((provider) => provider.dispose()));
      await services.killAll();
      for (const pid of pids()) { if (alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } }
      await removeFolder(dir);
    },
  };
}

// A session with its events collected, and a wait on a condition: shared with the other adapters' tests.
export { eventually, watch, type Watched } from '../sessions/watch';
