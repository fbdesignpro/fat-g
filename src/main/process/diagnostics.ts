// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type DiagnosticEvent, type DiagnosticLogger, FRAME_DROP_REASONS } from '@shared/provider-kit/logger';
import type { LifecycleTrace } from '@shared/provider-kit/lifecycle-trace';

/** Metadata only, in memory. In particular stderr is counted, never redacted with heuristics. */
export function createDiagnostics(maxEvents = 200, maxBytes = 32 * 1024, trace?: LifecycleTrace): DiagnosticLogger & { snapshot(): DiagnosticEvent[] } {
  const entries: { event: DiagnosticEvent; bytes: number }[] = [];
  let bytes = 0;
  return {
    trace: trace === undefined ? undefined : (event) => { try { trace(event); } catch { /* diagnostic sinks are observers */ } },
    record(event) {
      // Reconstruct fields so an object with extra runtime properties cannot leak through.
      let safe: DiagnosticEvent;
      switch (event.type) {
        case 'stderr-observed': safe = { type: event.type, byteCount: event.byteCount }; break;
        case 'failure': safe = { type: event.type, code: event.code }; break;
        case 'malformed-frame': safe = { type: event.type }; break;
        case 'restart-scheduled': safe = { type: event.type, attempt: event.attempt, delayMs: event.delayMs }; break;
        case 'frame-dropped': safe = { type: event.type, reason: FRAME_DROP_REASONS.includes(event.reason) ? event.reason : 'invalid' }; break;
        // A method the adapter names from its closed list: a protocol word, never a string the CLI chose
        // (C106). Letters, slashes and underscores: one provider names its requests `a/b`, another
        // `a_b` (M16, C85), and anything else is no name of either.
        case 'request-refused': safe = { type: event.type, method: /^[A-Za-z][A-Za-z/_]{0,63}$/.test(event.method) ? event.method : 'other' }; break;
      }
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (size > maxBytes) return;
      entries.push({ event: safe, bytes: size });
      bytes += size;
      while (entries.length > maxEvents || bytes > maxBytes) bytes -= entries.shift()!.bytes;
    },
    snapshot: () => entries.map(({ event }) => ({ ...event })),
  };
}
