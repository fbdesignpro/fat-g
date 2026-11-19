// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13, V23 (docs/planning/_archive/M18.md, Design 7; C27–C29, C54): what each store takes from the other, as
// the table has it. A pure function: the faults that make the two disagree, and the restarts after
// them, are in tests/sessions/two-stores.test.ts.
import { describe, expect, it } from 'vitest';
import type { LastTurn } from '@shared/contracts/sessions';
import type { StoredConversation, StoredTurn } from '../conversations/store';
import { reconcile, type StoreFacts } from './reconcile';

const conversation = (patch: Partial<StoredConversation> = {}): StoredConversation => ({ id: 's', reference: null, folder: null, configFolder: null, startHeld: true, reachedStart: false, removing: false, createdAt: 1, parentId: null, mode: null, ...patch });
const turn = (id: string, place: number, patch: Partial<StoredTurn> = {}): StoredTurn => ({
  id, conversationId: 's', place, origin: 'local', providerTurnId: null, acceptedAt: 100 * place, providerTook: true, providerStartedAt: null, providerEndedAt: null, endReceivedAt: null,
  providerOutcome: null, providerDurationMs: null, elapsedMs: null, sessionEndedAt: null, sessionOutcome: null, reached: false, gap: false, own: false, mode: null, plan: false, ...patch,
});
const last = (turnId: string, patch: Partial<LastTurn> = {}): LastTurn => ({ turnId, startedAt: 100, endedAt: null, outcome: null, ...patch });
const facts = (patch: Partial<StoreFacts> = {}): StoreFacts => ({ conversation: conversation(), lastLocal: null, recordTurn: null, ...patch });
const NOTHING = { reference: null, lastTurn: null, storeEnd: null };

describe('the reference (C28)', () => {
  const held = conversation({ reference: 'thread-9', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\Accounts\\work' });

  it('gives a record with no reference the one the store holds, with its two folders', () => {
    expect(reconcile({ reference: null, lastTurn: null }, facts({ conversation: held }))).toEqual({ ...NOTHING, reference: { reference: 'thread-9', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\Accounts\\work' } });
  });

  it('never replaces the record’s own', () => {
    expect(reconcile({ reference: 'the-records-own', lastTurn: null }, facts({ conversation: held }))).toEqual(NOTHING);
  });

  it('takes nothing from a store that has no conversation for the session', () => {
    expect(reconcile({ reference: null, lastTurn: last('t1') }, facts({ conversation: null }))).toEqual(NOTHING);
  });
});

describe('the last turn (C29, C54)', () => {
  it('gives a record with no last turn the newest turn fat-g ran, without an end when the store has none', () => {
    const local = turn('t1', 1);
    expect(reconcile({ reference: null, lastTurn: null }, facts({ lastLocal: local }))).toEqual({ ...NOTHING, lastTurn: { turnId: 't1', startedAt: 100, endedAt: null, outcome: null } });
  });

  it('gives a record with an older turn the newer one, with the session’s end where the store has it', () => {
    const older = turn('t1', 1, { sessionEndedAt: 150, sessionOutcome: 'completed' });
    const newer = turn('t2', 2, { sessionEndedAt: 260, sessionOutcome: 'interrupted' });
    expect(reconcile({ reference: null, lastTurn: last('t1', { endedAt: 150, outcome: 'completed' }) }, facts({ lastLocal: newer, recordTurn: older }))).toEqual({ ...NOTHING, lastTurn: { turnId: 't2', startedAt: 200, endedAt: 260, outcome: 'interrupted' } });
  });

  it('writes the session’s end only the store holds into the record', () => {
    const same = turn('t1', 1, { sessionEndedAt: 190, sessionOutcome: 'stopped' });
    expect(reconcile({ reference: null, lastTurn: last('t1') }, facts({ lastLocal: same, recordTurn: same }))).toEqual({ ...NOTHING, lastTurn: { turnId: 't1', startedAt: 100, endedAt: 190, outcome: 'stopped' } });
  });

  it('writes the session’s end only the record holds into the store', () => {
    const same = turn('t1', 1);
    expect(reconcile({ reference: null, lastTurn: last('t1', { endedAt: 190, outcome: 'completed' }) }, facts({ lastLocal: same, recordTurn: same }))).toEqual({ ...NOTHING, storeEnd: { turnId: 't1', at: 190, outcome: 'completed' } });
  });

  it('never writes the provider’s end into the record as the session’s: the record stays without an end, and reads STOPPED', () => {
    // The provider completed the turn while its worker still ran; fat-g was then killed.
    const same = turn('t1', 1, { providerOutcome: 'completed', endReceivedAt: 120 });
    expect(reconcile({ reference: null, lastTurn: last('t1') }, facts({ lastLocal: same, recordTurn: same }))).toEqual(NOTHING);
  });

  it('does nothing when both hold the same end, and nothing for a turn the store does not have', () => {
    const same = turn('t1', 1, { sessionEndedAt: 190, sessionOutcome: 'completed' });
    expect(reconcile({ reference: null, lastTurn: last('t1', { endedAt: 190, outcome: 'completed' }) }, facts({ lastLocal: same, recordTurn: same }))).toEqual(NOTHING);
    // The record's turn is one the store never had — the demo source's, or one lost with a store set aside.
    expect(reconcile({ reference: null, lastTurn: last('gone') }, facts({ lastLocal: turn('t5', 5), recordTurn: null }))).toEqual(NOTHING);
  });

  it('takes no turn from the provider’s history as the session’s last: only one fat-g ran', () => {
    // `lastLocal` is the newest LOCAL turn: an imported one, newer by place, is not it.
    expect(reconcile({ reference: null, lastTurn: null }, facts({ lastLocal: null }))).toEqual(NOTHING);
  });

  it('gives both at once: a reference and a turn', () => {
    const held = conversation({ reference: 'thread-9', folder: '/p', configFolder: null });
    const local = turn('t1', 1, { sessionEndedAt: 150, sessionOutcome: 'completed' });
    expect(reconcile({ reference: null, lastTurn: null }, facts({ conversation: held, lastLocal: local }))).toEqual({
      reference: { reference: 'thread-9', folder: '/p', configFolder: null }, lastTurn: { turnId: 't1', startedAt: 100, endedAt: 150, outcome: 'completed' }, storeEnd: null,
    });
  });
});
