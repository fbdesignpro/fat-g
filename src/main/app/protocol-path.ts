// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Maps an app://fatg/… URL to a file inside the renderer output folder. Pure — no Electron imports.
import path from 'node:path';
import { APP_HOST, APP_SCHEME } from './origins';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Returns the absolute file path for a request, or `null` if the URL is not ours or would
 * escape `rootDir` (path traversal, including encoded and backslash variants).
 */
export function resolveAppRequest(url: string, rootDir: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  if (pathname === '' || pathname.endsWith('/')) pathname += 'index.html';

  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${pathname}`)}`);
  // Second check on the *resolved* path: on Windows a decoded backslash is a separator too.
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
