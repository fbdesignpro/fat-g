// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The files a mutation script changes, and their way back (scripts/verify-*-mutations.mjs).
//
// A mutation script breaks one safeguard in the working tree, runs a check that must turn red, and
// puts the tree back. The way back is the dangerous half: a write the file system refuses for a
// moment — a scanner, an indexer or a watcher holding the file — once left a launch flag removed
// from a source file, with nothing to say so. So here:
//
// - every file a run touches is remembered as it was when the run first read it;
// - a read, a write and a removal the file system refuses for a moment are tried again;
// - putting back goes through every file, whatever fails on the way, and reads each one back;
// - and a run cannot end — by its last line, an error or an interrupt — without the tree being
//   compared with what was read. A file that differs is named, loudly, its original bytes are kept
//   in the temporary folder, and the run fails.
//
// A process that is killed outright runs nothing: after one, look at `git diff` before building.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What a busy file system answers for a moment, on Windows above all. */
export const TRANSIENT_CODES = Object.freeze(['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN', 'EAGAIN', 'EMFILE', 'ENFILE']);
/** How long each further try waits: seven of them, a little over three seconds in all. */
export const RETRY_PAUSES_MS = Object.freeze([20, 50, 100, 200, 400, 800, 1600]);

/** A pause that holds the thread: the scripts are synchronous between their checks. */
const pauseSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const NODE_FS = { existsSync, readFileSync, rmSync, writeFileSync };
const same = (one, other) => (one === null || other === null ? one === other : one.equals(other));

/**
 * Does `action`, again after a pause where the file system refused it for a moment. Another error is
 * thrown at once, and the last of the transient ones once the pauses have run out.
 */
export function retrying(action, { pause = pauseSync, pauses = RETRY_PAUSES_MS } = {}) {
  for (let tries = 0; ; tries += 1) {
    try {
      return action();
    } catch (error) {
      if (tries >= pauses.length || !TRANSIENT_CODES.includes(error?.code)) throw error;
      pause(pauses[tries]);
    }
  }
}

/**
 * The files of one run. `fs`, `pause` and `pauses` are a test's: a script gives none.
 */
export function createMutationFiles({ fs = NODE_FS, pause = pauseSync, pauses = RETRY_PAUSES_MS } = {}) {
  /** Every file the run has touched, as it was when first read: its bytes, or null for one that was not there. */
  const originals = new Map();
  /** Those changed and not yet put back. */
  const changed = new Set();
  const again = (action) => retrying(action, { pause, pauses });
  const current = (target) => again(() => (fs.existsSync(target) ? fs.readFileSync(target) : null));

  const files = {
    /** A file as the run found it — its bytes, or null — read once and kept for the way back. */
    original(target) {
      if (!originals.has(target)) originals.set(target, current(target));
      return originals.get(target);
    },
    /** A file as it is now, an earlier edit of this mutation with it: its bytes, or null. */
    read(target) {
      files.original(target);
      return current(target);
    },
    /** Writes a mutation. The file is remembered first, and marked before the write: a write that fails half-way is still put back. */
    write(target, content) {
      files.original(target);
      changed.add(target);
      again(() => fs.writeFileSync(target, content));
    },
    /** Takes a file away, as a mutation. */
    remove(target) {
      files.original(target);
      changed.add(target);
      again(() => fs.rmSync(target));
    },
    /**
     * Puts back every file that was changed, each read back after it is written. A file that cannot
     * be put back does not stop the others: it stays marked, and is answered. Empty when all are back.
     */
    restore() {
      const failed = [];
      for (const target of [...changed]) {
        const bytes = originals.get(target);
        try {
          again(() => { if (bytes === null) fs.rmSync(target, { force: true }); else fs.writeFileSync(target, bytes); });
          if (same(current(target), bytes)) changed.delete(target);
          else failed.push(target);
        } catch {
          failed.push(target);
        }
      }
      return failed;
    },
    /** The files of this run that are not as it found them: one that cannot be read counts as one. */
    differing() {
      const left = [];
      for (const [target, bytes] of originals) {
        try {
          if (!same(current(target), bytes)) left.push(target);
        } catch {
          left.push(target);
        }
      }
      return left;
    },
    /** What the run found of a file it has touched: for whoever keeps a copy of one it could not put back. */
    kept(target) {
      return originals.get(target) ?? null;
    },
  };
  return files;
}

const RULE = '='.repeat(78);

/**
 * The end of a run: puts back whatever is still changed, compares every touched file with what was
 * read, and where one differs says so and keeps its original bytes under `rescueDirectory`. Answers
 * the files left mutated, their paths as given: none is the only good answer.
 */
export function settleTree(files, { root = process.cwd(), log = console.error, rescueDirectory = path.join(os.tmpdir(), 'fatg-mutation-originals', String(process.pid)), fs = { mkdirSync, writeFileSync } } = {}) {
  files.restore();
  const left = files.differing();
  if (left.length === 0) return left;
  const named = (target) => path.relative(root, target).split(path.sep).join('/');
  const lines = [RULE, 'THE WORKING TREE IS LEFT MUTATED. Not as this run found them:'];
  for (const target of left) {
    const bytes = files.kept(target);
    if (bytes === null) { lines.push(`  ${named(target)}  (it was not there before: delete it)`); continue; }
    const copy = path.join(rescueDirectory, named(target).replaceAll('/', '__'));
    try {
      fs.mkdirSync(rescueDirectory, { recursive: true });
      fs.writeFileSync(copy, bytes);
      lines.push(`  ${named(target)}  (as it was: ${copy})`);
    } catch {
      lines.push(`  ${named(target)}  (no copy of it could be kept)`);
    }
  }
  lines.push('Put each back before anything is built, packaged or committed.', RULE);
  log(lines.join('\n'));
  return left;
}

/** The signals that end a run from outside, and what each makes the process answer. */
const STOPS = Object.freeze({ SIGINT: 130, SIGTERM: 143, SIGBREAK: 149, SIGHUP: 129 });

/**
 * Holds a script to its tree. At the process's end — its last line, an error thrown, `process.exit`
 * — the tree is settled, and a file left mutated makes the process fail. A signal ends the run by
 * the same way, where the default would end it with nothing run at all.
 *
 * A signal is heard only when the script lets the event loop turn: a script awaits `turn()` between
 * its mutations, when nothing is changed. `target` is a test's: a script gives none.
 */
export function guardTree(files, { target = process, ...options } = {}) {
  let settled = false;
  target.on('exit', () => {
    if (settled) return;
    settled = true;
    if (settleTree(files, options).length > 0) target.exitCode = 1;
  });
  for (const [signal, code] of Object.entries(STOPS)) target.on(signal, () => { target.exit(code); });
}

/** Lets the event loop turn once: a signal that arrived during a check is heard here. */
export const turn = () => new Promise((resolve) => { setImmediate(resolve); });

/** Thrown where a mutation's files could not be put back: the run stops, and mutates nothing further. */
export function leftMutated(failed, root = process.cwd()) {
  return new Error(`could not put back: ${failed.map((target) => path.relative(root, target).split(path.sep).join('/')).join(', ')}`);
}
