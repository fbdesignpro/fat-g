// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
interface Placement {
  readonly host: Rect;
  readonly viewport: Rect;
  readonly messageLeft: number;
  readonly sourceTop: number;
  readonly width: number;
  readonly height: number;
  readonly gap: number;
  readonly toolbar: Rect | null;
}

/** Overlay coordinates only: no layout changes and no vertical clamping around the toolbar. */
export function placeTime({ host, viewport, messageLeft, sourceTop, width, height, gap, toolbar }: Placement) {
  const right = messageLeft - gap;
  const left = right - width;
  const bottom = sourceTop + height;
  const topEdge = Math.max(host.top, viewport.top);
  const bottomEdge = Math.min(host.bottom, viewport.bottom);
  if (sourceTop < topEdge || sourceTop >= bottomEdge || right <= host.left || left >= host.right) return null;
  if (toolbar !== null && left < toolbar.right && right > toolbar.left && sourceTop < toolbar.bottom + gap && bottom > toolbar.top - gap) return null;
  return { left: right - host.left, top: sourceTop - host.top, clipTop: topEdge - host.top, clipBottom: host.bottom - bottomEdge };
}
