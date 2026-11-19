// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K2's writer (run by k2.mjs, never by hand): makes a store, and either closes it cleanly or
// stays alive with a transaction open until it is killed.
//
//   <runtime> k2-writer.mjs <file> <wal|delete> <killed|clean> <minReaderVersion>
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_ID } from './lib/store-check.mjs';

const [file, mode, how, minReader] = process.argv.slice(2);
const db = new DatabaseSync(file);
const journal = db.prepare(`PRAGMA journal_mode=${mode}`).get().journal_mode;
db.exec('PRAGMA synchronous=FULL');
// Nothing moves the log's work into the main file by itself: committed work stays in the log.
if (mode === 'wal') db.exec('PRAGMA wal_autocheckpoint=0');
db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
db.exec('CREATE TABLE meta (schemaVersion INTEGER NOT NULL, minReaderVersion INTEGER NOT NULL) STRICT');
db.prepare('INSERT INTO meta VALUES (?, ?)').run(1, Number(minReader));
db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT');
db.prepare('INSERT INTO item (body) VALUES (?)').run('committed');

if (how === 'clean') {
  db.close();
  process.stdout.write(`DONE ${JSON.stringify({ journal })}\n`);
} else {
  // A transaction left open, large enough to leave the page cache: its pages reach the files.
  db.exec('PRAGMA cache_size=8');
  db.exec('BEGIN IMMEDIATE');
  const insert = db.prepare('INSERT INTO item (body) VALUES (?)');
  const body = 'u'.repeat(2000);
  for (let index = 0; index < 3000; index += 1) insert.run(body);
  process.stdout.write(`READY ${JSON.stringify({ journal })}\n`);
  setInterval(() => { /* alive until killed */ }, 1000);
}
