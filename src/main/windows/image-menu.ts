// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { Menu, type BrowserWindow } from 'electron';
import { isAttachmentHash } from '@shared/contracts/attachments';
import { isTrustedPageUrl, type TrustedOrigins } from '../app/origins';

/** Only attachment images already displayed by Chromium may be copied. No file read or IPC. */
export function attachImageMenu(window: BrowserWindow, origins: TrustedOrigins): void {
  const contents = window.webContents;
  contents.on('context-menu', (_event, params) => {
    if (!isTrustedPageUrl(params.pageURL, origins) || params.mediaType !== 'image' || !params.hasImageContents || !isAttachmentImage(params.srcURL)) return;
    Menu.buildFromTemplate([{
      label: 'Copy image',
      click: () => {
        if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
      },
    }]).popup({ window });
  });
}

function isAttachmentImage(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === 'app:' && url.host === 'media' && url.username === '' && url.password === ''
      && url.search === '' && url.hash === '' && url.pathname.startsWith('/attachments/')
      && isAttachmentHash(url.pathname.slice('/attachments/'.length));
  } catch {
    return false;
  }
}
