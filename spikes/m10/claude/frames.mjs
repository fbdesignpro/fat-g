// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Claude's frame table: which frame types the spikes know, which keys carry ids, where configured
// items are named, and what is scrubbed before anything else. Read from the Agent SDK's type
// definitions (reading material only, C2) and corrected from captures.

/** `type`, or `type/subtype` for system frames and control requests. */
export function typeKey(frame) {
  if (!frame || typeof frame !== 'object') return '<not-an-object>';
  if (frame._reduced) return frame.type;
  if (frame.type === 'system') return `system/${frame.subtype ?? '?'}`;
  if (frame.type === 'control_request') return `control_request/${frame.request?.subtype ?? '?'}`;
  return String(frame.type ?? '<no type>');
}

export const KNOWN_TYPES = new Set([
  // From the CLI.
  'system/init', 'system/status', 'system/api_retry', 'system/compact_boundary', 'system/task_started',
  'system/task_progress', 'system/task_notification', 'system/task_updated', 'system/session_state_changed',
  'system/hook_started', 'system/hook_progress', 'system/hook_response', 'system/informational', 'system/notification',
  'system/files_persisted', 'system/thinking_tokens', 'system/permission_denied', 'system/commands_changed',
  'system/background_tasks_changed', 'system/control_request_progress', 'system/worker_shutting_down',
  'assistant', 'user', 'result', 'tool_progress', 'tool_use_summary', 'rate_limit_event', 'keep_alive',
  'conversation_reset', 'control_response', 'control_cancel_request',
  // Seen by M16's traces: the life of one prompt, named by the id its `user` frame carried.
  'command_lifecycle',
  // Kept by M19's K2 (spikes/m19), which launches with `--include-partial-messages`: a reply as it is written.
  'stream_event',
  'control_request/can_use_tool', 'control_request/hook_callback', 'control_request/mcp_message',
  'control_request/elicitation', 'control_request/request_user_dialog',
  // From the spike.
  'control_request/initialize', 'control_request/interrupt', 'control_request/set_model',
  'control_request/apply_flag_settings', 'control_request/get_settings', 'control_request/get_context_usage',
  'control_request/mcp_status', 'control_request/get_usage',
  // Sent by M20b's K1 (spikes/m20b): a question beside the session, read in the SDK's runtime; and the
  // two system frames the SDK declares for a model that refused and fell back, or did not.
  'control_request/side_question', 'system/model_refusal_fallback', 'system/model_refusal_no_fallback',
  // Sent by M22's K2 (spikes/m22): a permission mode set with no turn, and the rule list, which 2.1.268 refuses as unsupported.
  'control_request/set_permission_mode', 'control_request/list_permission_rules',
]);

/** Token-level deltas: never requested (no --include-partial-messages), counted if they come (C16). */
export const isDelta = (frame) => frame?.type === 'stream_event';

const ID_KEYS = {
  session_id: 'session', new_conversation_id: 'session',
  parent_tool_use_id: 'tool-use', tool_use_id: 'tool-use', toolUseID: 'tool-use', preceding_tool_use_ids: 'tool-use',
  request_id: 'request',
  task_id: 'worker', agent_id: 'worker', agentId: 'worker',
  uuid: 'uuid', user_message_uuid: 'uuid', user_message_uuids: 'uuid', message_uuid: 'uuid', command_uuid: 'uuid', logical_parent_uuid: 'uuid',
};

/** The alias kind for an id-carrying value, or null. */
export function idKind(key, value, parent) {
  if (typeof value !== 'string') return null;
  if (key in ID_KEYS) return ID_KEYS[key];
  if (key === 'id') {
    if (/^toolu_|^srvtoolu_/.test(value)) return 'tool-use';
    if (/^msg_/.test(value)) return 'message';
    // A claude.ai connector's id, in an MCP server's `config`: it belongs to the account.
    if (/^mcpsrv_/.test(value)) return 'connector';
    if (parent && (parent.type === 'tool_use' || parent.type === 'server_tool_use')) return 'tool-use';
    if (parent && parent.role === 'assistant') return 'message';
  }
  return null;
}

/** Keys whose object value is an account: replaced whole (Design 4). */
export const ACCOUNT_KEYS = ['account'];

/** Signatures and encrypted reasoning. */
export function secretLabel(key, parent) {
  if (key === 'signature') return '<signature>';
  // The session's private messaging socket (a named pipe with a random token), seen in `init`.
  if (key === 'messaging_socket_path') return '<socket>';
  if (key === 'data' && parent?.type === 'redacted_thinking') return '<encrypted>';
  return null;
}

/** Configured items a frame names (C54): skills, plugins, agents, commands, MCP servers, output styles. */
export function configuredNames(frame) {
  const out = [];
  const push = (list, kind, pick = (x) => x) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const name = pick(item);
      if (typeof name === 'string') out.push({ name, kind });
      if (typeof name === 'string' && name.includes(':')) for (const part of name.split(':')) out.push({ name: part, kind });
    }
  };
  const visit = (f) => {
    if (!f || typeof f !== 'object') return;
    push(f.skills, 'skill');
    push(f.agents, 'agent', (a) => (typeof a === 'string' ? a : a?.name ?? a?.agentType));
    push(f.slash_commands, 'command');
    push(f.commands, 'command', (c) => (typeof c === 'string' ? c : c?.name));
    push(f.plugins, 'plugin', (p) => p?.name);
    push(f.mcp_servers, 'mcp-server', (s) => s?.name);
    push(f.mcpServers, 'mcp-server', (s) => s?.name);
    // A server's tools are named `mcp__<server>__<tool>`, the server's name with every character
    // that is no letter or digit turned into `_` (M16's captures list the account's connectors so).
    push(f.mcp_servers, 'mcp-server', (s) => (typeof s?.name === 'string' && /[^A-Za-z0-9]/.test(s.name) ? s.name.replace(/[^A-Za-z0-9]/g, '_') : null));
    push(f.mcpTools, 'mcp-server', (t) => t?.serverName);
    push(f.skills?.skillFrontmatter, 'skill', (s) => s?.name);
    push(f.available_output_styles, 'output-style');
    if (typeof f.output_style === 'string') out.push({ name: f.output_style, kind: 'output-style' });
  };
  visit(frame);
  visit(frame?.response?.response);
  return out;
}

/**
 * Applied before redaction. Usage readings never enter a capture (Design 3): a rate-limit frame
 * keeps its type and the names of its keys only.
 */
export function scrub(frame) {
  // An image the spike sent, or the CLI gave back (M23's K2): its bytes are the harness's own
  // fixture, measured and never kept; the block keeps its type and its length alone.
  if (frame?.type === 'user' && Array.isArray(frame.message?.content) && frame.message.content.some((block) => block?.type === 'image')) {
    const content = frame.message.content.map((block) => (block?.type === 'image' && block.source && typeof block.source === 'object' && typeof block.source.data === 'string'
      ? { ...block, source: { ...block.source, data: `<image bytes: ${block.source.data.length} base64 units>` } }
      : block));
    return { ...frame, message: { ...frame.message, content } };
  }
  if (frame?.type === 'rate_limit_event') {
    return { type: frame.type, rate_limit_info: frame.rate_limit_info && typeof frame.rate_limit_info === 'object' ? { _keys: Object.keys(frame.rate_limit_info).sort() } : null, uuid: frame.uuid, session_id: frame.session_id };
  }
  // A get_settings reply: `applied` answers C15; the merged and per-source settings documents can
  // hold the user's own rules, environment values and commands, so only their key names stay.
  const reply = frame?.type === 'control_response' ? frame.response?.response : null;
  if (reply && typeof reply === 'object' && 'applied' in reply && ('effective' in reply || 'sources' in reply)) {
    const keys = (v) => (v && typeof v === 'object' ? { _keys: Array.isArray(v) ? `array of ${v.length}` : Object.keys(v).sort() } : v);
    return { ...frame, response: { ...frame.response, response: { ...reply, effective: keys(reply.effective), sources: keys(reply.sources) } } };
  }
  // A get_usage reply is a usage reading: never in a capture.
  if (reply && typeof reply === 'object' && 'rate_limits' in reply) {
    return { ...frame, response: { ...frame.response, response: { _keys: Object.keys(reply).sort() } } };
  }
  return frame;
}

export const CLAUDE_TABLE = Object.freeze({ cli: 'claude', typeKey, types: KNOWN_TYPES, idKind, accountKeys: ACCOUNT_KEYS, secretLabel, configuredNames, scrub, isDelta });
