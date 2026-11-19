// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { InstallDirectoryHint, InstanceSupport } from '@shared/provider-kit/provider';
import { CLAUDE_PERMISSIONS, CLAUDE_PLANS } from './chat-modes';
import { CLAUDE_EXECUTABLE_HELP } from './executable-help';

// The app feature is "Claude", never branded "Claude Code" (decision 0004, rule 7).
export const CLAUDE_DESCRIPTOR: ProviderDescriptor = {
  id: 'claude',
  displayName: 'Claude',
  installGuidance: 'Install the Claude CLI, then sign in from your own terminal.',
  executableHelp: CLAUDE_EXECUTABLE_HELP,
  loginCommand: 'claude auth login',
  // The CLI caches usage reads machine-wide for about a minute (decision 0001).
  minPollIntervalSec: 60,
  // Models come from the `initialize` reply its usage session already receives (M13, C27). Sessions
  // through its facet, each on a process of its own, under the mode its chat has (M22; decision
  // 0027): the reading mode holds one to four tools that only read and one that asks the user a
  // question, and grants nothing it asks for but that question's answer, which grants no action
  // (M16, M21; decisions 0020, 0026); the four others offer three tools that act, and an action is
  // granted by the user, on its card, or by what the mode lets run. A project's other roots reach a
  // session as `--add-dir` (C19, C61). No history: fat-g opens no transcript of Claude's, and a chat
  // shows what fat-g recorded (C48, C49). A question is a request that holds its turn: `blocking`
  // (M21, C30). Its modes, in fat-g's names, are chat-modes.ts's (M22, C39, C63).
  capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: true, models: true, asides: { followUp: true, streamed: false, tools: 'none' }, questions: 'blocking', declines: true, permissions: CLAUDE_PERMISSIONS, titles: true, plans: CLAUDE_PLANS, context: true },
  // Its look — the orange of the layout mockup, and an original mark, not Anthropic's logo (M11,
  // C55): a speech bubble with three dots cut out — is in catalog-defaults.json (M13, C21).
};

/** Settings' Installation guide (M13, C25). */
export const CLAUDE_INSTALLATION_GUIDE = 'https://code.claude.com/docs/en/setup';

/**
 * Several accounts (M14b, C5, C9). The CLI keeps one login per configuration folder, and
 * `CLAUDE_CONFIG_DIR` moves that folder from `~/.claude`; M14b's spike saw an empty folder read as
 * signed out beside the signed-in default one (docs/research/multiple-accounts.md §8).
 *
 * An added account's children do not inherit what the CLI's documented authentication precedence
 * puts above a folder's login — a cloud selector, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
 * the OAuth token, a profile and the federation variables — nor `ANTHROPIC_BASE_URL`, which would
 * send a folder's login to the endpoint the environment names. With one of them exported, every
 * account would be the same account. The first account inherits as environment.ts says.
 */
export const CLAUDE_INSTANCES: InstanceSupport = {
  variable: 'CLAUDE_CONFIG_DIR',
  defaultFolder: ['.claude'],
  withhold: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], prefixes: ['ANTHROPIC_', 'CLAUDE_CODE_USE_'] },
};

export const CLAUDE_EXECUTABLE_NAMES = ['claude'] as const;

// Repaired PATH covers npm, Homebrew and system installs; these are the native installer's and
// winget's directories for launches that did not inherit a login shell's PATH.
export const CLAUDE_INSTALL_HINTS: readonly InstallDirectoryHint[] = [
  { base: 'home', segments: ['.local', 'bin'] },
  { base: 'local-app-data', segments: ['Microsoft', 'WinGet', 'Links'], platforms: ['win32'] },
  // Only the desktop runtime directory, never its surrounding settings/account data.
  // Layout evidence: docs/research/desktop-cli-discovery.md.
  { base: 'app-data', segments: ['Claude', 'claude-code'], platforms: ['win32'], versions: { children: 'version', suffix: [] } },
  // The MSIX desktop app keeps its data outside the package, one build folder inside each version.
  { base: 'local-app-data', segments: ['Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude-code'], platforms: ['win32'], versions: { children: 'version', nested: 'hash', suffix: [] } },
  { base: 'home', segments: ['Library', 'Application Support', 'Claude', 'claude-code'], platforms: ['darwin'], versions: { children: 'version', suffix: ['claude.app', 'Contents', 'MacOS'] } },
  { base: 'home', segments: ['Library', 'Application Support', 'Claude', 'claude-code'], platforms: ['darwin'], versions: { children: 'version', nested: 'hash', suffix: ['claude.app', 'Contents', 'MacOS'] } },
];
