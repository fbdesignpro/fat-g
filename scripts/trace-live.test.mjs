// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceLine, observeProcesses } from './trace-live.mjs';

test('disk boundary drops arbitrary output, keys and strings', () => {
  assert.equal(traceLine('private raw output'), null);
  assert.equal(traceLine('[fatg-trace] {bad'), null);
  const event = { version: 1, at: 10, elapsedMs: 1, appPid: 42, phase: 'reply', pid: 43, operation: 'resume', refusal: 'active-writer', message: 'private', reference: 'private', numericCode: -32600 };
  const saved = traceLine(`[fatg-trace] ${JSON.stringify(event)}`);
  assert.equal(saved.refusal, 'active-writer');
  assert.ok(!JSON.stringify(saved).includes('private'));
  assert.equal(traceLine(`[fatg-trace] ${JSON.stringify({ ...event, phase: 'private' })}`), null);
  assert.equal(traceLine(`[fatg-trace] ${JSON.stringify({ ...event, pid: 'private' })}`), null);
});

test('observer follows surviving descendants after parent death and ignores unrelated PID reuse', () => {
  const tracked = new Map(); const roots = new Set([10]);
  const root = { pid: 10, parent: 1, born: 'root' };
  const child = { pid: 20, parent: 10, born: 'child' };
  const other = { pid: 99, parent: 1, born: 'unrelated' };
  assert.equal(observeProcesses([root, child, other], roots, tracked, 100).length, 2);
  const exits = observeProcesses([child, other], roots, tracked, 200);
  assert.deepEqual(exits, [{ source: 'observer', at: 200, phase: 'observed-exit', pid: 10, lastSeenAt: 100, born: 'root' }]);
  const reuse = { pid: 10, parent: 1, born: 'replacement' };
  const unrelatedChild = { pid: 30, parent: 10, born: 'unrelated-child' };
  const next = observeProcesses([reuse, unrelatedChild, other], roots, tracked, 300);
  assert.equal(next.length, 1); assert.equal(next[0].pid, 20);
  assert.equal(tracked.has(30), false);
});
