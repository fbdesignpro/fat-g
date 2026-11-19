// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1's check (docs/planning/_archive/M18-spec-sheet.md), the same in every leg: with `node:sqlite`, a store
// created, a transaction committed, the store reopened. It reports booleans, versions, names and
// timings; the store holds made-up rows only and lives in the scratch folder it is given.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** 'fatg', as SQLite's application id. */
export const APPLICATION_ID = 0x66617467;
export const STORE_NAME = 'conversations.sqlite';

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** How long one small committed transaction takes, at a synchronous level: the median of `count`. */
function commitTiming(db, level, count = 200) {
  db.exec(`PRAGMA synchronous=${level}`);
  const insert = db.prepare('INSERT INTO item (turn, body) VALUES (?, ?)');
  const times = [];
  for (let index = 0; index < count; index += 1) {
    const before = performance.now();
    db.exec('BEGIN IMMEDIATE');
    insert.run(`timing-${level}`, JSON.stringify({ text: 'x'.repeat(400), index }));
    db.exec('COMMIT');
    times.push(performance.now() - before);
  }
  return { medianMs: Number(median(times).toFixed(3)), maxMs: Number(Math.max(...times).toFixed(3)) };
}

export async function storeCheck(dir) {
  const report = {
    ok: false,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    processType: process.type ?? null,
    platform: `${process.platform}-${process.arch}`,
    loads: false,
    steps: {},
  };
  const warnings = [];
  const onWarning = (warning) => warnings.push(`${warning.name}: ${warning.message}`);
  process.on('warning', onWarning);
  try {
    let sqlite;
    try { sqlite = await import('node:sqlite'); } catch (error) { report.loadError = `${error?.code ?? ''} ${error?.message ?? error}`.trim(); return report; }
    report.loads = true;
    const { DatabaseSync } = sqlite;

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, STORE_NAME);

    // Created.
    let db = new DatabaseSync(file);
    report.sqlite = db.prepare('SELECT sqlite_version() AS version').get().version;
    report.steps.journalMode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    db.exec('CREATE TABLE meta (schemaVersion INTEGER NOT NULL, minReaderVersion INTEGER NOT NULL) STRICT');
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(1, 1);
    db.exec('CREATE TABLE item (id INTEGER PRIMARY KEY, turn TEXT NOT NULL, body TEXT NOT NULL) STRICT');
    report.steps.created = existsSync(file);
    report.steps.strictTables = true;

    // Committed: the call returns nothing to wait for, and a second connection sees the row at once.
    db.exec('BEGIN IMMEDIATE');
    const ran = db.prepare('INSERT INTO item (turn, body) VALUES ($turn, $body)').run({ $turn: 'turn-1', $body: JSON.stringify({ text: 'hello', unknown: { kept: true } }) });
    const committed = db.exec('COMMIT');
    report.steps.commitReturns = committed === undefined ? 'undefined' : committed instanceof Promise ? 'promise' : typeof committed;
    report.steps.runReturns = Object.keys(ran).sort().join(',');
    const second = new DatabaseSync(file);
    report.steps.secondConnectionSeesCommit = second.prepare('SELECT count(*) AS n FROM item').get().n === 1;
    second.close();

    // A rollback leaves nothing.
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO item (turn, body) VALUES (?, ?)').run('turn-rolled-back', '{}');
    db.exec('ROLLBACK');
    report.steps.rollbackLeavesNothing = db.prepare('SELECT count(*) AS n FROM item').get().n === 1;

    // JSON: a key this build does not know survives an update of one it does.
    db.prepare("UPDATE item SET body = json_set(body, '$.text', ?) WHERE turn = ?").run('changed', 'turn-1');
    const body = JSON.parse(db.prepare('SELECT body FROM item WHERE turn = ?').get('turn-1').body);
    report.steps.jsonFunctions = body.text === 'changed' && body.unknown?.kept === true;

    report.steps.commitTiming = { full: commitTiming(db, 'FULL'), normal: commitTiming(db, 'NORMAL') };
    db.exec("DELETE FROM item WHERE turn LIKE 'timing-%'");
    report.steps.filesWhileOpen = readdirSync(dir).sort();
    db.close();
    report.steps.filesAfterClose = readdirSync(dir).sort();

    // Reopened.
    db = new DatabaseSync(file);
    const meta = db.prepare('SELECT schemaVersion, minReaderVersion FROM meta').get();
    const row = db.prepare('SELECT turn FROM item').get();
    report.steps.reopened = meta.schemaVersion === 1 && meta.minReaderVersion === 1 && row.turn === 'turn-1'
      && db.prepare('PRAGMA application_id').get().application_id === APPLICATION_ID
      && db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal';
    db.close();

    // A read-only connection reads, and cannot write.
    const reader = new DatabaseSync(file, { readOnly: true });
    let refusal = null;
    try { reader.exec("INSERT INTO item (turn, body) VALUES ('no', '{}')"); } catch (error) { refusal = `${error?.code ?? ''} ${error?.errcode ?? ''} ${error?.message ?? error}`.trim(); }
    report.steps.readOnlyReads = reader.prepare('SELECT count(*) AS n FROM item').get().n === 1;
    report.steps.readOnlyRefusesWrite = refusal;
    reader.close();

    const { steps } = report;
    report.ok = steps.created && steps.commitReturns === 'undefined' && steps.secondConnectionSeesCommit && steps.rollbackLeavesNothing
      && steps.jsonFunctions && steps.reopened && steps.readOnlyReads && refusal !== null;
  } catch (error) {
    report.error = `${error?.code ?? ''} ${error?.message ?? error}`.trim();
  } finally {
    // A warning is told on a later tick than the import that caused it.
    await new Promise((resolve) => setImmediate(resolve));
    process.off('warning', onWarning);
    report.warnings = warnings;
  }
  return report;
}
