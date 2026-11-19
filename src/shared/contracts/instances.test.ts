// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { accountName, FIRST_INSTANCE_ID, MAX_INSTANCES, shownLabel, firstInstances, instanceKey, isAddedInstanceId, isInstanceId, loginCommand, loginCommandAt, loginShell, sameAccountAs, sameInstance } from './instances';

const ADDED = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';

describe('instance ids (M14b, C6, C10)', () => {
  it('knows the first instance by a fixed word and an added one by a UUID', () => {
    expect(isInstanceId(FIRST_INSTANCE_ID)).toBe(true);
    expect(isAddedInstanceId(FIRST_INSTANCE_ID)).toBe(false);
    expect(isInstanceId(ADDED)).toBe(true);
    expect(isAddedInstanceId(ADDED)).toBe(true);
    // A hand-edited id need not carry RFC 4122's version bits, as in the records file.
    expect(isAddedInstanceId('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it.each([
    ['another word', 'work'],
    ['the first id in another case', 'Default'],
    ['an empty string', ''],
    ['a UUID with something after it', `${ADDED}x`],
    ['a UUID without its hyphens', ADDED.replaceAll('-', '')],
    ['a number', 1],
    ['null', null],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(isInstanceId(value)).toBe(false);
    expect(isAddedInstanceId(value)).toBe(false);
  });

  it('allows eight instances a provider, the first included', () => {
    expect(MAX_INSTANCES).toBe(8);
  });

  it('names an instance by the pair: the same id under another provider is another instance', () => {
    expect(sameInstance({ providerId: 'a', instanceId: FIRST_INSTANCE_ID }, { providerId: 'a', instanceId: FIRST_INSTANCE_ID })).toBe(true);
    expect(sameInstance({ providerId: 'a', instanceId: FIRST_INSTANCE_ID }, { providerId: 'b', instanceId: FIRST_INSTANCE_ID })).toBe(false);
    expect(sameInstance({ providerId: 'a', instanceId: ADDED }, { providerId: 'a', instanceId: FIRST_INSTANCE_ID })).toBe(false);
    // Two spellings of one UUID are one id.
    expect(sameInstance({ providerId: 'a', instanceId: ADDED }, { providerId: 'a', instanceId: ADDED.toUpperCase() })).toBe(true);
  });
});

// M14b, V7 and V23 (C11, C68): the same account under two instances of one provider.
describe('the same account twice', () => {
  const side = (id: string, instanceId: string, account: { email?: string; organization?: string } | null) => ({ id, instanceId, account });
  const personal = side('codex', FIRST_INSTANCE_ID, { email: 'Someone@Example.test', organization: 'Org' });

  it.each([
    ['the same email in another letter case, the same organization', { email: 'someone@example.TEST', organization: 'Org' }, true],
    ['the same email and another organization', { email: 'someone@example.test', organization: 'Other' }, false],
    ['the same email, and an organization only one side reports', { email: 'someone@example.test' }, false],
    ['another email', { email: 'other@example.test', organization: 'Org' }, false],
    ['no email', { organization: 'Org' }, false],
    ['an empty email', { email: '', organization: 'Org' }, false],
    ['no account', null, false],
  ])('for %s: %j', (_name, account, same) => {
    const added = side('codex', ADDED, account);
    expect(sameAccountAs([personal, added], added)).toBe(same ? personal : null);
  });

  it('matches two sides that both report no organization, and does not compare the plan', () => {
    const first = { ...side('claude', FIRST_INSTANCE_ID, { email: 'me@example.test' }), plan: 'max' };
    const second = { ...side('claude', ADDED, { email: 'ME@example.test' }), plan: 'pro' };
    expect(sameAccountAs([first, second], second)).toBe(first);
  });

  it('says it on the later one only, about the earliest that matches, and never across providers', () => {
    const third = side('codex', '00000003-0000-4000-8000-000000000000', { email: 'someone@example.test', organization: 'Org' });
    const added = side('codex', ADDED, { email: 'someone@example.test', organization: 'Org' });
    const other = side('claude', FIRST_INSTANCE_ID, { email: 'someone@example.test', organization: 'Org' });
    const all = [other, personal, added, third];
    expect(sameAccountAs(all, personal)).toBeNull();
    expect(sameAccountAs(all, added)).toBe(personal);
    expect(sameAccountAs(all, third)).toBe(personal);
    expect(sameAccountAs(all, other)).toBeNull();
  });
});

describe('lists of instances', () => {
  it('gives one row a provider from the first instances, and a key that tells two of one provider apart', () => {
    const snapshots = [{ id: 'claude', instanceId: FIRST_INSTANCE_ID }, { id: 'codex', instanceId: FIRST_INSTANCE_ID }, { id: 'codex', instanceId: ADDED }];
    expect(firstInstances(snapshots)).toEqual(snapshots.slice(0, 2));
    expect(new Set(snapshots.map(instanceKey)).size).toBe(3);
  });
});

// M14b, V10 (C36): the login command for an added account, on a table of paths.
describe('the login command', () => {
  it('is written for PowerShell on Windows, and for a POSIX shell elsewhere', () => {
    expect(loginShell('win32')).toBe('powershell');
    for (const platform of ['darwin', 'linux', 'freebsd']) expect(loginShell(platform)).toBe('posix');
  });

  it.each([
    ['a plain path', 'D:\\accounts\\work', "$env:VENDOR_HOME = 'D:\\accounts\\work'; vendor login"],
    ['a path with spaces', 'C:\\Users\\Some One\\vendor work', "$env:VENDOR_HOME = 'C:\\Users\\Some One\\vendor work'; vendor login"],
    ['a single quote, doubled', "D:\\it's mine", "$env:VENDOR_HOME = 'D:\\it''s mine'; vendor login"],
    ['two single quotes, each doubled', "D:\\'a'", "$env:VENDOR_HOME = 'D:\\''a'''; vendor login"],
    // Inside single quotes PowerShell expands nothing: these stay as they are.
    ['a dollar, a backtick, a semicolon and a double quote', 'D:\\$env:X\\`n;"q"', "$env:VENDOR_HOME = 'D:\\$env:X\\`n;\"q\"'; vendor login"],
    ['a UNC path', '\\\\server\\share\\vendor', "$env:VENDOR_HOME = '\\\\server\\share\\vendor'; vendor login"],
  ])('quotes %s for PowerShell', (_name, folder, expected) => {
    expect(loginCommand('powershell', 'VENDOR_HOME', folder, 'vendor login')).toBe(expected);
  });

  it.each([
    ['a plain path', '/home/me/vendor-work', "VENDOR_HOME='/home/me/vendor-work' vendor login"],
    ['a path with spaces', '/Users/Some One/vendor work', "VENDOR_HOME='/Users/Some One/vendor work' vendor login"],
    ['a single quote: closed, escaped, opened again', "/home/me/it's mine", "VENDOR_HOME='/home/me/it'\\''s mine' vendor login"],
    ['two single quotes', "/srv/'a'", "VENDOR_HOME='/srv/'\\''a'\\''' vendor login"],
    // Inside single quotes a POSIX shell expands nothing: these stay as they are.
    ['a dollar, a backtick, a backslash, a semicolon and a double quote', '/srv/$HOME/`x`\\;"q"', "VENDOR_HOME='/srv/$HOME/`x`\\;\"q\"' vendor login"],
  ])('quotes %s for a POSIX shell', (_name, folder, expected) => {
    expect(loginCommand('posix', 'VENDOR_HOME', folder, 'vendor login')).toBe(expected);
  });

  it('runs the CLI by its quoted full path in place of its name, the rest of the command kept', () => {
    expect(loginCommandAt('powershell', "C:\\Users\\O'Neil\\Claude-Data\\claude.exe", 'claude auth login')).toBe("& 'C:\\Users\\O''Neil\\Claude-Data\\claude.exe' auth login");
    expect(loginCommandAt('posix', "/Applications/It's.app/codex", 'codex login')).toBe("'/Applications/It'\\''s.app/codex' login");
    expect(loginCommandAt('posix', '/opt/vendor', 'vendor')).toBe("'/opt/vendor'");
    expect(loginCommand('powershell', 'VENDOR_HOME', 'D:\\a', loginCommandAt('powershell', 'C:\\v.exe', 'vendor login'))).toBe("$env:VENDOR_HOME = 'D:\\a'; & 'C:\\v.exe' login");
  });

  it('keeps the command as the provider gives it, after the variable', () => {
    expect(loginCommand('posix', 'VENDOR_HOME', '/a', 'vendor auth login --device')).toBe("VENDOR_HOME='/a' vendor auth login --device");
    expect(loginCommand('powershell', 'VENDOR_HOME', 'C:\\a', 'vendor auth login --device')).toBe("$env:VENDOR_HOME = 'C:\\a'; vendor auth login --device");
  });
});

// M14b, V11 and V13 (C40, C41, C47): when an account is named by its label.
describe('the label an account is shown by', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const snapshot = (id: string, instanceId: string, label: string) => ({ id, instanceId, label });
  const two = [snapshot('claude', FIRST_INSTANCE_ID, 'Default'), snapshot('codex', FIRST_INSTANCE_ID, 'Personal'), snapshot('codex', WORK, 'Work')];

  it('is none for a provider with one instance configured, whatever its label', () => {
    expect(shownLabel(two, { providerId: 'claude', instanceId: FIRST_INSTANCE_ID })).toBeNull();
    expect(shownLabel([snapshot('codex', FIRST_INSTANCE_ID, 'Personal')], { providerId: 'codex', instanceId: FIRST_INSTANCE_ID })).toBeNull();
  });

  it('is each instance’s own for a provider with more than one, switched on or not', () => {
    expect(shownLabel(two, { providerId: 'codex', instanceId: FIRST_INSTANCE_ID })).toBe('Personal');
    expect(shownLabel(two, { providerId: 'codex', instanceId: WORK.toUpperCase() })).toBe('Work');
  });

  it('is none for an instance that is not configured, and for an entry with no label to show', () => {
    expect(shownLabel(two, { providerId: 'codex', instanceId: '11111111-2222-4333-8444-555555555555' })).toBeNull();
    expect(shownLabel([snapshot('codex', FIRST_INSTANCE_ID, 'Default'), snapshot('codex', WORK, '')], { providerId: 'codex', instanceId: WORK })).toBeNull();
    expect(shownLabel([], { providerId: 'codex', instanceId: FIRST_INSTANCE_ID })).toBeNull();
  });

  it('names an account by its provider, then its label when one shows', () => {
    expect(accountName('Codex', null)).toBe('Codex');
    expect(accountName('Codex', 'Work')).toBe('Codex · Work');
  });
});
