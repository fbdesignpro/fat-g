// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The `agents` kind (docs/planning/_archive/M100.md, round 8; C78; docs/planning/_archive/M106.md, Design 6, 7): a
// session's Sub-agents tab — its sub-agents stacked as the session list stacks its capsules, each
// unfolding its thread under its row, and the grants fat-g sent — which the model column held until
// the chat's list ran over it (C76). A session has one: its reference is null. It opens by itself, by
// its watcher, as soon as the session lists a sub-agent or has a live grant, and cannot be closed
// (M106, C1, C2): it goes with its session.
import { AGENTS_KIND } from '../opener';
import { tabKind } from '../tab-kind';
import { AgentsBody, type AgentsViewState } from './AgentsBody';
import { AgentsWatcher } from './AgentsWatcher';
import { AGENTS_WORDS } from './words';

export const agentsKind = tabKind<null, AgentsViewState>({ id: AGENTS_KIND, title: () => AGENTS_WORDS.title, Body: AgentsBody, Watcher: AgentsWatcher, closable: false });
