// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import type { ModelPreset } from '@shared/contracts/presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { capsulePresentation, ModelCapsule } from './ModelCapsule';
import { TILE_WIDTH } from './chooser-shape';
import { useCapsuleColumns } from './useCapsuleColumns';
import styles from './Capsules.module.css';

export function RecentModels({ providers, busy, selection, onChoose, className, layout = 'compact' }: {
  readonly layout?: 'compact' | 'column';
  readonly className?: string;
  readonly providers: readonly string[];
  readonly busy: boolean;
  readonly selection: ModelPreset | null;
  readonly onChoose: (preset: ModelPreset) => Promise<boolean>;
}) {
  const prefs = usePrefs((state) => state.snapshot?.values);
  const [visibleCount, setVisibleCount] = useState(6);
  const app = useAppState((state) => state.snapshot);
  const saved = new Set(Object.values(prefs?.presets ?? {}).map(modelSelectionKey));
  const available = (prefs?.recentModels ?? []).filter((preset) => !saved.has(modelSelectionKey(preset)))
    .map((preset) => ({ preset, presentation: capsulePresentation(preset, app?.catalog, app?.providers ?? [], providers) }))
    .filter((entry) => entry.presentation.problem === null);
  const { outer, columns, gridStyle } = useCapsuleColumns(available.length > 0, TILE_WIDTH);
  if (available.length === 0 && layout === 'compact') return null;
  return <section className={[layout === 'column' ? styles.columnSection : styles.section, className].filter(Boolean).join(' ')} aria-label="Recent">
    <h2>Recent</h2>
    {available.length === 0 && <p>No recent settings.</p>}
    <div ref={outer} className={styles.carousel}>
      <div className={layout === 'column' ? styles.columnList : styles.grid} style={layout === 'column' ? undefined : gridStyle}>
        {available.slice(0, layout === 'column' ? visibleCount : columns).map(({ preset, presentation }) => {
          const key = modelSelectionKey(preset);
          return <ModelCapsule key={key} recentKey={key} preset={preset} presentation={presentation} busy={busy} selection={selection} onChoose={() => { void onChoose(preset); }} />;
        })}
      </div>
    </div>
    {layout === 'column' && available.length > visibleCount && <button type="button" className={styles.showMore} disabled={busy} aria-label="Show more recent settings" onClick={() => setVisibleCount((count) => count + 6)}>Show more</button>}
  </section>;
}
