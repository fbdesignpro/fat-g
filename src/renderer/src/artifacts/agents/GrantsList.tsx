// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { SessionGrant } from '@shared/contracts/interaction';
import type { SessionEntry } from '@shared/contracts/sessions';
import { GRANT_WORDS } from '../../session-area/mode-words';
import { useAppState } from '../../state/store';
import styles from './Agents.module.css';

/** One grant, in one row: what it covers, in the CLI's own words, and under it what is known of it — confirmed or not, live or ended. */
function GrantRow({ grant }: { readonly grant: SessionGrant }) {
  return (
    <li className={styles.grant} data-grant={grant.itemId} data-live={grant.live ? '' : undefined} data-confirmed={grant.confirmed ? '' : undefined}>
      <span className={styles.grantCovers} title={grant.covers}>{grant.covers}</span>
      <span className={styles.grantState}>
        {grant.confirmed ? GRANT_WORDS.confirmed : GRANT_WORDS.notConfirmed} · {grant.live ? GRANT_WORDS.live : GRANT_WORDS.ended}
      </span>
    </li>
  );
}

/**
 * The session grants fat-g sent, unfolded under the Sub-agents tab's "n grants" line (docs/planning/
 * M106.md, Design 7; C31, C32; docs/planning/_archive/M100.md, round 8; C78; docs/planning/_archive/
 * M22.md, Design 5, 10; C23, C57, C86, C92): each by what it covers, said confirmed or not by the CLI's
 * own word, and live or ended by its process — the live ones first, then the ended ones.
 *
 * It is fat-g's record of what it sent, and says so: it reads nothing of the CLI, which lists none,
 * and what is known of the CLI's own rules is the one line its provider declares, drawn under it.
 * A grant whose reply was not delivered is never here (C92): the session's read lists delivered
 * ones alone, and such a one is told on its card.
 *
 * It has no control that ends a grant (C86): a grant ends with its process and with nothing else.
 */
export function GrantsList({ entry, grants }: { readonly entry: SessionEntry; readonly grants: readonly SessionGrant[] }) {
  const { record } = entry;
  // The provider's own line on its CLI's rules (C23): the same for every account of it.
  const rules = useAppState((state) => state.snapshot?.providers.find((provider) => provider.id === record.providerId)?.descriptor.capabilities.permissions?.rules ?? null);
  const ordered = [...grants.filter((grant) => grant.live), ...grants.filter((grant) => !grant.live)];

  return (
    <section className={styles.grants} aria-label={GRANT_WORDS.title} data-grants="">
      <ul className={styles.grantGroup}>
        {ordered.map((grant) => <GrantRow key={grant.itemId} grant={grant} />)}
      </ul>
      <p className={styles.grantsNote}>
        <span data-grants-record="">{GRANT_WORDS.record}</span>
        {rules !== null && rules !== '' && <span data-grants-rules=""> {rules}</span>}
      </p>
    </section>
  );
}
