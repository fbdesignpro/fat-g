// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentTypeFor, resolveAppRequest } from './protocol-path';

// An absolute root that is valid on whichever OS runs the tests.
const ROOT = path.resolve('/srv/fatg/out/renderer');
const inRoot = (...parts: string[]) => path.join(ROOT, ...parts);

describe('resolveAppRequest', () => {
  it('maps the root and directories to index.html', () => {
    expect(resolveAppRequest('app://fatg/', ROOT)).toBe(inRoot('index.html'));
    expect(resolveAppRequest('app://fatg', ROOT)).toBe(inRoot('index.html'));
  });

  it('maps asset paths inside the root', () => {
    expect(resolveAppRequest('app://fatg/assets/index-abc.js', ROOT)).toBe(inRoot('assets', 'index-abc.js'));
    expect(resolveAppRequest('app://fatg/pet.html?x=1#y', ROOT)).toBe(inRoot('pet.html'));
  });

  it('decodes percent-encoded names', () => {
    expect(resolveAppRequest('app://fatg/art/title%20screen.webp', ROOT)).toBe(inRoot('art', 'title screen.webp'));
  });

  it.each([
    'app://fatg/../../../etc/passwd',
    'app://fatg/..%2F..%2F..%2Fetc%2Fpasswd',
    'app://fatg/%2e%2e/%2e%2e/secret.txt',
    'app://fatg/..%5C..%5C..%5CWindows%5Cwin.ini',
    'app://fatg/assets/..%5C..%5C..%5Csecret.txt',
    'app://fatg/assets/../../outside.txt',
  ])('never escapes the root: %s', (url) => {
    const resolved = resolveAppRequest(url, ROOT);
    // Either refused outright, or normalised to something that is still inside the root.
    expect(resolved === null || resolved.startsWith(ROOT + path.sep)).toBe(true);
  });

  it.each(['app://other/index.html', 'file:///C:/Windows/win.ini', 'https://fatg/index.html', 'app://fatg/a%00b', 'app://fatg/%E0%A4%A', 'nonsense'])(
    'refuses foreign or malformed URL: %s',
    (url) => {
      expect(resolveAppRequest(url, ROOT)).toBeNull();
    },
  );
});

describe('contentTypeFor', () => {
  it('knows the types the renderer ships', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('assets/index-abc.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('art/bg.webp')).toBe('image/webp');
  });

  it('falls back to a non-executable type', () => {
    expect(contentTypeFor('mystery.bin')).toBe('application/octet-stream');
  });
});
