// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The confined media route (docs/planning/_archive/M23.md, Design 3; C10, C11; M102, Design 6; C59–C62):
// what the page draws an image of fat-g's from, `app://media/<source>/<id>`, inside the one `app`
// scheme handler. Each source answers ids by a rule of its own — the attachments source a hash its
// store names, the avatars source an id its scan minted — and builds the file's path from what it
// holds, never from the request, and each names how Chromium may keep what it serves. Anything else
// is refused before a file is opened: an unknown source, a method but GET, a path of another shape, a
// query, an encoded character.
//
// Pure, and Electron-free: a request's method and address in, an answer out. protocol.ts hands it the
// requests of the `media` host and makes the answer a Response.

/** The host of the media route, beside the renderer's own `fatg`. */
export const MEDIA_HOST = 'media';

/** A source's name, and an id within it: lowercase letters, digits and hyphens, a bounded length. */
const SEGMENT = /^[a-z0-9-]{1,128}$/;

/**
 * How Chromium may keep what a source serves (M102, C62): `no-store`, nowhere — an attachment, as M23
 * chose (M23, C11); `immutable`, in its cache under the id for as long as it likes — an avatar, whose
 * id changes with its file (C60).
 */
export type MediaCachePolicy = 'no-store' | 'immutable';

/** What a source answers: local media, or a refusal. */
export type SourceAnswer =
  | { readonly status: 200; readonly body: Uint8Array; readonly contentType: string }
  /** Every refusal, whatever its cause: the page learns nothing more of why. */
  | { readonly status: 404; readonly kind: MediaRefusal };

/** What the route answers: local media with its source's cache policy, or a refusal. */
export type MediaAnswer =
  | (Extract<SourceAnswer, { readonly status: 200 }> & { readonly cache: MediaCachePolicy })
  | Extract<SourceAnswer, { readonly status: 404 }>;

/** Why a request was refused, by kind: what a log may say, never an id or an address (C75). */
export type MediaRefusal = 'method' | 'address' | 'source' | 'id' | 'unavailable' | 'changed';

export interface MediaSource {
  /** The source's name in the address. */
  readonly name: string;
  /** How Chromium may keep what it serves (C62). */
  readonly cache: MediaCachePolicy;
  /** An id of this source's own rule, already shaped as a segment: an image, or a refusal. */
  serve(id: string): Promise<SourceAnswer>;
}

/** The source and id an address names, or null for any address of another shape. */
export function parseMediaAddress(url: string): { readonly source: string; readonly id: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'app:' || parsed.host !== MEDIA_HOST || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  // The path as written: an encoded character, a dot segment or a backslash is no path of the route's.
  const segments = parsed.pathname.split('/');
  if (segments.length !== 3 || segments[0] !== '') return null;
  const [, source = '', id = ''] = segments;
  return SEGMENT.test(source) && SEGMENT.test(id) ? { source, id } : null;
}

const refuse = (kind: MediaRefusal): MediaAnswer => ({ status: 404, kind });

/** The `cache-control` of each policy (C62): an attachment kept nowhere, an avatar kept by its id. */
const CACHE_CONTROL: Readonly<Record<MediaCachePolicy, string>> = {
  'no-store': 'no-store',
  immutable: 'private, max-age=31536000, immutable',
};

/**
 * The headers an image is served with (M23, C11; M102, C62): the type its signature gave and nothing
 * sniffed, its source's cache policy — an attachment in no cache of Chromium's (no persistent copy
 * outside the owned folder), an avatar kept under its id — offering no Range, and a policy that lets
 * the response itself run nothing.
 */
export function mediaHeaders(contentType: string, cache: MediaCachePolicy): Record<string, string> {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': CACHE_CONTROL[cache],
    'content-security-policy': "default-src 'none'; sandbox",
  };
}

/** The route over its sources: a request's method and address in, an answer out. */
export function createMediaRoute(sources: readonly MediaSource[]): (request: { readonly method: string; readonly url: string }) => Promise<MediaAnswer> {
  const byName = new Map(sources.map((source) => [source.name, source]));
  return async (request) => {
    if (request.method !== 'GET') return refuse('method');
    const named = parseMediaAddress(request.url);
    if (named === null) return refuse('address');
    const source = byName.get(named.source);
    if (source === undefined) return refuse('source');
    try {
      const answer = await source.serve(named.id);
      return answer.status === 200 ? { ...answer, cache: source.cache } : answer;
    } catch {
      return refuse('unavailable');
    }
  };
}
