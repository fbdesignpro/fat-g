// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's draft in main (docs/planning/_archive/M23.md, Design 2, 5; C14, C18, C31–C34, C83, C86; decisions
// 0019, 0030): the images staged into it, and its text as the page hands it over.
//
// Staging (C14). The page reads a pasted or dropped image's bytes and hands them over with a name, if
// the file had one. Main checks the session, the bytes' bound and their header, hashes them, writes
// the file under its hash, then names the image and its use in the draft in one transaction, which
// checks the message's bounds beside every other staging. Stagings of one draft are taken one at a
// time, in the order they came, and each captures the draft's generation: one that finishes after the
// draft was sent, queued, cleared or swapped attaches to nothing, so no late image lands in another
// draft or brings back a draft the user emptied (C18). A file left by a staging that attached nothing
// is removed at once where no row names it, and otherwise by the next open's sweep.
//
// Text (C31, C86). The page gathers its edits for 300 ms and hands over the latest at a revision of
// its own numbering; main holds the latest it took and writes it at most every two seconds, at a
// session switch and at the quit. An update at or below the revision held is late, and changes
// nothing: a delayed one cannot bring back what was sent, queued or swapped. A write that fails marks
// the session `failing` (C34) and keeps the text in main's memory for the run; nothing is sent for it
// that the store did not take, since a Send's acceptance writes its own text in its own transaction.
//
// Electron-free, and no provider is named: the store, the images' folder and what the runtime knows
// of a session arrive as options. Nothing of a draft is logged: counts and kinds only (C75).
import { type AttachmentStageResult, attachmentName, MAX_IMAGE_BYTES, type StageRefusal } from '@shared/contracts/attachments';
import { type ChatDraftRequest, type ChatDraftResult, DRAFT_WRITE_MS, type DraftView, EMPTY_DRAFT, type PromptIntent } from '@shared/contracts/composer';
import { type BlobFiles, sha256 } from '../attachments/files';
import { readAttachmentHeader } from '../attachments/headers';
import { type ConversationStore, StorageFailure } from '../conversations/store';
import { errorKind } from '../storage/error-kind';

export type ComposerStore = Pick<ConversationStore, 'status' | 'blob' | 'draft' | 'saveDraft' | 'stageDraft' | 'removeDraftAttachment' | 'clearDraft'>;

export interface ComposerTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ComposerServiceOptions {
  readonly store: ComposerStore;
  readonly blobs: Pick<BlobFiles, 'write' | 'remove'>;
  /** The session is listed. */
  readonly listed: (sessionId: string) => boolean;
  /** It is being removed or completed, or fat-g is quitting: it takes no new image. */
  readonly leaving: (sessionId: string) => boolean;
  /** Its provider's session exists: a conversation row made for its draft does not hold its start (C18). */
  readonly started: (sessionId: string) => boolean;
  /** What the composer shows of a session changed, by main's doing: an image staged or removed, the draft cleared. */
  readonly changed: (sessionId: string) => void;
  /** A draft's write failed (C34): the session's chat says `failing`. */
  readonly failing: (sessionId: string) => void;
  /** A draft's text was written: whether the session's draft holds something may have changed (C83). */
  readonly written?: (sessionId: string) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: ComposerTimers;
  readonly writeMs?: number;
  /** Counts and kinds only (C75): never a text, a name, a hash or a size in pixels. */
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

export interface ComposerService {
  /** An image staged into the session's draft (C14): its descriptor, or why not. */
  stage(sessionId: string, bytes: Uint8Array, name?: string): Promise<AttachmentStageResult>;
  /** The session's draft as main holds it: what the store has, with the text it took and has not written yet. */
  draft(sessionId: string): DraftView;
  /** A change of the draft (C86): its text and intent, an image taken out, a clear, or a write now. */
  update(request: ChatDraftRequest): ChatDraftResult;
  /** Every draft main holds and has not written, written now: what a session switch and the quit ask (C31). */
  flush(sessionId?: string): void;
  /**
   * The draft was taken by an acceptance at this revision — a Send, a Queue, an Edit's swap (C56,
   * C86): stagings under way attach to nothing, and text held at or below the revision goes.
   */
  consumed(sessionId: string, revision: number): void;
  /** Resolves once every staging the session's draft has under way has answered (C18): what a Send waits for. */
  settled(sessionId: string): Promise<void>;
  /**
   * Plan released in the draft by main (decision 0029): its plan was carried out elsewhere or discarded.
   * Written at once at the next revision, the text as it stands; a draft not pressed is left alone.
   */
  releasePlan(sessionId: string): void;
  /** The session is no longer listed: what main held of its draft goes, unwritten. Its rows are its removal's. */
  forget(sessionId: string): void;
  dispose(): void;
}

interface Held {
  /** The draft's generation: raised by every acceptance and clear, which a staging under way finds changed. */
  generation: number;
  /** Text the page handed over and main has not written. */
  pending: { readonly revision: number; readonly text: string; readonly intent: PromptIntent } | null;
  timer: unknown;
  /** The stagings of the draft, one after the other. */
  chain: Promise<unknown>;
}

const defaultTimers: ComposerTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function createComposerService(options: ComposerServiceOptions): ComposerService {
  const { store, blobs, listed, leaving, started, changed, failing } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const timers = options.timers ?? defaultTimers;
  const writeMs = options.writeMs ?? DRAFT_WRITE_MS;
  const log = options.log ?? console;
  const held = new Map<string, Held>();
  const counts = new Map<string, number>();

  /** The first, the tenth, the hundredth (C75). */
  function count(what: string): void {
    const total = (counts.get(what) ?? 0) + 1;
    counts.set(what, total);
    if (/^10*$/.test(String(total))) log.info(`[composer] ${what}, ${total} so far`);
  }

  function entry(sessionId: string): Held {
    let found = held.get(sessionId);
    if (found === undefined) {
      found = { generation: 0, pending: null, timer: undefined, chain: Promise.resolve() };
      held.set(sessionId, found);
    }
    return found;
  }

  const refused = (reason: StageRefusal): AttachmentStageResult => ({ status: 'refused', reason });

  /** The store's draft, or none while the store cannot say. */
  function stored(sessionId: string): DraftView {
    if (store.status().kind !== 'ok') return EMPTY_DRAFT;
    try {
      const draft = store.draft(sessionId);
      return draft === null ? EMPTY_DRAFT : { revision: draft.revision, text: draft.text, intent: draft.intent, attachments: draft.attachments };
    } catch {
      return EMPTY_DRAFT;
    }
  }

  function view(sessionId: string): DraftView {
    const draft = stored(sessionId);
    const pending = held.get(sessionId)?.pending ?? null;
    return pending === null || pending.revision <= draft.revision ? draft : { ...draft, revision: pending.revision, text: pending.text, intent: pending.intent };
  }

  /** The text main took, written now. False where the write failed: it stays held, and the session is failing (C34). */
  function write(sessionId: string, found: Held): boolean {
    timers.clear(found.timer);
    found.timer = undefined;
    const pending = found.pending;
    if (pending === null) return true;
    try {
      store.saveDraft(sessionId, pending.revision, { text: pending.text, intent: pending.intent }, now(), started(sessionId));
      if (found.pending === pending) found.pending = null;
      options.written?.(sessionId);
      return true;
    } catch (error) {
      count(`draft not saved (${errorKind(error)})`);
      failing(sessionId);
      return false;
    }
  }

  function arm(sessionId: string, found: Held): void {
    if (found.timer !== undefined) return;
    found.timer = timers.set(() => { found.timer = undefined; write(sessionId, found); }, writeMs);
  }

  /** A staging's own work, its turn come. */
  async function stageNow(sessionId: string, bytes: Uint8Array, name: string | null, generation: number): Promise<AttachmentStageResult> {
    const header = readAttachmentHeader(bytes);
    if (header.kind === 'refused') return refused(header.reason);
    const hash = sha256(bytes);
    try {
      await blobs.write(hash, header.mediaType, bytes);
    } catch (error) {
      count(`image not kept (${errorKind(error)})`);
      return refused('storage-failed');
    }
    /** The file, where no row names it: this staging attached nothing. */
    const drop = (): void => { try { if (store.blob(hash) === null) blobs.remove(hash, header.mediaType); } catch { /* the next open's sweep */ } };
    // After the write's wait: the session still listed and staying, and its draft still the one this staging began for.
    if (!listed(sessionId)) { drop(); return refused('unknown-session'); }
    if (leaving(sessionId) || entry(sessionId).generation !== generation) { drop(); return refused('busy'); }
    if (store.status().kind !== 'ok') { drop(); return refused('conversations-refused'); }
    const use = { id: newId(), name };
    const at = now();
    let savedName: string;
    try {
      savedName = store.stageDraft(sessionId, { hash, mediaType: header.mediaType, bytes: bytes.byteLength, width: header.width, height: header.height, stagedAt: at }, use, at, started(sessionId));
    } catch (error) {
      drop();
      if (error instanceof StorageFailure && (error.kind === 'too-many' || error.kind === 'too-large')) return refused(error.kind);
      count(`image not kept (${errorKind(error)})`);
      failing(sessionId);
      return refused('storage-failed');
    }
    count(`attachment staged (${header.mediaType.slice('image/'.length)})`);
    changed(sessionId);
    return { status: 'staged', attachment: { id: use.id, hash, mediaType: header.mediaType, bytes: bytes.byteLength, width: header.width, height: header.height, name: savedName } };
  }

  return {
    stage(sessionId, bytes, rawName) {
      if (!listed(sessionId)) return Promise.resolve(refused('unknown-session'));
      if (leaving(sessionId)) return Promise.resolve(refused('busy'));
      if (store.status().kind !== 'ok') return Promise.resolve(refused('conversations-refused'));
      // The bound again, on the view main holds, before anything is copied (C79).
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) return Promise.resolve(refused('too-large'));
      const found = entry(sessionId);
      const generation = found.generation;
      const name = attachmentName(rawName);
      const run = found.chain.then(() => stageNow(sessionId, bytes, name, generation), () => stageNow(sessionId, bytes, name, generation));
      found.chain = run.catch(() => undefined);
      return run.catch((): AttachmentStageResult => refused('storage-failed'));
    },

    draft: view,

    update(request) {
      const { sessionId } = request;
      if (!listed(sessionId)) return { status: 'refused', reason: 'unknown-session' };
      if (store.status().kind !== 'ok') return { status: 'refused', reason: 'conversations-refused' };
      const found = entry(sessionId);
      switch (request.op) {
        case 'text': {
          // Late: at or below what main holds, it changes nothing (C86).
          if (request.revision <= view(sessionId).revision) return { status: 'saved', draft: view(sessionId) };
          found.pending = { revision: request.revision, text: request.prompt, intent: request.intent };
          arm(sessionId, found);
          return { status: 'saved', draft: view(sessionId) };
        }
        case 'remove': {
          if (leaving(sessionId)) return { status: 'refused', reason: 'busy' };
          try {
            if (!store.removeDraftAttachment(sessionId, request.attachmentId, now())) return { status: 'refused', reason: 'unknown-attachment' };
          } catch (error) {
            count(`draft not saved (${errorKind(error)})`);
            failing(sessionId);
            return { status: 'refused', reason: 'storage-failed' };
          }
          changed(sessionId);
          return { status: 'saved', draft: view(sessionId) };
        }
        case 'clear': {
          found.generation += 1;
          if (found.pending !== null && found.pending.revision <= request.revision) found.pending = null;
          try {
            store.clearDraft(sessionId, request.revision, now());
          } catch (error) {
            count(`draft not saved (${errorKind(error)})`);
            failing(sessionId);
            return { status: 'refused', reason: 'storage-failed' };
          }
          changed(sessionId);
          return { status: 'saved', draft: view(sessionId) };
        }
        case 'flush': {
          if (!write(sessionId, found)) return { status: 'refused', reason: 'storage-failed' };
          return { status: 'saved', draft: view(sessionId) };
        }
      }
    },

    flush(sessionId) {
      for (const [id, found] of held) if (sessionId === undefined || id === sessionId) write(id, found);
    },

    consumed(sessionId, revision) {
      const found = entry(sessionId);
      found.generation += 1;
      if (found.pending !== null && found.pending.revision <= revision) { found.pending = null; timers.clear(found.timer); found.timer = undefined; }
    },

    settled(sessionId) {
      return held.get(sessionId)?.chain.then(() => undefined) ?? Promise.resolve();
    },

    releasePlan(sessionId) {
      if (!listed(sessionId) || store.status().kind !== 'ok') return;
      const current = view(sessionId);
      if (!current.intent.plan) return;
      const found = entry(sessionId);
      found.pending = { revision: current.revision + 1, text: current.text, intent: { ...current.intent, plan: false } };
      if (write(sessionId, found)) changed(sessionId);
    },

    forget(sessionId) {
      const found = held.get(sessionId);
      if (found === undefined) return;
      // Kept, with its generation raised: a staging still under way finds its draft gone.
      timers.clear(found.timer);
      found.timer = undefined;
      found.pending = null;
      found.generation += 1;
    },

    dispose() {
      for (const found of held.values()) timers.clear(found.timer);
    },
  };
}
