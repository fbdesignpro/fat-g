// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The `plan` kind (docs/planning/_archive/M22b.md, Design 7; C25, C26, C60, C73; decision 0029): a plan's
// tab, its versions read range by range from main's plan store. Opened from a plan's line, a
// prompt's folded block and the decision panel, and by its watcher when a plan arrives or is
// brought in. Its reference is the plan's id; its title is the plan's own, which its body sets once
// it is read.
import { PLAN_KIND } from '../opener';
import { tabKind } from '../tab-kind';
import { PlanBody, type PlanViewState } from './PlanBody';
import { PlanWatcher } from './PlanWatcher';
import { PLAN_TAB_WORDS } from './words';

export const planKind = tabKind<string, PlanViewState>({ id: PLAN_KIND, title: () => PLAN_TAB_WORDS.title, Body: PlanBody, Watcher: PlanWatcher });
