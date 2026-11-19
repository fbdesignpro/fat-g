// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ReactNode, RefObject } from 'react';
import { CopyButton } from '../ui/CopyButton';
import { useSidewaysScroll, useTabStop } from './inert';
import styles from './Markdown.module.css';

/**
 * A text in the monospace font, as a code block is drawn (docs/planning/_archive/M19.md, Design 6; C34, C35;
 * M20a.md, Design 8; C37): its name and a Copy button of its own above it, and the text scrolling
 * sideways within itself, never wrapped. What an activity's input and output are shown in. It is
 * given text, and draws nothing of it but text: no control is ever made from what it holds.
 *
 * `children` is what the `pre` shows, which may be the text in parts with a line of fat-g's between
 * them; `text` is what Copy takes, asked for at the press.
 */
export interface CodeTextProps {
  readonly title: string;
  readonly copyLabel: string;
  readonly text: () => string;
  /** What stands in its head row beside Copy, if anything: whoever draws it says what. */
  readonly beside?: ReactNode;
  /** Attributes for the element that holds the text, the `pre`: whoever draws it may mark it. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** Given that element, while it is drawn. */
  readonly textRef?: RefObject<HTMLPreElement | null>;
  readonly children: ReactNode;
}

export function CodeText({ title, copyLabel, text, beside, attributes, textRef, children }: CodeTextProps) {
  const [scroller, scrollStop] = useSidewaysScroll<HTMLPreElement>(textRef);
  const stop = useTabStop();
  return (
    <div className={styles.code}>
      <div className={styles.codeHead}>
        <span className={styles.language}>{title}</span>
        <span className={styles.codeControls}>
          {beside}
          <CopyButton label={copyLabel} text={text} tabIndex={stop} />
        </span>
      </div>
      <pre ref={scroller} className={styles.pre} tabIndex={scrollStop} aria-label={title} {...attributes}>
        {children}
      </pre>
    </div>
  );
}
