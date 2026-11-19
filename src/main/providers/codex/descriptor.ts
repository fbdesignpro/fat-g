// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { InstallDirectoryHint, InstanceSupport } from '@shared/provider-kit/provider';
import { CODEX_PERMISSIONS, CODEX_PLANS } from './modes';
import { CODEX_EXECUTABLE_HELP } from './executable-help';

export const CODEX_DESCRIPTOR: ProviderDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  installGuidance: 'Install the Codex CLI, then sign in from your own terminal.',
  executableHelp: CODEX_EXECUTABLE_HELP,
  loginCommand: 'codex login',
  minPollIntervalSec: 60,
  // Models from `model/list` over the connection it already holds (M13, C29). Sessions through its
  // facet, each on an app-server of its own (M15; decision 0018), and their earlier conversation
  // read back over that same connection (M18, C25). What a session may do is one of five modes, in
  // fat-g's names (M22, C39, C63; decision 0027): Read only, which is what every session was before
  // there were modes, Ask first, Sandbox ok, Auto reviewed and Berserk, declared in modes.ts with
  // Codex's own words for each. An account may need Codex's own sandbox setup before two of them.
  capabilities: { account: true, usage: 'poll+push', sessions: true, history: true, otherFolders: false, models: true, asides: { followUp: true, streamed: true, tools: 'read-only' }, questions: 'both', declines: true, permissions: CODEX_PERMISSIONS, titles: true, plans: CODEX_PLANS, context: true },
  // Its look — an original mark, not OpenAI's logo (M11, C55): a rounded tile with a prompt, >_,
  // cut out — is in catalog-defaults.json (M13, C21). Its status-bar stream there is Claude's palette
  // at hue 204°, saturation untouched: the ground rotated alone, since it is a plain background, and
  // the six tones taken to half their lightness, since they are composited with plus-lighter and a
  // blue's luminance sits in the green channel, which has the headroom to clip a straight rotation's
  // overlaps to near-white cyan. The half was settled by eye against the real compositor — a turn's
  // bar beside Claude's — not by the arithmetic, which had put it too bright at three quarters.
};

/** Settings' Installation guide (M13, C25). */
export const CODEX_INSTALLATION_GUIDE = 'https://developers.openai.com/codex/cli';

/**
 * Several accounts (M14b, C5, C9). Codex keeps its login, configuration and sessions under
 * `CODEX_HOME`, `~/.codex` by default; M14b's spike saw two homes report two accounts at once
 * (docs/research/multiple-accounts.md §8). Codex does not start with a home that does not exist.
 *
 * An added account's children do not inherit, from Codex's environment variables page as read on
 * `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN`, each a credential the CLI reads directly;
 * the workload identity variables, which all start with `OPENAI_`; and `CODEX_SQLITE_HOME`, which
 * moves part of a home's state out of it, so two accounts would share it (C74). The `OPENAI_`
 * prefix also takes `OPENAI_API_KEY`, the name the documentation uses for a key. A certificate
 * bundle (`CODEX_CA_CERTIFICATE`, `SSL_CERT_FILE`) passes. The first account inherits everything.
 */
export const CODEX_INSTANCES: InstanceSupport = {
  variable: 'CODEX_HOME',
  defaultFolder: ['.codex'],
  withhold: { names: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME'], prefixes: ['OPENAI_'] },
};

export const CODEX_EXECUTABLE_NAMES = ['codex'] as const;

export const CODEX_INSTALL_HINTS: readonly InstallDirectoryHint[] = [
  { base: 'home', segments: ['.local', 'bin'] },
  { base: 'app-data', segments: ['npm'], platforms: ['win32'] },
  // Desktop runtime layouts: docs/research/desktop-cli-discovery.md. Never search account data.
  { base: 'local-app-data', segments: ['OpenAI', 'Codex', 'bin'], platforms: ['win32'], versions: { children: 'hash', suffix: [], includeRoot: true } },
  { base: 'applications', segments: ['Codex.app', 'Contents', 'Resources'], platforms: ['darwin'] },
  { base: 'home', segments: ['Applications', 'Codex.app', 'Contents', 'Resources'], platforms: ['darwin'] },
  { base: 'applications', segments: ['ChatGPT.app', 'Contents', 'Resources'], platforms: ['darwin'] },
  { base: 'home', segments: ['Applications', 'ChatGPT.app', 'Contents', 'Resources'], platforms: ['darwin'] },
  // ChatGPT launches its shipped CLI from here. Finder launches of fat-g do not inherit that PATH.
  { base: 'mac-applications', segments: ['ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS'] },
];
