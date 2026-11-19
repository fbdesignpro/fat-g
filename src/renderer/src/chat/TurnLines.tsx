// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { CHAT_LINES } from '@shared/contracts/chat';
import type { ConversationTurn } from '@shared/contracts/conversation';
import styles from './Chat.module.css';

/**
 * Under a turn's last item (M18, C16, C19, C59; M19, C43): what is known of an end the provider
 * never gave, and of what could not be saved. Durations belong to the speaker bar; these outcome
 * and storage warnings remain under the turn's last item.
 */
export function TurnLines({ turn, providerName }: { readonly turn: ConversationTurn; readonly providerName: string }) {
  return (
    <>
      {turn.state === 'unacknowledged' && <p className={styles.line} data-turn-line="unacknowledged">{CHAT_LINES.unacknowledged(providerName)}</p>}
      {turn.state === 'unfinished' && <p className={styles.line} data-turn-line="unfinished">{CHAT_LINES.unfinished}</p>}
      {turn.gap && <p className={styles.line} data-turn-line="gap">{CHAT_LINES.gap}</p>}
    </>
  );
}
