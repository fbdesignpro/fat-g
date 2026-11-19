// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The attachments channel (docs/planning/_archive/M23.md, Design 2, 10; C14, C79; decision 0030). The page names
// a session and hands over an image's bytes, read with the File API, with a dropped file's name where
// it had one; the bytes' bound was checked in the preload and is checked again by the contract and in
// main before anything is copied. Whether the bytes are an image fat-g takes, and whether it is kept,
// is the runtime's to work out. What main says of a staging is its outcome's kind, counted: never a
// name, a hash, a size in pixels or a byte of the image (C75).
//
// The Main window's only: an image the user pasted or dropped is conversation content, and the Pet,
// which shows on screen shares, is refused as `forbidden` by the contract.
import type { SessionRuntime } from '../../sessions/runtime';
import type { InvokeHandlers } from '../dispatch';
import { createKindCounts, type KindCounts } from './counts';

export function attachmentHandlers(runtime: Pick<SessionRuntime, 'stage'>, counts: KindCounts = createKindCounts()): Pick<InvokeHandlers, 'attachments:stage'> {
  return {
    async 'attachments:stage'({ sessionId, bytes, name }) {
      const answer = await runtime.stage(sessionId, bytes, name);
      counts.add(answer.status === 'staged' ? `staged:${answer.attachment.mediaType.slice('image/'.length)}` : `refused:${answer.reason}`);
      return answer;
    },
  };
}
