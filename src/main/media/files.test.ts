// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0022, item 15: the media route's image files source — an id of another shape refused before
// the image files are asked, an id's answer passed on with its kind, and what is served kept in no cache.
import { describe, expect, it, vi } from 'vitest';
import type { Served } from '../files/images';
import { createImageFileSource, FILES_SOURCE } from './files';
import { createMediaRoute, mediaHeaders } from './route';

const ID = 'a'.repeat(32);
const BYTES = new Uint8Array([1, 2, 3]);

function setup(answer: Served) {
  const serve = vi.fn((_id: string) => Promise.resolve(answer));
  const route = createMediaRoute([createImageFileSource({ serve })]);
  const get = (id: string) => route({ method: 'GET', url: `app://media/${FILES_SOURCE}/${id}` });
  return { serve, get };
}

describe('the image files source', () => {
  it('serves an id’s file by the id alone, in no cache of Chromium’s', async () => {
    const s = setup({ ok: true, bytes: BYTES, mediaType: 'image/webp' });
    expect(await s.get(ID)).toEqual({ status: 200, body: BYTES, contentType: 'image/webp', cache: 'no-store' });
    expect(s.serve.mock.calls).toEqual([[ID]]);
    expect(mediaHeaders('image/webp', 'no-store')['cache-control']).toBe('no-store');
  });

  it('refuses an id of another shape before the image files are asked', async () => {
    const s = setup({ ok: true, bytes: BYTES, mediaType: 'image/png' });
    for (const id of ['a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), 'a-'.repeat(16)]) expect(await s.get(id)).toEqual({ status: 404, kind: 'id' });
    // A capital is no segment of the route's at all.
    expect(await s.get('A'.repeat(32))).toEqual({ status: 404, kind: 'address' });
    expect(s.serve).not.toHaveBeenCalled();
  });

  it.each(['id', 'unavailable', 'changed'] as const)('answers a refusal of kind %s with that kind alone', async (kind) => {
    expect(await setup({ ok: false, kind }).get(ID)).toEqual({ status: 404, kind });
  });
});
