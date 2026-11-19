// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6 (docs/planning/_archive/M14.md, C30): every fixture summary passes the contract's schema, and the set
// covers the states the demo script and the captures show and the ones hard to produce live.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanLabel, type SessionSummary, SessionSummarySchema } from '@shared/contracts/sessions';
import { LONG_NAME, RAW_SUMMARIES, sessionView, SUMMARIES } from '../support/sessions';

const DIRECTORY = path.resolve(import.meta.dirname, '../fixtures/sessions');
const all: readonly SessionSummary[] = Object.values(SUMMARIES);

describe('the fixture summaries (V6)', () => {
  it('are all loaded: one entry per file in tests/fixtures/sessions', () => {
    const files = readdirSync(DIRECTORY).map((name) => name.replace(/\.json$/, '')).sort();
    expect(Object.keys(RAW_SUMMARIES).sort()).toEqual(files);
    expect(Object.keys(SUMMARIES)).toHaveLength(files.length);
  });

  it.each(Object.entries(RAW_SUMMARIES))('%s passes the summary schema', (_name, raw) => {
    expect(SessionSummarySchema.safeParse(raw).success).toBe(true);
  });

  it.each(Object.entries(SUMMARIES))('%s counts its running agents as its active workers (C18)', (_name, summary) => {
    expect(summary.activeWorkers).toBe(summary.agents.filter((agent) => agent.state === 'running').length);
  });

  it('cover every status, every attention kind and the acknowledged state', () => {
    expect(new Set(all.map((summary) => summary.status))).toEqual(new Set(['not-started', 'idle', 'running']));
    expect(new Set(all.flatMap((summary) => (summary.attention === null ? [] : [summary.attention.kind])))).toEqual(new Set(['ready', 'question', 'approval', 'error', 'stopped']));
    expect(all.some((summary) => summary.attention?.acknowledged === true)).toBe(true);
  });

  it('cover several questions, many workers and an error', () => {
    expect(SUMMARIES.questions.attention).toEqual({ kind: 'question', count: 3, acknowledged: false });
    expect(SUMMARIES.manyWorkers.activeWorkers).toBeGreaterThanOrEqual(8);
    expect(SUMMARIES.manyWorkers.agents.some((agent) => agent.state === 'failed')).toBe(true);
    expect(SUMMARIES.manyWorkers.agents.some((agent) => agent.state === 'completed')).toBe(true);
    expect(SUMMARIES.error.attention?.kind).toBe('error');
  });

  // M100 (C52, V13): each carries its detail — none for fat-g's words, the provider's sentence for its own, a file's name for a file.
  it('cover both forms of a label: fat-g’s words, and a provider’s sentence at the clamp (C21), each with its detail (M100, C52)', () => {
    expect(SUMMARIES.runningThinking.action).toEqual({ kind: 'thinking', label: 'Thinking…', detail: null });
    const sentence = SUMMARIES.runningSentence.action?.label ?? '';
    expect([...sentence]).toHaveLength(60);
    expect(sentence.endsWith('…')).toBe(true);
    expect(cleanLabel(sentence)).toBe(sentence);
    expect(SUMMARIES.runningSentence.action?.detail).toBe(sentence);
    expect(SUMMARIES.runningWorkers.action).toEqual({ kind: 'reading', label: 'Reading notes.txt', detail: 'notes.txt' });
  });

  it('cover a session waiting on its workers after its turn has ended (C114)', () => {
    expect(SUMMARIES.waitingOnWorkers).toMatchObject({ status: 'running', attention: null, action: { kind: 'waiting', label: 'Waiting for 2 sub-agents' }, activeWorkers: 2 });
    expect(SUMMARIES.waitingOnWorkers.turnStartedAt).not.toBeNull();
  });

  it('come with a name of exactly 60 characters for the records they are shown with', () => {
    expect([...LONG_NAME]).toHaveLength(60);
    expect(sessionView(LONG_NAME).name).toBe(LONG_NAME);
  });
});
