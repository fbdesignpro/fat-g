// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V17, V21 (docs/planning/_archive/M23.md; C40, C41, C84, C90): a refused store's generation — its database, its
// sidecars and its images' folder — moved aside as one, announced by a marker a crash at any rename
// leaves for the next launch to finish; and the removal of a set-aside generation, its images first
// and its database last, which a failure or an exit at any step leaves listed for Remove to finish.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { createStoreFiles, MOVE_MARKER, nodeStoreFilesIo, setAsideFolder, type StoreFilesIo } from './files';
import { CONVERSATIONS_VERSION, STORE_FILE } from './format';
import { type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const AT = Date.parse('2020-01-25T14:03:12.345Z');
const STAMP = '2020-01-25T14-03-12Z';
const DB = `conversations.set-aside.${STAMP}.sqlite`;
const IMAGES = `${ATTACHMENTS_FOLDER}.set-aside.${STAMP}`;
const names = (): string[] => readdirSync(area.dir).sort();

/** An old generation's four parts, as a refused store leaves them. */
function generation(): void {
  writeFileSync(path.join(area.dir, STORE_FILE), 'the database');
  writeFileSync(path.join(area.dir, `${STORE_FILE}-wal`), 'its log');
  writeFileSync(path.join(area.dir, `${STORE_FILE}-shm`), 'its index');
  mkdirSync(path.join(area.dir, ATTACHMENTS_FOLDER));
  writeFileSync(path.join(area.dir, ATTACHMENTS_FOLDER, `${'a'.repeat(64)}.png`), 'an image');
}

describe('a generation moved aside (V17; C40, C84)', () => {
  it('moves the database, its sidecars and its images’ folder under one stamp, and leaves no marker', async () => {
    generation();
    const files = createStoreFiles(area.dir);
    expect(await files.moveAside(AT)).toBe(path.join(area.dir, DB));
    expect(names()).toEqual([IMAGES, DB, `${DB}-shm`, `${DB}-wal`].sort());
    expect(readFileSync(path.join(area.dir, IMAGES, `${'a'.repeat(64)}.png`), 'utf8')).toBe('an image');
    expect(setAsideFolder(DB)).toBe(IMAGES);
  });

  it('announces the move before the first rename, with the stamp alone', async () => {
    generation();
    let seen: string | null = null;
    const io: StoreFilesIo = { ...nodeStoreFilesIo, rename: (from, to) => { seen ??= readFileSync(path.join(area.dir, MOVE_MARKER), 'utf8'); nodeStoreFilesIo.rename(from, to); } };
    await createStoreFiles(area.dir, io).moveAside(AT);
    expect(JSON.parse(seen ?? 'null')).toEqual({ stamp: STAMP, attempt: 1 });
  });

  it('takes the next attempt where a name of the stamp is taken, for every part at once', async () => {
    generation();
    mkdirSync(path.join(area.dir, IMAGES));
    expect(await createStoreFiles(area.dir).moveAside(AT)).toBe(path.join(area.dir, `conversations.set-aside.${STAMP}-2.sqlite`));
    expect(existsSync(path.join(area.dir, `${ATTACHMENTS_FOLDER}.set-aside.${STAMP}-2`))).toBe(true);
  });

  it('moves back what it moved when a rename fails, and leaves no marker', async () => {
    generation();
    let renames = 0;
    const io: StoreFilesIo = { ...nodeStoreFilesIo, rename: (from, to) => { renames += 1; if (renames === 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); nodeStoreFilesIo.rename(from, to); } };
    await expect(createStoreFiles(area.dir, io).moveAside(AT)).rejects.toThrow('busy');
    expect(names()).toEqual([ATTACHMENTS_FOLDER, STORE_FILE, `${STORE_FILE}-shm`, `${STORE_FILE}-wal`].sort());
  });

  it('keeps the marker where what it moved cannot go back, and the next launch finishes the move', async () => {
    generation();
    let renames = 0;
    const io: StoreFilesIo = { ...nodeStoreFilesIo, rename: (from, to) => { renames += 1; if (renames >= 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); nodeStoreFilesIo.rename(from, to); } };
    await expect(createStoreFiles(area.dir, io).moveAside(AT)).rejects.toThrow('busy');
    expect(names()).toContain(MOVE_MARKER);
    expect(createStoreFiles(area.dir).settleMove()).toBe('settled');
    expect(names()).toEqual([IMAGES, DB, `${DB}-shm`, `${DB}-wal`].sort());
  });

  // Each crash point (V17): the marker is written, then the four renames; an exit after any of them.
  for (let done = 0; done <= 4; done += 1) {
    it(`finishes at the next launch a move an exit cut short after ${done} of its four renames`, () => {
      generation();
      writeFileSync(path.join(area.dir, MOVE_MARKER), JSON.stringify({ stamp: STAMP, attempt: 1 }));
      const order = [[STORE_FILE, DB], [`${STORE_FILE}-wal`, `${DB}-wal`], [`${STORE_FILE}-shm`, `${DB}-shm`], [ATTACHMENTS_FOLDER, IMAGES]] as const;
      for (const [from, to] of order.slice(0, done)) nodeStoreFilesIo.rename(path.join(area.dir, from), path.join(area.dir, to));
      expect(createStoreFiles(area.dir).settleMove()).toBe('settled');
      expect(names()).toEqual([IMAGES, DB, `${DB}-shm`, `${DB}-wal`].sort());
    });
  }

  it('opens nothing and sweeps nothing while a move cannot be finished: the store is refused (C84)', () => {
    generation();
    writeFileSync(path.join(area.dir, MOVE_MARKER), JSON.stringify({ stamp: STAMP, attempt: 1 }));
    // Both the old name and its target there: finishing would write over one of them.
    writeFileSync(path.join(area.dir, DB), 'another');
    const store = area.open();
    expect(store.status()).toEqual({ kind: 'refused', cause: 'unreadable' });
    expect(readdirSync(path.join(area.dir, ATTACHMENTS_FOLDER))).toHaveLength(1);
    expect(names()).toContain(MOVE_MARKER);
    // A marker that cannot be read is no license either.
    writeFileSync(path.join(area.dir, MOVE_MARKER), 'not json');
    expect(createStoreFiles(area.dir).settleMove()).toBe('failed');
  });

  it('opens a new store after an exit that came once every part had moved, before the new folder existed', () => {
    writeFileSync(path.join(area.dir, MOVE_MARKER), JSON.stringify({ stamp: STAMP, attempt: 1 }));
    writeFileSync(path.join(area.dir, DB), 'the old database');
    mkdirSync(path.join(area.dir, IMAGES));
    writeFileSync(path.join(area.dir, IMAGES, `${'b'.repeat(64)}.png`), 'an old image');
    const store = area.open();
    expect(store.status()).toEqual({ kind: 'ok' });
    expect(names()).not.toContain(MOVE_MARKER);
    // The old images are the old generation's: never swept, nor moved, by the new store.
    expect(readdirSync(path.join(area.dir, IMAGES))).toEqual([`${'b'.repeat(64)}.png`]);
  });
});

describe('a store’s Start fresh with its images (V17; C84)', () => {
  it('moves the refused store’s images aside with it, sweeps none of them, and counts them in its size', async () => {
    area.open().close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    mkdirSync(path.join(area.dir, ATTACHMENTS_FOLDER));
    writeFileSync(path.join(area.dir, ATTACHMENTS_FOLDER, `${'c'.repeat(64)}.png`), 'twelve bytes');
    const store = area.open({ now: () => AT });
    expect(store.status()).toMatchObject({ kind: 'refused' });
    expect(await store.startFresh()).toMatchObject({ status: 'done' });
    expect(store.status()).toEqual({ kind: 'ok' });
    expect(readdirSync(path.join(area.dir, IMAGES))).toEqual([`${'c'.repeat(64)}.png`]);
    expect(existsSync(path.join(area.dir, ATTACHMENTS_FOLDER))).toBe(false);
    const [aside] = store.files.setAside();
    expect(aside?.name).toBe(DB);
    const parts = [DB, `${DB}-wal`, `${DB}-shm`].filter((name) => existsSync(path.join(area.dir, name)));
    const database = parts.reduce((sum, name) => sum + readFileSync(path.join(area.dir, name)).length, 0);
    expect(aside?.bytes).toBe(database + 'twelve bytes'.length);
    expect(store.attachmentsSize()).toEqual({ count: 0, bytes: 0 });
  });
});

describe('a set-aside generation’s removal (V21; C90)', () => {
  /** A set-aside generation as Start fresh leaves one. */
  function aside(): void {
    writeFileSync(path.join(area.dir, DB), 'the database');
    writeFileSync(path.join(area.dir, `${DB}-wal`), 'its log');
    writeFileSync(path.join(area.dir, `${DB}-shm`), 'its index');
    mkdirSync(path.join(area.dir, IMAGES));
    writeFileSync(path.join(area.dir, IMAGES, `${'1'.repeat(64)}.png`), 'first image');
    writeFileSync(path.join(area.dir, IMAGES, `${'2'.repeat(64)}.png`), 'second image');
  }
  const size = (): number | undefined => createStoreFiles(area.dir).setAside().find((entry) => entry.name === DB)?.bytes;

  it('removes the images first, then the sidecars, and the database last', () => {
    aside();
    const order: string[] = [];
    const io: StoreFilesIo = {
      ...nodeStoreFilesIo,
      removeTree: (dir) => { order.push(path.basename(dir)); nodeStoreFilesIo.removeTree(dir); },
      remove: (file) => { order.push(path.basename(file)); nodeStoreFilesIo.remove(file); },
    };
    expect(createStoreFiles(area.dir, io).removeSetAside([DB])).toEqual({ removed: 1, failed: 0 });
    expect(order).toEqual([IMAGES, `${DB}-wal`, `${DB}-shm`, DB]);
    expect(names()).toEqual([]);
  });

  // A failure at each step, and part of the folder (V21): listed after, with what remains, and Remove again finishes it.
  const steps = ['part of the folder', 'the folder', `${DB}-wal`, `${DB}-shm`, DB] as const;
  for (const step of steps) {
    it(`leaves the generation listed with what remains when the removal fails at ${step}, and Remove again finishes it`, () => {
      aside();
      const whole = size() ?? 0;
      const fail = (): never => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); };
      const io: StoreFilesIo = {
        ...nodeStoreFilesIo,
        removeTree(dir) {
          if (step === 'part of the folder') { nodeStoreFilesIo.remove(path.join(dir, `${'1'.repeat(64)}.png`)); fail(); }
          if (step === 'the folder') fail();
          nodeStoreFilesIo.removeTree(dir);
        },
        remove(file) {
          if (path.basename(file) === step) fail();
          nodeStoreFilesIo.remove(file);
        },
      };
      expect(createStoreFiles(area.dir, io).removeSetAside([DB])).toEqual({ removed: 0, failed: 1 });
      // Still listed, by its database, after a restart too: its size what is left of it.
      const left = size();
      expect(left).toBeDefined();
      expect(left).toBeLessThanOrEqual(whole);
      if (step === 'part of the folder') expect(left).toBe(whole - 'first image'.length);
      expect(createStoreFiles(area.dir).removeSetAside([DB])).toEqual({ removed: 1, failed: 0 });
      expect(names()).toEqual([]);
    });
  }

  it('never leaves an images’ folder behind its database: one whose database is gone is no generation listed (C90)', () => {
    aside();
    createStoreFiles(area.dir).removeSetAside([DB]);
    expect(existsSync(path.join(area.dir, IMAGES))).toBe(false);
  });

  it('removes no generation whose move has not settled (C84)', () => {
    aside();
    writeFileSync(path.join(area.dir, MOVE_MARKER), JSON.stringify({ stamp: STAMP, attempt: 1 }));
    expect(createStoreFiles(area.dir).removeSetAside([DB])).toEqual({ removed: 0, failed: 1 });
    expect(existsSync(path.join(area.dir, IMAGES))).toBe(true);
  });
});
