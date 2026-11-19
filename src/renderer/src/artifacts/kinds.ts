// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The built-in kinds of tab (docs/planning/_archive/M19b.md, Design 1; C4): the one file of this folder that
// names a kind. Adding one is a folder of its own under this one and a line here
// (docs/adding-a-tab-kind.md); the pane, its tab list, its store and the opener name none, and
// tests/architecture/artifact-kinds.test.ts holds them to it.
import { agentsKind } from './agents';
import { asideKind } from './aside';
import { fileKind } from './file';
import { imageKind } from './image';
import { planKind } from './plan';
import type { TabKind } from './tab-kind';

// A worker's own kind retired with M106 (C4): its thread unfolds in the Sub-agents tab.
export const BUILT_IN_KINDS: readonly TabKind[] = [fileKind, asideKind, agentsKind, planKind, imageKind];
