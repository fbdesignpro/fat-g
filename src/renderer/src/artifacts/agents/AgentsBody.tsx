// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect } from 'react';
import { useGrants } from '../../chat/grants-store';
import { useAppState } from '../../state/store';
import type { TabBodyProps } from '../tab-kind';
import { ArtifactBar } from '../ArtifactBar';
import barStyles from '../ArtifactBar.module.css';
import { AgentStack } from './AgentStack';
import styles from './Agents.module.css';

/** The sub-agent whose thread is unfolded (M106, C23): by its id, with the label it was chosen with. */
export interface ChosenAgent {
  readonly id: string;
  /** The label whoever chose it showed: what heads a thread opened for one the list no longer holds (C24). */
  readonly label: string | null;
  /** The list has held it since it was chosen: once it leaves the list, it is no longer chosen (C27). */
  readonly listed?: boolean;
}

/**
 * What the pane keeps for the tab between showings (M106, C23, C30, C31): whether the completed
 * sub-agents and the grants are unfolded, and the sub-agent whose thread is. Each field may be
 * missing — a tab opened by `openAgent` names its chosen one alone — and reads as closed and none.
 */
export interface AgentsViewState {
  readonly completedOpen?: boolean;
  readonly grantsOpen?: boolean;
  readonly chosen?: ChosenAgent | null;
}

/**
 * A session's Sub-agents tab (docs/planning/_archive/M100.md, round 8; C78; docs/planning/_archive/M106.md,
 * Design 7; C1, C40): its sub-agents, as its summary lists them, stacked as the session list stacks its
 * capsules, a press unfolding one's thread under its row; under them the grants fat-g sent, folded.
 * The stack reads the app state and the page's grants; a thread reads its sub-agent's items from
 * main while it is unfolded. The whole tab scrolls as one column.
 *
 * The chosen sub-agent is the tab's view state (C23): set by a press, or by the chat's Open and an
 * aside's source (`openAgent`), never by a new sub-agent, and dropped once it leaves the list; one
 * chosen from the chat that the list does not hold stands first in the stack, under a head of its
 * own (C24).
 */
export function AgentsBody({ sessionId, viewState, setViewState }: TabBodyProps<null, AgentsViewState>) {
  const entry = useAppState((state) => state.snapshot?.sessions?.sessions.find((candidate) => candidate.record.id === sessionId));
  const grants = useGrants(sessionId);
  const chosen = viewState?.chosen ?? null;
  const listed = chosen !== null && entry !== undefined && entry.summary.agents.some((agent) => agent.id === chosen.id);

  // Seen in the list, it is the list's from then on; gone from it, it is no longer chosen (C27).
  useEffect(() => {
    if (chosen === null || entry === undefined) return;
    if (listed && chosen.listed !== true) setViewState({ ...viewState, chosen: { ...chosen, listed: true } });
    else if (!listed && chosen.listed === true) setViewState({ ...viewState, chosen: null });
  }, [chosen, entry, listed, setViewState, viewState]);

  return (
    <div className={barStyles.frame}>
      <ArtifactBar label="Sub-agents" />
      <div className={styles.tab} data-agents-tab={sessionId}>
        {entry !== undefined && <AgentStack
          entry={entry}
          grants={grants}
          completedOpen={viewState?.completedOpen === true}
          grantsOpen={viewState?.grantsOpen === true}
          chosen={chosen}
          onChange={(next) => setViewState({ ...viewState, ...next })}
        />}
      </div>
    </div>
  );
}
