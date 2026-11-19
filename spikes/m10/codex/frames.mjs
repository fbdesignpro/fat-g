// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's frame table for the app-server's JSON-RPC (no "jsonrpc" member on the wire). Method names
// come from the schema the installed CLI generates (spikes/m10/schema.mjs, B3), corrected from
// captures. A frame's type key is its method; replies are "response".
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { outputPath } from '../lib/paths.mjs';

export function typeKey(frame) {
  if (!frame || typeof frame !== 'object') return '<not-an-object>';
  if (frame._reduced) return frame.type;
  if (typeof frame.method === 'string') return frame.method;
  if ('result' in frame || 'error' in frame) return 'response';
  return '<no method>';
}

export const KNOWN_TYPES = new Set([
  'response',
  // Sent by the spike.
  'initialize', 'initialized', 'thread/start', 'turn/start', 'turn/interrupt', 'model/list', 'config/read',
  'thread/list', 'account/rateLimits/read', 'account/read', 'thread/read',
  // Sent by the M15 spikes (spikes/m15).
  'thread/resume', 'thread/turns/list', 'thread/items/list', 'thread/delete',
  // Sent by M20b's K3 (spikes/m20b): an ephemeral child of the session's thread for an aside.
  'thread/fork',
  // Sent by M23's K1 (spikes/m23): a message steered into the running turn, and the skills the CLI lists for a folder.
  'turn/steer', 'skills/list',
  // Sent by M22's K1 (spikes/m22): what the machine's sandbox and the configuration allow, read with no turn.
  'windowsSandbox/readiness', 'permissionProfile/list', 'configRequirements/read',
  // The `setup` scenario of that spike, run by the maintainer: Codex's own sandbox setup, its completion and its warning.
  'windowsSandbox/setupStart', 'windowsSandbox/setupCompleted', 'windows/worldWritableWarning',
  // Notifications.
  'thread/started', 'thread/status/changed', 'thread/name/updated', 'thread/tokenUsage/updated', 'thread/closed',
  'thread/archived', 'thread/settings/updated', 'turn/started', 'turn/completed', 'turn/diff/updated',
  'turn/plan/updated', 'item/started', 'item/completed', 'item/updated', 'error', 'warning', 'deprecationNotice',
  'configWarning', 'account/rateLimits/updated', 'account/updated', 'mcpServer/startupStatus/updated',
  'serverRequest/resolved', 'item/autoApprovalReview/started', 'item/autoApprovalReview/completed',
  'model/rerouted', 'skills/changed', 'sessionConfigured', 'remoteControl/status/changed',
  // Seen in a turn under Codex's own reviewer (M22's K4): the thread's id and the review's verdict in the reviewer's words.
  'guardianWarning',
  // Seen after a thread/resume (M15): the thread's id and nothing else.
  'thread/goal/cleared',
  // Kept by M19's K1 (spikes/m19), which does not opt out of it: an agent message's text as it is written.
  'item/agentMessage/delta',
  // Kept by M22b's K2 (spikes/m22b): a plan item's text as it is written.
  'item/plan/delta',
  // Seen in every turn of M22b's K2, on the scratch account: the thread's and turn's ids and moderation category flags, no text.
  'turn/moderationMetadata',
  // Seen in the turns of M22b's K2 run again on codex-cli 0.163.0: the thread's id, the id of its first unread turn and a revision id, no text.
  'thread/readState/changed',
  // Requests from the server.
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call', 'execCommandApproval',
  'applyPatchApproval',
]);

/** Deltas are never requested; any that come are counted, not stored (C16). */
export const isDelta = (frame) => typeof frame?.method === 'string' && (/\/delta$/i.test(frame.method) || /Delta$/.test(frame.method));

/**
 * The delta notifications the installed CLI's schema lists (schema.mjs output). The driver opts
 * out of them in `initialize` (InitializeCapabilities.optOutNotificationMethods, stable in
 * 0.155.1): Codex's way of not requesting them. Empty when the schema has not been generated.
 */
export function deltaMethods() {
  const file = outputPath('schema', 'methods.json');
  if (!existsSync(file)) return [];
  const methods = JSON.parse(readFileSync(file, 'utf8'));
  return [...new Set(methods.filter((m) => m.category === 'server-notification' && isDelta({ method: m.method })).map((m) => m.method))].sort();
}

const THREAD_KEYS = new Set(['threadId', 'conversationId', 'senderThreadId', 'receiverThreadId', 'receiverThreadIds', 'newThreadId', 'parentThreadId', 'forkedFromId', 'agentThreadId']);

/**
 * Thread ids other than the session's own are workers: the redactor pre-registers the session's
 * thread as "session" before it collects, so only the others reach this kind.
 */
export function idKind(key, value, parent) {
  if (typeof value !== 'string') return null;
  if (THREAD_KEYS.has(key)) return 'worker';
  if (key === 'turnId') return 'turn';
  if (key === 'itemId' || key === 'callId' || key === 'call_id') return 'item';
  if (key === 'sessionId') return 'session';
  // Paging cursors are opaque and may hold ids; a client message id is one the client made (M15).
  if (/^(cursor|nextCursor|backwardsCursor|turnsBackwardsCursor|itemsBackwardsCursor)$/.test(key)) return 'cursor';
  if (key === 'clientUserMessageId' || key === 'clientId') return 'client-message';
  if (key === 'processId' || key === 'approvalId' || key === 'installationId') return 'process';
  if (key === 'id' && parent && typeof parent === 'object') {
    if (typeof parent.type === 'string') return 'item';
    if ('items' in parent || ('status' in parent && 'error' in parent)) return 'turn';
    if ('preview' in parent || 'cwd' in parent || 'modelProvider' in parent || 'createdAt' in parent) return 'worker';
  }
  return null;
}

export const ACCOUNT_KEYS = ['account'];

export function secretLabel(key) {
  if (key === 'encrypted_content' || key === 'encryptedContent') return '<encrypted>';
  return null;
}

export function configuredNames(frame) {
  const out = [];
  const params = frame?.params ?? {};
  if (frame?.method === 'mcpServer/startupStatus/updated' && typeof params.name === 'string') out.push({ name: params.name, kind: 'mcp-server' });
  const item = params.item;
  if (item?.type === 'mcpToolCall' && typeof item.server === 'string') out.push({ name: item.server, kind: 'mcp-server' });
  return out;
}

/** The spike's own skill (spikes/m23): the one name a `skills/list` reply keeps. */
const SPIKE_SKILL = 'm23-marker';

export function scrub(frame) {
  // A `skills/list` reply (M23's K1) names the user's plugins and skills and their folders: each
  // skill keeps its scope and whether it is enabled; the spike's own keeps its name and description
  // too, and every other name, description, plugin id, icon and path goes.
  if (frame?.result && Array.isArray(frame.result.data) && frame.result.data.some((entry) => Array.isArray(entry?.skills))) {
    const data = frame.result.data.map((entry) => ({
      ...entry,
      skills: (entry.skills ?? []).map((skill) => (skill?.name === SPIKE_SKILL
        ? { name: skill.name, description: skill.description, path: skill.path, scope: skill.scope ?? null, enabled: skill.enabled ?? null, pluginId: skill.pluginId ?? null }
        : { name: '<skill>', description: '<description>', path: '<path>', scope: skill?.scope ?? null, enabled: skill?.enabled ?? null, pluginId: skill?.pluginId == null ? null : '<plugin>', ...(skill?.interface ? { interface: { _keys: Object.keys(skill.interface).sort() } } : {}) })),
      errors: (entry.errors ?? []).map((error) => ({ path: '<path>', message: '<message>', _keys: Object.keys(error ?? {}).sort() })),
    }));
    return { ...frame, result: { ...frame.result, data } };
  }
  if (frame?.method === 'account/rateLimits/updated') return { method: frame.method, params: { _keys: Object.keys(frame.params ?? {}).sort() } };
  // Names the machine (serverName) and carries installation and environment ids: status only.
  if (frame?.method === 'remoteControl/status/changed') return { method: frame.method, params: { status: frame.params?.status ?? null, _keys: Object.keys(frame.params ?? {}).sort() } };
  // A turn's diff names git blob ids, which are hashes of the changed files' contents (M22's K1): no
  // id of an account's or a session's, but forty hex digits, which the leak check takes for one.
  if (frame?.method === 'turn/diff/updated' && typeof frame.params?.diff === 'string') return { ...frame, params: { ...frame.params, diff: frame.params.diff.replace(/\b[0-9a-f]{40}\b/g, '<blob>') } };
  return frame;
}

/**
 * C53 and C69: a config/read reply keeps the key names, value types and entry counts of the reply
 * and of its `config` member, and nothing deeper. Applied before anything is written, raw output
 * included. The hash of the full reply stays in memory for the unchanged check (V12).
 */
export function reduceConfigRead(result) {
  const describe = (object) => {
    const out = {};
    for (const [key, value] of Object.entries(object ?? {})) {
      const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      out[key] = type === 'array' ? { type, count: value.length } : type === 'object' ? { type, count: Object.keys(value).length } : { type };
    }
    return out;
  };
  // Canonical form: keys sorted at every level. Codex serializes maps in an order that can differ
  // between two reads of the same configuration (seen), so a byte hash would report a
  // change that is not one.
  const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
  const hash = createHash('sha256').update(JSON.stringify(canonical(result ?? null))).digest('hex');
  return { reduced: { _reduced: 'config/read reply (C53, C69): two levels of key names, types and counts', reply: describe(result), config: describe(result?.config) }, hash };
}

export const CODEX_TABLE = Object.freeze({ cli: 'codex', typeKey, types: KNOWN_TYPES, idKind, accountKeys: ACCOUNT_KEYS, secretLabel, configuredNames, scrub, isDelta });
