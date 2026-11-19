// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V11 (docs/planning/_archive/M23.md; C14, C75, C79): the attachments channel and the draft's, through the
// real contract — the Main window alone, bytes within the bound before anything is forwarded, a name
// bounded, and what main says of a staging its outcome's kind alone.
import { describe, expect, it, vi } from 'vitest';
import { type AttachmentStageResult, MAX_IMAGE_BYTES, MAX_STAGE_NAME } from '@shared/contracts/attachments';
import { MAX_STAGE_BYTES, stageBytesWithin } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { attachmentHandlers } from './attachments';
import { createKindCounts } from './counts';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const HASH = 'b'.repeat(64);
const log = { warn: vi.fn(), error: vi.fn() };
const deps = (): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail: 'kinds' });
const from = (kind: 'main' | 'pet', request: unknown) => ({ windowKind: kind, sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });

function setup(answer: AttachmentStageResult = { status: 'staged', attachment: { id: 'use-1', hash: HASH, mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'PRIVATE-NAME.png' } }) {
  const stage = vi.fn(() => Promise.resolve(answer));
  const counts = createKindCounts();
  const handler = attachmentHandlers({ stage }, counts)['attachments:stage'] as Handler<unknown, unknown>;
  const ask = (kind: 'main' | 'pet', request: unknown) => dispatchInvoke('attachments:stage', INVOKE_SPECS['attachments:stage'], handler, from(kind, request), deps());
  return { stage, counts, ask };
}

describe('attachments:stage (V4, V11; C14, C79)', () => {
  it('hands the session, the bytes and the name to the runtime, and counts the outcome by kind alone', async () => {
    const { stage, counts, ask } = setup();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await ask('main', { sessionId: SESSION, bytes, name: 'PRIVATE-NAME.png' })).toMatchObject({ ok: true, value: { status: 'staged' } });
    expect(stage).toHaveBeenCalledWith(SESSION, bytes, 'PRIVATE-NAME.png');
    expect(JSON.stringify(counts.snapshot())).not.toMatch(/PRIVATE|bbbb/);
    expect(counts.snapshot()).toEqual({ 'staged:png': 1 });
  });

  it('refuses the Pet, as forbidden', async () => {
    const { stage, ask } = setup();
    expect(await ask('pet', { sessionId: SESSION, bytes: new Uint8Array([1]) })).toEqual({ ok: false, error: 'forbidden' });
    expect(stage).not.toHaveBeenCalled();
  });

  it('refuses bytes past the bound, no bytes, a name past its bound, a path, and anything more', async () => {
    const { stage, ask } = setup();
    for (const request of [
      { sessionId: SESSION, bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) },
      { sessionId: SESSION, bytes: new Uint8Array(0) },
      { sessionId: SESSION, bytes: [1, 2, 3] },
      { sessionId: SESSION, bytes: 'aGVsbG8=' },
      { sessionId: SESSION, bytes: new Uint8Array([1]), name: 'x'.repeat(MAX_STAGE_NAME + 1) },
      { sessionId: SESSION, bytes: new Uint8Array([1]), path: 'C:\\Users\\someone\\cat.png' },
      { sessionId: 'not-a-session', bytes: new Uint8Array([1]) },
    ]) expect(await ask('main', request)).toEqual({ ok: false, error: 'bad-request' });
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('the preload’s bound (V11; C79)', () => {
  it('is the one-image bound', () => {
    expect(MAX_STAGE_BYTES).toBe(MAX_IMAGE_BYTES);
  });

  it('passes a view within it, and nothing else', () => {
    expect(stageBytesWithin({ bytes: new Uint8Array(1) })).toBe(true);
    expect(stageBytesWithin({ bytes: new Uint8Array(MAX_STAGE_BYTES) })).toBe(true);
    expect(stageBytesWithin({ bytes: new Uint8Array(MAX_STAGE_BYTES + 1) })).toBe(false);
    expect(stageBytesWithin({ bytes: new Uint8Array(0) })).toBe(false);
    expect(stageBytesWithin({ bytes: [1] })).toBe(false);
    expect(stageBytesWithin(null)).toBe(false);
    // A small view of a large buffer is measured as the view: what is sent is the view.
    const big = new ArrayBuffer(MAX_STAGE_BYTES * 2);
    expect(stageBytesWithin({ bytes: new Uint8Array(big, 0, 10) })).toBe(true);
    expect(stageBytesWithin({ bytes: new Uint8Array(big) })).toBe(false);
  });
});
