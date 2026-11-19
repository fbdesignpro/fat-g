// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The selected session's grants, in the page (docs/planning/_archive/M22.md, Design 5, 10; C57, C86, C92):
// the session grants fat-g sent, as the session's last read listed them and as its approvals'
// pushes have changed them since. What the list in the avatar column draws, and what the mode menu
// counts before a change that restarts the session's process.
//
// It is fat-g's record of what it sent, and no reading of the CLI. A grant is listed only where its
// decision's reply was delivered (`grantSent`), which is main's to say; whether it is live is main's
// too, laid over each read and each push — the page works out neither. One whose reply was not
// delivered is on its card alone, and is never here (C92).
//
// Held as the chat's asides and its workers' waiting questions are, in the page's memory for the
// run: set by the chat's own read, and by each approval's push — the session's own, and a worker's,
// which the chat's list passes.
import { create } from 'zustand';
import type { ConversationItem } from '@shared/contracts/conversation';
import { approvalOf, grantSent, type SessionGrant } from '@shared/contracts/interaction';

export interface GrantsState {
  /** The session these are of, or null before any read. */
  readonly sessionId: string | null;
  /** Oldest first, as the read lists them. */
  readonly grants: readonly SessionGrant[];
}

const NOTHING: GrantsState = { sessionId: null, grants: [] };
export const NO_GRANTS: readonly SessionGrant[] = [];

export const useGrantsStore = create<GrantsState>()(() => NOTHING);

const sameGrant = (a: SessionGrant, b: SessionGrant | undefined): boolean =>
  b !== undefined && a.itemId === b.itemId && a.covers === b.covers && a.decidedAt === b.decidedAt && a.confirmed === b.confirmed && a.live === b.live;
const same = (a: readonly SessionGrant[], b: readonly SessionGrant[]): boolean => a.length === b.length && a.every((grant, index) => sameGrant(grant, b[index]));

/** What a read of the session's chat listed. Nothing changes, and nothing is drawn again, for a list that reads the same. */
export function setGrants(sessionId: string, grants: readonly SessionGrant[]): void {
  useGrantsStore.setState((held) => (held.sessionId === sessionId && same(held.grants, grants) ? held : { sessionId, grants }));
}

/**
 * An approval's item, as a push carried it (C57, C92): listed, as it now reads, while its grant was
 * sent — its reply delivered — and not otherwise. A push of anything else changes nothing.
 */
export function noteGrant(sessionId: string, item: Pick<ConversationItem, 'id' | 'interaction'>): void {
  const body = approvalOf(item);
  if (body === null) return;
  const held = useGrantsStore.getState();
  const listed = held.sessionId === sessionId ? held.grants : NO_GRANTS;
  const at = listed.findIndex((grant) => grant.itemId === item.id);
  if (!grantSent(body) || body.grant === null) {
    if (at !== -1) useGrantsStore.setState({ sessionId, grants: listed.filter((grant) => grant.itemId !== item.id) });
    return;
  }
  const grant: SessionGrant = { itemId: item.id, covers: body.grant.covers, decidedAt: body.decidedAt, confirmed: body.confirmedAt !== null, live: body.grant.live };
  if (at === -1) useGrantsStore.setState({ sessionId, grants: [...listed, grant] });
  else if (!sameGrant(grant, listed[at])) useGrantsStore.setState({ sessionId, grants: listed.map((entry, index) => (index === at ? grant : entry)) });
}

/** Another session is shown, or none: nothing of the last one's stays. */
export function clearGrants(sessionId: string): void {
  useGrantsStore.setState((held) => (held.sessionId === sessionId ? NOTHING : held));
}

/** The grants of a session, where they are the ones held: none for any other session. */
export function useGrants(sessionId: string | null): readonly SessionGrant[] {
  return useGrantsStore((state) => (sessionId !== null && state.sessionId === sessionId ? state.grants : NO_GRANTS));
}

/** For tests: nothing held. */
export function resetGrants(): void {
  useGrantsStore.setState(NOTHING);
}
