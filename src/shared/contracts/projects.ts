// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Projects: fat-g's own records of the folders a user works in (docs/planning/_archive/M12.md, decision 0011).
// Main keeps the file (src/main/records); the Main window sees only the view below, inside the app
// state, and changes records only through the channels whose request schemas are here. The Pet
// sees none of it: root paths hold the user's name.
import { z } from 'zod';
import { ModeIdSchema } from './permissions';

// ── Colours (C18, C19) ────────────────────────────────────────────────────────────────────────

/** The fixed set, in the order proposals take them. The file stores the id, never a colour value. */
export const PROJECT_COLORS = ['red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'grey'] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

/** What each colour is called on its radio button: the name tells them apart, not the colour. */
export const PROJECT_COLOR_NAMES: Readonly<Record<ProjectColor, string>> = {
  red: 'Red',
  orange: 'Orange',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  grey: 'Grey',
};

/** Shown for a colour this build does not know (C12). */
export const UNKNOWN_COLOR_FALLBACK: ProjectColor = 'grey';

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && (PROJECT_COLORS as readonly string[]).includes(value);
}

/** The first colour no project uses, or else the first of the set (C20). */
export function proposeColor(used: Iterable<string | null>): ProjectColor {
  const taken = new Set(used);
  return PROJECT_COLORS.find((color) => !taken.has(color)) ?? PROJECT_COLORS[0];
}

// ── Limits ────────────────────────────────────────────────────────────────────────────────────

export const MAX_ROOTS = 32;
export const MAX_PROVIDERS = 16;
/** What the page may send as a name, before main normalizes and clamps it to 60 (C16). */
export const MAX_NAME_INPUT = 1000;
export const MAX_PATH = 4096;

// ── The view (C52) ────────────────────────────────────────────────────────────────────────────

export const TRUST_ANSWERS = ['trusted', 'not-trusted'] as const;
export type TrustAnswer = (typeof TRUST_ANSWERS)[number];

/** How a later root stands to an earlier one: the same folder, inside it, or around it (C26). */
export const ROOT_RELATIONS = ['same', 'inside', 'around'] as const;
export type RootRelation = (typeof ROOT_RELATIONS)[number];

export interface ProjectRootView {
  readonly path: string;
  /** Null when not answered, or answered with a value this build does not know (C83): not trusted. */
  readonly trust: TrustAnswer | null;
  /** The folder's last check found nothing there (C28). Unchecked or unanswered roots are not missing. */
  readonly missing: boolean;
}

export type ProjectEntryView =
  | {
      readonly kind: 'project';
      /** Its id: what a move or a remove names. */
      readonly key: string;
      readonly id: string;
      readonly name: string;
      /** Null for a colour this build does not know, which shows as grey (C12). */
      readonly color: ProjectColor | null;
      readonly hidden: boolean;
      /** Whether the project's session list is folded; saved independently of Hide/Show. */
      readonly collapsed: boolean;
      /** Registered providers only, in the registry's order. */
      readonly providers: readonly string[];
      readonly roots: readonly ProjectRootView[];
      /** How many session entries go with it when it is removed (M14, C13, C57). */
      readonly sessions: number;
      /**
       * The project's default mode for each provider's new chats (M22, C40): by provider id, the id
       * of one of that provider's modes. A provider with no entry uses the user's own default.
       */
      readonly permissionModes: Readonly<Record<string, string>>;
    }
  /** An entry fat-g cannot read (C6, C60). Its key is made for this run and never written. */
  | { readonly kind: 'unreadable'; readonly key: string; readonly sessions: number };

export type RecordsRefusalCause = 'newer' | 'older' | 'unreadable' | 'damaged';

export type RecordsStatus =
  /** `keptAs`: after Start fresh, the full path of the file moved aside, for the rest of the run (C63). */
  | { readonly kind: 'ok'; readonly keptAs: string | null }
  | { readonly kind: 'refused'; readonly cause: RecordsRefusalCause };

export interface RecordsState {
  readonly status: RecordsStatus;
  /** In stored order (C15): the list's order is the file's. */
  readonly projects: readonly ProjectEntryView[];
}

// ── Requests (C53, C82) ───────────────────────────────────────────────────────────────────────

// Any 8-4-4-4-12 UUID, as the records file accepts (src/main/records/format.ts): a hand-edited id
// need not carry RFC 4122's version bits, and its project must still be reachable.
const id = z.guid();
/** A project's id, or an unreadable entry's run-only key: both are UUIDs. */
const key = z.guid();
const rootPath = z.string().min(1).max(MAX_PATH);
const providerId = z.string().min(1).max(128);

const rootRequest = z.strictObject({ path: rootPath, trust: z.enum(TRUST_ANSWERS) });
/**
 * A project's default modes as a request gives them (M22, C40): every provider that has one, so a
 * provider left out uses the user's default. Left out whole, an update keeps what is stored.
 */
const permissionModes = z.record(providerId, ModeIdSchema).refine((modes) => Object.keys(modes).length <= MAX_PROVIDERS, 'too many providers');

export const ProjectPickFolderRequestSchema = z.strictObject({
  /** The project being edited, or null in the add flow. */
  projectId: id.nullable(),
  /** The draft's roots, compared with the folder picked (C26). */
  roots: z.array(rootPath).max(MAX_ROOTS),
});

/** A root already saved on this project, or returned by the folder picker in this run. */
export const ProjectOpenFolderRequestSchema = z.strictObject({ projectId: id.nullable(), path: rootPath });
export type ProjectOpenFolderRequest = z.infer<typeof ProjectOpenFolderRequestSchema>;

export const ProjectAddRequestSchema = z.strictObject({
  name: z.string().max(MAX_NAME_INPUT),
  color: z.enum(PROJECT_COLORS),
  roots: z.array(rootRequest).min(1).max(MAX_ROOTS),
  providers: z.array(providerId).max(MAX_PROVIDERS),
  permissionModes: permissionModes.optional(),
});

export const ProjectUpdateRequestSchema = z.strictObject({
  id,
  name: z.string().max(MAX_NAME_INPUT),
  /** Left out, the stored colour stays — one this build does not know included (C12). */
  color: z.enum(PROJECT_COLORS).optional(),
  roots: z.array(rootRequest).min(1).max(MAX_ROOTS),
  providers: z.array(providerId).max(MAX_PROVIDERS),
  permissionModes: permissionModes.optional(),
});

export const ProjectSetHiddenRequestSchema = z.strictObject({ id, hidden: z.boolean() });
export const ProjectSetCollapsedRequestSchema = z.strictObject({ id, collapsed: z.boolean() });

/** Drops the project into a group (`hidden`), before the entry `before` names, or at the group's end. */
export const ProjectMoveRequestSchema = z.strictObject({ id, hidden: z.boolean(), before: key.nullable() });

export const ProjectRemoveRequestSchema = z.strictObject({ key });

export const ProjectCheckRootsRequestSchema = z.strictObject({ id });

export type ProjectPickFolderRequest = z.infer<typeof ProjectPickFolderRequestSchema>;
export type ProjectAddRequest = z.infer<typeof ProjectAddRequestSchema>;
export type ProjectUpdateRequest = z.infer<typeof ProjectUpdateRequestSchema>;
export type ProjectSetHiddenRequest = z.infer<typeof ProjectSetHiddenRequestSchema>;
export type ProjectSetCollapsedRequest = z.infer<typeof ProjectSetCollapsedRequestSchema>;
export type ProjectMoveRequest = z.infer<typeof ProjectMoveRequestSchema>;
export type ProjectRemoveRequest = z.infer<typeof ProjectRemoveRequestSchema>;
export type ProjectRootRequest = z.infer<typeof rootRequest>;

// ── Answers ───────────────────────────────────────────────────────────────────────────────────

/**
 * How a root stands to the folder of an account the user added (M14b, C58): the account by its
 * provider and its key, never by its folder's path. The first account's folder is not compared.
 */
export interface AccountFolderConflict {
  readonly providerId: string;
  readonly key: string;
  readonly relation: RootRelation;
}

export type ProjectRefusal =
  /**
   * `session-running`: Remove, while one of the project's sessions runs (M14, C96).
   * `conversations-refused` and `storage-failed`: Remove, while the conversation store is refused,
   * or when the removal's mark could not be written there (M18, C42, C63).
   */
  | { readonly status: 'refused'; readonly reason: 'records-refused' | 'unknown-project' | 'name-empty' | 'no-provider' | 'session-running' | 'conversations-refused' | 'storage-failed' }
  /** A root the picker did not return in this run, and the project's saved record does not hold (C23). */
  | { readonly status: 'refused'; readonly reason: 'root-not-allowed'; readonly index: number }
  /** Root `index` is an added account's folder, or inside or around one: its CLI keeps the account's login there (M14b, C58). */
  | { readonly status: 'refused'; readonly reason: 'account-folder'; readonly index: number; readonly account: AccountFolderConflict }
  /** Root `second` is `relation` to root `first`, which comes before it (C26). */
  | { readonly status: 'refused'; readonly reason: 'root-overlap'; readonly first: number; readonly second: number; readonly relation: RootRelation };

export type ProjectSaved = { readonly status: 'saved' };

export type PickFolderResult =
  | {
      readonly status: 'picked';
      /** Normalized once by main, and sent back in this form (C24). */
      readonly path: string;
      /** The folder's own name, proposed as the project's (C17); null for a drive or filesystem root. */
      readonly folderName: string | null;
      /** The first of the draft's roots it overlaps, and how it stands to it (C26). */
      readonly conflict: { readonly index: number; readonly relation: RootRelation } | null;
      /** The added account whose folder it is, or lies inside or around (M14b, C58). Save refuses it again. */
      readonly account: AccountFolderConflict | null;
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'refused'; readonly reason: 'busy' | 'records-refused' | 'unsupported-path' };
