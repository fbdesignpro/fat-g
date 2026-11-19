// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { accountName } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { usePrefs } from '../state/prefs-store';
import { formatDateTime, formatPercent, relativeTime, remainingPercent, resetText } from '../ui/format';
import { maskEmail } from '../ui/mask-email';
import { isHistorical, providerStatusDetail } from '../ui/provider-status-detail';
import { providerStatusSummary } from '../ui/provider-status-label';
import { useClock } from '../ui/useClock';
import styles from './UsagePanel.module.css';

/** "38% remaining": a window's share that remains, as its bar shows it (M100, C56). */
export function remainingText(usedPercent: number): string {
  return `${formatPercent(remainingPercent(usedPercent))} remaining`;
}

/** Distance from the block above, and the least distance kept from the window's edges. */
const GAP = 4;
const MARGIN = 8;

/**
 * Everything the old Usage scene showed about a provider, as a tooltip below its block (C45):
 * plan, email (masked by preference), CLI version, status and guidance, every usage window with its
 * reset time, the last refresh and the next check. Display only: the actions are in Settings (C59).
 *
 * It exists only while open, and its clock with it.
 */
export function UsagePanel({ id, provider, label = null, anchor }: {
  readonly id: string;
  readonly provider: ProviderSnapshot;
  /** Its account's label, when its block shows one (M14b, C42). */
  readonly label?: string | null;
  readonly anchor: RefObject<HTMLElement | null>;
}) {
  const now = useClock();
  // Masked until the preferences say otherwise, even before they have loaded.
  const mask = usePrefs((state) => state.snapshot?.values.privacy.maskEmail ?? true);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | null>(null);

  // Below the block, inside the window: measured before paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const target = anchor.current;
    const element = panel.current;
    if (target === null || element === null) return;
    const rect = target.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - element.offsetWidth - MARGIN));
    setPosition({ left, top: rect.bottom + GAP });
  }, [anchor]);

  const { account, installation, usage } = provider;
  const detail = providerStatusDetail(provider);
  const historical = isHistorical(provider);

  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      className={styles.panel}
      style={position === null ? { visibility: 'hidden' } : { left: position.left, top: position.top }}
    >
      <p className={styles.name}>{accountName(provider.displayName, label)}</p>
      <dl className={styles.facts}>
        {account?.plan !== undefined && (
          <>
            <dt>Plan</dt>
            <dd>{account.plan}</dd>
          </>
        )}
        {account?.email !== undefined && (
          <>
            <dt>Account</dt>
            <dd>{mask ? maskEmail(account.email) : account.email}</dd>
          </>
        )}
        {installation?.version !== undefined && installation.version !== null && (
          <>
            <dt>CLI</dt>
            <dd>{installation.version}</dd>
          </>
        )}
        <dt>Status</dt>
        <dd>{providerStatusSummary(provider)}</dd>
      </dl>
      {detail !== null && <p className={styles.detail}>{detail}</p>}
      {usage !== null && usage.windows.length > 0 && (
        <ul className={styles.windows}>
          {usage.windows.map((window) => (
            <li key={window.id} className={styles.window}>
              <span className={styles.windowName}>
                {window.label}
                {window.scope !== undefined && ` · ${window.scope}`}
              </span>
              <span className={styles.windowPercent}>{window.usedPercent === null ? 'No data' : remainingText(window.usedPercent)}</span>
              <span className={styles.reset}>
                {resetText(window.resetsAt, now)}
                {historical && ' · Historical reading'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <dl className={`${styles.facts} ${styles.freshness}`}>
        <dt>Last refresh</dt>
        <dd>{provider.asOf === null ? 'Never' : formatDateTime(provider.asOf)}</dd>
        {provider.nextRefreshAt !== null && (
          <>
            <dt>Next check</dt>
            <dd>{relativeTime(provider.nextRefreshAt, now)}</dd>
          </>
        )}
      </dl>
    </div>,
    document.body,
  );
}
