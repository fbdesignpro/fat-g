// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K3 (docs/planning/_archive/M18-spec-sheet.md): what does a removed chat leave in the store's files?
//
//   node spikes/m18/k3.mjs                                   under Node
//   ELECTRON_RUN_AS_NODE=1 <electron> spikes/m18/k3.mjs      under Electron's Node
//
// Per setting, a store in write-ahead mode is made with a chat to keep and a larger one to remove,
// closed, and opened again as a later launch opens it. The larger chat's rows are then deleted, and
// every file of the store is searched for a text that only those rows held, while the store is
// open and after it is closed; the files' sizes are recorded before and after.
// It launches nothing, and touches only spikes/output/m18/k3-*/. The rows are made up.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_ID, STORE_NAME } from './lib/store-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const runtime = process.versions.electron === undefined ? 'node' : 'electron';
const OUT = path.join(ROOT, 'spikes', 'output', 'm18');
const SCRATCH = path.join(OUT, `k3-${runtime}`);
/** In the removed chat's rows alone. */
const NEEDLE = 'k3-removed-chat-sentinel-0123456789';

const sizes = (dir) => Object.fromEntries(readdirSync(dir).sort().map((name) => [name, statSync(path.join(dir, name)).size]));
/** The files that still hold the removed chat's text. */
const holding = (dir) => readdirSync(dir).sort().filter((name) => readFileSync(path.join(dir, name)).includes(NEEDLE));

/** The writing connection's own settings: they last as long as the connection, so each open sets them. */
function settle(db, secure) {
  db.exec('PRAGMA synchronous=FULL');
  if (secure) db.exec('PRAGMA secure_delete=ON');
}

function storeCase(name, { secure, vacuum, checkpoint }) {
  const dir = path.join(SCRATCH, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STORE_NAME);
  const result = { name, secure, vacuum, checkpoint };

  let db = new DatabaseSync(file);
  result.defaults = { secureDelete: db.prepare('PRAGMA secure_delete').get().secure_delete, autoVacuum: db.prepare('PRAGMA auto_vacuum').get().auto_vacuum };
  // Chosen before the first table is made: it is a property of the file from then on.
  if (vacuum !== null) db.exec(`PRAGMA auto_vacuum=${vacuum}`);
  db.exec('PRAGMA journal_mode=WAL');
  settle(db, secure);
  db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
  db.exec('CREATE TABLE item (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, body TEXT NOT NULL) STRICT');
  db.exec('CREATE INDEX item_conversation ON item (conversationId)');
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 100; index += 1) insert.run(`keep-${index}`, 'keep', JSON.stringify({ text: 'kept '.repeat(400) }));
  for (let index = 0; index < 400; index += 1) insert.run(`gone-${index}`, 'gone', JSON.stringify({ text: `${NEEDLE} ${'removed '.repeat(250)}` }));
  db.exec('COMMIT');
  db.close();

  db = new DatabaseSync(file);
  result.atReopen = { secureDelete: db.prepare('PRAGMA secure_delete').get().secure_delete, autoVacuum: db.prepare('PRAGMA auto_vacuum').get().auto_vacuum };
  settle(db, secure);
  result.before = { sizes: sizes(dir), holding: holding(dir) };
  const started = performance.now();
  db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM item WHERE conversationId = ?').run('gone');
  db.exec('COMMIT');
  if (vacuum === 'INCREMENTAL') db.exec('PRAGMA incremental_vacuum');
  if (checkpoint) result.checkpointAnswer = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  result.removalMs = Number((performance.now() - started).toFixed(1));
  result.whileOpen = { sizes: sizes(dir), holding: holding(dir) };
  result.rowsKept = db.prepare('SELECT count(*) AS n FROM item').get().n;
  result.quickCheck = db.prepare('PRAGMA quick_check').get().quick_check;
  db.close();
  result.afterClose = { sizes: sizes(dir), holding: holding(dir) };
  return result;
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const probe = new DatabaseSync(':memory:');
const sqlite = probe.prepare('SELECT sqlite_version() AS version').get().version;
const compileOptions = probe.prepare('PRAGMA compile_options').all().map((row) => row.compile_options).filter((option) => /SECURE_DELETE|VACUUM/.test(option));
probe.close();

const cases = [
  storeCase('defaults', { secure: false, vacuum: null, checkpoint: false }),
  storeCase('secure', { secure: true, vacuum: null, checkpoint: false }),
  storeCase('secure-checkpoint', { secure: true, vacuum: null, checkpoint: true }),
  storeCase('secure-incremental-checkpoint', { secure: true, vacuum: 'INCREMENTAL', checkpoint: true }),
  storeCase('secure-full-checkpoint', { secure: true, vacuum: 'FULL', checkpoint: true }),
  // Without the overwrite: does shrinking the file alone take the text with it?
  storeCase('full-checkpoint', { secure: false, vacuum: 'FULL', checkpoint: true }),
];
const report = { at: new Date().toISOString(), runtime, node: process.versions.node, electron: process.versions.electron ?? null, sqlite, compileOptions, platform: `${process.platform}-${process.arch}`, cases };
const outFile = path.join(OUT, `k3-${runtime}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

console.log(`[k3] ${runtime}: sqlite ${sqlite}; defaults ${JSON.stringify(cases[0].defaults)}; compile options ${JSON.stringify(compileOptions)}`);
for (const entry of cases) {
  const main = (snapshot) => snapshot.sizes[STORE_NAME];
  console.log(`[k3] ${entry.name}: at reopen ${JSON.stringify(entry.atReopen)}; removal ${entry.removalMs} ms; rows kept ${entry.rowsKept}; ${entry.quickCheck}`);
  console.log(`      main file ${main(entry.before)} → ${main(entry.whileOpen)} (open) → ${main(entry.afterClose)} (closed) bytes; log while open ${entry.whileOpen.sizes[`${STORE_NAME}-wal`] ?? 'none'} bytes`);
  console.log(`      the removed text is in: ${JSON.stringify(entry.whileOpen.holding)} while open, ${JSON.stringify(entry.afterClose.holding)} after the close`);
}
console.log(`[k3] report: ${path.relative(ROOT, outFile)}`);
