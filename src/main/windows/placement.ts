// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where each window opens when it has nowhere (reachable) to return to, and how small it may get
// (bounds.ts). Pure, so bounds.test.ts checks these very policies without loading Electron.
import type { PlacementPolicy, Size } from './bounds';

/**
 * The Main window (docs/planning/_archive/M100.md, Design 2; C57). The minimum, for now, leaves the session
 * window about 887 px beside the 345 px project column and inside the one-cell margin: with a tab
 * open, each half is about 442 px, and the chat column about 266 px beside the 176 px model column — where the status bar cuts its
 * words and the prompt-type bar wraps (C58). The default stays above it.
 */
export const MAIN_PLACEMENT: PlacementPolicy = {
  defaultSize: { width: 1440, height: 900 },
  minSize: { width: 1280, height: 640 },
  anchor: 'center',
};

/**
 * The Pet (decision 0010): opaque, not transparent (docs/planning/_archive/phase-1/phase-1-m2.md), and
 * not resizable by the user — main sizes it to its list (src/shared/contracts/pet.ts, pet-fit.ts), so a
 * saved size means nothing and only the saved position is kept. Top-right of the primary display,
 * clear of the edges, when it has nowhere to return to.
 */
export function petPlacement(size: Size): PlacementPolicy {
  return { defaultSize: size, minSize: size, anchor: 'top-right', margin: 48, fixedSize: true };
}
