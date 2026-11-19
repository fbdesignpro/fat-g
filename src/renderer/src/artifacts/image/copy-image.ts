// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AttachmentCopySource } from '@shared/contracts/attachments';
import { invoke } from '../../ipc/client';

/** A user-initiated, transient read. Decode in Chromium so every supported attachment format works. */
export function copyImage(hash: string): Promise<void> {
  return copyFrom(() => invoke('attachments:readForCopy', { hash }));
}

/** An image file's (decision 0022, item 15), by the id main gave it for the run: main reads it again and checks it. */
export function copyImageFile(sessionId: string, id: string): Promise<void> {
  return copyFrom(() => invoke('files:readImageForCopy', { sessionId, id }));
}

function copyFrom(read: () => Promise<AttachmentCopySource | null>): Promise<void> {
  const png = (async (): Promise<Blob> => {
    const source = await read();
    if (source === null) throw new Error('image unavailable');
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(source.bytes)], { type: source.mediaType }));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('image unavailable');
      try {
        context.drawImage(bitmap, 0, 0);
        return await canvas.convertToBlob({ type: 'image/png' });
      } finally { canvas.width = 0; canvas.height = 0; }
    } finally { bitmap.close(); }
  })();
  // Supply the promise immediately, while the press still grants clipboard activation.
  // Handle it even if the clipboard refuses before asking for the data.
  void png.catch(() => undefined);
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
