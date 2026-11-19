// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A summary source (docs/planning/_archive/M14.md, Design 4; C25, C26): whatever tells main what a session is
// doing. In M14 that is the demo source alone; M15's and M16's adapters attach the same way, and how
// a CLI's frames map to these events is theirs.
//
// A source is handed the service's `apply` through `subscribe`. It never imports the records store:
// what an event means for a record is the service's to say.
import type { SessionEvent } from '@shared/contracts/sessions';

export type SessionEventListener = (event: SessionEvent) => void;

export interface SummarySource {
  /** Starts sending this source's events to `listener`. Returns the function that stops it. */
  subscribe(listener: SessionEventListener): () => void;
}
