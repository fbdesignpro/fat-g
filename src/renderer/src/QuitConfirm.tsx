// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { quitActivity, quitWords } from '@shared/contracts/quit';
import { invoke } from './ipc/client';
import { useAppState } from './state/store';
import { ConfirmDialog } from './ui/ConfirmDialog';

/**
 * Main's question before a quit that would stop a running session: shown while the
 * snapshot's `quitQuestion` is set. Both counts follow the same snapshot, distinguishing a reply
 * held only for a plan decision from active replies and workers. With neither left it asks only
 * whether to quit. Cancel is the default, and each button sends one
 * answer; main clears the question, which closes the dialog.
 *
 * The same words are in the native message box main opens when this page cannot ask (C103).
 */
export function QuitConfirm() {
  const asked = useAppState((state) => state.snapshot?.quitQuestion === true);
  const sessions = useAppState((state) => state.snapshot?.sessions?.sessions);
  // One answer per question: the buttons wait until main has taken it.
  const [sent, setSent] = useState(false);
  if (!asked && sent) setSent(false);
  const words = quitWords(quitActivity(sessions ?? []));

  const answer = (quit: boolean): void => {
    if (sent) return;
    setSent(true);
    // Nothing to show if the call fails: main still holds the question, and the next close asks natively.
    invoke('app:answerQuit', { quit }).catch(() => setSent(false));
  };

  return (
    <ConfirmDialog open={asked} title={words.title} confirmLabel={words.confirm} busy={sent} onConfirm={() => answer(true)} onCancel={() => answer(false)}>
      {words.body.split('\n\n').map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    </ConfirmDialog>
  );
}
