// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useRef } from 'react';
import { DEFAULT_CREATION_ANIMATION } from '@shared/contracts/appearance';
import { DoneButton } from '../session-area/DoneButton';
import { useShownChat } from '../session-area/selected';
import { ArtifactRegion, ArtifactWatchers, useArtifactRegion } from './ArtifactRegion';
import { ChatRegion } from './ChatRegion';
import styles from './Shell.module.css';
import { SplitHandle } from './SplitHandle';
import { NewChatScreen } from '../new-session/NewChatScreen';
import { useNewChatLifecycle } from '../new-session/useNewChatLifecycle';
import { useFirstSendReveal } from '../new-session/useFirstSendReveal';
import { usePrefs } from '../state/prefs-store';
import { HoverTimeHost } from '../chat/hover-time/HoverTime';
import { FirstRunScreen } from '../first-run/FirstRunScreen';
import { useFirstRunGuide } from '../first-run/first-run';

/**
 * The session window (docs/planning/_archive/M100.md, Design 6, 8, round 8; C29, C32, C43, C44, C50, C76–C80):
 * the main row's work cell. The chat window is a box in it, holding the chat content — the message
 * list across it, and under the thick rule the avatar and the prompt, centred and no wider than
 * --chat-content-width. While the shown session has a tab open, the artifact pane is a box of its own
 * beside it, the grid showing through the gap between them, and the gap resizes the two. Done
 * stands at the chat window's top-left corner, inside the box and over the chat, for a shown session
 * that is not completed (C50; the maintainer: it left the band, whose height followed it,
 * so the window's top no longer moves when a session goes). With a tab open the pane holds the right
 * 40% by default and Done stays over the chat.
 *
 * A chat without a session is its list alone, with no avatar and no prompt area (C44).
 *
 * With nothing shown nothing is drawn: no box, the grid alone in the cell (the maintainer),
 * which is how a session marked Done leaves it, main clearing the selection with the
 * mark. The chat window stays in the page, empty, since it holds the page's main landmark. It names
 * the session it shows, so the Done flash knows whether it covers the window too (leaving.ts).
 * Except while a first-run guide applies (first-run.ts): no provider to use, or no project yet. The
 * guide is then drawn in the chat window's place, on the grid, and is the main landmark itself.
 * A new chat's first accepted Send reveals its window with the entrance chosen in Appearance.
 *
 * It is always there, so it is what registers the page's tab kinds (C59), and what draws the
 * watchers of the kinds whose tabs open by themselves (C78).
 */
export function SessionWindow() {
  const shown = useShownChat();
  const split = useArtifactRegion();
  const own = useRef<HTMLDivElement>(null);
  const chatId = useId();
  const starting = useNewChatLifecycle();
  const firstRun = useFirstRunGuide();
  const guide = starting === null && shown.kind === 'none' ? firstRun : null;
  const shownId = shown.kind === 'session' ? shown.entry.record.id : null;
  const reveal = useFirstSendReveal(starting, shownId);
  const creation = usePrefs((state) => state.snapshot?.values.appearance.creationAnimation) ?? DEFAULT_CREATION_ANIMATION;
  return (
    <div ref={own} className={styles.sessionWindow} data-split={starting === null && guide === null && split || undefined}>
      <ArtifactWatchers />
      {starting !== null ? <NewChatScreen key={starting.key} project={starting.project} draftId={starting.draftId} /> : guide !== null ? <FirstRunScreen guide={guide} /> : <div id={chatId} className={styles.chatWindow} data-chat-window="" data-shown-session={shownId ?? undefined} data-reveal={(reveal && creation !== 'none') || undefined} data-empty={shown.kind === 'none' || undefined}>
        <HoverTimeHost>
          {/* Keyed by the session: what it remembers — a refusal's words — is that session's. */}
          {shown.kind === 'session' && <DoneButton key={shown.entry.record.id} entry={shown.entry} />}
          <div className={styles.content} data-detached={shown.kind === 'detached' || undefined}>
            <ChatRegion />
          </div>
        </HoverTimeHost>
      </div>}
      {starting === null && guide === null && split && <SplitHandle target={own} controls={chatId} />}
      {starting === null && guide === null && split && <ArtifactRegion />}
    </div>
  );
}
