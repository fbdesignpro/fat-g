// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words about an account (M14b, C13, C15, C16, C23, C33, C37, C59): why a stored one cannot
// be used, why a folder cannot be an account's, and why adding or removing one was refused. A folder
// is named only where the user picked it; what it collides with is named by its label or its
// project's name, never by a path.
import {
  type FolderRefusal,
  type FolderRule,
  type InstanceAddResult,
  type InstanceIssue,
  type InstancePickFolderResult,
  type InstanceRemoveResult,
  MAX_INSTANCES,
} from '@shared/contracts/instances';
import type { RootRelation } from '@shared/contracts/projects';
import type { ProviderActionResult } from '@shared/contracts/provider';

export const LABEL_EMPTY = 'Enter a name for this account.';
export const LABEL_TAKEN = 'Another account of this provider has that name.';
export const LIMIT_TEXT = `A provider can have ${MAX_INSTANCES} accounts.`;
export const FOLDER_NEEDED = 'Choose a folder for this account.';

/** What an account's folder is, said where one is chosen. */
export const FOLDER_HELP = 'Choose an empty folder dedicated to this account. The CLI will store its sign-in information, settings and chat history here. fat-g remembers the folder’s location but never reads its contents.';

/** Why a stored account cannot be used (C16, C66). Removing it is the remedy for each. */
export function instanceIssueText(issue: InstanceIssue): string {
  switch (issue) {
    case 'invalid-entry': return 'This saved account is not a readable entry.';
    case 'invalid-id': return 'This saved account has no usable id.';
    case 'duplicate-id': return 'An earlier account has this saved account’s id.';
    case 'invalid-label': return 'This saved account has no name.';
    case 'label-taken': return 'An earlier account has this saved account’s name.';
    case 'invalid-folder': return 'This saved account’s folder is not an absolute path.';
    case 'invalid-enabled': return 'This saved account’s switch is neither on nor off.';
    case 'over-limit': return `This saved account is past the limit: ${LIMIT_TEXT.toLowerCase()}`;
  }
}

const RELATION: Readonly<Record<RootRelation, string>> = { same: 'is', inside: 'is inside', around: 'is around' };

/** Why a folder cannot be an account's, as a rule alone: what a blocked account's status carries (C59). */
export function folderRuleText(rule: FolderRule): string {
  switch (rule) {
    case 'other-instance': return 'This folder is another account’s.';
    case 'default-folder': return 'This folder is the CLI’s own default folder, which is the first account’s.';
    case 'inherited-folder': return 'This folder is the one fat-g’s environment names, which is the first account’s.';
    case 'project': return 'This folder is a project’s folder, or is inside or around one.';
    case 'data-folder': return 'This folder is fat-g’s data folder, or is inside or around it.';
  }
}

export interface RefusalNames {
  /** A project's name, by id; null when it is not in the list. */
  readonly project: (id: string) => string | null;
  /** An account's label, by its key; null when it has none to show. */
  readonly account: (key: string) => string | null;
}

/** Why a picked folder cannot be an account's, with what it collides with by name (C15, C33). */
export function folderRefusalText(refusal: FolderRefusal, names: RefusalNames): string {
  switch (refusal.rule) {
    case 'other-instance': {
      const label = names.account(refusal.key);
      return label === null ? 'This folder is another account’s.' : `This folder is the account “${label}”’s.`;
    }
    case 'project': {
      const name = names.project(refusal.projectId);
      const relation = RELATION[refusal.relation];
      return `This folder ${relation} ${name === null ? 'a project’s folder' : `a folder of the project “${name}”`}. An account’s login must not sit among the files an agent reads.`;
    }
    case 'data-folder':
      return `This folder ${RELATION[refusal.relation]} fat-g’s data folder.`;
    case 'default-folder':
    case 'inherited-folder':
      return folderRuleText(refusal.rule);
  }
}

type Refused<T> = Extract<T, { status: 'refused' }>;

/** Why the folder picker could not be opened, or what it returned could not be used. */
export function pickRefusalText(reason: Refused<InstancePickFolderResult>['reason']): string {
  switch (reason) {
    case 'busy': return 'A folder picker is already open.';
    case 'preferences-blocked': return 'Your preferences cannot be saved right now, so no account can be added.';
    case 'unsupported-path': return 'That folder’s path cannot be used. Choose a folder on a local drive.';
    case 'not-supported': return 'This provider runs as one account.';
  }
}

/** Where an add's refusal is said: beside the name, beside the folder, or under the row. */
export function addRefusal(answer: Refused<InstanceAddResult>, names: RefusalNames): { readonly field: 'label' | 'folder' | 'row'; readonly text: string } {
  switch (answer.reason) {
    case 'label-empty': return { field: 'label', text: LABEL_EMPTY };
    case 'label-taken': return { field: 'label', text: LABEL_TAKEN };
    case 'folder-not-picked': return { field: 'folder', text: 'Choose the folder again: fat-g takes only a folder its own picker returned.' };
    case 'folder-refused': return { field: 'folder', text: folderRefusalText(answer.refusal, names) };
    case 'limit': return { field: 'row', text: LIMIT_TEXT };
    case 'preferences-blocked': return { field: 'row', text: 'Your preferences cannot be saved right now, so the account was not added.' };
    case 'not-supported': return { field: 'row', text: 'This provider runs as one account.' };
  }
}

export const SESSION_RUNNING_TEXT = 'A session of this account is running. Wait for it to finish, then remove the account.';

/**
 * Why Settings did not do it (M15, C18): the action would end the CLI process of a session that is
 * running, in a turn or on its workers alone.
 */
export function runningRefusalText(action: 'provider-switch' | 'provider-executable' | 'instance-switch' | 'redetect'): string {
  switch (action) {
    case 'provider-switch': return 'A session of this provider is running. Wait for it to finish, then switch the provider off.';
    case 'provider-executable': return 'A session of this provider is running. Wait for it to finish, then change its executable.';
    case 'instance-switch': return 'A session of this account is running. Wait for it to finish, then switch the account off.';
    case 'redetect': return 'A session of this account is running. Wait for it to finish, then redetect.';
  }
}

/** What a Redetect refused for says; `preferences-blocked` alone names the preferences. */
export function redetectRefusalText(reason: Refused<ProviderActionResult>['reason']): string {
  switch (reason) {
    case 'session-running': return runningRefusalText('redetect');
    case 'preferences-blocked': return 'Detection is unavailable until these preferences are repaired.';
    case 'disabled': return 'This account is switched off. Switch it on to detect its CLI.';
    case 'not-ready': return 'Detection is not ready yet. Try again in a moment.';
  }
}

export function removeRefusalText(reason: Refused<InstanceRemoveResult>['reason']): string {
  switch (reason) {
    case 'session-running': return SESSION_RUNNING_TEXT;
    case 'cleanup-failed': return 'fat-g could not confirm that this account’s CLI process has ended, so the account was kept. Use Redetect / reconnect, then remove it again.';
    case 'preferences-blocked': return 'Your preferences cannot be saved right now, so the account was kept.';
    case 'unknown-instance': return 'This account is no longer in your preferences.';
    case 'first-instance': return 'A provider’s first account cannot be removed.';
  }
}

/** "3 sessions", "1 session", "no sessions". */
export function sessionCount(count: number): string {
  return count === 0 ? 'no sessions' : count === 1 ? '1 session' : `${count} sessions`;
}
