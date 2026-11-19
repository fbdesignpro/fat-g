// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Serves the packaged renderer from app://fatg instead of file://. A real origin gives us a
// meaningful CSP `'self'`, reliable IPC sender checks, and the same security model in dev and prod.
//
// The same scheme's `media` host is the confined media route (docs/planning/_archive/M23.md, Design 3; C10,
// C11; M102, C59, C62): an image of fat-g's own, by its source and id, answered by src/main/media/. It
// is no page: it grants no IPC, cannot be navigated to and opens no window (origins.ts, security.ts).
import { readFile } from 'node:fs/promises';
import { protocol } from 'electron';
import { type MediaAnswer, MEDIA_HOST, mediaHeaders } from '../media/route';
import { APP_SCHEME } from './origins';
import { contentTypeFor, resolveAppRequest } from './protocol-path';

/** Must run synchronously at startup, before the app `ready` event. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/** What the media route answers a request with: the route's own, by source (src/main/media/). */
export type MediaHandler = (request: { readonly method: string; readonly url: string }) => Promise<MediaAnswer>;

/**
 * Files are read with `fs` rather than `net.fetch('file://…')` so the app's "no network module"
 * lint rule has no exceptions. NOTE: no HTTP Range support yet — fine for UI assets; large
 * seekable video backgrounds will need it (revisit when the media layer lands).
 *
 * `media`: the route for the `media` host. Left out, every media address is answered 404.
 * `refused`: told the kind of each refused media request, never its address (C75).
 */
export function handleAppProtocol(rootDir: string, csp: string, media?: MediaHandler, refused?: (kind: string) => void): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (isMediaRequest(request.url)) {
      const answer: MediaAnswer = media === undefined ? { status: 404, kind: 'source' } : await media({ method: request.method, url: request.url });
      if (answer.status !== 200) { refused?.(answer.kind); return notFound(); }
      // The type its signature gave, never sniffed; no Range; and kept as its source says (M23, C11; M102, C62).
      return new Response(new Uint8Array(answer.body), { headers: mediaHeaders(answer.contentType, answer.cache) });
    }
    const filePath = resolveAppRequest(request.url, rootDir);
    if (!filePath) return notFound();
    try {
      const body = await readFile(filePath);
      return new Response(new Uint8Array(body), {
        headers: {
          'content-type': contentTypeFor(filePath),
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return notFound();
    }
  });
}

/** Whether an address is the media route's: its host, whatever its path. */
function isMediaRequest(url: string): boolean {
  try {
    return new URL(url).host === MEDIA_HOST;
  } catch {
    return false;
  }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
