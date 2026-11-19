// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0033: what the context meter draws of a reading — its cells, its red line, and its
// tooltip's sections — apart from the page.
import { describe, expect, it } from 'vitest';
import type { ContextReading } from '@shared/contracts/sessions';
import { CONTEXT_CELLS, contextCells, contextPercent, contextSections } from './context-view';

const reading = (used: number, window = 200_000, compactAt?: number | null): ContextReading => ({ used, window, ...(compactAt === undefined ? {} : { compactAt }) });

describe('the meter’s cells', () => {
  it('are 30, two rows of fifteen', () => {
    expect(CONTEXT_CELLS).toBe(30);
  });

  it('fill by the share used, rounded, and at least one for a context that holds anything; none with no reading', () => {
    expect(contextCells(undefined)).toEqual({ filled: 0, compactFrom: null });
    expect(contextCells(reading(0)).filled).toBe(0);
    expect(contextCells(reading(1)).filled).toBe(1);
    expect(contextCells(reading(100_000)).filled).toBe(15);
    expect(contextCells(reading(23_605, 1_000_000)).filled).toBe(1);
    expect(contextCells(reading(240_000)).filled).toBe(30);
  });

  it('are red from the cell the CLI’s line falls in; none where it gives no line, says it compacts nothing, or draws it past the window', () => {
    // A 200,000 window that compacts at 167,000: 83.5 % of 30 falls in cell 25.
    expect(contextCells(reading(10, 200_000, 167_000)).compactFrom).toBe(25);
    // A 1M window at 967,000: the last cell alone.
    expect(contextCells(reading(10, 1_000_000, 967_000)).compactFrom).toBe(29);
    expect(contextCells(reading(10)).compactFrom).toBeNull();
    expect(contextCells(reading(10, 200_000, null)).compactFrom).toBeNull();
    expect(contextCells(reading(10, 200_000, 200_000)).compactFrom).toBeNull();
  });

  it('say the share as a whole percent', () => {
    expect(contextPercent(reading(23_605, 1_000_000))).toBe(2);
    expect(contextPercent(reading(161_500))).toBe(81);
  });
});

describe('the tooltip’s sections', () => {
  const messages = { toolCalls: 12_000, toolResults: 44_000, answers: 16_000, prompts: 8_000, attachments: 0, other: 0 };
  const full: ContextReading = {
    used: 99_000, window: 200_000, compactAt: 167_000,
    parts: [{ label: 'System prompt', tokens: 3_000 }, { label: 'System tools', tokens: 16_000 }, { label: 'Messages', tokens: 80_000 }],
    messages,
    lastCall: { input: 1_200, cacheRead: 96_300, cacheWrite: 600, output: 900 },
  };

  it('keep the parts in the CLI’s order, and put each other section’s largest first; each row’s bar is its share of its section’s largest', () => {
    const sections = contextSections(full);
    expect(sections.map((section) => [section.key, section.title])).toEqual([['parts', 'In context'], ['messages', 'Message token breakdown'], ['lastCall', 'Last call']]);
    expect(sections[0]?.rows.map((row) => [row.label, row.tokens, row.share])).toEqual([['System prompt', 3_000, 0.0375], ['System tools', 16_000, 0.2], ['Messages', 80_000, 1]]);
    expect(sections[1]?.rows.map((row) => row.label)).toEqual(['Tool results', 'Answers', 'Tool calls', 'Your messages', 'Attachments']);
    expect(sections[1]?.rows.at(-1)).toMatchObject({ tokens: 0, share: 0 });
    expect(sections[2]?.rows.map((row) => row.label)).toEqual(['Cache read (98%)', 'Input', 'Output', 'Cache write']);
  });

  it('leave out messages that hold nothing, Other while it is nothing, and what the CLI did not tell apart', () => {
    const { lastCall: _lastCall, ...unanswered } = full;
    const idle = contextSections({ ...unanswered, messages: { toolCalls: 0, toolResults: 0, answers: 0, prompts: 0, attachments: 0, other: 0 } });
    expect(idle.map((section) => section.key)).toEqual(['parts']);
    const other = contextSections({ ...full, messages: { ...messages, other: 5 } });
    expect(other[1]?.rows.map((row) => row.key)).toContain('other');
    // Codex's: no parts, no messages, its calls with reasoning and no cache write.
    const codex = contextSections({ used: 15_800, window: 258_400, lastCall: { input: 3_203, cacheRead: 12_544, output: 53, reasoning: 0 }, calls: { input: 6_000, cacheRead: 25_000, output: 120, reasoning: 7 } });
    expect(codex.map((section) => [section.key, section.title])).toEqual([['lastCall', 'Last call'], ['calls', 'Whole chat']]);
    expect(codex[0]?.rows.map((row) => row.key)).toEqual(['cacheRead', 'input', 'output', 'reasoning']);
  });

  it('shows the cache share of input, reaching 100 only when all input was cached', () => {
    const label = (input: number, cacheRead: number, cacheWrite = 0): string | undefined =>
      contextSections({ used: 0, window: 200_000, lastCall: { input, cacheRead, cacheWrite, output: 10_000 } })[0]?.rows.find((row) => row.key === 'cacheRead')?.label;
    expect(label(1, 999)).toBe('Cache read (99%)');
    expect(label(0, 999)).toBe('Cache read (100%)');
    expect(label(0, 99, 1)).toBe('Cache read (99%)');
    expect(label(0, 0)).toBe('Cache read');
  });
});
