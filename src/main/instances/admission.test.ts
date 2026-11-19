// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b, V5 and V23 (C37, C59, C72): what an added instance must pass each time it starts. The file
// system is a table: which folders are there, and where each really is.
import { describe, expect, it } from 'vitest';
import type { InstanceEntry } from '@shared/contracts/instances';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { FolderState, Lookups } from '../records/lookup';
import { admitInstance, createInstanceGuard, type InstanceGuardOptions } from './admission';
import type { FolderSurroundings } from './folders';

const support: InstanceSupport = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: [], prefixes: [] } };

interface Disk {
  /** Real paths; a path not listed is its own. */
  real?: Record<string, string>;
  /** How each folder answers; one not listed is there. */
  state?: Record<string, FolderState>;
}
function lookupsOf(disk: Disk = {}): Lookups & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    realpath: (path) => { asked.push(`realpath ${path}`); return Promise.resolve(disk.real?.[path] ?? path); },
    folder: (path) => { asked.push(`folder ${path}`); return Promise.resolve(disk.state?.[path] ?? 'present'); },
  };
}

const alone: FolderSurroundings = { others: [], defaultFolder: 'C:\\Users\\me\\.vendor', inheritedFolder: null, projects: [], dataFolder: 'C:\\Users\\me\\AppData\\Roaming\\fat-g' };

describe('admitInstance (C37, C59, C72)', () => {
  it('admits a folder that is there and breaks no rule', async () => {
    expect(await admitInstance('D:\\accounts\\work', alone, 'win32', lookupsOf())).toEqual({ kind: 'admitted' });
  });

  it('says a folder is missing when it is gone or is not a folder, before any rule', async () => {
    const lookups = lookupsOf({ state: { 'C:\\Users\\me\\.vendor': 'missing' } });
    // Even the default folder: what is true of a missing folder's path is not what the user needs to hear.
    expect(await admitInstance('C:\\Users\\me\\.vendor', alone, 'win32', lookups)).toEqual({ kind: 'folder-missing' });
    expect(lookups.asked).toEqual(['folder C:\\Users\\me\\.vendor']);
  });

  it('does not take silence for an answer: a check that does not answer admits nothing, and is not "missing" (C72)', async () => {
    const lookups = lookupsOf({ state: { 'N:\\share\\account': 'no-answer' } });
    expect(await admitInstance('N:\\share\\account', alone, 'win32', lookups)).toEqual({ kind: 'folder-unchecked' });
    expect(lookups.asked).toEqual(['folder N:\\share\\account']);
  });

  it('names the rule a folder fails', async () => {
    const surroundings = { ...alone, projects: [{ id: 'p1', roots: ['D:\\code\\app'] }] };
    expect(await admitInstance('D:\\code\\app\\.account', surroundings, 'win32', lookupsOf()))
      .toEqual({ kind: 'folder-refused', refusal: { rule: 'project', projectId: 'p1', relation: 'inside' } });
  });
});

describe('the guard, at each start (C59)', () => {
  const A = '00000001-0000-4000-8000-000000000000';
  const B = '00000002-0000-4000-8000-000000000000';
  const entry = (id: string, label: string, folder: string | null, extra: Partial<InstanceEntry> = {}): InstanceEntry => ({ key: id, id, label, folder, enabled: true, issue: null, ...extra });
  const guard = (options: Partial<InstanceGuardOptions> & { disk?: Disk } = {}) => {
    const { disk, ...rest } = options;
    const lookups = lookupsOf(disk);
    return {
      lookups,
      guard: createInstanceGuard({
        platform: 'win32', lookups, env: {}, home: 'C:\\Users\\me', dataFolder: 'C:\\Users\\me\\AppData\\Roaming\\fat-g',
        support: (providerId) => (providerId === 'vendor' ? support : undefined),
        instances: () => [entry(A, 'Work', 'D:\\accounts\\work'), entry(B, 'Side', 'D:\\accounts\\side')],
        projects: () => [{ id: 'p1', roots: ['D:\\code\\app'] }],
        ...rest,
      }),
    };
  };

  it('admits each instance whose folder is there and apart from everything else', async () => {
    const { guard: g } = guard();
    expect(await g.admit('vendor', A)).toEqual({ kind: 'admitted' });
    expect(await g.admit('vendor', B)).toEqual({ kind: 'admitted' });
  });

  it.each([
    ['a stored folder edited to the default folder', { instances: () => [entry(A, 'Work', 'D:\\accounts\\work'), entry(B, 'Side', 'C:\\Users\\me\\.vendor')] }, { rule: 'default-folder' }],
    ['a stored folder edited to lie inside a project', { instances: () => [entry(A, 'Work', 'D:\\accounts\\work'), entry(B, 'Side', 'D:\\code\\app\\.account')] }, { rule: 'project', projectId: 'p1', relation: 'inside' }],
    ['a link that now leads into a project', { disk: { real: { 'D:\\accounts\\side': 'D:\\code\\app\\linked' } } }, { rule: 'project', projectId: 'p1', relation: 'inside' }],
    ['a link that now leads to the data folder', { disk: { real: { 'D:\\accounts\\side': 'C:\\Users\\me\\AppData\\Roaming\\fat-g' } } }, { rule: 'data-folder', relation: 'same' }],
    ['a launch whose inherited variable names its folder', { env: { VENDOR_HOME: 'D:\\accounts\\side' } }, { rule: 'inherited-folder' }],
    ['a project added around it since', { projects: () => [{ id: 'p9', roots: ['D:\\accounts'] }] }, { rule: 'project', projectId: 'p9', relation: 'inside' }],
  ])('blocks that instance alone for %s, naming the rule', async (_name, options, refusal) => {
    const { guard: g } = guard(options);
    expect(await g.admit('vendor', B)).toEqual({ kind: 'folder-refused', refusal });
  });

  it('leaves the other instance running when one fails', async () => {
    const one = guard({ disk: { real: { 'D:\\accounts\\side': 'D:\\code\\app\\linked' } } }).guard;
    expect(await one.admit('vendor', A)).toEqual({ kind: 'admitted' });
    const gone = guard({ disk: { state: { 'D:\\accounts\\side': 'missing' } } }).guard;
    expect(await gone.admit('vendor', A)).toEqual({ kind: 'admitted' });
    expect(await gone.admit('vendor', B)).toEqual({ kind: 'folder-missing' });
    const silent = guard({ disk: { state: { 'D:\\accounts\\side': 'no-answer' } } }).guard;
    expect(await silent.admit('vendor', A)).toEqual({ kind: 'admitted' });
    expect(await silent.admit('vendor', B)).toEqual({ kind: 'folder-unchecked' });
  });

  it('of two entries that name one folder, runs the earlier and refuses the later', async () => {
    const { guard: g } = guard({ instances: () => [entry(A, 'Work', 'D:\\accounts\\work'), entry(B, 'Side', 'd:/accounts/WORK')], disk: { real: { 'd:/accounts/WORK': 'D:\\accounts\\work' } } });
    expect(await g.admit('vendor', A)).toEqual({ kind: 'admitted' });
    expect(await g.admit('vendor', B)).toEqual({ kind: 'folder-refused', refusal: { rule: 'other-instance', key: A } });
  });

  it('counts an earlier entry that cannot be used: its folder is still that account’s', async () => {
    const { guard: g } = guard({ instances: () => [entry(A, 'Work', 'D:\\accounts\\work', { issue: 'invalid-enabled' }), entry(B, 'Side', 'D:\\accounts\\work')] });
    expect(await g.admit('vendor', B)).toEqual({ kind: 'folder-refused', refusal: { rule: 'other-instance', key: A } });
  });

  it('has nothing to launch with for an entry it does not know, one with no folder, or a provider with no declaration', async () => {
    const { guard: g, lookups } = guard({ instances: () => [entry(A, 'Work', null, { issue: 'invalid-folder' })] });
    expect(await g.admit('vendor', A)).toEqual({ kind: 'folder-missing' });
    expect(await g.admit('vendor', B)).toEqual({ kind: 'folder-missing' });
    expect(await g.admit('plain', A)).toEqual({ kind: 'folder-missing' });
    expect(lookups.asked).toEqual([]);
  });

  it('judges a picked folder against every account of the provider, the last one included (C15)', async () => {
    const { guard: g } = guard();
    expect(await g.checkPicked('vendor', 'D:\\accounts\\new')).toBeNull();
    expect(await g.checkPicked('vendor', 'D:\\accounts\\side')).toEqual({ rule: 'other-instance', key: B });
    expect(await g.checkPicked('vendor', 'C:\\Users\\me\\.vendor')).toEqual({ rule: 'default-folder' });
    expect(await g.checkPicked('vendor', 'D:\\code')).toEqual({ rule: 'project', projectId: 'p1', relation: 'around' });
    expect(await g.checkPicked('vendor', 'C:\\Users\\me\\AppData\\Roaming\\fat-g\\accounts')).toEqual({ rule: 'data-folder', relation: 'inside' });
    // A provider that declares no instances has no account to pick a folder for.
    expect(await g.checkPicked('plain', 'D:\\code\\app')).toBeNull();
  });

  it('asks a folder only whether it is there and where it really is', async () => {
    const { guard: g, lookups } = guard();
    await g.admit('vendor', B);
    await g.checkPicked('vendor', 'D:\\accounts\\new');
    for (const asked of lookups.asked) expect(asked).toMatch(/^(folder|realpath) /);
    expect(lookups.asked.filter((asked) => asked.startsWith('folder '))).toEqual(['folder D:\\accounts\\side']);
  });
});
