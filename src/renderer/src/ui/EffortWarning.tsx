// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CatalogEffort } from '@shared/contracts/catalog';
import { WARNING_MARK } from './effort-text';
import styles from './EffortWarning.module.css';

/**
 * The chosen level's warning, in words under where it is chosen (decision 0013): nothing for a level
 * that has none. Its mark is the one its label carries.
 */
export function EffortWarning({ effort, id }: { readonly effort: Pick<CatalogEffort, 'label' | 'warning'> | undefined; readonly id?: string }) {
  if (effort?.warning === undefined) return null;
  return (
    <p id={id} className={styles.warning} data-effort-warning="">
      <span aria-hidden="true">{WARNING_MARK}</span> {effort.label}: {effort.warning}
    </p>
  );
}
