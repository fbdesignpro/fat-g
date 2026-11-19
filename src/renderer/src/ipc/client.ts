// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The renderer's only door to the main process: nothing else touches `window.fatg.invoke/on`, so
// this is the one place that knows the wire format.
import type { InvokeChannel, PushChannel } from '@shared/ipc/channels';
import type { InvokeRequest, InvokeResponse, PushMap } from '@shared/ipc/contract';
import type { IpcErrorCode, IpcResult } from '@shared/ipc/result';

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode) {
    super(`IPC call failed: ${code}`);
    this.name = 'IpcError';
    this.code = code;
  }
}

/** Calls a main-process handler and returns its value; anything else throws an IpcError. */
export async function invoke<C extends InvokeChannel>(channel: C, request: InvokeRequest<C>): Promise<InvokeResponse<C>> {
  let result: IpcResult<InvokeResponse<C>>;
  try {
    result = await window.fatg.invoke(channel, request);
  } catch {
    // Electron-level failure — the window is closing, or the channel is not allowlisted — so no
    // envelope came back. Normalized so callers only ever see one error shape.
    throw new IpcError('unavailable');
  }
  if (!result.ok) throw new IpcError(result.error);
  return result.value;
}

/** Tells main the folder a dropped image came from, for the next image chooser (decision 0036): the preload reads its path, the page never does. */
export function noteDroppedFile(file: File): void {
  window.fatg.noteDroppedFile(file);
}

/** Listens on a push channel. Returns the function that stops listening. */
export function subscribe<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void {
  return window.fatg.on(channel, listener);
}
