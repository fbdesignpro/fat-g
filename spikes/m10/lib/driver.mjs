// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What every CLI driver shares. A driver offers open, prompt, interrupt, setEffort, setModel,
// onRequest and close (M10 "Boundaries and files"); scenarios see only that and the spike-internal
// events below, never a process or a wire format. A third provider is a new driver folder.
//
// Events (spike-internal, not the app's normalized events):
//   turn-start, turn-end {status}, tool-call {name, worker}, worker-start, worker-end,
//   request {requestKind: approval | question | permissions | other, tool}, effort {value},
//   model {value}, error, auto-review
import { CliExited, WireSession } from './wire.mjs';

export class Driver {
  constructor({ table, launcher, executable, args, cwd, env, waits, signal, transform }) {
    this.table = table;
    this.waits = waits;
    this.cwd = cwd;
    this.args = args;
    this.session = new WireSession({ launcher, executable, args, cwd, env, waits, signal, isDelta: table.isDelta, typeOf: table.typeKey, transform });
    this.requestHandler = null;
    this.turnActive = false;
    this.requestsSeen = [];
  }

  /** The handler answers requests the CLI makes (approvals, questions). Returns a decision object. */
  onRequest(handler) { this.requestHandler = handler; }

  async startWire() {
    await this.session.start();
    if (this.session.ended) throw new CliExited(this.session.ended);
    this.session.onFrame((frame, index) => {
      if (index === null) return;
      for (const event of this.derive(frame, index)) if (event.kind === 'turn-end' && event.main !== false) this.turnActive = false;
      this.incoming(frame, index);
    });
  }

  /** Events a frame stands for. Pure: called again by waitEvent. */
  derive() { return []; }

  /** Reacts to a frame the CLI sent (answers its requests). */
  incoming() {}

  /** Resolves the first event from frame `from` on that satisfies `predicate`. */
  async waitEvent(predicate, { wait, ms, from = 0 } = {}) {
    let found = null;
    await this.session.waitFor((frame, index) => {
      found = this.derive(frame, index).find(predicate) ?? null;
      return found !== null;
    }, { wait, ms, fromIndex: from });
    return found;
  }

  events(from = 0) {
    return this.session.frames.filter((f) => f.dir === 'recv' && f.index >= from).flatMap((f) => this.derive(f.frame, f.index));
  }

  get nextIndex() { return this.session.nextIndex; }
  get tree() { return this.session.tree; }
  record(moment) { return this.session.tree?.tryRecord(moment); }

  close() {
    return this.session.teardown({ turnActive: this.turnActive, interrupt: () => this.interrupt().catch(() => {}) });
  }
}
