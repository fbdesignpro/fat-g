// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { WindowKind } from '@shared/ipc/channels';
import { resolveTrustedOrigins } from '../app/origins';
import { checkSender, type SenderFacts } from './sender-policy';

const DEV_URL = 'http://localhost:5173';
const dev = resolveTrustedOrigins({ isPackaged: false, devServerUrl: DEV_URL });
const packaged = resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined });

const top = (frameUrl: string | null): SenderFacts => ({ frameUrl, isTopFrame: true });
const BOTH: readonly WindowKind[] = ['main', 'pet'];

describe('checkSender', () => {
  it.each([
    ['packaged page', top('app://fatg/index.html'), packaged],
    ['packaged Pet page', top('app://fatg/pet.html'), packaged],
    ['dev-server page', top(`${DEV_URL}/pet.html`), dev],
  ])('accepts our own %s', (_name, sender, origins) => {
    expect(checkSender(sender, 'main', BOTH, origins)).toEqual({ ok: true });
  });

  it.each([
    ['a remote site', 'https://evil.example/'],
    ['another app:// host', 'app://other/index.html'],
    ['a local file', 'file:///C:/Users/someone/page.html'],
    ['a blank page', 'about:blank'],
    ['DevTools', 'devtools://devtools/bundled/inspector.html'],
    ['the dev server of a packaged build', `${DEV_URL}/index.html`],
    ['garbage', 'not a url'],
  ])('refuses a page from %s as untrusted-origin', (_name, url) => {
    expect(checkSender(top(url), 'main', BOTH, packaged)).toEqual({ ok: false, reason: 'untrusted-origin' });
  });

  it('refuses a frame that navigated away or was destroyed', () => {
    expect(checkSender(top(null), 'main', BOTH, packaged)).toEqual({ ok: false, reason: 'frame-gone' });
  });

  it('refuses an iframe even when it shows one of our pages', () => {
    const sender: SenderFacts = { frameUrl: 'app://fatg/index.html', isTopFrame: false };
    expect(checkSender(sender, 'main', BOTH, packaged)).toEqual({ ok: false, reason: 'subframe' });
  });

  it('refuses a window kind the channel does not allow', () => {
    const sender = top('app://fatg/pet.html');
    expect(checkSender(sender, 'pet', ['main'], packaged)).toEqual({ ok: false, reason: 'window-kind' });
    expect(checkSender(sender, 'main', ['main'], packaged)).toEqual({ ok: true });
  });

  it('checks the origin before the window kind, so a foreign page learns nothing about permissions', () => {
    expect(checkSender(top('https://evil.example/'), 'pet', ['main'], packaged)).toEqual({ ok: false, reason: 'untrusted-origin' });
  });
});
