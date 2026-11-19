// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The media route's image files source (decision 0022, item 15): an image file on this machine's own
// disks — one an agent read, or one a reference names — by the id main gave it for the run when it
// was read (src/main/files/images.ts). The id must be one the run holds, of a session still listed;
// its file is checked again at each request, and served only where it is still the same file, of the
// same type, size and content digest. Nothing of the request but its id is used, and no path is read from it.
//
// Electron-free: the image files' serving arrives as a function.
import { IMAGE_FILE_ID } from '@shared/contracts/files';
import type { ImageFiles } from '../files/images';
import type { MediaSource, SourceAnswer } from './route';

export const FILES_SOURCE = 'files';

export function createImageFileSource({ serve }: Pick<ImageFiles, 'serve'>): MediaSource {
  return {
    name: FILES_SOURCE,
    // Kept in no cache of Chromium's, as a chat's attachment is: nothing of it persists.
    cache: 'no-store',
    async serve(id): Promise<SourceAnswer> {
      if (!IMAGE_FILE_ID.test(id)) return { status: 404, kind: 'id' };
      const answer = await serve(id);
      return answer.ok ? { status: 200, body: answer.bytes, contentType: answer.mediaType } : { status: 404, kind: answer.kind };
    },
  };
}
