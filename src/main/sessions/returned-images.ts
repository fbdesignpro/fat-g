// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Only bytes already delivered by a CLI are ingested. The serialized queue is bounded before
// decoding; a published image uses the conversation store's existing attachment ownership.
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@shared/contracts/agent-events';
import { MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGE_BYTES } from '@shared/contracts/attachments';
import { type ImageReturnFailure, returnedImageMessageId } from '@shared/contracts/returned-images';
import { readAttachmentHeader } from '../attachments/headers';
import { type BlobFiles, sha256 } from '../attachments/files';
import type { ConversationStore, NewItem, ReservedPlace } from '../conversations/store';

export type ImageReturned = Extract<AgentEvent, { type: 'image-returned' }>;
export interface ReturnedImages {
  receive(sessionId: string, event: ImageReturned): Promise<void>;
  flush(): Promise<void>;
}
export interface ReturnedImagesDeps {
  readonly store: Pick<ConversationStore, 'reserveItem' | 'saveReturnedImage' | 'blob'>;
  readonly blobs: Pick<BlobFiles, 'write' | 'remove'>;
  readonly alive: (sessionId: string) => boolean;
  readonly changed: (sessionId: string) => void;
  readonly unsaved?: (sessionId: string, turnId: string, item: NewItem) => void;
  readonly now?: () => number;
}

const REASONS: Record<ImageReturnFailure, string> = {
  failed: 'The image generation failed.',
  missing: 'The CLI returned no image bytes to display.',
  'too-large': 'The generated image exceeds the preview limits: 5 MiB, 8,000 pixels per side and 16 million pixels per image; ten images and 20 MiB per turn.',
  invalid: 'The returned image data is invalid.',
  unsupported: 'The returned image format is not supported.',
  busy: 'The generated image could not be saved because the image queue is full.',
  'not-saved': 'The generated image could not be saved.',
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function createReturnedImages({ store, blobs, alive, changed, unsaved, now = Date.now }: ReturnedImagesDeps): ReturnedImages {
  let queue = Promise.resolve();
  let queuedBytes = 0;
  const pending = new Map<string, Promise<void>>();

  function save(sessionId: string, place: ReservedPlace, item: NewItem, failure: ImageReturnFailure): void {
    if (!alive(sessionId)) return;
    const notice: NewItem = { ...item, kind: 'notice', role: null, text: REASONS[failure] };
    try {
      if (store.saveReturnedImage(sessionId, place, notice) === 'stored') changed(sessionId);
    } catch { unsaved?.(sessionId, place.turnId, notice); }
  }

  return {
    flush: () => queue,
    receive(sessionId, event) {
      if (!alive(sessionId)) return Promise.resolve();
      const key = `${sessionId}\0${event.turnId}\0${event.workerId ?? ''}\0${event.itemId}`;
      const previous = pending.get(key);
      if (previous !== undefined) return previous;
      let place: ReservedPlace;
      try {
        place = store.reserveItem(sessionId, event.turnId);
        // Keep the attachment's place too, before another synchronous event can reserve one.
        store.reserveItem(sessionId, event.turnId);
      } catch { return Promise.resolve(); }
      const item: NewItem = { id: randomUUID(), kind: 'message', origin: 'local', providerItemId: returnedImageMessageId(event.itemId), role: 'assistant', phase: 'commentary', text: '', cut: false, questions: [], notice: null, detail: null, receivedAt: now(), providerAt: null, workerId: event.workerId ?? null };
      const estimated = event.image.kind === 'base64' ? Math.ceil(event.image.data.length / 4) * 3 : 0;
      if (estimated > MAX_IMAGE_BYTES + 2 || queuedBytes + estimated > MAX_MESSAGE_IMAGE_BYTES) {
        try { save(sessionId, place, item, estimated > MAX_IMAGE_BYTES + 2 ? 'too-large' : 'busy'); } catch { /* The store itself is unavailable. */ }
        return Promise.resolve();
      }
      queuedBytes += estimated;
      const job = queue.then(async () => {
        if (!alive(sessionId)) return;
        if (event.image.kind === 'unavailable') { save(sessionId, place, item, event.image.reason); return; }
        const data = event.image.data;
        if (data === '' || data.length % 4 !== 0 || !BASE64.test(data)) { save(sessionId, place, item, 'invalid'); return; }
        const bytes = Buffer.from(data, 'base64');
        if (bytes.toString('base64') !== data) { save(sessionId, place, item, 'invalid'); return; }
        const header = readAttachmentHeader(bytes);
        if (header.kind !== 'image') { save(sessionId, place, item, header.reason === 'too-large' ? 'too-large' : header.reason === 'unsupported' ? 'unsupported' : 'invalid'); return; }
        if (header.width * header.height > 16_000_000) { save(sessionId, place, item, 'too-large'); return; }
        const hash = sha256(bytes);
        try {
          await blobs.write(hash, header.mediaType, bytes);
          if (!alive(sessionId)) return;
          const result = store.saveReturnedImage(sessionId, place, item, { hash, mediaType: header.mediaType, bytes: bytes.length, width: header.width, height: header.height, stagedAt: now() });
          if (result === 'limit') save(sessionId, place, item, 'too-large');
          else if (result === 'stored') changed(sessionId);
        } catch { save(sessionId, place, item, 'not-saved'); }
        finally {
          // A removed session or a failed transaction must not leave an unowned image behind.
          try { if (store.blob(hash) === null) blobs.remove(hash, header.mediaType); } catch { /* The next compatible open sweeps it. */ }
        }
      }).catch(() => { /* Store failures reveal no content through logs or the app state. */ }).finally(() => {
        queuedBytes -= estimated;
        pending.delete(key);
      });
      pending.set(key, job);
      queue = job;
      return job;
    },
  };
}
