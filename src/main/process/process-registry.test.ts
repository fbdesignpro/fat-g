// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, expect, it, vi } from 'vitest';
import { createProcessRegistry } from './process-registry';
import { createDiagnostics } from './diagnostics';
afterEach(() => vi.useRealTimers());
it('closes admission synchronously, reuses cleanup and reports failed kills', async () => {
  const registry = createProcessRegistry(); const stop = vi.fn(() => Promise.resolve({ ok: false }));
  registry.register({ stop, emergency: () => ({ ok: false }) }); const first = registry.killAll(); expect(registry.killAll()).toBe(first);
  expect(() => registry.assertOpen()).toThrow('disposed'); expect((await first).ok).toBe(false); expect(stop).toHaveBeenCalledTimes(1);
});
it('bounds a hung termination and invokes emergency once', async () => {
  vi.useFakeTimers(); const registry = createProcessRegistry(100); const emergency = vi.fn(() => ({ ok: false }));
  registry.register({ stop: () => new Promise(() => {}), emergency }); const cleanup = registry.killAll(); await vi.advanceTimersByTimeAsync(100);
  expect(await cleanup).toEqual({ ok: false }); registry.emergency(); registry.emergency(); expect(emergency).toHaveBeenCalledTimes(1);
});
it('keeps bounded diagnostics and drops unexpected raw fields', () => {
  const log = createDiagnostics(2, 500); const event = { type: 'stderr-observed', byteCount: 20, raw: 'secret@example.test' } as const;
  log.record(event); log.record({ type: 'malformed-frame' }); log.record(event);
  expect(log.snapshot()).toHaveLength(2); expect(JSON.stringify(log.snapshot())).not.toContain('secret');
  const tiny = createDiagnostics(200, 70); for (let i = 0; i < 200; i++) tiny.record(event); expect(JSON.stringify(tiny.snapshot()).length).toBeLessThan(75);
});
