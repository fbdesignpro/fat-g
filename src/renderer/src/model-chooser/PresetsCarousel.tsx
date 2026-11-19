// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from 'react';
import type { ModelPreset } from '@shared/contracts/presets';
import { orderedPresetIds, type SavedPreset } from '@shared/contracts/saved-presets';
import { ChevronIcon } from '../control-bar/icons';
import { capsulePresentation, ModelCapsule } from './ModelCapsule';
import { useCapsuleColumns } from './useCapsuleColumns';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import styles from './Capsules.module.css';

export function PresetsCarousel({ providers, busy, selection = null, onChoose, onEdit, layout = 'compact' }: {
  readonly layout?: 'compact' | 'column';
  readonly providers: readonly string[];
  readonly busy: boolean;
  readonly selection?: ModelPreset | null;
  readonly onChoose: (preset: SavedPreset, id: string) => Promise<boolean>;
  readonly onEdit?: () => void;
}) {
  const prefs = usePrefs((state) => state.snapshot?.values);
  const app = useAppState((state) => state.snapshot);
  const [page, setPage] = useState(0);
  const [visibleCount, setVisibleCount] = useState(6);
  // Usage is saved immediately, but only a new visit adopts its latest order.
  const [recency, setRecency] = useState(prefs?.presetRecency);
  if (recency === undefined && prefs !== undefined) setRecency(prefs.presetRecency);
  const [focused, setFocused] = useState<{ readonly id: string } | null>(null);
  const appliedFocus = useRef<typeof focused>(null);
  const presets = prefs?.presets ?? {};
  const ids = orderedPresetIds(presets, recency ?? []);
  const { outer, columns, gridStyle } = useCapsuleColumns(ids.length > 0);
  const capacity = columns * 2;
  const current = Math.min(page, Math.max(0, Math.ceil(ids.length / capacity) - 1));
  const visible = layout === 'column' ? ids.slice(0, visibleCount) : ids.slice(current * capacity, (current + 1) * capacity);
  const accounts = app?.providers ?? [];

  useEffect(() => {
    if (focused === null || appliedFocus.current === focused || !visible.includes(focused.id)) return;
    outer.current?.querySelector<HTMLButtonElement>(`[data-preset-id="${focused.id}"]`)?.focus();
    appliedFocus.current = focused;
  }, [focused, visible, outer]);

  if (ids.length === 0 && layout === 'compact') return null;
  const showPage = (next: number): void => {
    setPage(next);
    const id = ids[next * capacity];
    if (id !== undefined) setFocused({ id });
  };
  return (
    <section className={layout === 'column' ? styles.columnSection : styles.section} aria-label="Presets">
      <h2>Presets{onEdit !== undefined && <> <button type="button" className={styles.editLink} aria-label="Edit presets" onClick={onEdit}>edit</button></>}</h2>
      {ids.length === 0 && <p>No presets saved.</p>}
      <div ref={outer} className={styles.carousel}>
        {layout === 'compact' && ids.length > capacity && (current > 0 ? <button className={styles.arrow} type="button" aria-label="Show previous presets" onClick={() => showPage(current - 1)}><ChevronIcon direction="left" /></button> : <span className={styles.arrowSpace} />)}
        <div className={layout === 'column' ? styles.columnList : styles.grid} style={layout === 'column' ? undefined : gridStyle}>
          {visible.map((id) => {
            const preset = presets[id];
            if (preset === undefined) return null;
            return <ModelCapsule key={id} presetId={id} preset={preset} name={preset.name} presentation={capsulePresentation(preset, app?.catalog, accounts, providers)} busy={busy} selection={selection}
              onChoose={() => {
                void onChoose(preset, id);
              }} />;
          })}
        </div>
        {layout === 'compact' && ids.length > capacity && ((current + 1) * capacity < ids.length ? <button className={styles.arrow} type="button" aria-label="Show more presets" onClick={() => showPage(current + 1)}><ChevronIcon direction="right" /></button> : <span className={styles.arrowSpace} />)}
      </div>
      {layout === 'column' && ids.length > visibleCount && <button type="button" className={styles.showMore} disabled={busy} aria-label="Show more presets" onClick={() => setVisibleCount((count) => count + 6)}>Show more</button>}
    </section>
  );
}
