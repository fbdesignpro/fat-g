// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProjectColumnSide } from '@shared/contracts/prefs';
import { DoneCovers } from '../sessions/DoneCovers';
import { useSequenceLock } from '../sessions/sequence-lock';
import { SessionSwitcher } from '../sessions/SessionSwitcher';
import { useUnstartedSessions } from '../sessions/unstarted';
import { usePrefs } from '../state/prefs-store';
import { AddProjectButton } from './AddProjectButton';
import { ProjectColumn } from './ProjectColumn';
import { SessionWindow } from './SessionWindow';
import styles from './Shell.module.css';
import { TitleStrip } from './TitleStrip';
import { TopBand } from './TopBand';

/**
 * The Main window's page grid (docs/planning/_archive/M100.md, Design 2; C9–C12): under the title strip, one
 * grid of two rows and two columns on a faint grid background — the top band, with the session's
 * names, Done and the usage box in the work column and Add project in the project column, and the
 * main row, with the session window and the project list.
 *
 * With the projects on the right only the project column's two cells move: they are rendered last
 * in each row instead of first, so the DOM order — and with it the keyboard order — is the visual
 * order on either side (M11, C26). Each part is keyed, so a change of side moves it and keeps what
 * it holds.
 *
 * Until preferences arrive, or when they cannot be read, the projects are on the left (C91).
 *
 * It watches, for the window, what the selection leaves behind in a session no turn has run (M26,
 * round 2): the page's work, since the draft that decides it is the page's own. And it holds the
 * recent sessions switcher Ctrl+Tab opens (C93), which keeps the visits its list is made from.
 * Over everything, the Done flash's covers, and the lock that holds the page still while it plays
 * (leaving.ts).
 */
export function Shell() {
  const side: ProjectColumnSide = usePrefs((state) => state.snapshot?.values.layout.projectColumn ?? 'left');
  useUnstartedSessions();
  useSequenceLock();
  const band = <TopBand key="band" />;
  const add = <AddProjectButton key="add" />;
  const session = <SessionWindow key="session" />;
  const projects = <ProjectColumn key="projects" />;
  return (
    <div className={styles.shell}>
      <TitleStrip />
      <div className={styles.body} data-project-column={side}>
        {side === 'left' ? [add, band, projects, session] : [band, add, session, projects]}
      </div>
      <SessionSwitcher />
      <DoneCovers />
    </div>
  );
}
