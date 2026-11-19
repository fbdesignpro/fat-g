// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V18, V24, V29 (docs/planning/_archive/M18.md; C8, C36–C40, C56, C62): the store's envelope as SQLite has
// it — what is at the path decides the open, a store this build cannot read keeps its bytes, and
// the settings a new store and its writing connection are given.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPLICATION_ID, CONVERSATIONS_VERSION, NEEDED_COLUMNS, SCHEMA, STORE_FILE, storeFiles } from './format';
import { openStore } from './open';
import { CONVERSATION, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const pragma = (db: DatabaseSync, name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];

/** A store made by hand, as an earlier or later fat-g would have left it, closed cleanly. */
function make(change: (db: DatabaseSync) => void = () => undefined, id: number = APPLICATION_ID): void {
  const db = new DatabaseSync(area.file);
  db.exec('PRAGMA auto_vacuum=FULL');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`PRAGMA application_id=${id}`);
  for (const statement of SCHEMA) db.exec(statement);
  db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, ?, ?)').run(CONVERSATIONS_VERSION, CONVERSATIONS_VERSION);
  change(db);
  db.close();
}

/** A version's statements as an earlier fat-g made them: without what version 4 added (M20b, C28). */
const beforeAsides = (statement: string): string => statement.replace(',\n     parentId TEXT, source TEXT, title TEXT', '').replace(',\n     own INTEGER NOT NULL DEFAULT 0', '');
const EARLIER = SCHEMA.filter((line) => !line.includes('conversation_parent')).map(beforeAsides);

describe('what is at the path (V18; C36)', () => {
  it('makes a new store where nothing is: fat-g’s id, the tables and both versions, in write-ahead mode', () => {
    const opened = openStore(area.file, null);
    expect(opened.kind).toBe('open');
    if (opened.kind !== 'open') return;
    expect(opened.created).toBe(true);
    expect(pragma(opened.db, 'application_id')).toBe(APPLICATION_ID);
    expect(pragma(opened.db, 'journal_mode')).toBe('wal');
    expect(opened.db.prepare('SELECT schemaVersion, minReaderVersion FROM meta WHERE id = 1').get()).toEqual({ schemaVersion: 13, minReaderVersion: 13 });
    // Version 2 (M19, C22): a turn's elapsed time has its column.
    expect(NEEDED_COLUMNS['turn']).toContain('elapsedMs');
    // Version 4 (M20b, C28, C35): an aside's parent, source and title on a conversation, with the
    // index its session's read and removal go by, and the mark of a prompt fat-g answered itself.
    expect(NEEDED_COLUMNS['conversation']).toEqual(expect.arrayContaining(['parentId', 'source', 'title']));
    expect(NEEDED_COLUMNS['turn']).toContain('own');
    expect((opened.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all('conversation_parent') as { name: string }[]).map((row) => row.name)).toEqual(['parentId']);
    for (const [table, columns] of Object.entries(NEEDED_COLUMNS)) {
      const found = (opened.db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name);
      expect(found, table).toEqual(expect.arrayContaining([...columns]));
    }
    opened.db.close();
    // A clean close leaves the main file alone (K1).
    expect(readdirSync(area.dir)).toEqual([STORE_FILE]);
  });

  it('takes a zero-length file as a store not yet made', () => {
    writeFileSync(area.file, '');
    const opened = openStore(area.file, 0);
    expect(opened).toMatchObject({ kind: 'open', created: true });
    if (opened.kind === 'open') opened.db.close();
  });

  it('opens a store it made, with its rows', () => {
    const store = area.open();
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'm1', text: 'hello', at: 5, started: false });
    store.close();
    const again = area.open();
    expect(again.status()).toEqual({ kind: 'ok' });
    expect(again.newestPage(CONVERSATION).items.map((item) => item.id)).toEqual(['m1']);
  });
});

describe('the settings (V24, V29; C56, C62)', () => {
  it('gives the writing connection full synchronisation and secure delete, at the first open and at every later one', () => {
    for (const round of ['made', 'reopened']) {
      const opened = openStore(area.file, round === 'made' ? null : 4096);
      expect(opened.kind, round).toBe('open');
      if (opened.kind !== 'open') return;
      // 2 is FULL: a commit waits for the disk.
      expect(pragma(opened.db, 'synchronous'), round).toBe(2);
      expect(pragma(opened.db, 'secure_delete'), round).toBe(1);
      opened.db.close();
    }
  });

  it('makes the store with auto-vacuum, which stays with the file', () => {
    const made = openStore(area.file, null);
    if (made.kind === 'open') made.db.close();
    // 1 is FULL. Read on a connection that sets nothing.
    expect(area.raw((db) => pragma(db, 'auto_vacuum'))).toBe(1);
  });

  it('are the driver’s defaults turned on: neither is on by itself (K3)', () => {
    const db = new DatabaseSync(path.join(area.dir, 'plain.sqlite'));
    expect([pragma(db, 'secure_delete'), pragma(db, 'auto_vacuum')]).toEqual([0, 0]);
    db.close();
  });
});

describe('a store this build cannot read (V3, V18; C8, C36–C39)', () => {
  /** Opens the store as the app does, and checks that the main file and its log, where one is there, kept their bytes. */
  function refusedUnchanged(cause: string, version?: number): void {
    const before = area.hashes();
    const size = readFileSync(area.file).length;
    expect(openStore(area.file, size, version)).toEqual({ kind: 'refused', cause });
    const after = area.hashes();
    for (const name of [STORE_FILE, `${STORE_FILE}-wal`]) {
      if (before[name] !== undefined) expect(after[name], name).toBe(before[name]);
    }
    expect(after[STORE_FILE]).toBe(before[STORE_FILE]);
  }

  it('refuses a file that is no database as damaged, byte for byte unchanged', () => {
    writeFileSync(area.file, randomBytes(8192));
    refusedUnchanged('damaged');
    // And no sidecar was made beside it (K2).
    expect(readdirSync(area.dir)).toEqual([STORE_FILE]);
  });

  it('refuses another program’s database as damaged: the application id is not fat-g’s', () => {
    make(() => undefined, 0x12345678);
    refusedUnchanged('damaged');
  });

  it('refuses a store with no versions as damaged', () => {
    make((db) => db.exec('DELETE FROM meta'));
    refusedUnchanged('damaged');
  });

  it.each([
    ['a needed table', 'DROP TABLE item'],
    ['a needed column', 'ALTER TABLE turn DROP COLUMN sessionOutcome'],
    ['the versions’ table', 'DROP TABLE meta'],
  ])('refuses a store that lacks %s as damaged', (_what, statement) => {
    make((db) => db.exec(statement));
    refusedUnchanged('damaged');
  });

  it('refuses a store that needs a newer reader as newer', () => {
    make((db) => db.exec(`UPDATE meta SET schemaVersion = ${CONVERSATIONS_VERSION + 1}, minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    refusedUnchanged('newer');
  });

  it('refuses an earlier format as older: there is no migration before the first release', () => {
    make();
    refusedUnchanged('older', CONVERSATIONS_VERSION + 1);
  });

  it('refuses a version-10 store, as M106 made it, as older, byte for byte unchanged: version 11 added a conversation’s `planNote` and four plan outcomes (decision 0029)', () => {
    expect(NEEDED_COLUMNS['conversation']).toContain('planNote');
    make((db) => {
      db.exec('ALTER TABLE conversation DROP COLUMN planNote');
      db.exec('UPDATE meta SET schemaVersion = 10, minReaderVersion = 10');
    });
    refusedUnchanged('older');
  });

  it('refuses a version-11 store without queue provenance, byte for byte unchanged', () => {
    make((db) => db.exec('UPDATE meta SET schemaVersion = 11, minReaderVersion = 11'));
    refusedUnchanged('older');
  });

  it('refuses a version-9 store, as M23 made it, as older, byte for byte unchanged: version 10 added no column, a worker item’s body naming its model (M106, C19)', () => {
    make((db) => db.exec('UPDATE meta SET schemaVersion = 9, minReaderVersion = 9'));
    refusedUnchanged('older');
  });

  it('refuses a version-4 store, as M20b made it, as older, byte for byte unchanged: version 5 added no column (M21, C32, S5)', () => {
    // The tables are the ones this build makes: the two numbers alone say it is an earlier format.
    make((db) => db.exec('UPDATE meta SET schemaVersion = 4, minReaderVersion = 4'));
    refusedUnchanged('older');
  });

  it('refuses the previous speed-less format without changing its bytes', () => {
    make((db) => db.exec('UPDATE meta SET schemaVersion = 12, minReaderVersion = 12'));
    refusedUnchanged('older');
  });

  it('refuses a version-1 store, as M18 made it, as older, byte for byte unchanged (M19, C22, S9)', () => {
    expect(CONVERSATIONS_VERSION).toBe(13);
    // Version 1: both numbers 1, no elapsed column on a turn, no `complete` key in a body, and no worker's column.
    const db = new DatabaseSync(area.file);
    db.exec('PRAGMA auto_vacuum=FULL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    for (const statement of EARLIER.filter((line) => !line.includes('item_worker'))) db.exec(statement.replace(' elapsedMs INTEGER,', '').replace(', workerId TEXT', ''));
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 1, 1)').run();
    db.prepare('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, 1, 1)').run(CONVERSATION);
    db.prepare("INSERT INTO turn (id, conversationId, place, origin) VALUES ('t1', ?, 1, 'local')").run(CONVERSATION);
    db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, body) VALUES ('i1', ?, 't1', 1, 'message', 'local', ?)").run(CONVERSATION, JSON.stringify({ role: 'user', phase: null, blocks: [{ type: 'text', text: 'kept', cut: false }], questions: [], notice: null, detail: null }));
    db.close();
    refusedUnchanged('older');
    // Left for Start fresh: what it held is still in it.
    expect(area.raw((raw) => (raw.prepare('SELECT name FROM pragma_table_info(?)').all('turn') as { name: string }[]).map((row) => row.name))).not.toContain('elapsedMs');
    expect(area.holding('kept')).toContain(STORE_FILE);
  });

  it('refuses a version-2 store, as M19 made it, as older, byte for byte unchanged: its saved chats stay in it (M20a, S7)', () => {
    // Version 2: both numbers 2, a turn's elapsed time, a body's `complete` key — and no worker's column or index on an item.
    const db = new DatabaseSync(area.file);
    db.exec('PRAGMA auto_vacuum=FULL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    for (const statement of EARLIER.filter((line) => !line.includes('item_worker'))) db.exec(statement.replace(', workerId TEXT', ''));
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 2, 2)').run();
    db.prepare('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, 1, 1)').run(CONVERSATION);
    db.prepare("INSERT INTO turn (id, conversationId, place, origin, elapsedMs) VALUES ('t1', ?, 1, 'local', 40)").run(CONVERSATION);
    db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, body) VALUES ('i1', ?, 't1', 1, 'message', 'local', ?)").run(CONVERSATION, JSON.stringify({ role: 'assistant', phase: 'final', blocks: [{ type: 'text', text: 'a saved chat', cut: false }], questions: [], notice: null, detail: null, complete: true }));
    db.close();
    // Older, and not damaged, though it lacks a column this build needs: the versions are read first.
    refusedUnchanged('older');
    expect(area.raw((raw) => (raw.prepare('SELECT name FROM pragma_table_info(?)').all('item') as { name: string }[]).map((row) => row.name))).not.toContain('workerId');
    expect(area.holding('a saved chat')).toContain(STORE_FILE);
  });

  it('refuses a version-3 store, as M20a made it, as older, byte for byte unchanged: its saved chats stay in it (M20b, S7)', () => {
    // Version 3: both numbers 3, a worker's column and its index — and no parent, source or title on a conversation, and no `own` on a turn.
    const db = new DatabaseSync(area.file);
    db.exec('PRAGMA auto_vacuum=FULL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    for (const statement of EARLIER) db.exec(statement);
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 3, 3)').run();
    db.prepare('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, 1, 1)').run(CONVERSATION);
    db.prepare("INSERT INTO turn (id, conversationId, place, origin, elapsedMs) VALUES ('t1', ?, 1, 'local', 40)").run(CONVERSATION);
    db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, body, workerId) VALUES ('i1', ?, 't1', 1, 'message', 'local', ?, NULL)").run(CONVERSATION, JSON.stringify({ role: 'assistant', phase: 'final', blocks: [{ type: 'text', text: 'a chat of M20a', cut: false }], questions: [], notice: null, detail: null, complete: true }));
    db.close();
    // Older, and not damaged, though it lacks the columns this build needs: the versions are read first.
    refusedUnchanged('older');
    const columns = (table: string): string[] => area.raw((raw) => (raw.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name));
    expect(columns('conversation')).not.toContain('parentId');
    expect(columns('turn')).not.toContain('own');
    expect(area.holding('a chat of M20a')).toContain(STORE_FILE);
  });

  it('opens a store a later fat-g wrote for this reader: its minimum reader is this build’s', () => {
    make((db) => db.exec(`UPDATE meta SET schemaVersion = ${CONVERSATIONS_VERSION + 1}`));
    const opened = openStore(area.file, 4096);
    expect(opened.kind).toBe('open');
    if (opened.kind === 'open') opened.db.close();
  });

  it('refuses what cannot be opened as unreadable', () => {
    // A folder where the file should be.
    const folder = path.join(area.dir, 'a-folder');
    mkdirSync(folder);
    expect(openStore(folder, 4096)).toEqual({ kind: 'refused', cause: 'unreadable' });
  });

  it('reads the versions and nothing more: a store damaged past its first pages opens, and nothing repairs it (C39)', () => {
    const store = area.open();
    for (let n = 1; n <= 40; n += 1) store.acceptPrompt({ conversationId: CONVERSATION, turnId: `t${n}`, itemId: `m${n}`, text: 'x'.repeat(3000), at: n, started: false });
    store.close();
    const bytes = readFileSync(area.file);
    // The last page, overwritten: a scan would find it, the check does not look.
    bytes.fill(0xff, bytes.length - 4096);
    writeFileSync(area.file, bytes);
    const damaged = area.hashes()[STORE_FILE];
    const opened = openStore(area.file, bytes.length);
    expect(opened.kind).toBe('open');
    if (opened.kind === 'open') opened.db.close();
    expect(area.hashes()[STORE_FILE]).toBe(damaged);
  });

  it('names no check of the whole store, no repair and no rebuild anywhere in the store’s code (C39)', () => {
    const folder = import.meta.dirname;
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts') && entry !== 'test-support.ts')) {
      expect(readFileSync(path.join(folder, name), 'utf8'), name).not.toMatch(/integrity_check|quick_check|\bVACUUM\b|REINDEX|\.recover|writable_schema/);
    }
  });

  it('leaves the store’s three files where they are: a refusal moves nothing', () => {
    make((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    openStore(area.file, 4096);
    expect(readdirSync(area.dir).filter((name) => !storeFiles().includes(name))).toEqual([]);
  });
});
