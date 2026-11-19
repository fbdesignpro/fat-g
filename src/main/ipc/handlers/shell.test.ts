// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// M13 (C25, C59; V14, V19): the page names a registered provider or nothing at all — never an
// address, never a folder. Main opens what the provider's module and the data folder give.
//
// M19b (C23, C44, C45; V2, V6, V7): one channel takes an address a message wrote, and main hands it
// to the system's browser only as a parsed `http:` or `https:` URL with no credentials.
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readAddress } from '@shared/contracts/files';
import { nodeAvatarFs } from '../../avatars/fs';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { createKindCounts } from './counts';
import { checkAddress, shellHandlers, type ShellHandlerDeps } from './shell';

const log = () => ({ warn: vi.fn(), error: vi.fn() });
const deps = (logger = log()): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: logger, detail: 'kinds' });
type From = { readonly windowKind: 'main' | 'pet'; readonly sender: { readonly frameUrl: string; readonly isTopFrame: boolean } };
const MAIN: From = { windowKind: 'main', sender: { frameUrl: 'app://fatg/index.html', isTopFrame: true } };
const PET: From = { windowKind: 'pet', sender: { frameUrl: 'app://fatg/pet.html', isTopFrame: true } };
const GUIDES = new Map([['claude', 'https://code.claude.com/docs/en/setup'], ['codex', 'https://developers.openai.com/codex/cli']]);

function setup(overrides: Partial<ShellHandlerDeps> = {}) {
  const openExternal = vi.fn(async (_url: string) => undefined);
  const showDataFolder = vi.fn(async (_folder: 'plans' | 'avatars' | 'audio' | null) => '');
  const createAvatarsFolder = vi.fn(async () => undefined);
  const addresses = createKindCounts();
  const handlers = shellHandlers({ guides: GUIDES, openExternal, showDataFolder, createAvatarsFolder, addresses, platform: 'win32', ...overrides });
  const call = (channel: 'shell:openLink' | 'shell:openAddress' | 'shell:showDataFolder', request: unknown, from = MAIN, dispatch = deps()) =>
    dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as (request: unknown) => Promise<null>, { ...from, request }, dispatch);
  return { openExternal, showDataFolder, createAvatarsFolder, addresses, call };
}

describe('installation guides (C25)', () => {
  it.each([...GUIDES])('opens the guide the %s module gives', async (providerId, url) => {
    const h = setup();
    await expect(h.call('shell:openLink', { providerId })).resolves.toEqual({ ok: true, value: null });
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('refuses a provider that is not registered, before opening anything', async () => {
    const h = setup();
    await expect(h.call('shell:openLink', { providerId: 'gemini' })).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['an address', { providerId: 'https://evil.example' }],
    ['the old link id', { linkId: 'claude-installation' }],
    ['an empty id', { providerId: '' }],
    ['an id of 129 characters', { providerId: 'x'.repeat(129) }],
    ['a field beside the id', { providerId: 'claude', url: 'https://evil.example' }],
  ])('refuses %s', async (_name, request) => {
    const h = setup();
    expect((await h.call('shell:openLink', request)).ok).toBe(false);
    expect(h.openExternal).not.toHaveBeenCalled();
  });
});

describe('the data folder (C59)', () => {
  it('opens the folder main names, from a null request', async () => {
    const h = setup();
    await expect(h.call('shell:showDataFolder', null)).resolves.toEqual({ ok: true, value: null });
    expect(h.showDataFolder).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('opens the plans’ folder main names, from a request that names it (M22b, C75)', async () => {
    const h = setup();
    await expect(h.call('shell:showDataFolder', { folder: 'plans' })).resolves.toEqual({ ok: true, value: null });
    expect(h.showDataFolder).toHaveBeenCalledExactlyOnceWith('plans');
  });

  it.each([{ path: 'C:\\Windows' }, 'C:\\Windows', {}, { folder: 'attachments' }, { folder: 'avatars', path: 'C:\\Windows' }])('refuses the request %j: the page never names a folder', async (request) => {
    const h = setup();
    await expect(h.call('shell:showDataFolder', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.showDataFolder).not.toHaveBeenCalled();
    expect(h.createAvatarsFolder).not.toHaveBeenCalled();
  });

  // M102 (C40, C63; V18): the avatars' folder, which main makes empty where it is missing, then opens.
  it('makes the avatars’ folder, then opens the one main names; no other folder is made', async () => {
    const h = setup();
    const order: string[] = [];
    h.createAvatarsFolder.mockImplementation(async () => { order.push('create'); });
    h.showDataFolder.mockImplementation(async () => { order.push('open'); return ''; });
    await expect(h.call('shell:showDataFolder', { folder: 'avatars' })).resolves.toEqual({ ok: true, value: null });
    expect(order).toEqual(['create', 'open']);
    expect(h.showDataFolder).toHaveBeenCalledExactlyOnceWith('avatars');
    await h.call('shell:showDataFolder', null);
    await h.call('shell:showDataFolder', { folder: 'plans' });
    expect(h.createAvatarsFolder).toHaveBeenCalledOnce();
  });

  it('makes only an empty avatars/ in the data folder, and leaves one that is there as it is', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fatg-avatars-folder-'));
    try {
      const folder = path.join(dir, 'avatars');
      const h = setup({ createAvatarsFolder: () => nodeAvatarFs.createFolder(folder) });
      await h.call('shell:showDataFolder', { folder: 'avatars' });
      expect(readdirSync(dir)).toEqual(['avatars']);
      expect(statSync(folder).isDirectory()).toBe(true);
      expect(readdirSync(folder)).toEqual([]);
      await h.call('shell:showDataFolder', { folder: 'avatars' });
      expect(readdirSync(dir)).toEqual(['avatars']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers internal, opening nothing, when the avatars’ folder cannot be made', async () => {
    const h = setup({ createAvatarsFolder: vi.fn(async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }) });
    await expect(h.call('shell:showDataFolder', { folder: 'avatars' })).resolves.toEqual({ ok: false, error: 'internal' });
    expect(h.showDataFolder).not.toHaveBeenCalled();
  });

  it('answers internal when the OS could not open it, and logs its kind, never the message with the path', async () => {
    const logger = log();
    const h = setup({ showDataFolder: vi.fn(async () => 'Failed to open C:\\Users\\someone\\AppData\\Roaming\\fat-g') });
    await expect(h.call('shell:showDataFolder', null, MAIN, deps(logger))).resolves.toEqual({ ok: false, error: 'internal' });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('[ipc] shell:showDataFolder handler failed (Error)');
  });
});

describe('the Pet (S8)', () => {
  it.each([['shell:openLink', { providerId: 'codex' }], ['shell:openAddress', { address: 'https://example.com/' }], ['shell:showDataFolder', null]] as const)('is refused %s before the handler runs', async (channel, request) => {
    const h = setup();
    await expect(h.call(channel, request, PET)).resolves.toEqual({ ok: false, error: 'forbidden' });
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.showDataFolder).not.toHaveBeenCalled();
  });
});

// ── M19b: an address a message wrote ──────────────────────────────────────────────────────────
describe('an external address (M19b: V7; C23, C44, C45)', () => {
  it.each([
    ['https://example.com/docs', 'https://example.com/docs'],
    ['http://example.com', 'http://example.com/'],
    // The parsed URL's own spelling: the host folded, a space encoded, a default port dropped.
    ['HTTPS://EXAMPLE.com:443/a b?q=1#frag', 'https://example.com/a%20b?q=1#frag'],
    ['http://www.example.org/x/../y', 'http://www.example.org/y'],
    ['https://xn--exmple-cua.com/', 'https://xn--exmple-cua.com/'],
    ['https://exämple.com/', 'https://xn--exmple-cua.com/'],
    ['http://localhost:3000/', 'http://localhost:3000/'],
  ])('hands %s over as the parsed URL spells it, at once', async (address, href) => {
    const h = setup();
    await expect(h.call('shell:openAddress', { address })).resolves.toEqual({ ok: true, value: null });
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(href);
    expect(h.addresses.snapshot()).toEqual({});
  });

  it.each([
    ['a file: URL', 'file:///C:/Windows/system.ini', 'scheme'],
    ['a script', 'javascript:alert(1)', 'scheme'],
    ['data', 'data:text/html,<script>alert(1)</script>', 'scheme'],
    ['a share', 'smb://host/share/x', 'scheme'],
    ['mail', 'mailto:someone@example.com', 'scheme'],
    ['an unknown scheme', 'unknown-scheme:thing', 'scheme'],
    ['a scheme a program registered', 'ms-settings:privacy', 'scheme'],
    ['a drive path', 'C:\\Windows\\system.ini', 'scheme'],
    ['a user name', 'https://user@example.com/', 'credentials'],
    ['a user name and a password', 'https://user:secret@example.com/', 'credentials'],
    ['a relative path', 'docs/a.md', 'unparsable'],
    ['no host', 'https://', 'unparsable'],
    ['an address over the bound', `https://example.com/${'a'.repeat(2000)}`, 'too-long'],
  ])('refuses %s, counts it by kind, and hands nothing over', async (_name, address, why) => {
    const logger = log();
    const h = setup();
    await expect(h.call('shell:openAddress', { address }, MAIN, deps(logger))).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.addresses.snapshot()).toEqual({ [why]: 1 });
    // The log holds the channel and the window, and nothing of the address (V6).
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('[ipc] bad request on shell:openAddress from the main window');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('takes an address of exactly the bound', async () => {
    const h = setup();
    const address = `https://example.com/${'a'.repeat(2000 - 'https://example.com/'.length)}`;
    expect(address).toHaveLength(2000);
    await expect(h.call('shell:openAddress', { address })).resolves.toEqual({ ok: true, value: null });
    expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(address);
  });

  it.each([{ address: '' }, { url: 'https://example.com' }, { address: 'https://example.com', providerId: 'codex' }, 'https://example.com', null])('refuses the request %j before the handler runs', async (request) => {
    const h = setup();
    await expect(h.call('shell:openAddress', request)).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.addresses.snapshot()).toEqual({});
  });

  it('logs a failure of the system’s by its kind, never the address', async () => {
    const logger = log();
    const h = setup({ openExternal: vi.fn(async () => { throw new Error('Failed to open https://example.com/private-path'); }) });
    await expect(h.call('shell:openAddress', { address: 'https://example.com/private-path' }, MAIN, deps(logger))).resolves.toEqual({ ok: false, error: 'internal' });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('[ipc] shell:openAddress handler failed (Error)');
  });

  // V2 (C15): the page draws a control by the function main checks with, so the two cannot disagree.
  it.each(['win32', 'darwin', 'linux'])('refuses on %s whatever the page’s reader does not read as external, by the same answer', (platform) => {
    for (const address of ['https://example.com/', 'http://example.com/a', 'file:///x', 'javascript:alert(1)', 'mailto:a@example.com', 'C:/x.md', '/etc/hosts', 'README.md', '#top', 'https://']) {
      const external = readAddress(address, platform) === 'external';
      expect(checkAddress(address, platform).ok, `${address} on ${platform}`).toBe(external);
    }
  });

  it('leaves shell:openLink as it was: the page names a provider, and no address crosses it', async () => {
    const h = setup();
    expect((await h.call('shell:openLink', { providerId: 'https://example.com' })).ok).toBe(false);
    expect(h.openExternal).not.toHaveBeenCalled();
  });
});
