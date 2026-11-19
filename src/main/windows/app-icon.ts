// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { app, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import normalPath from '../../../build/icon.png?asset';
import attentionPath from '../../../build/icon-attention.png?asset';
import normalIcoPath from '../../../build/icon.ico?asset';
import attentionIcoPath from '../../../build/icon-attention.ico?asset';
import type { AppStateStore } from '../state/app-state-store';
import { followAttentionIcon } from './attention-icon';

// Decoded once per application run, after ready. No image work during streaming state updates.
let images: { normal: NativeImage; attention: NativeImage } | undefined;

// ICO-backed NativeImages let Electron request the matching prefiltered HICON size on Windows.
// A PNG-backed NativeImage gives Windows one large bitmap regardless of the requested icon size.
export const appIconPath = process.platform === 'win32' ? normalIcoPath : normalPath;

/** Native shell glue: macOS owns a Dock image, Windows/Linux a window image. */
export function followAppIcon(window: BrowserWindow, store: AppStateStore): void {
  images ??= {
    normal: nativeImage.createFromPath(appIconPath),
    attention: nativeImage.createFromPath(process.platform === 'win32' ? attentionIcoPath : attentionPath),
  };
  const icons = images;
  const stop = followAttentionIcon(store, (attention) => {
    if (window.isDestroyed()) return;
    const image = attention ? icons.attention : icons.normal;
    if (process.platform === 'darwin') app.dock?.setIcon(image);
    else window.setIcon(image);
  });
  window.once('closed', stop);
}
