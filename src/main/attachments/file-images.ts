// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An attachment path reported by an agent is a claim, just like a project-file reference. Match it
// to an active blob, then use the attachment source's size/hash/header checks. No general read of
// fat-g's data folder is allowed, and no file supplied by the claim is opened.
import type { OwnedImageFiles } from '../files/images';
import { isLocalPath, pathLib } from '../files/confine';
import type { HeldImage } from '../media/attachments';
import type { MediaSource } from '../media/route';
import { blobHashOfPath } from './files';

export interface AttachmentImageFilesDeps {
  readonly root: string;
  readonly platform: string;
  readonly image: (hash: string) => HeldImage | null;
  readonly source: Pick<MediaSource, 'serve'>;
  /** Main resolves the owned file and refuses missing files, links and redirected descendants. */
  readonly locate: (hash: string) => string | null;
}

export function createAttachmentImageFiles({ root, platform, image, source, locate }: AttachmentImageFilesDeps): OwnedImageFiles {
  const paths = pathLib(platform);
  const identify = (file: string) => {
    if (!isLocalPath(file, platform)) return null;
    const named = blobHashOfPath(root, file, paths);
    if (named === null) return null;
    const held = image(named.hash);
    return held?.mediaType === named.mediaType ? named : null;
  };
  return {
    owns: (file) => identify(file) !== null,
    async read(file) {
      const named = identify(file);
      if (named === null) return null;
      const real = locate(named.hash);
      if (real === null || !isLocalPath(real, platform)) return null;
      const answer = await source.serve(named.hash);
      // Recheck ownership and location after the asynchronous read as well.
      if (answer.status !== 200 || answer.contentType !== named.mediaType || identify(file) === null || locate(named.hash) !== real) return null;
      return answer.body;
    },
  };
}
