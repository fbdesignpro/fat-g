// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The composer's rows in the conversation store (docs/planning/_archive/M23.md, Design 1, 2, 5, 7; C5, C6, C8,
// C31, C47–C51, C81, C85–C87; decisions 0019, 0030): the images the store names, each use of one,
// each session's draft and its queued messages.
//
//   blob     one row per image, by the hash of its bytes: its type, its size, its pixels, when first staged
//   staged   one row per use of an image in a draft or a queued message: its owner, its place, its name
//   draft    one row per session: its text, its intent and the revision the page last gave it
//   queue    one row per queued message: its session, its place, its text, its intent, when queued
//
// A sent message's use is an item of kind `attachment` in its turn (C5), its image named in the
// item's `blob` column and its message, place and name in its body. Ownership moves in the
// transaction of the operation that moves it — staging, Queue, Edit, a release, a removal — so no
// image is ever unnamed between two parts of a move that succeeds, and one that fails leaves what was.
//
// These are the store's helpers, run inside its transactions (store.ts): they write and read rows and
// know no file. An image whose last use goes is told back to the store, which deletes its row in the
// same transaction and its file after the commit.
import type { SQLInputValue } from 'node:sqlite';
import { ATTACHMENT_WORDS, type AttachmentDescriptor, type AttachmentView, isAttachmentHash, isAttachmentMediaType, MAX_IMAGES, MAX_MESSAGE_IMAGE_BYTES } from '@shared/contracts/attachments';
import { MAX_QUEUE, type PromptIntent, readIntent } from '@shared/contracts/composer';
import type { AttachmentMediaType } from '@shared/contracts/attachments';

type Row = Record<string, unknown>;

export interface RowsContext {
  readonly get: (sql: string, ...values: SQLInputValue[]) => Row | undefined;
  readonly all: (sql: string, ...values: SQLInputValue[]) => Row[];
  readonly run: (sql: string, ...values: SQLInputValue[]) => number;
}

/** A failure of the operation's own, which the store throws as a `StorageFailure` of this kind: nothing of it is written. */
export type ComposerFailure = 'too-many' | 'too-large' | 'full' | 'empty' | 'draft-changed' | 'unknown-entry' | 'unknown-attachment' | 'not-queued' | 'no-blob';

/** An image as the store names it (C5). */
export interface StoredBlob {
  readonly hash: string;
  readonly mediaType: AttachmentMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly stagedAt: number;
}

/** A use of an image, to be moved: its id, its image and its name. */
export interface StagedUse {
  readonly id: string;
  readonly hash: string;
  readonly name: string | null;
}

export interface StoredDraft {
  readonly sessionId: string;
  readonly text: string;
  readonly revision: number;
  readonly intent: PromptIntent;
  readonly changedAt: number;
  readonly attachments: readonly AttachmentDescriptor[];
}

export interface StoredQueued {
  readonly id: string;
  readonly sessionId: string;
  readonly place: number;
  readonly text: string;
  readonly intent: PromptIntent;
  readonly queuedAt: number;
  readonly attachments: readonly AttachmentDescriptor[];
}

/** An input as Send, Queue and Edit carry it (C86): the text, the intent, the revision, and the images by their uses' ids. */
export interface GivenInput {
  readonly revision: number;
  readonly text: string;
  readonly intent: PromptIntent;
  readonly attachmentIds: readonly string[];
}

export class ComposerRowsFailure extends Error {
  constructor(readonly kind: ComposerFailure) {
    super(kind);
    this.name = 'ComposerRowsFailure';
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const intentJson = (intent: PromptIntent): string | null => (!intent.plan && intent.skill === null ? null : JSON.stringify(intent));
const readIntentColumn = (value: unknown): PromptIntent => {
  if (typeof value !== 'string') return readIntent(null);
  try { return readIntent(JSON.parse(value)); } catch { return readIntent(null); }
};
const marks = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

function toBlob(row: Row): StoredBlob | null {
  const hash = text(row['hash']);
  const mediaType = row['mediaType'];
  const bytes = integer(row['bytes']);
  const width = integer(row['width']);
  const height = integer(row['height']);
  if (hash === null || !isAttachmentHash(hash) || !isAttachmentMediaType(mediaType) || bytes === null || width === null || height === null) return null;
  return { hash, mediaType, bytes, width, height, stagedAt: integer(row['stagedAt']) ?? 0 };
}

/** A use with its image, as the page is shown it: one whose image row cannot be read is none. */
function toDescriptor(row: Row): AttachmentDescriptor | null {
  const blob = toBlob({ ...row, hash: row['blob'] });
  if (blob === null) return null;
  return { id: String(row['id']), hash: blob.hash, mediaType: blob.mediaType, bytes: blob.bytes, width: blob.width, height: blob.height, name: text(row['name']) };
}

const USE_COLUMNS = 's.id AS id, s.blob AS blob, s.name AS name, b.mediaType AS mediaType, b.bytes AS bytes, b.width AS width, b.height AS height';

export interface ComposerRows {
  blob(hash: string): StoredBlob | null;
  /** Whether the store names an image of this hash and type: what the sweep of its folder asks (C6). */
  knows(hash: string, mediaType: AttachmentMediaType): boolean;
  /** The images of these uses, in their order: what a Send, a Queue or an Edit names, checked against its owner. */
  uses(owner: 'draft' | 'queue', ownerId: string): StagedUse[];
  draft(sessionId: string): StoredDraft | null;
  queue(sessionId: string): StoredQueued[];
  /** The draft's row, made where there is none: empty, at revision 0. */
  ensureDraft(sessionId: string, at: number): void;
  /** Its text and intent at a revision above the one held (C86): false where it is late, and nothing changed. */
  setDraft(sessionId: string, revision: number, value: { readonly text: string; readonly intent: PromptIntent }, at: number): boolean;
  /** An image put last in the draft (C14), within its bounds (C2); answers its saved display name. */
  stage(sessionId: string, blob: StoredBlob, use: { readonly id: string; readonly name: string | null }, at: number): string;
  /** A use taken out of the draft (C16). Answers its image, for the release. */
  removeDraftUse(sessionId: string, useId: string): string | null;
  /** The draft emptied at a revision (C32): its uses' images, for the release. */
  clearDraft(sessionId: string, revision: number, at: number): string[];
  /** The draft's uses, checked against what was given and taken from it, its text emptied (C56, C86). */
  consumeDraft(sessionId: string, given: GivenInput, at: number): StagedUse[];
  /** A queued message, taken whole from the queue (C56): its text, its intent and its uses. */
  consumeQueued(sessionId: string, entryId: string): { readonly text: string; readonly intent: PromptIntent; readonly uses: StagedUse[] };
  /**
   * Queue next (C47, C48): the draft as given appended, its uses with it, and the draft emptied. With
   * `index`, put among the entries at that place instead — a held Send now, ahead of what was queued.
   */
  enqueue(sessionId: string, entryId: string, given: GivenInput, at: number, index?: number): void;
  /** Edit (C50, C87): the entry's input into the draft, and the draft as given into the entry's place. */
  edit(sessionId: string, entryId: string, given: GivenInput, at: number): void;
  /** A queued message removed (C50): its uses' images, for the release. */
  unqueue(sessionId: string, entryId: string): string[];
  /** The entries put in the order named, which names each of the session's once (C51, C86). */
  reorder(sessionId: string, ids: readonly string[]): void;
  /** Every queued message of the session removed (C82): their uses' images, for the release. */
  dropQueue(sessionId: string): string[];
  /** A session's draft, its uses and its queue, gone with its conversation (C6; 0019, item 11): their images, for the release. */
  eraseComposer(sessionId: string): string[];
  /** The sessions whose draft holds text or an image, or that have a queued message (C83): ids alone. */
  withContent(): string[];
  /** The sessions that have a queued message (C52). */
  queued(): string[];
  /** Of these images, those no use names any more: their rows deleted, their types answered, for their files to go (C6). */
  release(hashes: Iterable<string>): { readonly hash: string; readonly mediaType: AttachmentMediaType }[];
  /** A sent message's images, for each of these messages of these turns, in their order (C26). */
  attachmentsOf(conversationId: string, turnIds: readonly string[]): Map<string, AttachmentView[]>;
  /** Inserts a sent message's uses as items of its turn, from `place` on (C5): answers the next free place. */
  insertItems(conversationId: string, turnId: string, messageId: string, place: number, uses: readonly { readonly id: string; readonly hash: string | null; readonly name: string | null }[]): number;
  /** Every image the conversations' items name (C6): what their removal releases. */
  itemBlobs(conversationId: string): string[];
}

export function composerRows(ctx: RowsContext): ComposerRows {
  const { get, all, run } = ctx;

  /** Names are already durable per use: count the session's draft, queue and sent labels, never blobs. */
  function nextPastedName(sessionId: string): string {
    const names = all(
      `SELECT name FROM staged WHERE (owner = 'draft' AND ownerId = ?)
           OR (owner = 'queue' AND ownerId IN (SELECT id FROM queue WHERE sessionId = ?))
       UNION ALL
       SELECT json_extract(body, '$.attachment.name') AS name FROM item
        WHERE conversationId = ? AND kind = 'attachment'`,
      sessionId, sessionId, sessionId,
    );
    let last = 0;
    for (const row of names) {
      const name = text(row['name']);
      const number = name === null ? null : /^Pasted image ([1-9]\d*)$/.exec(name);
      const ordinal = Number(number?.[1]);
      if (Number.isSafeInteger(ordinal) && ordinal < Number.MAX_SAFE_INTEGER) last = Math.max(last, ordinal);
    }
    return ATTACHMENT_WORDS.pasted(last + 1);
  }

  function uses(owner: 'draft' | 'queue', ownerId: string): StagedUse[] {
    return all('SELECT id, blob, name FROM staged WHERE owner = ? AND ownerId = ? ORDER BY place', owner, ownerId).flatMap((row) => {
      const hash = text(row['blob']);
      return hash === null ? [] : [{ id: String(row['id']), hash, name: text(row['name']) }];
    });
  }

  const descriptors = (owner: 'draft' | 'queue', ownerId: string): AttachmentDescriptor[] =>
    all(`SELECT ${USE_COLUMNS} FROM staged s JOIN blob b ON b.hash = s.blob WHERE s.owner = ? AND s.ownerId = ? ORDER BY s.place`, owner, ownerId).flatMap((row) => {
      const descriptor = toDescriptor(row);
      return descriptor === null ? [] : [descriptor];
    });

  function ensureDraft(sessionId: string, at: number): void {
    run("INSERT INTO draft (sessionId, text, revision, intent, changedAt) SELECT ?, '', 0, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM draft WHERE sessionId = ?)", sessionId, at, sessionId);
  }

  const revisionOf = (sessionId: string): number => integer(get('SELECT revision FROM draft WHERE sessionId = ?', sessionId)?.['revision']) ?? 0;

  /** The uses named are the owner's, each once and in its order (C86): anything else is a draft the page has not read. */
  function check(owner: 'draft' | 'queue', ownerId: string, ids: readonly string[]): StagedUse[] {
    const held = uses(owner, ownerId);
    if (held.length !== ids.length || held.some((use, index) => use.id !== ids[index])) throw new ComposerRowsFailure('draft-changed');
    return held;
  }

  /** The draft's text, intent and revision written: the revision never goes back. */
  function writeDraft(sessionId: string, revision: number, value: { readonly text: string; readonly intent: PromptIntent }, at: number): void {
    ensureDraft(sessionId, at);
    run('UPDATE draft SET text = ?, intent = ?, revision = max(revision, ?), changedAt = ? WHERE sessionId = ?', value.text, intentJson(value.intent), revision, at, sessionId);
  }

  const moveUses = (fromOwner: 'draft' | 'queue' | 'swap', fromId: string, toOwner: 'draft' | 'queue' | 'swap', toId: string): number =>
    run('UPDATE staged SET owner = ?, ownerId = ? WHERE owner = ? AND ownerId = ?', toOwner, toId, fromOwner, fromId);

  const nextQueuePlace = (sessionId: string): number => (integer(get('SELECT max(place) AS place FROM queue WHERE sessionId = ?', sessionId)?.['place']) ?? 0) + 1;

  function queueRow(sessionId: string, entryId: string): Row | undefined {
    return get('SELECT id, text, intent FROM queue WHERE id = ? AND sessionId = ?', entryId, sessionId);
  }

  function dropQueue(sessionId: string): string[] {
    const entries = all('SELECT id FROM queue WHERE sessionId = ?', sessionId).map((row) => String(row['id']));
    const released = entries.flatMap((id) => uses('queue', id).map((use) => use.hash));
    for (const id of entries) run("DELETE FROM staged WHERE owner = 'queue' AND ownerId = ?", id);
    run('DELETE FROM queue WHERE sessionId = ?', sessionId);
    return released;
  }

  return {
    blob(hash) {
      const row = get('SELECT hash, mediaType, bytes, width, height, stagedAt FROM blob WHERE hash = ?', hash);
      return row === undefined ? null : toBlob(row);
    },

    knows(hash, mediaType) {
      return get('SELECT 1 AS found FROM blob WHERE hash = ? AND mediaType = ?', hash, mediaType) !== undefined;
    },

    uses,

    draft(sessionId) {
      const row = get('SELECT sessionId, text, revision, intent, changedAt FROM draft WHERE sessionId = ?', sessionId);
      if (row === undefined) return null;
      return { sessionId, text: text(row['text']) ?? '', revision: integer(row['revision']) ?? 0, intent: readIntentColumn(row['intent']), changedAt: integer(row['changedAt']) ?? 0, attachments: descriptors('draft', sessionId) };
    },

    queue(sessionId) {
      return all('SELECT id, place, text, intent, queuedAt FROM queue WHERE sessionId = ? ORDER BY place', sessionId).map((row) => {
        const id = String(row['id']);
        return { id, sessionId, place: integer(row['place']) ?? 0, text: text(row['text']) ?? '', intent: readIntentColumn(row['intent']), queuedAt: integer(row['queuedAt']) ?? 0, attachments: descriptors('queue', id) };
      });
    },

    ensureDraft,

    setDraft(sessionId, revision, value, at) {
      ensureDraft(sessionId, at);
      return run('UPDATE draft SET text = ?, intent = ?, revision = ?, changedAt = ? WHERE sessionId = ? AND revision < ?', value.text, intentJson(value.intent), revision, at, sessionId, revision) > 0;
    },

    stage(sessionId, blob, use, at) {
      ensureDraft(sessionId, at);
      const held = all(`SELECT ${USE_COLUMNS} FROM staged s JOIN blob b ON b.hash = s.blob WHERE s.owner = 'draft' AND s.ownerId = ?`, sessionId);
      // Each use counts, the same image twice among them (C2): checked here, beside every other staging of the draft.
      if (held.length >= MAX_IMAGES) throw new ComposerRowsFailure('too-many');
      const bytes = held.reduce((sum, row) => sum + (integer(row['bytes']) ?? 0), 0);
      if (bytes + blob.bytes > MAX_MESSAGE_IMAGE_BYTES) throw new ComposerRowsFailure('too-large');
      // The same bytes are one row (C85): the first staging's metadata and time stand.
      run('INSERT INTO blob (hash, mediaType, bytes, width, height, stagedAt) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM blob WHERE hash = ?)', blob.hash, blob.mediaType, blob.bytes, blob.width, blob.height, blob.stagedAt, blob.hash);
      const place = (integer(get("SELECT max(place) AS place FROM staged WHERE owner = 'draft' AND ownerId = ?", sessionId)?.['place']) ?? 0) + 1;
      const name = use.name ?? nextPastedName(sessionId);
      run("INSERT INTO staged (id, owner, ownerId, place, blob, name) VALUES (?, 'draft', ?, ?, ?, ?)", use.id, sessionId, place, blob.hash, name);
      run('UPDATE draft SET changedAt = ? WHERE sessionId = ?', at, sessionId);
      return name;
    },

    removeDraftUse(sessionId, useId) {
      const hash = text(get("SELECT blob FROM staged WHERE id = ? AND owner = 'draft' AND ownerId = ?", useId, sessionId)?.['blob']);
      if (hash === null) return null;
      run('DELETE FROM staged WHERE id = ?', useId);
      return hash;
    },

    clearDraft(sessionId, revision, at) {
      const released = uses('draft', sessionId).map((use) => use.hash);
      run("DELETE FROM staged WHERE owner = 'draft' AND ownerId = ?", sessionId);
      // Plan stays as pressed (C87): the composer's choice, which a clear of its text and images leaves.
      writeDraft(sessionId, revision, { text: '', intent: { plan: readIntentColumn(get('SELECT intent FROM draft WHERE sessionId = ?', sessionId)?.['intent']).plan, skill: null } }, at);
      return released;
    },

    consumeDraft(sessionId, given, at) {
      const taken = check('draft', sessionId, given.attachmentIds);
      run("DELETE FROM staged WHERE owner = 'draft' AND ownerId = ?", sessionId);
      // The message took its skill; Plan stays pressed for the next, as the page shows it (C87; M22b, C1).
      writeDraft(sessionId, given.revision, { text: '', intent: { plan: given.intent.plan, skill: null } }, at);
      return taken;
    },

    consumeQueued(sessionId, entryId) {
      const row = queueRow(sessionId, entryId);
      if (row === undefined) throw new ComposerRowsFailure('not-queued');
      const taken = uses('queue', entryId);
      run("DELETE FROM staged WHERE owner = 'queue' AND ownerId = ?", entryId);
      run('DELETE FROM queue WHERE id = ?', entryId);
      return { text: text(row['text']) ?? '', intent: readIntentColumn(row['intent']), uses: taken };
    },

    enqueue(sessionId, entryId, given, at, index) {
      const count = integer(get('SELECT count(*) AS n FROM queue WHERE sessionId = ?', sessionId)?.['n']) ?? 0;
      if (count >= MAX_QUEUE) throw new ComposerRowsFailure('full');
      const taken = check('draft', sessionId, given.attachmentIds);
      if (given.text.trim() === '' && taken.length === 0) throw new ComposerRowsFailure('empty');
      const placed = index === undefined ? null : all('SELECT id FROM queue WHERE sessionId = ? ORDER BY place', sessionId).map((row) => String(row['id']));
      run('INSERT INTO queue (id, sessionId, place, text, intent, queuedAt) VALUES (?, ?, ?, ?, ?, ?)', entryId, sessionId, nextQueuePlace(sessionId), given.text, intentJson(given.intent), at);
      if (placed !== null) {
        // Places have gaps where entries went: every entry is numbered again, the new one at its index.
        placed.splice(Math.max(0, Math.min(index ?? placed.length, placed.length)), 0, entryId);
        for (const [place, id] of placed.entries()) run('UPDATE queue SET place = ? WHERE id = ?', place + 1, id);
      }
      moveUses('draft', sessionId, 'queue', entryId);
      // The entry took its intent; Plan stays pressed for the next, as after a Send (C87).
      writeDraft(sessionId, given.revision, { text: '', intent: { plan: given.intent.plan, skill: null } }, at);
    },

    edit(sessionId, entryId, given, at) {
      const row = queueRow(sessionId, entryId);
      if (row === undefined) throw new ComposerRowsFailure('unknown-entry');
      const draftUses = check('draft', sessionId, given.attachmentIds);
      const entry = { text: text(row['text']) ?? '', intent: readIntentColumn(row['intent']) };
      // Past every revision the page gave: the swap is main's change, and a late update cannot undo either side (C50).
      const revision = Math.max(revisionOf(sessionId), given.revision) + 1;
      if (given.text.trim() === '' && draftUses.length === 0) {
        // An empty draft: the entry comes in, and its slot goes.
        moveUses('queue', entryId, 'draft', sessionId);
        run('DELETE FROM queue WHERE id = ?', entryId);
      } else {
        // Each side's uses to the other, through a name neither holds, in one transaction.
        moveUses('queue', entryId, 'swap', entryId);
        moveUses('draft', sessionId, 'queue', entryId);
        moveUses('swap', entryId, 'draft', sessionId);
        run('UPDATE queue SET text = ?, intent = ? WHERE id = ?', given.text, intentJson(given.intent), entryId);
      }
      ensureDraft(sessionId, at);
      run('UPDATE draft SET text = ?, intent = ?, revision = ?, changedAt = ? WHERE sessionId = ?', entry.text, intentJson(entry.intent), revision, at, sessionId);
    },

    unqueue(sessionId, entryId) {
      if (queueRow(sessionId, entryId) === undefined) throw new ComposerRowsFailure('unknown-entry');
      const released = uses('queue', entryId).map((use) => use.hash);
      run("DELETE FROM staged WHERE owner = 'queue' AND ownerId = ?", entryId);
      run('DELETE FROM queue WHERE id = ?', entryId);
      return released;
    },

    reorder(sessionId, ids) {
      const held = all('SELECT id FROM queue WHERE sessionId = ?', sessionId).map((row) => String(row['id']));
      // Each of the session's entries once, and no other (C86): none invented, omitted or doubled.
      if (new Set(ids).size !== ids.length || ids.length !== held.length || ids.some((id) => !held.includes(id))) throw new ComposerRowsFailure('unknown-entry');
      for (const [index, id] of ids.entries()) run('UPDATE queue SET place = ? WHERE id = ?', index + 1, id);
    },

    dropQueue,

    eraseComposer(sessionId) {
      const released = [...uses('draft', sessionId).map((use) => use.hash)];
      released.push(...dropQueue(sessionId));
      run("DELETE FROM staged WHERE owner = 'draft' AND ownerId = ?", sessionId);
      run('DELETE FROM draft WHERE sessionId = ?', sessionId);
      return released;
    },

    withContent() {
      return all(`SELECT sessionId AS id FROM draft WHERE text <> '' OR EXISTS (SELECT 1 FROM staged WHERE owner = 'draft' AND ownerId = draft.sessionId)
                  UNION SELECT DISTINCT sessionId AS id FROM queue`).map((row) => String(row['id']));
    },

    queued() {
      return all('SELECT DISTINCT sessionId AS id FROM queue').map((row) => String(row['id']));
    },

    release(hashes) {
      const gone: { hash: string; mediaType: AttachmentMediaType }[] = [];
      for (const hash of new Set(hashes)) {
        const named = get("SELECT 1 AS found FROM staged WHERE blob = ? UNION ALL SELECT 1 AS found FROM item WHERE blob = ? AND kind = 'attachment' LIMIT 1", hash, hash) !== undefined;
        if (named) continue;
        const row = get('SELECT mediaType FROM blob WHERE hash = ?', hash);
        if (row === undefined || !isAttachmentMediaType(row['mediaType'])) continue;
        run('DELETE FROM blob WHERE hash = ?', hash);
        gone.push({ hash, mediaType: row['mediaType'] });
      }
      return gone;
    },

    attachmentsOf(conversationId, turnIds) {
      const found = new Map<string, AttachmentView[]>();
      if (turnIds.length === 0) return found;
      const rows = all(
        `SELECT i.id AS id, i.blob AS blob, json_extract(i.body, '$.attachment.messageId') AS messageId, json_extract(i.body, '$.attachment.name') AS name,
                b.mediaType AS mediaType, b.bytes AS bytes, b.width AS width, b.height AS height
           FROM item i LEFT JOIN blob b ON b.hash = i.blob
          WHERE i.conversationId = ? AND i.kind = 'attachment' AND i.turnId IN (${marks(turnIds.length)}) ORDER BY i.turnId, i.place`,
        conversationId, ...turnIds,
      );
      for (const row of rows) {
        const messageId = text(row['messageId']);
        if (messageId === null) continue;
        const descriptor = row['blob'] === null ? null : toDescriptor(row);
        // An image fat-g never held, or whose row is gone: kept as a use, and drawn as not available (C8, C25).
        const view: AttachmentView = descriptor === null ? { id: String(row['id']), hash: null, available: false, name: null } : { ...descriptor, available: true };
        const list = found.get(messageId);
        if (list === undefined) found.set(messageId, [view]); else list.push(view);
      }
      return found;
    },

    insertItems(conversationId, turnId, messageId, place, list) {
      let next = place;
      for (const [index, use] of list.entries()) {
        run(
          "INSERT INTO item (id, conversationId, turnId, place, kind, origin, providerItemId, receivedAt, providerAt, body, workerId, blob) VALUES (?, ?, ?, ?, 'attachment', 'local', NULL, NULL, NULL, ?, NULL, ?)",
          use.id, conversationId, turnId, next, JSON.stringify({ attachment: { messageId, index, name: use.name } }), use.hash,
        );
        next += 1;
      }
      return next;
    },

    itemBlobs(conversationId) {
      return all("SELECT DISTINCT blob FROM item WHERE conversationId = ? AND kind = 'attachment' AND blob IS NOT NULL", conversationId).map((row) => String(row['blob']));
    },
  };
}
