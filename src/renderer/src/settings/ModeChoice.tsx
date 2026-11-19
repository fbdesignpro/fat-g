// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId } from 'react';
import { MODE_WORDS, modeOf, type PermissionCapability } from '@shared/contracts/permissions';
import { useKeptFocus } from './kept-focus';
import styles from './Settings.module.css';

export interface ModeChoiceProps {
  /** What the choice is of: "Default mode", or a provider's name before it. */
  readonly legend: string;
  /** The provider's own declaration (C39, C63): its modes in fat-g's names, each with its one line, and the line that stands under them. */
  readonly capability: PermissionCapability;
  /** The saved choice: the id of one of the provider's modes, or null for none. An id the provider does not list reads as none. */
  readonly value: string | null;
  /**
   * What no choice is. `fallback`: the provider's fallback mode, which is then the one marked — the
   * user's own default, in Settings. `use-default`: an option of its own, Use my default — a
   * project's, whose absence is the user's default.
   */
  readonly none: 'fallback' | 'use-default';
  readonly disabled: boolean;
  /** Compact Settings presentation; project choices keep their inline explanations. */
  readonly tooltipsOnly?: boolean;
  /** A mode's id; null for Use my default, where it is offered. */
  readonly onChange: (mode: string | null) => void;
}

/**
 * A choice among a provider's modes (docs/planning/_archive/M22.md, Design 10; C3, C40, C43, C63, C87): native
 * radios, one row a mode, each with its description — what runs without asking — and under the
 * list the provider's one line on the user's own configuration, drawn once and not per mode.
 * Settings draws it for a provider's default mode, and the project dialog for a project's.
 *
 * It shows the provider's declaration and nothing of an account (C43): a default is a provider's
 * word, and the chat says whether its account can use it. It holds no mode and no provider word of
 * its own, and it saves nothing: whoever draws it says what a choice does.
 *
 * Where a choice is saved at once its radios are disabled while it is saved; the focus an arrow key
 * had on one of them is on the chosen one again once they can be used, so the next key goes on.
 */
export function ModeChoice({ legend, capability, value, none, disabled, onChange, tooltipsOnly = false }: ModeChoiceProps) {
  const name = useId();
  const noteId = useId();
  const group = useKeptFocus(disabled);
  const listed = modeOf(capability, value) === undefined ? null : value;
  const chosen = none === 'fallback' ? listed ?? capability.fallback : listed;
  return (
    <fieldset ref={group} className={styles.modeChoice} disabled={disabled} aria-describedby={tooltipsOnly ? undefined : noteId} title={tooltipsOnly ? capability.inherited : undefined} data-mode-choice="">
      <legend className={styles.modeLegend}>{legend}</legend>
      {none === 'use-default' && (
        <label className={styles.modeOption}>
          <input type="radio" name={name} value="" checked={chosen === null} onChange={() => onChange(null)} />
          <span className={styles.modeName}>{MODE_WORDS.useMyDefault}</span>
        </label>
      )}
      {capability.modes.map((mode) => (
        <label key={mode.id} className={styles.modeOption} title={tooltipsOnly ? mode.description : undefined}>
          <input type="radio" name={name} value={mode.id} checked={chosen === mode.id} aria-description={tooltipsOnly ? mode.description : undefined} onChange={() => onChange(mode.id)} />
          <span>
            <span className={styles.modeName}>{mode.label}</span> {!tooltipsOnly && <small className={styles.modeDescription}>{mode.description}</small>}
          </span>
        </label>
      ))}
      {!tooltipsOnly && <p id={noteId} className={styles.modeInherited} data-mode-inherited="">{capability.inherited}</p>}
    </fieldset>
  );
}
