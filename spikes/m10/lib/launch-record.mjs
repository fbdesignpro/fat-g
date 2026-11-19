// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The launch record (C62): spikes/output/m10/launched.json names the processes a spike launched,
// written before the spawn, after it, and at each recording, and removed once the tree is confirmed
// gone. A spike ended from outside runs no handler, and Windows leaves a killed parent's children
// running; the next spike finds the record and stops. It never ends anything itself, because a
// recorded pid may since belong to another program.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { descendants, listProcesses, survivors } from './proctree.mjs';
import { outputPath, writeJson } from './paths.mjs';

export const LAUNCH_RECORD = outputPath('launched.json');
const FORMAT = 'fat-g.launch-record/1';

export class RecordedProcessRunning extends Error {
  constructor(processes) {
    super(`a process recorded by an earlier spike still runs: ${processes.map(describe).join(', ')}`);
    this.name = 'RecordedProcessRunning';
    this.processes = processes;
  }
}

export const describe = (p) => `${p.name || '?'} (pid ${p.pid}${p.start ? `, started ${p.start}` : ''})`;

/**
 * Run by every launching script before anything else. Resolves `{ status: 'none' | 'stale-cleared' }`
 * or throws RecordedProcessRunning (exit 4) or ListingFailed (cannot confirm: exit 3).
 */
export async function checkLaunchRecord({ file = LAUNCH_RECORD, lister = listProcesses } = {}) {
  if (!existsSync(file)) return { status: 'none' };
  let record;
  try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { record = null; }
  const recorded = Array.isArray(record?.processes) ? record.processes.filter((p) => Number.isInteger(p?.pid)) : [];
  if (recorded.length > 0) {
    const listing = await lister();
    const alive = [...survivors(recorded, listing), ...descendants(recorded, listing)];
    if (alive.length > 0) throw new RecordedProcessRunning(alive);
  }
  rmSync(file, { force: true });
  return { status: 'stale-cleared', spike: record?.spike ?? null, phase: record?.phase ?? null };
}

/** One tree's record. Only processes the spike launched are ever written (C67). */
export class LaunchRecord {
  constructor(spike, file = LAUNCH_RECORD) {
    this.file = file;
    this.data = { format: FORMAT, spike, phase: 'idle', updatedAt: null, processes: [] };
  }

  #write(phase) {
    this.data.phase = phase;
    this.data.updatedAt = new Date().toISOString();
    writeJson(this.file, this.data);
  }

  beforeSpawn(expectedName) {
    this.data.processes = [];
    this.data.expectedName = expectedName;
    this.#write('spawning');
  }

  /** Right after spawn: pid and the image name we expect, before any listing fills the start time. */
  afterSpawn(pid, name) {
    this.data.processes = [{ pid, ppid: process.pid, start: null, name, role: 'root' }];
    this.#write('spawned');
  }

  /** Replaces the list with the tree as last recorded. */
  recorded(processes) {
    this.data.processes = processes.map(({ pid, ppid, start, name, role }) => ({ pid, ppid, start, name, role: role ?? 'descendant' }));
    this.#write('recorded');
  }

  clear() { rmSync(this.file, { force: true }); }
}
