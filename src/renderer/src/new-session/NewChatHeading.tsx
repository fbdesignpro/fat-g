// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef } from 'react';
import { useFittedTitle } from '../ui/useFittedTitle';
import { useTitleInkAlignment } from './useTitleInkAlignment';
import styles from './NewChat.module.css';

/** Keep the separator fixed while choosing a full-size row or a smaller stacked heading. */
export function NewChatHeading({ name }: { readonly name: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const title = useRef<HTMLSpanElement>(null);
  useFittedTitle({ text: name, container: heading, title, token: '--text-120', scaleContainer: true, layout: 'single-line-or-stacked' });
  useTitleInkAlignment(name, heading, title);

  return <div className={styles.headingSlot}>
    <h1 ref={heading} className={styles.heading}><span ref={title} className={styles.projectTitle}>{name}</span>{' '}<span className={styles.subtitle}>// new chat</span></h1>
  </div>;
}
