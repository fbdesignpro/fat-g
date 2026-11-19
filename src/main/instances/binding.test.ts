// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b, V21 (C61, C62): the folder a session's account had when it started, against the one its
// instance has now. The file system is a table: where each folder really is, or that it gives no answer.
import { describe, expect, it } from 'vitest';
import type { InstanceRef } from '@shared/contracts/instances';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { Lookups } from '../records/lookup';
import { createFolderBinding, instanceFolders, sameFolder } from './binding';

const support: InstanceSupport = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: [], prefixes: [] } };
const FIRST: InstanceRef = { providerId: 'vendor', instanceId: 'default' };
const WORK: InstanceRef = { providerId: 'vendor', instanceId: '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19' };
const HOME = 'C:\\Users\\me';
const DEFAULT = 'C:\\Users\\me\\.vendor';

/** Real paths; a path not listed is its own, and one listed as null gives no answer. */
function lookupsOf(real: Record<string, string | null> = {}): Pick<Lookups, 'realpath'> & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    realpath: (path) => {
      asked.push(path);
      return Promise.resolve(path in real ? real[path] ?? null : path);
    },
  };
}

const foldersOf = (env: Record<string, string | undefined>, added: Record<string, string> = {}, platform = 'win32', home = HOME) =>
  instanceFolders({ platform, env, home, support: (providerId) => (providerId === 'vendor' ? support : undefined), added: (ref) => added[ref.instanceId] ?? null });

describe('the folder an instance has now (C61)', () => {
  it.each<[string, Record<string, string | undefined>, string]>([
    ['the declared default under the home folder, with the variable unset', {}, DEFAULT],
    ['the folder the inherited variable names', { VENDOR_HOME: 'D:\\accounts\\personal' }, 'D:\\accounts\\personal'],
    ['the same, as a root is stored: no trailing separator, the platform’s own', { VENDOR_HOME: 'D:/accounts/personal/' }, 'D:\\accounts\\personal'],
    ['the same under another letter case of the variable’s name, as Windows reads it', { vendor_home: 'D:\\accounts\\personal' }, 'D:\\accounts\\personal'],
    ['the default, when the variable names no absolute path', { VENDOR_HOME: 'accounts\\personal' }, DEFAULT],
    ['the default, when the variable is empty', { VENDOR_HOME: '' }, DEFAULT],
  ])('is, for the first instance, %s', (_name, env, expected) => {
    expect(foldersOf(env)(FIRST)).toBe(expected);
  });

  it('is, for the first instance on another OS, that OS’s path', () => {
    expect(foldersOf({}, {}, 'linux', '/home/me')(FIRST)).toBe('/home/me/.vendor');
    expect(foldersOf({ VENDOR_HOME: '/srv/vendor/' }, {}, 'linux', '/home/me')(FIRST)).toBe('/srv/vendor');
    // Names are exact off Windows: another letter case is another variable.
    expect(foldersOf({ vendor_home: '/srv/vendor' }, {}, 'linux', '/home/me')(FIRST)).toBe('/home/me/.vendor');
  });

  it('is, for an added instance, its stored folder, whatever the inherited variable names', () => {
    const folderOf = foldersOf({ VENDOR_HOME: 'D:\\accounts\\personal' }, { [WORK.instanceId]: 'D:\\accounts\\work\\' });
    expect(folderOf(WORK)).toBe('D:\\accounts\\work');
  });

  it('is none for an instance the preferences do not hold, and for a provider that declares no instances', () => {
    expect(foldersOf({})(WORK)).toBeNull();
    expect(foldersOf({})({ providerId: 'other', instanceId: 'default' })).toBeNull();
    expect(foldersOf({}, { [WORK.instanceId]: 'relative\\path' })(WORK)).toBeNull();
  });
});

describe('two folders as one (C62; M12, C78)', () => {
  it('needs no lookup for one spelling', async () => {
    const lookups = lookupsOf();
    expect(await sameFolder(DEFAULT, DEFAULT, 'win32', lookups)).toBe(true);
    expect(lookups.asked).toEqual([]);
  });

  it.each<[string, string, string, Record<string, string | null>, string, boolean]>([
    ['two spellings the file system reports as one folder', 'D:\\Accounts\\Work', 'D:\\accounts\\work', { 'D:\\Accounts\\Work': 'D:\\accounts\\work' }, 'win32', true],
    ['a link that leads to the other folder', 'D:\\links\\work', 'D:\\accounts\\work', { 'D:\\links\\work': 'D:\\accounts\\work' }, 'win32', true],
    ['two folders', 'D:\\accounts\\work', 'D:\\accounts\\personal', {}, 'win32', false],
    ['one spelling in two letter cases that a case-sensitive folder keeps apart', '/srv/Vendor', '/srv/vendor', {}, 'linux', false],
    ['a link that now leads elsewhere', 'D:\\links\\work', 'D:\\accounts\\work', { 'D:\\links\\work': 'D:\\accounts\\other' }, 'win32', false],
    // With no answer, the stored paths under the OS's usual rules.
    ['two letter cases on Windows, with no answer', 'D:\\Accounts\\Work', 'D:\\accounts\\work', { 'D:\\Accounts\\Work': null, 'D:\\accounts\\work': null }, 'win32', true],
    ['two separators on Windows, with one side giving no answer', 'D:/accounts/work', 'D:\\accounts\\work', { 'D:/accounts/work': null }, 'win32', true],
    ['two letter cases on Linux, with no answer', '/srv/Vendor', '/srv/vendor', { '/srv/Vendor': null, '/srv/vendor': null }, 'linux', false],
    ['two folders, with no answer', 'D:\\accounts\\work', 'D:\\accounts\\personal', { 'D:\\accounts\\work': null, 'D:\\accounts\\personal': null }, 'win32', false],
  ])('judges %s', async (_name, a, b, real, platform, expected) => {
    expect(await sameFolder(a, b, platform, lookupsOf(real))).toBe(expected);
  });
});

describe('a session’s folder against its instance’s (C62)', () => {
  const bindingOf = (env: Record<string, string | undefined>, added: Record<string, string> = {}, real: Record<string, string | null> = {}) => {
    const lookups = lookupsOf(real);
    return { lookups, binding: createFolderBinding({ platform: 'win32', lookups, folderOf: foldersOf(env, added) }) };
  };

  it('gives the folder to store with a reference: the one the instance has now', () => {
    const { binding } = bindingOf({ VENDOR_HOME: 'D:\\accounts\\personal' }, { [WORK.instanceId]: 'D:\\accounts\\work' });
    expect(binding.current(FIRST)).toBe('D:\\accounts\\personal');
    expect(binding.current(WORK)).toBe('D:\\accounts\\work');
  });

  // A session started with the variable naming D:\accounts\personal, then fat-g launched again.
  it.each<[string, Record<string, string | undefined>, Record<string, string | null>, 'bound' | 'moved']>([
    ['with the variable changed', { VENDOR_HOME: 'D:\\accounts\\other' }, {}, 'moved'],
    ['with the variable unset', {}, {}, 'moved'],
    ['with the variable set again as it was', { VENDOR_HOME: 'D:\\accounts\\personal' }, {}, 'bound'],
    ['with the variable naming the same folder another way', { VENDOR_HOME: 'D:/Accounts/Personal/' }, { 'D:\\Accounts\\Personal': 'D:\\accounts\\personal' }, 'bound'],
    ['with the variable naming a link to it', { VENDOR_HOME: 'D:\\links\\me' }, { 'D:\\links\\me': 'D:\\accounts\\personal' }, 'bound'],
  ])('reads a first-instance session, relaunched %s, as %s', async (_name, env, real, expected) => {
    const { binding } = bindingOf(env, {}, real);
    expect(await binding.check(FIRST, 'D:\\accounts\\personal')).toBe(expected);
    expect(binding.last(FIRST, 'D:\\accounts\\personal')).toBe(expected);
  });

  it('reads a session started in the default folder as moved once the variable names another, and bound without it', async () => {
    expect(await bindingOf({ VENDOR_HOME: 'D:\\accounts\\other' }).binding.check(FIRST, DEFAULT)).toBe('moved');
    expect(await bindingOf({}).binding.check(FIRST, DEFAULT)).toBe('bound');
  });

  it('reads an added instance’s session as moved once its stored folder was edited, and bound when it was not', async () => {
    expect(await bindingOf({}, { [WORK.instanceId]: 'D:\\accounts\\edited' }).binding.check(WORK, 'D:\\accounts\\work')).toBe('moved');
    expect(await bindingOf({}, { [WORK.instanceId]: 'D:\\accounts\\work' }).binding.check(WORK, 'D:\\accounts\\work')).toBe('bound');
  });

  it('never holds a session that stored no folder: it has no reference, and starts wherever its instance points', async () => {
    const { binding, lookups } = bindingOf({ VENDOR_HOME: 'D:\\accounts\\other' });
    expect(await binding.check(FIRST, null)).toBe('bound');
    expect(binding.last(FIRST, null)).toBe('bound');
    expect(lookups.asked).toEqual([]);
  });

  it('says nothing until a comparison has answered, and remembers the answer', async () => {
    const { binding, lookups } = bindingOf({ VENDOR_HOME: 'D:\\accounts\\other' });
    expect(binding.last(FIRST, 'D:\\accounts\\personal')).toBe('unknown');
    const first = binding.check(FIRST, 'D:\\accounts\\personal');
    // Asked twice at once: one comparison.
    const second = binding.check(FIRST, 'D:\\accounts\\personal');
    expect(binding.last(FIRST, 'D:\\accounts\\personal')).toBe('unknown');
    expect(await Promise.all([first, second])).toEqual(['moved', 'moved']);
    expect(lookups.asked).toHaveLength(2);
    expect(binding.last(FIRST, 'D:\\accounts\\personal')).toBe('moved');
    // One spelling needs no comparison at all.
    expect(binding.last(FIRST, 'D:\\accounts\\other')).toBe('bound');
  });

  it('forgets every answer on a reset, and keeps none that was asked before it', async () => {
    const real: Record<string, string | null> = { 'D:\\links\\me': 'D:\\accounts\\personal' };
    const { binding } = bindingOf({ VENDOR_HOME: 'D:\\links\\me' }, {}, real);
    expect(await binding.check(FIRST, 'D:\\accounts\\personal')).toBe('bound');
    // The link is led elsewhere; a comparison asked before the reset must not come back as the answer.
    const stale = binding.check(FIRST, 'D:\\accounts\\personal');
    real['D:\\links\\me'] = 'D:\\accounts\\other';
    binding.reset();
    await stale;
    expect(binding.last(FIRST, 'D:\\accounts\\personal')).toBe('unknown');
    expect(await binding.check(FIRST, 'D:\\accounts\\personal')).toBe('moved');
    expect(binding.last(FIRST, 'D:\\accounts\\personal')).toBe('moved');
  });

  it('has nothing to compare for an instance that is not configured: that holds its sessions by itself', async () => {
    const { binding, lookups } = bindingOf({});
    expect(await binding.check(WORK, 'D:\\accounts\\work')).toBe('unknown');
    expect(binding.last(WORK, 'D:\\accounts\\work')).toBe('unknown');
    expect(lookups.asked).toEqual([]);
  });
});
