// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useRef } from 'react';
import type { ProviderStream } from '@shared/contracts/catalog';
import { providerPresentation } from '../../state/presentation';
import { useAppState } from '../../state/store';
import { useLightStream } from './useLightStream';
import styles from './StatusStream.module.css';

/** Provider presentation stays module-owned, including for accounts no longer configured. */
export function useProviderStream(providerId: string): ProviderStream | undefined {
  return useAppState((state) => providerPresentation(state.snapshot, providerId)?.stream);
}

/** Applied to the host, so additive lights blend onto the same provider ground as its text. */
export function streamStyle(stream: ProviderStream): CSSProperties {
  return {
    '--stream-ground': stream.ground,
    ...Object.fromEntries(stream.lights.map((light, index) => [`--stream-${index + 1}`, light])),
    ...(stream.image === undefined ? {} : { '--stream-glow': `url("${stream.image}")`, '--stream-fill': 'transparent' }),
  } as CSSProperties;
}

/** Span markup also fits inside a capsule's select button; the field never receives input. */
export function StatusStream({ active, available, immediate = false, compact = false, waiting = false }: {
  readonly active: boolean;
  readonly available: boolean;
  readonly immediate?: boolean;
  readonly compact?: boolean;
  readonly waiting?: boolean;
}) {
  const field = useRef<HTMLSpanElement>(null);
  useLightStream(field, active && available, immediate || !available, compact, waiting);
  return (
    <span ref={field} className={styles.field} aria-hidden="true" data-status-stream="" data-active={active && available || undefined} data-waiting={active && waiting || undefined} data-immediate={immediate || undefined} data-compact={compact || undefined}>
      {Array.from({ length: 12 }, (_, index) => <span className={styles.light} key={index}><span className={styles.beam} /></span>)}
    </span>
  );
}
