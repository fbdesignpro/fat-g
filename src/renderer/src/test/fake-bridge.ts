// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A scriptable stand-in for `window.fatg` (the preload bridge) in jsdom tests.
import type { FatgBridge } from '@shared/ipc/bridge';
import type { InvokeChannel, PushChannel } from '@shared/ipc/channels';
import type { PushMap } from '@shared/ipc/contract';
import { resetComposers } from '../chat/composer/composer-store';
import { resetImageFiles } from '../chat/image-files';

type InvokeImpl = (channel: InvokeChannel, request: unknown) => Promise<unknown>;

export interface FakeBridge {
  /** Every call in order, e.g. `on:state:snapshot` then `invoke:state:getSnapshot`, or `noteDropped:<file name>`. */
  readonly calls: string[];
  /** Replaces what `invoke` does. By default it never settles, like a main process that is busy. */
  setInvoke(impl: InvokeImpl): void;
  /** Delivers a push to the current listeners, as main would. */
  push<C extends PushChannel>(channel: C, payload: PushMap[C]): void;
  listenerCount(channel: PushChannel): number;
}

const pending = (): Promise<never> => new Promise<never>(() => undefined);

export function installFakeBridge(platform = 'test-os'): FakeBridge {
  // A new bridge is a new main: what the page held of main's composers, and its unsent text, goes (M23),
  // and so do the ids main gave image files for its run (decision 0022, item 15).
  resetComposers();
  resetImageFiles();
  const calls: string[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let invokeImpl: InvokeImpl = pending;

  const bridge = {
    platform,
    invoke: (channel: InvokeChannel, request: unknown) => {
      calls.push(`invoke:${channel}`);
      return invokeImpl(channel, request);
    },
    noteDroppedFile: (file: File) => {
      calls.push(`noteDropped:${file.name}`);
    },
    on: (channel: PushChannel, listener: (payload: unknown) => void) => {
      calls.push(`on:${channel}`);
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => {
        set.delete(listener);
      };
    },
  } as unknown as FatgBridge;

  Object.defineProperty(window, 'fatg', { value: bridge, configurable: true });

  return {
    calls,
    setInvoke: (impl) => {
      invokeImpl = impl;
    },
    push: (channel, payload) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
  };
}
