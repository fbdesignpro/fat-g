// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId } from 'react';
import type { SessionEntry } from '@shared/contracts/sessions';
import { effortExplanation, effortText } from '../ui/effort-text';
import { EffortWarning } from '../ui/EffortWarning';
import { NOT_FAST, notFastText, SPEED_MARK, speedExplanation, speedRefusal, speedText, tierOf, withSpeed } from '../ui/speed-text';
import { menuStyles, Popup } from '../ui/Popup';
import { useMenu } from '../ui/useMenu';
import { focusPrompt } from '../chat/prompt-focus';
import type { SessionCatalog } from './selected';
import styles from './SessionArea.module.css';

export const NO_EFFORT_LEVELS = 'No effort levels';
/** Said in the menu while the session runs (M15, C45): the turn under way keeps the level it was sent with. */
export const NEXT_TURN_TEXT = 'A change applies from the next reply.';

/**
 * The effort menu below the model id: a dark bar with its label centred in title case and a
 * chevron at the right. Its menu lists the model's levels in catalog order, a level that warns
 * carrying its mark and saying why on hover and to assistive technology, and the chosen level's
 * warning in words under them (decision 0013). The menu is the one way to change the level: no
 * cycling on press.
 *
 * The button shows the level in force (C23); the menu marks, and sets, the record's. Disabled and
 * named "No effort levels" for a model with none; disabled, showing the effort by its id, before the
 * provider's CLI has reported and for a provider that is off or not in this build (C88, C108).
 *
 * While the session runs, the menu says that a change applies from the next turn (M15, C45).
 *
 * The speed tier is the effort's company (the maintainer): the button says it after the
 * level — "Extra High - ⚡Fast" — and the menu lists the model's tiers under the levels, one as a check,
 * several with Standard as a choice, each applying from the next turn as a level does.
 */
export function EffortMenu({ entry, catalog, onChoose, onChooseSpeed }: {
  readonly entry: SessionEntry;
  readonly catalog: SessionCatalog;
  readonly onChoose: (effort: string) => void;
  readonly onChooseSpeed: (speed: string | null) => void;
}) {
  const { open, close, button, buttonProps, menuProps } = useMenu();
  const { record, summary } = entry;
  const levels = catalog.usable ? catalog.stored.efforts : [];
  const tiers = catalog.usable ? catalog.stored.speedTiers : [];
  const speed = tierOf(catalog.stored.speedTiers, record.speed);
  const refused = speedRefusal(catalog.provider?.speedTierRequest);
  const inForce = catalog.usable ? catalog.inForce.efforts.find((effort) => effort.id === summary.effort) : undefined;
  const disabled = levels.length === 0 && tiers.length === 0;
  // No level in force: a model with none — or, for one that has some, none chosen yet.
  const name = summary.effort === null ? (levels.length === 0 ? NO_EFFORT_LEVELS : 'None') : inForce?.label ?? summary.effort;
  const level = summary.effort === null && levels.length === 0 ? name : name.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const text = withSpeed(level, speed);
  // The last turn asked for the tier and ran at standard speed: said in red in the bar's place, the level and why on hover
  // (the maintainer: the level and "Not fast" together do not fit the column).
  const notFast = speed !== undefined && summary.notFast !== undefined ? notFastText(speed, summary.notFast.reason) : null;
  const running = summary.status === 'running';
  const noteId = useId();

  return (
    <>
      <button
        {...buttonProps}
        type="button"
        className={styles.effort}
        disabled={disabled}
        aria-label={summary.effort === null && disabled ? NO_EFFORT_LEVELS : `Effort: ${name}${speed === undefined ? '' : `, speed: ${speed.name}`}${notFast === null ? '' : `. ${notFast}`}`}
        title={notFast === null ? undefined : `Effort: ${level}. ${notFast}`}
        data-speed={record.speed ?? undefined}
      >
        <span className={styles.menuText}>{notFast === null ? text : <span className={styles.notFast} data-not-fast="">{NOT_FAST}</span>}</span>
        <Chevron />
      </button>
      {open && !disabled && (
        <Popup anchor={button} align="start">
          <div {...menuProps} aria-label="Effort" aria-describedby={running ? noteId : undefined} className={menuStyles.menu}>
            {running && <p id={noteId} className={menuStyles.menuNote}>{NEXT_TURN_TEXT}</p>}
            {levels.map((effort) => (
              <button
                key={effort.id}
                type="button"
                role="menuitemradio"
                aria-checked={effort.id === record.effort}
                tabIndex={-1}
                className={menuStyles.item}
                aria-description={effortExplanation(effort)}
                title={effortExplanation(effort)}
                data-caution={effort.caution || undefined}
                data-warning={effort.warning === undefined ? undefined : ''}
                onClick={() => {
                  close(true);
                  if (effort.id !== record.effort) onChoose(effort.id);
                  focusPrompt(record.id, true);
                }}
              >
                {effortText(effort)}
              </button>
            ))}
            <EffortWarning effort={levels.find((effort) => effort.id === record.effort)} />
            {tiers.length === 1 && tiers[0] !== undefined && (() => {
              const tier = tiers[0];
              const on = record.speed === tier.id;
              return (
                <button type="button" role="menuitemcheckbox" aria-checked={on} aria-disabled={refused !== null || undefined} tabIndex={-1} className={menuStyles.item}
                  aria-description={refused ?? speedExplanation(tier)} title={refused ?? speedExplanation(tier)} data-speed-item={tier.id}
                  onClick={() => { if (refused !== null) return; close(true); onChooseSpeed(on ? null : tier.id); }}>
                  {SPEED_MARK} {tier.name}
                </button>
              );
            })()}
            {tiers.length > 1 && [null, ...tiers].map((tier) => (
              <button key={tier?.id ?? 'standard'} type="button" role="menuitemradio" aria-checked={(tier?.id ?? null) === record.speed} aria-disabled={refused !== null || undefined} tabIndex={-1} className={menuStyles.item}
                aria-description={refused ?? (tier === null ? undefined : speedExplanation(tier))} title={refused ?? (tier === null ? undefined : speedExplanation(tier))} data-speed-item={tier?.id ?? ''}
                onClick={() => { if (refused !== null) return; close(true); if ((tier?.id ?? null) !== record.speed) onChooseSpeed(tier?.id ?? null); }}>
                {tier === null ? 'Standard speed' : speedText(tier)}
              </button>
            ))}
            {tiers.length > 0 && refused !== null && <p className={menuStyles.menuNote}>{refused}</p>}
            {tiers.length > 0 && notFast !== null && <p className={menuStyles.menuNote} data-not-fast-note="">{notFast}</p>}
          </div>
        </Popup>
      )}
    </>
  );
}

export function Chevron() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false" className={styles.chevron}>
      <path d="M5 9L12 16L19 9" stroke="currentColor" strokeWidth="2.5" fill="none" />
    </svg>
  );
}
