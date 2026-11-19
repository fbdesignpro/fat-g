// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Gives one window its invoke handlers. Deliberately thin: every decision is made in the pure
// dispatch.ts / sender-policy.ts, which is where the tests are.
//
// Handlers are registered on the window's OWN `webContents.ipc` (not the global ipcMain), with the
// window's kind captured below. So a window's kind is fixed by construction rather than looked up
// per call, a webContents we never registered has no handlers at all, and the handlers go away
// with their window.
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { INVOKE_CHANNELS, type InvokeChannel, type WindowKind } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { dispatchInvoke, type DispatchDeps, type InvokeHandlers } from './dispatch';
import type { SenderFacts } from './sender-policy';

export function attachIpcHandlers(contents: WebContents, windowKind: WindowKind, handlers: InvokeHandlers, deps: DispatchDeps): void {
  const attach = <C extends InvokeChannel>(channel: C): void => {
    const spec = INVOKE_SPECS[channel];
    const handler = handlers[channel];
    contents.ipc.handle(channel, (event, request: unknown) =>
      dispatchInvoke(channel, spec, handler, { windowKind, sender: readSenderFacts(event), request }, deps),
    );
  };
  for (const channel of INVOKE_CHANNELS) attach(channel);
}

/**
 * Must run synchronously on entry, before any await: `senderFrame` becomes null once the frame
 * navigates or is destroyed (routine under HMR), and WebFrameMain getters throw after disposal.
 */
function readSenderFacts(event: IpcMainInvokeEvent): SenderFacts {
  try {
    const frame = event.senderFrame;
    if (frame === null) return { frameUrl: null, isTopFrame: false };
    return { frameUrl: frame.url, isTopFrame: frame.parent === null };
  } catch {
    return { frameUrl: null, isTopFrame: false };
  }
}
