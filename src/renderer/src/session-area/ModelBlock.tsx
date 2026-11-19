// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useState } from 'react';
import type { SessionEntry, SessionHold, SessionRefusal, SessionSaved } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { Avatar } from '../sessions/Avatar';
import { EffortMenu } from './EffortMenu';
import { useSessionCatalog } from './selected';
import styles from './SessionArea.module.css';

export const PANEL_FAILED_TEXT = 'fat-g could not save the change.';

/**
 * Why a session cannot be used now, in fat-g's words (M14, C108; M14b, C29, C62). A moved folder is
 * said with the variable that names it, when its provider has one; no path is shown. Said in the
 * input's place, where the session's block is its hold (docs/planning/_archive/M100.md, round 8; C77).
 */
export function holdText(hold: SessionHold, variable: string | null): string {
  switch (hold) {
    case 'provider-unavailable': return 'Its provider is switched off, or is not in this build.';
    case 'instance-unavailable': return 'Its account is switched off, cannot run, or is no longer set up in Settings.';
    case 'folder-moved':
      return `This session started in another configuration folder than its account has now${variable === null ? '' : ` (${variable})`}. It cannot be continued until fat-g is started with that folder again.`;
  }
}

/**
 * The prompt area's separate model block: a portrait, the effective model name on its provider's
 * colour, then the effort menu. Its catalog name matches the speaker bars; the id is in its tooltip.
 * Account labels and failed effort changes follow below. Keyed by the session where it is drawn.
 */
export function ModelBlock({ entry }: { readonly entry: SessionEntry }) {
  const catalog = useSessionCatalog(entry);
  const [failed, setFailed] = useState(false);
  const { record, summary } = entry;

  const change = (request: () => Promise<SessionSaved | SessionRefusal>): void => {
    request().then(
      (answer) => setFailed(answer.status !== 'saved'),
      () => setFailed(true),
    );
  };

  return (
    <section className={styles.modelBlock} aria-label="Model" data-model-block="">
      <Avatar providerId={record.providerId} avatar={entry.avatar} size="column" effort={summary.effort} fast={record.speed !== null} />
      <div className={styles.modelId} role="group" aria-label="Model" data-session-model="" style={catalog.presentation === undefined ? undefined : { '--bar-color': catalog.presentation.barColor } as CSSProperties} title={summary.model}>
        <span className={styles.menuText}>{catalog.inForce.name}</span>
      </div>
      <EffortMenu entry={entry} catalog={catalog} onChoose={(effort) => change(() => invoke('sessions:setEffort', { id: record.id, effort }))}
        onChooseSpeed={(speed) => change(() => invoke('sessions:setSpeed', { id: record.id, speed }))} />
      {catalog.label !== null && (
        <div className={styles.account} role="group" aria-label="Account" data-session-account="">
          <span className={styles.menuText}>{catalog.label}</span>
        </div>
      )}
      {failed && (
        <p className={styles.problem} role="status">
          {PANEL_FAILED_TEXT}
        </p>
      )}
    </section>
  );
}
