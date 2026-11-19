// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The session area (docs/planning/_archive/M14.md, V13; docs/planning/_archive/M100.md, V5, round 8): the session's
// names, the model block at the prompt area's left, the status bar over the input and Done, for the
// session the Main window has selected. The agent list and the grants are the pane's Sub-agents tab
// since round 8 (C78): src/renderer/src/artifacts/agents.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEffort, CatalogModel, CatalogState } from '@shared/contracts/catalog';
import type { SessionEntry, SessionSummary, SessionView } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES, TURN_STARTED_AT } from '../../../../tests/support/sessions';
import { SessionNameArea } from '../shell/SessionNameArea';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { SelectedModel, SelectedStatus } from '../test/selected';
import { showState, type ShownState } from '../test/sessions';
import { RESTORE_TEXT, SHELVE_TEXT, UNSHELVE_TEXT } from '../sessions/SessionMenu';
import { CANCEL_TEXT, DONE_TEXT, DoneButton } from './DoneButton';
import { holdText } from './ModelBlock';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answer: () => unknown;

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  answer = () => ({ status: 'saved' });
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: answer() };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const level = (id: string, label: string, place: number, caution = false, warning?: string): CatalogEffort => ({ id, label, place, caution, ...(warning === undefined ? {} : { warning }) });
/** Ultra's warning, as Codex's module gives it. */
const ULTRA_WARNING = 'Automatically delegates tasks; can increase usage.';
const LEVELS = [level('low', 'Low', 1), level('high', 'High', 2), level('xhigh', 'X-High', 3), level('ultra', 'Ultra', 4, true, ULTRA_WARNING)];
const model = (key: string, name: string, overrides: Partial<CatalogModel> = {}): CatalogModel =>
  sampleModel({ key, resolvedId: key, name, efforts: LEVELS, listedDefaultEffort: 'high', listedDefault: false, ...overrides });
const claude = sampleCatalogProvider({
  id: 'claude',
  presentation: { barColor: '#ff9933', icon: { viewBox: '0 0 24 24', path: 'M2 2H22V22H2Z' } },
  models: [
    model('default', 'Default (recommended)', { resolvedId: 'claude-opus[1m]', listedDefault: true }),
    model('opus[1m]', 'Opus (1M context)', { resolvedId: 'claude-opus[1m]' }),
    model('sonnet', 'Sonnet'),
    model('haiku', 'Haiku', { efforts: [], listedDefaultEffort: null, speedTiers: [] }),
    model('retired', 'Retired', { hidden: true }),
  ],
});
const CATALOG: CatalogState = { ...sampleCatalog([]), providers: [claude, sampleCatalogProvider({ id: 'codex' })] };
const PROVIDERS = [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex' })];

const A = project('Calamari', { color: 'purple' });
const s = (name: string | null, summary: SessionSummary = SUMMARIES.idle, overrides: Partial<SessionView> = {}, hold: SessionEntry['hold'] = null): SessionEntry =>
  sessionEntry(name, summary, { projectId: A.id, providerId: 'claude', model: 'sonnet', effort: 'xhigh', ...overrides }, hold);
const select = (entry: SessionEntry, extra: Partial<ShownState> = {}) =>
  showState({ projects: [A], sessions: [entry], selectedId: entry.record.id, catalog: CATALOG, providers: PROVIDERS, ...extra });

function Area() {
  return (
    <>
      <SessionNameArea />
      <SelectedModel />
      <SelectedStatus />
    </>
  );
}

const header = () => screen.getByRole('region', { name: 'Session' });
const column = () => screen.getByRole('region', { name: 'Model' });
const effortButton = () => column().querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
const modelText = () => column().querySelector('[data-session-model]') as HTMLElement;
const avatar = () => column().querySelector('[data-avatar]') as HTMLElement;
const action = () => document.querySelector('[data-status-bar]') as HTMLElement;
const after = (a: Element, b: Element | null) => b !== null && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
    await flush();
  });
};

describe('with no session selected (V13; C58)', () => {
  it('leaves the names empty, and draws no model block and no status bar', () => {
    showState({ projects: [A], sessions: [s('Create plan')], catalog: CATALOG });
    render(<Area />);
    expect(header().textContent).toBe('');
    expect(header().children).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Model' })).toBeNull();
    expect(action()).toBeNull();
  });

  it('empties them again when the selected session goes', () => {
    const entry = s('Create plan');
    select(entry);
    render(<Area />);
    expect(header().textContent).not.toBe('');
    act(() => void showState({ projects: [A], sessions: [], catalog: CATALOG }));
    expect(header().children).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Model' })).toBeNull();
  });
});

// M100 (C14, C23, V3): the session's names, directly on the grid; the project's colour is drawn nowhere.
describe('the session’s names (M100, C14)', () => {
  it('shows the project’s name, a // for the eye alone, then the session’s name as the heading — and no control, and no colour', () => {
    select(s('Create plan'));
    render(<Area />);
    const parts = [...(header().firstElementChild?.children ?? [])];
    expect(parts.map((part) => part.textContent)).toEqual(['Calamari', ' // ', 'Create plan']);
    expect(parts[1]?.getAttribute('aria-hidden')).toBe('true');
    expect(within(header()).getByRole('heading', { name: 'Create plan' })).toBe(parts[2]?.firstElementChild);
    expect(header().textContent).toBe('Calamari // Create plan');
    expect(header().querySelector('[data-color]')).toBeNull();
    expect(header().querySelectorAll('button, a, input, select, [role="button"], [tabindex]')).toHaveLength(0);
  });

  it('keeps a long name whole in its heading, for the lines to cut', () => {
    const long = 'Create a plan for the renewed interest in the project, over two lines and more';
    select(s(long));
    render(<Area />);
    expect(within(header()).getByRole('heading').textContent).toBe(long);
  });

  // A session no turn has run is shown on the new-chat screen, with no names here: an idle one stands for it.
  it('shows a session with no name by its creation time', () => {
    showState({ projects: [project('Calamari', { color: null })], sessions: [s(null, SUMMARIES.idle, { createdAt: Date.UTC(2020, 0, 22, 12, 0) })], selectedId: s(null, SUMMARIES.idle, { createdAt: Date.UTC(2020, 0, 22, 12, 0) }).record.id, catalog: CATALOG });
    render(<Area />);
    expect(within(header()).getByRole('heading').textContent).toMatch(/2020/);
  });
});

describe('the placeholder avatar (V13; C59; M100, C28)', () => {
  // M102 (V7; C4, C31): the model column draws the session's avatar, its portrait over the placeholder.
  it('draws the session’s resolved avatar at the column’s width: its portrait', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    select({ ...s('Create plan'), avatar: face });
    render(<Area />);
    expect(avatar().getAttribute('data-size')).toBe('column');
    expect(avatar().querySelector('svg')).not.toBeNull();
    expect(avatar().querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${face.portrait}`);
  });

  // M103 (V6; C13, C14): the avatar the session's entry carries, an assigned one, and the default face once main resolves it again.
  it('draws the session’s assigned avatar, and the default face when its entry carries that instead', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    const assigned = { ref: { origin: 'user' as const, family: 'Mine', avatar: 'Op' }, portrait: 'c'.repeat(32), small: 'd'.repeat(32) };
    const entry = s('Create plan');
    select({ ...entry, avatar: assigned });
    render(<Area />);
    expect(avatar().querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${assigned.portrait}`);
    act(() => { select({ ...entry, avatar: face }); });
    expect(avatar().querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${face.portrait}`);
  });

  it('is as wide as the avatar’s column, in the provider’s bar colour, with its mark, from the catalog’s presentation', () => {
    select(s('Create plan'));
    render(<Area />);
    expect(avatar().getAttribute('data-size')).toBe('column');
    expect(avatar().getAttribute('data-avatar')).toBe('claude');
    expect(avatar().style.getPropertyValue('--bar-color')).toBe('#ff9933');
    expect(avatar().querySelector('path')?.getAttribute('d')).toBe('M2 2H22V22H2Z');
  });
});

describe('the effort menu (V13; C60; M100, C33)', () => {
  it('shows the level in title case below the provider-coloured model name', () => {
    select(s('Create plan'));
    render(<Area />);
    expect(effortButton().textContent).toBe('X-High');
    expect(effortButton().getAttribute('aria-label')).toBe('Effort: X-High');
    expect(effortButton().style.getPropertyValue('--bar-color')).toBe('');
    expect(avatar().nextElementSibling).toBe(modelText());
    expect(modelText().nextElementSibling).toBe(effortButton());
    expect(modelText().style.getPropertyValue('--bar-color')).toBe('#ff9933');
    expect(effortButton().disabled).toBe(false);
  });

  // M15 (C45): a turn keeps the level it was sent with.
  it('says, while the session runs, that a change applies from the next turn', () => {
    select(s('Create plan', SUMMARIES.runningThinking));
    render(<Area />);
    fireEvent.click(effortButton());
    const menu = screen.getByRole('menu', { name: 'Effort' });
    expect(menu.textContent).toContain('A change applies from the next reply.');
    expect(document.getElementById(menu.getAttribute('aria-describedby') ?? '')?.textContent).toBe('A change applies from the next reply.');
    cleanup();
    select(s('Create plan'));
    render(<Area />);
    fireEvent.click(effortButton());
    expect(screen.getByRole('menu', { name: 'Effort' }).textContent).not.toContain('next reply');
    expect(screen.getByRole('menu', { name: 'Effort' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('lists the model’s levels in catalog order, the one that warns marked and saying why, the current one marked', () => {
    select(s('Create plan'));
    render(<Area />);
    fireEvent.click(effortButton());
    const items = within(screen.getByRole('menu', { name: 'Effort' })).getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['Low', 'High', 'X-High', 'Ultra ⚠']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    expect([items[3]?.getAttribute('data-caution'), items[3]?.getAttribute('title'), items[3]?.getAttribute('aria-description')]).toEqual(['true', ULTRA_WARNING, ULTRA_WARNING]);
    expect(items[2]?.hasAttribute('title')).toBe(false);
    // The chosen level warns of nothing: no words under the levels.
    expect(screen.getByRole('menu', { name: 'Effort' }).querySelector('[data-effort-warning]')).toBeNull();
    // Opening puts the focus on the level in force, and the keys move among the levels.
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Effort' }), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[3]);
  });

  it('says the chosen level’s warning in words under the levels', () => {
    select(s('Create plan', SUMMARIES.idle, { effort: 'ultra' }));
    render(<Area />);
    fireEvent.click(effortButton());
    expect(screen.getByRole('menu', { name: 'Effort' }).querySelector('[data-effort-warning]')?.textContent).toBe(`⚠ Ultra: ${ULTRA_WARNING}`);
  });

  it('says the speed tier after the level, and turns it on and off from its check under the levels (decision 0016)', async () => {
    const entry = s('Create plan', SUMMARIES.idle, { speed: 'priority' });
    select(entry);
    render(<Area />);
    expect(effortButton().textContent).toBe('X-High - ⚡Fast');
    expect(effortButton().getAttribute('aria-label')).toBe('Effort: X-High, speed: Fast');
    fireEvent.click(effortButton());
    const fast = within(screen.getByRole('menu', { name: 'Effort' })).getByRole('menuitemcheckbox', { name: '⚡ Fast' });
    expect(fast.getAttribute('aria-checked')).toBe('true');
    await click(fast);
    expect(requests).toEqual([['sessions:setSpeed', { id: entry.record.id, speed: null }]]);
  });

  it('says Not fast in the bar’s place where the last turn ran at standard speed, the level and why on hover and in the menu', () => {
    const entry = s('Create plan', { ...SUMMARIES.idle, notFast: { reason: 'out_of_credits' } }, { speed: 'priority' });
    select(entry);
    render(<Area />);
    const why = 'Fast was requested for the last reply, which ran at standard speed: no extra usage is left, which the faster tier is billed as.';
    expect(effortButton().textContent).toBe('Not fast');
    expect(effortButton().querySelector('[data-not-fast]')?.textContent).toBe('Not fast');
    expect(effortButton().getAttribute('title')).toBe(`Effort: X-High. ${why}`);
    expect(effortButton().getAttribute('aria-label')).toBe(`Effort: X-High, speed: Fast. ${why}`);
    fireEvent.click(effortButton());
    expect(screen.getByRole('menu', { name: 'Effort' }).querySelector('[data-not-fast-note]')?.textContent).toBe(why);
    cleanup();
    // At standard speed, a last turn's reading is no part of it.
    select(s('Create plan', { ...SUMMARIES.idle, notFast: { reason: null } }));
    render(<Area />);
    expect(effortButton().textContent).toBe('X-High');
  });

  it('sends one request for the chosen level, and none for the one in force: no cycling on press', async () => {
    const entry = s('Create plan');
    select(entry);
    render(<Area />);
    // A press opens the menu and changes nothing.
    fireEvent.click(effortButton());
    expect(requests).toEqual([]);
    await click(within(screen.getByRole('menu', { name: 'Effort' })).getByRole('menuitemradio', { name: 'X-High' }));
    expect(requests).toEqual([]);
    fireEvent.click(effortButton());
    await click(within(screen.getByRole('menu', { name: 'Effort' })).getByRole('menuitemradio', { name: 'Ultra ⚠' }));
    expect(requests).toEqual([['sessions:setEffort', { id: entry.record.id, effort: 'ultra' }]]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(effortButton());
  });

  it('is disabled and named No effort levels for a model with none', () => {
    select(s('Create plan', SUMMARIES.idle, { model: 'haiku', effort: null }));
    render(<Area />);
    expect(effortButton().disabled).toBe(true);
    expect(effortButton().getAttribute('aria-label')).toBe('No effort levels');
    expect(effortButton().textContent).toBe('No effort levels');
    fireEvent.click(effortButton());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('says so when the change is refused or fails', async () => {
    answer = () => ({ status: 'refused', reason: 'effort-not-listed' });
    select(s('Create plan'));
    render(<Area />);
    fireEvent.click(effortButton());
    await click(within(screen.getByRole('menu', { name: 'Effort' })).getByRole('menuitemradio', { name: 'Low' }));
    expect(within(column()).getByRole('status').textContent).toBe('fat-g could not save the change.');
  });
});

// M14b, V20 (C55, C56): a session's model is fixed when it is created, so it is text, not a menu.
describe('the model, as text (M14b, V20; C55, C56)', () => {
  it('preserves the effective model id’s capitalization and title-cases a multiword effort label', () => {
    const entry = s('Mixed case', SUMMARIES.idle, { model: 'Provider-Model[1M]', effort: 'extra-high' });
    select(entry, { catalog: { ...CATALOG, providers: [{ ...claude, models: [model('Provider-Model[1M]', 'Friendly name', { efforts: [level('extra-high', 'EXTRA HIGH', 1)] })] }] } });
    render(<Area />);
    expect(modelText().textContent).toBe('Friendly name');
    expect(modelText().title).toBe('Provider-Model[1M]');
    expect(effortButton().textContent).toBe('Extra High');
  });

  it('shows the effective model name as text with no menu and no way to change it', () => {
    select(s('Create plan'));
    render(<Area />);
    expect(modelText().textContent).toBe('Sonnet');
    expect(modelText().className).not.toContain('announcer');
    expect(within(column()).getByRole('group', { name: 'Model' })).toBe(modelText());
    // The effort menu is the column's one menu button.
    expect([...column().querySelectorAll('button[aria-haspopup="menu"]')]).toEqual([effortButton()]);
    expect(modelText().querySelector('button')).toBeNull();
    fireEvent.click(modelText());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('is read between the avatar and effort bar, in a block that holds no agent list and no grants', () => {
    select(s('Create plan', SUMMARIES.runningWorkers));
    render(<Area />);
    expect([...column().children].map((child) => child.getAttribute('data-avatar') ?? child.tagName)).toEqual(['claude', 'DIV', 'BUTTON']);
    expect(after(modelText(), effortButton())).toBe(true);
    expect(column().querySelector('[data-agent-list], [data-agent], [data-grants]')).toBeNull();
    // The status is the status bar's, outside the block.
    expect(column().contains(action())).toBe(false);
  });

  it('names the model of the row the record’s key names, the row the tiles leave out included', () => {
    select(s('Create plan', SUMMARIES.idle, { model: 'default' }));
    render(<Area />);
    expect(modelText().textContent).toBe('Default (recommended)');
  });

  it('shows what the session runs with once a source has reported it (C23, C63)', () => {
    const entry = s('Create plan');
    showState({ projects: [A], sessions: [{ ...entry, summary: { ...entry.summary, model: 'opus[1m]', effort: 'low' } }], selectedId: entry.record.id, catalog: CATALOG, providers: PROVIDERS });
    render(<Area />);
    expect(modelText().textContent).toBe('Opus (1M context)');
    expect(effortButton().textContent).toBe('Low');
    // The effort menu still marks, and sets, the record's level.
    fireEvent.click(effortButton());
    expect(within(screen.getByRole('menu', { name: 'Effort' })).getAllByRole('menuitemradio').filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent)).toEqual(['X-High']);
  });

  it('still sets a level from the effort menu', async () => {
    const entry = s('Create plan');
    select(entry);
    render(<Area />);
    fireEvent.click(effortButton());
    await click(within(screen.getByRole('menu', { name: 'Effort' })).getByRole('menuitemradio', { name: 'Low' }));
    expect(requests).toEqual([['sessions:setEffort', { id: entry.record.id, effort: 'low' }]]);
  });
});

describe('before a report, and without a provider (V13; C88, C108)', () => {
  const silent: CatalogState = { ...CATALOG, providers: [{ ...claude, source: { kind: 'none' }, models: [] }, sampleCatalogProvider({ id: 'codex' })] };

  it('shows the model by its key and the effort by its id, with the effort menu disabled, until the report arrives', () => {
    const entry = s('Create plan');
    select(entry, { catalog: silent });
    render(<Area />);
    expect(modelText().textContent).toBe('sonnet');
    expect(effortButton().textContent).toBe('Xhigh');
    expect(effortButton().disabled).toBe(true);
    // The provider is registered: it keeps its avatar.
    expect(column().querySelector('[data-avatar]')?.hasAttribute('data-neutral')).toBe(false);
    act(() => void select(entry));
    expect(modelText().textContent).toBe('Sonnet');
    expect(effortButton().textContent).toBe('X-High');
    expect(effortButton().disabled).toBe(false);
  });

  it('shows the same for a session whose provider is switched off, with that provider’s avatar', () => {
    // Main says so in the entry (M14b, C29): the page reads no switch for it.
    select(s('Create plan', SUMMARIES.idle, {}, 'provider-unavailable'), { providers: [sampleProvider({ status: { kind: 'disabled' } }), sampleProvider({ id: 'codex', displayName: 'Codex' })] });
    render(<Area />);
    expect([modelText().textContent, effortButton().textContent]).toEqual(['Sonnet', 'Xhigh']);
    expect(effortButton().disabled).toBe(true);
    const avatar = column().querySelector('[data-avatar]') as HTMLElement;
    expect(avatar.hasAttribute('data-neutral')).toBe(false);
    expect(avatar.querySelector('svg')).not.toBeNull();
  });

  it('shows the same for a provider this build does not have, with the neutral square and no mark', () => {
    select(s('From elsewhere', SUMMARIES.idle, { providerId: 'gemini', model: 'gemini-3-pro', effort: 'high' }));
    render(<Area />);
    expect([modelText().textContent, effortButton().textContent]).toEqual(['gemini-3-pro', 'High']);
    expect(modelText().style.getPropertyValue('--bar-color')).toBe('');
    expect(effortButton().disabled).toBe(true);
    const avatar = column().querySelector('[data-avatar]') as HTMLElement;
    expect(avatar.hasAttribute('data-neutral')).toBe(true);
    expect(avatar.querySelector('svg')).toBeNull();
  });

  it('shows a model the catalog no longer lists by its key, with no level to choose', () => {
    select(s('Old', SUMMARIES.idle, { model: 'claude-retired-4', effort: 'high' }));
    render(<Area />);
    expect(modelText().textContent).toBe('claude-retired-4');
    expect(effortButton().disabled).toBe(true);
  });
});

// M100 (C51, C52, V5, V13): what the session does, over the input, at a fixed height of two lines.
describe('the status bar (M100, C51, C52)', () => {
  const words = () => action().querySelector('p')?.textContent;
  const lines = () => [...action().querySelectorAll('p')].map((line) => [...line.childNodes].map((node) => node.textContent));

  it.each([
    ['not-started', 'Not started', SUMMARIES.notStarted],
    ['ready', 'Ready', SUMMARIES.idle],
    ['ready', 'Ready', SUMMARIES.ready],
    ['ready', 'Ready', SUMMARIES.readyAcknowledged],
    ['attention', 'Error', SUMMARIES.error],
    ['attention', 'Stopped', SUMMARIES.stopped],
  ] as const)('is one line, %s, reading %s, for a session between turns, with no time', (state, text, summary) => {
    select(s('Create plan', summary));
    render(<Area />);
    expect(action().getAttribute('data-state')).toBe(state);
    expect(lines()).toEqual([[text]]);
    expect(action().getAttribute('aria-label')).toBe(text);
  });

  it('calls for the user while a turn runs, on one line: a question or an approval, never dimmed', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 32_000 });
    select(s('Create plan', SUMMARIES.questions));
    render(<Area />);
    expect(action().getAttribute('data-state')).toBe('attention');
    expect(lines()).toEqual([['3 Questions']]);
    cleanup();
    select(s('Create plan', SUMMARIES.approval));
    render(<Area />);
    expect([action().getAttribute('data-state'), words()]).toEqual(['attention', '1 Approval']);
  });

  it.each([
    ['question', '1 Question'], ['approval', '1 Approval'], ['plan', 'Plan ready'], ['review', 'Plan review'],
  ] as const)('exposes %s for the local attention colours, replacing the running presentation', (kind, text) => {
    select(s('Create plan', SUMMARIES.runningThinking));
    render(<Area />);
    expect(action().getAttribute('data-state')).toBe('running');
    expect(action().hasAttribute('data-attention')).toBe(false);
    act(() => { select(s('Create plan', { ...SUMMARIES.runningThinking, attention: { kind, count: 1, acknowledged: false } })); });
    expect(action().getAttribute('data-state')).toBe('attention');
    expect(action().getAttribute('data-attention')).toBe(kind);
    expect(action().getAttribute('aria-label')).toBe(text);
    expect(action().querySelector('[data-status-detail]')).toBeNull();
    act(() => { select(s('Create plan', SUMMARIES.runningThinking)); });
    expect(action().getAttribute('data-state')).toBe('running');
    expect(action().hasAttribute('data-attention')).toBe(false);
  });

  it('shows only the action’s status and elapsed time on one line, keeping detail in its accessible name', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 247_000 });
    select(s('Create plan', SUMMARIES.runningWorkers));
    render(<Area />);
    expect(action().getAttribute('data-state')).toBe('running');
    expect(lines()).toEqual([['Reading', '4m7s']]);
    expect(action().getAttribute('aria-label')).toBe('Reading, notes.txt, 4m7s');
    expect(action().querySelector('[aria-hidden="true"]')?.children).toHaveLength(12);
  });

  it('keeps one line for an action with no detail', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 32_000 });
    select(s('Create plan', SUMMARIES.runningThinking));
    render(<Area />);
    expect(lines()).toEqual([['Thinking…', '32s']]);
    expect(action().querySelector('[data-status-detail]')).toBeNull();
    expect(action().getAttribute('aria-label')).toBe('Thinking…, 32s');
  });

  it('shows a provider’s sentence whole as the detail, where the line cuts it', () => {
    select(s('Create plan', SUMMARIES.runningSentence));
    render(<Area />);
    expect(action().querySelector('[data-status-detail]')).toBeNull();
    expect(lines()[0]?.[0]).toBe('Writing');
  });

  it('reads as waiting, with its time and no detail, after the turn has ended and its workers run (C114)', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 150_000 });
    select(s('Create plan', SUMMARIES.waitingOnWorkers));
    render(<Area />);
    expect(lines()).toEqual([['Waiting for 2 sub-agents', '2m30s']]);
  });

  it('is no live region: it changes every second while a turn runs', () => {
    select(s('Create plan', SUMMARIES.runningThinking));
    render(<Area />);
    expect(action().getAttribute('role')).toBe('group');
    expect(action().hasAttribute('aria-live')).toBe(false);
  });
});

// M100 (C31, C50, V5): Done completes the session as the capsule menu's Done does.
describe('Done (M100, C50)', () => {
  it('sends sessions:complete for its session', async () => {
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    const done = screen.getByRole('button', { name: DONE_TEXT });
    await click(done);
    expect(requests).toEqual([['sessions:complete', { id: entry.record.id }]]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says in its description which flags it clears and which it keeps, each with its mark', () => {
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    const tip = document.getElementById(screen.getByRole('button', { name: DONE_TEXT }).getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(tip.textContent).toBe('Complete this session. Clears To do and To verify. Keeps Starred.');
    expect(tip.querySelectorAll('svg')).toHaveLength(3);
  });

  it('grays Done while a session runs, and a press sends nothing', async () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    select(entry);
    const { rerender } = render(<DoneButton entry={entry} />);
    const done = screen.getByRole('button', { name: DONE_TEXT });
    expect(done.getAttribute('aria-disabled')).toBe('true');
    expect(done.hasAttribute('data-unavailable')).toBe(true);
    await click(done);
    expect(requests).toEqual([]);
    rerender(<DoneButton entry={s('Create plan')} />);
    expect(done.hasAttribute('aria-disabled')).toBe(false);
  });

  it('says why main refused completion if a turn started before the request arrived', async () => {
    answer = () => ({ status: 'refused', reason: 'running' });
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    await click(screen.getByRole('button', { name: DONE_TEXT }));
    expect(screen.getByRole('status').textContent).toBe('A chat cannot be completed while it is still working on a reply. Wait until it finishes, or stop it, then try again.');
  });

  it('says what the running session does where main says it (M22e)', async () => {
    answer = () => ({ status: 'refused', reason: 'running', doing: 'review' });
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    await click(screen.getByRole('button', { name: DONE_TEXT }));
    expect(screen.getByRole('status').textContent).toBe('A chat cannot be completed while it is writing its review of a plan. Wait until it finishes, or stop it, then try again.');
  });

  it('says so when the change fails otherwise', async () => {
    answer = () => ({ status: 'refused', reason: 'records-refused' });
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    await click(screen.getByRole('button', { name: DONE_TEXT }));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });

  it('has Shelve under it, which sends sessions:shelve and says why a running session was not shelved', async () => {
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([DONE_TEXT, SHELVE_TEXT, 'Starred', 'To do', 'To verify']);
    await click(screen.getByRole('button', { name: SHELVE_TEXT }));
    expect(requests).toEqual([['sessions:shelve', { id: entry.record.id }]]);
    answer = () => ({ status: 'refused', reason: 'running', doing: 'plan' });
    await click(screen.getByRole('button', { name: SHELVE_TEXT }));
    expect(screen.getByRole('status').textContent).toBe('A chat cannot be shelved while it is writing a plan. Wait until it finishes, or stop it, then try again.');
  });

  it('grays Shelve while a turn runs, and a press of it then sends nothing', async () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    select(entry);
    render(<DoneButton entry={entry} />);
    const shelve = screen.getByRole('button', { name: SHELVE_TEXT });
    expect(shelve.getAttribute('aria-disabled')).toBe('true');
    await click(shelve);
    expect(requests).toEqual([]);
  });

  it('is one column of buttons named by their words, one stop to the keyboard, with Up and Down among them', () => {
    const entry = s('Create plan');
    select(entry);
    render(<DoneButton entry={entry} />);
    const bar = screen.getByRole('toolbar', { name: 'Done, shelf and tags' });
    const cells = within(bar).getAllByRole('button');
    expect(cells.map((cell) => [cell.getAttribute('aria-label'), cell.tabIndex])).toEqual([[DONE_TEXT, 0], [SHELVE_TEXT, -1], ['Starred', -1], ['To do', -1], ['To verify', -1]]);
    // The toggles are a group of their own, named by the words before them.
    expect(within(within(bar).getByRole('group', { name: 'Mark as' })).getAllByRole('button').map((cell) => cell.getAttribute('aria-label'))).toEqual(['Starred', 'To do', 'To verify']);
    act(() => cells[0]?.focus());
    fireEvent.keyDown(bar, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells[1]);
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cells[4]);
    // The stop follows the focus.
    expect(cells.map((cell) => cell.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
  });

  it('sets and clears each flag from its toggle, each pressed while its flag is set', async () => {
    const entry = s('Create plan', SUMMARIES.idle, { toVerify: true });
    select(entry);
    render(<DoneButton entry={entry} />);
    const toggle = (name: string) => screen.getByRole('button', { name });
    expect([toggle('Starred').getAttribute('aria-pressed'), toggle('To do').getAttribute('aria-pressed'), toggle('To verify').getAttribute('aria-pressed')]).toEqual(['false', 'false', 'true']);
    expect(toggle('To do').querySelector('svg')).not.toBeNull();
    await click(toggle('Starred'));
    await click(toggle('To do'));
    await click(toggle('To verify'));
    expect(requests).toEqual([['sessions:setFlag', { id: entry.record.id, flag: 'starred', on: true }], ['sessions:setFlag', { id: entry.record.id, flag: 'toDo', on: true }], ['sessions:setFlag', { id: entry.record.id, flag: 'toVerify', on: false }]]);
    answer = () => ({ status: 'refused', reason: 'records-refused' });
    await click(toggle('To do'));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });

  it('has Unshelve under it for a shelved session, which sends sessions:restore', async () => {
    const entry = s('Create plan', SUMMARIES.idle, { shelvedAt: 100 });
    select(entry);
    render(<DoneButton entry={entry} />);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([DONE_TEXT, UNSHELVE_TEXT, 'Starred', 'To do', 'To verify']);
    await click(screen.getByRole('button', { name: UNSHELVE_TEXT }));
    await click(screen.getByRole('button', { name: DONE_TEXT }));
    expect(requests).toEqual([['sessions:restore', { id: entry.record.id }], ['sessions:complete', { id: entry.record.id }]]);
  });

  it('has no Done for a completed session: Restore above Shelve, starred or not', async () => {
    const starred = s('Create plan', SUMMARIES.idle, { completedAt: 100, starred: true });
    const plain = s('Fix login', SUMMARIES.idle, { completedAt: 100 });
    select(starred);
    const { unmount } = render(<DoneButton entry={starred} />);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([RESTORE_TEXT, SHELVE_TEXT, 'Starred', 'To do', 'To verify']);
    await click(screen.getByRole('button', { name: RESTORE_TEXT }));
    unmount();
    select(plain);
    render(<DoneButton entry={plain} />);
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([RESTORE_TEXT, SHELVE_TEXT, 'Starred', 'To do', 'To verify']);
    await click(screen.getByRole('button', { name: SHELVE_TEXT }));
    await click(screen.getByRole('button', { name: RESTORE_TEXT }));
    expect(requests).toEqual([['sessions:restore', { id: starred.record.id }], ['sessions:shelve', { id: plain.record.id }], ['sessions:restore', { id: plain.record.id }]]);
  });

  // M26 (round 2): nothing that never ran a turn is filed under the completed sessions.
  it('says Cancel alone, in Decline’s colours, until a turn has run, and removes the session', async () => {
    const entry = s(null, SUMMARIES.notStarted);
    select(entry);
    render(<DoneButton entry={entry} />);
    expect(screen.queryByRole('button', { name: DONE_TEXT })).toBeNull();
    expect(screen.queryByRole('button', { name: SHELVE_TEXT })).toBeNull();
    expect(screen.queryByRole('button', { name: 'To do' })).toBeNull();
    const cancel = screen.getByRole('button', { name: CANCEL_TEXT });
    expect(cancel.getAttribute('data-done')).toBe('cancel');
    await click(cancel);
    expect(requests).toEqual([['sessions:remove', { id: entry.record.id }]]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is Done again from the first turn, which Decline’s colours leave', () => {
    const entry = s(null, SUMMARIES.runningThinking);
    select(entry);
    render(<DoneButton entry={entry} />);
    expect(screen.getByRole('button', { name: DONE_TEXT }).getAttribute('data-done')).toBe('');
  });

  it('says why a removal failed, in the same place', async () => {
    answer = () => ({ status: 'refused', reason: 'conversations-refused' });
    const entry = s(null, SUMMARIES.notStarted);
    select(entry);
    render(<DoneButton entry={entry} />);
    await click(screen.getByRole('button', { name: CANCEL_TEXT }));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });
});

// M14b, V9 (C28, C29, C62): the session's own instance, and a session main holds back.
describe('a session’s instance (M14b; C28, C29, C62)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  // The same provider's second account: fewer levels for the model both list.
  const work = { ...claude, instanceId: WORK, models: [model('sonnet', 'Sonnet', { efforts: [level('low', 'Low', 1), level('high', 'High', 2)] })] };
  const two: CatalogState = { ...CATALOG, providers: [claude, work, sampleCatalogProvider({ id: 'codex' })] };
  const providers = [...PROVIDERS, sampleProvider({ instanceId: WORK, label: 'Work' })];
  const levels = () => within(screen.getByRole('menu', { name: 'Effort' })).getAllByRole('menuitemradio').map((item) => item.textContent);

  it('lists the levels its own instance reports for its model, not another instance’s', () => {
    select(s('On the second account', SUMMARIES.idle, { instanceId: WORK, effort: 'high' }), { catalog: two, providers });
    render(<Area />);
    fireEvent.click(effortButton());
    expect(levels()).toEqual(['Low', 'High']);
  });

  it('lists the first instance’s levels for a session on it', () => {
    select(s('On the first account', SUMMARIES.idle, { effort: 'high' }), { catalog: two, providers });
    render(<Area />);
    fireEvent.click(effortButton());
    expect(levels()).toHaveLength(4);
  });

  it('shows a session whose instance is no longer configured by its key and its level’s id, with the effort menu disabled', () => {
    // Its provider is there and switched on; only this account is gone.
    select(s('Its account is gone', SUMMARIES.idle, { instanceId: '11111111-2222-4333-8444-555555555555', effort: 'high' }, 'instance-unavailable'), { catalog: two, providers });
    render(<Area />);
    expect([modelText().textContent, effortButton().textContent]).toEqual(['sonnet', 'High']);
    expect(effortButton().disabled).toBe(true);
  });

  it.each(['instance-unavailable', 'folder-moved'] as const)('disables the effort menu of a session held as %s, though its instance has reported', (hold) => {
    select(s('Held', SUMMARIES.idle, { instanceId: WORK, effort: 'high' }, hold), { catalog: two, providers });
    render(<Area />);
    expect(effortButton().disabled).toBe(true);
    fireEvent.click(effortButton());
    expect(screen.queryByRole('menu', { name: 'Effort' })).toBeNull();
    expect(requests).toEqual([]);
  });
});


// M14b, V13 (C47) and the page's part of C29 and C62: the account's label, and why a session is held.
// M100 (round 8; C77, V19): the label under the effort bar; the hold said in the input's place alone.
describe('the account under the effort bar (M14b; C47, C29, C62; M100, C77)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const work = { ...claude, instanceId: WORK };
  const two: CatalogState = { ...CATALOG, providers: [claude, work, sampleCatalogProvider({ id: 'codex' })] };
  const providers = [sampleProvider({ label: 'Personal', instanceVariable: 'CLAUDE_CONFIG_DIR' }), sampleProvider({ instanceId: WORK, label: 'Work', instanceVariable: 'CLAUDE_CONFIG_DIR' }), sampleProvider({ id: 'codex', displayName: 'Codex' })];
  const accountText = () => column().querySelector('[data-session-account]');

  it('shows the session’s account label under the effort bar when its provider has two accounts configured', () => {
    select(s('On the second account', SUMMARIES.idle, { instanceId: WORK }), { catalog: two, providers });
    render(<Area />);
    expect(accountText()?.textContent).toBe('Work');
    expect(within(column()).getByRole('group', { name: 'Account' })).toBe(accountText());
    expect(after(effortButton(), accountText())).toBe(true);
    expect(after(modelText(), accountText())).toBe(true);
  });

  it('shows the first account’s label too', () => {
    select(s('On the first account'), { catalog: two, providers });
    render(<Area />);
    expect(accountText()?.textContent).toBe('Personal');
  });

  it('shows none with one account configured, whatever its label', () => {
    select(s('Create plan'), { providers: [sampleProvider({ label: 'Personal' }), sampleProvider({ id: 'codex', displayName: 'Codex' })] });
    render(<Area />);
    expect(accountText()).toBeNull();
    // Another provider's two accounts name nothing here.
    cleanup();
    select(s('Create plan'), { providers: [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Personal' }), sampleProvider({ id: 'codex', displayName: 'Codex', instanceId: WORK, label: 'Work' })] });
    render(<Area />);
    expect(accountText()).toBeNull();
  });

  it('shows none for a session whose account is no longer configured, and keeps its provider’s colour', () => {
    select(s('Its account is gone', SUMMARIES.idle, { instanceId: '11111111-2222-4333-8444-555555555555', effort: 'high' }, 'instance-unavailable'), { catalog: two, providers });
    render(<Area />);
    expect(accountText()).toBeNull();
    expect(avatar().hasAttribute('data-neutral')).toBe(false);
    expect(avatar().style.getPropertyValue('--bar-color')).toBe('#ff9933');
  });

  it.each(['provider-unavailable', 'instance-unavailable', 'folder-moved'] as const)('draws no note in the block for a session held as %s: the input’s place says why (C77)', (hold) => {
    select(s('Held', SUMMARIES.idle, { instanceId: WORK }, hold), { catalog: two, providers });
    render(<Area />);
    expect(column().querySelector('[data-session-hold], [role="note"]')).toBeNull();
    expect(effortButton().disabled).toBe(true);
  });

  it.each([
    ['provider-unavailable', 'CLAUDE_CONFIG_DIR', 'Its provider is switched off, or is not in this build.'],
    ['instance-unavailable', 'CLAUDE_CONFIG_DIR', 'Its account is switched off, cannot run, or is no longer set up in Settings.'],
    ['folder-moved', 'CLAUDE_CONFIG_DIR', 'This session started in another configuration folder than its account has now (CLAUDE_CONFIG_DIR). It cannot be continued until fat-g is started with that folder again.'],
    ['folder-moved', null, 'This session started in another configuration folder than its account has now. It cannot be continued until fat-g is started with that folder again.'],
  ] as const)('words a session held as %s, with the variable %s, and no path', (hold, variable, said) => {
    expect(holdText(hold, variable)).toBe(said);
  });
});
