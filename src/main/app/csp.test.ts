// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';
import { resolveTrustedOrigins } from './origins';

const packaged = resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined });
const dev = resolveTrustedOrigins({ isPackaged: false, devServerUrl: 'http://localhost:5173' });

function directive(csp: string, name: string): string[] {
  const entry = csp.split('; ').find((part) => part.startsWith(`${name} `));
  return entry ? entry.split(' ').slice(1) : [];
}

describe('buildCsp (packaged)', () => {
  const csp = buildCsp(packaged);

  it('denies by default', () => {
    expect(directive(csp, 'default-src')).toEqual(["'none'"]);
  });

  it('allows no inline or eval script and no inline style', () => {
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    expect(directive(csp, 'style-src')).toEqual(["'self'"]);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows no remote origin anywhere', () => {
    expect(csp).not.toMatch(/https?:|wss?:|\*/);
  });

  it('locks down plugins, base URI, forms and framing', () => {
    for (const name of ['object-src', 'base-uri', 'form-action', 'frame-ancestors']) {
      expect(directive(csp, name)).toEqual(["'none'"]);
    }
  });
});

describe('buildCsp (development)', () => {
  const csp = buildCsp(dev);

  it('relaxes only what Vite needs: inline script/style and the HMR websocket', () => {
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, 'style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, 'connect-src')).toEqual(["'self'", 'ws://localhost:5173']);
  });

  it('still never allows eval or a remote origin', () => {
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https:|wss:|\*/);
  });
});

// M23, V3 (C10): the media route is in the image sources, and in no other directive.
describe('the media route in the policy', () => {
  it('is an image and audio source alone', () => {
    for (const csp of [buildCsp(packaged), buildCsp(dev)]) {
      expect(directive(csp, 'img-src')).toContain('app://media');
      expect(directive(csp, 'media-src')).toContain('app://media');
      expect(csp.split('; ').filter((part) => part.includes('app://media'))).toHaveLength(2);
    }
  });
});
