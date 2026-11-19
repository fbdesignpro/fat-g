// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { sessionLabel } from '@shared/contracts/sessions';
import { useRef } from 'react';
import { useFittedTitle } from '../ui/useFittedTitle';
import { useShownChat } from '../session-area/selected';
import { useNewChatScreen } from '../new-session/useNewChatLifecycle';
import styles from './Shell.module.css';

/**
 * The shown session's names (docs/planning/_archive/M100.md, Design 4; C14), directly on the grid: the
 * project's name in bold, `//`, then the session's name in the regular weight, at the larger size.
 * The three stand in a row, the project's name alone on the left and the session's name in a box of
 * its own after the `//` (the maintainer), where it wraps under itself over at most
 * two lines, reducing its font size when needed to keep the whole name visible inside the band's
 * height (the maintainer).
 * The `//` is a glyph for the eye alone.
 *
 * Empty with no session selected (M11, C28), and for a chat without a session, which has neither
 * name (M18, C35). The project's colour is drawn nowhere (C23). A session no turn has run shows the
 * name the secretary wrote from its draft behind "New session: ", as its capsule does (M26, round 2).
 */
export function SessionNameArea() {
  const shown = useShownChat();
  const starting = useNewChatScreen() !== null;
  return (
    <section className={styles.sessionNames} aria-label="Session">
      {!starting && shown.kind === 'session' && (
        <div className={styles.names}>
          <span className={styles.projectName}>{shown.project?.name ?? ''}</span>
          <span className={styles.nameSeparator} aria-hidden="true">
            {' // '}
          </span>
          <SessionTitle name={sessionLabel(shown.entry)} />
        </div>
      )}
    </section>
  );
}

function SessionTitle({ name }: { readonly name: string }) {
  const container = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useFittedTitle({ text: name, container, title, token: '--text-28' });
  return <div ref={container} className={styles.sessionTitleBox}>
    <h2 ref={title} className={styles.sessionName}>{name}</h2>
  </div>;
}
