// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The model chooser's shape (docs/planning/_archive/M14.md, Design 8, "Size"; C119), in capsules. The
// chooser never scrolls: it is as large as its capsules need. Pure: whatever holds the chooser measures
// the space it may give it, this decides the columns.
//
//   • Each provider fills one column, top to bottom, under its name. The chooser grows with the
//     longest list, up to the space it has, before a provider continues in another column.
//   • Past what that space holds, the columns narrow, and the names keep their ellipsis — where what
//     holds the chooser cannot scroll. Where it can, the capsules keep their full width and the chooser
//     takes more rows than the height it was given. Either way the capsules never run under the levels:
//     past the least a capsule can be, the chooser takes more rows.
//   • A provider with more than one switched-on account shows a button for each under its name
//     (M14b, C45). The buttons have a fixed width and wrap within their provider's columns; the band
//     they take is as tall as the provider that needs the most lines, so every column's capsules start
//     level. With no such provider there is no band.

/**
 * A model's capsule: the 60 px avatar in its 1 px frame, then its name on one line and its CLI's
 * description on two.
 */
export const TILE_WIDTH = 224;
export const TILE_HEIGHT = 62;
/** Between two capsules, down a column and across columns. */
export const TILE_GAP = 8;
export const MAX_MODEL_ROWS = 8;
/** The Show more control and the gap above it. */
export const MORE_HEIGHT = 40;
/** The narrowest a capsule gets: its avatar, and a few characters before the ellipsis. */
export const MIN_TILE_WIDTH = 150;
/** The column of effort levels, on the right, and the space between it and the capsules. */
export const LEVELS_WIDTH = 220;
export const LEVELS_GAP = 12;
/** A 28px effort row and its 4px gap, so the next hover background clears the selection frame. */
export const LEVEL_HEIGHT = 32;
/** The row of a provider's name, above its capsules, and of the word Effort above the levels. */
export const HEADING_HEIGHT = 24;
/** Clearance below the heading/account band for the first capsule's selection frame. */
export const HEADING_GAP = 8;
/** An account button, one line with an ellipsis (M14b, C45). */
export const ACCOUNT_WIDTH = 96;
export const ACCOUNT_HEIGHT = 24;

export interface ChooserColumn {
  /** Which provider's capsules it holds, by its place among the groups. */
  readonly group: number;
  /** The first of that provider's capsules it holds, and how many. */
  readonly from: number;
  readonly count: number;
  /** Whether it is the provider's first column, which carries its name. */
  readonly first: boolean;
}

export interface ChooserShape {
  /** Capsules per column. */
  readonly rows: number;
  readonly columns: readonly ChooserColumn[];
  readonly tileWidth: number;
  /** How tall the account buttons' band is, under the providers' names; 0 when no provider shows any. */
  readonly band: number;
  /** The chooser's own size, without whatever holds it. */
  readonly width: number;
  readonly height: number;
}

/** How wide `count` columns side by side are, the gaps between them included. */
export const spanWidth = (count: number, tileWidth: number): number => (count <= 0 ? 0 : count * tileWidth + (count - 1) * TILE_GAP);

/** Where the column at `index` starts, from the chooser's left edge. */
export const columnLeft = (index: number, tileWidth: number): number => index * (tileWidth + TILE_GAP);

function columnsOf(groups: readonly number[], rows: number, limits?: readonly number[]): ChooserColumn[] {
  return groups.flatMap((count, group) =>
    Array.from({ length: Math.min(limits?.[group] ?? Infinity, Math.ceil(count / rows)) }, (_unused, index): ChooserColumn => ({ group, from: index * rows, count: Math.min(rows, count - index * rows), first: index === 0 })),
  );
}

/**
 * The band the account buttons take in a shape: each provider's buttons wrap within its own columns,
 * and the band is as tall as the provider that needs the most lines.
 */
function bandOf(columns: readonly ChooserColumn[], tileWidth: number, accounts: readonly number[]): number {
  const lines = accounts.map((count, group) => {
    const width = spanWidth(columns.filter((column) => column.group === group).length, tileWidth);
    // One account has no button; a provider with no column shows nothing at all.
    if (count < 2 || width === 0) return 0;
    return Math.ceil(count / Math.max(1, Math.floor(width / ACCOUNT_WIDTH)));
  });
  return Math.max(0, ...lines) * ACCOUNT_HEIGHT;
}

/**
 * The columns for these providers' capsule counts, in the space the chooser may take. `levels` is how
 * many effort levels the longest list holds. `accounts` is how many account buttons each provider
 * shows: none, or two and more (M14b, C45).
 * `columnLimits` enables the chooser's progressive reveal: at most eight rows, with room for
 * Show more while a provider still has hidden models.
 */
export function chooserShape(groups: readonly number[], available: { readonly width: number; readonly height: number }, levels = 0, accounts: readonly number[] = [], scrolls = false, columnLimits?: readonly number[]): ChooserShape {
  // A dialog already scrolls its body: its columns can keep eight rows even when the content
  // above the chooser leaves little height. The anchored popup must fit the height it is given.
  const fitted = fittingShape(groups, scrolls && columnLimits !== undefined ? { ...available, height: Infinity } : available, levels, accounts, columnLimits);
  const fits = (shape: ChooserShape): boolean => (scrolls ? shape.tileWidth === TILE_WIDTH : shape.width <= available.width);
  if (fits(fitted)) return fitted;
  // Too wide for its space: as many more rows as it takes, the height given no longer the bound.
  const most = Math.min(columnLimits === undefined ? Infinity : MAX_MODEL_ROWS, Math.max(1, ...groups));
  for (let rows = fitted.rows + 1; rows < most; rows += 1) {
    const shape = shapeOf(groups, available, levels, rows, accounts, columnLimits);
    if (fits(shape)) return shape;
  }
  return shapeOf(groups, available, levels, most, accounts, columnLimits);
}

/** The tallest shape that fits the height given, its columns narrowed to fit the width as far as a capsule can be. */
function fittingShape(groups: readonly number[], available: { readonly width: number; readonly height: number }, levels: number, accounts: readonly number[], columnLimits?: readonly number[]): ChooserShape {
  const fitting = Math.floor((available.height - HEADING_HEIGHT - HEADING_GAP + TILE_GAP) / (TILE_HEIGHT + TILE_GAP));
  const maxRows = Math.min(columnLimits === undefined ? Infinity : MAX_MODEL_ROWS, Math.max(1, ...groups), Math.max(1, fitting));
  // Account wrapping depends on the columns too. Evaluate each height with its actual band,
  // choosing the tallest that fits rather than oscillating between two band sizes.
  for (let rows = maxRows; rows > 1; rows -= 1) {
    const shape = shapeOf(groups, available, levels, rows, accounts, columnLimits);
    if (shape.height <= available.height) return shape;
  }
  return shapeOf(groups, available, levels, 1, accounts, columnLimits);
}

function shapeOf(groups: readonly number[], available: { readonly width: number; readonly height: number }, levels: number, rows: number, accounts: readonly number[], columnLimits?: readonly number[]): ChooserShape {
  const room = Math.max(MIN_TILE_WIDTH, available.width - LEVELS_WIDTH - LEVELS_GAP);
  const fits = Math.max(1, Math.floor((room + TILE_GAP) / (TILE_WIDTH + TILE_GAP)));
  // A provider with no capsule has no column.
  const columns = columnsOf(groups, rows, columnLimits);
  // And only then narrower columns.
  const tileWidth = columns.length <= fits ? TILE_WIDTH : Math.max(MIN_TILE_WIDTH, Math.floor((room - (columns.length - 1) * TILE_GAP) / columns.length));
  const band = bandOf(columns, tileWidth, accounts);
  const tallest = Math.max(1, ...columns.map((column) => column.count));
  const more = groups.some((count, group) => count > columns.filter((column) => column.group === group).reduce((total, column) => total + column.count, 0));
  const tiles = band + tallest * TILE_HEIGHT + (tallest - 1) * TILE_GAP + (more ? MORE_HEIGHT : 0);
  return {
    rows,
    columns,
    tileWidth,
    band,
    width: spanWidth(Math.max(1, columns.length), tileWidth) + LEVELS_GAP + LEVELS_WIDTH,
    height: HEADING_HEIGHT + HEADING_GAP + Math.max(tiles, levels * LEVEL_HEIGHT),
  };
}
