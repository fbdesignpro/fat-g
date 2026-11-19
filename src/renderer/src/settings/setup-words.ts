// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for the sandbox setup's dialog (docs/planning/_archive/M22.md, Design 10; C60–C62, C72): each
// of its states, whose it is, and why a press was not taken, with the provider named by the display
// name it is given. What the setup changes on the machine, who asks for leave and what may be
// happening while it waits are the provider's own lines, declared in its descriptor
// (`capabilities.permissions.setup`): no word of a CLI or a system is here.
//
// Nothing here says the setup is something fat-g does: fat-g sends the one request, at the press,
// and can undo nothing of it.
import type { InstanceSetupSandboxResult } from '@shared/contracts/instances';
import { MODE_WORDS, type SandboxReadiness, type SetupAction } from '@shared/contracts/permissions';

type SetupRefusal = Extract<InstanceSetupSandboxResult, { status: 'refused' }>['reason'];

const list = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`);

export const SETUP_WORDS = {
  title: (provider: string): string => `Set up ${provider}’s sandbox`,
  /** Before the press (C60), after the provider's own lines on what changes and who asks: what fat-g never sees, whose the setup is, and that it stays. */
  noPassword: 'fat-g asks for no password, and sees none.',
  belongs: (provider: string, account: string | null): string => `The setup belongs to this account’s ${provider} configuration${account === null ? '' : ` (${account})`}, and to no session.`,
  permanent: 'fat-g cannot undo it.',
  /** `starting` and `waiting` (C72): no clock of fat-g's ends it. */
  waiting: (provider: string, hint: string): string => `Waiting for ${provider}’s setup…${hint === '' ? '' : ` ${hint}`}`,
  held: 'Nothing else of this account is sent until it has ended.',
  /** `failed` (C61): the CLI's own reason follows, where it gave one. */
  failed: (provider: string): string => `${provider}’s setup did not succeed. The modes that need its sandbox stay unavailable to this account.`,
  reported: (provider: string, reason: string): string => `${provider} reported: ${reason}`,
  /** `completed` (C61): the modes it was for, by their labels, where the dialog knows them. */
  completed: (modes: readonly string[]): string => (modes.length === 0 ? 'Set up; this account can use the modes that need the sandbox.' : `Set up; this account’s ${list(modes)} ${modes.length === 1 ? 'is' : 'are'} available.`),
  /** `unknown` (C72): fat-g did not hear the setup's end. */
  unknown: 'The outcome is unknown: the setup may still be changing the machine.',
  reports: (provider: string, readiness: SandboxReadiness | null): string => (readiness === null ? `${provider} has not said since whether its sandbox is ready.` : `${provider} reports: ${READINESS_WORDS[readiness]}.`),
  cancel: 'Cancel',
  close: 'Close',
  setUp: MODE_WORDS.setUp,
  stopWaiting: 'Stop waiting',
  tryAgain: 'Try again',
  notSent: 'fat-g could not reach the setup.',
} as const;

const READINESS_WORDS: Readonly<Record<SandboxReadiness, string>> = { ready: 'ready', 'not-configured': 'not configured', 'update-required': 'an update is required' };

/** Why a press was not taken, in fat-g's words (C62, C72). */
export function setupRefusalText(reason: SetupRefusal, action: SetupAction, provider: string): string {
  switch (reason) {
    case 'unknown-instance': return 'This account is no longer set up in fat-g.';
    case 'no-setup': return action === 'start' ? `${provider} has no sandbox setup to run on this system.` : 'No setup is under way for this account.';
    case 'running': return 'A setup is already under way for this account.';
    case 'busy': return 'A chat or a side question of this account is still in progress. Set up once it has finished.';
  }
}
