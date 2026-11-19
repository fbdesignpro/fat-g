// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation store's file, format version 12 (docs/planning/_archive/M18.md, Design 2 and 3; C7, C8,
// C36–C40, C62; M19.md, Design 4; C22; M20a.md, Design 6; C28; M20b.md, Design 5; C28; M21.md,
// Design 5; C32; M22.md, Design 9; C25, C77, C83; docs/planning/_archive/M106.md, Design 4; C19; decisions 0019,
// 0024, 0025, 0026, 0027): a SQLite
// database in fat-g's data folder, in write-ahead mode.
//
//   conversations.sqlite        the main file
//   conversations.sqlite-wal    SQLite's log, while the store is open: committed work can be here alone (K2)
//   conversations.sqlite-shm    SQLite's index of the log
//
// Its envelope (C36) is SQLite's application id, which marks the file as fat-g's, and the one row of
// `meta`, which holds the two version numbers. Until the first public release a format change raises
// both numbers together, with no migration (decision 0014).
//
// `auto_vacuum` is the file's own, chosen before its first table, and so part of this version (C62):
// a removal gives its pages back. `secure_delete` and `synchronous` are the connection's, and are
// set at every open (open.ts).
//
// No frame and no account field has a column: what is kept is what the agent events' schemas let
// through (C9). From version 3 that includes what a session did between its messages — command
// lines, paths, tool output — as the bounded body of an activity (M20a, C30; decision 0024). From
// version 4 it includes the questions asked beside a session, each aside a conversation of its own
// that names its session as its parent, with the passage it was asked about (M20b, C28, C29;
// decision 0025): the one text of a project's file that is kept, because the user sent it. From
// version 5 it includes the questions a session asks and the answers given, as the body of an
// item of kind `interaction` (M21, C4, C32; decision 0026): a secret's answer is never among them.
// From version 6 it includes what a session asked leave for and what was decided — the command, the
// change, the decision and the grant sent with it — as a body of that same kind, told from a
// question's by its own `kind` (M22, C77), with the mode each chat has and each turn ran under
// (C25, C83; decision 0027). From version 9 it includes what was not sent yet (M23, C5, C31, C47;
// decision 0030): each session's draft and queued messages, and the images the user pasted or dropped,
// named here by the hash of their bytes — the bytes themselves are files in `attachments/` beside the
// store, which the store names and never reads. From version 10 a sub-agent's item names the model it ran
// on and, where its CLI names one, the agent definition it ran as (M106, C19, C20). From version 11 a
// plan's line may close as superseded, decided elsewhere, left or retired, and a conversation keeps
// where a plan it took part in was implemented — a session's id and a time, never a plan's text —
// once that plan is deleted (decision 0029).
// From version 12 a user message keeps whether it was accepted from the queue (decision 0019).
import { CONVERSATIONS_FILE } from '@shared/contracts/conversation';

export const STORE_FILE = CONVERSATIONS_FILE;
/** What SQLite keeps beside the main file, by the ending it adds to its name (C40). */
export const SIDECAR_ENDINGS = ['-wal', '-shm'] as const;

/** The store's files, main file first: what a move aside takes together, and what a size adds up. */
export function storeFiles(name: string = STORE_FILE): readonly string[] {
  return [name, ...SIDECAR_ENDINGS.map((ending) => `${name}${ending}`)];
}

/** 'fatg', as SQLite's application id. */
export const APPLICATION_ID = 0x66617467;
/**
 * Both version numbers of the format this build reads and writes. Version 2 (M19, C22): a message's
 * body says whether it is complete, and a turn has its elapsed time. A version-1 store is refused as
 * older, and left as it is until Start fresh. Version 3 (M20a, C28): an item says whose it is — the
 * session's own, or a worker's — and a body of kind `activity` holds its fields under a key of its
 * own. A version-2 store is refused as older, as a version-1 one is. Version 4 (M20b, C28): a
 * conversation may name a parent — an aside's names its session's — with the source it was asked
 * about and its title, and a message's body may name the model that wrote it. A version-3 store is
 * refused as older. Version 5 (M21, C32): an item of kind `interaction` holds a question's body
 * under a key of its own; no column and no index is added, and a version-4 store is refused as
 * older. Version 6 (M22, C25, C77, C83): a conversation holds its chat's mode and where it came
 * from, a turn the mode it ran under, and an `interaction` body may be an approval's; no item kind
 * is added, and a version-5 store is refused as older. Version 7 (M22b, C17, C69, C71): a turn says
 * whether it was a plan turn, an `interaction` body may be a plan's line, and a prompt's body may
 * name the plan and the version it was composed for; no item kind is added, and a version-6 store is
 * refused as older. Version 8 (M22e, C53): a prompt's plan fields may name the intent `review`, a
 * prompt that reads the plan for a review; no key, column or kind is added, and a version-7 store is
 * refused as older. Version 9 (M23, C5, C31, C38, C47, C81): the tables `blob`, `staged`, `draft` and
 * `queue`, an item's `blob` column for the kind `attachment` M18 reserved, and a user's message's
 * `delivery` for one sent into a running turn; a version-8 store is refused as older. Version 10
 * (M106, C19): a worker item's activity body names its sub-agent's `model` and `agentType`, from which
 * the session's finished sub-agents are listed at launch; no key, column or kind is added beside them,
 * and a version-9 store is refused as older. Version 11 (decision 0029): a plan's line may read
 * `superseded`, `elsewhere`, `left` or `retired`, and a conversation's `planNote` says where a plan it
 * took part in was implemented, as JSON of a session's id and a time; a version-10 store is refused as older.
 */
// Version 13 snapshots each dispatched turn's requested speed under turn.extra.speed.
export const CONVERSATIONS_VERSION = 13;

/**
 * The tables, as they are made. Every table is `STRICT`. A place is stored, never derived (C49): a
 * turn's in its conversation, an item's in its turn. `extra` and an item's `body` are JSON, whose
 * unknown keys this build leaves alone (C38).
 */
export const SCHEMA: readonly string[] = [
  'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), schemaVersion INTEGER NOT NULL, minReaderVersion INTEGER NOT NULL) STRICT',
  // `startHeld`: the row was made at the session's first prompt, so the store has the conversation's
  // start (C18). `reachedStart`: a history check walked back to the start (C51). `removing`: an
  // explicit removal has begun (C63). `parentId`: null for a session's conversation, and for an
  // aside's the id of its session's (M20b, C28); `source`: what the aside was asked about, as JSON,
  // or null for a question typed freely (C29); `title`: the aside's own (C36). `mode`: the id of
  // the chat's mode, and `modeSource` where it came from (M22, C25, C40) — both null for an aside's
  // row, and for a chat no mode was resolved for. `planNote`: where a plan the chat took part in was
  // implemented, once the plan is deleted (decision 0029), as JSON; null for none.
  `CREATE TABLE conversation (id TEXT PRIMARY KEY, reference TEXT, folder TEXT, configFolder TEXT,
     startHeld INTEGER NOT NULL, reachedStart INTEGER NOT NULL DEFAULT 0,
     removing INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, extra TEXT,
     parentId TEXT, source TEXT, title TEXT, mode TEXT, modeSource TEXT, planNote TEXT) STRICT`,
  // The provider's end and the session's end, kept apart (C54). `providerTook`: the provider
  // confirmed that it took the prompt. `reached`: a history check saw the turn (C51, C61).
  // `elapsedMs`: fat-g's own measure of a turn it ran, written with the provider's end (M19, C44);
  // `providerDurationMs` is the provider's, and stays what an import gave. `own`: fat-g answered the
  // prompt itself and sent it to no provider (M20b, C35), so no provider took it or ended it.
  // `mode`: the chat's mode when the turn's prompt was accepted (M22, C83); null for an imported
  // turn and an aside's. `plan`: the turn was a plan turn (M22b, C1, C55, C71) — its mode is the
  // chat's still, which never changes for one.
  `CREATE TABLE turn (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, place INTEGER NOT NULL,
     origin TEXT NOT NULL, providerTurnId TEXT, acceptedAt INTEGER, providerTook INTEGER NOT NULL DEFAULT 0,
     providerStartedAt INTEGER, providerEndedAt INTEGER, endReceivedAt INTEGER, providerOutcome TEXT,
     providerDurationMs INTEGER, elapsedMs INTEGER, sessionEndedAt INTEGER, sessionOutcome TEXT,
     reached INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0, extra TEXT,
     own INTEGER NOT NULL DEFAULT 0, mode TEXT, plan INTEGER NOT NULL DEFAULT 0) STRICT`,
  // `body` is JSON: role, phase, blocks, questions, notice, detail, and `complete` — false for a
  // message whose whole text never arrived (M19, C15), and for an activity whose end has not come.
  // `model`: on a message whose provider named the model that wrote it (M20b, C28), and else absent.
  // An activity's own fields are under `activity` (M20a, C28), an interaction's under `interaction`
  // (M21, C32) — a question's, an approval's with `kind: 'approval'` (M22, C77), or a plan's line
  // with `kind: 'plan'` (M22b, C17). A prompt fat-g composed for a plan names it under `plan`
  // (M22b, C69). `workerId`: null for the session's own items, else the worker whose item it is (C20).
  // An item of kind `attachment` (M23, C5) is a sent message's use of an image: `blob` names the
  // image's hash — null for one a provider's history named and fat-g never held (C25) — and its body
  // holds its message, its place among that message's images and its name under `attachment`. A
  // user's message sent into a running turn says what became of it under `delivery` (C38).
  `CREATE TABLE item (id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, turnId TEXT NOT NULL, place INTEGER NOT NULL,
     kind TEXT NOT NULL, origin TEXT NOT NULL, providerItemId TEXT, receivedAt INTEGER, providerAt INTEGER,
     body TEXT NOT NULL, workerId TEXT, blob TEXT) STRICT`,
  // The images the store names (M23, C5, C85): one row per hash, with what its header said and when it
  // was first staged. A row goes in the transaction that removes its last use (C6).
  'CREATE TABLE blob (hash TEXT PRIMARY KEY, mediaType TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, stagedAt INTEGER NOT NULL, extra TEXT) STRICT',
  // A use of an image in a draft (`owner` 'draft', `ownerId` its session) or in a queued message
  // ('queue', the entry's id), at its place among them, with the name it was dropped under (C5).
  'CREATE TABLE staged (id TEXT PRIMARY KEY, owner TEXT NOT NULL, ownerId TEXT NOT NULL, place INTEGER NOT NULL, blob TEXT NOT NULL, name TEXT, extra TEXT) STRICT',
  // A session's draft (C31): its text, the page's revision of it and its intent — a plan turn, a chosen
  // skill (C87) — as JSON, null for none. Kept empty once sent, so a late update cannot bring it back (C86).
  'CREATE TABLE draft (sessionId TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL, intent TEXT, changedAt INTEGER NOT NULL, extra TEXT) STRICT',
  // A session's queued messages (C47), each at its place, its intent as a draft's is.
  'CREATE TABLE queue (id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, place INTEGER NOT NULL, text TEXT NOT NULL, intent TEXT, queuedAt INTEGER NOT NULL, extra TEXT) STRICT',
  'CREATE INDEX turn_place ON turn (conversationId, place)',
  'CREATE INDEX turn_provider ON turn (conversationId, providerTurnId)',
  'CREATE INDEX item_place ON item (turnId, place)',
  'CREATE INDEX item_provider ON item (conversationId, providerItemId)',
  // A worker's items, in their order (M20a, C28, C32): they are all in the turn that started it.
  'CREATE INDEX item_worker ON item (conversationId, workerId, place)',
  // A session's asides (M20b, C28, C30): what its read lists, and what its removal takes.
  'CREATE INDEX conversation_parent ON conversation (parentId)',
  // What names an image (M23, C6): asked at every release.
  'CREATE INDEX item_blob ON item (blob)',
  'CREATE INDEX staged_owner ON staged (owner, ownerId, place)',
  'CREATE INDEX staged_blob ON staged (blob)',
  'CREATE INDEX queue_place ON queue (sessionId, place)',
];

/**
 * The tables and columns this build needs (C36, C39): the open's check looks for these names and
 * nothing else of the schema. A table or a column it does not know is left as it is (C38).
 */
export const NEEDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  meta: ['id', 'schemaVersion', 'minReaderVersion'],
  conversation: ['id', 'reference', 'folder', 'configFolder', 'startHeld', 'reachedStart', 'removing', 'createdAt', 'parentId', 'source', 'title', 'mode', 'modeSource', 'planNote'],
  turn: ['id', 'conversationId', 'place', 'origin', 'providerTurnId', 'acceptedAt', 'providerTook', 'providerStartedAt', 'providerEndedAt', 'endReceivedAt', 'providerOutcome', 'providerDurationMs', 'elapsedMs', 'sessionEndedAt', 'sessionOutcome', 'reached', 'gap', 'own', 'mode', 'plan', 'extra'],
  item: ['id', 'conversationId', 'turnId', 'place', 'kind', 'origin', 'providerItemId', 'receivedAt', 'providerAt', 'body', 'workerId', 'blob'],
  blob: ['hash', 'mediaType', 'bytes', 'width', 'height', 'stagedAt'],
  staged: ['id', 'owner', 'ownerId', 'place', 'blob', 'name'],
  draft: ['sessionId', 'text', 'revision', 'intent', 'changedAt'],
  queue: ['id', 'sessionId', 'place', 'text', 'intent', 'queuedAt'],
};
