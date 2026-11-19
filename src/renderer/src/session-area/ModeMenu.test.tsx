// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// V15, V25, V29, V33, V34 (docs/planning/_archive/M22.md, Design 3, 10; C2, C3, C43, C46, C55, C60, C63, C65,
// C82, C86, C87, C89, C90, C93): the mode control, above the thick rule at the chat column's right (M100) — what its
// button reads, what its menu says of each mode before a press, when nothing can be chosen and why,
// what a choice sends and what a refusal says. Every word of a mode comes from the provider's
// declaration in the app state: the page holds no mode table.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChatSetModeResult, SET_MODE_REFUSALS, type SetModeRefusal } from '@shared/contracts/chat';
import type { SessionGrant } from '@shared/contracts/interaction';
import { MODE_REASONS, MODE_SOURCES, MODE_WORDS, type ModeAvailability, modeReasonWords, type PermissionCapability, type SandboxSetupView } from '@shared/contracts/permissions';
import { SEND_BLOCKS, type SessionEntry } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { SUMMARIES } from '../../../../tests/support/sessions';
import { resetAsides, setAsides } from '../chat/asides-store';
import { resetGrants, setGrants } from '../chat/grants-store';
import { resetWorkflows, useWorkflows } from '../chat/workflow-store';
import { closeSandboxSetup, useSandboxSetup } from '../settings/sandbox-setup-store';
import { SelectedMode } from '../test/selected';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { availability, modedEntry, modedProvider, MODES } from '../test/permissions';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { askModeMenu, resetModeMenuAsk } from './mode-menu-store';
import { MODE_LABELS, SET_MODE_FAILED_TEXT, setModeRefusalText } from './mode-words';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answer: ChatSetModeResult | Error;

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  answer = { status: 'set' };
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    if (answer instanceof Error) throw answer;
    return { ok: true, value: answer };
  });
  resetGrants();
  resetAsides();
  resetModeMenuAsk();
  resetWorkflows();
  closeSandboxSetup();
});
afterEach(cleanup);

const A = project('Calamari');
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const saved = (id = 'ask-first', source: (typeof MODE_SOURCES)[number] = 'project') => ({ id, source });
type Options = Parameters<typeof modedEntry>[2];
const session = (mode = saved(), options: Options = {}): SessionEntry => modedEntry('Create plan', mode, { ...options, record: { projectId: A.id, ...options?.record } });
interface Account { readonly modes?: readonly ModeAvailability[]; readonly sandboxSetup?: SandboxSetupView; readonly capability?: PermissionCapability | null }
function select(entry: SessionEntry, account: Account = {}) {
  const provider = modedProvider({ ...(account.modes === undefined ? {} : { modes: account.modes }), ...(account.sandboxSetup === undefined ? {} : { sandboxSetup: account.sandboxSetup }) }, account.capability === undefined ? MODES : account.capability);
  act(() => { showState({ projects: [A], sessions: [entry], selectedId: entry.record.id, providers: [provider] }); });
}
function open(entry: SessionEntry, account: Account = {}) {
  select(entry, account);
  render(<SelectedMode />);
}
const header = () => document.querySelector('[data-mode-row]') as HTMLElement;
const control = () => header().querySelector('[data-session-mode]');
const button = () => header().querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
const press = () => { fireEvent.click(button()); };
const menu = () => screen.getByRole('menu', { name: MODE_LABELS.menu });
const items = () => within(menu()).getAllByRole('menuitemradio');
const item = (id: string) => menu().querySelector(`[role="menuitemradio"][data-mode="${id}"]`) as HTMLButtonElement;
/** An item's lines: its name, its description, and each thing said of it besides. */
const lines = (id: string): string[] => [...item(id).querySelectorAll('span')].filter((span) => span.children.length === 0).map((span) => span.textContent ?? '');
const notes = (id: string): string[] => lines(id).slice(2);
const said = (): string | null => header().querySelector('p[role="status"]')?.textContent ?? null;
const sent = () => requests.filter(([channel]) => channel === 'chat:setMode').map(([, request]) => request);
const grant = (itemId: string, live: boolean): SessionGrant => ({ itemId, covers: `Bash(${itemId})`, decidedAt: 5, confirmed: true, live });

describe('the mode control (V15, V25; C82, C87)', () => {
  // M100 (C75): the mode's name alone on screen, with no arrow; where it came from is in the accessible name.
  it('reads the chat’s saved mode, and where it came from in its accessible name', () => {
    open(session(saved('ask-first', 'project'), { confirmed: 'ask-first' }));
    expect(header().lastElementChild).toBe(control());
    expect(control()).toMatchObject({ dataset: { sessionMode: 'ask-first', modeSource: 'project' } });
    expect(button().textContent).toBe('Ask first');
    expect(button().querySelector('svg')).toBeNull();
    expect(button().getAttribute('aria-label')).toBe('Mode: Ask first · project default');
    expect(button().getAttribute('aria-haspopup')).toBe('menu');
  });

  it.each(MODE_SOURCES)('says a mode that came from %s in words', (source) => {
    open(session(saved('edits-ok', source), { confirmed: 'edits-ok' }));
    expect(button().getAttribute('aria-label')).toBe(`Mode: Edits ok · ${MODE_WORDS.source[source]}`);
  });

  it('says that a saved mode applies at the next prompt until a process of the session has confirmed it (C75)', () => {
    const entry = session(saved('edits-ok', 'chat'));
    open(entry);
    // No process has confirmed any mode: before the first start, and after every end of its process.
    // Said in the button's accessible name, and on screen nowhere (M100, the maintainer's review).
    expect(control()?.hasAttribute('data-mode-pending')).toBe(true);
    expect(header().textContent).not.toContain(MODE_WORDS.atNextPrompt);
    expect(button().getAttribute('aria-label')).toBe('Mode: Edits ok · this chat, applies at the next prompt');
    // A process that runs under another mode than the one saved has not confirmed it either.
    select(session(saved('edits-ok', 'chat'), { confirmed: 'ask-first' }));
    expect(control()?.hasAttribute('data-mode-pending')).toBe(true);
    select(session(saved('edits-ok', 'chat'), { confirmed: 'edits-ok' }));
    expect(control()?.hasAttribute('data-mode-pending')).toBe(false);
    expect(button().textContent).toBe('Edits ok');
  });

  it('draws no control for a provider that declares no mode, nor for a chat that has none', () => {
    open(session(), { capability: null });
    expect(control()).toBeNull();
    expect(header().querySelectorAll('button')).toHaveLength(0);
    cleanup();
    open({ ...session(), mode: null });
    expect(control()).toBeNull();
  });
});

describe('the mode menu (V15, V25, V34; C3, C63, C82, C87)', () => {
  it('lists the provider’s own modes in its own words, the saved one marked, each with its description', () => {
    open(session(saved('ask-first'), { confirmed: 'ask-first' }));
    press();
    expect(items().map((entry) => entry.dataset['mode'])).toEqual(MODES.modes.map((mode) => mode.id));
    expect(items().map((entry) => entry.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false', 'false']);
    for (const mode of MODES.modes) expect(lines(mode.id).slice(0, 2)).toEqual([mode.label, mode.description]);
    // With nothing known against it, every mode can be chosen.
    expect(items().some((entry) => entry.hasAttribute('aria-disabled'))).toBe(false);
  });

  it('shows another provider’s list for another provider: no mode is the page’s own', () => {
    const other: PermissionCapability = { ...MODES, modes: [{ id: 'careful', label: 'Careful', description: 'Asks about everything', asks: true, reading: false, transitionsFrom: [] }], fallback: 'careful', inherited: 'Another line' };
    open(session(saved('careful', 'fallback')), { capability: other });
    expect(button().textContent).toBe('Careful');
    press();
    expect(items().map((entry) => entry.textContent)).toEqual(['Careful' + 'Asks about everything']);
    expect(menu().textContent).not.toContain('Ask first');
  });

  it('ends its list with the provider’s one line on the user’s own configuration, drawn once (C3)', () => {
    open(session());
    press();
    const inherited = menu().querySelectorAll('[data-mode-inherited]');
    expect(inherited).toHaveLength(1);
    expect(inherited[0]?.textContent).toBe(MODES.inherited);
    expect(menu().lastElementChild).toBe(inherited[0]);
    expect(menu().getAttribute('aria-describedby')).toBe(inherited[0]?.id);
  });

  it('says before the press which change restarts the session’s process, and none for a change the provider declares idle (C2, C87)', () => {
    open(session(saved('ask-first'), { confirmed: 'ask-first' }));
    press();
    // Edits ok is reached from Ask first with no restart; the saved mode is no change at all.
    expect(notes('ask-first')).toEqual([]);
    expect(notes('edits-ok')).toEqual([]);
    for (const id of ['read-only', 'sandbox-ok', 'berserk']) expect(notes(id), id).toEqual([MODE_WORDS.restarts]);
  });

  it('says no restart where no process of the session is live: the choice is saved, and the next prompt starts under it (C75)', () => {
    open(session(saved('ask-first')));
    press();
    for (const id of ['read-only', 'ask-first', 'edits-ok', 'berserk']) expect(notes(id), id).toEqual([]);
  });

  it('says how many of the session’s live grants a restart ends, on the items that restart alone (C86, C87)', () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first' });
    open(entry);
    act(() => { setGrants(entry.record.id, [grant('a', true), grant('b', true), grant('c', false)]); });
    press();
    expect(notes('read-only')).toEqual([MODE_WORDS.restarts, 'Ends this session’s 2 grants']);
    expect(notes('berserk')).toEqual([MODE_WORDS.restarts, 'Ends this session’s 2 grants']);
    // An idle change ends none, and neither does the mode that is already saved.
    expect(notes('edits-ok')).toEqual([]);
    expect(notes('ask-first')).toEqual([]);
    act(() => { setGrants(entry.record.id, [grant('a', true), grant('c', false)]); });
    expect(notes('read-only')).toEqual([MODE_WORDS.restarts, 'Ends this session’s 1 grant']);
    // Ended grants are ended already: nothing is said of them.
    act(() => { setGrants(entry.record.id, [grant('c', false)]); });
    expect(notes('read-only')).toEqual([MODE_WORDS.restarts]);
  });

  it('says what choosing a mode makes the CLI record, where it can write and that an account has no sandbox, as its account’s snapshot says (C4, C55, C65)', () => {
    open(session(saved('read-only'), { confirmed: 'read-only' }), { modes: [
      availability('ask-first', { unconfined: true }),
      availability('sandbox-ok', { records: true, places: { temporary: true, roots: ['D:\\Shared', 'D:\\Other'], network: true } }),
      availability('edits-ok', { places: { temporary: false, roots: [], network: false } }),
    ] });
    press();
    expect(notes('ask-first')).toEqual([MODE_WORDS.unconfined, MODE_WORDS.restarts]);
    expect(notes('sandbox-ok')).toEqual([MODE_WORDS.temporary, 'Your own Claude configuration adds 2 writable folders', 'Your own Claude configuration lets it reach the network', 'Choosing it makes Claude record this folder as trusted in its own configuration', MODE_WORDS.restarts]);
    expect(notes('edits-ok')).toEqual([MODE_WORDS.restarts]);
    // A root is a path of the user's: counted, and never drawn.
    expect(menu().textContent).not.toContain('D:\\Shared');
  });
});

describe('a mode its account cannot use (V15, V25, V33; C43, C60, C93)', () => {
  it.each(MODE_REASONS)('is listed, not to be chosen, with its reason: %s', async (reason) => {
    open(session(saved('ask-first'), { confirmed: 'ask-first' }), { modes: [availability('berserk', { available: false, reason })] });
    press();
    expect(item('berserk').getAttribute('aria-disabled')).toBe('true');
    expect(item('berserk').dataset['unavailable']).toBe(reason);
    expect(notes('berserk')).toEqual([modeReasonWords(reason, 'Berserk', 'Claude'), MODE_WORDS.restarts]);
    // Still an item of the menu: it is reached, and read, as any other.
    expect(items()).toContain(item('berserk'));
    fireEvent.click(item('berserk'));
    await settle();
    expect(sent()).toEqual([]);
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('says so in words where main gave no reason', () => {
    open(session(), { modes: [availability('berserk', { available: false })] });
    press();
    expect(notes('berserk')).toEqual(['This account cannot use Berserk.']);
  });

  it('has a Set up item where the CLI’s own setup would make it usable, which opens the setup’s dialog for the session’s account and sends nothing (C60)', async () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first' });
    open(entry, { modes: [availability('sandbox-ok', { available: false, reason: 'needs-setup', setup: true }), availability('berserk', { available: false, reason: 'unvalidated' })] });
    press();
    const setUps = within(menu()).getAllByRole('menuitem');
    expect(setUps.map((control) => [control.textContent, control.getAttribute('aria-label'), control.dataset['modeSetup']])).toEqual([['Set up…', 'Set up… (Sandbox ok)', 'sandbox-ok']]);
    // It stands right after the mode it is for.
    expect(item('sandbox-ok').nextElementSibling).toBe(setUps[0]);
    fireEvent.click(setUps[0] as HTMLElement);
    await settle();
    expect(useSandboxSetup.getState()).toEqual({ open: true, target: { providerId: entry.record.providerId, instanceId: entry.record.instanceId } });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe('a change of mode (V15, V29; C2, C40, C46, C89)', () => {
  it('asks main for the mode chosen, by the session and the mode’s id, and for nothing where the saved one is chosen', async () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first' });
    open(entry);
    press();
    fireEvent.click(item('ask-first'));
    await settle();
    expect(requests).toEqual([]);
    expect(screen.queryByRole('menu')).toBeNull();
    press();
    fireEvent.click(item('edits-ok'));
    await settle();
    // The chat's mode alone: no default is saved from here, and no word of the CLI's is sent.
    expect(requests).toEqual([['chat:setMode', { sessionId: entry.record.id, mode: 'edits-ok' }]]);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(said()).toBeNull();
  });

  it('shows what the session’s entry says once main has taken the change: the page keeps no mode of its own', async () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first' });
    open(entry);
    press();
    fireEvent.click(item('read-only'));
    await settle();
    // Until main publishes it, the button reads what it read.
    expect(button().textContent).toBe('Ask first');
    select({ ...entry, mode: { id: 'read-only', source: 'chat' }, summary: { ...entry.summary, mode: null } });
    expect(button().textContent).toBe('Read only');
    expect(control()?.hasAttribute('data-mode-pending')).toBe(true);
  });

  it('says a refusal under the button, in a status region, until the menu is opened again', async () => {
    open(session(saved('ask-first'), { confirmed: 'ask-first' }));
    answer = { status: 'refused', reason: 'storage-failed' };
    press();
    fireEvent.click(item('edits-ok'));
    await settle();
    expect(said()).toBe('fat-g could not save the mode, so it is as it was.');
    press();
    expect(said()).toBeNull();
  });

  it('says what the CLI reported where it did not confirm the change, and that nothing can be sent until one is (C46)', async () => {
    open(session(saved('ask-first'), { confirmed: 'ask-first' }));
    answer = { status: 'refused', reason: 'not-confirmed', detail: 'permission mode is default' };
    press();
    fireEvent.click(item('edits-ok'));
    await settle();
    expect(said()).toBe('Claude did not confirm Edits ok, so this chat’s mode is as it was and nothing can be sent until a mode is confirmed. Claude reported: permission mode is default');
  });

  it('says a refusal for the mode asked for by that mode’s own reason, and nothing for one already saved (C43, C89)', async () => {
    // The page knew nothing against it; main does.
    open(session(saved('ask-first'), { confirmed: 'ask-first' }));
    answer = { status: 'refused', reason: 'mode-unavailable' };
    press();
    fireEvent.click(item('berserk'));
    await settle();
    expect(said()).toBe('This account cannot use Berserk.');
    answer = { status: 'refused', reason: 'same' };
    press();
    fireEvent.click(item('edits-ok'));
    await settle();
    expect(said()).toBeNull();
    answer = new Error('gone');
    press();
    fireEvent.click(item('edits-ok'));
    await settle();
    expect(said()).toBe(SET_MODE_FAILED_TEXT);
  });

  it('has words for every refusal main can give, a session’s own block among them', () => {
    const asked = { label: 'Sandbox ok', availability: availability('sandbox-ok', { available: false, reason: 'needs-setup' }) };
    const silent: readonly SetModeRefusal[] = ['same'];
    for (const reason of SET_MODE_REFUSALS) {
      const text = setModeRefusalText(reason, 'Codex', asked, null);
      if (silent.includes(reason)) expect(text, reason).toBeNull();
      else expect(text, reason).toMatch(/\S/);
    }
    for (const block of SEND_BLOCKS) expect(setModeRefusalText(block, 'Codex', asked), block).toMatch(/\S/);
    expect(setModeRefusalText('mode-unavailable', 'Codex', asked)).toBe(modeReasonWords('needs-setup', 'Sandbox ok', 'Codex'));
    expect(setModeRefusalText('setting-up', 'Codex', asked)).toBe(MODE_WORDS.settingUp('Codex'));
    expect(setModeRefusalText('running', 'Codex', asked)).toBe(MODE_WORDS.busy);
  });

  it('asks main for the chat’s own mode again where its last start did not confirm it, and says on its item that choosing it is another try (C46, C104)', async () => {
    const entry = session(saved('ask-first', 'fallback'), { block: 'mode-unconfirmed' });
    open(entry);
    press();
    // Said on the saved mode alone, before the press.
    expect(notes('ask-first')).toEqual([MODE_WORDS.tryAgain]);
    expect(notes('edits-ok')).toEqual([]);
    fireEvent.click(item('ask-first'));
    await settle();
    expect(requests).toEqual([['chat:setMode', { sessionId: entry.record.id, mode: 'ask-first' }]]);
    expect(screen.queryByRole('menu')).toBeNull();
    // Under the other block the saved mode is the one the account cannot use: it is listed, and not to be chosen.
    requests.length = 0;
    const unusable = session(saved('sandbox-ok'), { block: 'mode-unavailable' });
    select(unusable, { modes: [availability('sandbox-ok', { available: false, reason: 'needs-setup', setup: true })] });
    press();
    expect(notes('sandbox-ok')).not.toContain(MODE_WORDS.tryAgain);
    fireEvent.click(item('sandbox-ok'));
    await settle();
    expect(requests).toEqual([]);
  });

  it.each(['mode-unavailable', 'mode-unconfirmed'] as const)('is taken under the block %s, whose remedy it is: every usable mode can be chosen (V29; C89)', async (block) => {
    const entry = session(saved('sandbox-ok', 'chat'), { block });
    open(entry, { modes: [availability('sandbox-ok', { available: false, reason: 'needs-setup', setup: true })] });
    press();
    // The saved mode is the one that cannot be used; the others are as they always are.
    expect(items().filter((entry) => entry.getAttribute('aria-disabled') === 'true').map((entry) => entry.dataset['mode'])).toEqual(['sandbox-ok']);
    expect(menu().querySelector('[data-mode-held]')).toBeNull();
    fireEvent.click(item('ask-first'));
    await settle();
    expect(sent()).toEqual([{ sessionId: entry.record.id, mode: 'ask-first' }]);
  });

  it('opens when Change mode is pressed in the chat, for its own session alone (C89)', () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first', block: 'mode-unconfirmed' });
    open(entry);
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => { askModeMenu('5e55ffff-0000-4000-8000-00000000ffff'); });
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => { askModeMenu(entry.record.id); });
    expect(menu()).toBeTruthy();
    // Opened for the keyboard: the saved mode has the focus.
    expect(document.activeElement).toBe(item('ask-first'));
  });
});

describe('when nothing can be chosen (V2, V30; C2, C62, C90)', () => {
  const held = async (entry: SessionEntry, account: Account, reason: string): Promise<void> => {
    open(entry, account);
    // Said at the button, for whoever reaches it without opening it.
    const descriptions = (button().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(descriptions).toEqual([MODE_LABELS.tooltip, reason]);
    press();
    // The menu still opens, to be read, with the reason at its head.
    expect(menu().querySelector('[data-mode-held]')?.textContent).toBe(reason);
    expect(menu().firstElementChild?.textContent).toBe(MODE_LABELS.menu);
    expect(menu().firstElementChild?.nextElementSibling).toBe(menu().querySelector('[data-mode-held]'));
    expect(items().every((entry) => entry.getAttribute('aria-disabled') === 'true')).toBe(true);
    fireEvent.click(item('edits-ok'));
    await settle();
    expect(sent()).toEqual([]);
  };

  it('says why while the session runs', async () => {
    await held(session(saved('ask-first'), { confirmed: 'ask-first', summary: SUMMARIES.runningThinking }), {}, MODE_WORDS.busy);
  });

  it('says why while a plan’s decision waits in the chat (M22b, C58)', async () => {
    await held({ ...session(saved('ask-first'), { confirmed: 'ask-first' }), planPending: true }, {}, MODE_WORDS.planPending);
  });

  it('takes a change while the chat’s plan is ready, the request it holds on it what runs; and holds it while the plan is under review (decision 0029)', async () => {
    const entry = { ...session(saved('ask-first'), { confirmed: 'ask-first', summary: SUMMARIES.runningThinking }), planPending: true };
    const flow = (state: 'ready' | 'reviewing') => ({ kind: 'plan' as const, role: 'participant' as const, workflow: { planId: 'plan-1', state, revision: 3, version: 1, participants: [entry.record.id], holder: null, operation: null, reviewId: null, busy: null } });
    act(() => { useWorkflows.setState({ bySession: { [entry.record.id]: flow('ready') } }); });
    open(entry);
    press();
    fireEvent.click(item('edits-ok'));
    await settle();
    expect(requests).toEqual([['chat:setMode', { sessionId: entry.record.id, mode: 'edits-ok' }]]);
    cleanup();
    requests.length = 0;
    act(() => { useWorkflows.setState({ bySession: { [entry.record.id]: flow('reviewing') } }); });
    await held(entry, {}, MODE_WORDS.busy);
  });

  it('says why while a change of its mode is under way (C90)', async () => {
    await held(session(saved('ask-first'), { confirmed: 'ask-first', changingMode: true }), {}, MODE_WORDS.busy);
  });

  it('says why while an aside of it runs (C2)', async () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first' });
    act(() => { setAsides(entry.record.id, [{ id: 'a1', title: 'A side question', source: null, createdAt: 1, running: true }], 'none'); });
    await held(entry, {}, MODE_WORDS.busy);
  });

  it.each(['starting', 'waiting'] as const)('says why while the account’s sandbox setup is %s (C62)', async (state) => {
    await held(session(saved('ask-first'), { confirmed: 'ask-first' }), { sandboxSetup: { state, error: null, readiness: 'not-configured' } }, 'Claude’s sandbox is being set up for this account.');
  });

  it('is as it always is once that has ended: an aside that finished, a setup that failed or completed', () => {
    const entry = session(saved('ask-first'), { confirmed: 'ask-first' });
    act(() => { setAsides(entry.record.id, [{ id: 'a1', title: 'A side question', source: null, createdAt: 1, running: false }], 'none'); });
    open(entry, { sandboxSetup: { state: 'failed', error: 'declined', readiness: 'not-configured' } });
    expect(document.getElementById(button().getAttribute('aria-describedby') ?? '')?.textContent).toBe(MODE_LABELS.tooltip);
    press();
    expect(menu().querySelector('[data-mode-held]')).toBeNull();
    expect(items().some((entry) => entry.hasAttribute('aria-disabled'))).toBe(false);
  });
});

describe('the mode menu by the keyboard (V10; C36)', () => {
  it('opens from the button on Arrow Down with the saved mode focused, goes through every item — a Set up item among them — and closes on Escape with the focus back on its button', () => {
    open(session(saved('edits-ok'), { confirmed: 'edits-ok' }), { modes: [availability('sandbox-ok', { available: false, reason: 'needs-setup', setup: true })] });
    button().focus();
    fireEvent.keyDown(button(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('edits-ok'));
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    // A mode that cannot be chosen is still reached: its reason is read there.
    expect(document.activeElement).toBe(item('sandbox-ok'));
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(menu()).getByRole('menuitem'));
    fireEvent.keyDown(menu(), { key: 'End' });
    expect(document.activeElement).toBe(item('berserk'));
    fireEvent.keyDown(menu(), { key: 'Home' });
    expect(document.activeElement).toBe(item('read-only'));
    fireEvent.keyDown(menu(), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('has no control that offers a mode for one prompt alone (S9)', () => {
    open(session());
    press();
    // Its items are the provider's modes, and nothing else chooses a mode.
    expect(within(menu()).getAllByRole('menuitemradio')).toHaveLength(MODES.modes.length);
    expect(within(menu()).queryAllByRole('menuitem')).toEqual([]);
    expect(menu().querySelectorAll('input, select')).toHaveLength(0);
  });
});
