// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Content-Security-Policy for every window. Pure — no Electron imports.
import { MEDIA_ORIGIN, type TrustedOrigins } from './origins';

/**
 * Production is strict: no inline script, no inline <style>, no remote anything.
 * (React sets inline styles through the CSSOM, which CSP does not restrict, so `style-src 'self'`
 * is compatible with `style={{…}}` and CSS custom properties set from JS.)
 *
 * Development must relax two things for Vite: the React-refresh preamble is an inline script,
 * CSS HMR injects <style> tags, and HMR talks over a websocket.
 */
export function buildCsp(origins: TrustedOrigins): string {
  const dev = origins.devServer !== undefined;
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // The confined media route: images and local sound effects (decision 0034).
    'img-src': ["'self'", 'data:', 'blob:', MEDIA_ORIGIN],
    'media-src': ["'self'", 'blob:', MEDIA_ORIGIN],
    'font-src': ["'self'"],
    'connect-src': dev ? ["'self'", toWebSocketOrigin(origins.devServer)] : ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

function toWebSocketOrigin(httpOrigin: string | undefined): string {
  return (httpOrigin ?? '').replace(/^http/, 'ws');
}
