// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Launching a CLI and confirming its whole tree gone (C59–C62, Design 1). No npm dependency.
//
// Confirmed gone means all of: the root's exit event fired; its output pipes closed; and a listing
// taken after the last kill holds no recorded process and no process whose parent is one.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEADLINES, TEARDOWN, settlesWithin, sleep } from './deadlines.mjs';
import { LaunchRecord, describe } from './launch-record.mjs';
import { ListingFailed, descendants, forceEnd, listProcesses, sameProcess, survivors } from './proctree.mjs';

const isWin = process.platform === 'win32';

/** The app's own rule for shims: cmd.exe re-parses these, so a launch holding one is refused. */
const SHIM_UNSAFE = /[%!"&|<>^()\r\n]/;

export class LaunchRefused extends Error {
  constructor(reason, processes = []) {
    super(processes.length ? `${reason}: ${processes.map(describe).join(', ')}` : reason);
    this.name = 'LaunchRefused';
    this.processes = processes;
  }
}

function quoteForShim(arg) {
  if (arg === '') return '""';
  return /[\s]/.test(arg) ? `"${arg}"` : arg;
}

function comspec() {
  return process.env.ComSpec ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
}

/**
 * One launcher per spike invocation. It refuses a launch until the tree before it is confirmed
 * gone (C61), and keeps the launch record (C62) current.
 */
export class Launcher {
  constructor({ spike, lister = listProcesses, record, waits = DEADLINES, log = () => {} }) {
    this.spike = spike;
    this.lister = lister;
    this.record = record ?? new LaunchRecord(spike);
    this.waits = waits;
    this.log = log;
    this.previous = null;
  }

  /** Throws LaunchRefused while an earlier tree of this launcher is not confirmed gone. */
  async #gate() {
    const prev = this.previous;
    if (!prev || prev.cleanup?.confirmed) return;
    if (!prev.cleanup) throw new LaunchRefused('the previous tree has not been torn down');
    let listing;
    try { listing = await this.lister(); } catch (error) {
      throw new LaunchRefused(`the previous tree cannot be confirmed gone (${error.message})`, prev.cleanup.remaining);
    }
    const recorded = [...prev.entries.values()];
    const alive = [...survivors(recorded, listing), ...descendants(recorded, listing)];
    if (alive.length > 0) throw new LaunchRefused('the previous tree is not confirmed gone', alive);
    prev.cleanup = { ...prev.cleanup, confirmed: true, remaining: [], confirmedLater: true };
    this.record.clear();
  }

  /**
   * `executable` is `{ path, kind }` from resolveExecutable. Returns a Tree once spawned; a spawn
   * error surfaces through `tree.spawnError` and `tree.exited`.
   */
  async launch({ executable, args, cwd, env }) {
    await this.#gate();
    if (!path.isAbsolute(executable.path) || !path.isAbsolute(cwd)) throw new LaunchRefused('paths must be absolute');
    if ([executable.path, cwd, ...args].some((v) => v.includes('\0'))) throw new LaunchRefused('a NUL in a path or argument');
    let file;
    let argv;
    const options = { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: !isWin };
    if (executable.kind === 'shim') {
      if (!isWin) throw new LaunchRefused('a shim launch is Windows only');
      if ([executable.path, ...args].some((v) => SHIM_UNSAFE.test(v))) throw new LaunchRefused('a shim argument holds a character cmd.exe would re-parse');
      file = comspec();
      argv = ['/d', '/s', '/c', `"${[`"${executable.path}"`, ...args.map(quoteForShim)].join(' ')}"`];
      options.windowsVerbatimArguments = true;
    } else {
      file = executable.path;
      argv = [...args];
    }
    const imageName = path.basename(file);
    this.record.beforeSpawn(imageName);
    const tree = new Tree(this, file, argv, options, imageName);
    this.previous = tree;
    if (tree.pid === undefined) {
      // Nothing was launched: there is no tree to confirm.
      tree.cleanup = { confirmed: true, remaining: [], spawnFailed: true };
      this.record.clear();
    } else {
      this.record.afterSpawn(tree.pid, imageName);
    }
    return tree;
  }
}

export class Tree {
  constructor(launcher, file, argv, options, imageName) {
    this.launcher = launcher;
    this.spawnedAt = Date.now();
    this.entries = new Map();
    this.recordings = [];
    this.cleanup = null;
    this.exitInfo = null;
    this.closeInfo = null;
    this.spawnError = null;
    let resolveExit;
    let resolveClose;
    this.exited = new Promise((resolve) => { resolveExit = resolve; });
    this.closed = new Promise((resolve) => { resolveClose = resolve; });
    try {
      this.child = spawn(file, argv, options);
    } catch (error) {
      this.spawnError = error.code ?? 'spawn failed';
      this.child = null;
      resolveExit({ code: null, signal: null, spawnError: this.spawnError });
      resolveClose({ code: null, signal: null });
      this.exitInfo = { code: null, signal: null };
      this.closeInfo = this.exitInfo;
      return;
    }
    this.pid = this.child.pid;
    this.child.on('error', (error) => {
      this.spawnError ??= error.code ?? 'spawn error';
      if (this.pid === undefined) {
        this.exitInfo ??= { code: null, signal: null };
        this.closeInfo ??= this.exitInfo;
        resolveExit({ ...this.exitInfo, spawnError: this.spawnError });
        resolveClose(this.closeInfo);
      }
    });
    this.child.on('exit', (code, signal) => { this.exitInfo = { code, signal }; resolveExit(this.exitInfo); });
    this.child.on('close', (code, signal) => {
      this.closeInfo = { code, signal };
      this.exitInfo ??= this.closeInfo;
      resolveExit(this.exitInfo);
      resolveClose(this.closeInfo);
    });
    this.child.stdin.on('error', () => {});
    this.child.stdout.on('error', () => {});
    this.child.stderr.on('error', () => {});
    // Stderr is always drained. Its size is kept, and a short tail for the raw output and the
    // redacted capture (an error may appear only there).
    this.stderrBytes = 0;
    this.stderrTail = '';
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrBytes += Buffer.byteLength(chunk);
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });
    if (this.pid !== undefined) this.entries.set(this.pid, { pid: this.pid, ppid: process.pid, start: null, name: imageName, role: 'root' });
  }

  get stdin() { return this.child?.stdin; }
  get stdout() { return this.child?.stdout; }
  get stderr() { return this.child?.stderr; }
  get rootExited() { return this.exitInfo !== null; }
  get pipesClosed() { return this.closeInfo !== null; }
  elapsed() { return Date.now() - this.spawnedAt; }

  /**
   * Records the tree (Design 1, step 1): the root and every descendant. Fills the root's start
   * time from the first listing that still shows it. Throws ListingFailed.
   */
  async record(moment) {
    if (this.pid === undefined) return [];
    const listing = await this.launcher.lister();
    const root = this.entries.get(this.pid);
    const current = listing.get(this.pid);
    if (root.start === null && current && sameProcess(root, current)) root.start = current.start;
    for (const found of descendants([...this.entries.values()], listing)) {
      if (!this.entries.has(found.pid)) this.entries.set(found.pid, { ...found, role: 'descendant' });
    }
    const snapshot = [...this.entries.values()];
    this.launcher.record.recorded(snapshot);
    this.recordings.push({ moment, atMs: this.elapsed(), images: snapshot.map((p) => p.name), alive: snapshot.filter((p) => sameProcess(p, listing.get(p.pid))).length });
    return snapshot;
  }

  /** Best effort: a recording that fails is noted, not fatal; teardown's own listings decide. */
  async tryRecord(moment) {
    try { return await this.record(moment); } catch (error) {
      this.recordings.push({ moment, atMs: this.elapsed(), failed: error instanceof ListingFailed ? error.message : String(error) });
      return null;
    }
  }

  /**
   * The same teardown on every path (Design 1). `interrupt` is the protocol's own interrupt, sent
   * only when `turnActive`. Resolves the cleanup state; never throws. Idempotent.
   */
  teardown({ turnActive = false, interrupt } = {}) {
    this.teardownPromise ??= this.#teardown(turnActive, interrupt);
    return this.teardownPromise;
  }

  async #teardown(turnActive, interrupt) {
    const waits = this.launcher.waits;
    const started = Date.now();
    const deadline = started + waits.shutdown;
    const left = () => Math.max(0, deadline - Date.now());
    const state = { confirmed: false, graceful: false, interrupted: false, forced: false, expiredWait: null, remaining: [], listingFailures: 0, ms: 0 };
    if (this.pid === undefined) {
      this.cleanup = { ...state, confirmed: true, spawnFailed: true };
      return this.cleanup;
    }
    // 1. Record the tree before closing stdin.
    await this.tryRecord('before-close');
    // 2. Interrupt an active turn with the protocol's own request.
    if (turnActive && interrupt && !this.rootExited) {
      state.interrupted = await settlesWithin(Promise.resolve().then(interrupt), Math.min(TEARDOWN.interruptGrace, left()));
    }
    // 3. Close stdin and give the root a moment to exit by itself: closing first protects the
    //    user's CLI data from a kill in the middle of a write.
    try { this.child.stdin.end(); } catch { /* already closed */ }
    state.graceful = this.rootExited || await settlesWithin(this.exited, Math.min(TEARDOWN.stdinGrace, left()));
    if (!state.graceful) state.expiredWait = 'shutdown';
    // 4. End whatever is left: the root's tree, then each recorded process still alive.
    if (!this.rootExited) {
      state.forced = true;
      await forceEnd(this.pid, { tree: true, timeoutMs: Math.min(5_000, left() || 1) });
    }
    // 5. List again until clean or out of time. An unrecorded descendant found here is recorded,
    //    ended, and the listing repeated.
    for (;;) {
      let listing = null;
      try { listing = await this.launcher.lister(); } catch { state.listingFailures++; }
      if (listing) {
        const recorded = [...this.entries.values()];
        const alive = survivors(recorded, listing);
        const late = descendants(recorded, listing).filter((p) => !this.entries.has(p.pid));
        for (const p of late) this.entries.set(p.pid, { ...p, role: 'descendant' });
        if (late.length) this.launcher.record.recorded([...this.entries.values()]);
        const targets = [...alive, ...late];
        if (targets.length === 0) {
          if (!this.pipesClosed) await settlesWithin(this.closed, Math.min(1_000, left()));
          if (this.rootExited && this.pipesClosed) { state.confirmed = true; break; }
        } else {
          state.forced = true;
          for (const p of targets) {
            // Re-check identity right before the kill: a pid may have been reused since.
            if (p.pid === this.pid || sameProcess(p, listing.get(p.pid))) await forceEnd(p.pid, { tree: true, timeoutMs: Math.min(5_000, left() || 1) });
          }
        }
        state.remaining = targets;
      }
      if (left() <= 0) break;
      await sleep(Math.min(250, left()));
    }
    if (!state.confirmed) {
      state.expiredWait = 'shutdown';
      if (!this.rootExited || !this.pipesClosed) state.remaining = [...new Map([...state.remaining, this.entries.get(this.pid)].map((p) => [p.pid, p])).values()];
    } else {
      state.remaining = [];
      this.launcher.record.clear();
    }
    state.ms = Date.now() - started;
    state.recorded = [...this.entries.values()].map((p) => ({ name: p.name, role: p.role }));
    // Leave the pipes flowing so their close is later evidence; a confirmed tree has nothing left.
    try { this.child.stdout.resume(); this.child.stderr.resume(); } catch { /* destroyed */ }
    this.cleanup = state;
    return state;
  }
}
