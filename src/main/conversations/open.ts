// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Opening the conversation store (docs/planning/_archive/M18.md, Design 2; C7, C8, C36, C37, C39, C56, C62):
// the driver is `node:sqlite`, the module of Node itself and of Electron's Node, so nothing is
// added to the package (K1).
//
//   nothing there, or a zero-length file   a new store is made
//   a file                                 checked on a READ-ONLY connection, then opened for writing
//
// The check reads the application id, the `meta` row and the names of the tables and columns this
// build needs, and nothing else: it is bounded, never a scan of the store (C39). Its connection is
// read-only and is closed before anything else happens, so a store this build refuses keeps its
// main file and its log byte for byte (K2); only the index SQLite keeps beside them is written.
// Nothing here checks the whole store, repairs it or rebuilds it, now or later.
import { DatabaseSync } from 'node:sqlite';
import type { RecordsRefusalCause } from '@shared/contracts/projects';
import { APPLICATION_ID, CONVERSATIONS_VERSION, NEEDED_COLUMNS, SCHEMA } from './format';

export type OpenResult =
  | { readonly kind: 'open'; readonly db: DatabaseSync; readonly created: boolean }
  /** The four causes are the records file's own (C33). */
  | { readonly kind: 'refused'; readonly cause: RecordsRefusalCause };

/** SQLite's own result codes for a file that is no database, or one it calls corrupt. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function sqliteCode(error: unknown): number | null {
  const code = typeof error === 'object' && error !== null && 'errcode' in error ? error.errcode : undefined;
  // The low byte is the primary code: an extended code keeps it there.
  return typeof code === 'number' ? code & 0xff : null;
}

/** `FULL` in the app (C56). A test that writes thousands of rows may say `OFF`: nothing else may. */
export type Synchronous = 'FULL' | 'OFF';

/**
 * The writing connection's own settings, which last as long as the connection (K3): an accepted
 * prompt and every item are on disk when their commit returns (C56), and what a delete frees is
 * overwritten (C62).
 */
function settle(db: DatabaseSync, synchronous: Synchronous): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`PRAGMA synchronous=${synchronous}`);
  db.exec('PRAGMA secure_delete=ON');
}

/** A new store: `auto_vacuum` before the first table, then one transaction with the id, the tables and the versions. */
function create(file: string, version: number, synchronous: Synchronous): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA auto_vacuum=FULL');
    settle(db, synchronous);
    db.exec('BEGIN IMMEDIATE');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    for (const statement of SCHEMA) db.exec(statement);
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, ?, ?)').run(version, version);
    db.exec('COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** What the read-only check finds: null when this build reads the store, else why it does not. */
function check(file: string, version: number): RecordsRefusalCause | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return 'unreadable';
  }
  try {
    const id = (db.prepare('PRAGMA application_id').get() as { application_id?: unknown } | undefined)?.application_id;
    if (id !== APPLICATION_ID) return 'damaged';
    const has = (table: string, columns: readonly string[]): boolean => {
      const found = new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name));
      return columns.every((column) => found.has(column));
    };
    // The versions first: an earlier format lacks what a later one added, and is older, not damaged (M19, C22).
    if (!has('meta', NEEDED_COLUMNS['meta'] ?? [])) return 'damaged';
    const meta = db.prepare('SELECT schemaVersion, minReaderVersion FROM meta WHERE id = 1').get() as { schemaVersion?: unknown; minReaderVersion?: unknown } | undefined;
    const schemaVersion = meta?.schemaVersion;
    const minReaderVersion = meta?.minReaderVersion;
    if (typeof schemaVersion !== 'number' || typeof minReaderVersion !== 'number' || !Number.isInteger(schemaVersion) || !Number.isInteger(minReaderVersion) || schemaVersion < 1 || minReaderVersion < 1) return 'damaged';
    if (minReaderVersion > version) return 'newer';
    // No migration before the first release (decision 0014): an earlier format is refused as older.
    if (schemaVersion < version) return 'older';
    // A store of a format this build reads has every table and column it needs, or is damaged.
    for (const [table, columns] of Object.entries(NEEDED_COLUMNS)) if (!has(table, columns)) return 'damaged';
    return null;
  } catch (error) {
    const code = sqliteCode(error);
    // A file that is no database is found at its first read, not at the open (K2).
    return code === SQLITE_NOTADB || code === SQLITE_CORRUPT ? 'damaged' : 'unreadable';
  } finally {
    db.close();
  }
}

/**
 * Opens the store at `file`. `size` is the main file's size, or null when nothing is there: a
 * zero-length file is a store not yet made, and is taken as missing (C36).
 */
export function openStore(file: string, size: number | null, version: number = CONVERSATIONS_VERSION, synchronous: Synchronous = 'FULL'): OpenResult {
  if (size === null || size === 0) {
    try {
      return { kind: 'open', db: create(file, version, synchronous), created: true };
    } catch {
      return { kind: 'refused', cause: 'unreadable' };
    }
  }
  const cause = check(file, version);
  if (cause !== null) return { kind: 'refused', cause };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    settle(db, synchronous);
    return { kind: 'open', db, created: false };
  } catch {
    try { db?.close(); } catch { /* it never opened */ }
    return { kind: 'refused', cause: 'unreadable' };
  }
}
