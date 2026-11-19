// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AttachmentMediaType, MAX_IMAGE_BYTES } from '@shared/contracts/attachments';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { createBlobFiles, sha256 } from '../../attachments/files';
import { resolveTrustedOrigins } from '../../app/origins';
import { pngBytes } from '../../images/test-support';
import { createAttachmentSource } from '../../media/attachments';
import { regularOwnedFile } from '../../storage/owned-file';
import { dispatchInvoke, type Handler } from '../dispatch';
import { artifactFileHandlers } from './artifact-files';

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(path.join(tmpdir(), 'fatg-artifact-actions-')); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

async function world() {
  const bytes = pngBytes(20, 10);
  const hash = sha256(bytes);
  const blobs = createBlobFiles(path.join(scratch, 'attachments'));
  await blobs.write(hash, 'image/png', bytes);
  const held = { mediaType: 'image/png' as const, width: 20, height: 10, bytes: bytes.byteLength };
  let available = true;
  const read = vi.fn((id: string, type: AttachmentMediaType, size: number) => blobs.read(id, type, size));
  const source = createAttachmentSource({ image: (id) => available && id === hash ? held : null, read });
  const show = vi.fn();
  const handlers = artifactFileHandlers({ attachments: source, attachmentPath: (id) => available && id === hash && blobs.holds(id, held.mediaType, held.bytes) ? regularOwnedFile(blobs.root, blobs.pathOf(id, held.mediaType)) : null }, show);
  const log = { warn: vi.fn(), error: vi.fn() };
  const call = (channel: keyof typeof handlers, request: unknown, windowKind: 'main' | 'pet' = 'main') => dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as Handler<unknown, unknown>, {
    windowKind, request, sender: { frameUrl: `app://fatg/${windowKind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true },
  }, { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail: 'kinds' });
  return { hash, bytes, blobs, held, read, show, call, unavailable: () => { available = false; } };
}

describe('stored artifact actions', () => {
  it('copies verified bytes and reveals only a main-resolved file', async () => {
    const test = await world();
    expect(await test.call('attachments:readForCopy', { hash: test.hash })).toEqual({ ok: true, value: { bytes: new Uint8Array(test.bytes), mediaType: 'image/png' } });
    expect(await test.call('attachments:showInFolder', { hash: test.hash })).toEqual({ ok: true, value: null });
    expect(test.show).toHaveBeenLastCalledWith(realpathSync(test.blobs.pathOf(test.hash, 'image/png')));
  });

  it('refuses missing, altered and oversized attachments', async () => {
    const test = await world();
    test.held.bytes = MAX_IMAGE_BYTES + 1;
    expect(await test.call('attachments:readForCopy', { hash: test.hash })).toEqual({ ok: true, value: null });
    expect(test.read).not.toHaveBeenCalled();
    test.held.bytes = test.bytes.byteLength;
    const altered = new Uint8Array(test.bytes);
    altered[0] = 0;
    writeFileSync(test.blobs.pathOf(test.hash, 'image/png'), altered);
    expect(await test.call('attachments:readForCopy', { hash: test.hash })).toEqual({ ok: true, value: null });
    test.unavailable();
    expect(await test.call('attachments:readForCopy', { hash: test.hash })).toEqual({ ok: true, value: null });
    expect(await test.call('attachments:showInFolder', { hash: test.hash })).toEqual({ ok: false, error: 'bad-request' });
    expect(test.show).not.toHaveBeenCalled();
  });

  it('rejects the Pet and malformed requests before reaching either store', async () => {
    const test = await world();
    for (const channel of ['attachments:readForCopy', 'attachments:showInFolder'] as const) {
      const request = { hash: test.hash };
      expect(await test.call(channel, request, 'pet')).toEqual({ ok: false, error: 'forbidden' });
      expect(await test.call(channel, { ...request, path: 'private' })).toEqual({ ok: false, error: 'bad-request' });
    }
    expect(await test.call('attachments:readForCopy', { hash: '../private' })).toEqual({ ok: false, error: 'bad-request' });
    expect(test.read).not.toHaveBeenCalled();
    expect(test.show).not.toHaveBeenCalled();
  });
});
