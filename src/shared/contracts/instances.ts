// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Provider instances (docs/planning/_archive/M14b.md): a provider runs as one or more instances, each the
// same CLI started with its own configuration folder and so its own login. The user sees an
// instance as an account. Renderer-safe: what names an instance, and how many a provider may have.
// A folder is never part of an instance's name, and no variable is named here: each module declares
// its own (shared/provider-kit/provider.ts).
import { z } from 'zod';
import { normalizeText } from './names';
import { SETUP_ACTIONS } from './permissions';
import { MAX_PATH, type RootRelation } from './projects';
import type { ProviderId } from './provider';

/**
 * The first instance's id (C4, C6). Every provider has this instance: it sets nothing, so it runs
 * exactly as the provider does without instances, in the folder the user's own environment names.
 */
export const FIRST_INSTANCE_ID = 'default';

/** How many instances a provider may have, the first included (C10). */
export const MAX_INSTANCES = 8;

/** The first instance's id, or the UUID main made for an added one. Never shown, never reused (C6). */
export type InstanceId = string;

/** An instance is always named by the pair: an instance id alone says nothing (C6). */
export interface InstanceRef {
  readonly providerId: ProviderId;
  readonly instanceId: InstanceId;
}

// Any 8-4-4-4-12 hexadecimal UUID, as the records file accepts (src/main/records/format.ts): a
// hand-edited id need not carry RFC 4122's version bits.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An added instance's id: a UUID, which the first instance's fixed word can never be. */
export function isAddedInstanceId(value: unknown): value is InstanceId {
  return typeof value === 'string' && UUID.test(value);
}

export function isInstanceId(value: unknown): value is InstanceId {
  return value === FIRST_INSTANCE_ID || isAddedInstanceId(value);
}

/**
 * Two references to one instance. The provider's id compares exactly; an added instance's id
 * ignores letter case, as two spellings of one UUID are one id.
 */
export function sameInstance(a: InstanceRef, b: InstanceRef): boolean {
  return a.providerId === b.providerId && a.instanceId.toLowerCase() === b.instanceId.toLowerCase();
}

/** Each provider's first instance, in order: what a list of providers shows, one row a provider. */
export function firstInstances<T extends { readonly instanceId: InstanceId }>(snapshots: readonly T[]): T[] {
  return snapshots.filter((snapshot) => snapshot.instanceId === FIRST_INSTANCE_ID);
}

/** A key for a list of instances: two snapshots of one provider differ by it. */
export function instanceKey(snapshot: { readonly id: ProviderId; readonly instanceId: InstanceId }): string {
  return `${snapshot.id}:${snapshot.instanceId}`;
}

// ── How an account is named (C40, C41, C47) ────────────────────────────────────────────────────

/**
 * The label an instance is shown by, or null. Only a provider with more than one instance configured
 * names its accounts: with one, which is nearly every user, nothing is added anywhere. An entry with
 * no label to show has none either.
 */
export function shownLabel(snapshots: readonly { readonly id: ProviderId; readonly instanceId: InstanceId; readonly label?: string }[], ref: InstanceRef): string | null {
  const own = snapshots.filter((snapshot) => snapshot.id === ref.providerId);
  if (own.length < 2) return null;
  const label = own.find((snapshot) => sameInstance({ providerId: snapshot.id, instanceId: snapshot.instanceId }, ref))?.label ?? '';
  return label === '' ? null : label;
}

/** A provider's name, then its account's label when one shows: what names a usage block and heads its panel. */
export function accountName(displayName: string, label: string | null): string {
  return label === null ? displayName : `${displayName} · ${label}`;
}

// ── The same account twice (C11, C68) ──────────────────────────────────────────────────────────

/** What the rule reads of a snapshot: nothing of it is stored. */
interface AccountSide {
  readonly id: ProviderId;
  readonly instanceId: InstanceId;
  readonly account: { readonly email?: string | undefined; readonly organization?: string | undefined } | null;
}

/**
 * The earlier instance of the same provider that reports the same account as `snapshot`, or null:
 * both report an email, the two match ignoring case, and their organizations match or neither reports
 * one. The plan is not compared. `snapshots` are in the app state's order.
 */
export function sameAccountAs<T extends AccountSide>(snapshots: readonly T[], snapshot: AccountSide): T | null {
  const email = snapshot.account?.email;
  if (email === undefined || email === '') return null;
  for (const other of snapshots) {
    if (other.id === snapshot.id && other.instanceId === snapshot.instanceId) return null;
    if (other.id !== snapshot.id) continue;
    const theirs = other.account?.email;
    if (theirs === undefined || theirs.toLowerCase() !== email.toLowerCase()) continue;
    if ((other.account?.organization ?? null) === (snapshot.account?.organization ?? null)) return other;
  }
  return null;
}

// ── Labels (C13) ──────────────────────────────────────────────────────────────────────────────

/** The longest label, in grapheme clusters. */
export const INSTANCE_LABEL_MAX = 24;

/** What a first instance without a label is shown as. */
export const DEFAULT_INSTANCE_LABEL = 'Default';

/** A label as it is stored and shown: cleaned as a name is, at 24 grapheme clusters. Empty means none. */
export function cleanInstanceLabel(value: string): string {
  return normalizeText(value, INSTANCE_LABEL_MAX);
}

/** A first instance's label as it is shown: its own, or "Default". */
export function shownFirstLabel(label: string | null): string {
  return label ?? DEFAULT_INSTANCE_LABEL;
}

/** Two labels a reader could not tell apart: the same once letter case is ignored. */
export function sameLabel(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

// ── The login command (C36) ─────────────────────────────────────────────────────────────────────

/** The shell a login command is written for: PowerShell on Windows, POSIX elsewhere. */
export type LoginShell = 'powershell' | 'posix';

export function loginShell(platform: string): LoginShell {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * The CLI's login command with a variable set to an account's folder, for the user to run in their
 * own terminal: fat-g runs no login (decision 0004). The path is quoted so the shell takes it
 * literally, whatever it holds.
 *
 * - PowerShell: `$env:NAME = '<folder>'; <command>`. Inside single quotes only `'` is special, and it is doubled.
 * - POSIX: `NAME='<folder>' <command>`. Inside single quotes nothing is special, so a `'` ends them,
 *   is written escaped, and begins them again: `'\''`.
 */
export function loginCommand(shell: LoginShell, variable: string, folder: string, command: string): string {
  if (shell === 'powershell') return `$env:${variable} = '${folder.replaceAll("'", "''")}'; ${command}`;
  return `${variable}='${folder.replaceAll("'", "'\\''")}' ${command}`;
}

/**
 * The login command run by the CLI file's full path, for a CLI the shell would not find by name (a
 * manual override, a desktop app's runtime folder): its first word, the CLI's name, is replaced by the
 * quoted path. PowerShell runs a quoted path through its call operator, `&`.
 */
export function loginCommandAt(shell: LoginShell, file: string, command: string): string {
  const space = command.indexOf(' ');
  const rest = space < 0 ? '' : command.slice(space);
  if (shell === 'powershell') return `& '${file.replaceAll("'", "''")}'${rest}`;
  return `'${file.replaceAll("'", "'\\''")}'${rest}`;
}

// ── What the preferences hold of a provider's instances (C12, C16, C66) ─────────────────────────

/**
 * Why a stored instance cannot be used. The entry keeps its place and its value in the file, the
 * other instances run, and Settings says which of these it is.
 */
export const INSTANCE_ISSUES = [
  /** Not an object. */
  'invalid-entry',
  /** Its id is not a UUID. */
  'invalid-id',
  /** An earlier entry of the provider has its id. */
  'duplicate-id',
  /** Its label is missing, not a string, or empty once cleaned. */
  'invalid-label',
  /** An earlier instance of the provider has its label, the first instance's shown label included. */
  'label-taken',
  /** Its folder is missing or not an absolute path. */
  'invalid-folder',
  /** Its switch is not a boolean. */
  'invalid-enabled',
  /** It stands past the cap. */
  'over-limit',
] as const;
export type InstanceIssue = (typeof INSTANCE_ISSUES)[number];

/** An added instance as the preferences hold it, usable or not. Main window only: it carries a folder. */
export interface InstanceEntry {
  /**
   * What names the entry in a request: its id when it has a usable one, else a key made for this
   * run and never written, as an unreadable project has (M12, C6).
   */
  readonly key: string;
  /** Null when the stored id is not a UUID, or an earlier entry has it. */
  readonly id: InstanceId | null;
  /** Cleaned; null when the entry has none that can be shown. */
  readonly label: string | null;
  /** As stored; null when it is not an absolute path. Never in the app state, so never in the Pet (C19). */
  readonly folder: string | null;
  readonly enabled: boolean;
  readonly issue: InstanceIssue | null;
}

export interface ProviderInstances {
  /** The first instance's label, cleaned; null when it has none and shows as "Default". */
  readonly firstLabel: string | null;
  /** The added instances in stored order, unusable ones included. */
  readonly added: readonly InstanceEntry[];
}

export const NO_INSTANCES: ProviderInstances = Object.freeze({ firstLabel: null, added: Object.freeze([]) });

/** Whether `label` is one a reader would take for another instance of the provider: any but `except`. */
export function labelTaken(instances: ProviderInstances, label: string, except: { readonly first?: boolean; readonly key?: string } = {}): boolean {
  if (except.first !== true && sameLabel(shownFirstLabel(instances.firstLabel), label)) return true;
  return instances.added.some((entry) => entry.key !== except.key && entry.label !== null && sameLabel(entry.label, label));
}

// ── An account's folder (C15, C37, C59) ─────────────────────────────────────────────────────────

/**
 * Why a folder cannot be an account's, in the order the rules are checked. Each is judged on the
 * real paths the OS reports, as two roots are (M12, C78).
 */
export const FOLDER_RULES = [
  /** It is another added instance's folder of that provider. */
  'other-instance',
  /** It is the provider's default folder, which is the first instance's unless a variable moves it. */
  'default-folder',
  /** It is the folder the inherited variable names: the first instance's, in this launch. */
  'inherited-folder',
  /** It is a project's root, or inside or around one: the login would sit among the files an agent reads. */
  'project',
  /** It is fat-g's data folder, or inside or around it. */
  'data-folder',
] as const;
export type FolderRule = (typeof FOLDER_RULES)[number];

/** The rule a folder fails, and what it collides with, by id and never by path. */
export type FolderRefusal =
  | { readonly rule: 'other-instance'; readonly key: string }
  | { readonly rule: 'default-folder' }
  | { readonly rule: 'inherited-folder' }
  | { readonly rule: 'project'; readonly projectId: string; readonly relation: RootRelation }
  | { readonly rule: 'data-folder'; readonly relation: RootRelation };

// ── Requests (C14, C15, C21, C23) ───────────────────────────────────────────────────────────────

const providerId = z.string().min(1).max(128);

/** An instance as a request names it: the first one's fixed word, an added one's id, or an unusable entry's run key. */
export const InstanceRefSchema = z.strictObject({ providerId, instanceId: z.string().refine(isInstanceId) });

/** Opens main's folder picker for a new account of this provider. It stores and starts nothing. */
export const InstancePickFolderRequestSchema = z.strictObject({ providerId });
export type InstancePickFolderRequest = z.infer<typeof InstancePickFolderRequestSchema>;

export type InstancePickFolderResult =
  /** The folder as it would be stored, and the rule it fails when it fails one (C15). */
  | { readonly status: 'picked'; readonly path: string; readonly refusal: FolderRefusal | null }
  | { readonly status: 'cancelled' }
  | { readonly status: 'refused'; readonly reason: 'busy' | 'preferences-blocked' | 'unsupported-path' | 'not-supported' };

/** A label, and a folder main's own picker returned in this run (C14). */
export const InstanceAddRequestSchema = z.strictObject({ providerId, label: z.string().max(256), folder: z.string().min(1).max(MAX_PATH) });
export type InstanceAddRequest = z.infer<typeof InstanceAddRequestSchema>;

export type InstanceAddResult =
  | { readonly status: 'saved'; readonly id: InstanceId }
  | { readonly status: 'refused'; readonly reason: 'preferences-blocked' | 'not-supported' | 'limit' | 'label-empty' | 'label-taken' | 'folder-not-picked' }
  | { readonly status: 'refused'; readonly reason: 'folder-refused'; readonly refusal: FolderRefusal };

/**
 * Opens the user's own terminal with an account's login command in it (C80). The request names the
 * account and nothing else: main builds the command, from the provider's own and the account's folder.
 */
export type InstanceLoginTerminalResult =
  | { readonly status: 'opened' }
  /** `no-terminal`: none could be started, so the command is copied and run by hand, as before. */
  | { readonly status: 'refused'; readonly reason: 'unknown-instance' | 'unavailable' | 'no-terminal' };

/**
 * The CLI's own sandbox setup for one account (M22, C60, C72, C88): `start` at the user's press,
 * and `stop-waiting` to let go of one whose completion has not come. The request names the account
 * and the action and nothing else: main sends the CLI's one request, and never a second without a
 * new press.
 */
export const InstanceSetupSandboxRequestSchema = z.strictObject({ providerId, instanceId: z.string().refine(isInstanceId), action: z.enum(SETUP_ACTIONS) });
export type InstanceSetupSandboxRequest = z.infer<typeof InstanceSetupSandboxRequestSchema>;

export type InstanceSetupSandboxResult =
  | { readonly status: 'started' }
  | { readonly status: 'stopping' }
  /**
   * `no-setup`: the provider has none on this system, or none is under way to stop. `running`: one
   * is under way already. `busy`: a turn or an aside of the account runs (C62).
   */
  | { readonly status: 'refused'; readonly reason: 'unknown-instance' | 'no-setup' | 'running' | 'busy' };

/** An added instance by its key: its id, or an unusable entry's run key (C66). */
export const InstanceRemoveRequestSchema = z.strictObject({ providerId, key: z.guid() });
export type InstanceRemoveRequest = z.infer<typeof InstanceRemoveRequestSchema>;

export type InstanceRemoveResult =
  | { readonly status: 'removed' }
  /** `cleanup-failed`: its runtime's end could not be confirmed, so its entry stays (C69). */
  | { readonly status: 'refused'; readonly reason: 'unknown-instance' | 'first-instance' | 'session-running' | 'cleanup-failed' | 'preferences-blocked' };
