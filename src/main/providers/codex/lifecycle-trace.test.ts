// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { codexSessionTrace } from './lifecycle-trace';

describe('Codex diagnostic classifications', () => {
  const writer = 'thread 00000000-0000-4000-8000-000000000001 already has an active writer';
  it('recognizes only the exact resume refusal without retaining its reference', () => {
    expect(codexSessionTrace.refusal('thread/resume', writer)).toBe('active-writer');
    for (const message of [null, {}, 'no rollout found for private reference', `${writer}: private detail`, `private prefix ${writer}`]) expect(codexSessionTrace.refusal('thread/resume', message)).toBe('other');
    expect(codexSessionTrace.refusal('turn/start', writer)).toBe('other');
  });
  it('emits turn metadata only and uses closed fallback values', () => {
    expect(codexSessionTrace.operation('private-method')).toBe('other');
    expect(codexSessionTrace.notification('item/completed', { text: 'private answer' })).toBeNull();
    expect(codexSessionTrace.notification('turn/completed', { threadId: 'private', turn: { status: 'completed', error: { message: 'private' } } })).toEqual({ phase: 'turn-completed', outcome: 'completed' });
    expect(codexSessionTrace.notification('turn/completed', { turn: { status: 'private' } })).toEqual({ phase: 'turn-completed', outcome: 'unknown' });
  });
});
