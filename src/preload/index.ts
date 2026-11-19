// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sandboxed preload: runs with access to `electron`'s renderer-side modules only, and is bundled
// into a single CommonJS file shared by every window.
//
// It is deliberately a dumb pipe: an allowlist of channel names and nothing else. Payloads are
// validated in main, behind the trust boundary — checking them here would prove nothing, since
// the page is untrusted. Never expose `ipcRenderer` itself, or anything that would hand the page
// a general-purpose capability.
import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from 'electron';
import { BRIDGE_KEY, type FatgBridge } from '@shared/ipc/bridge';
import { BYTE_FIELDS, byteField, bytesWithin, isInvokeChannel, isPushChannel, PRELOAD_ONLY_CHANNELS } from '@shared/ipc/channels';

const bridge: FatgBridge = {
  platform: process.platform,

  invoke(channel, request) {
    if (!isInvokeChannel(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
    // A dropped file's path is the preload's to read and send (decision 0036): never a page's to name.
    if (PRELOAD_ONLY_CHANNELS.has(channel)) return Promise.reject(new Error(`Not a page's channel: ${channel}`));
    // An image's bytes past the one-image bound go no further than here (M23, C79; decision 0036):
    // the one payload the pipe measures, so a page cannot hand main an outsized copy to make. Main
    // checks again.
    const fields = BYTE_FIELDS[channel];
    if (fields !== undefined) {
      if (!bytesWithin(request, fields)) return Promise.reject(new Error('Image bytes outside the bound'));
      // Each view's own bytes alone, in a buffer of their size: never a backing buffer the bound did not measure.
      const copy: Record<string, unknown> = { ...(request as object) };
      for (const field of fields.map(byteField)) if (copy[field] instanceof Uint8Array) copy[field] = copy[field].slice();
      return ipcRenderer.invoke(channel, copy);
    }
    return ipcRenderer.invoke(channel, request);
  },

  noteDroppedFile(file) {
    let filePath: string;
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {
      return;
    }
    // A file with no path — one made in a page, or dragged from a browser — leaves the chooser where it was.
    if (filePath === '') return;
    ipcRenderer.invoke('avatars:noteDropped', { path: filePath }).catch(() => undefined);
  },

  on(channel, listener) {
    if (!isPushChannel(channel)) throw new Error(`Unknown IPC channel: ${String(channel)}`);
    // Forward the payload only: the event's `sender` IS ipcRenderer, and handing the event to the
    // page would hand it ipcRenderer too.
    const forward = (_event: IpcRendererEvent, payload: Parameters<typeof listener>[0]): void => listener(payload);
    ipcRenderer.on(channel, forward);
    return () => {
      ipcRenderer.removeListener(channel, forward);
    };
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
