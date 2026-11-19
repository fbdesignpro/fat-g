// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// followRecords: the records view in the app state, with each root's missing mark (M12, C28, C29, C52).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderState, Lookups } from '../records/lookup';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore } from '../records/store';
import { createAppStateStore } from './app-state-store';
import { followRecords } from './records';

const ID = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-follow-'));
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({
    schemaVersion: RECORDS_VERSION,
    minReaderVersion: RECORDS_VERSION,
    projects: [{ id: ID, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: 'D:\\here' }, { path: 'D:\\gone' }] }],
  }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setUp(states: Record<string, FolderState>) {
  const records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  const store = createAppStateStore();
  const later: (() => void)[] = [];
  const folder = vi.fn((root: string) => Promise.resolve(states[root] ?? 'present'));
  const lookups: Lookups = { realpath: () => Promise.resolve(null), folder };
  const follower = followRecords({ records, store, lookups, later: (run) => later.push(run) });
  const runLater = async () => {
    for (const run of later.splice(0)) run();
    await vi.waitFor(() => expect(folder).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { records, store, follower, folder, runLater };
}

describe('followRecords', () => {
  it('puts the view in the app state at once, with nothing marked missing before a check', () => {
    const { store } = setUp({ 'D:\\gone': 'missing' });
    expect(store.getSnapshot().records).toEqual({
      status: { kind: 'ok', keptAs: null },
      projects: [expect.objectContaining({ id: ID, roots: [{ path: 'D:\\here', trust: null, missing: false }, { path: 'D:\\gone', trust: null, missing: false }] })],
    });
  });

  it('checks the roots at start, on a later turn, and marks the missing one', async () => {
    const { store, folder, runLater } = setUp({ 'D:\\gone': 'missing' });
    expect(folder).not.toHaveBeenCalled();
    await runLater();
    const [entry] = store.getSnapshot().records?.projects ?? [];
    expect(entry?.kind === 'project' && entry.roots.map((root) => root.missing)).toEqual([false, true]);
  });

  it('checks again after each change, and when asked', async () => {
    const { records, follower, folder, runLater } = setUp({});
    await runLater();
    folder.mockClear();
    await records.setHidden(ID, true);
    await runLater();
    expect(folder.mock.calls.map(([root]) => root).sort()).toEqual(['D:\\gone', 'D:\\here']);
    folder.mockClear();
    follower.checkRoots(['D:\\here']);
    await runLater();
    expect(folder.mock.calls).toEqual([['D:\\here']]);
  });

  // M15 (V55; C30, C126): the gate reads the mark, and is told when it changes with no other event.
  it('answers whether a root is missing, and tells its listeners when a mark changes', async () => {
    const states: Record<string, FolderState> = { 'D:\\gone': 'missing' };
    const { follower, runLater } = setUp(states);
    const told = vi.fn();
    const stop = follower.onMissingChanged(told);
    expect(follower.isMissing('D:\\gone')).toBe(false);
    await runLater();
    expect(follower.isMissing('D:\\gone')).toBe(true);
    expect(follower.isMissing('D:\\here')).toBe(false);
    expect(told).toHaveBeenCalled();

    // The folder comes back: the mark lifts at the next check, and the listener hears of it.
    told.mockClear();
    states['D:\\gone'] = 'present';
    follower.checkRoots(['D:\\gone']);
    await runLater();
    expect(follower.isMissing('D:\\gone')).toBe(false);
    expect(told).toHaveBeenCalled();

    // Stopped: it hears nothing more.
    told.mockClear();
    stop();
    states['D:\\gone'] = 'missing';
    follower.checkRoots(['D:\\gone']);
    await runLater();
    expect(follower.isMissing('D:\\gone')).toBe(true);
    expect(told).not.toHaveBeenCalled();
  });
});
