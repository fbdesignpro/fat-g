// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K2 (docs/planning/_archive/M18-spec-sheet.md): does the version check leave a refused store unchanged?
//
//   node spikes/m18/k2.mjs                                   under Node
//   ELECTRON_RUN_AS_NODE=1 <electron> spikes/m18/k2.mjs      under Electron's Node
//
// Per journal mode (write-ahead log, rollback journal), a writer process makes a store and is
// killed with a transaction open and committed work behind it; the store is then opened as the
// version check would open it — read-only — and every file is compared, byte for byte, with what
// it was. The same for a store closed cleanly, a file that is no database, and a missing file.
// It launches only this runtime again as the writer, and touches only spikes/output/m18/k2-*/.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_ID, STORE_NAME } from './lib/store-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const runtime = process.versions.electron === undefined ? 'node' : 'electron';
const OUT = path.join(ROOT, 'spikes', 'output', 'm18');
const SCRATCH = path.join(OUT, `k2-${runtime}`);
const WRITER_MS = 60_000;

/** Every file of a folder: its size and the hash of its bytes. */
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const bytes = readFileSync(path.join(dir, name));
    return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16) }];
  }));
}

/** What became of each file between two snapshots. */
function compare(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return Object.fromEntries(names.map((name) => [name,
    before[name] === undefined ? `created (${after[name].bytes} bytes)`
      : after[name] === undefined ? 'removed'
        : before[name].sha256 === after[name].sha256 && before[name].bytes === after[name].bytes ? 'same' : `changed (${before[name].bytes} → ${after[name].bytes} bytes)`]));
}

const describe = (error) => `${error?.code ?? ''} ${error?.errcode ?? ''} ${error?.errstr ?? ''} ${error?.message ?? error}`.replace(/\s+/g, ' ').trim();

/** The file's own header, read as bytes with no database opened: SQLite's user version and application id. */
function header(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 100) return { bytes: bytes.length };
  return { magic: bytes.subarray(0, 15).toString('latin1') === 'SQLite format 3', userVersion: bytes.readUInt32BE(60), applicationId: bytes.readUInt32BE(68), applicationIdIsOurs: bytes.readUInt32BE(68) === APPLICATION_ID, writeVersion: bytes[18], readVersion: bytes[19] };
}

/** The version check: a read-only connection, the application id and the two versions. Nothing else. */
function versionCheck(file) {
  const result = { opened: false };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    result.opened = true;
    result.applicationIdIsOurs = db.prepare('PRAGMA application_id').get().application_id === APPLICATION_ID;
    const meta = db.prepare('SELECT schemaVersion, minReaderVersion FROM meta').get();
    result.versions = { schemaVersion: meta.schemaVersion, minReaderVersion: meta.minReaderVersion };
    result.committedRows = db.prepare("SELECT count(*) AS n FROM item WHERE body = 'committed'").get().n;
    result.uncommittedRows = db.prepare("SELECT count(*) AS n FROM item WHERE body <> 'committed'").get().n;
  } catch (error) {
    result.error = describe(error);
  } finally {
    try { db?.close(); } catch (error) { result.closeError = describe(error); }
  }
  return result;
}

/** Runs the writer; resolves at its READY or DONE line, having killed it when it is to be killed. */
function writer(file, mode, how, minReader) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'k2-writer.mjs'), file, mode, how, String(minReader)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let said = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the writer said nothing in ${WRITER_MS} ms: ${stderr.slice(-400)}`)); }, WRITER_MS);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = /^(READY|DONE) (.*)$/m.exec(stdout);
      if (line === null || said !== null) return;
      said = { word: line[1], ...JSON.parse(line[2]) };
      // Killed outright: no handler of its own runs, as when the app's process is ended from outside.
      if (line[1] === 'READY') child.kill('SIGKILL');
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (said === null) reject(new Error(`the writer ended (${code ?? signal}) before it was ready: ${stderr.slice(-400)}`));
      else resolve({ ...said, exit: code, signal });
    });
  });
}

async function storeCase(mode, how, minReader) {
  const dir = path.join(SCRATCH, `${mode}-${how}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STORE_NAME);
  const result = { mode, how };
  result.writer = await writer(file, mode, how, minReader);
  const before = snapshot(dir);
  result.filesBefore = Object.fromEntries(Object.entries(before).map(([name, entry]) => [name, entry.bytes]));
  result.headerBefore = header(file);
  result.check = versionCheck(file);
  const after = snapshot(dir);
  result.afterCheck = compare(before, after);
  // A second check, as a second launch would make it.
  result.secondCheck = versionCheck(file);
  result.afterSecondCheck = compare(after, snapshot(dir));
  // Then what a build that accepts the store does: opens it to write. What a killed writer left is undone here.
  const beforeOpen = snapshot(dir);
  try {
    const db = new DatabaseSync(file);
    result.writeOpen = {
      committedRows: db.prepare("SELECT count(*) AS n FROM item WHERE body = 'committed'").get().n,
      uncommittedRows: db.prepare("SELECT count(*) AS n FROM item WHERE body <> 'committed'").get().n,
      quickCheck: db.prepare('PRAGMA quick_check').get().quick_check,
    };
    db.prepare('INSERT INTO item (body) VALUES (?)').run('committed');
    db.close();
  } catch (error) {
    result.writeOpen = { error: describe(error) };
  }
  result.afterWriteOpenAndCleanClose = compare(beforeOpen, snapshot(dir));
  result.headerAfterCleanClose = header(file);
  return result;
}

/** A file that is no database, and a file that is not there: neither is changed, and nothing is made. */
function strangers() {
  const dir = path.join(SCRATCH, 'strangers');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const garbage = path.join(dir, STORE_NAME);
  writeFileSync(garbage, randomBytes(8192));
  const before = snapshot(dir);
  const notADatabase = { header: header(garbage), check: versionCheck(garbage) };
  notADatabase.afterCheck = compare(before, snapshot(dir));
  const empty = path.join(dir, 'empty.sqlite');
  writeFileSync(empty, '');
  const beforeEmpty = snapshot(dir);
  const emptyFile = { check: versionCheck(empty), afterCheck: compare(beforeEmpty, snapshot(dir)) };
  const missing = path.join(dir, 'missing.sqlite');
  const missingFile = { check: versionCheck(missing), createdSomething: existsSync(missing) };
  // A store opened to write and ended before its first write: what is left of it.
  const fresh = path.join(dir, 'fresh.sqlite');
  const opened = new DatabaseSync(fresh);
  const freshOpen = { existsWhileOpen: existsSync(fresh), bytesWhileOpen: existsSync(fresh) ? readFileSync(fresh).length : null };
  opened.close();
  freshOpen.existsAfterClose = existsSync(fresh);
  freshOpen.bytesAfterClose = existsSync(fresh) ? readFileSync(fresh).length : null;
  return { notADatabase, emptyFile, missingFile, freshOpen };
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const probe = new DatabaseSync(':memory:');
const sqlite = probe.prepare('SELECT sqlite_version() AS version').get().version;
probe.close();

const cases = [];
for (const mode of ['wal', 'delete']) {
  cases.push(await storeCase(mode, 'killed', 1));
  // Closed cleanly, and written by a build newer than this one: its minimum reader is 99.
  cases.push(await storeCase(mode, 'clean', 99));
}
const report = { at: new Date().toISOString(), runtime, node: process.versions.node, electron: process.versions.electron ?? null, sqlite, platform: `${process.platform}-${process.arch}`, cases, strangers: strangers() };
const outFile = path.join(OUT, `k2-${runtime}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

for (const entry of cases) {
  console.log(`[k2] ${runtime} ${entry.mode}/${entry.how}: files before ${JSON.stringify(entry.filesBefore)}`);
  console.log(`      header before: ${JSON.stringify(entry.headerBefore)}`);
  console.log(`      check: ${JSON.stringify(entry.check)}`);
  console.log(`      after check: ${JSON.stringify(entry.afterCheck)}`);
  console.log(`      after second check: ${JSON.stringify(entry.afterSecondCheck)}`);
  console.log(`      write open: ${JSON.stringify(entry.writeOpen)} → ${JSON.stringify(entry.afterWriteOpenAndCleanClose)}`);
  console.log(`      header after clean close: ${JSON.stringify(entry.headerAfterCleanClose)}`);
}
console.log(`[k2] strangers: ${JSON.stringify(report.strangers)}`);
console.log(`[k2] sqlite ${sqlite}; report: ${path.relative(ROOT, outFile)}`);
