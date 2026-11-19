// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V32 (docs/planning/_archive/M16.md; C85; M15, C75, C106): what the diagnostics keep of an event. Kinds and
// counts, rebuilt field by field; a refused request under its protocol name, and under `other` for
// anything that is no such name.
import { describe, expect, it } from 'vitest';
import type { DiagnosticEvent } from '@shared/provider-kit/logger';
import { createDiagnostics } from './diagnostics';

const refused = (method: string): string => {
  const diagnostics = createDiagnostics();
  diagnostics.record({ type: 'request-refused', method });
  const [event] = diagnostics.snapshot();
  if (event?.type !== 'request-refused') throw new Error('nothing was recorded');
  return event.method;
};

describe('the diagnostics', () => {
  it('keeps a refused request under its own name, with a slash or an underscore in it (C85, C106)', () => {
    // One provider's names have a slash, the other's an underscore.
    for (const name of ['item/commandExecution/requestApproval', 'item/tool/requestUserInput', 'can_use_tool', 'hook_callback', 'mcp_message', 'elicitation', 'request_user_dialog', 'other']) {
      expect(refused(name), name).toBe(name);
    }
  });

  it('records `other` for whatever is no protocol name: a path, a sentence, a quoted string, an over-long word', () => {
    for (const text of ['C:\\Users\\someone\\secret.txt', 'please run rm -rf', 'can_use_tool; drop', '"quoted"', 'tool name', 'a.b', 'ünïcode', '_leading', '9lives', '', 'x'.repeat(65), 'a\nb']) {
      expect(refused(text), JSON.stringify(text)).toBe('other');
    }
  });

  it('rebuilds each event from its reviewed fields, so nothing rides along', () => {
    const diagnostics = createDiagnostics();
    diagnostics.record({ type: 'request-refused', method: 'can_use_tool', input: { command: 'private' } } as unknown as DiagnosticEvent);
    diagnostics.record({ type: 'frame-dropped', reason: 'oversized', line: 'private' } as unknown as DiagnosticEvent);
    diagnostics.record({ type: 'frame-dropped', reason: 'made-up' } as unknown as DiagnosticEvent);
    diagnostics.record({ type: 'stderr-observed', byteCount: 12, text: 'private' } as unknown as DiagnosticEvent);
    expect(diagnostics.snapshot()).toEqual([
      { type: 'request-refused', method: 'can_use_tool' },
      { type: 'frame-dropped', reason: 'oversized' },
      { type: 'frame-dropped', reason: 'invalid' },
      { type: 'stderr-observed', byteCount: 12 },
    ]);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('private');
  });

  it('keeps the newest events within its bounds', () => {
    const diagnostics = createDiagnostics(3);
    for (const reason of ['oversized', 'other-thread', 'other-turn', 'held-overflow', 'invalid'] as const) diagnostics.record({ type: 'frame-dropped', reason });
    expect(diagnostics.snapshot().map((event) => (event.type === 'frame-dropped' ? event.reason : event.type))).toEqual(['other-turn', 'held-overflow', 'invalid']);
  });
});
