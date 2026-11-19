// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH_FILTERS, type SessionSearchRequest, type SessionSearchResult } from '@shared/contracts/session-search';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { useAppState } from '../state/store';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { SessionSwitcher } from '../sessions/SessionSwitcher';
import { SessionSearch } from './SessionSearch';

const p = project('Hidden project', { hidden: true });
const one = sessionEntry('Avatar rendering', SUMMARIES.idle, { projectId: p.id, completedAt: 10 });
const two = sessionEntry('Second session', SUMMARIES.idle, { projectId: p.id, shelvedAt: 10 });
const result: SessionSearchResult = { status: 'ready', total: 2, more: false, hits: [
  { sessionId: one.record.id, titleRanges: [{ start: 0, end: 6 }], excerpt: { role: 'assistant', text: '<script>avatar</script>', ranges: [{ start: 8, end: 14 }] } },
  { sessionId: two.record.id, titleRanges: [], excerpt: null },
] };
let bridge: FakeBridge;
let requests: SessionSearchRequest[];
let selects: string[];
beforeEach(() => {
  vi.useFakeTimers(); installDialogStandIn(); bridge = installFakeBridge(); requests = []; selects = [];
  showState({ projects: [p], sessions: [one, two] });
  bridge.setInvoke((channel, value) => {
    if (channel === 'sessions:search') { requests.push(value as SessionSearchRequest); return Promise.resolve({ ok: true, value: result }); }
    if (channel === 'sessions:select') { selects.push((value as { id: string }).id); return Promise.resolve({ ok: true, value: { status: 'saved' } }); }
    return Promise.resolve({ ok: true, value: null });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); useAppState.setState({ snapshot: null }); });
const advance = (ms = 200) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function open() {
  render(<SessionSearch />);
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await advance();
  return screen.getByRole('combobox', { name: 'Search session names and messages' });
}

describe('the session search dialog', () => {
  it('stays open through dev effect replay and still follows a later native close', async () => {
    // Chromium queues the close event; React reopens the dialog before that event arrives in dev.
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute('open');
      setTimeout(() => { this.dispatchEvent(new Event('close')); }, 0);
    });
    render(<StrictMode><SessionSearch /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await advance();
    const dialog = screen.getByRole<HTMLDialogElement>('dialog');
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search session names and messages' }));
    expect(requests).toHaveLength(1);

    dialog.close();
    await advance();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Search' }));
  });

  it('focuses search, falls back to all projects without a selection, and displays safe excerpts and lifecycle labels', async () => {
    const input = await open();
    expect(document.activeElement).toBe(input);
    expect(requests[0]).toEqual({ ...DEFAULT_SEARCH_FILTERS, query: '', offset: 0 });
    const rows = screen.getAllByRole('option').filter((row) => row.parentElement?.getAttribute('role') === 'listbox');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Hidden project (hidden) · Done');
    expect(rows[1]?.textContent).toContain('Shelved');
    expect(screen.getByRole('dialog').querySelector('script')).toBeNull();
    expect(screen.getByRole('dialog').querySelectorAll('mark')).toHaveLength(2);
    expect(selects).toEqual([]);
  });

  it('defaults each opening to the current project and still allows searching all projects', async () => {
    const other = project('Other project');
    const session = sessionEntry('Other session', SUMMARIES.idle, { projectId: other.id });
    showState({ projects: [p, other], sessions: [one, session], selectedId: one.record.id });
    await open();
    expect(screen.getByLabelText<HTMLSelectElement>('Project').value).toBe(p.id);
    expect(requests.at(-1)).toMatchObject({ projectId: p.id });

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: '' } });
    await advance();
    expect(requests.at(-1)).toMatchObject({ projectId: null });
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    act(() => { showState({ projects: [p, other], sessions: [one, session], selectedId: session.record.id }); });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await advance();
    expect(screen.getByLabelText<HTMLSelectElement>('Project').value).toBe(other.id);
    expect(requests.at(-1)).toMatchObject({ projectId: other.id });
  });

  it('debounces typing and sends filters, while highlighting alone selects nothing', async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: 'av' } });
    fireEvent.change(input, { target: { value: 'avatr' } });
    await advance(100);
    expect(requests).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'recent' } });
    fireEvent.change(screen.getByLabelText('Sessions'), { target: { value: 'done' } });
    fireEvent.change(screen.getByLabelText('Search in'), { target: { value: 'messages' } });
    fireEvent.click(screen.getByLabelText('Allow typos'));
    await advance();
    expect(requests.at(-1)).toMatchObject({ query: 'avatr', sort: 'recent', state: 'done', scope: 'messages', fuzzy: false });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(selects).toEqual([]);
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); await Promise.resolve(); });
    expect(selects).toEqual([two.record.id]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bridge.calls).not.toContain('invoke:sessions:restore');
  });

  it('ignores obsolete responses and stops polling after close', async () => {
    const input = await open();
    let release: ((value: unknown) => void) | undefined;
    bridge.setInvoke(async (_channel, payload) => {
      requests.push(payload as SessionSearchRequest);
      if ((payload as SessionSearchRequest).query === 'old') return new Promise((resolve) => { release = resolve; });
      return { ok: true, value: { ...result, total: 0, hits: [] } };
    });
    fireEvent.change(input, { target: { value: 'old' } }); await advance();
    fireEvent.change(input, { target: { value: 'new' } }); await advance();
    await act(async () => { release?.({ ok: true, value: result }); await Promise.resolve(); });
    expect(screen.getByText('No matching sessions.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));
    const count = requests.length;
    await advance(2200);
    expect(requests).toHaveLength(count);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Search' }));
  });

  it('clears text on close while retaining filter choices for this window', async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: 'private query' } });
    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'recent' } });
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    await advance();
    expect(bridge.calls).toContain('invoke:sessions:closeSearch');
    fireEvent.click(screen.getByRole('button', { name: 'Search' })); await advance();
    expect(screen.getByRole<HTMLInputElement>('combobox', { name: 'Search session names and messages' }).value).toBe('');
    expect(requests.at(-1)).toMatchObject({ query: '', sort: 'recent' });
  });

  it('shows indexing and unavailable states without pretending there are no matches', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: { ...result, status: 'indexing', hits: [], total: 0 } }));
    await open();
    expect(screen.getByRole('status').textContent).toContain('Searching saved messages');
    expect(screen.queryByText('No matching sessions.')).toBeNull();
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: { ...result, status: 'messages-unavailable' } })); await advance(1100);
    expect(screen.getByRole('status').textContent).toContain('Saved messages are unavailable');
  });

  it('keeps Ctrl+Tab out of the modal and removes deleted sessions from stale results', async () => {
    await open(); render(<SessionSwitcher />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', ctrlKey: true });
    expect(screen.queryByRole('listbox', { name: 'Recent sessions' })).toBeNull();
    act(() => { showState({ projects: [p], sessions: [two] }); });
    expect(within(screen.getByRole('listbox', { name: 'Matching sessions' })).getAllByRole('option')).toHaveLength(1);
  });
});
