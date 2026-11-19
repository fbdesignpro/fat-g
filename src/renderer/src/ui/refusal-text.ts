// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the notes say about a stored file fat-g refused (docs/planning/_archive/M12.md, C62), for the three it
// keeps: records, preferences and the conversation store (M18, C33). Each note first says the file is
// unchanged, then names the cause and the remedy that keeps its contents. Preferences keep their own
// status shape; `preferencesCause` maps it onto the four causes.
import { CATALOG_FILE, CATALOG_MAX_BYTES, type OverrideCause, type OverrideStatus } from '@shared/contracts/catalog';
import { CONVERSATIONS_FILE } from '@shared/contracts/conversation';
import { PREFERENCES_VERSION, type PreferencesStatus } from '@shared/contracts/prefs';
import type { RecordsRefusalCause } from '@shared/contracts/projects';

export type RefusalCause = RecordsRefusalCause;
export type StoredFile = 'records' | 'preferences' | 'conversations';

interface Explanation {
  readonly cause: string;
  readonly remedy: string;
}

const EXPLANATIONS: Readonly<Record<StoredFile, Readonly<Record<RefusalCause, Explanation>>>> = {
  records: {
    newer: { cause: 'A newer fat-g saved your projects.', remedy: 'Update fat-g to see them again.' },
    older: { cause: 'An earlier development version of fat-g saved them.', remedy: 'That version still reads them.' },
    unreadable: { cause: 'The file cannot be opened.', remedy: 'Another program may be holding it. Try again.' },
    damaged: { cause: 'The file is damaged.', remedy: 'If you edited it by hand, undo the edit.' },
  },
  preferences: {
    newer: { cause: 'A newer fat-g saved your preferences.', remedy: 'Update fat-g to use them again.' },
    older: { cause: 'An earlier development version of fat-g saved them.', remedy: 'That version still reads them.' },
    unreadable: { cause: 'The file cannot be opened.', remedy: 'Another program may be holding it. Try again.' },
    damaged: { cause: 'The file is damaged.', remedy: 'If you edited it by hand, undo the edit.' },
  },
  // A database, not a file to edit by hand; and nothing reads it again in this run (M18, C36, C39).
  conversations: {
    newer: { cause: 'A newer fat-g saved your chats.', remedy: 'Update fat-g to see them again.' },
    older: { cause: 'An earlier development version of fat-g saved them.', remedy: 'That version still reads them.' },
    unreadable: { cause: 'The file cannot be opened.', remedy: 'Another program may be holding it. Restart fat-g to try again.' },
    damaged: { cause: 'The file is damaged.', remedy: 'fat-g does not try to repair it.' },
  },
};

export const FILE_NAMES: Readonly<Record<StoredFile, string>> = { records: 'records.json', preferences: 'preferences.json', conversations: CONVERSATIONS_FILE };

export function explain(file: StoredFile, cause: RefusalCause): Explanation {
  return EXPLANATIONS[file][cause];
}

/** The first sentence of every note. */
export function unchangedText(file: StoredFile): string {
  switch (file) {
    case 'records': return 'Your projects file is unchanged.';
    case 'preferences': return 'Your preferences file is unchanged, and providers are paused.';
    case 'conversations': return 'Your saved chats are unchanged, and nothing can be sent.';
  }
}

/** Settings' reasons, as the table in Design 3 maps them. */
export function preferencesCause(status: Extract<PreferencesStatus, { kind: 'read-only' }>): RefusalCause {
  switch (status.reason) {
    case 'incompatible':
      return status.fileVersion !== undefined && status.fileVersion < PREFERENCES_VERSION ? 'older' : 'newer';
    case 'unreadable':
      return 'unreadable';
    case 'corrupt':
    case 'migration-failed':
      return 'damaged';
  }
}

/** What Start fresh will do, said before the user confirms it (C66, C64; M18, C33, C40). */
export function startFreshText(file: StoredFile): string {
  const name = FILE_NAMES[file];
  const kept = name.replace(/\.(json|sqlite)$/, '.set-aside.<date and time>.$1');
  switch (file) {
    case 'records':
      return `fat-g will move ${name}, unchanged, to ${kept} in its data folder, and start with no projects.`;
    case 'preferences':
      return `fat-g will move ${name}, unchanged, to ${kept} in its data folder, and use the default preferences. Providers go back to their default switches, all on.`;
    case 'conversations':
      // The store is three files: the two SQLite keeps beside it go with it, under the same name.
      return `fat-g will move ${name}, and the ${name}-wal and ${name}-shm files beside it, unchanged, to ${kept} with the same endings in its data folder, and start with no saved chats. Your sessions stay listed.`;
  }
}

/** Said when the move failed: nothing changed, and the note stays. */
export const COULD_NOT_MOVE = 'fat-g could not move the file. Nothing was changed.';
/** The same for the conversation store, which is moved as a group or not at all (M18, C40). */
export const COULD_NOT_MOVE_STORE = 'fat-g could not move the files. Nothing was changed.';

// ── The catalog override (M13, C41, C57) ────────────────────────────────────────────────────────
// fat-g only reads this file, so it offers nothing to start over from (C45): the note says why it is
// ignored, and the user repairs or deletes it.

const OVERRIDE_CAUSES: Readonly<Record<OverrideCause, string>> = {
  unreadable: 'fat-g cannot open the file. Another program may be holding it.',
  'too-large': `The file is larger than ${CATALOG_MAX_BYTES / 1024} KB.`,
  'not-json': 'The file is not valid JSON. If you edited it by hand, undo the edit.',
  damaged: 'The file has no valid schemaVersion and minReaderVersion.',
  newer: 'A newer fat-g wrote this file. Update fat-g to use it.',
  older: 'An earlier development version of fat-g wrote this file.',
  invalid: 'A value is not what fat-g expects.',
};

/** Why the override is ignored, in plain words, with the field at fault when there is one. */
export function overrideCause(cause: OverrideCause, field: string | null): string {
  return cause === 'invalid' && field !== null ? `A value is not what fat-g expects, at ${field}.` : OVERRIDE_CAUSES[cause];
}

/** Settings' note: the override's state, above the providers (C85). The path follows it on a line of its own. */
export function overrideText(status: OverrideStatus): string {
  switch (status.kind) {
    case 'none':
      return `No ${CATALOG_FILE}: a file at this path can rename, hide, show or add models.`;
    case 'applied': {
      const unknown = status.unknownProviders.length === 0 ? '' : ` It skips providers this build does not have: ${status.unknownProviders.join(', ')}.`;
      return `Your ${CATALOG_FILE} is applied: ${status.changed} changed, ${status.added} added, ${status.hidden} hidden.${unknown}`;
    }
    case 'ignored':
      return `Your ${CATALOG_FILE} is ignored: nothing in it applies. ${overrideCause(status.cause, status.field)}`;
  }
}
