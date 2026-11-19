// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// App state with projects and sessions, for the renderer's session tests (M14).
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { CatalogState } from '@shared/contracts/catalog';
import type { ConversationsState } from '@shared/contracts/conversation';
import type { ProjectEntryView, RecordsStatus } from '@shared/contracts/projects';
import type { SessionEntry } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { sessionsState } from '../../../../tests/support/sessions';
import { useAppState } from '../state/store';
import { recordsState } from './records';

export interface ShownState {
  readonly projects?: readonly ProjectEntryView[];
  readonly sessions?: readonly SessionEntry[];
  readonly selectedId?: string | null;
  readonly orphans?: number;
  readonly providers?: readonly ProviderSnapshot[];
  readonly catalog?: CatalogState;
  readonly quitQuestion?: boolean;
  /** The records file's status: read, unless said (M12, C50). */
  readonly recordsStatus?: RecordsStatus;
  /** The conversation store's status and the count of chats without a session (M18, C24); left out unless said. */
  readonly conversations?: ConversationsState;
}

let seq = 0;

/** The snapshot a Main window would hold. Each one is newer than the last, so a window takes it. */
export function stateWith({ projects = [], sessions = [], selectedId = null, orphans = 0, providers, catalog, quitQuestion, recordsStatus, conversations }: ShownState): AppStateSnapshot {
  seq += 1;
  const base = sampleSnapshot(seq, providers);
  return {
    ...base,
    ...(catalog === undefined ? {} : { catalog }),
    records: recordsState(projects, recordsStatus),
    sessions: sessionsState(sessions, selectedId, orphans),
    ...(conversations === undefined ? {} : { conversations }),
    ...(quitQuestion === undefined ? {} : { quitQuestion }),
  };
}

/** Puts that snapshot in the page's store, as a push from main would. */
export function showState(state: ShownState): AppStateSnapshot {
  const snapshot = stateWith(state);
  useAppState.setState({ snapshot, error: null });
  return snapshot;
}
