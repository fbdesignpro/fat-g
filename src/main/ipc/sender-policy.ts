// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Who may call an IPC channel. Pure — no Electron imports — so every refusal is table-tested;
// src/main/ipc/router.ts reads the facts off the Electron event and asks here.
import type { WindowKind } from '@shared/ipc/channels';
import { isTrustedPageUrl, type TrustedOrigins } from '../app/origins';

export interface SenderFacts {
  /** URL of the sending frame, or null when the frame has navigated away or been destroyed. */
  readonly frameUrl: string | null;
  /** True when the sender is its window's top-level frame rather than an iframe. */
  readonly isTopFrame: boolean;
}

export type SenderRefusal = 'frame-gone' | 'subframe' | 'untrusted-origin' | 'window-kind';

export type SenderCheck = { readonly ok: true } | { readonly ok: false; readonly reason: SenderRefusal };

const refuse = (reason: SenderRefusal): SenderCheck => ({ ok: false, reason });

/**
 * Checks, in order: the frame still exists, it is the top frame (subframes cannot reach IPC with
 * `nodeIntegrationInSubFrames` off; this is defence in depth), it shows one of our own pages, and
 * the window's kind may use the channel.
 */
export function checkSender(
  sender: SenderFacts,
  windowKind: WindowKind,
  allowedKinds: readonly WindowKind[],
  origins: TrustedOrigins,
): SenderCheck {
  if (sender.frameUrl === null) return refuse('frame-gone');
  if (!sender.isTopFrame) return refuse('subframe');
  if (!isTrustedPageUrl(sender.frameUrl, origins)) return refuse('untrusted-origin');
  if (!allowedKinds.includes(windowKind)) return refuse('window-kind');
  return { ok: true };
}
