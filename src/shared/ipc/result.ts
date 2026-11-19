// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What every invoke call resolves to. A failure carries only a code — never a message, stack or
// path — so nothing from inside the main process can reach a page by accident. The renderer
// turns codes into words.

export type IpcErrorCode =
  /** The request payload failed validation in main. */
  | 'bad-request'
  /** The calling page may not use this channel: wrong origin, not the top frame, or wrong window kind. */
  | 'forbidden'
  /** The handler failed. Details are logged in main only. */
  | 'internal'
  /** Main could not be reached at all (window closing, channel not allowlisted). Produced renderer-side. */
  | 'unavailable';

export type IpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: IpcErrorCode };

export function ipcOk<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function ipcFail(error: IpcErrorCode): IpcResult<never> {
  return { ok: false, error };
}
