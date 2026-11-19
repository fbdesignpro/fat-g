// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's queue, drained (docs/planning/_archive/M23.md, Design 7; C47, C48, C52, C54–C57, C82, C89;
// decision 0019). The entries are the conversation store's; this holds what is in flight of them:
// the one claimed while it is sent, a queue paused on a refusal the user has to remedy, and the
// entries that are a Send now held until the turn can take it.
//
//   idle ─► the first entry claimed ("Sending…") ─► the send path, with every check of a typed prompt's
//            ├─ accepted: its acceptance took it from the queue in its own transaction; the next goes at
//            │  the end of the turn it started
//            ├─ a wait (C89): the claim let go, the entry first as it was; that state's own event wakes it
//            └─ a pause: the claim let go, the queue paused with the refusal's reason until Resume
//
// A held Send now stands first, and goes at the first opportunity: into the running turn as soon as
// that takes a message, or as the next prompt once the session is idle, whichever comes first. A
// pause of the queue behind it does not hold it back.
//
// Nothing here polls or times anything: the runtime wakes a session at each event a wait may end on —
// a turn's or its workers' end, a history check's end, a change of the providers or their modes, a
// setup's or a mode change's end, the turn taking a message. A wake finds a session busy, paused or
// with nothing queued, and does nothing; one that comes while an entry is being sent is run again
// once that send is answered. Electron-free, and no provider is named.
import type { PromptIntent, QueuePause } from '@shared/contracts/composer';

/** The first entry of a session's queue, as the send path takes it: its text, its intent and its images by their uses' ids. */
export interface QueuedInput {
  readonly id: string;
  readonly text: string;
  readonly intent: PromptIntent;
  readonly attachmentIds: readonly string[];
}

/** What became of a queued message's send: accepted, or the send path's refusal. */
export type QueueSent = { readonly status: 'sent' } | { readonly status: 'refused'; readonly reason: string };

export interface QueueDrainHost {
  /** The first entry of the session's queue, or the first of those named; null where it holds none, or the store cannot say. */
  first(sessionId: string, among?: ReadonlySet<string>): QueuedInput | null;
  /** The session may take a prompt as far as the queue can tell: listed, staying, no turn, no workers, nothing its CLI holds. */
  idle(sessionId: string): boolean;
  /** The session's running turn takes a message now. */
  steerable(sessionId: string): boolean;
  /** The entry through the send path: its acceptance takes it from the queue (C54, C56). */
  send(sessionId: string, entry: QueuedInput): Promise<QueueSent>;
  /** A held Send now into the running turn: its acceptance takes it from the queue. */
  steer(sessionId: string, entry: QueuedInput): Promise<QueueSent>;
  /** Whether a refusal is one main is already settling (C89): a wait, which that state's own event ends. */
  waits(sessionId: string, reason: string): boolean;
  /** What the composer shows of the queue changed: the page that shows the session is told. */
  changed(sessionId: string): void;
  /** Counts and kinds only (C75). */
  readonly log?: Pick<Console, 'info'>;
}

export interface QueueDrain {
  /** Something a queued message may wait on happened: the session's first entry goes, where it may. */
  wake(sessionId: string): void;
  /** The entry being sent (C54): it takes no Edit, Remove or move meanwhile. */
  sending(sessionId: string): string | null;
  /** Why the session's queue stopped, until Resume (C89). */
  paused(sessionId: string): QueuePause | null;
  /** Resume after the remedy (C89): false where the queue was not paused. */
  resume(sessionId: string): boolean;
  /** The entry is a Send now held until the turn can take it: it goes at the first opportunity. */
  hold(sessionId: string, entryId: string): void;
  /** The session's held entries, in no order: the queue's own order is the store's. */
  held(sessionId: string): ReadonlySet<string>;
  /** The entry is no longer held: edited, removed, or gone. */
  unhold(sessionId: string, entryId: string): void;
  /** The session's queue is gone — dropped, removed, completed, or its store started fresh (C82): nothing of it is held. */
  forget(sessionId: string): void;
}

const NONE: ReadonlySet<string> = new Set();

export function createQueueDrain(host: QueueDrainHost): QueueDrain {
  const claims = new Map<string, string>();
  const pauses = new Map<string, QueuePause>();
  const holds = new Map<string, Set<string>>();
  /** The sessions woken while an entry of theirs was being sent: woken again once that send is answered. */
  const woken = new Set<string>();
  const counts = new Map<string, number>();

  /** The first, the tenth, the hundredth (C75). */
  function count(what: string): void {
    const total = (counts.get(what) ?? 0) + 1;
    counts.set(what, total);
    if (/^10*$/.test(String(total))) host.log?.info(`[queue] ${what}, ${total} so far`);
  }

  function unhold(sessionId: string, entryId: string): void {
    const held = holds.get(sessionId);
    if (held === undefined) return;
    held.delete(entryId);
    if (held.size === 0) holds.delete(sessionId);
  }

  function wake(sessionId: string): void {
    if (claims.has(sessionId)) { woken.add(sessionId); return; }
    const holding = holds.get(sessionId);
    // A held Send now goes into the turn as soon as that takes a message: the first one held, whatever stands before it.
    if (holding !== undefined && host.steerable(sessionId)) {
      const entry = host.first(sessionId, holding);
      // A plan turn or a chosen skill is never sent now (C64, C88): it goes as any queued message.
      if (entry !== null && (entry.intent.plan || entry.intent.skill !== null)) unhold(sessionId, entry.id);
      else if (entry !== null) { release(sessionId, entry, true); return; }
    }
    if (!host.idle(sessionId)) return;
    // A paused queue waits for Resume (C89); a Send now held in it does not.
    const held = holds.get(sessionId);
    const entry = !pauses.has(sessionId) ? host.first(sessionId) : held === undefined ? null : host.first(sessionId, held);
    if (entry === null) return;
    release(sessionId, entry, false);
  }

  /** The entry claimed ("Sending…") and sent: into the running turn, or as the next prompt. */
  function release(sessionId: string, entry: QueuedInput, into: boolean): void {
    claims.set(sessionId, entry.id);
    host.changed(sessionId);
    const answered = (sent: QueueSent): void => {
      // Let go meanwhile: dropped with its queue, or the session removed.
      if (claims.get(sessionId) !== entry.id) return;
      claims.delete(sessionId);
      if (sent.status === 'sent') {
        unhold(sessionId, entry.id);
        count(into ? 'held message sent now' : 'queued message sent');
      } else if (host.waits(sessionId, sent.reason)) count(`queued message waits (${sent.reason})`);
      else { pauses.set(sessionId, { reason: sent.reason }); count(`queue paused (${sent.reason})`); }
      host.changed(sessionId);
      if (woken.delete(sessionId)) wake(sessionId);
    };
    void (into ? host.steer(sessionId, entry) : host.send(sessionId, entry)).then(answered, () => answered({ status: 'refused', reason: 'storage-failed' }));
  }

  return {
    wake,
    sending: (sessionId) => claims.get(sessionId) ?? null,
    paused: (sessionId) => pauses.get(sessionId) ?? null,
    resume(sessionId) {
      if (!pauses.delete(sessionId)) return false;
      host.changed(sessionId);
      wake(sessionId);
      return true;
    },
    hold(sessionId, entryId) {
      const held = holds.get(sessionId) ?? new Set<string>();
      held.add(entryId);
      holds.set(sessionId, held);
    },
    held: (sessionId) => holds.get(sessionId) ?? NONE,
    unhold,
    forget(sessionId) {
      claims.delete(sessionId);
      pauses.delete(sessionId);
      holds.delete(sessionId);
      woken.delete(sessionId);
    },
  };
}
