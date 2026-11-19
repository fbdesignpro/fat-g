// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's Windows sandbox, for one account (docs/planning/_archive/M22.md, Design 7; C60–C62, C72, C73;
// decision 0027): whether it is set up, and — at the user's press alone — Codex's own setup. Each
// question is asked on a connection of its own: a short-lived app-server in the account's scope,
// started as its other processes are, which makes its handshake, is sent one request and is
// closed. It starts no thread, and its two methods are in a set of their own (methods.ts), which
// neither the instance's connection nor a session's can send.
//
// Readiness. `windowsSandbox/readiness` is asked of a fresh process when the account's modes are
// first listed in a run and after each setup's end; its answer is kept for the run and dropped at
// a setup's end. The process that ran a setup still answers that none is set up (K6), so readiness
// is never asked on a setup's own connection.
//
// The setup changes the machine — sandbox accounts, firewall rules, file permissions — and fat-g
// cannot undo it. So `windowsSandbox/setupStart` is sent once for each press and never otherwise,
// in the one mode that was traced, and Windows asks for the administrator's approval by itself:
// fat-g asks for, sees and keeps no credential. Its outcome is Codex's own word,
// `windowsSandbox/setupCompleted`, waited for with no clock:
//
//   idle ─► starting ─► waiting ─► completed   Codex said it succeeded, and a fresh process answers ready
//              │           ├─────► failed      Codex said it did not, with its reason: a declined prompt among them
//              │           └─────► unknown     the connection ended first, or the user let go of the wait;
//              │                               or Codex said it succeeded and a fresh process does not say ready
//              ├─────────────────► failed      Codex refused the request, or answered without `started`;
//              │                               or the process could not be started, and nothing was sent
//              └─────────────────► unknown     the request was sent and not answered
//
// A success is never taken from the completion alone (C61): the connection is closed and readiness
// is asked of a fresh process, the setup still `waiting` meanwhile. An end fat-g did not hear is
// said as unknown — the setup may still be changing the machine — and readiness is then read from a
// fresh process and shown. Every end releases the account; nothing of a setup is kept across a
// restart, after which the account stands on readiness alone.
//
// Nothing of this is asked on a system other than Windows: the facet makes none of these there.
import { cutTo } from '@shared/contracts/cut';
import { MAX_SETUP_ERROR, type SandboxReadiness, type SandboxSetupState, type SandboxSetupView, type SetupAction } from '@shared/contracts/permissions';
import type { ProviderContext } from '@shared/provider-kit/context';
import { ProcessFailure, type Executable } from '@shared/provider-kit/process';
import type { OpenConnection } from '@shared/provider-kit/rpc';
import { sandboxHandshake, sendNotification, sendRequest, SETUP_COMPLETED_METHOD } from './methods';

/** The sandbox connection's deadlines (C72). A setup's completion has none. */
export interface SandboxTimings {
  /** The process's start, with its handshake. */
  readonly launchMs: number;
  /** `windowsSandbox/readiness`. */
  readonly readinessMs: number;
  /** `windowsSandbox/setupStart`, to its reply alone. */
  readonly setupMs: number;
}

export const SANDBOX_TIMINGS: SandboxTimings = Object.freeze({ launchMs: 30_000, readinessMs: 10_000, setupMs: 15_000 });

/** How many readiness reads may fail in a row before no more is started by a listing: the next comes with the instance's connection, or a setup's end. */
export const MAX_READINESS_ATTEMPTS = 2;

/** Codex's three answers, in fat-g's words. */
const READINESS: Readonly<Record<string, SandboxReadiness>> = { ready: 'ready', notConfigured: 'not-configured', updateRequired: 'update-required' };

export interface CodexSandboxOptions {
  readonly context: ProviderContext;
  /** What the instance's detection found: undefined until it has. */
  readonly executable: () => Executable | undefined;
  readonly argsPrefix: readonly string[];
  readonly applicationVersion: string;
  readonly timings?: Partial<SandboxTimings>;
  /** What `readiness` or `view` would now answer has changed. */
  readonly onChanged: () => void;
  /** A setup has ended (C73): what the account's start replies said before it is no longer what they would say. */
  readonly onSetupEnded: () => void;
}

export interface CodexSandbox {
  /**
   * What a fresh process last answered, or null where none has. Asking starts the read where none
   * is known and none is under way; its answer comes later, as a change (C73).
   */
  readiness(): SandboxReadiness | null;
  /**
   * Whether readiness is still to be known (M23, C89): none known yet, and a read under way or one a
   * listing still starts — not once its reads have failed as often as they may, which settles it.
   */
  pending(): boolean;
  view(): SandboxSetupView;
  /** `start`: sends Codex's one setup request, where none runs and its sandbox is not known to be ready. `stop-waiting`: lets go of one whose completion has not come. */
  act(action: SetupAction): 'started' | 'stopping' | 'running' | 'no-setup';
  /** The instance's own connection is ready: a read that failed may be made again. */
  retry(): void;
  /** Closes whatever connection is open. A setup under way is let go of: nothing more is said of it. */
  dispose(): Promise<void>;
}

/** One press's setup, from its start to its end. */
interface Run {
  connection: OpenConnection | null;
  /** `setupStart` has been handed to the process: from here its outcome is Codex's to say. */
  sent: boolean;
  /** Codex said it succeeded, and its connection was closed here for the fresh process's answer: that end is no end unheard. */
  confirming: boolean;
}

function takeReadiness(reply: unknown): SandboxReadiness | null {
  const status = typeof reply === 'object' && reply !== null ? (reply as { status?: unknown }).status : undefined;
  return typeof status === 'string' ? READINESS[status] ?? null : null;
}

/** `windowsSandbox/setupCompleted` (C61): whether it succeeded, and Codex's own reason where it did not, bounded. */
function takeCompleted(params: unknown): { readonly success: boolean; readonly error: string | null } {
  const frame = typeof params === 'object' && params !== null ? (params as { success?: unknown; error?: unknown }) : {};
  return { success: frame.success === true, error: typeof frame.error === 'string' && frame.error.trim() !== '' ? cutTo(frame.error, MAX_SETUP_ERROR).text : null };
}

export function createCodexSandbox(options: CodexSandboxOptions): CodexSandbox {
  const { context } = options;
  const timings: SandboxTimings = { ...SANDBOX_TIMINGS, ...options.timings };
  let disposed = false;
  let readiness: SandboxReadiness | null = null;
  /** The read whose answer is still wanted: a later one, or a setup's end, makes an earlier one's answer nobody's. */
  let reading = 0;
  let inFlight = false;
  let failedReads = 0;
  /** The account's modes have been listed in this run: readiness is wanted. */
  let wanted = false;
  let setup: { state: SandboxSetupState; error: string | null } = { state: 'idle', error: null };
  let current: Run | null = null;
  /** Every connection that is open, to be closed with the adapter. */
  const open = new Set<OpenConnection>();

  const changed = (): void => { if (!disposed) { try { options.onChanged(); } catch { /* a listener's failure is its own */ } } };

  /** A process of the account's own, its handshake made: started as the instance's others are, in fat-g's probe folder. */
  async function connect(): Promise<OpenConnection> {
    const executable = options.executable();
    if (executable === undefined || disposed) throw new ProcessFailure('spawn-failed');
    const deadline = Date.now() + timings.launchMs;
    const connection = await context.processes.open({ executable, args: [...options.argsPrefix, 'app-server'], options: { cwd: context.probeDirectory, stdoutLimit: 1024 * 1024 } });
    open.add(connection);
    void connection.done.then(() => open.delete(connection));
    try {
      if (disposed) throw new ProcessFailure('disposed');
      await sendRequest('sandbox', connection, 'initialize', sandboxHandshake(options.applicationVersion), { timeoutMs: Math.max(1, deadline - Date.now()) });
      await sendNotification('sandbox', connection, 'initialized', {});
      return connection;
    } catch (error) {
      await connection.close();
      throw error instanceof ProcessFailure ? error : new ProcessFailure('spawn-failed');
    }
  }

  /** One question of a fresh process (C61, C73): the connection is closed at its reply. Null where none answered. */
  async function ask(): Promise<SandboxReadiness | null> {
    let connection: OpenConnection | undefined;
    try {
      connection = await connect();
      return takeReadiness(await sendRequest('sandbox', connection, 'windowsSandbox/readiness', undefined, { timeoutMs: timings.readinessMs }));
    } catch {
      return null;
    } finally {
      await connection?.close();
    }
  }

  /** Reads readiness from a fresh process, and tells of the answer where it changes anything. A read started after this one takes its place. */
  function read(): void {
    if (disposed || options.executable() === undefined) return;
    const mine = ++reading;
    inFlight = true;
    void ask().then((answer) => {
      if (mine !== reading || disposed) return;
      inFlight = false;
      failedReads = answer === null ? failedReads + 1 : 0;
      if (answer === readiness) return;
      readiness = answer;
      changed();
    });
  }

  /** A setup's end (C72): the account is released at once, what was known of its sandbox is dropped, and a fresh process is asked. */
  function end(run: Run, state: SandboxSetupState, error: string | null): void {
    if (current !== run) return;
    current = null;
    const { connection } = run;
    run.connection = null;
    void connection?.close();
    setup = { state, error };
    readiness = null;
    failedReads = 0;
    try { options.onSetupEnded(); } catch { /* the facet's reading is its own */ }
    // Asked before it is told: whoever hears of the end and lists the modes at once joins this read, and starts no second process.
    read();
    changed();
  }

  /**
   * Codex said the setup succeeded. That is never taken alone (C61): its connection is closed, and
   * a fresh process is asked. `ready` is the setup completed; any other answer, or none, is an
   * outcome fat-g does not know, with what the fresh process said.
   */
  async function confirm(run: Run): Promise<void> {
    const { connection } = run;
    run.connection = null;
    run.confirming = true;
    // No other read's answer is wanted beside this one.
    reading += 1;
    inFlight = true;
    await connection?.close();
    const answer = await ask();
    // Let go of meanwhile: it was said unknown, and a read of its own was started.
    if (current !== run || disposed) return;
    inFlight = false;
    current = null;
    setup = { state: answer === 'ready' ? 'completed' : 'unknown', error: null };
    readiness = answer;
    failedReads = answer === null ? 1 : 0;
    try { options.onSetupEnded(); } catch { /* the facet's reading is its own */ }
    changed();
  }

  /** The one request of a press (C60), and the wait for Codex's word. */
  async function run(mine: Run): Promise<void> {
    let connection: OpenConnection;
    try {
      connection = await connect();
    } catch {
      // Nothing was sent: the setup did not start.
      end(mine, 'failed', null);
      return;
    }
    // Let go of while the process was starting: nothing is sent for it.
    if (current !== mine) { void connection.close(); return; }
    mine.connection = connection;
    // Subscribed before the request goes (C72): Codex's word cannot come unheard.
    const completed = new Promise<{ readonly success: boolean; readonly error: string | null }>((resolve) => { connection.onNotification(SETUP_COMPLETED_METHOD, (params) => resolve(takeCompleted(params))); });
    // The connection's end before that word is an end fat-g did not hear — once the request has gone.
    void connection.done.then(() => { if (!mine.confirming) end(mine, mine.sent ? 'unknown' : 'failed', null); });
    let reply: unknown;
    try {
      mine.sent = true;
      // The mode that was traced, and no other (C62): it needs an administrator's approval, which Windows asks for by itself.
      reply = await sendRequest('sandbox', connection, 'windowsSandbox/setupStart', { mode: 'elevated', cwd: context.probeDirectory }, { timeoutMs: timings.setupMs });
    } catch (error) {
      // Codex's own refusal is a setup that did not start. Any other — no answer in time, the pipe
      // gone — leaves a request that may have been taken: its outcome is not known.
      end(mine, error instanceof ProcessFailure && error.code === 'rpc-error' ? 'failed' : 'unknown', null);
      return;
    }
    if (current !== mine) return;
    if (typeof reply !== 'object' || reply === null || (reply as { started?: unknown }).started !== true) { end(mine, 'failed', null); return; }
    setup = { state: 'waiting', error: null };
    changed();
    // No clock of fat-g's (C72): the wait ends at Codex's word, at the connection's end, or when the user lets go.
    const outcome = await completed;
    if (current !== mine) return;
    if (!outcome.success) { end(mine, 'failed', outcome.error); return; }
    await confirm(mine);
  }

  return {
    pending: () => readiness === null && options.executable() !== undefined && (inFlight || failedReads < MAX_READINESS_ATTEMPTS),
    readiness() {
      wanted = true;
      // The first listing of a run asks (C73); one after a read that failed asks again, a few times and no more.
      if (readiness === null && !inFlight && current === null && failedReads < MAX_READINESS_ATTEMPTS) read();
      return readiness;
    },
    view: () => ({ state: setup.state, error: setup.error, readiness }),
    act(action) {
      if (disposed) return 'no-setup';
      if (action === 'stop-waiting') {
        const mine = current;
        if (mine === null) return 'no-setup';
        // Before the request went nothing was asked of Codex, and there is no outcome to wonder
        // about; after it, the setup may still be changing the machine (C72).
        if (mine.sent) end(mine, 'unknown', null);
        else { current = null; void mine.connection?.close(); setup = { state: 'idle', error: null }; changed(); }
        return 'stopping';
      }
      if (current !== null) return 'running';
      // A sandbox that is ready needs none; and before Codex has said anything of it, none is offered (C60).
      if (readiness === 'ready' || (readiness === null && setup.state === 'idle') || options.executable() === undefined) return 'no-setup';
      const mine: Run = { connection: null, sent: false, confirming: false };
      current = mine;
      // A read under way would answer for the account as it was before this setup.
      reading += 1;
      inFlight = false;
      setup = { state: 'starting', error: null };
      changed();
      void run(mine);
      return 'started';
    },
    retry() {
      if (!wanted || disposed || readiness !== null || inFlight || current !== null) return;
      failedReads = 0;
      read();
    },
    async dispose() {
      disposed = true;
      current = null;
      await Promise.all([...open].map((connection) => connection.close()));
    },
  };
}
