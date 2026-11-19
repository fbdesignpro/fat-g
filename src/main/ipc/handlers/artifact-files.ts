// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { isAttachmentMediaType } from '@shared/contracts/attachments';
import type { MediaSource } from '../../media/route';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';

export interface ArtifactFileDeps {
  readonly attachments: MediaSource;
  readonly attachmentPath: (hash: string) => string | null;
}

/** No paths arrive from the page. The owning stores resolve and validate each existing file. */
export function artifactFileHandlers(deps: ArtifactFileDeps, showInFolder: (file: string) => void): Pick<InvokeHandlers, 'attachments:readForCopy' | 'attachments:showInFolder'> {
  const show = (file: string | null): null => {
    if (file === null) throw new InvalidIpcRequest();
    showInFolder(file);
    return null;
  };
  return {
    async 'attachments:readForCopy'({ hash }) {
      const answer = await deps.attachments.serve(hash);
      if (answer.status !== 200 || !isAttachmentMediaType(answer.contentType)) return null;
      return { bytes: answer.body, mediaType: answer.contentType };
    },
    'attachments:showInFolder': ({ hash }) => show(deps.attachmentPath(hash)),
  };
}
