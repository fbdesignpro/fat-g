// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { constrainEnvironment, createEnvironment, instanceEnvironment, mergeEnvironment, sanitizeEnv, withheldPresent } from './env';
describe('provider environment constraints', () => {
  const constraints = { removePrefixes: ['VENDOR_'], keepNames: ['VENDOR_CONFIG_DIR'], keepPrefixes: ['VENDOR_USE_'], removeNames: ['DEBUG', 'VENDOR_USE_DEBUG', 'PARENTMARK'] };
  it('drops prefixed session keys but keeps reviewed settings, proxies and unrelated keys', () => {
    const input = {
      VENDOR_CONFIG_DIR: 'C:\\cfg', VENDOR_USE_CLOUD: '1', VENDOR_SESSION_TOKEN: 'secret', VENDOR_ENTRYPOINT: 'cli',
      HTTPS_PROXY: 'http://proxy', DEBUG: '1', PARENTMARK: '1', PATH: 'C:\\bin', NODE_OPTIONS: '--inspect', VENDOR_USE_DEBUG: 'yes',
    };
    expect(constrainEnvironment(input, constraints, 'linux')).toEqual({ VENDOR_CONFIG_DIR: 'C:\\cfg', VENDOR_USE_CLOUD: '1', HTTPS_PROXY: 'http://proxy', PATH: 'C:\\bin' });
  });
  it('matches every Windows case variant and leaves input untouched', () => {
    const input = { vendor_session_token: 'secret', Vendor_Config_Dir: 'C:\\cfg', debug: '1', ParentMark: '1', Path: 'C:\\bin' };
    expect(constrainEnvironment(input, constraints, 'win32')).toEqual({ VENDOR_CONFIG_DIR: 'C:\\cfg', PATH: 'C:\\bin' });
    expect(input.vendor_session_token).toBe('secret');
  });
  it('is only the generic sanitizer without constraints', () => {
    expect(constrainEnvironment({ VENDOR_X: '1', ELECTRON_RUN_AS_NODE: '1' }, undefined, 'linux')).toEqual({ VENDOR_X: '1' });
  });
});
// M14b, V3 (C8, C9): the mechanics, on made-up names. The modules' own declarations are held to the
// same in tests/process/instance-environment.test.ts, which may import them.
describe('an added instance’s environment', () => {
  const instance = { variable: 'VENDOR_HOME', folder: 'D:\\accounts\\work', withhold: { names: ['VENDOR_TOKEN', 'OTHER_API_KEY'], prefixes: ['VENDOR_BACKEND_', 'VENDOR_USE_'] } };
  it.each([
    ['linux', {
      VENDOR_HOME: '/home/me/.vendor', VENDOR_TOKEN: 'secret', OTHER_API_KEY: 'key', VENDOR_BACKEND_URL: 'https://elsewhere', VENDOR_BACKEND_PROFILE: 'p',
      VENDOR_USE_CLOUD: '1', VENDOR_CA_BUNDLE: '/certs.pem', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'localhost', SSL_CERT_FILE: '/ca.pem', PATH: '/bin', NODE_OPTIONS: '--inspect',
    }, { VENDOR_HOME: 'D:\\accounts\\work', VENDOR_CA_BUNDLE: '/certs.pem', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'localhost', SSL_CERT_FILE: '/ca.pem', PATH: '/bin' }],
    ['win32', {
      Vendor_Home: 'C:\\Users\\me\\.vendor', vendor_token: 'secret', Other_Api_Key: 'key', vendor_backend_url: 'https://elsewhere', Vendor_Use_Cloud: '1',
      https_proxy: 'http://proxy', Path: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1',
    }, { VENDOR_HOME: 'D:\\accounts\\work', HTTPS_PROXY: 'http://proxy', PATH: 'C:\\bin' }],
  ])('on %s sets the variable to the folder in place of an inherited value, and drops the withheld names and prefixes', (platform, input, expected) => {
    const before = { ...input };
    expect(instanceEnvironment(input, instance, platform)).toEqual(expected);
    expect(input).toEqual(before);
  });
  it('sets the variable when none was inherited, exactly once', () => {
    expect(instanceEnvironment({ PATH: '/bin' }, instance, 'linux')).toEqual({ PATH: '/bin', VENDOR_HOME: 'D:\\accounts\\work' });
    // Two spellings inherited on Windows leave one, the folder's.
    expect(instanceEnvironment({ vendor_home: 'a', VENDOR_HOME: 'b' }, instance, 'win32')).toEqual({ VENDOR_HOME: 'D:\\accounts\\work' });
  });
  it('still sets the variable when a module withholds it by mistake', () => {
    const mistaken = { ...instance, withhold: { names: ['VENDOR_HOME'], prefixes: ['VENDOR_'] } };
    expect(instanceEnvironment({ VENDOR_HOME: 'inherited', VENDOR_X: '1', PATH: '/bin' }, mistaken, 'linux')).toEqual({ PATH: '/bin', VENDOR_HOME: 'D:\\accounts\\work' });
  });
  it('treats another letter case as another variable off Windows, as the CLI would', () => {
    expect(instanceEnvironment({ vendor_token: 'not the token', vendor_home: 'not the home' }, instance, 'linux'))
      .toEqual({ vendor_token: 'not the token', vendor_home: 'not the home', VENDOR_HOME: 'D:\\accounts\\work' });
  });
  it('comes after the provider’s constraints: what the policy lets through is what an added instance then loses', () => {
    const constraints = { removePrefixes: ['VENDOR_'], keepNames: ['VENDOR_HOME', 'VENDOR_TOKEN'], keepPrefixes: ['VENDOR_USE_'] };
    const inherited = { VENDOR_HOME: 'C:\\first', VENDOR_TOKEN: 'secret', VENDOR_USE_CLOUD: '1', VENDOR_SESSION: 'parent', HTTPS_PROXY: 'http://proxy' };
    const first = constrainEnvironment(inherited, constraints, 'win32');
    // The first instance: exactly what the provider's children get today.
    expect(first).toEqual({ VENDOR_HOME: 'C:\\first', VENDOR_TOKEN: 'secret', VENDOR_USE_CLOUD: '1', HTTPS_PROXY: 'http://proxy' });
    expect(instanceEnvironment(first, instance, 'win32')).toEqual({ VENDOR_HOME: 'D:\\accounts\\work', HTTPS_PROXY: 'http://proxy' });
  });
});
describe('the withheld variables fat-g was started with', () => {
  const withhold = { names: ['VENDOR_TOKEN'], prefixes: ['VENDOR_BACKEND_'] };
  it('names them, sorted, and never a value', () => {
    const env = { VENDOR_TOKEN: 'secret-value', VENDOR_BACKEND_URL: 'https://elsewhere', VENDOR_BACKEND_AUTH: 'bearer', VENDOR_HOME: '/h', PATH: '/bin' };
    const names = withheldPresent(env, withhold, 'linux');
    expect(names).toEqual(['VENDOR_BACKEND_AUTH', 'VENDOR_BACKEND_URL', 'VENDOR_TOKEN']);
    expect(JSON.stringify(names)).not.toMatch(/secret-value|elsewhere|bearer/);
  });
  it('finds every Windows case variant, and nothing when none is set', () => {
    expect(withheldPresent({ vendor_token: 'x', Vendor_Backend_Url: 'y', Path: 'C:\\bin' }, withhold, 'win32')).toEqual(['VENDOR_BACKEND_URL', 'VENDOR_TOKEN']);
    expect(withheldPresent({ PATH: '/bin', vendor_token: 'another variable off Windows' }, withhold, 'linux')).toEqual([]);
  });
});
describe('environment', () => {
  it('applies safe per-run overrides with Windows key semantics and preserves a protected variable', () => {
    expect(mergeEnvironment({ PATH: 'old', CODEX_HOME: 'original' }, { Path: 'new', codex_home: 'redirect', node_options: 'unsafe' }, 'win32', ['CODEX_HOME'])).toEqual({ PATH: 'new', CODEX_HOME: 'original' });
    expect(mergeEnvironment({}, { CODEX_HOME: 'new' }, 'linux', ['CODEX_HOME'])).toEqual({});
  });
  it('lets a per-run override set no protected variable, in an added instance’s scope or the first’s, and every other one', () => {
    const names = ['VENDOR_HOME', 'OTHER_HOME'];
    const added = instanceEnvironment({ PATH: '/bin' }, { variable: 'VENDOR_HOME', folder: '/accounts/work', withhold: { names: [], prefixes: [] } }, 'linux');
    expect(mergeEnvironment(added, { VENDOR_HOME: '/redirect', OTHER_HOME: '/redirect', EXTRA: '1' }, 'linux', names)).toEqual({ PATH: '/bin', VENDOR_HOME: '/accounts/work', EXTRA: '1' });
    expect(mergeEnvironment({ VENDOR_HOME: '/inherited' }, { VENDOR_HOME: '/redirect', EXTRA: '1' }, 'linux', names)).toEqual({ VENDOR_HOME: '/inherited', EXTRA: '1' });
    expect(mergeEnvironment({ VENDOR_HOME: 'C:\\inherited' }, { vendor_home: 'C:\\redirect', Other_Home: 'C:\\redirect' }, 'win32', names)).toEqual({ VENDOR_HOME: 'C:\\inherited' });
    // The names are given, never built in: with none, nothing is protected.
    expect(mergeEnvironment({}, { VENDOR_HOME: '/set' }, 'linux', [])).toEqual({ VENDOR_HOME: '/set' });
  });
  it('sanitizes case variants without mutating configuration or creating CODEX_HOME', () => {
    const input = { Path: 'a', PATH: 'b', node_options: 'secret', ELECTRON_RUN_AS_NODE: '1', CLAUDE_CONFIG_DIR: 'custom', CODEX_HOME: 'existing', HTTPS_PROXY: 'proxy' };
    expect(sanitizeEnv(input, 'win32')).toEqual({ PATH: 'b', CLAUDE_CONFIG_DIR: 'custom', CODEX_HOME: 'existing', HTTPS_PROXY: 'proxy' });
    expect(input.node_options).toBe('secret'); expect(sanitizeEnv({}, 'linux')).not.toHaveProperty('CODEX_HOME');
  });
  it('repairs Windows PATH in order, removing duplicates and relative entries', async () => {
    const get = createEnvironment({ env: { Path: '"C:\\tools";;relative;c:\\TOOLS', USERPROFILE: 'C:\\users\\é', APPDATA: 'C:\\app', LOCALAPPDATA: 'C:\\local' }, platform: 'win32', homedir: '', isDirectory: () => Promise.resolve(true), probe: vi.fn() });
    expect((await get())['PATH']).toBe('C:\\tools;C:\\users\\é\\.local\\bin;C:\\app\\npm;C:\\local\\Microsoft\\WinGet\\Links');
  });
  it('does not manufacture relative repair paths when bases are missing', async () => {
    const get = createEnvironment({ env: {}, platform: 'win32', homedir: '', isDirectory: () => Promise.resolve(true), probe: vi.fn() });
    expect((await get())['PATH']).toBe('');
  });
  it('coalesces and caches a noisy POSIX shell probe', async () => {
    const probe = vi.fn(() => Promise.resolve('banner\n__FATG_PATH_BEGIN__/shell:/usr/bin:relative__FATG_PATH_END__\nnoise'));
    const get = createEnvironment({ env: { PATH: '/first::.', SHELL: '/bin/zsh' }, platform: 'darwin', homedir: '/home/me', isDirectory: () => Promise.resolve(true), probe });
    const [a, b] = await Promise.all([get(), get()]); expect(a).toBe(b); await get(); expect(probe).toHaveBeenCalledTimes(1);
    expect(a['PATH']).toBe('/first:/shell:/usr/bin:/home/me/.local/bin:/home/me/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/bin');
  });
  it.each(['unsupported', 'failure', 'oversized', 'malformed'])('uses cached static fallback on %s probe', async (mode) => {
    const probe = vi.fn(() => mode === 'failure' ? Promise.reject(new Error('private')) : Promise.resolve(mode === 'oversized' ? 'x'.repeat(65537) : 'banner'));
    const get = createEnvironment({ env: { SHELL: mode === 'unsupported' ? '/bin/unknown' : '/bin/bash' }, platform: 'linux', homedir: '/h', isDirectory: () => Promise.resolve(true), probe });
    expect((await get())['PATH']).toContain('/usr/bin'); await get(); expect(probe).toHaveBeenCalledTimes(mode === 'unsupported' ? 0 : 1);
  });
  it('uses a fixed fish-specific command', async () => {
    const probe = vi.fn(() => Promise.resolve(''));
    await createEnvironment({ env: { SHELL: '/bin/fish' }, platform: 'linux', homedir: '/h', isDirectory: () => Promise.resolve(false), probe })();
    expect(probe.mock.calls[0]).toBeDefined();
  });
});
