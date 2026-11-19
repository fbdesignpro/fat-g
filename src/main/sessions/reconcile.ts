// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What each store takes from the other (docs/planning/_archive/M18.md, Design 7; C27–C29, C54): a pure
// function of a session's record and of what the conversation store holds for its id. Each fact has
// one home — the record says which sessions exist and whether a prompt starts or resumes, the store
// holds the conversation and each turn's ends — and neither is rebuilt from the other but as here:
//
//   The record                      The store                What happens
//   no reference                    a reference              the record is asked to take it, by its once-only rule
//   a reference                     any                      nothing: the record's is never replaced
//   no last turn, or an older one   a newer local turn       the record's last turn becomes it, with the session's end if the store has one
//   the same turn, no end           the session's end        written into the record
//   the same turn, an end           no session's end         written into the store
//   the same turn, no end           the provider's end alone nothing: the record reads STOPPED (M14, C74)
//   a turn                          no such turn             nothing
//
// A provider's end is never written into the record as the session's, and no outcome is invented
// (C16, C29): a turn the provider completed while its worker still ran, fat-g then killed, has no
// end in the record, and the session reads STOPPED.
import type { LastTurn, TurnOutcome } from '@shared/contracts/sessions';
import type { StoredConversation, StoredTurn } from '../conversations/store';
import type { SessionRecord } from '../records/format';

export interface StoreFacts {
  readonly conversation: StoredConversation | null;
  /** The newest turn fat-g ran itself, or null. */
  readonly lastLocal: StoredTurn | null;
  /** The store's own row for the record's last turn, or null when it has none. */
  readonly recordTurn: StoredTurn | null;
}

export interface Reconciliation {
  /** The store's reference, for a record that has none (C28): the runtime keeps it, and the record is asked to. */
  readonly reference: { readonly reference: string; readonly folder: string; readonly configFolder: string | null } | null;
  /** What the record's last turn becomes, or null to leave it. */
  readonly lastTurn: LastTurn | null;
  /** The session's end the record holds and the store lacks. */
  readonly storeEnd: { readonly turnId: string; readonly at: number; readonly outcome: TurnOutcome } | null;
}

const NOTHING: Reconciliation = { reference: null, lastTurn: null, storeEnd: null };

/** The record's last turn as the store has a turn: the session's start and end alone. */
function asLastTurn(turn: StoredTurn, startedAt: number): LastTurn {
  const ended = turn.sessionEndedAt !== null && turn.sessionOutcome !== null;
  return { turnId: turn.id, startedAt, endedAt: ended ? turn.sessionEndedAt : null, outcome: ended ? turn.sessionOutcome : null };
}

export function reconcile(record: Pick<SessionRecord, 'reference' | 'lastTurn'>, store: StoreFacts): Reconciliation {
  const { conversation, lastLocal, recordTurn } = store;
  if (conversation === null) return NOTHING;
  const reference = record.reference === null && conversation.reference !== null && conversation.folder !== null
    ? { reference: conversation.reference, folder: conversation.folder, configFolder: conversation.configFolder }
    : null;

  const turn = record.lastTurn;
  // A turn only the store holds, newer than the record's: the record's write of its start never landed.
  if (lastLocal !== null && lastLocal.acceptedAt !== null && (turn === null || (recordTurn !== null && recordTurn.id !== lastLocal.id && recordTurn.place < lastLocal.place))) {
    return { reference, lastTurn: asLastTurn(lastLocal, lastLocal.acceptedAt), storeEnd: null };
  }
  // A turn the store does not have: nothing.
  if (turn === null || recordTurn === null) return { ...NOTHING, reference };

  const storeEnded = recordTurn.sessionEndedAt !== null && recordTurn.sessionOutcome !== null;
  if (turn.endedAt === null || turn.outcome === null) return { reference, lastTurn: storeEnded ? asLastTurn(recordTurn, turn.startedAt) : null, storeEnd: null };
  if (!storeEnded) return { reference, lastTurn: null, storeEnd: { turnId: recordTurn.id, at: turn.endedAt, outcome: turn.outcome } };
  return { ...NOTHING, reference };
}
