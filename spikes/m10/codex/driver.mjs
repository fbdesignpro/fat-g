// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Codex driver: `codex app-server` JSON-RPC over stdio, NDJSON framed. Codex reads the user's
// own configuration (C6): fat-g never sets CODEX_HOME, and neither does a spike.
import { Driver } from '../lib/driver.mjs';
import { CODEX_TABLE, deltaMethods, reduceConfigRead } from './frames.mjs';

export const CLIENT_INFO = Object.freeze({ name: 'fat_g', title: 'fat-g M10 spike', version: '0.0.0' });

const REQUEST_KINDS = {
  'item/commandExecution/requestApproval': 'approval',
  'item/fileChange/requestApproval': 'approval',
  execCommandApproval: 'approval',
  applyPatchApproval: 'approval',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'question',
};

const TOOL_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'collabAgentToolCall', 'sleep']);

export class CodexDriver extends Driver {
  constructor(options) {
    const reduceIds = new Set();
    const configHashes = [];
    super({
      ...options,
      args: ['app-server'],
      table: CODEX_TABLE,
      // C53: a config/read reply is reduced before the recorder (or anything else) keeps it.
      transform: (frame) => {
        if (frame && frame.id !== undefined && reduceIds.has(frame.id) && 'result' in frame) {
          reduceIds.delete(frame.id);
          const { reduced, hash } = reduceConfigRead(frame.result);
          configHashes.push(hash);
          return { id: frame.id, result: reduced };
        }
        return frame;
      },
    });
    this.reduceIds = reduceIds;
    this.configHashes = configHashes;
    this.counter = 0;
    this.threadId = null;
    this.turnId = null;
    this.nextTurn = {};
  }

  async open() {
    await this.startWire();
    this.optedOut = deltaMethods();
    const capabilities = this.optedOut.length ? { capabilities: { optOutNotificationMethods: this.optedOut } } : {};
    const reply = await this.request('initialize', { clientInfo: CLIENT_INFO, ...capabilities }, 'startup');
    await this.session.send({ method: 'initialized' });
    return reply;
  }

  /** The thread as Codex reports it now: its model and reasoning effort among the fields (T2, T8). */
  readThread() { return this.request('thread/read', { threadId: this.threadId, includeTurns: false }); }

  /** Resolves `{ ok, value | error, index }`. */
  async request(method, params, wait = 'request') {
    const id = ++this.counter;
    const from = this.nextIndex;
    if (method === 'config/read') this.reduceIds.add(id);
    await this.session.send(params === undefined ? { method, id } : { method, id, params });
    const { frame, index } = await this.session.waitFor((f) => f.id === id && !('method' in f), { wait, fromIndex: from });
    return frame.error ? { ok: false, error: frame.error, index } : { ok: true, value: frame.result, index };
  }

  async startThread(params) {
    const reply = await this.request('thread/start', params);
    if (reply.ok) this.threadId = reply.value?.thread?.id ?? null;
    return reply;
  }

  async prompt(text) {
    this.turnActive = true;
    const params = { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], ...this.nextTurn };
    this.nextTurn = {};
    const reply = await this.request('turn/start', params);
    if (reply.ok) this.turnId = reply.value?.turn?.id ?? null;
    else this.turnActive = false;
    return reply;
  }

  interrupt() { return this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
  /** Codex takes effort and model per turn: they ride on the next turn/start. */
  async setEffort(level) { this.nextTurn.effort = level; return { ok: true, deferred: true }; }
  async setModel(model) { this.nextTurn.model = model; return { ok: true, deferred: true }; }

  derive(frame, index) {
    const events = [];
    const method = frame?.method;
    const params = frame?.params ?? {};
    const main = !params.threadId || params.threadId === this.threadId;
    if (method && frame.id !== undefined && REQUEST_KINDS[method]) {
      events.push({ kind: 'request', requestKind: REQUEST_KINDS[method], tool: method, worker: !main, index });
      return events;
    }
    if (method && frame.id !== undefined) {
      events.push({ kind: 'request', requestKind: 'other', tool: method, worker: !main, index });
      return events;
    }
    switch (method) {
      case 'turn/started':
        events.push(main ? { kind: 'turn-start', index } : { kind: 'worker-start', index, source: 'turn/started' });
        break;
      case 'turn/completed':
        events.push(main ? { kind: 'turn-end', status: params.turn?.status ?? null, error: params.turn?.error ?? null, index } : { kind: 'worker-end', status: params.turn?.status ?? null, index, source: 'turn/completed' });
        break;
      case 'thread/started':
        if (params.thread?.id && params.thread.id !== this.threadId && this.threadId) events.push({ kind: 'worker-start', index, source: 'thread/started' });
        break;
      case 'item/started':
      case 'item/completed': {
        const item = params.item ?? {};
        if (method === 'item/started' && TOOL_ITEMS.has(item.type)) events.push({ kind: 'tool-call', name: item.type, worker: !main, index });
        // 0.155.1 shows the spawn as a subAgentActivity item (kind started, then completed), not as
        // a collabAgentToolCall; the only collab call seen in T3 was `wait`.
        if (item.type === 'subAgentActivity' && method === 'item/started') {
          if (item.kind === 'started') events.push({ kind: 'worker-start', index, source: 'subAgentActivity' });
          if (item.kind === 'completed') events.push({ kind: 'worker-end', index, source: 'subAgentActivity' });
        }
        if (item.type === 'collabAgentToolCall') {
          const tool = String(item.tool ?? '');
          if (method === 'item/started' && /spawn/i.test(tool)) events.push({ kind: 'worker-start', index, source: `collab:${tool}` });
          if (method === 'item/completed' && /wait|close/i.test(tool)) events.push({ kind: 'worker-end', index, source: `collab:${tool}` });
        }
        break;
      }
      case 'error':
        events.push({ kind: 'error', index, willRetry: params.willRetry ?? null });
        break;
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed':
        events.push({ kind: 'auto-review', index });
        break;
      default:
        break;
    }
    const effort = findKey(frame, ['reasoningEffort', 'effort']);
    if (effort !== undefined && method !== 'turn/start') events.push({ kind: 'effort', value: effort, index, source: method ?? 'response' });
    const reportsModel = method === 'thread/settings/updated' || method === 'model/rerouted' || (method === undefined && 'result' in (frame ?? {}));
    const model = reportsModel ? findKey(frame, ['model', 'toModel']) : undefined;
    if (model !== undefined) events.push({ kind: 'model', value: model, index, source: method ?? 'response' });
    return events;
  }

  incoming(frame) {
    if (!frame || frame.method === undefined || frame.id === undefined) return;
    const info = { kind: frame.method, requestKind: REQUEST_KINDS[frame.method] ?? 'other', params: frame.params ?? {} };
    this.requestsSeen.push({ kind: info.kind, requestKind: info.requestKind });
    const answer = translate(info, this.requestHandler?.(info) ?? null);
    this.requestsSeen.at(-1).answer = answer ? JSON.stringify(answer.result).slice(0, 80) : 'error reply';
    const reply = answer ? { id: frame.id, result: answer.result } : { id: frame.id, error: { code: -32601, message: 'not handled by the M10 spike' } };
    this.session.send(reply).catch(() => {});
  }
}

/** A semantic decision (allow | deny | decline | answer-first) as the reply Codex's schema asks for. */
function translate(info, semantic) {
  const decision = semantic?.decision ?? 'decline';
  switch (info.kind) {
    case 'item/tool/requestUserInput': {
      const questions = Array.isArray(info.params.questions) ? info.params.questions : [];
      const answers = decision === 'answer-first' ? Object.fromEntries(questions.map((q) => [q.id, { answers: [q.options?.[0]?.label ?? ''] }])) : {};
      return { result: { answers } };
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: decision === 'allow' ? 'accept' : 'decline' } };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { result: { decision: decision === 'allow' ? 'approved' : 'denied' } };
    case 'item/permissions/requestApproval':
      // Declining grants nothing: an empty permission set for this turn.
      return { result: { permissions: {}, scope: 'turn' } };
    default:
      return null;
  }
}

/** First value under any of `keys`, searched depth-first; undefined when absent. */
function findKey(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  for (const key of keys) if (Object.hasOwn(value, key) && (typeof value[key] === 'string' || value[key] === null)) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** C58: a session-start reply matches what was asked for. Compares sandbox, policy and reviewer. */
export function checkSessionStart(requested, reply) {
  const norm = (v) => (typeof v === 'string' ? v : v?.type ?? v?.mode ?? JSON.stringify(v ?? null)).toLowerCase().replace(/[^a-z]/g, '');
  const rows = [];
  if (requested.sandbox !== undefined) rows.push({ field: 'sandbox', requested: requested.sandbox, reported: reply?.sandbox ?? null, match: norm(requested.sandbox) === norm(reply?.sandbox) });
  if (requested.approvalPolicy !== undefined) rows.push({ field: 'approvalPolicy', requested: requested.approvalPolicy, reported: reply?.approvalPolicy ?? null, match: norm(requested.approvalPolicy) === norm(reply?.approvalPolicy) });
  if (requested.approvalsReviewer !== undefined) rows.push({ field: 'approvalsReviewer', requested: requested.approvalsReviewer, reported: reply?.approvalsReviewer ?? null, match: norm(requested.approvalsReviewer) === norm(reply?.approvalsReviewer) });
  return { passed: rows.every((r) => r.match), rows };
}
