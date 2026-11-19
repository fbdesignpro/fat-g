// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// A provider's accounts in Settings (docs/planning/_archive/M14b.md, V10 and V23; C11, C34–C37, C64, C66, C71):
// the rows of a provider that has more than one, on two Codex accounts.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InstanceEntry } from '@shared/contracts/instances';
import type { PreferencesSnapshot } from '@shared/contracts/prefs';
import type { ProviderSnapshot, ProviderStatus } from '@shared/contracts/status';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleAccount, sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { sessionEntry, sessionsState, SUMMARIES, withSessions } from '../../../../tests/support/sessions';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { OFF_PATH } from './LoginHelp';
import { ProvidersSection } from './ProvidersSection';

const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const FOLDER = 'D:\\accounts\\codex work';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answers: Partial<Record<InvokeChannel, unknown>>;

beforeAll(installDialogStandIn);
beforeEach(() => {
  usePrefs.setState({ snapshot: null, error: null, saving: false });
  useAppState.setState({ snapshot: null, error: null });
  install('win32');
});
afterEach(cleanup);

function install(platform: string): void {
  bridge = installFakeBridge(platform);
  requests = [];
  answers = {};
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: answers[channel] ?? (channel === 'prefs:patch' ? prefs(undefined, 2) : { status: 'accepted' }) };
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const entry = (overrides: Partial<InstanceEntry> = {}): InstanceEntry => ({ key: WORK, id: WORK, label: 'Work', folder: FOLDER, enabled: true, issue: null, ...overrides });
const prefs = (added: readonly InstanceEntry[] = [entry()], rev = 1, firstLabel: string | null = 'Personal'): PreferencesSnapshot => ({
  ...prefsSnapshot({}, { kind: 'ok' }, rev),
  instances: { codex: { firstLabel, added } },
});
const codex = (overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot =>
  sampleProvider({ id: 'codex', displayName: 'Codex', label: 'Personal', instanceVariable: 'CODEX_HOME', descriptor: { ...sampleProvider().descriptor, id: 'codex', displayName: 'Codex', loginCommand: 'codex login' }, ...overrides });
const work = (status: ProviderStatus = { kind: 'ok' }, overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot =>
  codex({ instanceId: WORK, label: 'Work', status, account: sampleAccount({ email: 'work@example.test', plan: 'team' }), ...overrides });

/** Shows the Providers section with these Codex instances. */
function show(instances: readonly ProviderSnapshot[] = [codex(), work()], given: PreferencesSnapshot = prefs(), state: (snapshot: ReturnType<typeof sampleSnapshot>) => ReturnType<typeof sampleSnapshot> = (snapshot) => snapshot) {
  usePrefs.setState({ snapshot: given });
  const snapshot = sampleSnapshot(1, instances);
  useAppState.setState({ snapshot: state(snapshot) });
  return render(<ProvidersSection />);
}
const row = (label: string): HTMLElement => {
  const provider = useAppState.getState().snapshot?.providers.find((candidate) => (candidate.label || 'Unnamed account') === label);
  const element = [...document.querySelectorAll<HTMLElement>('[data-instance]')].find((candidate) => candidate.dataset['instance'] === provider?.instanceId);
  if (!(element instanceof HTMLElement)) throw new Error(`no row for ${label}`);
  return element;
};
const openMenu = (label: string): HTMLElement => {
  fireEvent.click(within(row(label)).getByRole('button', { name: `Actions for the account ${label}` }));
  return within(row(label)).getByRole('menu');
};
const items = (menu: HTMLElement): string[] => within(menu).getAllByRole('menuitem').map((item) => item.textContent);

describe('the rows (V10; C34)', () => {
  it('lists one row an account, in order, each with its label and its status line', () => {
    show();
    expect(screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent)).toEqual(['Account: Personal', 'Account: Work']);
    expect(row('Personal').textContent).toContain('user@example.com · Up to date · max · CLI 1.0.0');
    expect(row('Work').textContent).toContain('work@example.test · Up to date · team · CLI 1.0.0');
  });

  // Round 5 (C79): masked, two accounts of one provider can read alike.
  it('shows each account’s email in full, with the mask preference on and with it off: the accounts are told apart here', () => {
    const accounts = [codex({ account: sampleAccount({ email: 'jo.personal@example.test' }) }), work({ kind: 'ok' }, { account: sampleAccount({ email: 'jo.work@example.test' }) })];
    for (const maskEmail of [true, false]) {
      show(accounts, { ...prefs(), values: { ...prefs().values, privacy: { maskEmail } } });
      expect(row('Personal').textContent).toContain('jo.personal@example.test');
      expect(row('Work').textContent).toContain('jo.work@example.test');
      expect(document.body.textContent).not.toContain('•••');
      cleanup();
    }
  });

  it('shows the folder under an added account’s row, and none under the first', () => {
    show();
    expect(row('Work').querySelector('[data-instance-folder]')?.textContent).toBe(FOLDER);
    expect(row('Personal').querySelector('[data-instance-folder]')).toBeNull();
  });

  it('offers Rename in each header and keeps Remove in the added account menu', () => {
    show();
    expect(within(row('Work')).getByLabelText<HTMLInputElement>('Enabled').checked).toBe(true);
    expect(within(row('Personal')).queryByLabelText('Enabled')).toBeNull();
    expect(within(row('Work')).getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(within(row('Personal')).getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(items(openMenu('Work'))).toEqual(['Remove…']);
    expect(within(row('Personal')).queryByRole('button', { name: 'Actions for the account Personal' })).toBeNull();
    expect(within(row('Personal')).getByRole('button', { name: 'Rename account Personal' })).toBeTruthy();
  });

  it('keeps the provider’s own controls once: its switch, its executable override, Redetect and Add account', () => {
    show();
    const section = screen.getByRole('heading', { level: 4, name: 'Codex' }).closest('section') as HTMLElement;
    expect(within(section).getAllByLabelText(/CLI executable/)).toHaveLength(1);
    expect(within(section).getAllByRole('button', { name: 'Redetect / reconnect' })).toHaveLength(1);
    expect(within(section).getAllByRole('button', { name: 'Add Codex account' })).toHaveLength(1);
    // The provider's Enabled is the heading's; the added account's is its row's.
    expect(within(section).getAllByLabelText('Enabled')).toHaveLength(2);
  });

  it('sends Refresh and the switch for the row’s own account', async () => {
    show();
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Refresh' }));
    fireEvent.click(within(row('Personal')).getByRole('button', { name: 'Refresh' }));
    fireEvent.click(within(row('Work')).getByLabelText('Enabled'));
    await act(flush);
    expect(requests).toEqual([
      ['providers:refresh', { providerId: 'codex', instanceId: WORK }],
      ['providers:refresh', { providerId: 'codex', instanceId: 'default' }],
      ['prefs:patch', { providers: { codex: { instances: { [WORK]: { enabled: false } } } } }],
    ]);
  });

  it('shows a switched-off account with its switch off, and no Refresh', () => {
    show([codex(), work({ kind: 'disabled' })], prefs([entry({ enabled: false })]));
    expect(within(row('Work')).getByLabelText<HTMLInputElement>('Enabled').checked).toBe(false);
    expect(within(row('Work')).queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(row('Work').textContent).toContain('Disabled');
  });

  // V23 (C71): the provider's Redetect asks each switched-on account, one request each.
  it('sends one redetect per switched-on account from the provider’s Redetect, and none for one that is off or cannot be used', async () => {
    const OFF = '11111111-2222-4333-8444-555555555555';
    const BROKEN = '22222222-2222-4333-8444-555555555555';
    show(
      [codex(), work(), codex({ instanceId: OFF, label: 'Off', status: { kind: 'disabled' } }), codex({ instanceId: BROKEN, label: '', status: { kind: 'blocked', reason: 'invalid-instance', issue: 'invalid-label' } })],
      prefs([entry(), entry({ key: OFF, id: OFF, label: 'Off', enabled: false }), entry({ key: BROKEN, id: BROKEN, label: null, issue: 'invalid-label' })]),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Redetect / reconnect' }));
    expect(await screen.findByText('Detection restarted.')).toBeTruthy();
    expect(requests).toEqual([
      ['providers:redetect', { providerId: 'codex', instanceId: 'default' }],
      ['providers:redetect', { providerId: 'codex', instanceId: WORK }],
    ]);
  });
});

describe('Rename (V10; C13, C34)', () => {
  const rename = (label: string, value: string): HTMLInputElement => {
    fireEvent.click(within(row(label)).getByRole('button', { name: `Rename account ${label}` }));
    const field = screen.getByLabelText<HTMLInputElement>(`Name of the account ${label}`);
    fireEvent.change(field, { target: { value } });
    return field;
  };

  it('edits the label in place, starting from the one it has, and sends a patch for that account', async () => {
    show();
    answers['prefs:patch'] = prefs([entry({ label: 'Client A' })], 2);
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Rename account Work' }));
    const field = screen.getByLabelText<HTMLInputElement>('Name of the account Work');
    expect(field.value).toBe('Work');
    fireEvent.change(field, { target: { value: '  Client   A ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await act(flush);
    // Cleaned as a name is, as main cleans it.
    expect(requests).toEqual([['prefs:patch', { providers: { codex: { instances: { [WORK]: { label: 'Client A' } } } } }]]);
    expect(screen.queryByLabelText('Name of the account Work')).toBeNull();
    expect(within(row('Work')).getByRole('heading', { name: 'Account: Client A' })).toBeTruthy();
    expect(row('Work').dataset['instance']).toBe(WORK);
    expect(row('Work').textContent).toContain('work@example.test');
  });

  it('renames the first account through the provider’s own label, and clears it when left empty', async () => {
    show();
    answers['prefs:patch'] = prefs(undefined, 2, 'Home');
    rename('Personal', 'Home');
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await act(flush);
    expect(requests.at(-1)).toEqual(['prefs:patch', { providers: { codex: { label: 'Home' } } }]);
    expect(within(row('Personal')).getByRole('heading', { name: 'Account: Home' })).toBeTruthy();
    expect(row('Personal').textContent).toContain('user@example.com');
    answers['prefs:patch'] = prefs(undefined, 3, null);
    rename('Personal', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await act(flush);
    expect(requests.at(-1)).toEqual(['prefs:patch', { providers: { codex: { label: null } } }]);
    expect(within(row('Personal')).getByRole('heading', { name: 'Account: user@example.com' })).toBeTruthy();
  });

  it.each([
    ['an empty name, for an added account', 'Work', '   ', 'Enter a name for this account.'],
    ['a name another account has, in another letter case', 'Work', 'personal', 'Another account of this provider has that name.'],
    ['an added account’s name, for the first one', 'Personal', 'WORK', 'Another account of this provider has that name.'],
  ])('refuses %s beside the field, and sends nothing', async (_name, label, value, said) => {
    show();
    // The row, found before its heading gives way to the field.
    const target = row(label);
    rename(label, value);
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await act(flush);
    expect(within(target).getByRole('alert').textContent).toBe(said);
    // The field stays, with what was typed, for another try.
    expect(within(target).getByLabelText<HTMLInputElement>(`Name of the account ${label}`).value).toBe(value);
    expect(requests).toEqual([]);
  });

  it('keeps its own name: saving it unchanged in another letter case is no clash', async () => {
    show();
    rename('Work', 'WORK');
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await act(flush);
    expect(requests).toEqual([['prefs:patch', { providers: { codex: { instances: { [WORK]: { label: 'WORK' } } } } }]]);
  });

  it('drops the edit on Escape and on Cancel, sending nothing', () => {
    show();
    fireEvent.keyDown(rename('Work', 'Other'), { key: 'Escape' });
    expect(screen.queryByLabelText('Name of the account Work')).toBeNull();
    rename('Work', 'Other');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(within(row('Work')).getByRole('heading', { level: 5 })).toBeTruthy();
    expect(requests).toEqual([]);
  });
});

describe('Remove (V10, V23; C23, C69)', () => {
  const withWorkSessions = (count: number, running = false) => (snapshot: ReturnType<typeof sampleSnapshot>) =>
    withSessions(snapshot, sessionsState([
      ...Array.from({ length: count }, (_, index) => sessionEntry(`Work ${index}`, running && index === 0 ? SUMMARIES.runningThinking : SUMMARIES.idle, { providerId: 'codex', instanceId: WORK })),
      sessionEntry('On the first account', SUMMARIES.runningThinking, { providerId: 'codex' }),
      sessionEntry('Another provider, same id', SUMMARIES.runningThinking, { providerId: 'claude', instanceId: WORK }),
    ]));
  const askRemove = (label = 'Work') => fireEvent.click(within(openMenu(label)).getByRole('menuitem', { name: 'Remove…' }));

  it.each([[0, 'no sessions'], [1, '1 session'], [3, '3 sessions']])('asks first, naming the label and its %i sessions, and saying the folder is left as it is', (count, words) => {
    show(undefined, undefined, withWorkSessions(count));
    askRemove();
    const dialog = screen.getByRole('dialog', { name: 'Remove the account Work?' });
    expect(dialog.textContent).toContain(`“Work”, which has ${words}.`);
    expect(dialog.textContent).toContain('Its folder, and everything the CLI keeps in it, is left as it is.');
    expect(requests).toEqual([]);
  });

  it('sends one request for that account once confirmed, and none on Cancel', async () => {
    answers['instances:remove'] = { status: 'removed' };
    show();
    askRemove();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remove the account Work?' })).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([]);
    askRemove();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remove the account Work?' })).getByRole('button', { name: 'Remove' }));
    await act(flush);
    expect(requests).toEqual([['instances:remove', { providerId: 'codex', key: WORK }]]);
  });

  it('says so instead of asking while one of its own sessions runs, and sends nothing', () => {
    show(undefined, undefined, withWorkSessions(2, true));
    askRemove();
    expect(screen.queryByRole('dialog', { name: 'Remove the account Work?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'A session of Work is running' }).textContent).toContain('Wait for it to finish, then remove the account.');
    expect(requests).toEqual([]);
  });

  it('asks as usual when only other accounts’ sessions run', () => {
    show(undefined, undefined, withWorkSessions(2));
    askRemove();
    expect(screen.getByRole('dialog', { name: 'Remove the account Work?' })).toBeTruthy();
  });

  it.each([
    ['cleanup-failed', /could not confirm that this account’s CLI process has ended, so the account was kept/],
    ['session-running', /A session of this account is running/],
    ['preferences-blocked', /preferences cannot be saved right now, so the account was kept/],
  ])('keeps the row and says why when main refuses as %s', async (reason, said) => {
    answers['instances:remove'] = { status: 'refused', reason };
    show();
    askRemove();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remove the account Work?' })).getByRole('button', { name: 'Remove' }));
    await act(flush);
    expect(within(row('Work')).getByRole('status').textContent).toMatch(said);
  });
});

describe('a signed-out account (V10; C36)', () => {
  const signedOut = () => [codex(), work({ kind: 'not-logged-in' }, { account: null, usage: null })];
  const command = (label: string) => row(label).querySelector('code')?.textContent;

  it.each([
    ['PowerShell, on Windows', 'win32', 'D:\\accounts\\codex work', `$env:CODEX_HOME = 'D:\\accounts\\codex work'; codex login`],
    ['PowerShell, a quote in the path doubled', 'win32', `D:\\it's mine\\codex`, `$env:CODEX_HOME = 'D:\\it''s mine\\codex'; codex login`],
    ['POSIX, elsewhere', 'linux', '/home/me/codex work', `CODEX_HOME='/home/me/codex work' codex login`],
    ['POSIX, a quote in the path closed, escaped and opened again', 'darwin', `/Users/me/it's mine`, `CODEX_HOME='/Users/me/it'\\''s mine' codex login`],
    ['POSIX, a dollar and a backtick left as they are inside the quotes', 'linux', '/srv/$HOME/`x`', "CODEX_HOME='/srv/$HOME/`x`' codex login"],
  ])('shows the login command with the variable set for its folder: %s', (_name, platform, folder, expected) => {
    install(platform);
    show(signedOut(), prefs([entry({ folder })]));
    expect(command('Work')).toBe(expected);
  });

  it('says a CLI found off PATH is run by its full path in the terminal fat-g opens, and keeps the path out of the row', () => {
    show([codex(), work({ kind: 'not-logged-in' }, { account: null, usage: null, installation: { source: 'known-dir', version: '2.1.321' } })], prefs([entry()]));
    expect(within(row('Work')).getByText(OFF_PATH)).toBeTruthy();
    expect(command('Work')).toContain('codex login');
    cleanup();
    show(signedOut(), prefs([entry()]));
    expect(row('Work').querySelector('[data-off-path]')).toBeNull();
  });

  it('shows the first account the CLI’s own command: it sets nothing', () => {
    show([codex({ status: { kind: 'not-logged-in' } }), work()]);
    expect(command('Personal')).toBe('codex login');
  });

  it('copies the command shown, and reconnects that account alone', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    show(signedOut());
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Copy' }));
    await act(flush);
    expect(copied).toEqual([`$env:CODEX_HOME = '${FOLDER}'; codex login`]);
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Signed in, reconnect' }));
    await act(flush);
    expect(requests).toEqual([['providers:redetect', { providerId: 'codex', instanceId: WORK }]]);
    expect(within(row('Work')).getByText('CLI reconnection accepted.')).toBeTruthy();
  });

  // Round 6, V28 (C80): the user's own terminal, opened with the command the row shows.
  it('opens a terminal for that account from its row: the request names the account, and carries no command', async () => {
    answers['instances:openLoginTerminal'] = { status: 'opened' };
    show(signedOut());
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Sign in with the CLI' }));
    await act(flush);
    expect(requests).toEqual([['instances:openLoginTerminal', { providerId: 'codex', instanceId: WORK }]]);
    expect(within(row('Work')).getByRole('status').textContent).toBe('A terminal opened and started the sign-in. Finish it in your browser, then press Signed in, reconnect.');
    // The command stays, with Copy, as the fallback for a terminal of the user's own.
    expect(command('Work')).toBe(`$env:CODEX_HOME = '${FOLDER}'; codex login`);
    expect(within(row('Work')).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('opens one for the first account too, by its own id', async () => {
    answers['instances:openLoginTerminal'] = { status: 'opened' };
    show([codex({ status: { kind: 'not-logged-in' } }), work()]);
    fireEvent.click(within(row('Personal')).getByRole('button', { name: 'Sign in with the CLI' }));
    await act(flush);
    expect(requests).toEqual([['instances:openLoginTerminal', { providerId: 'codex', instanceId: 'default' }]]);
  });

  it.each([
    ['none could be started', { status: 'refused', reason: 'no-terminal' }],
    ['the account cannot be used', { status: 'refused', reason: 'unavailable' }],
  ])('says to run the command in a terminal of your own when %s', async (_name, answer) => {
    answers['instances:openLoginTerminal'] = answer;
    show(signedOut());
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Sign in with the CLI' }));
    await act(flush);
    expect(within(row('Work')).getByRole('status').textContent).toBe('No terminal could be opened. Run the command below in a terminal of your own.');
  });

  it('offers no terminal for an account that is signed in', () => {
    show();
    expect(screen.queryByRole('button', { name: 'Sign in with the CLI' })).toBeNull();
  });

  it('offers Reconnect on the row of an account in error, for that account', async () => {
    show([codex(), work({ kind: 'error', message: 'The CLI stopped answering.' })]);
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Reconnect CLI' }));
    await act(flush);
    expect(requests).toEqual([['providers:redetect', { providerId: 'codex', instanceId: WORK }]]);
    expect(within(row('Personal')).queryByRole('button', { name: 'Reconnect CLI' })).toBeNull();
  });
});

describe('what an account says under its row (V10; C11, C35, C64)', () => {
  it('names the variables it was started without, never a value, and says nothing with none', () => {
    show([codex(), work({ kind: 'ok' }, { startedWithout: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] })]);
    expect(row('Work').querySelector('[data-started-without]')?.textContent).toBe('Started without OPENAI_API_KEY, OPENAI_BASE_URL');
    expect(row('Personal').querySelector('[data-started-without]')).toBeNull();
    // The login command is not changed by them.
    cleanup();
    show([codex(), work({ kind: 'not-logged-in' }, { startedWithout: ['OPENAI_API_KEY'] })]);
    expect(row('Work').querySelector('code')?.textContent).toBe(`$env:CODEX_HOME = '${FOLDER}'; codex login`);
  });

  it('says Same account as, and the other’s label, on the later of two accounts that report one account', () => {
    const same = sampleAccount({ email: 'Same@Example.test' });
    show([codex({ account: same }), work({ kind: 'ok' }, { account: { ...same, email: 'same@example.test' } })]);
    expect(row('Work').querySelector('[data-same-account]')?.textContent).toBe('Same account as Personal');
    expect(row('Personal').querySelector('[data-same-account]')).toBeNull();
  });

  it('says nothing of it for two different accounts', () => {
    show();
    expect(document.querySelector('[data-same-account]')).toBeNull();
  });

  it('lists each account’s own models under its row, with their levels and speed tiers', () => {
    const level = (id: string, label: string, place: number) => ({ id, label, place, caution: false });
    const first = sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', resolvedId: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: [level('low', 'Low', 1), level('high', 'High', 2)], listedDefaultEffort: null, speedTiers: [{ id: 'fast', name: 'Fast', description: null }] })] });
    const second = sampleCatalogProvider({ id: 'codex', instanceId: WORK, models: [sampleModel({ key: 'gpt-6-team', resolvedId: 'gpt-6-team', name: 'GPT-6 Team', efforts: [level('low', 'Low', 1)], listedDefaultEffort: null, speedTiers: [] })] });
    show(undefined, undefined, (snapshot) => ({ ...snapshot, catalog: { ...snapshot.catalog!, providers: [first, second] } }));
    const models = (label: string) => [...row(label).querySelectorAll('tbody tr')].map((line) => [...line.querySelectorAll('td')].slice(0, 4).map((cell) => cell.textContent));
    expect(models('Personal')).toEqual([['GPT-6 Sol', 'gpt-6-sol', 'Low · High', 'Fast']]);
    expect(models('Work')).toEqual([['GPT-6 Team', 'gpt-6-team', 'Low', 'None']]);
  });
});

describe('an account that cannot run (V10; C37, C59, C66)', () => {
  it('says its folder is missing, with Remove as the remedy and no Refresh', () => {
    show([codex(), work({ kind: 'blocked', reason: 'folder-missing' }, { account: null, usage: null })]);
    expect(row('Work').textContent).toContain('Folder missing');
    expect(row('Work').textContent).toContain('This account’s folder is missing, or is not a folder, so nothing is started for it.');
    expect(within(row('Work')).queryByRole('button', { name: 'Refresh' })).toBeNull();
    fireEvent.click(within(row('Work')).getByRole('button', { name: 'Remove account…' }));
    expect(screen.getByRole('dialog', { name: 'Remove the account Work?' })).toBeTruthy();
  });

  it.each([
    ['project', 'This folder is a project’s folder, or is inside or around one.'],
    ['inherited-folder', 'This folder is the one fat-g’s environment names, which is the first account’s.'],
    ['other-instance', 'This folder is another account’s.'],
  ] as const)('says which rule its folder fails: %s', (rule, said) => {
    show([codex(), work({ kind: 'blocked', reason: 'folder-refused', rule }, { account: null, usage: null })]);
    expect(row('Work').textContent).toContain(said);
    expect(within(row('Work')).getByRole('button', { name: 'Remove account…' })).toBeTruthy();
  });

  it('shows an entry that cannot be used with why, and Remove alone: no switch, no Refresh, no Rename', async () => {
    const KEY = '33333333-2222-4333-8444-555555555555';
    answers['instances:remove'] = { status: 'removed' };
    show(
      [codex(), work(), codex({ instanceId: KEY, label: 'Work', status: { kind: 'blocked', reason: 'invalid-instance', issue: 'label-taken' }, account: null, usage: null })],
      prefs([entry(), entry({ key: KEY, id: KEY, label: 'Work', issue: 'label-taken' })]),
    );
    const broken = document.querySelector(`[data-instance="${KEY}"]`) as HTMLElement;
    expect(broken.textContent).toContain('An earlier account has this saved account’s name.');
    expect(within(broken).queryByLabelText('Enabled')).toBeNull();
    expect(within(broken).queryByRole('button', { name: 'Refresh' })).toBeNull();
    fireEvent.click(within(broken).getByRole('button', { name: 'Actions for the account Work' }));
    expect(items(within(broken).getByRole('menu'))).toEqual(['Remove…']);
    fireEvent.click(within(broken).getByRole('menuitem', { name: 'Remove…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remove the account Work?' })).getByRole('button', { name: 'Remove' }));
    await act(flush);
    // By its key, which for an entry with no usable id is one made for this run.
    expect(requests).toEqual([['instances:remove', { providerId: 'codex', key: KEY }]]);
  });

  it('names an entry that has no label to show', () => {
    const KEY = '33333333-2222-4333-8444-555555555555';
    show(
      [codex(), codex({ instanceId: KEY, label: '', status: { kind: 'blocked', reason: 'invalid-instance', issue: 'invalid-label' }, account: null, usage: null })],
      prefs([entry({ key: KEY, id: KEY, label: null, issue: 'invalid-label' })]),
    );
    expect(row('Unnamed account').textContent).toContain('This saved account has no name.');
  });
});

describe('with read-only preferences', () => {
  it('disables the switch, Rename and Remove, and leaves Refresh', () => {
    show(undefined, { ...prefs(), status: { kind: 'read-only', reason: 'unreadable' } });
    expect(within(row('Work')).getByLabelText<HTMLInputElement>('Enabled').disabled).toBe(true);
    const menu = openMenu('Work');
    expect(within(menu).getAllByRole('menuitem').map((item) => (item as HTMLButtonElement).disabled)).toEqual([true]);
    expect(within(row('Work')).getByRole<HTMLButtonElement>('button', { name: 'Rename account Work' }).disabled).toBe(true);
    expect(within(row('Work')).getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(false);
  });
});
