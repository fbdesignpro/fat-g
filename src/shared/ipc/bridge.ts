// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The shape of `window.fatg` — the ONLY surface the sandboxed renderer can reach outside the DOM.
// Types only, apart from the key: the preload implements it, src/renderer/src/ipc/client.ts is the
// one place that calls it. This file must stay free of runtime dependencies because the sandboxed
// preload bundles it.
import type { InvokeChannel, PushChannel } from './channels';
import type { InvokeRequest, InvokeResponse, PushMap } from './contract';
import type { IpcResult } from './result';

export const BRIDGE_KEY = 'fatg';

export interface FatgBridge {
  /** `process.platform` of the host ('win32' | 'darwin' | 'linux' | …), for platform-specific chrome. */
  readonly platform: string;
  /**
   * Calls a main-process handler. Resolves with an envelope for everything main decided, refusals
   * included; rejects only when main could not be reached or the channel is not allowlisted.
   */
  invoke<C extends InvokeChannel>(channel: C, request: InvokeRequest<C>): Promise<IpcResult<InvokeResponse<C>>>;
  /** Listens on a push channel. Returns the function that stops listening. */
  on<C extends PushChannel>(channel: C, listener: (payload: PushMap[C]) => void): () => void;
  /**
   * Tells main the folder an image the user dropped came from, so the next image chooser opens there
   * (decision 0036). The preload reads the file's path and sends it to main itself: the page never
   * holds it. Nothing is answered.
   */
  noteDroppedFile(file: File): void;
}
