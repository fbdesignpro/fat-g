// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The redactor (C8, C54, C66, Design 4): two passes over keys and values of a capture.
//
//   1. Collect: the driver's frame table names the keys that carry ids. Every such value gets one
//      alias, numbered by first appearance across kinds (<session-1>, <worker-2>, <tool-use-3>).
//      The map is keyed by value, so one id has one alias everywhere and two ids never share one.
//   2. Rewrite, in order: registered ids wherever they occur, message text included; account
//      objects whole; signatures and encrypted reasoning; the scratch folder; the home folder and
//      every other absolute path; emails, the user name, unregistered UUIDs; configured-item names
//      that are not in the shipped list.
//   3. A text that arrives in pieces (M19b): a reply's deltas are rewritten as the one text they
//      are, and never string by string. A path or a user name that the CLI wrote across several
//      deltas is in no one of them, and a piece alone may read as what it is not.
//
// A frame of a type the table does not know is reduced to its type and key names first (C66), so
// nothing inside it reaches either pass. The leak check (leak-check.mjs) shares no code with this.
import { spawnSync } from 'node:child_process';
import { homedir, hostname, userInfo } from 'node:os';
import { shippedSet } from './shipped-names.mjs';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\|\/)[^\s"'<>|*?`\r\n]*/g;
const FILE_URL = /file:\/\/\/?[^\s"'<>`]+/gi;
const NAMED_PIPE = /\\\\[.?]\\pipe\\[^\s"'<>`]+|\\\\\\\\[.?]\\\\pipe\\\\[^\s"'<>`]+/gi;
const POSIX_PATH = /(?<![\w:/.~>@-])\/(?:[A-Za-z0-9._@+%-]+\/)+[A-Za-z0-9._@+%-]*/g;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 8.3 short form of a folder, Windows only; null when there is none. */
export function shortPathOf(dir) {
  if (process.platform !== 'win32') return null;
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `for %I in ("${dir}") do @echo %~sI`], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  const short = result.stdout?.trim();
  return short && short.toLowerCase() !== dir.toLowerCase() ? short : null;
}

/** Every form a folder path takes in CLI output (Design 4). */
export function pathForms(dir) {
  const forms = new Set();
  const add = (form) => { if (form && form.length > 3) forms.add(form); };
  const bases = [dir, shortPathOf(dir)].filter(Boolean);
  for (const base of bases) {
    const win = base.replace(/\//g, '\\');
    const fwd = win.replace(/\\/g, '/');
    for (const form of [win, fwd, win.replace(/\\/g, '\\\\')]) {
      add(form);
      add(form.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`));
      add(form.replace(/^([A-Za-z]):/, (_, d) => `${d.toUpperCase()}:`));
    }
    if (/^[A-Za-z]:/.test(win)) {
      add(`/${win[0].toLowerCase()}${fwd.slice(2)}`);
      add(`/mnt/${win[0].toLowerCase()}${fwd.slice(2)}`);
      add(`file:///${fwd}`);
      add(`file:///${fwd.replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`)}`);
      add(encodeURI(`file:///${fwd}`));
      add(`${win[0]}%3A${fwd.slice(2)}`);
      add(encodeURIComponent(win));
      add(encodeURIComponent(fwd));
    } else {
      add(`file://${fwd}`);
      add(encodeURI(fwd));
    }
    // The slug Claude derives from a working folder: every non-alphanumeric character becomes '-'.
    add(win.replace(/[^A-Za-z0-9]/g, '-'));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value, false);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[fn(key, true)] = mapStrings(item, fn);
    return out;
  }
  return value;
}

function walk(value, visit, key = null, parent = null) {
  visit(value, key, parent);
  if (Array.isArray(value)) value.forEach((item) => walk(item, visit, key, value));
  else if (value && typeof value === 'object') for (const [k, item] of Object.entries(value)) walk(item, visit, k, value);
}

/**
 * `table`: { typeKey(frame), types: Set, idKind(key, value, parent) → kind | null,
 *            configuredNames(frame) → [{ name, kind }], accountKeys: [...],
 *            secretLabel(key, parent) → label | null, scrub(frame) → frame }.
 */
export function createRedactor({ cli, table, scratchDirs = [], sessionIds = [], home = homedir(), user = userInfo().username, extraSecrets = [] }) {
  const aliases = new Map();
  const counts = {};
  let counter = 0;
  const alias = (value, kind) => {
    if (!aliases.has(value)) { counter++; aliases.set(value, `<${kind}-${counter}>`); counts[kind] = (counts[kind] ?? 0) + 1; }
    return aliases.get(value);
  };
  const shipped = shippedSet(cli);
  const names = new Map();
  const report = { untabledTypes: {}, reducedFrames: 0, aliasCounts: counts, configuredNamesAliased: 0, accountObjects: 0, signatures: 0 };

  function reduceUntabled(frames) {
    return frames.map((entry) => {
      const type = table.typeKey(entry.frame);
      if (table.types.has(type)) return entry;
      report.reducedFrames++;
      report.untabledTypes[type] = (report.untabledTypes[type] ?? 0) + 1;
      return { ...entry, frame: { _reduced: 'untabled frame type (C66)', type, keys: Object.keys(entry.frame ?? {}).sort() } };
    });
  }

  function collect(value) {
    walk(value, (item, key, parent) => {
      if (typeof item !== 'string' || key === null) return;
      // Six characters or more: short enough for a CLI's short worker ids, long enough that
      // replacing the value everywhere cannot hit ordinary words or small numbers.
      const kind = table.idKind(key, item, parent);
      if (kind && item.length >= 6) alias(item, kind);
    });
    if (Array.isArray(value?.frames)) {
      for (const { frame } of value.frames) {
        for (const { name, kind } of table.configuredNames(frame)) {
          if (typeof name === 'string' && name && !shipped.has(name.toLowerCase())) names.set(name, kind);
        }
      }
    }
  }

  function scrubObjects(value) {
    if (Array.isArray(value)) return value.map(scrubObjects);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (table.accountKeys.includes(key) && item && typeof item === 'object') { out[key] = '<account>'; report.accountObjects++; continue; }
      const label = typeof item === 'string' && item.length > 0 ? table.secretLabel(key, value) : null;
      if (label) { out[key] = label; report.signatures++; continue; }
      out[key] = scrubObjects(item);
    }
    return out;
  }

  const scratchForms = [...new Set(scratchDirs.flatMap(pathForms))].sort((a, b) => b.length - a.length);
  const homeForms = pathForms(home);
  const byLength = (list) => [...list].sort((a, b) => b.length - a.length);
  const formsRegex = (forms) => (forms.length ? new RegExp(forms.map(escapeRegExp).join('|'), 'gi') : null);
  const scratchRegex = formsRegex(scratchForms);
  const homeRegex = formsRegex(homeForms);
  const userRegex = user && user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(user)}(?![A-Za-z0-9])`, 'gi') : null;
  const host = hostname();
  const hostRegex = host && host.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(host)}(?![A-Za-z0-9])`, 'gi') : null;

  function rewriteString(text, isKey = false) {
    let out = text;
    // 1. Registered ids, longest first, wherever they occur.
    for (const id of byLength(aliases.keys())) if (out.includes(id)) out = out.split(id).join(aliases.get(id));
    // Secrets the caller knows by other means (account values it asked the CLI for).
    for (const secret of byLength(extraSecrets.filter((s) => typeof s === 'string' && s.length >= 3))) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'gi'), '<secret>');
    }
    // 4. The scratch folder, then 5. the home folder and every other absolute path.
    if (scratchRegex) out = out.replace(scratchRegex, '<scratch>');
    if (homeRegex) out = out.replace(homeRegex, '<path>');
    out = out.replace(NAMED_PIPE, '<path>').replace(FILE_URL, '<path>').replace(WINDOWS_PATH, '<path>').replace(POSIX_PATH, '<path>');
    // 6. Emails, the user name and the machine's name, unregistered UUIDs.
    out = out.replace(EMAIL, '<email>');
    if (userRegex) out = out.replace(userRegex, '<user>');
    if (hostRegex) out = out.replace(hostRegex, '<host>');
    out = out.replace(UUID, (match) => alias(match.toLowerCase(), 'uuid'));
    // 7. Configured-item names not in the shipped list, in values only: keys are the protocol's and
    //    the capture's own field names, and a built-in called "run" must not rename `run`. The
    //    CLIs list configured items as values (arrays of names, `name` fields), never as keys.
    for (const name of isKey ? [] : byLength(names.keys())) {
      // Underscores count as boundaries, so a server name inside `mcp__<server>__<tool>` is caught.
      const pattern = new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, 'g');
      if (pattern.test(out)) {
        report.configuredNamesAliased++;
        out = out.replace(pattern, alias(`name:${name}`, names.get(name)));
      }
    }
    return out;
  }

  return {
    /** Redacts one capture object (format fat-g.capture/1). */
    redactCapture(capture) {
      const scrubbed = (capture.frames ?? []).map((entry) => ({ ...entry, frame: table.scrub(entry.frame) }));
      const reduced = { ...capture, frames: reduceUntabled(scrubbed) };
      for (const id of sessionIds) if (typeof id === 'string' && id.length >= 8) alias(id, 'session');
      collect(reduced);
      const { _fixture, ...rest } = reduced;
      const body = mapStrings(scrubObjects(rest), rewriteString);
      // 3. Each run of pieces, from the text as the CLI sent it: the string-by-string rewriting of a
      //    piece is put aside for what the whole text's rewriting gives it.
      let message = 0;
      const holders = (body.frames ?? []).map((entry) => {
        if (entry?.frame?.type === 'stream_event' && entry.frame.event?.type === 'message_start') message += 1;
        return pieceOf(entry?.frame, message);
      });
      for (const run of runsOf(reduced.frames ?? [])) {
        const rewritten = rewritePieces(run.map((piece) => piece.text), (text) => rewriteString(text));
        for (const [index, piece] of run.entries()) {
          const holder = holders[piece.at];
          if (holder !== null && holder !== undefined) holder.holder[holder.key] = rewritten[index];
        }
        report.pieceRuns = (report.pieceRuns ?? 0) + 1;
      }
      return { capture: { _fixture, ...body }, report };
    },
    /** Redacts a free-standing value with the aliases collected so far. */
    redactValue(value) { collect(value); return mapStrings(scrubObjects(value), rewriteString); },
    report,
  };
}


// ── A text that arrives in pieces (M19b) ──────────────────────────────────────────────────────
// A reply's deltas are strings of a few characters each. A path, a user name or an id that the CLI
// wrote across several of them is in no one string, so rewriting each string by itself leaves it
// there: the pieces of one text are rewritten as that text, and what the rewriting put in place of a
// span goes into the piece the span starts in.

/**
 * A frame's piece of a text that arrives in pieces, or null: the run it belongs to, and where its
 * text is. `message` counts a Claude session's replies, whose blocks are numbered from 0 in each.
 */
export function pieceOf(frame, message = 0) {
  if (typeof frame?.method === 'string' && /\/delta$/i.test(frame.method) && typeof frame.params?.delta === 'string') {
    return { run: `${frame.method}|${frame.params.threadId ?? ''}|${frame.params.itemId ?? ''}`, holder: frame.params, key: 'delta' };
  }
  if (frame?.type === 'stream_event' && frame.event?.type === 'content_block_delta' && frame.event.delta && typeof frame.event.delta === 'object') {
    const key = ['text', 'partial_json', 'thinking'].find((name) => typeof frame.event.delta[name] === 'string');
    if (key) return { run: `block|${frame.parent_tool_use_id ?? ''}|${message}|${frame.event.index}|${key}`, holder: frame.event.delta, key };
  }
  return null;
}

/** The runs of a capture's frames: for each, where its pieces are, in order. */
export function runsOf(frames) {
  const runs = new Map();
  let message = 0;
  for (const [at, entry] of frames.entries()) {
    const frame = entry?.frame;
    if (frame?.type === 'stream_event' && frame.event?.type === 'message_start') message += 1;
    const piece = pieceOf(frame, message);
    if (piece === null) continue;
    if (!runs.has(piece.run)) runs.set(piece.run, []);
    runs.get(piece.run).push({ at, text: piece.holder[piece.key] });
  }
  return [...runs.values()];
}

const TOKEN = /<[a-z][a-z-]*(?:-\d+)?>/g;

/**
 * The spans of `raw` that a rewriting replaced, each with the token put in its place: `out` is `raw`
 * with those spans replaced. Null when the two cannot be read that way. A token-like word that
 * `raw` holds itself, an element's name in angle brackets, is no replacement.
 */
export function replacedSpans(raw, out) {
  const parts = [];
  let last = 0;
  for (const match of out.matchAll(TOKEN)) {
    parts.push(out.slice(last, match.index), match[0]);
    last = match.index + match[0].length;
  }
  parts.push(out.slice(last));
  const failed = new Set();
  // parts: a literal, a token, a literal, … a literal.
  const solve = (index, at) => {
    if (index === parts.length) return at === raw.length ? [] : null;
    const key = `${index}|${at}`;
    if (failed.has(key)) return null;
    const part = parts[index];
    let found = null;
    if (raw.startsWith(part, at)) found = solve(index + 1, at + part.length);
    if (found === null && index % 2 === 1) {
      const next = parts[index + 1];
      const tried = (end) => {
        const rest = solve(index + 1, end);
        if (rest !== null) found = [{ start: at, end, token: part }, ...rest];
      };
      if (next !== '') for (let end = raw.indexOf(next, at + 1); end !== -1 && found === null; end = raw.indexOf(next, end + 1)) tried(end);
      // Nothing between this token and the next, or the text's end: every place it could stop.
      else for (let end = raw.length; end > at && found === null; end -= 1) tried(end);
    }
    if (found === null) failed.add(key);
    return found;
  };
  return solve(0, 0);
}

/** A text's pieces with the spans replaced: a span's token goes into the piece it starts in. */
export function distribute(pieces, spans) {
  const raw = pieces.join('');
  let start = 0;
  return pieces.map((piece) => {
    const end = start + piece.length;
    let text = '';
    let cursor = start;
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue;
      if (span.start >= cursor) text += raw.slice(cursor, span.start);
      if (span.start >= start) text += span.token;
      cursor = Math.min(span.end, end);
    }
    if (cursor < end) text += raw.slice(cursor, end);
    start = end;
    return text;
  });
}

/**
 * A run's pieces, rewritten as the one text they are. Where the rewritten text cannot be laid over
 * the pieces, all of it goes into the first and the others are left empty: nothing is left unredacted.
 */
export function rewritePieces(pieces, rewrite) {
  const raw = pieces.join('');
  const out = rewrite(raw);
  if (out === raw) return pieces;
  const spans = replacedSpans(raw, out);
  return spans === null ? pieces.map((_, index) => (index === 0 ? out : '')) : distribute(pieces, spans);
}
