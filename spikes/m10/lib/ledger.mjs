// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The run ledger: one entry per tracing run, so a retry (a new invocation) knows its number, the
// three-run cap of C24 and the two-void cap of C64 hold across invocations, and every turn spent is
// counted, void runs included.
import { existsSync, readFileSync } from 'node:fs';
import { outputPath, writeJson } from './paths.mjs';

export const LEDGER = outputPath('ledger.json');
const FORMAT = 'fat-g.run-ledger/1';
export const MAX_RUNS = 3;
export const MAX_VOID = 2;
/** Outcomes that count among the three runs. */
const COUNTED = new Set(['happened', 'did-not-happen', 'timed-out', 'cli-cannot', 'cancelled', 'interrupted']);

export class RunCapReached extends Error {
  constructor(message) { super(message); this.name = 'RunCapReached'; }
}

export class Ledger {
  constructor(file = LEDGER) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { format: FORMAT, runs: [] };
    if (this.data.format !== FORMAT) throw new Error('unknown ledger format');
  }

  save() { writeJson(this.file, this.data); }

  runsFor(cli, scenario, variant = 'default') {
    return this.data.runs.filter((r) => r.cli === cli && r.scenario === scenario && r.variant === variant);
  }

  /**
   * Opens a run, or throws RunCapReached. A run left "in progress" by an invocation ended from
   * outside is closed as "interrupted" first; its turns stay counted.
   */
  open(cli, scenario, { variant = 'default', again = false } = {}) {
    for (const run of this.data.runs) {
      if (run.status === 'in-progress') { run.status = 'interrupted'; run.closedAt = new Date().toISOString(); }
    }
    const runs = this.runsFor(cli, scenario, variant);
    const counted = runs.filter((r) => COUNTED.has(r.status)).length;
    const voids = runs.filter((r) => r.status === 'void').length;
    if (voids >= MAX_VOID) throw new RunCapReached(`${cli} ${scenario}: ${voids} void runs; stop and report (C64)`);
    if (counted >= MAX_RUNS) throw new RunCapReached(`${cli} ${scenario}: ${counted} runs made; the cap is ${MAX_RUNS} (C24)`);
    if (!again && runs.some((r) => r.status === 'happened')) throw new RunCapReached(`${cli} ${scenario}: already happened; pass --again to run it once more`);
    const run = {
      id: `${cli}-${scenario}${variant === 'default' ? '' : `-${variant}`}-${this.data.runs.length + 1}`,
      cli, scenario, variant, number: counted + 1, attempt: runs.length + 1,
      status: 'in-progress', turns: 0, wait: null, defect: null, capture: null,
      openedAt: new Date().toISOString(), closedAt: null,
    };
    this.data.runs.push(run);
    this.save();
    return run;
  }

  /** Called as each prompt goes out, so a crash never hides a spent turn. */
  countTurn(run) { run.turns++; this.save(); }

  close(run, fields) {
    Object.assign(run, fields, { closedAt: new Date().toISOString() });
    this.save();
  }

  /** A run spoiled by the spike's own defect (C64). It leaves the three; its turns stay counted. */
  markVoid(id, defect) {
    const run = this.data.runs.find((r) => r.id === id);
    if (!run) throw new Error(`no run ${id}`);
    run.status = 'void';
    run.defect = defect;
    run.number = null;
    this.save();
    return run;
  }

  turnsSpent() { return this.data.runs.reduce((sum, r) => sum + r.turns, 0); }
}
