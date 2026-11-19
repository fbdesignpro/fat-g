// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The leak check (V3, Design 4). Independent of the redactor on purpose: it imports none of its
// code, works on the file as written, gathers its secrets by other means and generates its own
// path forms. A redactor defect therefore shows as a failure here, not as a silence.
//
// A reply's deltas are read joined as well (M19b): a path or a user name that the CLI wrote across
// several deltas is in no one string of the file, and was found in three published fixtures.
import { readFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED, SPIKE_OWN } from './shipped-names.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['absolute path', /(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\|\/)[A-Za-z0-9._$~ -]/],
  ['absolute path', /file:\/\/\/?[A-Za-z0-9]/i],
  ['absolute path', /(?<![\w:/.>-])\/(?:Users|home|mnt|tmp|var|private|opt|root|[a-z])\/[A-Za-z0-9._-]/],
];

/** Id-like tokens: what a CLI uses for sessions, threads, workers, messages, tool calls. */
// A prefixed or long token counts only if it holds a digit: `task_notification` is a word, a
// generated id like `toolu_01Ab…` is not.
const ID_TOKEN = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:toolu|msg|req|call|srvtoolu|mcpsrv|rs|fc|thr|turn|item|task|agent|sess)_(?=[A-Za-z]*\d)[A-Za-z0-9]{8,}|[0-9a-f]{24,}|(?=[A-Za-z]*\d)[A-Za-z0-9]{32,})\b/gi;

/** Keys that hold ids: session_id, threadId, task_id, agentId, receiverThreadIds, uuid, … */
const ID_KEY = /(?:_id|Id|_ids|Ids|^uuid|_uuid|Uuid)$/;

function forms(folder) {
  const out = new Set();
  const win = folder.replace(/\//g, '\\');
  const unix = win.replace(/\\/g, '/');
  out.add(win); out.add(unix); out.add(win.split('\\').join('\\\\'));
  const drive = /^([A-Za-z]):(.*)$/.exec(unix);
  if (drive) {
    out.add(`/${drive[1]}${drive[2]}`);
    out.add(`/mnt/${drive[1].toLowerCase()}${drive[2]}`);
    out.add(`${drive[1]}%3A${drive[2]}`);
    out.add(encodeURIComponent(win));
    out.add(encodeURIComponent(unix));
  }
  out.add(win.replace(/[^A-Za-z0-9]/g, '-'));
  return [...out].filter((f) => f.length > 4);
}

/** Id-like tokens of a raw capture, labelled by the key they were found under. */
export function rawIdTokens(raw) {
  const tokens = new Map();
  const label = (key) => {
    const k = String(key ?? '');
    if (/session/i.test(k)) return 'session id';
    if (/thread|conversation/i.test(k)) return 'thread id';
    if (/task|agent|worker|receiver|sender/i.test(k)) return 'worker id';
    return 'raw id';
  };
  const visit = (value, key, isKey = false) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(ID_TOKEN)) if (!tokens.has(match[0])) tokens.set(match[0], label(key));
      // Any value under an id-named key, whatever its shape (a short worker id, say). Model and
      // provider names are not ids, and neither is the key itself.
      if (!isKey && ID_KEY.test(String(key ?? '')) && !/model|provider|limit/i.test(String(key)) && value.length >= 6 && !tokens.has(value)) tokens.set(value, label(key));
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { visit(k, k, true); visit(v, k); }
  };
  visit(raw, null);
  return tokens;
}

/** Configured-item names a raw capture lists, found by the leak check's own traversal. */
export function rawConfiguredNames(raw, cli) {
  const listed = [];
  const flatten = (value) => { if (Array.isArray(value)) listed.push(...value); else if (value && typeof value === 'object') Object.values(value).forEach(flatten); };
  flatten(SHIPPED[cli] ?? {});
  const shipped = new Set([...listed, ...SPIKE_OWN].map((n) => n.toLowerCase()));
  const found = new Set();
  const visit = (value, key) => {
    if (Array.isArray(value)) {
      if (/^(skills|agents|slash_commands|commands|plugins|mcp_servers|mcpServers|mcpTools|skillFrontmatter)$/.test(key ?? '')) {
        for (const item of value) {
          const name = typeof item === 'string' ? item : item?.name ?? item?.agentType ?? item?.serverName;
          if (typeof name === 'string' && name && !shipped.has(name.toLowerCase())) found.add(name);
          // An MCP server's name as its tools carry it: `mcp__<the name, `_` for every other character>__<tool>`.
          if (typeof name === 'string' && /^(mcp_servers|mcpServers)$/.test(key ?? '') && /[^A-Za-z0-9]/.test(name)) found.add(name.replace(/[^A-Za-z0-9]/g, '_'));
        }
      }
      value.forEach((v) => visit(v, key));
    } else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(raw, null);
  return found;
}

/**
 * Checks `text` (a fixture as written). `secrets` are extra labelled values gathered by other means
 * (account values the CLI reports at check time): [{ kind, value }]. `raw` is the unredacted
 * capture the fixture came from, when there is one.
 */
export function leakCheck(file, { cli, raw = null, secrets = [], scratchDirs = [] } = {}) {
  const failures = [];
  // The file as written, and after it each text that arrives in pieces, its pieces joined.
  const text = `${file}\n${joinedPieces(file).join('\n')}`;
  const lower = text.toLowerCase();
  const fail = (kind, value) => failures.push({ kind, sample: mask(value) });
  for (const [kind, pattern] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) fail(kind, match[0]);
  }
  const folders = [['home folder', homedir()], ['repository folder', REPO], ['temp folder', tmpdir()], ...scratchDirs.map((d) => ['scratch folder', d])];
  for (const [kind, folder] of folders) {
    for (const form of forms(folder)) if (lower.includes(form.toLowerCase())) { fail(kind, form); break; }
  }
  for (const [kind, name] of [['user name', userInfo().username], ['host name', hostname()]]) {
    if (name && name.length >= 3 && new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(text)) fail(kind, name);
  }
  for (const { kind, value } of secrets) {
    if (typeof value === 'string' && value.length >= 4 && lower.includes(value.toLowerCase())) fail(kind, value);
  }
  if (raw) {
    for (const [token, kind] of rawIdTokens(raw)) if (text.includes(token)) fail(kind, token);
    // Names are words, and the spike's own `_fixture` note is prose it wrote itself (a built-in
    // command called "run" would match "run against the installed CLI"). Every other check
    // above covers the whole file, the note included.
    const body = withoutFixtureNote(text);
    for (const name of rawConfiguredNames(raw, cli)) {
      if (new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(body)) fail('configured-item name', name);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Each text of the file that arrives in pieces, joined: a Codex item's deltas, and the deltas of one
 * block of one reply of a Claude session. Its own traversal, as everything here is.
 */
function joinedPieces(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const runs = new Map();
  let reply = 0;
  for (const entry of Array.isArray(parsed?.frames) ? parsed.frames : []) {
    const frame = entry?.frame;
    if (!frame || typeof frame !== 'object') continue;
    let run = null;
    let piece = null;
    if (typeof frame.method === 'string' && /delta$/i.test(frame.method) && typeof frame.params?.delta === 'string') {
      run = `${frame.method}|${frame.params.threadId ?? ''}|${frame.params.itemId ?? ''}`;
      piece = frame.params.delta;
    } else if (frame.type === 'stream_event') {
      if (frame.event?.type === 'message_start') reply += 1;
      const delta = frame.event?.type === 'content_block_delta' ? frame.event.delta : null;
      const field = delta && typeof delta === 'object' ? Object.keys(delta).find((name) => name !== 'type' && typeof delta[name] === 'string') : undefined;
      if (field !== undefined) { run = `${frame.parent_tool_use_id ?? ''}|${reply}|${frame.event.index}|${field}`; piece = delta[field]; }
    }
    if (run !== null) runs.set(run, (runs.get(run) ?? '') + piece);
  }
  return [...runs.values()];
}

/**
 * The string values of the file, without the spike's `_fixture` note and without keys: a name is
 * looked for where the CLIs put configured items (values), not in field names such as `run`.
 */
function withoutFixtureNote(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  const { _fixture, ...rest } = parsed;
  const values = [];
  const walk = (v) => {
    if (typeof v === 'string') values.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(rest);
  return values.join('\n');
}

export function leakCheckFile(file, options) {
  return leakCheck(readFileSync(file, 'utf8'), options);
}

/** Never print a secret in full, even in a failure message. */
function mask(value) {
  const s = String(value);
  return s.length <= 6 ? `${s[0] ?? ''}…(${s.length})` : `${s.slice(0, 3)}…${s.slice(-2)}(${s.length})`;
}
