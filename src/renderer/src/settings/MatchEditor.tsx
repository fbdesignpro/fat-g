// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId } from 'react';
import { isMatchKey, type MatchEntry } from '@shared/contracts/avatars';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { EDITOR_WORDS } from './family-editor-words';
import styles from './Settings.module.css';

export const keyOf = (entry: MatchEntry): string => (typeof entry === 'string' ? entry : entry.key);
export const providerOf = (entry: MatchEntry): string => (typeof entry === 'string' ? '' : entry.provider);
export const entryOf = (key: string, provider: string): MatchEntry => (provider === '' ? key : { provider, key });

/**
 * An avatar's match entries (decision 0031), as the family editor and its Add avatar popup edit them:
 * a pattern and a provider a row, each removable, a row added as `*`, a pattern of another form named,
 * and the models the family's search would give the avatar now, which the caller says.
 */
export function MatchEditor({ matches, providers, disabled, takes, onChange }: {
  readonly matches: readonly MatchEntry[];
  readonly providers: readonly ProviderSnapshot[];
  readonly disabled: boolean;
  /** Each model's name and its provider's; null omits the line when editing no named avatar yet. */
  readonly takes: readonly string[] | null;
  readonly onChange: (matches: readonly MatchEntry[]) => void;
}) {
  const baseId = useId();
  const unknown = [...new Set(matches.map(providerOf).filter((id) => id !== '' && !providers.some((provider) => provider.id === id)))];
  return (
    <fieldset className={styles.styleGroup} data-match-editor="">
      <legend>{EDITOR_WORDS.matches}</legend>
      {matches.length === 0 && <p className={styles.muted}>{EDITOR_WORDS.noMatches}</p>}
      {matches.map((entry, index) => {
        const key = keyOf(entry);
        const bad = !isMatchKey(key);
        const replace = (next: MatchEntry): void => onChange(matches.map((before, at) => (at === index ? next : before)));
        return (
          <div key={index} className={styles.matchRow} data-match-row={index}>
            <input
              type="text"
              aria-label={`${EDITOR_WORDS.pattern} ${index + 1}`}
              aria-invalid={bad || undefined}
              aria-describedby={bad ? `${baseId}-bad-${index}` : undefined}
              disabled={disabled}
              value={key}
              spellCheck={false}
              onChange={(event) => replace(entryOf(event.target.value, providerOf(entry)))}
              data-match-key=""
            />
            <select aria-label={`${EDITOR_WORDS.provider} ${index + 1}`} disabled={disabled} value={providerOf(entry)} onChange={(event) => replace(entryOf(key, event.target.value))} data-match-provider="">
              <option value="">{EDITOR_WORDS.anyProvider}</option>
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
              {unknown.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <span className={styles.inlineActions}>
              <button type="button" disabled={disabled} onClick={() => onChange(matches.filter((_, at) => at !== index))}>{EDITOR_WORDS.removeMatch}</button>
            </span>
            {bad && <small id={`${baseId}-bad-${index}`} className={`${styles.statusLine} ${styles.critical}`}>{EDITOR_WORDS.badPattern}</small>}
          </div>
        );
      })}
      <span className={styles.inlineActions}>
        <button type="button" disabled={disabled} onClick={() => onChange([...matches, '*'])} data-add-match="">{EDITOR_WORDS.addMatch}</button>
      </span>
      {takes !== null && <p className={styles.statusLine} data-takes="">{takes.length === 0 ? EDITOR_WORDS.takesNone : EDITOR_WORDS.takes(takes)}</p>}
    </fieldset>
  );
}
