// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M19's traces share (M19, C1): M15's Codex runner and M16's Claude runner, each given M19's
// output folder and a driver that keeps the one delta kind the milestone reads, and the helpers
// that reduce a run's frames to counts, orders and sizes. Plain Node; nothing here is application code.
//
// Nothing a scenario notes is a text: a delta's size and its time, never its words. The captures
// hold the deltas, as the earlier captures hold the whole messages, and go through the same
// redaction and leak check (spikes/m10/publish.mjs).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { M15Driver } from '../../m15/lib/common.mjs';
import { M16Driver } from '../../m16/lib/common.mjs';
import { CLIENT_INFO } from '../../m10/codex/driver.mjs';
import { REPO_ROOT, SPIKES_DIR } from '../../m10/lib/paths.mjs';

export const M19_DIR = path.join(SPIKES_DIR, 'output', 'm19');

/** The delta a message's text comes in, on Codex. */
export const CODEX_TEXT_DELTA = 'item/agentMessage/delta';

/**
 * Production's eleven delta methods, read from the app's own module so that the handshake is the
 * app's and not a copy of it (src/main/providers/codex/methods.ts, DELTA_METHODS).
 */
export function productionDeltaMethods() {
  const source = readFileSync(path.join(REPO_ROOT, 'src', 'main', 'providers', 'codex', 'methods.ts'), 'utf8');
  const block = /DELTA_METHODS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(source)?.[1];
  const methods = block ? [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
  if (methods.length !== 11 || !methods.includes(CODEX_TEXT_DELTA)) throw new Error('DELTA_METHODS was not read from methods.ts as expected');
  return methods;
}

/** M15's driver with production's session handshake less the one opt-out, and that delta kept (C7). */
export class M19CodexDriver extends M15Driver {
  async open() {
    const table = this.table;
    // The other ten are still counted and dropped, as the recorder does: none is expected, since all are opted out.
    this.session.recorderOptions.isDelta = (frame) => table.isDelta(frame) && frame?.method !== CODEX_TEXT_DELTA;
    await this.startWire();
    this.session.recorder.deltas.requested = true;
    this.session.recorder.deltas.kept = [CODEX_TEXT_DELTA];
    this.optedOut = productionDeltaMethods().filter((method) => method !== CODEX_TEXT_DELTA);
    const reply = await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { optOutNotificationMethods: this.optedOut } }, 'startup');
    await this.session.send({ method: 'initialized' });
    return reply;
  }
}

/** M16's driver with every `stream_event` kept (C9, C10). */
export class M19ClaudeDriver extends M16Driver {
  async startWire() {
    this.session.recorderOptions.isDelta = () => false;
    await super.startWire();
    this.session.recorder.deltas.requested = true;
    this.session.recorder.deltas.kept = ['stream_event'];
  }
}

export const OMITTED_CODEX = ['the ten delta kinds the handshake opts out of (counted only)', 'usage readings'];
export const OMITTED_CLAUDE = ['usage readings'];

// ── Reductions: numbers and orders, never a text ───────────────────────────────────────────────
const round = (value) => Math.round(value * 10) / 10;

export function sizes(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return { count: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1), total: sorted.reduce((sum, value) => sum + value, 0) };
}

/** How a run of deltas came: their sizes in UTF-16 units, the gaps between them, and the rate over the run. */
export function deltaFacts(entries, textOf) {
  if (entries.length === 0) return { count: 0 };
  const units = entries.map((entry) => String(textOf(entry.frame) ?? '').length);
  const gaps = entries.slice(1).map((entry, index) => entry.ms - entries[index].ms);
  const span = entries.at(-1).ms - entries[0].ms;
  const total = units.reduce((sum, value) => sum + value, 0);
  return { count: entries.length, units: sizes(units), gapMs: sizes(gaps.map(round)), spanMs: round(span), unitsPerSecond: span > 0 ? round((total / span) * 1000) : null, firstAtMs: entries[0].ms, lastAtMs: entries.at(-1).ms };
}

/** Received frames from `from` on. */
export const received = (driver, from = 0) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
