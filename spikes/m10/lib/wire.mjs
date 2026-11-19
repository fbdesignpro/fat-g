// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One launched CLI speaking JSON lines: launch, decode, record, and wait for frames under a named
// deadline. The Claude, Codex and stand-in drivers are built on it.
import { Cancelled, DeadlineExpired } from './deadlines.mjs';
import { decodeLines, writeFrame } from './lines.mjs';
import { Recorder } from './recorder.mjs';

export class CliExited extends Error {
  constructor(info) {
    super(`the CLI exited (code ${info?.code ?? 'none'}${info?.spawnError ? `, ${info.spawnError}` : ''})`);
    this.name = 'CliExited';
    this.info = info;
  }
}

export class WireSession {
  /**
   * `launcher`: a Launcher. `executable`, `args`, `cwd`, `env`: the launch. `waits`: the four
   * deadlines. `signal`: cancellation. `isDelta`/`typeOf`: for the recorder. `transform(frame)`:
   * applied to every received frame before anything keeps it (the config/read reduction of C53).
   */
  constructor({ launcher, executable, args, cwd, env, waits, signal, isDelta, typeOf, transform = (f) => f }) {
    Object.assign(this, { launcher, executable, args, cwd, env, waits, signal, transform });
    this.recorderOptions = { isDelta, typeOf };
    this.waiters = new Set();
    this.listeners = new Set();
    this.tree = null;
    this.ended = null;
  }

  async start() {
    this.tree = await this.launcher.launch({ executable: this.executable, args: this.args, cwd: this.cwd, env: this.env });
    this.recorder = new Recorder({ ...this.recorderOptions, clock: () => this.tree.elapsed() });
    if (this.tree.spawnError || !this.tree.child) {
      this.ended = { code: null, spawnError: this.tree.spawnError ?? 'spawn failed' };
      return this;
    }
    decodeLines(this.tree.stdout, (raw) => {
      const frame = this.transform(raw);
      const index = this.recorder.record('recv', frame);
      for (const listener of this.listeners) listener(frame, index);
      for (const waiter of [...this.waiters]) {
        if (index === null && !waiter.includeDeltas) continue;
        let hit = false;
        try { hit = waiter.predicate(frame, index); } catch { hit = false; }
        if (hit) { this.waiters.delete(waiter); waiter.resolve({ frame, index }); }
      }
    }, { onGarbage: (text) => this.recorder.garbage(text) });
    const end = () => {
      if (this.ended) return;
      this.ended = this.tree.exitInfo ?? { code: null };
      for (const waiter of [...this.waiters]) { this.waiters.delete(waiter); waiter.reject(new CliExited(this.ended)); }
    };
    this.tree.closed.then(end);
    // A descendant can hold the pipes open after the root exits; give the last frames a moment to
    // arrive, then stop waiting on a CLI that is gone.
    this.tree.exited.then(() => { setTimeout(end, 750).unref?.(); });
    // Record the tree once before the handshake, while nothing has been asked of the CLI yet: a
    // shim's intermediate process that dies right after the handshake would otherwise never be
    // recorded, and a child it left holding the pipes could not be found (Design 1, known limit).
    await this.tree.tryRecord('after-spawn');
    return this;
  }

  /** Every received frame, as it arrives (after the transform). */
  onFrame(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async send(frame) {
    if (this.ended) throw new CliExited(this.ended);
    const index = this.recorder.record('send', frame);
    try {
      await writeFrame(this.tree.stdin, frame);
    } catch {
      // A write to a CLI that has gone is the CLI exiting, not a defect in the spike.
      throw new CliExited(this.tree.exitInfo ?? { code: null });
    }
    return index;
  }

  /**
   * Resolves `{ frame, index }` for the first received frame (from `fromIndex` on, already received
   * ones included) that satisfies `predicate`. Rejects DeadlineExpired naming `wait`, Cancelled, or
   * CliExited.
   */
  waitFor(predicate, { wait, ms = wait === 'startup' ? Math.max(1, this.waits.startup - (this.tree?.elapsed() ?? 0)) : this.waits[wait], fromIndex = 0 } = {}) {
    for (const { index, dir, frame } of this.recorder.frames) {
      if (dir === 'recv' && index >= fromIndex && predicate(frame, index)) return Promise.resolve({ frame, index });
    }
    if (this.ended) return Promise.reject(new CliExited(this.ended));
    return new Promise((resolve, reject) => {
      const waiter = { predicate: (frame, index) => index !== null && index >= fromIndex && predicate(frame, index) };
      const cleanup = () => { clearTimeout(timer); this.signal?.removeEventListener('abort', onAbort); this.waiters.delete(waiter); };
      waiter.resolve = (value) => { cleanup(); resolve(value); };
      waiter.reject = (error) => { cleanup(); reject(error); };
      const onAbort = () => waiter.reject(new Cancelled(this.signal.reason ?? 'aborted'));
      const timer = setTimeout(() => waiter.reject(new DeadlineExpired(wait, ms)), ms);
      if (this.signal?.aborted) { onAbort(); return; }
      this.signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  get frames() { return this.recorder?.frames ?? []; }
  get nextIndex() { return this.recorder?.frames.length ?? 0; }

  teardown(options) { return this.tree ? this.tree.teardown(options) : Promise.resolve({ confirmed: true, remaining: [], notLaunched: true }); }
}
