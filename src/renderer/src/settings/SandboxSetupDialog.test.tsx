// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// V18 (docs/planning/_archive/M22.md, Design 10; C60–C62, C72): the sandbox setup's dialog — what it says
// before the press, that nothing is sent without one, the one request each press sends, and each
// state the account's snapshot can put it in. Main, the CLI and Windows are not here: the dialog
// follows the snapshot main publishes, and the fake bridge answers the one channel.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstanceSetupSandboxResult } from '@shared/contracts/instances';
import { SANDBOX_SETUP_STATES, type SandboxSetupView } from '@shared/contracts/permissions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { availability, modedProvider } from '../test/permissions';
import { showState } from '../test/sessions';
import { closeSandboxSetup, openSandboxSetup, useSandboxSetup } from './sandbox-setup-store';
import { SandboxSetupDialog } from './SandboxSetupDialog';
import { SETUP_WORDS } from './setup-words';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answer: InstanceSetupSandboxResult | Error;

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  requests = [];
  answer = { status: 'started' };
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    if (answer instanceof Error) throw answer;
    return { ok: true, value: answer };
  });
  closeSandboxSetup();
});
afterEach(cleanup);

const TARGET = { providerId: 'codex', instanceId: 'default' } as const;
const NEEDING = [availability('sandbox-ok', { available: false, reason: 'needs-setup', setup: true }), availability('edits-ok', { available: false, reason: 'needs-setup', setup: true })];
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
/** The account as main publishes it: where its setup stands, and what it can use. */
function account(setup?: SandboxSetupView, modes = NEEDING) {
  act(() => { showState({ providers: [modedProvider({ id: 'codex', displayName: 'Codex', modes, ...(setup === undefined ? {} : { sandboxSetup: setup }) })] }); });
}
function open(setup?: SandboxSetupView) {
  account(setup);
  render(<SandboxSetupDialog />);
  act(() => { openSandboxSetup(TARGET); });
}
const dialog = () => document.querySelector('dialog[data-sandbox-setup]') as HTMLDialogElement;
const text = (): string => dialog().querySelector('[data-setup-state]')?.textContent ?? '';
const state = () => dialog().querySelector<HTMLElement>('[data-setup-state]')?.dataset['setupState'];
const buttons = (): string[] => [...dialog().querySelectorAll('button')].map((button) => button.textContent ?? '');
const button = (name: string) => screen.getByRole('button', { name });

describe('the sandbox setup’s dialog, before the press (V18; C60)', () => {
  it('holds nothing until it is opened, and sends nothing by being opened', async () => {
    account();
    render(<SandboxSetupDialog />);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(dialog().textContent).toBe('');
    act(() => { openSandboxSetup(TARGET); });
    await settle();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(requests).toEqual([]);
  });

  it('is titled by the provider it sets up, and says what the setup changes, who asks for leave, whose it is and that fat-g cannot undo it', () => {
    open();
    expect(screen.getByRole('heading').textContent).toBe('Set up Codex’s sandbox');
    expect(dialog().getAttribute('aria-labelledby')).toBe(screen.getByRole('heading').id);
    expect(state()).toBe('idle');
    // In its provider's own description: accounts, firewall rules and file permissions.
    // What it changes and who asks are the provider's own lines, from its descriptor; what fat-g never sees is fat-g's.
    expect(text()).toContain('By its vendor’s own description, the CLI’s setup creates dedicated sandbox user accounts on this machine, and changes firewall rules and file permissions.');
    expect(text()).toContain('The system will ask for an administrator’s approval by itself. fat-g asks for no password, and sees none.');
    expect(text()).toContain('fat-g asks for no password, and sees none.');
    expect(text()).toContain('The setup belongs to this account’s Codex configuration, and to no session.');
    expect(text()).toContain('fat-g cannot undo it.');
    // No field anywhere: fat-g asks for, sees and keeps no credential.
    expect(dialog().querySelectorAll('input, textarea, form')).toHaveLength(0);
  });

  it('gives Cancel the focus, so the safe answer is the default, and closes without sending anything', async () => {
    open();
    expect(buttons()).toEqual([SETUP_WORDS.cancel, SETUP_WORDS.setUp]);
    expect(document.activeElement).toBe(button(SETUP_WORDS.cancel));
    fireEvent.click(button(SETUP_WORDS.cancel));
    await settle();
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(useSandboxSetup.getState()).toEqual({ open: false, target: null });
    expect(requests).toEqual([]);
  });

  it('names the account by its label where its provider runs more than one', () => {
    act(() => {
      showState({ providers: [
        modedProvider({ id: 'codex', displayName: 'Codex', modes: NEEDING }),
        modedProvider({ id: 'codex', displayName: 'Codex', instanceId: 'aaaaaaaa-0000-4000-8000-00000000000a', label: 'Work', modes: NEEDING }),
      ] });
    });
    render(<SandboxSetupDialog />);
    act(() => { openSandboxSetup({ providerId: 'codex', instanceId: 'aaaaaaaa-0000-4000-8000-00000000000a' }); });
    expect(text()).toContain('The setup belongs to this account’s Codex configuration (Work), and to no session.');
  });

  it('sends the one request at the press of Set up, for the account alone: no mode, no path and no credential', async () => {
    open();
    fireEvent.click(button(SETUP_WORDS.setUp));
    await settle();
    expect(requests).toEqual([['instances:setupSandbox', { providerId: 'codex', instanceId: 'default', action: 'start' }]]);
    // The dialog shows what main publishes, and keeps no state of the setup itself.
    expect(state()).toBe('idle');
  });

  it.each([
    ['unknown-instance', /no longer set up in fat-g/],
    ['no-setup', /Codex has no sandbox setup to run on this system/],
    ['running', /already under way/],
    ['busy', /A chat or a side question of this account is still in progress/],
  ] as const)('says why a press was not taken: %s', async (reason, words) => {
    open();
    answer = { status: 'refused', reason };
    fireEvent.click(button(SETUP_WORDS.setUp));
    await settle();
    expect(screen.getByRole('alert').textContent).toMatch(words);
  });

  it('says so when main could not be reached at all', async () => {
    open();
    answer = new Error('gone');
    fireEvent.click(button(SETUP_WORDS.setUp));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(SETUP_WORDS.notSent);
  });
});

describe('the sandbox setup’s dialog, by the account’s state (V18; C61, C62, C72)', () => {
  it.each(['starting', 'waiting'] as const)('waits while the setup is %s, with Stop waiting, and says the account is held', async (name) => {
    open({ state: name, error: null, readiness: null });
    expect(state()).toBe(name);
    expect(screen.getByRole('status').textContent).toBe('Waiting for Codex’s setup… The system may be asking for your approval.');
    expect(text()).toContain(SETUP_WORDS.held);
    expect(buttons()).toEqual([SETUP_WORDS.close, SETUP_WORDS.stopWaiting]);
    fireEvent.click(button(SETUP_WORDS.stopWaiting));
    await settle();
    expect(requests).toEqual([['instances:setupSandbox', { providerId: 'codex', instanceId: 'default', action: 'stop-waiting' }]]);
  });

  it('says a failed setup with the CLI’s own reason, and offers Try again, which is a new press', async () => {
    open({ state: 'failed', error: 'The administrator declined the request.', readiness: 'not-configured' });
    expect(screen.getByRole('status').textContent).toBe('Codex’s setup did not succeed. The modes that need its sandbox stay unavailable to this account.');
    expect(text()).toContain('Codex reported: The administrator declined the request.');
    expect(buttons()).toEqual([SETUP_WORDS.close, SETUP_WORDS.tryAgain]);
    expect(requests).toEqual([]);
    fireEvent.click(button(SETUP_WORDS.tryAgain));
    await settle();
    expect(requests).toEqual([['instances:setupSandbox', { providerId: 'codex', instanceId: 'default', action: 'start' }]]);
    cleanup();
    // With no reason given, none is made up.
    closeSandboxSetup();
    open({ state: 'failed', error: null, readiness: 'not-configured' });
    expect(text()).not.toContain('reported');
  });

  it('says a completed setup by the modes it was for, by their provider’s labels, and offers nothing but Close', () => {
    // Opened while the modes waited for it: those are the ones it names.
    open({ state: 'waiting', error: null, readiness: null });
    account({ state: 'completed', error: null, readiness: 'ready' }, [availability('sandbox-ok'), availability('edits-ok')]);
    expect(state()).toBe('completed');
    expect(screen.getByRole('status').textContent).toBe('Set up; this account’s Edits ok and Sandbox ok are available.');
    expect(buttons()).toEqual([SETUP_WORDS.close]);
    cleanup();
    // Opened once it was already done: it names none, and still says it.
    closeSandboxSetup();
    account({ state: 'completed', error: null, readiness: 'ready' }, [availability('sandbox-ok')]);
    render(<SandboxSetupDialog />);
    act(() => { openSandboxSetup(TARGET); });
    expect(screen.getByRole('status').textContent).toBe('Set up; this account can use the modes that need the sandbox.');
  });

  it.each([
    ['not-configured', 'Codex reports: not configured.', true],
    ['update-required', 'Codex reports: an update is required.', true],
    ['ready', 'Codex reports: ready.', false],
    [null, 'Codex has not said since whether its sandbox is ready.', true],
  ] as const)('says an outcome it did not hear as unknown, with what the CLI reports now: %s', (readiness, words, again) => {
    open({ state: 'unknown', error: null, readiness });
    expect(screen.getByRole('status').textContent).toBe('The outcome is unknown: the setup may still be changing the machine.');
    expect(text()).toContain(words);
    // Try again where it is not ready, and only there: a second request needs a new press.
    expect(buttons()).toEqual(again ? [SETUP_WORDS.close, SETUP_WORDS.tryAgain] : [SETUP_WORDS.close]);
    expect(requests).toEqual([]);
  });

  it('has something to say in every state the contract names', () => {
    for (const name of SANDBOX_SETUP_STATES) {
      open({ state: name, error: null, readiness: null });
      expect(state(), name).toBe(name);
      expect(text(), name).toMatch(/\S/);
      cleanup();
      closeSandboxSetup();
    }
  });

  it('follows the account’s snapshot from the press to the end, the focus going to the button that leaves things as they are at each change', async () => {
    open();
    fireEvent.click(button(SETUP_WORDS.setUp));
    await settle();
    account({ state: 'starting', error: null, readiness: null });
    expect(state()).toBe('starting');
    // The button that was pressed is gone, and another stands in its place: a second Enter presses neither.
    expect(document.activeElement).toBe(button(SETUP_WORDS.close));
    account({ state: 'waiting', error: null, readiness: null });
    account({ state: 'failed', error: 'declined', readiness: 'not-configured' });
    expect(state()).toBe('failed');
    expect(document.activeElement).toBe(button(SETUP_WORDS.close));
    // One request, for the one press.
    expect(requests).toHaveLength(1);
  });

  it('gives the focus back to the control that opened it, and to what stands around its place where that control is gone: never to the page', async () => {
    // As the chat has it: its list, and under it the block's reason with Set up — which a completed setup ends (C89).
    const page = (blocked: boolean) => (
      <>
        <div data-area="">
          <div tabIndex={0} data-list="" />
          {blocked ? <div data-reason=""><button type="button">Opens it</button></div> : <textarea aria-label="Message" />}
        </div>
        <SandboxSetupDialog />
      </>
    );
    account();
    const { rerender } = render(page(true));
    const opener = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Opens it' });
    opener().focus();
    act(() => { openSandboxSetup(TARGET); });
    fireEvent.click(button(SETUP_WORDS.cancel));
    await settle();
    expect(document.activeElement).toBe(opener());
    // Opened again, and its opener leaves while it is open.
    act(() => { openSandboxSetup(TARGET); });
    account({ state: 'completed', error: null, readiness: 'ready' }, []);
    rerender(page(false));
    fireEvent.click(button(SETUP_WORDS.close));
    await settle();
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('[data-list]'));
  });

  it('stops nothing by being closed: opened again, it shows where the account stands', async () => {
    open({ state: 'waiting', error: null, readiness: null });
    fireEvent.click(button(SETUP_WORDS.close));
    await settle();
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(requests).toEqual([]);
    act(() => { openSandboxSetup(TARGET); });
    expect(state()).toBe('waiting');
  });
});
