// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useLayoutEffect, useRef, useState } from 'react';

/** Shared capsule widths, including space for the preset carousel's arrows. */
export function useCapsuleColumns(hasEntries: boolean, capsuleWidth = 260) {
  const outer = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  useLayoutEffect(() => {
    const element = outer.current;
    if (element === null) return;
    const measure = (): void => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setColumns(Math.max(1, Math.min(3, Math.floor((width - 38 + 12) / (capsuleWidth + 12)))));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasEntries, capsuleWidth]);
  const gridStyle = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxWidth: `${columns * capsuleWidth + (columns - 1) * 12}px` };
  return { outer, columns, gridStyle };
}
