// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The mutation scripts' way back (scripts/lib/mutation-files.mjs): a file a run changes is put back
// byte for byte whatever the file system does for a moment, one that cannot be put back does not
// stop the others, and a run cannot end with one left changed without saying so and failing.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMutationFiles, guardTree, leftMutated, type MutationFs, RETRY_PAUSES_MS, retrying, settleTree, TRANSIENT_CODES, turn,
} from '../../scripts/lib/mutation-files.mjs';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'fatg-mutation-files-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const at = (name: string): string => path.join(root, name);
const refusal = (code: string): Error => Object.assign(new Error(`${code}: unknown error, open`), { code });
const NODE_FS: MutationFs = { existsSync, readFileSync: (target) => readFileSync(target), rmSync, writeFileSync };
/** The real file system, but for the writes and removals of `target`, which `refuse` may throw for: it is told how many there have been. */
function refusing(target: string, refuse: (count: number) => Error | null): MutationFs & { tries: number } {
  const fs = {
    ...NODE_FS,
    tries: 0,
    writeFileSync(file: string, content: string | Uint8Array) { fs.gate(file); writeFileSync(file, content); },
    rmSync(file: string, options?: { force?: boolean }) { fs.gate(file); rmSync(file, options); },
    gate(file: string) {
      if (file !== target) return;
      fs.tries += 1;
      const error = refuse(fs.tries);
      if (error !== null) throw error;
    },
  };
  return fs;
}

describe('a file a run changes', () => {
  it('is remembered as the run found it, once, and put back byte for byte', () => {
    writeFileSync(at('a.ts'), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62]));
    const files = createMutationFiles();
    expect(files.read(at('a.ts'))?.toString('utf8')).toContain('a\r\nb');
    files.write(at('a.ts'), 'first edit');
    // A second edit of the same mutation reads the first, and the original stays the one first read.
    expect(files.read(at('a.ts'))?.toString('utf8')).toBe('first edit');
    files.write(at('a.ts'), 'second edit');
    expect(files.original(at('a.ts'))).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62]));
    expect(files.differing()).toEqual([at('a.ts')]);
    expect(files.restore()).toEqual([]);
    expect(readFileSync(at('a.ts'))).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62]));
    expect(files.differing()).toEqual([]);
  });

  it('is removed again where the run added it, and written again where the run removed it', () => {
    writeFileSync(at('kept.woff2'), 'a font');
    const files = createMutationFiles();
    expect(files.original(at('added.json'))).toBeNull();
    files.write(at('added.json'), '{}');
    files.remove(at('kept.woff2'));
    expect([existsSync(at('added.json')), existsSync(at('kept.woff2'))]).toEqual([true, false]);
    expect(files.differing().sort()).toEqual([at('added.json'), at('kept.woff2')]);
    expect(files.restore()).toEqual([]);
    expect([existsSync(at('added.json')), readFileSync(at('kept.woff2'), 'utf8')]).toEqual([false, 'a font']);
  });
});

describe('a file system that refuses for a moment', () => {
  it('is tried again after a pause, for each of the codes a busy one gives, and no pause is slept in a test', () => {
    expect(TRANSIENT_CODES).toEqual(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN', 'EAGAIN', 'EMFILE', 'ENFILE']);
    for (const code of TRANSIENT_CODES) {
      const paused: number[] = [];
      let calls = 0;
      expect(retrying(() => { calls += 1; if (calls < 4) throw refusal(code); return 'done'; }, { pause: (ms) => paused.push(ms) }), code).toBe('done');
      expect(paused, code).toEqual(RETRY_PAUSES_MS.slice(0, 3));
    }
  });

  it('is given up on at once for another error, and after the last pause for one that never lets go', () => {
    const paused: number[] = [];
    expect(() => retrying(() => { throw refusal('ENOENT'); }, { pause: (ms) => paused.push(ms) })).toThrow('ENOENT');
    expect(paused).toEqual([]);
    let calls = 0;
    expect(() => retrying(() => { calls += 1; throw refusal('EBUSY'); }, { pause: (ms) => paused.push(ms) })).toThrow('EBUSY');
    expect(calls).toBe(RETRY_PAUSES_MS.length + 1);
    expect(paused).toEqual([...RETRY_PAUSES_MS]);
  });

  it('puts a file back at the try that is let through: the refusal that left a flag out of a source file', () => {
    writeFileSync(at('session.ts'), "'--setting-sources=', '--strict-mcp-config',");
    // The mutation's own write is the first; the way back is refused twice, as `UNKNOWN: unknown error, open` was once.
    const fs = refusing(at('session.ts'), (count) => (count === 2 || count === 3 ? refusal('UNKNOWN') : null));
    const paused: number[] = [];
    const files = createMutationFiles({ fs, pause: (ms) => paused.push(ms) });
    files.write(at('session.ts'), "'--setting-sources=',");
    expect(files.restore()).toEqual([]);
    expect(readFileSync(at('session.ts'), 'utf8')).toBe("'--setting-sources=', '--strict-mcp-config',");
    expect(fs.tries).toBe(4);
    expect(paused).toEqual(RETRY_PAUSES_MS.slice(0, 2));
  });

  it('tries a mutation’s own write again too, and a write that never goes through leaves the file marked', () => {
    writeFileSync(at('a.ts'), 'as it was');
    const files = createMutationFiles({ fs: refusing(at('a.ts'), () => refusal('EPERM')), pause: () => undefined });
    expect(() => files.write(at('a.ts'), 'mutated')).toThrow('EPERM');
    // Nothing was written, and the file is still looked at on the way back: it is as it was.
    expect(files.differing()).toEqual([]);
  });
});

describe('the way back', () => {
  it('goes through every file though one cannot be put back, answers that one, and puts it back at a later try', () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(at(name), `${name} as it was`);
    let locked = true;
    const fs = refusing(at('b.ts'), (count) => (count > 1 && locked ? refusal('EBUSY') : null));
    const files = createMutationFiles({ fs, pause: () => undefined });
    for (const name of ['a.ts', 'b.ts', 'c.ts']) files.write(at(name), `${name} mutated`);
    expect(files.restore()).toEqual([at('b.ts')]);
    // The files after the one that failed are back all the same.
    expect(['a.ts', 'b.ts', 'c.ts'].map((name) => readFileSync(at(name), 'utf8'))).toEqual(['a.ts as it was', 'b.ts mutated', 'c.ts as it was']);
    expect(files.differing()).toEqual([at('b.ts')]);
    locked = false;
    expect(files.restore()).toEqual([]);
    expect(readFileSync(at('b.ts'), 'utf8')).toBe('b.ts as it was');
    expect(files.differing()).toEqual([]);
  });

  it('reads each file back: one that reads otherwise than it was after its write is not counted as put back', () => {
    writeFileSync(at('a.ts'), 'as it was');
    const fs: MutationFs = { ...NODE_FS, writeFileSync(target, content) { writeFileSync(target, typeof content === 'string' ? content : 'something else'); } };
    const files = createMutationFiles({ fs });
    files.write(at('a.ts'), 'mutated');
    expect(files.restore()).toEqual([at('a.ts')]);
    expect(files.differing()).toEqual([at('a.ts')]);
  });

  it('names what it could not put back, by its place in the tree', () => {
    expect(leftMutated([at('src/a.ts'), at('b.ts')], root).message).toBe('could not put back: src/a.ts, b.ts');
  });
});

describe('the end of a run', () => {
  it('says nothing and answers none where every file is as the run found it', () => {
    writeFileSync(at('a.ts'), 'as it was');
    const files = createMutationFiles();
    files.write(at('a.ts'), 'mutated');
    const said: string[] = [];
    // The mutation is still in place, as after an error thrown before the way back: the end puts it back itself.
    expect(settleTree(files, { root, log: (text) => said.push(text), rescueDirectory: at('rescue') })).toEqual([]);
    expect(said).toEqual([]);
    expect(readFileSync(at('a.ts'), 'utf8')).toBe('as it was');
    expect(existsSync(at('rescue'))).toBe(false);
  });

  it('names each file left mutated, loudly, and keeps a copy of what it was', () => {
    mkdirSync(at('src'));
    writeFileSync(at('src/session.ts'), 'as it was');
    const fs = refusing(at('src/session.ts'), (count) => (count > 1 ? refusal('UNKNOWN') : null));
    const files = createMutationFiles({ fs, pause: () => undefined });
    files.write(at('src/session.ts'), 'mutated');
    files.write(at('added.json'), '{}');
    rmSync(at('added.json'));
    writeFileSync(at('added.json'), 'put there by someone else since');
    const said: string[] = [];
    const left = settleTree(files, { root, log: (text) => said.push(text), rescueDirectory: at('rescue') });
    // The file that could not be written back; the added one was removed by the way back, and is as it was: not there.
    expect(left).toEqual([at('src/session.ts')]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('THE WORKING TREE IS LEFT MUTATED');
    expect(said[0]).toContain(`  src/session.ts  (as it was: ${path.join(at('rescue'), 'src__session.ts')})`);
    expect(said[0]).toContain('Put each back before anything is built, packaged or committed.');
    expect(readFileSync(path.join(at('rescue'), 'src__session.ts'), 'utf8')).toBe('as it was');
  });

  it('says of a file the run added, and could not remove, that it is to be deleted', () => {
    const fs = refusing(at('added.json'), (count) => (count > 1 ? refusal('EBUSY') : null));
    const files = createMutationFiles({ fs, pause: () => undefined });
    files.write(at('added.json'), '{}');
    const said: string[] = [];
    expect(settleTree(files, { root, log: (text) => said.push(text), rescueDirectory: at('rescue') })).toEqual([at('added.json')]);
    expect(said[0]).toContain('  added.json  (it was not there before: delete it)');
  });
});

describe('a script held to its tree', () => {
  /** A process as the guard needs one: its events, its exit code, and an exit that ends it as Node's does. */
  class FakeProcess extends EventEmitter {
    exitCode: number | undefined = undefined;
    exited: number[] = [];
    exit(code: number): void { this.exited.push(code); this.exitCode = code; this.emit('exit'); }
  }

  it('settles the tree at the process’s end, and fails it where a file is left mutated', () => {
    writeFileSync(at('a.ts'), 'as it was');
    const fs = refusing(at('a.ts'), (count) => (count > 1 ? refusal('EBUSY') : null));
    const files = createMutationFiles({ fs, pause: () => undefined });
    const target = new FakeProcess();
    const said: string[] = [];
    guardTree(files, { target, root, log: (text) => said.push(text), rescueDirectory: at('rescue') });
    files.write(at('a.ts'), 'mutated');
    target.exitCode = 0;
    target.emit('exit');
    expect(target.exitCode).toBe(1);
    expect(said).toHaveLength(1);
    // Once: an exit that comes again says nothing more.
    target.emit('exit');
    expect(said).toHaveLength(1);
  });

  it('leaves the exit code alone where the tree is as it was: a run that passed still passes', () => {
    writeFileSync(at('a.ts'), 'as it was');
    const files = createMutationFiles();
    const target = new FakeProcess();
    guardTree(files, { target, root, log: () => undefined, rescueDirectory: at('rescue') });
    files.write(at('a.ts'), 'mutated');
    target.exitCode = 0;
    target.emit('exit');
    expect(target.exitCode).toBe(0);
    expect(readFileSync(at('a.ts'), 'utf8')).toBe('as it was');
  });

  it('ends by the same way at an interrupt, a termination, a break and a hang-up, where the default would run nothing', () => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149], ['SIGHUP', 129]] as const) {
      writeFileSync(at('a.ts'), 'as it was');
      const files = createMutationFiles();
      const target = new FakeProcess();
      guardTree(files, { target, root, log: () => undefined, rescueDirectory: at('rescue') });
      files.write(at('a.ts'), 'mutated');
      target.emit(signal);
      expect(target.exited, signal).toEqual([code]);
      expect(readFileSync(at('a.ts'), 'utf8'), signal).toBe('as it was');
    }
  });

  it('lets the event loop turn between mutations, which is when a signal is heard', async () => {
    let heard = false;
    setImmediate(() => { heard = true; });
    await turn();
    expect(heard).toBe(true);
  });
});
