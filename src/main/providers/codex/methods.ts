// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What fat-g may send Codex, in one place (docs/planning/_archive/M15.md, Design 5; C13, C14, C36, C106;
// M20b.md, Design 4; C19, C27; M22.md, Design 7; C13, C60, C73; decisions 0018, 0025, 0027). Three connections, three fixed sets of methods, and the only functions in this module
// that call `request` or `notify`: each refuses a method outside its connection's set before
// anything is written. tests/architecture/codex-confinement.test.ts searches the module for any
// other sender.
//
// No set holds a login, a configuration method, or any method that lists, reads, names or
// deletes the user's threads, and no handshake asks for the experimental API.
//
// A session's set holds `thread/fork` for one thing (M20b, C19): an aside's side thread, an
// ephemeral copy of the session's own thread, read-only as its parent is. Its fields are the
// session's to choose, in one place (session.ts), and never a `config` override.
//
// The third set is the sandbox connection's (M22, C73): a short-lived process of the account's own,
// opened for one request and closed at its end — what Codex answers of its Windows sandbox, and,
// at the user's press alone, its own setup. Neither method can be sent on the instance's connection
// or a session's, and that connection can start no thread.
//
// The fourth is the secretary's (M26; decision 0028): a short-lived process of the account's own,
// opened for one request and closed at its end — one ephemeral thread, started read-only, and one
// turn on it. It can resume, fork, interrupt or read no thread.
import { ProcessFailure } from '@shared/provider-kit/process';
import type { RequestOptions, RpcConnection } from '@shared/provider-kit/rpc';

/** `existing`: an instance's supervised connection, for usage, models and history. `session`: one session's own process. `sandbox`: one question of an account's sandbox, on a process of its own (M22, C73). `secretary`: one request of the secretary's, on a process of its own (M26). */
export type ConnectionKind = 'existing' | 'session' | 'sandbox' | 'secretary';

/** The history read (C57, C134): the paged call M15's spike settled. */
export const HISTORY_METHOD = 'thread/turns/list';

/** The skills read (M23, C63; K1): a folder's skills, by name, description, scope and path. */
export const SKILLS_METHOD = 'skills/list';

const SETS: Readonly<Record<ConnectionKind, ReadonlySet<string>>> = Object.freeze({
  // `skills/list` (M23, C63): what the CLI lists for a session's folder, on the instance's own connection alone.
  existing: Object.freeze(new Set(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'model/list', HISTORY_METHOD, SKILLS_METHOD])),
  // `turn/steer` (M23, C36): a message into the session's own running turn, on its own process alone.
  session: Object.freeze(new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt', 'turn/steer'])),
  sandbox: Object.freeze(new Set(['initialize', 'initialized', 'windowsSandbox/readiness', 'windowsSandbox/setupStart'])),
  secretary: Object.freeze(new Set(['initialize', 'initialized', 'thread/start', 'turn/start'])),
});

export function mayBeSent(kind: ConnectionKind, method: string): boolean {
  return SETS[kind].has(method);
}

/** The one place a request leaves this module. */
export function sendRequest(kind: ConnectionKind, rpc: Pick<RpcConnection, 'request'>, method: string, params: unknown, options?: RequestOptions): Promise<unknown> {
  if (!mayBeSent(kind, method)) return Promise.reject(new ProcessFailure('protocol-error'));
  return rpc.request(method, params, options);
}

/** The one place a notification leaves this module. */
export function sendNotification(kind: ConnectionKind, rpc: Pick<RpcConnection, 'notify'>, method: string, params: unknown): Promise<void> {
  if (!mayBeSent(kind, method)) return Promise.reject(new ProcessFailure('protocol-error'));
  return rpc.notify(method, params);
}

/**
 * The eleven delta notifications of codex-cli 0.155.1's schema, checked against it again in
 * M15 (step 1), and on codex-cli 0.163.0 (M22b, step 0). A session's
 * handshake opts out of nine of them (`OPTED_OUT_DELTAS`); the
 * existing connection runs no thread, and its handshake stays as it was.
 */
export const DELTA_METHODS: readonly string[] = Object.freeze([
  'command/exec/outputDelta',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'process/outputDelta',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/transcript/delta',
]);

/** The one delta a session takes (M19, C7): an agent message's text as it is written. A notification the CLI sends, never a method fat-g calls. */
export const MESSAGE_DELTA_METHOD = 'item/agentMessage/delta';
/** And a plan's (M22b, C14): a plan item's text as it is written. A notification too. */
export const PLAN_DELTA_METHOD = 'item/plan/delta';

/**
 * The nine a session's handshake opts out of (M19, C7; M22b, C14; amends M15, C13): command,
 * file-change and process output, reasoning and realtime. Those are later milestones'; until then
 * the CLI sends their items whole.
 */
export const OPTED_OUT_DELTAS: readonly string[] = Object.freeze(DELTA_METHODS.filter((method) => method !== MESSAGE_DELTA_METHOD && method !== PLAN_DELTA_METHOD));

export function clientInfo(applicationVersion: string): { readonly name: string; readonly title: string; readonly version: string } {
  return { name: 'fat_g', title: 'fat-g', version: applicationVersion };
}

/** The existing connection's handshake: `clientInfo` alone. */
export function existingHandshake(applicationVersion: string): unknown {
  return { clientInfo: clientInfo(applicationVersion) };
}

/** The sandbox connection's handshake (M22, C73): `clientInfo` alone, as the existing connection's. It runs no thread. */
export function sandboxHandshake(applicationVersion: string): unknown {
  return { clientInfo: clientInfo(applicationVersion) };
}

/** The secretary's handshake (M26): `clientInfo`, and the opt-out of every delta, since it reads a message whole. No experimental API. */
export function secretaryHandshake(applicationVersion: string): unknown {
  return { clientInfo: clientInfo(applicationVersion), capabilities: { optOutNotificationMethods: [...DELTA_METHODS] } };
}

/** Codex's word that a setup is over (M22, C61): a notification the sandbox connection alone subscribes to, never a method fat-g calls. */
export const SETUP_COMPLETED_METHOD = 'windowsSandbox/setupCompleted';

/**
 * A session's handshake: the opt-out of every delta but an agent message's (M19, C7) and a plan's,
 * and the experimental API (M22b, C13), which a plan turn's `collaborationMode` needs on the
 * installed CLI. `plain`: the handshake without it, for a CLI that refused it (C80), which plans nothing.
 */
export function sessionHandshake(applicationVersion: string, plain = false): unknown {
  return { clientInfo: clientInfo(applicationVersion), capabilities: { ...(plain ? {} : { experimentalApi: true }), optOutNotificationMethods: [...OPTED_OUT_DELTAS] } };
}

/**
 * The two requests that ask leave for an action (M22, C8, C13): a command, and a file change. Under
 * Read only each is declined at once, as T7's was (M15, C34). Under every other mode one the
 * session can place and show whole is held, and answered `accept`, `acceptForSession` or `decline`
 * from the user's decision; one it cannot is refused. Every other request but a question is
 * "method not found".
 */
export const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
export const FILE_APPROVAL = 'item/fileChange/requestApproval';
export const APPROVAL_REQUESTS: readonly string[] = Object.freeze([COMMAND_APPROVAL, FILE_APPROVAL]);

/**
 * The one request a session answers when its answer comes, and not at once (M21, C23; decision
 * 0018, item 7): a question the model asks the user. Its reply is the user's answer and grants
 * nothing; one fat-g cannot place or cannot show is "method not found", as before.
 */
export const QUESTION_REQUEST = 'item/tool/requestUserInput';

/**
 * Codex's leave to run an MCP tool (decisions 0018, 0027): an MCP elicitation of its own kind, its
 * `_meta.codex_approval_kind` `mcp_tool_call`, held and answered from its card as a command's is, in
 * the elicitation's own words: `accept`, with `_meta.persist` `session` for the session's grant, or
 * `decline`. Never `always`, which Codex would keep beyond the session. Any other elicitation — an
 * MCP server's own form or address — is still "method not found" (spikes/codex-mcp, codex-cli 0.164.0).
 */
export const MCP_ELICITATION = 'mcpServer/elicitation/request';

/** The ten methods the stable schema lists as requests from the server (0.155.1). */
export const SERVER_REQUESTS: readonly string[] = Object.freeze([
  'account/chatgptAuthTokens/refresh',
  'applyPatchApproval',
  'attestation/generate',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/call',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

/** What a refused request is counted under (C106): its method when the schema lists it, else `other`, so no string the CLI chose reaches a log. */
export function refusedMethod(method: string): string {
  return SERVER_REQUESTS.includes(method) ? method : 'other';
}

/**
 * The code Codex refuses the resume of a missing thread with (C129; traced). It gives
 * the same code to other refusals — an id that is not well formed, a signed-out account's usage
 * read — and the adapter reads the code alone, never the message: so what the chat offers on it is
 * worded as unsure.
 */
export const MISSING_THREAD_CODE = -32600;

/**
 * The code Codex refuses a steer naming a turn that is over with (M23, C39; K1): the same
 * general invalid-request code, so it is taken for the turn's end only where that turn's end is known.
 */
export const STALE_STEER_CODE = -32600;
