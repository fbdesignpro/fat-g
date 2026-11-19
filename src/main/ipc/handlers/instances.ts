// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The account channels (docs/planning/_archive/M14b.md, Design 7; C14, C15, C21, C23, C69). Picking a folder and
// saving an account are two steps, as for a project's root, so Cancel after a pick leaves nothing
// stored and nothing started. What Save checks, in this order and before any lookup: the provider's
// module declares instances, the preferences can be written, the cap, the label, and that main's own
// picker returned this folder in this run. Then the folder's rules, again. Then it is stored, which
// starts it.
//
// Signing in stays the CLI's (decision 0004). `instances:openLoginTerminal` (round 6, C80) opens the
// user's own terminal with the command the row shows already in it. The page names the account and
// nothing else: main builds the command, and reads nothing from the terminal.
//
// `instances:setupSandbox` (docs/planning/_archive/M22.md, Design 7, 9; C60, C62, C72, C88) asks an account's
// CLI to set up its own sandbox, at the user's press alone: the page names the account and whether
// to start or to stop waiting, and the provider's module sends its CLI's one request. Nothing of a
// setup is logged but the kind of what was asked and answered.
import { cleanInstanceLabel, FIRST_INSTANCE_ID, labelTaken, loginCommand, loginCommandAt, loginShell, MAX_INSTANCES, NO_INSTANCES, type InstanceRef, type InstanceSetupSandboxResult } from '@shared/contracts/instances';
import type { InstanceGuard } from '../../instances/admission';
import type { PreferencesStore } from '../../prefs/store';
import { normalizeRoot } from '../../records/paths';
import type { SandboxFacet } from '@shared/provider-kit/sessions';
import type { ProviderRegistry } from '../../services/provider-registry';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';
import { createKindCounts, type KindCounts } from './counts';

export interface InstanceHandlerDeps {
  readonly prefs: PreferencesStore;
  readonly registry: Pick<ProviderRegistry, 'has' | 'hasInstance' | 'end'>;
  /** Whether the provider's module declares instances (C5). */
  readonly supports: (providerId: string) => boolean;
  readonly guard: Pick<InstanceGuard, 'checkPicked'>;
  /** The OS folder picker — or, in a smoke build, its stand-in. Null when cancelled. */
  readonly pickFolder: (providerId: string) => Promise<string | null>;
  /** Whether a session of this instance is in a turn, or waiting on its workers (C23). */
  readonly sessionRunning: (ref: InstanceRef) => boolean;
  /**
   * What signs a provider's account in: its CLI's own login command, and the variable that names an
   * added account's folder, when its module declares one. Undefined for a provider this build lacks.
   */
  readonly loginOf: (providerId: string) => { readonly command: string; readonly variable: string | null } | undefined;
  /** The CLI file an account's runtime found off PATH, or null (`ProviderRegistry.executableOffPath`). */
  readonly executableOffPath?: (ref: InstanceRef) => string | null;
  /**
   * Opens the user's terminal with this command, saying `note` first; false when none could be
   * opened. A smoke build answers from a stand-in and opens nothing.
   */
  readonly openTerminal: (providerId: string, command: string, note: string) => Promise<boolean>;
  /**
   * An account's sandbox setup (M22, C60), or undefined where its provider has none on this system
   * or the account has no runtime. Without it no setup is ever asked.
   */
  readonly sandbox?: (ref: InstanceRef) => SandboxFacet | undefined;
  /**
   * Whether a turn or an aside of this account runs on a process of its own (M22, C62): no setup
   * starts while one does. Without it `sessionRunning` is asked.
   */
  readonly accountBusy?: (ref: InstanceRef) => boolean;
  /** What main says of a setup (M22, C26): what was asked and what was answered, by kind. */
  readonly setups?: KindCounts;
  readonly platform?: string;
}

/** What the terminal says before the command runs. */
export const LOGIN_TERMINAL_NOTE = 'fat-g opened this window so you can sign in. It reads nothing from it; close it when you are done.';

type Channels = 'instances:pickFolder' | 'instances:add' | 'instances:remove' | 'instances:openLoginTerminal' | 'instances:setupSandbox';

export function instanceHandlers(deps: InstanceHandlerDeps): Pick<InvokeHandlers, Channels> {
  const platform = deps.platform ?? process.platform;
  const setups = deps.setups ?? createKindCounts();
  /**
   * The folders this picker returned in this run, normalized. Memory only, and a set of its own: a
   * folder picked for a project is not thereby an account's (C14).
   */
  const picked = new Set<string>();
  let pickerOpen = false;

  const known = (providerId: string): void => {
    if (!deps.registry.has(providerId)) throw new InvalidIpcRequest();
  };

  return {
    async 'instances:pickFolder'({ providerId }) {
      known(providerId);
      if (!deps.supports(providerId)) return { status: 'refused', reason: 'not-supported' };
      if (!deps.prefs.isWritable()) return { status: 'refused', reason: 'preferences-blocked' };
      if (pickerOpen) return { status: 'refused', reason: 'busy' };
      pickerOpen = true;
      let selected: string | null;
      try {
        selected = await deps.pickFolder(providerId);
      } finally {
        pickerOpen = false;
      }
      if (selected === null) return { status: 'cancelled' };
      const path = normalizeRoot(selected, platform);
      if (path === null) return { status: 'refused', reason: 'unsupported-path' };
      picked.add(path);
      // Said as soon as the folder is picked; Save checks again.
      return { status: 'picked', path, refusal: await deps.guard.checkPicked(providerId, path) };
    },

    async 'instances:add'({ providerId, label, folder }) {
      known(providerId);
      if (!deps.supports(providerId)) return { status: 'refused', reason: 'not-supported' };
      if (!deps.prefs.isWritable()) return { status: 'refused', reason: 'preferences-blocked' };
      const held = deps.prefs.getSnapshot().instances[providerId] ?? NO_INSTANCES;
      if (held.added.length >= MAX_INSTANCES - 1) return { status: 'refused', reason: 'limit' };
      const cleaned = cleanInstanceLabel(label);
      if (cleaned === '') return { status: 'refused', reason: 'label-empty' };
      if (labelTaken(held, cleaned)) return { status: 'refused', reason: 'label-taken' };
      // Before any lookup: a path the page made up never reaches the file system (C14).
      if (!picked.has(folder)) return { status: 'refused', reason: 'folder-not-picked' };
      const refusal = await deps.guard.checkPicked(providerId, folder);
      if (refusal !== null) return { status: 'refused', reason: 'folder-refused', refusal };
      // The store checks the cap, the label and the path again: something may have changed while the rules were read.
      const saved = deps.prefs.addInstance(providerId, { label: cleaned, folder });
      if (saved.status === 'saved') return saved;
      switch (saved.reason) {
        case 'limit':
        case 'label-empty':
        case 'label-taken':
        case 'preferences-blocked':
          return { status: 'refused', reason: saved.reason };
        case 'folder-invalid':
          return { status: 'refused', reason: 'folder-not-picked' };
        case 'unknown-provider':
          throw new InvalidIpcRequest();
      }
    },

    async 'instances:remove'({ providerId, key }) {
      known(providerId);
      if (!deps.prefs.isWritable()) return { status: 'refused', reason: 'preferences-blocked' };
      if (key === FIRST_INSTANCE_ID) return { status: 'refused', reason: 'first-instance' };
      const entry = (deps.prefs.getSnapshot().instances[providerId] ?? NO_INSTANCES).added.find((candidate) => candidate.key.toLowerCase() === key.toLowerCase());
      if (entry === undefined) return { status: 'refused', reason: 'unknown-instance' };
      const ref: InstanceRef = { providerId, instanceId: entry.key };
      if (deps.sessionRunning(ref)) return { status: 'refused', reason: 'session-running' };
      // Its runtime ends first, and its entry goes only once the process tree is confirmed gone:
      // deleting the entry first would leave a scope that may still hold a process, under no entry
      // that could show it (C69). Nothing in its folder is touched.
      if (deps.registry.hasInstance(ref) && !(await deps.registry.end(ref)).confirmed) return { status: 'refused', reason: 'cleanup-failed' };
      const removed = deps.prefs.removeInstance(providerId, entry.key);
      if (removed.status === 'removed') return removed;
      switch (removed.reason) {
        case 'first-instance':
        case 'unknown-instance':
        case 'preferences-blocked':
          return { status: 'refused', reason: removed.reason };
        case 'unknown-provider':
          throw new InvalidIpcRequest();
      }
    },

    async 'instances:openLoginTerminal'(ref) {
      known(ref.providerId);
      const login = deps.loginOf(ref.providerId);
      if (login === undefined) throw new InvalidIpcRequest();
      const admission = deps.prefs.getInstanceAdmission(ref);
      if (admission.kind === 'blocked') return { status: 'refused', reason: admission.reason === 'not-configured' ? 'unknown-instance' : 'unavailable' };
      // The command its row shows (C36): the first account's is the CLI's own, and an added one's
      // sets the variable to its folder first. Nothing of it comes from the page. A CLI found off
      // PATH is run by its full path, which the row does not show: a terminal would not find its name.
      const offPath = deps.executableOffPath?.(ref) ?? null;
      let command = offPath === null ? login.command : loginCommandAt(loginShell(platform), offPath, login.command);
      if (ref.instanceId !== FIRST_INSTANCE_ID) {
        if (login.variable === null || admission.folder === null) return { status: 'refused', reason: 'unavailable' };
        command = loginCommand(loginShell(platform), login.variable, admission.folder, command);
      }
      return (await deps.openTerminal(ref.providerId, command, LOGIN_TERMINAL_NOTE)) ? { status: 'opened' } : { status: 'refused', reason: 'no-terminal' };
    },

    'instances:setupSandbox'({ providerId, instanceId, action }) {
      known(providerId);
      const ref: InstanceRef = { providerId, instanceId };
      const answer = ((): InstanceSetupSandboxResult => {
        if (deps.prefs.getInstanceAdmission(ref).kind === 'blocked') return { status: 'refused', reason: 'unknown-instance' };
        const sandbox = deps.sandbox?.(ref);
        if (sandbox === undefined) return { status: 'refused', reason: 'no-setup' };
        // It holds its account, and none starts while a turn or an aside of that account runs (C62).
        if (action === 'start' && (deps.accountBusy ?? deps.sessionRunning)(ref)) return { status: 'refused', reason: 'busy' };
        const did = sandbox.act(action);
        return did === 'started' || did === 'stopping' ? { status: did } : { status: 'refused', reason: did };
      })();
      setups.add(`${action}:${'reason' in answer ? `refused:${answer.reason}` : answer.status}`);
      return answer;
    },
  };
}
