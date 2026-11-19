// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K4 (docs/planning/_archive/M19-spec-sheet.md, C16): what does writing a message's text again, as it grows,
// cost the process that writes it, and how far does the store's log grow?
//
//   node spikes/m19/k4.mjs                                   under Node
//   ELECTRON_RUN_AS_NODE=1 <electron> spikes/m19/k4.mjs      under Electron's Node
//
// A store is made as the app makes one (src/main/conversations/open.ts: write-ahead mode,
// `synchronous=FULL`, `secure_delete=ON`, `auto_vacuum=FULL`) with some chats in it. One item is
// then inserted at its first text and its body written again at every checkpoint, on a clock of the
// spike's own, as its text grows to 100,000 units: once per interval, and once more at the end, as
// the whole message's write. Per interval (2 s, 500 ms, 5 s) and per rate of growth, each write is
// timed and the log's size is read after it.
//
// It launches nothing and waits for nothing: the clock is counted, not slept. It touches only
// spikes/output/m19/k4-*/. The rows are made up.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const runtime = process.versions.electron === undefined ? 'node' : 'electron';
const OUT = path.join(ROOT, 'spikes', 'output', 'm19');
const SCRATCH = path.join(OUT, `k4-${runtime}`);
const STORE_NAME = 'conversations.db';

/** A message's bound, in UTF-16 units (M15, C113). */
const BOUND = 100_000;
/** The checkpoint intervals the sheet names, its own first. */
const INTERVALS_MS = [2_000, 500, 5_000];
/** Units a second: a slow answer, a usual one, and one faster than either CLI was seen to write. */
const RATES = [150, 500, 2_000];
/** The two ways an existing item's body can be written again (C17). */
const FORMS = ['whole-body', 'json_set'];

/** The app's tables (src/main/conversations/format.ts), as they are made. */
const SCHEMA = [
  'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), schemaVersion INTEGER NOT NULL, minReaderVersion INTEGER NOT NULL) STRICT',
  `CREATE TABLE conversation (id TEXT PRIMARY KEY, reference TEXT, folder TEXT, configFolder TEXT,
     startHeld INTEGER NOT NULL, reachedStart INTEGER NOT NULL DEFAULT 0,
     removing INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, extra TEXT) STRICT`,
  `CREATE TABLE turn (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, place INTEGER NOT NULL,
     origin TEXT NOT NULL, providerTurnId TEXT, acceptedAt INTEGER, providerTook INTEGER NOT NULL DEFAULT 0,
     providerStartedAt INTEGER, providerEndedAt INTEGER, endReceivedAt INTEGER, providerOutcome TEXT,
     providerDurationMs INTEGER, sessionEndedAt INTEGER, sessionOutcome TEXT,
     reached INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0, extra TEXT) STRICT`,
  `CREATE TABLE item (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, turnId TEXT NOT NULL, place INTEGER NOT NULL,
     kind TEXT NOT NULL, origin TEXT NOT NULL, providerItemId TEXT, receivedAt INTEGER, providerAt INTEGER,
     body TEXT NOT NULL) STRICT`,
  'CREATE INDEX turn_place ON turn (conversationId, place)',
  'CREATE INDEX turn_provider ON turn (conversationId, providerTurnId)',
  'CREATE INDEX item_place ON item (turnId, place)',
  'CREATE INDEX item_provider ON item (conversationId, providerItemId)',
];

/** The same text every run: Markdown-like lines, a few of them not ASCII. */
function textOf(units) {
  const lines = [];
  let length = 0;
  for (let n = 1; length < units; n += 1) {
    const line = n % 17 === 0 ? `| row ${n} | café ${n * 7} | naïve — ${n % 5} |\n` : n % 5 === 0 ? `- item ${n}: the tide table is pinned by the door, and the kettle whistles twice.\n` : `Line ${n} of the answer says that the logbook is kept in the blue drawer (${n * 13}).\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join('').slice(0, units);
}

const bodyOf = (text, complete) => JSON.stringify({ role: 'assistant', phase: complete ? 'final' : null, blocks: [{ type: 'text', text, cut: false }], questions: [], notice: null, detail: null, complete });
const sizeOf = (file) => (existsSync(file) ? statSync(file).size : 0);
const round = (value) => Number(value.toFixed(2));

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return { count: sorted.length, minMs: round(sorted[0]), medianMs: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(sorted.at(-1)), totalMs: round(sorted.reduce((sum, value) => sum + value, 0)) };
}

function createStore(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STORE_NAME);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA auto_vacuum=FULL');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=FULL');
  db.exec('PRAGMA secure_delete=ON');
  db.exec('BEGIN IMMEDIATE');
  db.exec('PRAGMA application_id=1717662823');
  for (const statement of SCHEMA) db.exec(statement);
  db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 2, 2)').run();
  // Some chats already there: 200 turns of a prompt and an answer.
  db.prepare('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, 1, ?)').run('c-old', 0);
  db.prepare('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, 1, ?)').run('c-live', 0);
  const turn = db.prepare("INSERT INTO turn (id, conversationId, place, origin, acceptedAt) VALUES (?, ?, ?, 'local', 0)");
  const item = db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, receivedAt, body) VALUES (?, ?, ?, ?, 'message', 'local', 0, ?)");
  const answer = textOf(1_500);
  for (let n = 1; n <= 200; n += 1) {
    turn.run(`t-old-${n}`, 'c-old', n);
    item.run(`i-old-${n}-1`, 'c-old', `t-old-${n}`, 1, JSON.stringify({ role: 'user', phase: null, blocks: [{ type: 'text', text: `Prompt ${n}`, cut: false }], questions: [], notice: null, detail: null }));
    item.run(`i-old-${n}-2`, 'c-old', `t-old-${n}`, 2, bodyOf(answer, true));
  }
  turn.run('t-live', 'c-live', 1);
  item.run('i-live-1', 'c-live', 't-live', 1, JSON.stringify({ role: 'user', phase: null, blocks: [{ type: 'text', text: 'Prompt', cut: false }], questions: [], notice: null, detail: null }));
  db.exec('COMMIT');
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  return { db, file };
}

/** One message streamed into one store: a write per interval of the counted clock, then the whole message's. */
function streamCase({ intervalMs, rate, form }) {
  const name = `${form}-${intervalMs}ms-${rate}ups`;
  const { db, file } = createStore(path.join(SCRATCH, name));
  const wal = `${file}-wal`;
  const full = textOf(BOUND);
  const perWrite = Math.max(1, Math.round((rate * intervalMs) / 1000));
  const insert = db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, providerItemId, receivedAt, body) VALUES ('i-live-2', 'c-live', 't-live', 2, 'message', 'local', 'provider-item', 0, ?)");
  const whole = db.prepare("UPDATE item SET body = ? WHERE id = 'i-live-2'");
  const keys = db.prepare("UPDATE item SET body = json_set(body, '$.blocks[0].text', ?, '$.complete', json(?), '$.phase', ?) WHERE id = 'i-live-2'");
  const write = (text, complete) => {
    const started = performance.now();
    db.exec('BEGIN IMMEDIATE');
    if (form === 'whole-body') whole.run(bodyOf(text, complete));
    else keys.run(text, complete ? 'true' : 'false', complete ? 'final' : null);
    db.exec('COMMIT');
    return performance.now() - started;
  };

  const mainBefore = sizeOf(file);
  // The first text: the item's insert (C14), with the first delta's worth of it.
  const firstStarted = performance.now();
  db.exec('BEGIN IMMEDIATE');
  insert.run(bodyOf(full.slice(0, Math.min(40, BOUND)), false));
  db.exec('COMMIT');
  const insertMs = performance.now() - firstStarted;

  const writes = [];
  let walMax = sizeOf(wal);
  let mainMax = sizeOf(file);
  for (let units = perWrite; units < BOUND; units += perWrite) {
    const ms = write(full.slice(0, units), false);
    const walBytes = sizeOf(wal);
    walMax = Math.max(walMax, walBytes);
    mainMax = Math.max(mainMax, sizeOf(file));
    writes.push({ units, ms, walBytes });
  }
  // The whole message, complete (C17).
  const finalMs = write(full, true);
  walMax = Math.max(walMax, sizeOf(wal));
  const walAtEnd = sizeOf(wal);
  const mainAtEnd = sizeOf(file);
  const stored = JSON.parse(db.prepare("SELECT body FROM item WHERE id = 'i-live-2'").get().body);
  const intact = stored.blocks[0].text === full && stored.complete === true && stored.role === 'assistant';
  const quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
  const checkpointStarted = performance.now();
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const checkpointMs = performance.now() - checkpointStarted;
  db.close();

  const by = (low, high) => stats(writes.filter((entry) => entry.units > low && entry.units <= high).map((entry) => entry.ms));
  return {
    name, form, intervalMs, rate, unitsPerWrite: perWrite, streamSeconds: round(BOUND / rate),
    insertMs: round(insertMs), writes: stats(writes.map((entry) => entry.ms)), finalWriteMs: round(finalMs),
    // By how much text the item held at its write: the cost grows with it.
    bySize: { to10k: by(0, 10_000), to50k: by(10_000, 50_000), to100k: by(50_000, BOUND) },
    slowest: [...writes].sort((a, b) => b.ms - a.ms).slice(0, 3).map((entry) => ({ units: entry.units, ms: round(entry.ms) })),
    log: { maxBytes: walMax, atEndBytes: walAtEnd, afterCheckpointBytes: sizeOf(wal) },
    mainFile: { beforeBytes: mainBefore, maxBytes: mainMax, atEndBytes: mainAtEnd, afterCheckpointBytes: sizeOf(file) },
    checkpointMs: round(checkpointMs), intact, quickCheck,
  };
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const probe = new DatabaseSync(':memory:');
const sqlite = probe.prepare('SELECT sqlite_version() AS version').get().version;
probe.close();

const cases = [];
for (const form of FORMS) for (const intervalMs of INTERVALS_MS) for (const rate of RATES) cases.push(streamCase({ intervalMs, rate, form }));

const report = { at: new Date().toISOString(), runtime, node: process.versions.node, electron: process.versions.electron ?? null, sqlite, platform: `${process.platform}-${process.arch}`, boundUnits: BOUND, cases };
mkdirSync(OUT, { recursive: true });
const outFile = path.join(OUT, `k4-${runtime}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

console.log(`[k4] ${runtime}: node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}, sqlite ${sqlite}`);
console.log('[k4] form        interval  rate   writes  median   p95     max     final   stream-total  log max    log end   intact');
for (const entry of cases) {
  console.log(`[k4] ${entry.form.padEnd(11)} ${String(entry.intervalMs).padStart(5)} ms ${String(entry.rate).padStart(5)}  ${String(entry.writes.count).padStart(6)}  ${String(entry.writes.medianMs).padStart(6)}  ${String(entry.writes.p95Ms).padStart(6)}  ${String(entry.writes.maxMs).padStart(6)}  ${String(entry.finalWriteMs).padStart(6)}  ${String(entry.writes.totalMs).padStart(9)} ms  ${String(entry.log.maxBytes).padStart(9)}  ${String(entry.log.atEndBytes).padStart(9)}  ${entry.intact && entry.quickCheck === 'ok' ? 'yes' : 'NO'}`);
}
console.log(`[k4] report: ${path.relative(ROOT, outFile)}`);
