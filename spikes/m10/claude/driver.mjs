// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Claude driver: the CLI's stdio control protocol, spoken directly (C2). No Agent SDK is run;
// its type definitions are reading material only. Tracing it here does not change decision 0006,
// which governs the app.
import { Driver } from '../lib/driver.mjs';
import { CliExited } from '../lib/wire.mjs';
import { CLAUDE_TABLE } from './frames.mjs';

/** The app's usage session (src/main/providers/claude/session.ts), for discovery. */
export const CONTROL_ARGS = Object.freeze([
  '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--setting-sources=', '--strict-mcp-config', '--permission-mode', 'default', '--no-session-persistence',
]);

/**
 * Tracing (Design 6): the control arguments, plus the flag that routes permission requests to
 * the spike, plus the scenario's tool list. `settingSources` and `strictMcp` change only for the
 * trust spike's positive control.
 */
export function tracingArgs({ tools, model, effort, settingSources = '', strictMcp = true } = {}) {
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', `--setting-sources=${settingSources}`];
  if (strictMcp) args.push('--strict-mcp-config');
  args.push('--permission-mode', 'default', '--no-session-persistence', '--permission-prompt-tool', 'stdio');
  if (tools) args.push('--tools', tools.join(','));
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

export class ClaudeDriver extends Driver {
  constructor(options) {
    super({ ...options, table: CLAUDE_TABLE });
    this.counter = 0;
    this.sessionIds = [];
  }

  /** Launch and `initialize` (the minimal request: the CLI's own system prompt applies). */
  async open(initialize = {}) {
    await this.startWire();
    const reply = await this.request('initialize', initialize, 'startup');
    return reply;
  }

  /** One control request; resolves `{ ok, value | error, index }`. */
  async request(subtype, payload = {}, wait = 'request') {
    const requestId = `m10-${++this.counter}`;
    const from = this.nextIndex;
    await this.session.send({ type: 'control_request', request_id: requestId, request: { subtype, ...payload } });
    const { frame, index } = await this.session.waitFor((f) => f.type === 'control_response' && f.response?.request_id === requestId, { wait, fromIndex: from });
    const response = frame.response;
    return response.subtype === 'success' ? { ok: true, value: response.response ?? null, index } : { ok: false, error: String(response.error ?? ''), index };
  }

  async prompt(text) {
    this.turnActive = true;
    return this.session.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  }

  interrupt() { return this.request('interrupt', {}); }
  setEffort(level) { return this.request('apply_flag_settings', { settings: { effortLevel: level } }); }
  setModel(model) { return this.request('set_model', { model }); }
  getSettings() { return this.request('get_settings', {}); }

  derive(frame, index) {
    const events = [];
    switch (CLAUDE_TABLE.typeKey(frame)) {
      case 'system/init':
        events.push({ kind: 'turn-start', index, sessionId: frame.session_id });
        if (typeof frame.model === 'string') events.push({ kind: 'model', value: frame.model, index, source: 'init' });
        if ('effort' in frame) events.push({ kind: 'effort', value: frame.effort, index, source: 'init' });
        break;
      case 'assistant': {
        const worker = frame.parent_tool_use_id != null;
        for (const block of Array.isArray(frame.message?.content) ? frame.message.content : []) {
          if (block?.type === 'tool_use') events.push({ kind: 'tool-call', name: block.name, id: block.id, worker, index });
        }
        if (frame.error) events.push({ kind: 'error', index, source: 'assistant' });
        break;
      }
      case 'result':
        events.push({ kind: 'turn-end', status: frame.subtype, isError: frame.is_error === true, terminalReason: frame.terminal_reason ?? null, index });
        if (frame.is_error) events.push({ kind: 'error', index, source: 'result' });
        break;
      case 'system/task_started':
        events.push({ kind: 'worker-start', index, taskType: frame.task_type ?? null });
        break;
      case 'system/task_notification':
        events.push({ kind: 'worker-end', status: frame.status, index });
        break;
      case 'system/task_updated':
        if (['completed', 'failed', 'killed'].includes(frame.patch?.status)) events.push({ kind: 'worker-end', status: frame.patch.status, index, source: 'task_updated' });
        break;
      case 'system/api_retry':
        events.push({ kind: 'error', index, source: 'api_retry', retry: true });
        break;
      case 'control_request/can_use_tool':
        events.push({ kind: 'request', requestKind: frame.request.tool_name === 'AskUserQuestion' ? 'question' : 'approval', tool: frame.request.tool_name, worker: Boolean(frame.request.agent_id), index });
        break;
      case 'control_response': {
        const applied = frame.response?.response?.applied;
        if (applied && typeof applied === 'object') {
          if ('effort' in applied) events.push({ kind: 'effort', value: applied.effort, index, source: 'get_settings' });
          if ('model' in applied) events.push({ kind: 'model', value: applied.model, index, source: 'get_settings' });
        }
        break;
      }
      default:
        break;
    }
    return events;
  }

  incoming(frame) {
    if (frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string' && !this.sessionIds.includes(frame.session_id)) this.sessionIds.push(frame.session_id);
    if (frame.type !== 'control_request') return;
    const request = frame.request ?? {};
    const info = { kind: request.subtype, tool: request.tool_name ?? null, input: request.input ?? {}, worker: Boolean(request.agent_id), blockedPath: request.blocked_path ?? null };
    this.requestsSeen.push({ kind: info.kind, tool: info.tool });
    let decision = null;
    if (request.subtype === 'can_use_tool') {
      info.requestKind = info.tool === 'AskUserQuestion' ? 'question' : 'approval';
      decision = translate(info, this.requestHandler?.(info));
      this.requestsSeen.at(-1).answer = decision.behavior;
    }
    const response = decision
      ? { subtype: 'success', request_id: frame.request_id, response: decision }
      : { subtype: 'error', request_id: frame.request_id, error: 'unsupported by the M10 spike' };
    this.session.send({ type: 'control_response', response }).catch(() => {});
  }
}

/** A semantic decision (allow | deny | decline | answer-first) as Claude's permission result. */
function translate(info, semantic) {
  const decision = semantic?.decision ?? 'deny';
  if (decision === 'allow') return { behavior: 'allow', updatedInput: info.input };
  if (decision === 'answer-first') {
    const questions = Array.isArray(info.input?.questions) ? info.input.questions : [];
    const answers = Object.fromEntries(questions.map((q) => [q.question, q.options?.[0]?.label ?? '']));
    return { behavior: 'allow', updatedInput: { ...info.input, answers } };
  }
  return { behavior: 'deny', message: semantic?.message ?? 'The user declined this request.' };
}

export { CliExited };
