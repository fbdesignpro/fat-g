// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where the usage strip is scrolled to when its blocks do not all fit (C56). Pure: the strip measures
// itself (measureStrip, replaced in tests — jsdom computes no layout) and these functions decide.
//
// The strip is aligned to the right, so blocks that do not fit are hidden on the left first.
// `scroll` counts from that end: 0 shows the last blocks, and larger values move the row right to
// show earlier ones. An arrow appears on each side that has something hidden; clicking it brings the
// next hidden block on that side fully into view.

export interface StripLayout {
  /** The strip's own width: all the room the blocks may have. */
  readonly outer: number;
  /** Each block's start and width along the row, from 0, in order. */
  readonly blocks: readonly { readonly start: number; readonly width: number }[];
}

export interface StripView {
  readonly overflowing: boolean;
  /** `scroll`, brought within what the layout allows. */
  readonly scroll: number;
  readonly hiddenBefore: boolean;
  readonly hiddenAfter: boolean;
}

/** The width of each arrow, and of the space kept for it: equal to `.arrow` in UsageStrip.module.css. */
export const ARROW_WIDTH = 19;
/** Sub-pixel measurements are not "hidden". */
const EPSILON = 0.5;

const trackWidth = (layout: StripLayout): number => layout.blocks.reduce((end, block) => Math.max(end, block.start + block.width), 0);

function geometry(layout: StripLayout): { track: number; viewport: number; max: number; overflowing: boolean } {
  const track = trackWidth(layout);
  const overflowing = track > layout.outer + EPSILON;
  // When the blocks overflow, room is kept for an arrow on both sides, shown or not, so the arrows
  // coming and going never changes how much there is to scroll.
  const viewport = overflowing ? Math.max(0, layout.outer - 2 * ARROW_WIDTH) : layout.outer;
  return { track, viewport, max: Math.max(0, track - viewport), overflowing };
}

const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value));

export function stripView(layout: StripLayout, scroll: number): StripView {
  const { track, viewport, max, overflowing } = geometry(layout);
  if (!overflowing) return { overflowing, scroll: 0, hiddenBefore: false, hiddenAfter: false };
  const at = clamp(scroll, max);
  return { overflowing, scroll: at, hiddenBefore: track - viewport - at > EPSILON, hiddenAfter: at > EPSILON };
}

/** The scroll that brings block `index` fully into view, moving as little as possible. */
export function revealBlock(layout: StripLayout, scroll: number, index: number): number {
  const { track, viewport, max, overflowing } = geometry(layout);
  const block = layout.blocks[index];
  if (!overflowing || block === undefined) return 0;
  const at = clamp(scroll, max);
  const visibleStart = track - viewport - at;
  if (block.start < visibleStart - EPSILON) return clamp(track - viewport - block.start, max);
  if (block.start + block.width > track - at + EPSILON) return clamp(track - block.start - block.width, max);
  return at;
}

/** Brings the nearest block hidden (even partly) on the left fully into view. */
export function revealPrevious(layout: StripLayout, scroll: number): number {
  const { track, viewport, max } = geometry(layout);
  const visibleStart = track - viewport - clamp(scroll, max);
  const index = layout.blocks.findLastIndex((block) => block.start < visibleStart - EPSILON);
  return index < 0 ? clamp(scroll, max) : revealBlock(layout, scroll, index);
}

/** Brings the nearest block hidden (even partly) on the right fully into view. */
export function revealNext(layout: StripLayout, scroll: number): number {
  const { track, max } = geometry(layout);
  const visibleEnd = track - clamp(scroll, max);
  const index = layout.blocks.findIndex((block) => block.start + block.width > visibleEnd + EPSILON);
  return index < 0 ? clamp(scroll, max) : revealBlock(layout, scroll, index);
}

/** Measures the real strip: its width, and each block's place in the row (the track is positioned). */
export function measureStrip(outer: HTMLElement, track: HTMLElement): StripLayout {
  return {
    outer: outer.clientWidth,
    blocks: [...track.children].map((child) => {
      const element = child as HTMLElement;
      return { start: element.offsetLeft, width: element.offsetWidth };
    }),
  };
}

export function sameLayout(a: StripLayout | null, b: StripLayout): boolean {
  return a !== null && a.outer === b.outer && a.blocks.length === b.blocks.length &&
    a.blocks.every((block, index) => block.start === b.blocks[index]?.start && block.width === b.blocks[index].width);
}
