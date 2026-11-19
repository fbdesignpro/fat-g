// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sending something to the windows after it changes, without sending it once per change.
//
// Coalescing, not debouncing: the first change schedules one flush and later changes ride along.
// A steady stream of updates therefore still reaches the windows every `delayMs`, instead of being
// postponed for as long as the stream lasts.
//
// Pushes are best-effort — a window that is still loading misses them — which is fine, because
// every window fetches the current value once its page has loaded.
//
// Electron-free: windows arrive as targets (src/main/windows/window-manager.ts), so this is tested
// with fake timers and no Electron at all.
import type { PushChannel, WindowKind } from '@shared/ipc/channels';
import type { PushMap } from '@shared/ipc/contract';

export interface BroadcastTarget {
  readonly kind: WindowKind;
  /** False once the window is closing or gone; such targets are skipped. */
  isAlive(): boolean;
  send<C extends PushChannel>(channel: C, payload: PushMap[C]): void;
}

export interface CoalescedPushOptions<C extends PushChannel> {
  readonly channel: C;
  /** Called whenever there may be something new to send. */
  readonly subscribe: (listener: () => void) => () => void;
  /** What a window of this kind should receive right now — or `null` if it receives nothing. */
  readonly payloadFor: (kind: WindowKind) => PushMap[C] | null;
  /** Read at flush time, so windows opened or closed in between are handled. */
  readonly targets: () => Iterable<BroadcastTarget>;
  readonly delayMs?: number;
  readonly log?: Pick<Console, 'error'>;
}

/** About one frame: merges bursts without adding latency anyone can see. */
export const PUSH_DELAY_MS = 16;

/** Starts pushing; returns the function that stops. */
export function startCoalescedPush<C extends PushChannel>({
  channel,
  subscribe,
  payloadFor,
  targets,
  delayMs = PUSH_DELAY_MS,
  log = console,
}: CoalescedPushOptions<C>): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    // One payload per window kind per flush, however many windows of that kind there are.
    const byKind = new Map<WindowKind, PushMap[C] | null>();
    for (const target of targets()) {
      if (!target.isAlive()) continue;
      if (!byKind.has(target.kind)) byKind.set(target.kind, payloadFor(target.kind));
      const payload = byKind.get(target.kind);
      if (payload === null || payload === undefined) continue;
      try {
        target.send(channel, payload);
      } catch (error) {
        // One broken window must not starve the others, or crash main from a timer callback.
        log.error(`[push] could not send ${channel} to the ${target.kind} window`, error);
      }
    }
  };

  const unsubscribe = subscribe(() => {
    timer ??= setTimeout(flush, delayMs);
  });

  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
