// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, devServerSwitches, isAllowedRequestUrl, isMediaUrl, isTrustedPageUrl, pageUrl, resolveTrustedOrigins } from './origins';

const DEV_URL = 'http://localhost:5173';
const dev = resolveTrustedOrigins({ isPackaged: false, devServerUrl: DEV_URL });
const packaged = resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined });

describe('resolveTrustedOrigins', () => {
  it('uses the dev server in development', () => {
    expect(dev).toEqual({ renderer: DEV_URL, devServer: DEV_URL });
  });

  it('uses the app:// origin when there is no dev server', () => {
    expect(packaged).toEqual({ renderer: APP_ORIGIN, devServer: undefined });
  });

  it('ignores the dev-server env var in a packaged app', () => {
    expect(resolveTrustedOrigins({ isPackaged: true, devServerUrl: DEV_URL })).toEqual(packaged);
  });

  it.each(['https://evil.example', 'http://evil.example:5173', 'http://192.168.1.10:5173', 'file:///C:/x.html', 'not a url'])(
    'refuses a non-loopback or non-http dev server: %s',
    (devServerUrl) => {
      expect(resolveTrustedOrigins({ isPackaged: false, devServerUrl }).devServer).toBeUndefined();
    },
  );

  it('accepts 127.0.0.1 as loopback', () => {
    expect(resolveTrustedOrigins({ isPackaged: false, devServerUrl: 'http://127.0.0.1:5173/' }).devServer).toBe('http://127.0.0.1:5173');
  });
});

describe('devServerSwitches', () => {
  it('turns Chromium’s HTTP cache off for a run from the dev server, whose packages are marked immutable under a version that may not change', () => {
    expect(devServerSwitches(resolveTrustedOrigins({ isPackaged: false, devServerUrl: 'http://localhost:5173' }))).toEqual(['disable-http-cache']);
  });

  it('sets nothing for a built or a packaged app, whatever the environment says', () => {
    expect(devServerSwitches(resolveTrustedOrigins({ isPackaged: false, devServerUrl: undefined }))).toEqual([]);
    expect(devServerSwitches(resolveTrustedOrigins({ isPackaged: true, devServerUrl: 'http://localhost:5173' }))).toEqual([]);
  });
});

describe('isTrustedPageUrl', () => {
  it('trusts our own app:// pages', () => {
    expect(isTrustedPageUrl('app://fatg/index.html', packaged)).toBe(true);
    expect(isTrustedPageUrl('app://fatg', packaged)).toBe(true);
  });

  it('rejects another host on the app scheme', () => {
    expect(isTrustedPageUrl('app://other/index.html', packaged)).toBe(false);
  });

  it('trusts the dev server only in development', () => {
    expect(isTrustedPageUrl(`${DEV_URL}/index.html`, dev)).toBe(true);
    expect(isTrustedPageUrl(`${DEV_URL}/index.html`, packaged)).toBe(false);
  });

  it.each(['https://example.com', 'http://localhost:9999/', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', ''])(
    'rejects %s',
    (url) => {
      expect(isTrustedPageUrl(url, dev)).toBe(false);
    },
  );
});

describe('isAllowedRequestUrl', () => {
  it('allows our pages, DevTools internals and inline data', () => {
    for (const url of ['app://fatg/assets/x.js', 'devtools://devtools/bundled/x.js', 'data:image/png;base64,AAAA', 'blob:app://fatg/1234']) {
      expect(isAllowedRequestUrl(url, packaged)).toBe(true);
    }
  });

  it('allows the HMR websocket only for the dev server host', () => {
    expect(isAllowedRequestUrl('ws://localhost:5173/', dev)).toBe(true);
    expect(isAllowedRequestUrl('ws://localhost:9999/', dev)).toBe(false);
    expect(isAllowedRequestUrl('ws://localhost:5173/', packaged)).toBe(false);
  });

  it.each(['https://fonts.googleapis.com/css', 'https://redirector.gvt1.com/edgedl/chrome/dict/en-us.bdic', 'http://example.com/', 'wss://example.com/'])(
    'blocks outbound request %s',
    (url) => {
      expect(isAllowedRequestUrl(url, dev)).toBe(false);
      expect(isAllowedRequestUrl(url, packaged)).toBe(false);
    },
  );
});

describe('pageUrl', () => {
  it.each([
    ['dev', dev, 'index.html', 'light', `${DEV_URL}/index.html?theme=light`],
    ['dev', dev, 'pet.html', 'dark', `${DEV_URL}/pet.html?theme=dark`],
    ['packaged', packaged, 'index.html', 'dark', 'app://fatg/index.html?theme=dark'],
    ['packaged', packaged, 'pet.html', 'light', 'app://fatg/pet.html?theme=light'],
  ] as const)('%s: %s in the %s theme', (_mode, origins, page, theme, expected) => {
    expect(pageUrl(origins, page, theme)).toBe(expected);
  });

  it('always yields a page the IPC sender check trusts, whatever the theme', () => {
    for (const origins of [dev, packaged]) {
      for (const page of ['index.html', 'pet.html'] as const) {
        for (const theme of ['light', 'dark'] as const) expect(isTrustedPageUrl(pageUrl(origins, page, theme), origins)).toBe(true);
      }
    }
  });
});

// M23, V3 (C10; M102, C27): the media route is an image's load alone — never a page, a frame or a fetch.
describe('the media route', () => {
  const MEDIA = `app://media/attachments/${'a'.repeat(64)}`;

  it('is no trusted page: it grants no IPC and cannot be navigated to', () => {
    expect(isTrustedPageUrl(MEDIA, packaged)).toBe(false);
    expect(isTrustedPageUrl(MEDIA, dev)).toBe(false);
    expect(isMediaUrl(MEDIA)).toBe(true);
    expect(isMediaUrl('app://fatg/index.html')).toBe(false);
  });

  it('is allowed as an image and as nothing else', () => {
    expect(isAllowedRequestUrl(MEDIA, packaged, 'image')).toBe(true);
    expect(isAllowedRequestUrl(MEDIA, dev, 'image')).toBe(true);
    for (const kind of ['mainFrame', 'subFrame', 'script', 'xhr', 'media', 'object', 'other', undefined]) expect(isAllowedRequestUrl(MEDIA, packaged, kind)).toBe(false);
  });

  // M102, V17 (C27): the avatars' source is the same route, and no more trusted.
  it('takes an avatar’s address as it takes an attachment’s', () => {
    const AVATAR = `app://media/avatars/${'0'.repeat(32)}`;
    expect(isTrustedPageUrl(AVATAR, packaged)).toBe(false);
    expect(isMediaUrl(AVATAR)).toBe(true);
    expect(isAllowedRequestUrl(AVATAR, packaged, 'image')).toBe(true);
    for (const kind of ['mainFrame', 'subFrame', 'script', 'xhr', 'media', 'object', 'other', undefined]) expect(isAllowedRequestUrl(AVATAR, packaged, kind)).toBe(false);
  });
});


describe('local audio media isolation', () => {
  it('allows audio only as media, with no navigation, IPC or fetch access', () => {
    const url = `app://media/audio/${'a'.repeat(64)}`;
    expect(isTrustedPageUrl(url, packaged)).toBe(false);
    for (const origins of [packaged, dev]) {
      expect(isAllowedRequestUrl(url, origins, 'media')).toBe(true);
      for (const kind of ['image', 'mainFrame', 'subFrame', 'script', 'xhr', 'object', 'other', undefined]) expect(isAllowedRequestUrl(url, origins, kind)).toBe(false);
    }
  });
});
