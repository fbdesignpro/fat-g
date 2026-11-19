// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0033: the context meter beside the mode control — drawn for a provider that reports its
// context, its cells filled and red as the reading says, and its tooltip's aligned table, each size
// said in tokens. CSS modules arrive empty here: what is drawn is read from its data attributes.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContextReading, SessionEntry } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { sampleDescriptor, sampleProvider } from '../../../../tests/support/app-state';
import { SUMMARIES } from '../../../../tests/support/sessions';
import { installFakeBridge } from '../test/fake-bridge';
import { modedEntry } from '../test/permissions';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { useSelectedSession } from './selected';
import { ContextMeter } from './ContextMeter';
import { CONTEXT_WORDS } from './context-words';

beforeEach(() => { installFakeBridge(); });
afterEach(cleanup);

const A = project('Calamari');

function provider(reports: boolean, displayName = 'Claude'): ProviderSnapshot {
  const descriptor = sampleDescriptor({ displayName });
  return sampleProvider({ displayName, descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, ...(reports ? { context: true } : {}) } } });
}

function entry(context?: ContextReading): SessionEntry {
  return modedEntry('Create plan', { id: 'ask-first', source: 'project' }, { record: { projectId: A.id }, summary: { ...SUMMARIES.idle, ...(context === undefined ? {} : { context }) } });
}

function Selected() {
  const selected = useSelectedSession();
  return selected === null ? null : <ContextMeter entry={selected.entry} />;
}

function show(context: ContextReading | undefined, reports = true, displayName = 'Claude') {
  const shown = entry(context);
  act(() => { showState({ projects: [A], sessions: [shown], selectedId: shown.record.id, providers: [provider(reports, displayName)] }); });
  render(<Selected />);
}

const meter = () => screen.getByRole('meter', { name: CONTEXT_WORDS.meterName });
const cells = () => [...meter().children] as HTMLElement[];
const tip = () => screen.getByRole('tooltip', { hidden: true });

const CLAUDE: ContextReading = {
  used: 99_000, window: 200_000, compactAt: 167_000,
  parts: [{ label: 'System prompt', tokens: 3_000 }, { label: 'System tools', tokens: 16_000 }, { label: 'Messages', tokens: 80_000 }],
  messages: { toolCalls: 12_000, toolResults: 44_000, answers: 16_000, prompts: 8_000, attachments: 0, other: 0 },
  lastCall: { input: 1_200, cacheRead: 96_300, cacheWrite: 600, output: 900 },
};
const CODEX: ContextReading = { used: 15_800, window: 258_400, lastCall: { input: 3_203, cacheRead: 12_544, cacheWrite: 0, output: 53, reasoning: 0 }, calls: { input: 6_000, cacheRead: 25_000, cacheWrite: 0, output: 120, reasoning: 7 } };

describe('the context meter (decision 0033)', () => {
  it('is drawn only for a provider that reports its context', () => {
    show(CLAUDE, false);
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('is a meter of 30 cells without a visible label, filled a column at a time, red from the CLI’s line', () => {
    show(CLAUDE);
    expect(meter().getAttribute('aria-valuenow')).toBe('99000');
    expect(meter().getAttribute('aria-valuemax')).toBe('200000');
    expect(meter().getAttribute('aria-valuetext')).toBe('99,000 of 200,000 tokens, 50%');
    expect(meter().closest('[data-context-meter]')?.textContent).toBe('');
    expect(cells()).toHaveLength(30);
    expect(cells().filter((cell) => cell.hasAttribute('data-filled'))).toHaveLength(15);
    expect(cells().slice(0, 15).every((cell) => cell.hasAttribute('data-filled'))).toBe(true);
    expect(cells().findIndex((cell) => cell.hasAttribute('data-compact'))).toBe(25);
    expect(cells().filter((cell) => cell.hasAttribute('data-compact'))).toHaveLength(5);
    // It takes the focus, so its tooltip opens from the keyboard as from the pointer.
    expect(meter().tabIndex).toBe(0);
    expect(meter().getAttribute('aria-describedby')).toBe(tip().id);
  });

  it('stands empty with no reading, and its tooltip says when one comes', () => {
    show(undefined);
    expect(cells().some((cell) => cell.hasAttribute('data-filled') || cell.hasAttribute('data-compact'))).toBe(false);
    expect(meter().getAttribute('aria-valuetext')).toBe(CONTEXT_WORDS.none);
    expect(tip().textContent).toBe(CONTEXT_WORDS.none);
  });

  it('opens its tooltip on the pointer and on the focus', () => {
    show(CLAUDE);
    expect(tip().hasAttribute('data-open')).toBe(false);
    fireEvent.pointerEnter(meter());
    expect(tip().hasAttribute('data-open')).toBe(true);
    fireEvent.pointerLeave(meter());
    fireEvent.focus(meter());
    expect(tip().hasAttribute('data-open')).toBe(true);
  });
});

describe('its tooltip (decision 0033)', () => {
  const sections = () => [...tip().querySelectorAll('tbody')].map((body) => body.getAttribute('data-context-section'));
  const rows = (section: string) => [...tip().querySelectorAll(`tbody[data-context-section='${section}'] tr[data-context-row]`)].map((row) => [...row.children].map((cell) => cell.textContent));
  const share = (section: string, row: string) => tip().querySelector(`tbody[data-context-section='${section}'] tr[data-context-row='${row}'] [data-share]`)?.getAttribute('data-share') ?? null;

  it('says the count, the window and the share in tokens, the CLI’s line, and closes on the unit', () => {
    show(CLAUDE);
    expect(tip().querySelector('[data-context-total]')?.textContent).toBe('99,000 / 200,000 tokens · 50%');
    expect(tip().querySelector('[data-context-compaction]')?.textContent).toBe('Compacts automatically at 167,000 tokens (84%)');
    expect(tip().querySelector('thead th')?.textContent).toBe('tokens');
    expect(tip().textContent).toContain(CONTEXT_WORDS.footer);
  });

  it('is one table, a section a group: its heading, then a row a part with its count and a bar of its share of the largest', () => {
    show(CLAUDE);
    expect(tip().querySelectorAll('table')).toHaveLength(1);
    expect(sections()).toEqual(['parts', 'messages', 'lastCall']);
    expect(within(tip()).getAllByRole('columnheader', { hidden: true }).map((cell) => cell.textContent)).toEqual(['tokens', 'In context', 'Message token breakdown', 'Last call']);
    expect(rows('parts')).toEqual([['System prompt', '3,000', ''], ['System tools', '16,000', ''], ['Messages', '80,000', '']]);
    expect([share('parts', 'part-2'), share('parts', 'part-1')]).toEqual(['1', '0.2']);
    // Largest first outside the parts, and a row that holds nothing draws no bar.
    expect(rows('messages').map((row) => row[0])).toEqual(['Tool results', 'Answers', 'Tool calls', 'Your messages', 'Attachments']);
    expect(share('messages', 'attachments')).toBeNull();
  });

  it('says that the CLI compacts nothing, or that it does not say where, by the provider’s name', () => {
    show({ ...CLAUDE, compactAt: null });
    expect(tip().querySelector('[data-context-compaction]')?.textContent).toBe(CONTEXT_WORDS.compactOff);
    cleanup();
    show(CODEX, true, 'Codex');
    expect(tip().querySelector('[data-context-compaction]')?.textContent).toBe('Codex does not report when it compacts.');
    expect(sections()).toEqual(['lastCall', 'calls']);
    expect(rows('calls').map((row) => row[0])).toEqual(['Cache read (81%)', 'Input', 'Output', 'Reasoning, in output', 'Cache write']);
    expect(cells().some((cell) => cell.hasAttribute('data-compact'))).toBe(false);
  });
});
