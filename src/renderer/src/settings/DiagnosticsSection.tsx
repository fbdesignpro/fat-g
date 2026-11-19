// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ResetDataSection } from './ResetDataSection';
import { useCspViolations } from '../diagnostics/useCspViolations';
import { useAppState } from '../state/store';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { CatalogNote } from './ProviderModels';
import { Section } from './Section';
import styles from './Settings.module.css';

/** What M1 put on screen to prove the shell is sound. "Copy diagnostics" joins it later. */
export function DiagnosticsSection() {
  const violations = useCspViolations();
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const secure = violations.length === 0;

  return (
    <Section section="diagnostics">
      <div className={styles.diagnostics}>
        {catalog !== undefined && <CatalogNote status={catalog.override} />}
        <div className={styles.recentModels}>
          <p>Clear the recent model list. Saved presets are kept.</p>
          <div className={styles.inlineActions}>
            <button type="button" disabled={prefs === null || prefs.status.kind !== 'ok' || saving || prefs.values.recentModels.length === 0} onClick={() => { void patchPrefs({ clearRecentModels: true }); }}>
              Clear recent model list
            </button>
          </div>
        </div>
        <ResetDataSection />
        <dl className={styles.facts}>
          <dt>Platform (via preload bridge)</dt>
          <dd>{window.fatg.platform}</dd>
          <dt>Renderer origin</dt>
          <dd>{window.location.origin}</dd>
          <dt>CSP violations</dt>
          <dd className={secure ? styles.ok : styles.critical} role="status">
            {violations.length}
          </dd>
        </dl>
        {!secure && (
          <ul className={styles.violations}>
            {violations.map((violation, index) => (
              <li key={index}>
                <code>{violation.directive}</code> blocked <code>{violation.blockedUri || '(inline)'}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
