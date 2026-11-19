// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { FailureCode } from './process';
import type { LifecycleTrace } from './lifecycle-trace';
export type DiagnosticEvent = { type: 'stderr-observed'; byteCount: number }
  | { type: 'failure'; code: FailureCode }
  | { type: 'malformed-frame' }
  | { type: 'restart-scheduled'; attempt: number; delayMs: number }
  /** A frame not taken, by reason from a closed list (M15, C19, C37, C110; M19, C8). */
  | { type: 'frame-dropped'; reason: FrameDropReason }
  /** A request from the CLI refused (C34): its method from the adapter's closed list, or `other` (C106). */
  | { type: 'request-refused'; method: string };
/**
 * `unopened-item`, `completed-item`: a delta for a message that nothing opened, or that is already
 * complete (M19, C8) — and, from M20a, the end of an activity that nothing opened (C6).
 * `other-worker`: a worker's frame that no worker claimed in time (M20a, C22).
 * `ended-aside`: a reply or a frame of an aside whose turn had been stopped, or had ended (M20b, C15, C70).
 */
export const FRAME_DROP_REASONS = ['oversized', 'other-thread', 'other-turn', 'held-overflow', 'invalid', 'unopened-item', 'completed-item', 'other-worker', 'ended-aside'] as const;
export type FrameDropReason = (typeof FRAME_DROP_REASONS)[number];
export interface DiagnosticLogger { record(event: DiagnosticEvent): void; readonly trace?: LifecycleTrace | undefined }
