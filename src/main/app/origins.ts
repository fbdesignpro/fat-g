// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which origins the app's own windows are allowed to load and talk to. Pure — no Electron imports.
import type { Theme } from '@shared/contracts/appearance';

export const APP_SCHEME = 'app';
export const APP_HOST = 'fatg';
/** Origin of the packaged renderer, served by our own protocol handler (see protocol.ts). */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/**
 * The confined media route's origin (M23, C10; M102, C23): an image of fat-g's own, drawn by the
 * page. Never a page: no IPC, no navigation, no window — loaded as an image and as nothing else.
 */
export const MEDIA_ORIGIN = `${APP_SCHEME}://media`;

/** Whether an address is the media route's. */
export function isMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === 'media';
  } catch {
    return false;
  }
}

export interface TrustedOrigins {
  /** Origin pages are loaded from: the dev server in development, otherwise APP_ORIGIN. */
  readonly renderer: string;
  /** Dev-server origin (http) when running under `electron-vite dev`; undefined when packaged. */
  readonly devServer: string | undefined;
}

/**
 * The dev-server URL arrives through an environment variable, so it is only honoured for an
 * unpackaged app and only for loopback hosts — a packaged build must never be steerable to a
 * remote page by whoever controls the environment.
 */
export function resolveTrustedOrigins(input: { isPackaged: boolean; devServerUrl: string | undefined }): TrustedOrigins {
  const devServer = input.isPackaged ? undefined : loopbackOrigin(input.devServerUrl);
  return { renderer: devServer ?? APP_ORIGIN, devServer };
}

/**
 * The Chromium switches a run from the dev server needs, set before `ready`; none for any other run.
 *
 * Vite marks its pre-bundled packages immutable for a year, under a version that does not always
 * change when the bundle is made again. A data folder that outlives one bundle — the development
 * build's, the stream form's — then answers from its own HTTP cache with a package of the old
 * bundle, whose chunks the server no longer has: no module of the page loads, and the window stays
 * empty. So nothing the dev server sends is read from Chromium's cache.
 */
export function devServerSwitches(origins: TrustedOrigins): readonly string[] {
  return origins.devServer === undefined ? [] : ['disable-http-cache'];
}

function loopbackOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    return parsed.protocol === 'http:' && isLoopback ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The renderer's HTML pages — one per window kind (see `renderer` inputs in electron.vite.config.ts). */
export type RendererPage = 'index.html' | 'pet.html';

/**
 * Where a window loads its page from: the dev server in development, our app:// origin otherwise.
 * Always names the page explicitly — in dev, Vite answers a missing page with index.html (SPA
 * fallback), which would hide a broken pet.html until the packaged build 404'd.
 *
 * The theme rides along as a query parameter, which the page reads in <head> to paint its first
 * frame in the right colours (src/renderer/public/theme-boot.js). The protocol handler serves by
 * path only (protocol-path.ts), so the query never names a file.
 */
export function pageUrl(origins: TrustedOrigins, page: RendererPage, theme: Theme): string {
  return `${origins.devServer ?? APP_ORIGIN}/${page}?theme=${theme}`;
}

/** True when `url` is a page the app itself serves. Used for navigation and IPC sender checks. */
export function isTrustedPageUrl(url: string, origins: TrustedOrigins): boolean {
  try {
    const parsed = new URL(url);
    // Custom schemes report origin "null" in some URL implementations — compare parts instead.
    if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST;
    return origins.devServer !== undefined && parsed.origin === origins.devServer;
  } catch {
    return false;
  }
}

/**
 * Network allowlist for the session. The app makes no network calls of its own (decision 0004):
 * everything except our own pages, the local dev server (incl. its HMR websocket) and DevTools
 * internals is cancelled. The media route admits image loads, or media loads for its audio source
 * (decision 0034): never a frame, a script or a fetch.
 */
export function isAllowedRequestUrl(url: string, origins: TrustedOrigins, resourceType?: string): boolean {
  if (isMediaUrl(url)) {
    const source = new URL(url).pathname.split('/')[1];
    return source === 'audio' ? resourceType === 'media' : resourceType === 'image';
  }
  if (isTrustedPageUrl(url, origins)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'devtools:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
    if (origins.devServer !== undefined && parsed.protocol === 'ws:') {
      return parsed.host === new URL(origins.devServer).host;
    }
    return false;
  } catch {
    return false;
  }
}
