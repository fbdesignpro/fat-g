// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b, V5 (C4, C15, C61): the first instance's folder and the folder rules, on a table per OS.
// The file system is a table of real paths: nothing here touches a disk.
import { describe, expect, it, vi } from 'vitest';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { Lookups } from '../records/lookup';
import { checkInstanceFolder, defaultFolder, firstFolder, inheritedFolder, type FolderSurroundings } from './folders';

const support: InstanceSupport = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: [], prefixes: [] } };

/** Lookups that answer from a table of real paths; a path not in it answers itself, and `silent` ones do not answer. */
function tableLookups(real: Record<string, string> = {}, silent: readonly string[] = []): Lookups & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    realpath: (path) => { asked.push(path); return Promise.resolve(silent.includes(path) ? null : real[path] ?? path); },
    folder: () => Promise.resolve('present'),
  };
}

describe('the first instance’s folder (C4, C61)', () => {
  it.each([
    ['win32', 'C:\\Users\\me', {}, 'C:\\Users\\me\\.vendor'],
    ['linux', '/home/me', {}, '/home/me/.vendor'],
    ['darwin', '/Users/me', {}, '/Users/me/.vendor'],
    // The inherited variable moves it, when it names an absolute folder.
    ['win32', 'C:\\Users\\me', { VENDOR_HOME: 'D:\\vendor\\' }, 'D:\\vendor'],
    ['win32', 'C:\\Users\\me', { vendor_home: 'D:/vendor' }, 'D:\\vendor'],
    ['linux', '/home/me', { VENDOR_HOME: '/srv/vendor/' }, '/srv/vendor'],
    // Another letter case is another variable off Windows.
    ['linux', '/home/me', { vendor_home: '/srv/vendor' }, '/home/me/.vendor'],
    // A value that is not an absolute folder is not one the default can be told from.
    ['win32', 'C:\\Users\\me', { VENDOR_HOME: 'vendor' }, 'C:\\Users\\me\\.vendor'],
    ['linux', '/home/me', { VENDOR_HOME: '' }, '/home/me/.vendor'],
    ['linux', '/home/me', { VENDOR_HOME: undefined }, '/home/me/.vendor'],
  ])('%s, home %s, environment %j: %s', (platform, home, env, expected) => {
    expect(firstFolder(support, env, home, platform)).toBe(expected);
  });

  it('takes the canonical spelling when Windows holds the variable twice, as a child would', () => {
    expect(inheritedFolder(support, { vendor_home: 'D:\\lower', VENDOR_HOME: 'D:\\upper' }, 'win32')).toBe('D:\\upper');
  });

  it('keeps the two apart: the default is the documented folder whatever the environment says', () => {
    expect(defaultFolder(support, 'C:\\Users\\me', 'win32')).toBe('C:\\Users\\me\\.vendor');
    expect(inheritedFolder(support, {}, 'win32')).toBeNull();
    expect(defaultFolder({ ...support, defaultFolder: ['.config', 'vendor'] }, '/home/me', 'linux')).toBe('/home/me/.config/vendor');
  });
});

describe('the folder rules (C15)', () => {
  const windows: FolderSurroundings = {
    others: [{ key: 'one', folder: 'D:\\accounts\\one' }, { key: 'two', folder: 'D:\\accounts\\two' }],
    defaultFolder: 'C:\\Users\\me\\.vendor',
    inheritedFolder: 'E:\\moved',
    projects: [{ id: 'p1', roots: ['D:\\code\\app'] }, { id: 'p2', roots: ['D:\\code\\site', 'F:\\'] }],
    dataFolder: 'C:\\Users\\me\\AppData\\Roaming\\fat-g',
  };
  const posix: FolderSurroundings = {
    others: [{ key: 'one', folder: '/accounts/one' }],
    defaultFolder: '/home/me/.vendor',
    inheritedFolder: '/srv/moved',
    projects: [{ id: 'p1', roots: ['/code/app'] }],
    dataFolder: '/home/me/.config/fat-g',
  };

  it.each([
    ['a folder of its own', 'D:\\accounts\\three', null],
    ['a folder beside a project', 'D:\\code\\other', null],
    ['a folder inside another account’s, which is not that folder', 'D:\\accounts\\one\\inner', null],
    // Around the default folder alone it would pass; the home folder is also around the data folder.
    ['the home folder', 'C:\\Users\\me', { rule: 'data-folder', relation: 'around' }],
    ['another account’s folder', 'D:\\accounts\\two', { rule: 'other-instance', key: 'two' }],
    ['another account’s folder in another letter case, with other separators', 'd:/ACCOUNTS/One', { rule: 'other-instance', key: 'one' }],
    ['the default folder', 'C:\\Users\\me\\.vendor', { rule: 'default-folder' }],
    ['the folder the inherited variable names', 'E:\\Moved', { rule: 'inherited-folder' }],
    ['a project’s root', 'D:\\code\\app', { rule: 'project', projectId: 'p1', relation: 'same' }],
    ['a folder inside a project’s root', 'D:\\code\\site\\.accounts\\work', { rule: 'project', projectId: 'p2', relation: 'inside' }],
    ['a folder around a project’s root', 'D:\\code', { rule: 'project', projectId: 'p1', relation: 'around' }],
    ['a folder on a drive that is a project’s root', 'F:\\accounts', { rule: 'project', projectId: 'p2', relation: 'inside' }],
    ['the data folder', 'C:\\Users\\me\\AppData\\Roaming\\fat-g', { rule: 'data-folder', relation: 'same' }],
    ['a folder inside the data folder', 'C:\\Users\\me\\AppData\\Roaming\\fat-g\\accounts', { rule: 'data-folder', relation: 'inside' }],
    ['a folder around the data folder', 'C:\\Users\\me\\AppData', { rule: 'data-folder', relation: 'around' }],
  ])('on Windows, %s: %j', async (_name, folder, expected) => {
    // No real path answers, so the stored paths are compared under Windows' usual rules (C78).
    expect(await checkInstanceFolder(folder, windows, 'win32', tableLookups({}, [folder, ...windows.others.map((o) => o.folder), 'C:\\Users\\me\\.vendor', 'E:\\moved', 'D:\\code\\app', 'D:\\code\\site', 'F:\\', windows.dataFolder]))).toEqual(expected);
  });

  it.each([
    ['linux', '/accounts/two', null],
    ['linux', '/accounts/one', { rule: 'other-instance', key: 'one' }],
    // Letter case tells folders apart on Linux, and not on macOS.
    ['linux', '/Accounts/One', null],
    ['darwin', '/Accounts/One', { rule: 'other-instance', key: 'one' }],
    ['linux', '/home/me/.vendor', { rule: 'default-folder' }],
    ['linux', '/srv/moved', { rule: 'inherited-folder' }],
    ['linux', '/code/app/accounts', { rule: 'project', projectId: 'p1', relation: 'inside' }],
    ['linux', '/code', { rule: 'project', projectId: 'p1', relation: 'around' }],
    ['linux', '/home/me/.config/fat-g/x', { rule: 'data-folder', relation: 'inside' }],
    ['linux', '/', { rule: 'project', projectId: 'p1', relation: 'around' }],
  ])('on %s, %s: %j', async (platform, folder, expected) => {
    const silent = [folder, '/accounts/one', '/home/me/.vendor', '/srv/moved', '/code/app', '/home/me/.config/fat-g'];
    expect(await checkInstanceFolder(folder, posix, platform, tableLookups({}, silent))).toEqual(expected);
  });

  it('refuses the first instance’s folder itself, and not a folder inside or around it', async () => {
    const surroundings: FolderSurroundings = { others: [{ key: 'one', folder: '/accounts/one' }], defaultFolder: '/home/me/.vendor', inheritedFolder: '/srv/moved', projects: [], dataFolder: '/var/fat-g' };
    for (const folder of ['/home/me', '/home/me/.vendor/second', '/srv', '/srv/moved/second', '/accounts', '/accounts/one/inner']) {
      expect(await checkInstanceFolder(folder, surroundings, 'linux', tableLookups()), folder).toBeNull();
    }
  });

  it('answers the first rule that fails, in the order of C15', async () => {
    // One folder that is another account's, the default folder, the inherited one, a project's root and the data folder at once.
    const all = (surroundings: Partial<FolderSurroundings>) => checkInstanceFolder('/x', {
      others: [], defaultFolder: null, inheritedFolder: null, projects: [], dataFolder: '/elsewhere', ...surroundings,
    }, 'linux', tableLookups());
    const everything = { others: [{ key: 'k', folder: '/x' }], defaultFolder: '/x', inheritedFolder: '/x', projects: [{ id: 'p', roots: ['/x'] }], dataFolder: '/x' };
    expect(await all(everything)).toEqual({ rule: 'other-instance', key: 'k' });
    expect(await all({ ...everything, others: [] })).toEqual({ rule: 'default-folder' });
    expect(await all({ ...everything, others: [], defaultFolder: null })).toEqual({ rule: 'inherited-folder' });
    expect(await all({ ...everything, others: [], defaultFolder: null, inheritedFolder: null })).toEqual({ rule: 'project', projectId: 'p', relation: 'same' });
    expect(await all({ ...everything, others: [], defaultFolder: null, inheritedFolder: null, projects: [] })).toEqual({ rule: 'data-folder', relation: 'same' });
    expect(await all({})).toBeNull();
  });

  it('judges on the real paths when both answer: a link to another account’s folder, to a project and to the default folder is that folder', async () => {
    const real = { 'D:\\links\\to-one': 'D:\\accounts\\one', 'D:\\links\\into-app': 'D:\\code\\app\\nested', 'D:\\links\\home': 'C:\\Users\\me\\.vendor' };
    expect(await checkInstanceFolder('D:\\links\\to-one', windows, 'win32', tableLookups(real))).toEqual({ rule: 'other-instance', key: 'one' });
    expect(await checkInstanceFolder('D:\\links\\into-app', windows, 'win32', tableLookups(real))).toEqual({ rule: 'project', projectId: 'p1', relation: 'inside' });
    expect(await checkInstanceFolder('D:\\links\\home', windows, 'win32', tableLookups(real))).toEqual({ rule: 'default-folder' });
    // And the other way: a project whose stored root is a link that leads around the folder.
    const moved = { 'D:\\code\\app': 'D:\\accounts' };
    expect(await checkInstanceFolder('D:\\accounts\\three', windows, 'win32', tableLookups(moved))).toEqual({ rule: 'project', projectId: 'p1', relation: 'inside' });
  });

  it('lets the filesystem’s own spelling decide: two spellings the OS reports as two folders are two', async () => {
    // A case-sensitive folder on Windows: the stored paths differ only by case, and the real ones differ too.
    const lookups = tableLookups({ 'D:\\accounts\\one': 'D:\\accounts\\one', 'D:\\accounts\\ONE': 'D:\\accounts\\ONE' });
    expect(await checkInstanceFolder('D:\\accounts\\ONE', windows, 'win32', lookups)).toBeNull();
  });

  it('falls back on the stored paths for a folder that has gone missing or whose drive does not answer', async () => {
    // The candidate's real path does not answer: it is still refused as the folder another account names.
    expect(await checkInstanceFolder('D:\\ACCOUNTS\\one', windows, 'win32', tableLookups({}, ['D:\\ACCOUNTS\\one']))).toEqual({ rule: 'other-instance', key: 'one' });
    // The other side does not answer: the same.
    expect(await checkInstanceFolder('D:\\code\\APP\\x', windows, 'win32', tableLookups({}, ['D:\\code\\app']))).toEqual({ rule: 'project', projectId: 'p1', relation: 'inside' });
  });

  it('asks each folder for its real path once, and for nothing else', async () => {
    const lookups = tableLookups();
    const folder = vi.spyOn(lookups, 'folder');
    await checkInstanceFolder('D:\\accounts\\three', { ...windows, others: [...windows.others, { key: 'again', folder: 'D:\\accounts\\one' }] }, 'win32', lookups);
    expect(lookups.asked.slice().sort()).toEqual([...new Set(lookups.asked)].sort());
    expect(lookups.asked).toHaveLength(9);
    expect(folder).not.toHaveBeenCalled();
  });
});
