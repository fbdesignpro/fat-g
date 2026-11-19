// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import { DEFAULT_ATTENTION_FLASH } from '@shared/contracts/appearance';
import type { Preferences, PreferencesSnapshot } from '@shared/contracts/prefs';
import type { ProviderActionResult } from '@shared/contracts/provider';
import type { ProviderSnapshot, ProviderStatus } from '@shared/contracts/status';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider, sampleSnapshot, sampleWindow } from '../../../../tests/support/app-state';
import { sampleModel } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { modedProvider, MODES } from '../test/permissions';
import { prefsSnapshot, savedPrefs } from '../test/prefs';
import { closeSettings, openSettings, type SettingsTarget, useSettings } from './settings-store';
import { SettingsDialog } from './SettingsDialog';
import { SETTINGS_TABS_LABEL } from './SettingsTabs';

let bridge: FakeBridge;

/**
 * The Storage section asks main for its sizes whenever Settings opens (M18, C23). That read is left
 * unanswered here and kept out of what a test sees, so each one's stand-in and its record of calls
 * hold only what the test is about; the section's own tests are in StorageSection.test.tsx.
 */
function installBridge(platform?: string): FakeBridge {
  const fake = installFakeBridge(platform);
  const storage: InvokeChannel = 'conversations:storage';
  return {
    ...fake,
    get calls() { return fake.calls.filter((call) => call !== `invoke:${storage}` && call !== 'invoke:audio:list' && call !== 'invoke:diagnostics:dataResetInfo'); },
    setInvoke: (impl) => fake.setInvoke((channel, request) => (channel === storage || channel === 'audio:list' || channel === 'diagnostics:dataResetInfo' ? new Promise<never>(() => undefined) : impl(channel, request))),
  };
}

beforeAll(installDialogStandIn);
beforeEach(() => {
  bridge = installBridge();
  usePrefs.setState({ snapshot: null, error: null, saving: false });
  useAppState.setState({ snapshot: null, error: null });
  // As at the first opening in a run: the shown tab is kept between openings (M101, C7).
  useSettings.setState({ open: false, target: null, tab: 'general' });
});
afterEach(cleanup);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const renderOpen = (target: SettingsTarget | null = null) => {
  const view = render(<SettingsDialog />);
  act(() => openSettings(target));
  return view;
};
/** Found open or closed: a closed dialog is hidden from role queries. */
const dialog = (): HTMLDialogElement => {
  const element = document.querySelector('dialog');
  if (element === null) throw new Error('no dialog');
  return element;
};
const ACCOUNTS: SettingsTarget = { section: 'accounts' };
const tabList = () => screen.getByRole('tablist', { name: SETTINGS_TABS_LABEL });
const tabs = () => within(tabList()).getAllByRole('tab');
const tab = (name: string) => within(tabList()).getByRole('tab', { name });
const shown = () => tabs().filter((element) => element.getAttribute('aria-selected') === 'true').map((element) => element.textContent);
const panel = () => screen.getByRole('tabpanel');
const key = (name: string) => fireEvent.keyDown(document.activeElement as Element, { key: name });
/** The elements Tab would stop at, in order: what has a tab index of zero. */
const stops = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]')].filter((element) => element.tabIndex === 0);
const maskCheckbox = () => screen.getByLabelText<HTMLInputElement>(/Mask the account email/);
const petCheckbox = () => screen.getByLabelText<HTMLInputElement>(/Show the mini window/);
const intervalInput = () => screen.getByLabelText<HTMLInputElement>(/Check usage every/);
const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
const withPet = (visible: boolean): Partial<Preferences> => ({ windows: { ...prefsSnapshot().values.windows, pet: { visible, autoHideOnMainFocus: true, bounds: null, size: 'capsule' } } });

describe('the dialog (C43, C44, C50)', () => {
  it('opens as a modal dialog', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog());
    expect(dialog().hasAttribute('open')).toBe(true);
  });

  it('closes from its close button, and the store follows', () => {
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(useSettings.getState()).toMatchObject({ open: false, target: null });
  });

  it('follows the store when something else closes it', () => {
    renderOpen();
    act(() => closeSettings());
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('hands the focus back to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // M101 (V2; C3, C8): a provider's target lands in Accounts.
  it('opens at a provider’s part, in Accounts, scrolled into view with its heading focused (C41)', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    useAppState.setState({ snapshot: sampleSnapshot(1) });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderOpen({ provider: 'codex' });
    expect(shown()).toEqual(['Accounts']);
    const heading = within(panel()).getByRole('heading', { name: 'Codex' });
    expect(document.activeElement).toBe(heading);
    expect(scrolled.mock.contexts).toContain(heading);
  });

  // M101 (V2; C6): the tab is the section's landing point.
  it('opens at a section: its tab shown, with the focus on it', () => {
    renderOpen({ section: 'diagnostics' });
    expect(shown()).toEqual(['Diagnostics']);
    expect(document.activeElement).toBe(tab('Diagnostics'));
    expect(screen.getByRole('tabpanel', { name: 'Diagnostics' })).toBeTruthy();
  });

  // M101 (V1; C7, C13): nor the shown tab, which is kept in memory alone.
  it('saves nothing about itself: opening, moving among the tabs and closing send nothing to main (C50)', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    useAppState.setState({ snapshot: sampleSnapshot(1) });
    renderOpen({ provider: 'claude' });
    fireEvent.click(tab('Appearance'));
    act(() => { tab('Appearance').focus(); });
    key('ArrowLeft');
    key('End');
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    act(() => openSettings({ section: 'general' }));
    act(() => closeSettings());
    act(() => openSettings());
    expect(bridge.calls.filter((call) => call.startsWith('invoke:'))).toEqual([]);
  });

  it('waits for the preferences, and says when they could not be read', () => {
    renderOpen();
    expect(within(dialog()).getByText('Loading your preferences…', { selector: '[role="status"]' })).toBeTruthy();
    act(() => usePrefs.setState({ error: 'forbidden' }));
    expect(screen.getByText('Preferences could not be read (forbidden).')).toBeTruthy();
  });

  it('shows About and the full license with read-only preferences, without invoking main', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'read-only', reason: 'corrupt' }) });
    renderOpen({ section: 'about' });
    const about = screen.getByRole('tabpanel', { name: 'About' });
    expect(document.activeElement).toBe(tab('About'));
    expect(within(about).getByText('Francois Bertrand')).toBeTruthy();
    expect(about.textContent).toContain('https://github.com/fbdesignpro/fat-g');
    expect(about.textContent).toContain('not an additional license requirement');
    const license = within(about).getByText('Read the MIT license').closest('details');
    expect(license?.querySelector('pre')?.textContent).toContain('Copyright (c) 2026 Francois Bertrand and the fat-g contributors');
    expect(license?.querySelector('pre')?.textContent).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(bridge.calls.filter((call) => call.startsWith('invoke:'))).toEqual([]);
  });
});

// ── M101 (docs/planning/_archive/M101-spec-sheet.md): the tabs ────────────────────────────────────────────
describe('the tabs (M101: V1, V2; C1–C3, C5–C7, C14, C16)', () => {
  const ORDER = ['General', 'Accounts', 'Appearance', 'Avatars', 'Audio', 'Presets', 'Storage', 'Diagnostics', 'About'];

  it('stand on one row under the header in the requested order, General first and Accounts second', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    expect(tabs().map((element) => element.textContent)).toEqual(ORDER);
    for (const element of tabs()) expect(element.tagName).toBe('BUTTON');
    // The header keeps its title and its close button, and the row comes after it.
    const header = within(dialog()).getByRole('heading', { level: 2, name: 'Settings' }).parentElement as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Close settings' })).toBeTruthy();
    expect(header.compareDocumentPosition(tabList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog()).queryByText('Providers')).toBeNull();
  });

  it('show General at the first opening, and one panel at a time, labelled by its tab (C5, C6, C14)', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    useAppState.setState({ snapshot: sampleSnapshot(1) });
    renderOpen();
    expect(shown()).toEqual(['General']);
    for (const name of ORDER) {
      fireEvent.click(tab(name));
      expect(shown()).toEqual([name]);
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
      expect(screen.getByRole('tabpanel', { name })).toBe(panel());
      expect(within(dialog()).queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(name === 'General' ? ['General Options'] : name === 'Diagnostics' ? ['Application data'] : name === 'About' ? ['fat-g'] : []);
      for (const element of tabs()) expect(element.getAttribute('aria-controls')).toBe(panel().id);
    }
    // Each panel is its section's content: Accounts holds the providers' parts.
    fireEvent.click(tab('Accounts'));
    expect(within(panel()).getByRole('heading', { level: 4, name: 'Claude' })).toBeTruthy();
    fireEvent.click(tab('General'));
    expect(within(panel()).getByLabelText(/Mask the account email/)).toBeTruthy();
    expect(within(panel()).queryByRole('heading', { name: 'Claude' })).toBeNull();
  });

  // M102 (V8; C36, C39): the Avatars tab replaces M101's line; its own tests are in AvatarsSection.test.tsx.
  it('opens the PNG family guide and returns focus to its button without closing Settings', async () => {
    renderOpen({ section: 'avatars' });
    await act(async () => { await flush(); });
    const opener = within(panel()).getByRole('button', { name: 'Technical details' });
    for (const closeWith of ['Close avatar family guide', 'Got it', 'native close']) {
      opener.focus();
      fireEvent.click(opener);
      const guide = screen.getByRole<HTMLDialogElement>('dialog', { name: 'Avatar families' });
      expect(document.activeElement).toBe(within(guide).getByRole('heading', { level: 2 }));
      expect(guide.textContent).toContain('Default/');
      expect(guide.textContent).toContain('portrait.png');
      expect(guide.textContent).toContain('small.png');
      expect(guide.textContent).toContain('512 × 512 px');
      expect(guide.textContent).toContain('64 × 64 px');
      expect(guide.textContent).toContain('5 MiB');
      expect(guide.textContent).toContain('8,000 pixels per side');
      expect(guide.textContent).not.toMatch(/webp/i);
      if (closeWith === 'native close') act(() => guide.close());
      else fireEvent.click(within(guide).getByRole('button', { name: closeWith }));
      expect(screen.queryByRole('dialog', { name: 'Avatar families' })).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(dialog().open).toBe(true);
      expect(useSettings.getState().open).toBe(true);
    }
  });

  it('hold the avatars in Avatars, whose family editor closes over Settings and leaves it open', async () => {
    const listing = { roots: [{ origin: 'built-in', families: [{ origin: 'built-in', folder: 'Orange', author: null, licence: null, defaultFor: ['claude'], unknownProviders: [], problems: [], avatars: [{ folder: 'Default', files: [{ id: '0'.repeat(32), role: 'portrait', format: 'webp', width: 512, height: 512, bytes: 1000 }], unused: [], matches: [], problems: [], fallback: true }] }], problems: [] }, { origin: 'user', families: [], problems: [] }] };
    bridge.setInvoke(async (channel) => ({ ok: true, value: channel === 'avatars:list' ? listing : null }));
    renderOpen({ section: 'avatars' });
    await act(async () => { await flush(); });
    expect(panel().textContent).not.toContain('Nothing here yet.');
    expect(within(panel()).getByRole('button', { name: 'Rescan' })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Edit family Orange' }));
    await act(async () => { await flush(); });
    const editor = document.querySelector<HTMLDialogElement>('dialog[data-family-editor]') as HTMLDialogElement;
    expect(editor.hasAttribute('open')).toBe(true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('dialog[data-family-editor]')).toBeNull();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(useSettings.getState().open).toBe(true);
  });

  it('show the tab last shown at the next opening in the run, and a target’s own tab when it names one (C7, C8)', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    fireEvent.click(tab('Storage'));
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    act(() => openSettings());
    expect(shown()).toEqual(['Storage']);
    act(() => closeSettings());
    act(() => openSettings({ provider: 'codex', instanceId: 'default' }));
    expect(shown()).toEqual(['Accounts']);
    act(() => closeSettings());
    act(() => openSettings());
    expect(shown()).toEqual(['Accounts']);
  });

  it('ask main for what a tab shows only when it is shown: Storage’s sizes (C5; M18, C23)', () => {
    const fake = installFakeBridge();
    fake.setInvoke(() => new Promise<never>(() => undefined));
    const asked = () => fake.calls.filter((call) => call === 'invoke:conversations:storage').length;
    renderOpen();
    expect(asked()).toBe(0);
    fireEvent.click(tab('Storage'));
    expect(asked()).toBe(1);
    fireEvent.click(tab('Diagnostics'));
    fireEvent.click(tab('Storage'));
    expect(asked()).toBe(2);
  });

  // M101 (V2; C3, C8; M14b, C38): an account's target, the provider's heading standing in.
  it('land an account’s target in Accounts, on its provider’s heading when the account has no row of its own', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    useAppState.setState({ snapshot: sampleSnapshot(1, [sampleProvider({ id: 'codex', displayName: 'Codex' })]) });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderOpen({ provider: 'codex', instanceId: 'default' });
    expect(shown()).toEqual(['Accounts']);
    const heading = within(panel()).getByRole('heading', { level: 5, name: 'Account: user@example.com' });
    expect(document.activeElement).toBe(heading);
    expect(scrolled.mock.contexts).toContain(heading);
  });
});

// M101 (V3; C9): the row by the keyboard and the pointer.
describe('the tabs by the keyboard and the pointer (M101: V3; C9)', () => {
  it('are one stop, the shown tab, and Tab goes on from it into the panel', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    expect(tabs().map((element) => element.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1, -1, -1]);
    expect(stops(tabList())).toEqual([tab('General')]);
    const order = stops(dialog());
    expect(order.slice(0, 3)).toEqual([screen.getByRole('button', { name: 'Close settings' }), tab('General'), panel()]);
    fireEvent.click(tab('Avatars'));
    // The panel is a stop of its own before its controls, so the keyboard reaches it and scrolls it.
    expect(stops(dialog()).slice(1, 3)).toEqual([tab('Avatars'), panel()]);
  });

  it('move and select at once with Left and Right, Home and End, stopping at each end', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    act(() => { tab('General').focus(); });
    key('ArrowRight');
    expect(document.activeElement).toBe(tab('Accounts'));
    expect(shown()).toEqual(['Accounts']);
    expect(screen.getByRole('tabpanel', { name: 'Accounts' })).toBeTruthy();
    key('End');
    expect(document.activeElement).toBe(tab('About'));
    expect(shown()).toEqual(['About']);
    key('ArrowRight');
    expect(shown()).toEqual(['About']);
    key('ArrowLeft');
    expect(document.activeElement).toBe(tab('Diagnostics'));
    expect(shown()).toEqual(['Diagnostics']);
    key('Home');
    expect(document.activeElement).toBe(tab('General'));
    expect(shown()).toEqual(['General']);
    key('ArrowLeft');
    expect(shown()).toEqual(['General']);
    // The stop follows: the shown tab is the one Tab comes back to.
    key('End');
    expect(stops(tabList())).toEqual([tab('About')]);
  });

  it('leave a key with a modifier, and any other key, to the page', () => {
    renderOpen();
    act(() => { tab('General').focus(); });
    fireEvent.keyDown(tab('General'), { key: 'ArrowRight', ctrlKey: true });
    fireEvent.keyDown(tab('General'), { key: 'ArrowDown' });
    expect(shown()).toEqual(['General']);
  });

  it('select a tab by the pointer', () => {
    renderOpen();
    fireEvent.click(tab('Accounts'));
    expect(shown()).toEqual(['Accounts']);
    expect(useSettings.getState().tab).toBe('accounts');
  });
});

describe('Appearance (C12, C13)', () => {
  // The maintainer: the attention flash's switch, speed and duration, each saved on its own.
  it('shows the attention flash, and saves its switch, speed and duration each on its own', async () => {
    const patches: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      patches.push(request);
      return { ok: true, value: savedPrefs({ appearance: { theme: 'light', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: { enabled: true, speed: 'slow', seconds: 5 } } }) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen({ section: 'appearance' });
    const flash = within(screen.getByRole('group', { name: 'Attention flash' }));
    const on = flash.getByRole<HTMLInputElement>('checkbox', { name: 'Flash a session’s status when it needs you' });
    const speed = flash.getByRole<HTMLSelectElement>('combobox', { name: 'Speed' });
    const length = flash.getByRole<HTMLSelectElement>('combobox', { name: 'For' });
    expect([on.checked, speed.value, length.value]).toEqual([true, 'fast', '3']);
    expect([...speed.options].map((option) => option.text)).toEqual(['Slow', 'Medium', 'Fast']);
    expect([...length.options].map((option) => option.text)).toEqual(['1 second', '2 seconds', '3 seconds', '5 seconds', '10 seconds']);
    fireEvent.change(speed, { target: { value: 'slow' } });
    await act(flush);
    fireEvent.change(length, { target: { value: '5' } });
    await act(flush);
    fireEvent.click(on);
    await act(flush);
    expect(patches).toEqual([{ appearance: { flash: { speed: 'slow' } } }, { appearance: { flash: { seconds: 5 } } }, { appearance: { flash: { enabled: false } } }]);
  });

  it('holds the speed and duration while the flash is off', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ appearance: { theme: 'light', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: { enabled: false, speed: 'medium', seconds: 2 } } }) });
    renderOpen({ section: 'appearance' });
    const flash = within(screen.getByRole('group', { name: 'Attention flash' }));
    expect(flash.getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
    expect(flash.getAllByRole<HTMLSelectElement>('combobox').map((select) => [select.value, select.disabled])).toEqual([['medium', true], ['2', true]]);
  });

  it('shows the saved theme and column side', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ appearance: { theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH }, layout: { projectColumn: 'right' } }) });
    renderOpen({ section: 'appearance' });
    expect(radio('Dark').checked).toBe(true);
    expect(radio('Light').checked).toBe(false);
    expect(radio('Right').checked).toBe(true);
    expect(radio('Left').checked).toBe(false);
  });

  it('patches the theme and the side, each on its own', async () => {
    const patches: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      patches.push(request);
      return { ok: true, value: savedPrefs({ appearance: { theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH } }) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen({ section: 'appearance' });
    fireEvent.click(radio('Dark'));
    await act(flush);
    // The defaults have the projects on the left (C91), so the side that is a change is the right.
    fireEvent.click(radio('Right'));
    await act(flush);
    expect(patches).toEqual([{ appearance: { theme: 'dark' } }, { layout: { projectColumn: 'right' } }]);
    expect(radio('Dark').checked).toBe(true);
  });

  it('has the focus on the chosen theme again once it is saved: the group is disabled meanwhile, and a disabled control cannot hold it', async () => {
    bridge.setInvoke(async () => ({ ok: true, value: savedPrefs({ appearance: { theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH } }) }));
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen({ section: 'appearance' });
    // An arrow key moves the focus to Dark and chooses it, which saves it.
    radio('Dark').focus();
    fireEvent.click(radio('Dark'));
    expect((radio('Dark').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    // What the browser does as the group is disabled, and jsdom does not: the focus goes to nothing.
    const close = screen.getByRole('button', { name: 'Close settings' });
    close.focus();
    close.blur();
    fireEvent.focusOut(radio('Dark'), { relatedTarget: null });
    expect(document.activeElement).toBe(document.body);
    await act(flush);
    expect((radio('Dark').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
    expect(document.activeElement).toBe(radio('Dark'));
  });
});

describe('General', () => {
  it('shows the saved values', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ privacy: { maskEmail: false }, usage: { pollIntervalSec: 900 } }) });
    renderOpen();
    expect(maskCheckbox().checked).toBe(false);
    expect(intervalInput().value).toBe('900');
  });

  it('sends a patch when the mask is toggled', async () => {
    const patches: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      patches.push(request);
      return { ok: true, value: savedPrefs({ privacy: { maskEmail: false } }) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    fireEvent.click(maskCheckbox());
    await act(flush);
    expect(patches).toEqual([{ privacy: { maskEmail: false } }]);
    expect(maskCheckbox().checked).toBe(false);
  });

  it('shows whether new sessions are named automatically, on by default, and changes it (M26)', async () => {
    const patches: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      patches.push(request);
      return { ok: true, value: savedPrefs({ titles: { generated: false, models: {} } }) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    const box = screen.getByLabelText<HTMLInputElement>(/Name sessions automatically/);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await act(flush);
    expect(patches).toEqual([{ titles: { generated: false } }]);
    expect(box.checked).toBe(false);
  });

  it('shows what Enter does while a turn runs, Send now by default, and changes it (M23, C80)', async () => {
    const patches: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      patches.push(request);
      return { ok: true, value: savedPrefs({ composer: { busyEnter: 'queue' } }) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    const choice = screen.getByLabelText<HTMLSelectElement>(/While a reply is in progress, “Enter”/);
    expect(choice.value).toBe('send-now');
    fireEvent.change(choice, { target: { value: 'queue' } });
    await act(flush);
    expect(patches).toEqual([{ composer: { busyEnter: 'queue' } }]);
    expect(choice.value).toBe('queue');
  });

  it('shows whether the Pet window is wanted, and changes it', async () => {
    const patches: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      patches.push(request);
      return { ok: true, value: savedPrefs(withPet(true)) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot(withPet(false)) });
    renderOpen();
    expect(petCheckbox().checked).toBe(false);
    fireEvent.click(petCheckbox());
    await act(flush);
    expect(patches).toEqual([{ windows: { pet: { visible: true } } }]);
    expect(petCheckbox().checked).toBe(true);
  });

  it('sends the interval when the field is left, not on every keystroke, and shows what main saved', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: savedPrefs({ usage: { pollIntervalSec: 60 } }) }));
    bridge.setInvoke(invoke);
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    fireEvent.change(intervalInput(), { target: { value: '5' } });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.blur(intervalInput());
    await act(flush);
    expect(invoke).toHaveBeenCalledOnce();
    expect(intervalInput().value).toBe('60');
  });

  it('puts the saved value back when the field is left empty', () => {
    const invoke = vi.fn(async () => ({ ok: true, value: prefsSnapshot() }));
    bridge.setInvoke(invoke);
    usePrefs.setState({ snapshot: prefsSnapshot({ usage: { pollIntervalSec: 300 } }) });
    renderOpen();
    fireEvent.change(intervalInput(), { target: { value: '   ' } });
    fireEvent.blur(intervalInput());
    expect(invoke).not.toHaveBeenCalled();
    expect(intervalInput().value).toBe('300');
  });
});

describe('read-only preferences (C48; M101: V4, C4)', () => {
  /** The shown panel's fields: under read-only preferences none of them can change a thing. */
  const fields = (): (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] => [...panel().querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')];
  const off = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement) => control.disabled || control.closest('fieldset')?.disabled === true;

  it.each([
    // M12 (C62): the file is unchanged, then the cause and the remedy that keeps it.
    ['a newer file', { kind: 'read-only', reason: 'incompatible', fileVersion: 99, minReaderVersion: 99 }, /unchanged, and providers are paused\.A newer fat-g saved your preferences\. Update fat-g to use them again\./],
    ['an older development file', { kind: 'read-only', reason: 'incompatible', fileVersion: 2, minReaderVersion: 2 }, /unchanged, and providers are paused\.An earlier development version of fat-g saved them\. That version still reads them\./],
    ['an unreadable file', { kind: 'read-only', reason: 'unreadable' }, /unchanged, and providers are paused\.The file cannot be opened\. Another program may be holding it\. Try again\./],
    ['a corrupt file', { kind: 'read-only', reason: 'corrupt' }, /unchanged, and providers are paused\.The file is damaged\. If you edited it by hand, undo the edit\./],
  ] as const)('puts the note above the tabs on every tab, and disables every control of the shown one, Appearance included, for %s', (_name, status, note) => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, status) });
    useAppState.setState({ snapshot: sampleSnapshot(1, [sampleProvider({ id: 'codex', displayName: 'Codex', status: { kind: 'blocked', reason: 'preferences-unavailable' }, usage: null })]) });
    renderOpen();
    const counted: Record<string, number> = {};
    for (const element of tabs()) {
      fireEvent.click(element);
      const first = dialog().querySelector('[role="status"]');
      expect(first?.parentElement?.firstElementChild).toBe(first);
      expect(first?.textContent).toMatch(note);
      expect((first as Element).compareDocumentPosition(tabList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      for (const control of fields()) expect(off(control), `${element.textContent}: ${control.outerHTML}`).toBe(true);
      counted[element.textContent ?? ''] = fields().length;
    }
    // The tabs whose controls are preferences have them: General's seven, Appearance's radios and checkboxes, a provider's.
    // Avatars' stand in its popups, which disable them alike (AvatarsSection.test.tsx): its panel holds buttons alone.
    expect(counted).toMatchObject({ General: 7, Avatars: 0 });
    expect(counted['Appearance']).toBeGreaterThan(0);
    expect(counted['Accounts']).toBeGreaterThan(0);
    // And the tabs themselves still move.
    expect(shown()).toEqual(['About']);
    fireEvent.click(tab('Accounts'));
    expect(within(panel()).getByLabelText<HTMLInputElement>(/CLI executable/).disabled).toBe(true);
    for (const name of ['Save path', 'Browse…', 'Redetect / reconnect']) expect(within(panel()).getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
  });

  it('puts the loading line above the tabs while the preferences are on their way (C4)', () => {
    renderOpen({ section: 'storage' });
    const loading = within(dialog()).getByText('Loading your preferences…', { selector: '[role="status"]' });
    expect(loading.compareDocumentPosition(tabList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says nothing at all when everything is fine', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen();
    expect(screen.queryByText(/unchanged|Start fresh|Try again/)).toBeNull();
  });
});

// M12: Start fresh (C64, C66; V20) and Try again (C81; V25) for preferences.
describe('the refused preferences’ remedies', () => {
  const locked = { kind: 'read-only', reason: 'unreadable' } as const;
  const damaged = { kind: 'read-only', reason: 'corrupt' } as const;
  const confirmation = () => screen.getByRole('dialog', { name: 'Start fresh?' });

  it('offers Try again for a file that could not be opened only', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, damaged) });
    renderOpen();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    act(() => usePrefs.setState({ snapshot: prefsSnapshot({}, locked, 2) }));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('asks before Start fresh, with Cancel focused, repeating the cause and naming the default switches', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, damaged) });
    renderOpen();
    const opener = screen.getByRole('button', { name: 'Start fresh…' });
    opener.focus();
    fireEvent.click(opener);
    expect(within(confirmation()).getByText(/The file is damaged\. If you edited it by hand, undo the edit\./)).toBeTruthy();
    expect(within(confirmation()).getByText(/move preferences\.json, unchanged, to preferences\.set-aside\.<date and time>\.json.*Providers go back to their default switches, all on\./)).toBeTruthy();
    expect(document.activeElement).toBe(within(confirmation()).getByRole('button', { name: 'Cancel' }));
  });

  it('changes nothing on Cancel, and hands the focus back', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, damaged) });
    renderOpen();
    const opener = screen.getByRole('button', { name: 'Start fresh…' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    expect(bridge.calls.filter((call) => call.includes('startFresh'))).toEqual([]);
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
  });

  it('moves the file aside once confirmed, and shows where it went until Settings closes', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, damaged) });
    const requests: unknown[] = [];
    bridge.setInvoke(async (channel, request) => {
      requests.push([channel, request]);
      return { ok: true, value: { status: 'done', keptAs: 'C:\\data\\preferences.set-aside.2020-01-21T14-03-12Z.json' } };
    });
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh…' }));
    await act(async () => {
      fireEvent.click(within(confirmation()).getByRole('button', { name: 'Start fresh' }));
      await flush();
    });
    expect(requests).toEqual([['prefs:startFresh', null]]);
    act(() => usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'ok' }, 2) }));
    const kept = screen.getByText(/Your old preferences file was kept as/);
    expect(kept.textContent).toContain('preferences.set-aside.2020-01-21T14-03-12Z.json');
    // Above the tabs, on whichever is shown (M101, C4).
    fireEvent.click(tab('Diagnostics'));
    expect(kept.isConnected && (kept.compareDocumentPosition(tabList()) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    act(() => openSettings());
    expect(screen.queryByText(/was kept as/)).toBeNull();
  });

  it('says the file could not be moved, and keeps the note', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, damaged) });
    bridge.setInvoke(async () => ({ ok: false, error: 'internal' }));
    renderOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh…' }));
    await act(async () => {
      fireEvent.click(within(confirmation()).getByRole('button', { name: 'Start fresh' }));
      await flush();
    });
    const note = within(dialog()).getAllByRole('status')[0];
    expect(note?.textContent).toMatch(/The file is damaged\..*fat-g could not move the file\. Nothing was changed\./);
    // The confirmation closed; Settings stays open.
    expect(screen.queryByRole('dialog', { name: 'Start fresh?' })).toBeNull();
    expect(dialog().hasAttribute('open')).toBe(true);
  });

  it('reads the file again on Try again, and says so when it still cannot', async () => {
    usePrefs.setState({ snapshot: prefsSnapshot({}, locked) });
    const requests: unknown[] = [];
    bridge.setInvoke(async (channel, request) => {
      requests.push([channel, request]);
      return { ok: true, value: { status: 'refused', reason: 'still-refused' } };
    });
    renderOpen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await flush();
    });
    expect(requests).toEqual([['prefs:retry', null]]);
    expect(screen.getByText('fat-g tried again, and still cannot read it.')).toBeTruthy();
  });
});

describe('Accounts: the provider controls (Design 6, the Settings scene’s rows)', () => {
  const providerValues = (enabled: boolean, executablePath: string | null): Partial<Preferences> => ({ providers: { codex: { enabled, executablePath, permissionMode: null } } });

  beforeEach(() => {
    bridge = installBridge('win32');
    useAppState.setState({ snapshot: sampleSnapshot(1, [sampleProvider({ id: 'codex', displayName: 'Codex' })]) });
  });

  it.each([
    ['win32', 'where.exe example-agent', '%LOCALAPPDATA%\\Example\\bin'],
    ['darwin', 'command -v example-agent', '/Applications/Example.app/Contents/Resources'],
    ['linux', 'command -v example-agent', '~/.local/bin'],
  ])('offers provider-declared executable help on %s without changing read-only preferences', (platform, command, folder) => {
    bridge = installBridge(platform);
    const invoke = vi.fn();
    bridge.setInvoke(invoke);
    const provider = sampleProvider({ id: 'codex', displayName: 'Codex' });
    useAppState.setState({ snapshot: sampleSnapshot(1, [{ ...provider, descriptor: { ...provider.descriptor, executableHelp: {
      command: 'example-agent',
      locations: {
        win32: { folders: ['%LOCALAPPDATA%\\Example\\bin'] },
        darwin: { folders: ['/Applications/Example.app/Contents/Resources'] },
        linux: { folders: ['~/.local/bin'] },
      },
    } } }]) });
    usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, null), { kind: 'read-only', reason: 'incompatible' }) });
    renderOpen(ACCOUNTS);
    const summary = screen.getByText('How to find the CLI executable');
    const disclosure = summary.closest('details');
    expect(disclosure?.open).toBe(false);
    summary.focus();
    expect(document.activeElement).toBe(summary);
    fireEvent.click(summary);
    expect(disclosure?.open).toBe(true);
    expect(within(disclosure!).getByText(command)).toBeTruthy();
    expect(within(disclosure!).getByText(folder)).toBeTruthy();
    expect(disclosure?.textContent).toContain('without quotes');
    expect(disclosure?.textContent).toContain('clear that override');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows saved controls and re-synchronizes a draft after an external preference push', () => {
    usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, 'C:\\first\\codex.exe')) });
    renderOpen(ACCOUNTS);
    const pathInput = screen.getByLabelText<HTMLInputElement>(/CLI executable/);
    expect(pathInput.value).toBe('C:\\first\\codex.exe');
    fireEvent.change(pathInput, { target: { value: 'C:\\draft\\codex.exe' } });
    act(() => usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, 'C:\\external\\codex.exe'), { kind: 'ok' }, 2) }));
    expect(pathInput.value).toBe('C:\\external\\codex.exe');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Manual override' }).checked).toBe(true);
    act(() => usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, null), { kind: 'ok' }, 3) }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Automatic detection' }).checked).toBe(true);
    expect(pathInput.disabled).toBe(true);
  });

  it('patches enable and automatic-detection controls without changing the other field', async () => {
    const calls: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      calls.push(request);
      const clearsPath = JSON.stringify(request).includes('executablePath');
      return { ok: true, value: prefsSnapshot(providerValues(false, clearsPath ? null : 'C:\\tools\\codex.exe'), { kind: 'ok' }, calls.length + 1) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, 'C:\\tools\\codex.exe')) });
    renderOpen(ACCOUNTS);
    fireEvent.click(screen.getByLabelText(/Enabled/));
    await act(flush);
    expect(calls[0]).toEqual({ providers: { codex: { enabled: false } } });
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic detection' }));
    await act(flush);
    expect(calls[1]).toEqual({ providers: { codex: { executablePath: null } } });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Automatic detection' }).checked).toBe(true);
  });

  it.each(['refused', 'failed'] as const)('keeps the saved manual override selected when automatic detection is %s', async (outcome) => {
    usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, 'C:\\tools\\codex.exe')) });
    bridge.setInvoke(async () => outcome === 'failed' ? { ok: false, error: 'internal' } : {
      ok: true,
      value: { ...savedPrefs(providerValues(true, 'C:\\tools\\codex.exe')), refused: 'session-running' },
    });
    renderOpen(ACCOUNTS);
    fireEvent.click(screen.getByRole('radio', { name: 'Automatic detection' }));
    await act(flush);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Manual override' }).checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(/CLI executable/).value).toBe('C:\\tools\\codex.exe');
  });

  it('rejects a relative manual path in the renderer and submits an absolute path explicitly', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: savedPrefs(providerValues(true, 'C:\\tools\\codex.exe')) }));
    bridge.setInvoke(invoke);
    usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, null)) });
    renderOpen(ACCOUNTS);
    const pathInput = screen.getByLabelText<HTMLInputElement>(/CLI executable/);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Automatic detection' }).checked).toBe(true);
    expect(pathInput.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Manual override' }));
    expect(pathInput.disabled).toBe(false);
    fireEvent.change(pathInput, { target: { value: 'codex --dangerous' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save path' }));
    expect(screen.getByText('Enter a literal absolute path, or choose the executable with Browse.')).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.change(pathInput, { target: { value: 'C:\\tools\\codex.exe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save path' }));
    await act(flush);
    expect(invoke).toHaveBeenCalledWith('prefs:patch', { providers: { codex: { executablePath: 'C:\\tools\\codex.exe' } } });
  });

  it('uses the native picker and the redetect action, and surfaces provider preference issues', async () => {
    bridge.setInvoke(async (channel) => ({ ok: true, value: channel === 'providers:pickExecutable' ? { status: 'selected' } : { status: 'accepted' } }));
    usePrefs.setState({ snapshot: { ...prefsSnapshot(providerValues(true, null)), providerIssues: { codex: 'invalid-executable-path' } } });
    renderOpen(ACCOUNTS);
    expect(screen.getByText(/saved executable override is invalid/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Automatic detection' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(await screen.findByText('Executable saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Redetect / reconnect' }));
    expect(await screen.findByText('Detection restarted.')).toBeTruthy();
  });

  it.each([
    ['not-ready', 'Detection is not ready yet. Try again in a moment.'],
    ['preferences-blocked', 'Detection is unavailable until these preferences are repaired.'],
  ] as const)('names the preferences only when they blocked a redetect (%s)', async (reason, text) => {
    bridge.setInvoke(async () => ({ ok: true, value: { status: 'refused', reason } }));
    usePrefs.setState({ snapshot: prefsSnapshot(providerValues(true, null)) });
    renderOpen(ACCOUNTS);
    fireEvent.click(screen.getByRole('button', { name: 'Redetect / reconnect' }));
    expect(await screen.findByText(text)).toBeTruthy();
  });
});

describe('Accounts: every state and action of the Usage scene (Design 6)', () => {
  const show = (provider: ProviderSnapshot): HTMLElement => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    useAppState.setState({ snapshot: sampleSnapshot(1, [provider]) });
    renderOpen(ACCOUNTS);
    const section = screen.getByRole('heading', { name: provider.displayName }).closest('section');
    if (section === null) throw new Error('no provider section');
    return section;
  };
  const buttons = (section: HTMLElement): string[] => within(section).getAllByRole('button').map((button) => button.textContent);
  const CONTROLS = ['Save path', 'Browse…', 'Redetect / reconnect'];

  it('draws each provider’s mark from its catalog entry, in its colour (M13, C21, V5)', () => {
    const section = show(sampleProvider());
    const path = section.querySelector('h4 svg path');
    expect(path?.getAttribute('d')).toBe(useAppState.getState().snapshot?.catalog?.providers[0]?.presentation.icon.path);
    expect(path?.getAttribute('fill')).toBe('#ff9933');
  });

  it('draws the rectangular provider logo and visible name when available', () => {
    const provider = sampleProvider();
    usePrefs.setState({ snapshot: prefsSnapshot() });
    const state = sampleSnapshot(1, [provider]);
    if (state.catalog === undefined) throw new Error('no catalog');
    const logo = 'data:image/png;base64,aW1hZ2U=';
    const catalog = { ...state.catalog, providers: state.catalog.providers.map((item) => ({ ...item, presentation: { ...item.presentation, logo } })) };
    useAppState.setState({ snapshot: { ...state, catalog } });
    renderOpen(ACCOUNTS);
    const heading = screen.getByRole('heading', { name: provider.displayName });
    expect(heading.querySelector('img')?.getAttribute('src')).toBe(logo);
    expect(heading.querySelector('svg')).toBeNull();
    expect(heading.textContent).toBe(provider.displayName);
  });

  it('names the plan, the account in full and the CLI version in the status line, whatever the mask preference (M14b, C79)', () => {
    const section = show(sampleProvider());
    // The preference is on by default: it masks the email in the usage panel, never here.
    expect(usePrefs.getState().snapshot?.values.privacy.maskEmail).toBe(true);
    expect(within(section).getByRole('heading', { name: 'Account: user@example.com' })).toBeTruthy();
    expect(within(section).getByText('user@example.com · Up to date · max · CLI 1.0.0')).toBeTruthy();
    expect(within(section).getByText('Found CLI 1.0.0 via PATH')).toBeTruthy();
  });

  it.each([
    [{ kind: 'disabled' }, 'Disabled', 'Disabled in Settings.', [...CONTROLS]],
    [{ kind: 'blocked', reason: 'invalid-preferences' }, 'Preferences need repair', 'saved controls need repair', [...CONTROLS]],
    // The sample provider's CLI is found (installation 1.0.0): its first read is what is left (M13, C89).
    [{ kind: 'detecting' }, 'Checking usage', 'Found CLI 1.0.0. Its first check is starting.', [...CONTROLS]],
    [{ kind: 'not-installed', overrideInvalid: false }, 'CLI not found', 'Install the CLI.', ['Refresh', 'Installation guide', ...CONTROLS]],
    [{ kind: 'not-installed', overrideInvalid: true }, 'Selected CLI unavailable', 'could not be used', ['Refresh', 'Installation guide', ...CONTROLS]],
    [{ kind: 'not-logged-in' }, 'Sign-in needed', 'Sign-in is the CLI', ['Refresh', 'Sign in with the CLI', 'Signed in, reconnect', 'Copy', ...CONTROLS]],
    [{ kind: 'not-applicable', reason: 'unsupported-cli-version' }, 'Usage not applicable', 'does not expose compatible account usage data', ['Refresh', ...CONTROLS]],
    [{ kind: 'ok' }, 'Usage unavailable', 'Usage data is not available yet.', ['Refresh', ...CONTROLS]],
    [{ kind: 'stale' }, 'Usage stale', 'These readings are historical', ['Refresh', ...CONTROLS]],
    [{ kind: 'waking' }, 'Updating after machine sleep', 'These readings are from before it slept', ['Refresh', ...CONTROLS]],
    [{ kind: 'error', message: 'Usage is temporarily unavailable.' }, 'Usage error', 'Usage is temporarily unavailable.', ['Refresh', 'Reconnect CLI', ...CONTROLS]],
  ] as readonly (readonly [ProviderStatus, string, string, readonly string[]])[])('$kind: status, guidance and its actions', (status, label, guidance, actions) => {
    const held = status.kind === 'stale' || status.kind === 'waking';
    const section = show(sampleProvider({ status, usage: held ? { windows: [sampleWindow()] } : null }));
    expect(within(section).getByText(new RegExp(`(?:^| · )${label}( ·|$)`))).toBeTruthy();
    expect(section.textContent).toContain(guidance);
    expect(buttons(section).filter((text) => text !== '…').sort()).toEqual([...actions, 'Rename'].sort());
  });

  it('says it is detecting until the CLI is found, then that its first check is under way (M13, C89, V44)', () => {
    const due = new Date(2020, 0, 22, 14, 5, 12).getTime();
    const detecting = show(sampleProvider({ status: { kind: 'detecting' }, installation: null, usage: null }));
    expect(within(detecting).getByText(/Detecting CLI/)).toBeTruthy();
    expect(detecting.textContent).toContain('Checking the installed CLI…');
    cleanup();
    const waiting = show(sampleProvider({ status: { kind: 'detecting' }, installation: { source: 'path', version: '0.155.1' }, usage: null, nextRefreshAt: due }));
    expect(within(waiting).getByText(/Checking usage · /)).toBeTruthy();
    expect(waiting.textContent).toContain(`Found CLI 0.155.1. Its first check is due at ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(due)}.`);
    cleanup();
    const reading = show(sampleProvider({ status: { kind: 'detecting' }, installation: { source: 'path', version: null }, usage: null, refreshing: true }));
    expect(reading.textContent).toContain('Found the CLI. Reading its account and usage…');
  });

  it('shows the login command, copies it, and reports a failure to copy without the exception', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const section = show(sampleProvider({ status: { kind: 'not-logged-in' }, usage: null }));
    expect(within(section).getByText('claude auth login').tagName).toBe('CODE');
    fireEvent.click(within(section).getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Command copied.')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('claude auth login');

    writeText.mockRejectedValueOnce(new Error('private'));
    fireEvent.click(within(section).getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('The command could not be copied.')).toBeTruthy();
    expect(section.textContent).not.toContain('private');
  });

  it('leaves no standing message after a Refresh, says so when one is refused, and reports a reconnect (M13, C98)', async () => {
    let answer: ProviderActionResult = { status: 'accepted' };
    const calls: string[] = [];
    bridge.setInvoke(async (channel) => {
      calls.push(channel);
      return { ok: true, value: channel === 'providers:refresh' ? answer : { status: 'accepted' } };
    });
    const section = show(sampleProvider({ status: { kind: 'not-logged-in' }, usage: null }));
    fireEvent.click(within(section).getByRole('button', { name: 'Refresh' }));
    await vi.waitFor(() => expect(calls).toEqual(['providers:refresh']));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(within(section).queryByRole('status')).toBeNull();
    answer = { status: 'refused', reason: 'not-ready' };
    fireEvent.click(within(section).getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('That action is unavailable right now.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Signed in, reconnect' }));
    expect(await screen.findByText('CLI reconnection accepted.')).toBeTruthy();
  });

  it('shows the read a Refresh started on its button, not in a message', () => {
    const section = show(sampleProvider({ refreshing: true }));
    const button = within(section).getByRole('button', { name: 'Refreshing…' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(within(section).queryByRole('status')).toBeNull();
  });

  it('reconnects after an error', async () => {
    const calls: string[] = [];
    bridge.setInvoke(async (channel) => {
      calls.push(channel);
      return { ok: true, value: { status: 'accepted' } };
    });
    const section = show(sampleProvider({ status: { kind: 'error', message: 'The CLI could not be started.' }, usage: null }));
    fireEvent.click(within(section).getByRole('button', { name: 'Reconnect CLI' }));
    expect(await screen.findByText('CLI reconnection accepted.')).toBeTruthy();
    expect(calls).toEqual(['providers:redetect']);
  });

  it('opens the installation guide by its provider’s id, and reports a failure without the exception', async () => {
    const requests: unknown[] = [];
    bridge.setInvoke(async (channel, request) => {
      requests.push([channel, request]);
      throw new Error('private');
    });
    const section = show(sampleProvider({ status: { kind: 'not-installed', overrideInvalid: false }, usage: null }));
    fireEvent.click(within(section).getByRole('button', { name: 'Installation guide' }));
    expect(await screen.findByText('The installation guide could not be opened.')).toBeTruthy();
    // The page names the provider; main opens the address its module gives (M13, C25).
    expect(requests).toEqual([['shell:openLink', { providerId: 'claude' }]]);
  });

  it('shows a refresh in flight', () => {
    const section = show(sampleProvider({ refreshing: true }));
    expect(within(section).getByRole('button', { name: 'Refreshing…' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps a disabled provider listed, with its Enabled toggle off (C40)', () => {
    usePrefs.setState({ snapshot: prefsSnapshot({ providers: { claude: { enabled: false, executablePath: null, permissionMode: null } } }) });
    useAppState.setState({ snapshot: sampleSnapshot(1, [sampleProvider({ status: { kind: 'disabled' }, usage: null })]) });
    renderOpen(ACCOUNTS);
    expect(screen.getByLabelText<HTMLInputElement>(/Enabled/).checked).toBe(false);
  });
});

describe('Diagnostics', () => {
  it('clears the recent model list through preferences, keeping saved presets', async () => {
    const recent = { providerId: 'codex', instanceId: 'default', model: 'sample', effort: 'high', speed: null };
    const before = prefsSnapshot({ recentModels: [recent] });
    const after = { ...before, rev: before.rev + 1, values: { ...before.values, recentModels: [] } };
    usePrefs.setState({ snapshot: before });
    const invoke = vi.fn(async () => ({ ok: true as const, value: after }));
    bridge.setInvoke(invoke);
    renderOpen({ section: 'diagnostics' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent model list' }));
    await act(flush);
    expect(invoke).toHaveBeenCalledWith('prefs:patch', { clearRecentModels: true });
    expect(usePrefs.getState().snapshot?.values.recentModels).toEqual([]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear recent model list' }).disabled).toBe(true);
    expect(screen.getByText('Clear the recent model list. Saved presets are kept.')).toBeTruthy();
  });

  it('shows the platform from the preload bridge and the page origin', () => {
    renderOpen({ section: 'diagnostics' });
    expect(screen.getByText('test-os')).toBeTruthy();
    expect(screen.getByText(window.location.origin)).toBeTruthy();
  });

  it('reports zero CSP violations on a healthy page, and surfaces one when it happens', () => {
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen({ section: 'diagnostics' });
    const count = () => screen.getAllByRole('status').at(-1)?.textContent;
    expect(count()).toBe('0');
    act(() => {
      document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), { effectiveDirective: 'img-src', blockedURI: 'https://tracker.example/pixel.png' }));
    });
    expect(count()).toBe('1');
    expect(screen.getByText('https://tracker.example/pixel.png')).toBeTruthy();
  });
});

// ── M14b: a provider's accounts (docs/planning/_archive/M14b.md, V10; C32, C33, C38) ────────────────────
describe('Accounts: several accounts of a provider (M14b; C32, C33, C38)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const PICKED = 'D:\\accounts\\codex work';
  /** A provider whose module can run several accounts. */
  const codex = (overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot => sampleProvider({ id: 'codex', displayName: 'Codex', instanceVariable: 'CODEX_HOME', ...overrides });
  const withInstances = (added: PreferencesSnapshot['instances'][string]['added'] = [], firstLabel: string | null = null): PreferencesSnapshot => ({ ...prefsSnapshot(), instances: { codex: { firstLabel, added } } });
  const work = { key: WORK, id: WORK, label: 'Work', folder: PICKED, enabled: true, issue: null };
  let requests: [string, unknown][];
  let answers: Record<string, unknown>;

  beforeEach(() => {
    bridge = installBridge('win32');
    requests = [];
    answers = {};
    bridge.setInvoke(async (channel, request) => {
      requests.push([channel, request]);
      return { ok: true, value: answers[channel] ?? { status: 'accepted' } };
    });
  });

  const show = (providers: readonly ProviderSnapshot[], prefs: PreferencesSnapshot = withInstances(), target: SettingsTarget = ACCOUNTS) => {
    usePrefs.setState({ snapshot: prefs });
    useAppState.setState({ snapshot: sampleSnapshot(1, providers) });
    renderOpen(target);
    return screen.getByRole('heading', { level: 4, name: 'Codex' }).closest('section') as HTMLElement;
  };
  const addRow = () => screen.getByRole('group', { name: 'Add a Codex account' });
  const openAdd = (section: HTMLElement) => fireEvent.click(within(section).getByRole('button', { name: 'Add Codex account' }));

  describe('with one account (C32)', () => {
    it('gives even one account its own titled box below Add account', () => {
      const section = show([codex()]);
      expect(within(section).getByRole('heading', { level: 5, name: 'Account: user@example.com' })).toBeTruthy();
      expect(section.querySelectorAll('[data-instance]')).toHaveLength(1);
      expect(within(section).getByRole('button', { name: /^Rename account/ })).toBeTruthy();
      expect(within(section).getAllByRole('button').map((button) => button.textContent)).toEqual(['Redetect / reconnect', 'Save path', 'Browse…', 'Add Codex account', 'Rename', 'Refresh']);
      expect(within(section).getAllByLabelText('Enabled')).toHaveLength(1);
    });

    it('offers no Add account for a module that declares no variable', () => {
      const section = show([sampleProvider({ id: 'codex', displayName: 'Codex' })]);
      expect(within(section).queryByRole('button', { name: 'Add Codex account' })).toBeNull();
      expect(within(section).getAllByRole('button').map((button) => button.textContent)).toEqual(['Redetect / reconnect', 'Save path', 'Browse…', 'Rename', 'Refresh']);
    });

    it('offers none when the saved accounts are not a list, and says why', () => {
      const section = show([codex()], { ...withInstances(), providerIssues: { codex: 'invalid-instances' } });
      expect(within(section).queryByRole('button', { name: 'Add Codex account' })).toBeNull();
      expect(section.textContent).toContain('saved accounts are not a list');
    });

    it('still sends Refresh, the reconnect and Redetect for the first account', async () => {
      const section = show([codex({ status: { kind: 'not-logged-in' }, account: null, usage: null })]);
      // The first account's login command is the CLI's own.
      expect(within(section).getByText('claude auth login', { selector: 'code' })).toBeTruthy();
      fireEvent.click(within(section).getByRole('button', { name: 'Signed in, reconnect' }));
      fireEvent.click(within(section).getByRole('button', { name: 'Redetect / reconnect' }));
      await act(flush);
      expect(requests).toEqual([
        ['providers:redetect', { providerId: 'codex', instanceId: 'default' }],
        ['providers:redetect', { providerId: 'codex', instanceId: 'default' }],
      ]);
    });
  });

  describe('the add row (C33)', () => {
    it('opens with a name field, Choose folder, Save and Cancel, and sends nothing', () => {
      openAdd(show([codex()]));
      expect(within(addRow()).getByLabelText('Name')).toBeTruthy();
      expect(within(addRow()).getAllByRole('button').map((button) => button.textContent)).toEqual(['Choose folder…', 'Save', 'Cancel']);
      expect(addRow().querySelector('[data-picked-folder]')).toBeNull();
      expect(requests).toEqual([]);
    });

    it('shows the picked path, and stores and starts nothing before Save', async () => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal: null };
      openAdd(show([codex()]));
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      expect(addRow().querySelector('[data-picked-folder]')?.textContent).toBe(PICKED);
      expect(requests).toEqual([['instances:pickFolder', { providerId: 'codex' }]]);
    });

    it('saves the name and the picked folder in one request, and closes', async () => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal: null };
      answers['instances:add'] = { status: 'saved', id: WORK };
      const section = show([codex()]);
      openAdd(section);
      fireEvent.change(within(addRow()).getByLabelText('Name'), { target: { value: 'Work' } });
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Save' }));
      await act(flush);
      expect(requests.at(-1)).toEqual(['instances:add', { providerId: 'codex', label: 'Work', folder: PICKED }]);
      expect(screen.queryByRole('group', { name: 'Add a Codex account' })).toBeNull();
      expect(within(section).getByRole('button', { name: 'Add Codex account' })).toBeTruthy();
    });

    it('drops the pick on Cancel: nothing is sent, and the row opens empty again', async () => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal: null };
      const section = show([codex()]);
      openAdd(section);
      fireEvent.change(within(addRow()).getByLabelText('Name'), { target: { value: 'Work' } });
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Cancel' }));
      expect(requests.map(([channel]) => channel)).toEqual(['instances:pickFolder']);
      openAdd(section);
      expect(within(addRow()).getByLabelText<HTMLInputElement>('Name').value).toBe('');
      expect(addRow().querySelector('[data-picked-folder]')).toBeNull();
    });

    it('drops the pick when Settings closes', async () => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal: null };
      openAdd(show([codex()]));
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      act(() => closeSettings());
      act(() => openSettings());
      expect(screen.queryByRole('group', { name: 'Add a Codex account' })).toBeNull();
      expect(requests.map(([channel]) => channel)).toEqual(['instances:pickFolder']);
    });

    it.each([
      ['no name', '', 'Enter a name for this account.'],
      ['a name that is empty once cleaned', ' \t ', 'Enter a name for this account.'],
      ['the first account’s shown name, in another letter case', 'default', 'Another account of this provider has that name.'],
      ['an added account’s name', 'WORK', 'Another account of this provider has that name.'],
    ])('says %s beside the name, and sends no add', async (_name, value, said) => {
      answers['instances:pickFolder'] = { status: 'picked', path: 'D:\\accounts\\other', refusal: null };
      openAdd(show([codex(), codex({ instanceId: WORK, label: 'Work' })], withInstances([work])));
      fireEvent.change(within(addRow()).getByLabelText('Name'), { target: { value } });
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Save' }));
      await act(flush);
      expect(within(addRow()).getByRole('alert').textContent).toBe(said);
      expect(within(addRow()).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
      expect(requests.map(([channel]) => channel)).toEqual(['instances:pickFolder']);
    });

    it('asks for a folder when none was chosen', async () => {
      openAdd(show([codex()]));
      fireEvent.change(within(addRow()).getByLabelText('Name'), { target: { value: 'Work' } });
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Save' }));
      await act(flush);
      expect(within(addRow()).getByRole('alert').textContent).toBe('Choose a folder for this account.');
      expect(requests).toEqual([]);
    });

    it.each([
      ['another account’s folder, by its label', { rule: 'other-instance', key: WORK }, 'This folder is the account “Work”’s.'],
      ['the CLI’s default folder', { rule: 'default-folder' }, 'This folder is the CLI’s own default folder, which is the first account’s.'],
      ['the folder the environment names', { rule: 'inherited-folder' }, 'This folder is the one fat-g’s environment names, which is the first account’s.'],
      ['a folder inside a project', { rule: 'project', projectId: 'p1', relation: 'inside' }, 'This folder is inside a project’s folder. An account’s login must not sit among the files an agent reads.'],
      ['a folder around fat-g’s data folder', { rule: 'data-folder', relation: 'around' }, 'This folder is around fat-g’s data folder.'],
    ] as const)('says at once that the picked folder is refused: %s; and Save sends nothing', async (_name, refusal, said) => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal };
      openAdd(show([codex(), codex({ instanceId: WORK, label: 'Work' })], withInstances([work])));
      fireEvent.change(within(addRow()).getByLabelText('Name'), { target: { value: 'Client' } });
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      // The path shows, with why it cannot be used.
      expect(addRow().querySelector('[data-picked-folder]')?.textContent).toBe(PICKED);
      expect(within(addRow()).getByRole('alert').textContent).toBe(said);
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Save' }));
      await act(flush);
      expect(requests.map(([channel]) => channel)).toEqual(['instances:pickFolder']);
    });

    it.each([
      [{ status: 'refused', reason: 'label-taken' }, 'Another account of this provider has that name.'],
      [{ status: 'refused', reason: 'label-empty' }, 'Enter a name for this account.'],
      [{ status: 'refused', reason: 'folder-not-picked' }, 'Choose the folder again: fat-g takes only a folder its own picker returned.'],
      [{ status: 'refused', reason: 'folder-refused', refusal: { rule: 'default-folder' } }, 'This folder is the CLI’s own default folder, which is the first account’s.'],
      [{ status: 'refused', reason: 'limit' }, 'A provider can have 8 accounts.'],
      [{ status: 'refused', reason: 'preferences-blocked' }, 'Your preferences cannot be saved right now, so the account was not added.'],
    ])('says what main refuses on Save, and keeps the row: %j', async (answer, said) => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal: null };
      answers['instances:add'] = answer;
      openAdd(show([codex()]));
      fireEvent.change(within(addRow()).getByLabelText('Name'), { target: { value: 'Work' } });
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Save' }));
      await act(flush);
      expect(within(addRow()).getByRole('alert').textContent).toBe(said);
      expect(within(addRow()).getByLabelText<HTMLInputElement>('Name').value).toBe('Work');
    });

    it.each([
      [{ status: 'cancelled' }, null],
      [{ status: 'refused', reason: 'busy' }, 'A folder picker is already open.'],
      [{ status: 'refused', reason: 'unsupported-path' }, 'That folder’s path cannot be used. Choose a folder on a local drive.'],
    ])('keeps what was picked before when the picker answers %j', async (answer, said) => {
      answers['instances:pickFolder'] = { status: 'picked', path: PICKED, refusal: null };
      openAdd(show([codex()]));
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      answers['instances:pickFolder'] = answer;
      fireEvent.click(within(addRow()).getByRole('button', { name: 'Choose folder…' }));
      await act(flush);
      expect(addRow().querySelector('[data-picked-folder]')?.textContent).toBe(PICKED);
      expect(within(addRow()).queryByRole('alert')?.textContent ?? null).toBe(said);
    });

    it('is not offered at the cap: eight accounts, the first included', () => {
      const ids = Array.from({ length: 7 }, (_, index) => `0000000${index}-2222-4333-8444-555555555555`);
      const section = show(
        [codex(), ...ids.map((instanceId, index) => codex({ instanceId, label: `Account ${index}` }))],
        withInstances(ids.map((id, index) => ({ ...work, key: id, id, label: `Account ${index}` }))),
      );
      expect(within(section).getByRole<HTMLButtonElement>('button', { name: 'Add Codex account' }).disabled).toBe(true);
      expect(section.textContent).toContain('A provider can have 8 accounts.');
    });

    it('explains the account data folder and that fat-g never reads its contents', () => {
      openAdd(show([codex()]));
      expect(addRow().textContent).toContain('Account data folder');
      expect(addRow().textContent).toContain('sign-in information, settings and chat history');
      expect(addRow().textContent).toContain('fat-g remembers the folder’s location but never reads its contents.');
    });
  });

  describe('opening at an account (C38)', () => {
    it('lands on the account’s row when its provider lists more than one', () => {
      const scrolled = vi.fn();
      Element.prototype.scrollIntoView = scrolled;
      show([codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })], withInstances([work], 'Personal'), { provider: 'codex', instanceId: WORK });
      const heading = document.querySelector('[data-instance="' + WORK + '"] h5');
      expect(document.activeElement).toBe(heading);
      expect(scrolled.mock.contexts).toContain(heading);
    });

    it('lands on the first account’s row too', () => {
      show([codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })], withInstances([work], 'Personal'), { provider: 'codex', instanceId: 'default' });
      expect(document.activeElement).toBe(document.querySelector('[data-instance="default"] h5'));
    });

    it('lands on the provider’s heading when it has one account, which has no row', () => {
      show([codex()], withInstances(), { provider: 'codex', instanceId: 'default' });
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 5, name: 'Account: user@example.com' }));
    });
  });
});

// M26 (decision 0028): which model writes a provider's titles.
describe('Accounts: the title model (M26)', () => {
  const titled = (overrides: Parameters<typeof sampleProvider>[0] = {}) => {
    const provider = sampleProvider({ id: 'codex', displayName: 'Codex', ...overrides });
    return { ...provider, descriptor: { ...provider.descriptor, capabilities: { ...provider.descriptor.capabilities, titles: true } } };
  };
  const picker = () => screen.getByLabelText<HTMLSelectElement>(/Chat titles written by/);
  const options = () => [...picker().options].map((option) => [option.value, option.textContent]);
  const withModels = (snapshot: AppStateSnapshot): AppStateSnapshot => {
    const { catalog } = snapshot;
    if (catalog === undefined) return snapshot;
    const models = [sampleModel({ key: 'big', name: 'Big' }), sampleModel({ key: 'small', name: 'Small' }), sampleModel({ key: 'gone', name: 'Gone', hidden: true })];
    return { ...snapshot, catalog: { ...catalog, providers: catalog.providers.map((entry) => ({ ...entry, models })) } };
  };

  it('offers the session’s model and the models the provider lists, hidden ones left out, and saves a choice for that provider alone', async () => {
    const calls: [InvokeChannel, unknown][] = [];
    bridge.setInvoke(async (channel, request) => {
      calls.push([channel, request]);
      return { ok: true, value: savedPrefs({ titles: { generated: true, models: { codex: 'small' } } }) };
    });
    useAppState.setState({ snapshot: withModels(sampleSnapshot(1, [titled()])) });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen(ACCOUNTS);
    expect(screen.getByRole('heading', { name: 'Codex' }).closest('section')?.contains(picker())).toBe(true);
    expect(options()).toEqual([['', 'Latest small model'], ['$session', 'Use the chat’s own model'], ['big', 'Big'], ['small', 'Small']]);
    expect(picker().value).toBe('');
    expect(screen.getByText(/Uses each account’s newest available small model/).id).toBe(picker().getAttribute('aria-describedby'));
    fireEvent.change(picker(), { target: { value: 'small' } });
    await act(flush);
    expect(calls).toEqual([['prefs:patch', { titles: { models: { codex: 'small' } } }]]);
    expect(picker().value).toBe('small');
    expect(screen.queryByText(/Uses each account’s newest available small model/)).toBeNull();
    expect(picker().hasAttribute('aria-describedby')).toBe(false);
  });

  it('clears a choice back to Latest small model, keeps one no account lists as saved, and is disabled while titles are off', async () => {
    const calls: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      calls.push(request);
      return { ok: true, value: savedPrefs({ titles: { generated: true, models: {} } }) };
    });
    useAppState.setState({ snapshot: withModels(sampleSnapshot(1, [titled()])) });
    usePrefs.setState({ snapshot: prefsSnapshot({ titles: { generated: true, models: { codex: 'retired' } } }) });
    renderOpen(ACCOUNTS);
    expect(options().at(-1)).toEqual(['retired', 'retired (not listed now)']);
    expect(screen.queryByText(/Uses each account’s newest available small model/)).toBeNull();
    fireEvent.change(picker(), { target: { value: '' } });
    await act(flush);
    expect(calls).toEqual([{ titles: { models: { codex: null } } }]);
    expect(screen.getByText(/Uses each account’s newest available small model/)).toBeTruthy();
    cleanup();
    usePrefs.setState({ snapshot: prefsSnapshot({ titles: { generated: false, models: {} } }) });
    renderOpen(ACCOUNTS);
    expect(picker().disabled).toBe(true);
  });

  it('saves the explicit session-model option separately from automatic small-model selection', async () => {
    const calls: unknown[] = [];
    bridge.setInvoke(async (_channel, request) => {
      calls.push(request);
      return { ok: true, value: savedPrefs({ titles: { generated: true, models: { codex: '$session' } } }) };
    });
    useAppState.setState({ snapshot: withModels(sampleSnapshot(1, [titled()])) });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen(ACCOUNTS);
    expect(picker().value).toBe('');
    fireEvent.change(picker(), { target: { value: '$session' } });
    await act(flush);
    expect(calls).toEqual([{ titles: { models: { codex: '$session' } } }]);
    expect(picker().value).toBe('$session');
    expect(screen.queryByText(/Uses each account’s newest available small model/)).toBeNull();
    expect(picker().hasAttribute('aria-describedby')).toBe(false);
    expect(options().some(([, label]) => label?.includes('not listed now'))).toBe(false);
  });

  it('draws none for a provider that has no secretary', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, [sampleProvider({ id: 'codex', displayName: 'Codex' })]) });
    usePrefs.setState({ snapshot: prefsSnapshot() });
    renderOpen(ACCOUNTS);
    expect(screen.queryByLabelText(/Chat titles written by/)).toBeNull();
  });
});

// M22, V15, V25 (docs/planning/_archive/M22.md, Design 10; C40, C43, C87): a provider's default mode.
describe('Accounts: the default mode (M22: V15, V25; C40, C87)', () => {
  const values = (permissionMode: string | null): Partial<Preferences> => ({ providers: { codex: { enabled: true, executablePath: null, permissionMode } } });
  const choice = () => screen.getByRole('group', { name: 'Default security mode' });
  const radios = () => within(choice()).getAllByRole<HTMLInputElement>('radio');
  const checked = () => radios().filter((each) => each.checked).map((each) => each.value);

  beforeEach(() => {
    useAppState.setState({ snapshot: sampleSnapshot(1, [modedProvider({ id: 'codex', displayName: 'Codex' })]) });
  });

  it('draws the provider’s own list in its part, with each description and the one line under it, the fallback marked while none is saved', () => {
    usePrefs.setState({ snapshot: prefsSnapshot(values(null)) });
    renderOpen(ACCOUNTS);
    expect(screen.getByRole('heading', { name: 'Codex' }).closest('section')?.contains(choice())).toBe(true);
    expect(radios().map((each) => (each.closest('label') as HTMLElement).textContent?.trim())).toEqual(MODES.modes.map((mode) => mode.label));
    expect(choice().querySelector('[data-mode-inherited]')).toBeNull();
    expect(choice().title).toBe(MODES.inherited);
    expect(radios().map((radio) => radio.closest('label')?.title)).toEqual(MODES.modes.map((mode) => mode.description));
    expect(checked()).toEqual([MODES.fallback]);
    // Nothing of an account: a default is a provider's word (C43).
    expect(choice().textContent).not.toMatch(/sandbox is|Set up|not been shown/);
  });

  it('saves a choice at once by the preferences’ own patch, for that provider alone, and shows what was saved (C40)', async () => {
    const calls: [InvokeChannel, unknown][] = [];
    bridge.setInvoke(async (channel, request) => {
      calls.push([channel, request]);
      return { ok: true, value: savedPrefs(values('edits-ok')) };
    });
    usePrefs.setState({ snapshot: prefsSnapshot(values(null)) });
    renderOpen(ACCOUNTS);
    fireEvent.click(radios()[2] as HTMLElement);
    await act(flush);
    // An id, and nothing of a chat, a session or a grant: no session is asked to change.
    expect(calls).toEqual([['prefs:patch', { providers: { codex: { permissionMode: 'edits-ok' } } }]]);
    expect(checked()).toEqual(['edits-ok']);
  });

  it('shows the saved default, and is disabled while the preferences are read-only', () => {
    usePrefs.setState({ snapshot: prefsSnapshot(values('berserk'), { kind: 'read-only', reason: 'corrupt' }) });
    renderOpen(ACCOUNTS);
    expect(checked()).toEqual(['berserk']);
    expect((choice() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('draws none for a provider that declares no mode', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1, [sampleProvider({ id: 'codex', displayName: 'Codex' })]) });
    usePrefs.setState({ snapshot: prefsSnapshot(values(null)) });
    renderOpen(ACCOUNTS);
    expect(screen.queryByRole('group', { name: 'Default security mode' })).toBeNull();
  });
});
