// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, useMemo } from 'react';
import { LINES_HOLDER } from '../../chat/selection-report';
import styles from './File.module.css';

/** The attribute the element that holds a plain text's lines carries: a line is its child, by its number. A selection's report reads its lines by it (M20b, C45). */
export { LINES_HOLDER };

/**
 * A text as plain text (docs/planning/_archive/M19b.md, Design 8; C53, C54): the monospace font, uncoloured,
 * one element a line, so that a line can be marked and come to. A line is as wide as it is, up to
 * 2,000 px: a wider one wraps at that width, so the text is as wide as its longest line and never
 * wider, and its scroller goes sideways to it and no further.
 *
 * Until M19c brings a viewer, this is how every text file that is not Markdown is shown, and a
 * Markdown file past its bound. Drawn again only when its text changes.
 */
export const PlainTextView = memo(function PlainTextView({ text }: { readonly text: string }) {
  const lines = useMemo(() => {
    const split = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    // A text that ends in a line break has no line after it.
    if (split.length > 1 && split.at(-1) === '') split.pop();
    return split;
  }, [text]);
  return (
    <div className={styles.plain} {...{ [LINES_HOLDER]: '' }}>
      {lines.map((line, index) => <div key={index} className={styles.line}>{line}</div>)}
    </div>
  );
});
