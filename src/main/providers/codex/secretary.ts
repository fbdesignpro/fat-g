// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary on Codex (docs/planning/_archive/M26.md, Design 3; decision 0028): one short app-server per
// request, in the account's scope and fat-g's probe folder, as the sandbox's questions are asked
// (sandbox.ts). Its connection's set is the fourth (methods.ts): the handshake, one ephemeral thread
// started read-only with `never` and the task's instruction as its base instructions — in place of
// Codex's own agent instructions, which a title needs none of (M26, K2: about 13,100 input tokens
// down to 9,600) — checked against Read only before anything is sent on it, and one turn. Every request Codex makes is refused,
// and the process is closed at the turn's end, whatever it was.
//
// Its start carries the one `config` fat-g sends Codex (decision 0018, item 4, as 0028 amends it):
// `SECRETARY_CONFIG`, overrides for this thread alone that each switch something off — sub-agents,
// hooks, plugins, the shell snapshot, tool suggestions, apps and their connectors, web search — as
// Codex's own extension sends its title threads (M26, K2: 9,600 input tokens down to 5,500). A start
// Codex refuses with them is asked once more without them, so a key a later Codex no longer takes
// costs a title its saving, never the title. The user's own MCP servers stay as the account has them.
// The base instructions and the overrides are this thread's alone: a session's thread and an aside's
// are sent neither.
//
// Nothing of what it sends or reads is kept, logged or passed on but the answer's text.
import type { ProviderContext } from '@shared/provider-kit/context';
import { type Executable, ProcessFailure } from '@shared/provider-kit/process';
import type { OpenConnection } from '@shared/provider-kit/rpc';
import type { SecretaryAnswer, SecretaryRequest } from '@shared/provider-kit/sessions';
import { secretaryHandshake, sendNotification, sendRequest } from './methods';
import { checkPolicy, startPolicy } from './modes';
import { takeItemFrame, takeStartReply, takeTurnFrame, takeTurnStartReply } from './session-schemas';

/** Each step's deadline; the whole request's is the caller's. */
export interface SecretaryTimings {
  /** The process's start, with its handshake. */
  readonly launchMs: number;
  /** `thread/start` and `turn/start`, each to its reply. */
  readonly requestMs: number;
}

export const SECRETARY_TIMINGS: SecretaryTimings = Object.freeze({ launchMs: 30_000, requestMs: 15_000 });

/** The secretary's thread's overrides: every value switches something off, and none is a setting of the user's. */
export const SECRETARY_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  'features.enable_fanout': false,
  'features.hooks': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.plugins': false,
  'features.shell_snapshot': false,
  'features.tool_suggest': false,
  'features.apps': false,
  apps: Object.freeze({ _default: Object.freeze({ enabled: false, destructive_enabled: false, open_world_enabled: false }) }),
  web_search: 'disabled',
});

export interface CodexSecretaryOptions {
  readonly context: ProviderContext;
  /** What the instance's detection found: undefined until it has. */
  readonly executable: () => Executable | undefined;
  readonly argsPrefix: readonly string[];
  readonly applicationVersion: string;
  readonly timings?: Partial<SecretaryTimings>;
}

export async function runCodexSecretary(options: CodexSecretaryOptions, request: SecretaryRequest, signal: AbortSignal): Promise<SecretaryAnswer> {
  const { context } = options;
  const timings: SecretaryTimings = { ...SECRETARY_TIMINGS, ...options.timings };
  const executable = options.executable();
  if (executable === undefined) return { kind: 'failed', reason: 'unavailable' };
  if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
  let connection: OpenConnection;
  try {
    connection = await context.processes.open({ executable, args: [...options.argsPrefix, 'app-server'], options: { cwd: context.probeDirectory, stdoutLimit: 1024 * 1024 } });
  } catch {
    return { kind: 'failed', reason: 'unavailable' };
  }
  // Let go of, the process is closed at once: what it was doing ends with it.
  const abort = (): void => { void connection.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const deadline = Date.now() + timings.launchMs;
    await sendRequest('secretary', connection, 'initialize', secretaryHandshake(options.applicationVersion), { timeoutMs: Math.max(1, deadline - Date.now()), signal });
    await sendNotification('secretary', connection, 'initialized', {});

    let threadId: string | null = null;
    let last: string | null = null;
    const ended = new Promise<SecretaryAnswer>((resolve) => {
      connection.onNotification('item/completed', (params) => {
        const taken = takeItemFrame(params, false);
        if (taken === null || taken.threadId !== threadId || taken.item?.type !== 'agentMessage' || taken.item.text.trim() === '') return;
        last = taken.item.text;
      });
      connection.onNotification('turn/completed', (params) => {
        const turn = takeTurnFrame(params);
        if (turn === null || turn.threadId !== threadId) return;
        resolve(turn.status === 'completed' && last !== null ? { kind: 'answered', text: last } : { kind: 'failed', reason: 'unavailable' });
      });
      void connection.done.then(() => resolve({ kind: 'failed', reason: signal.aborted ? 'aborted' : 'unavailable' }));
    });

    // The aside's guards, with no fork (decision 0025): read-only, asked for no approval, told to act on nothing, and saved nowhere.
    const start = (overridden: boolean): Promise<unknown> => sendRequest('secretary', connection, 'thread/start', {
      cwd: context.probeDirectory,
      ...startPolicy('read-only'),
      ephemeral: true,
      baseInstructions: request.instructions,
      model: request.model,
      // Standard speed, always (decision 0018): a tier of the user's configuration is not spent on a title.
      serviceTier: 'default',
      ...(overridden ? { config: SECRETARY_CONFIG } : {}),
    }, { timeoutMs: timings.requestMs, signal });
    let reply: unknown;
    try {
      reply = await start(true);
    } catch (error) {
      // Refused by Codex itself, the overrides perhaps: once more without them. Anything else is no title.
      if (!(error instanceof ProcessFailure && error.code === 'rpc-error')) throw error;
      reply = await start(false);
    }
    const started = takeStartReply(reply);
    if (started === null || !checkPolicy('read-only', started.policy).ok) return { kind: 'failed', reason: 'unavailable' };
    threadId = started.threadId;
    const turn = takeTurnStartReply(await sendRequest('secretary', connection, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: request.text, text_elements: [] }],
      model: request.model,
      ...(request.effort === null ? {} : { effort: request.effort }),
      serviceTier: 'default',
    }, { timeoutMs: timings.requestMs, signal }));
    if (turn === null) return { kind: 'failed', reason: 'unavailable' };
    return await ended;
  } catch (error) {
    return { kind: 'failed', reason: signal.aborted || (error instanceof ProcessFailure && error.code === 'aborted') ? 'aborted' : 'unavailable' };
  } finally {
    signal.removeEventListener('abort', abort);
    await connection.close();
  }
}
