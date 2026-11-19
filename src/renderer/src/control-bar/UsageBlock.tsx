// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import type { ProviderPresentation } from '@shared/contracts/catalog';
import { accountName } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { openSettings } from '../settings/settings-store';
import { compactCountdown } from '../ui/format';
import { useSessionClock } from '../sessions/session-clock';
import { isHistorical, providerStatusDetail } from '../ui/provider-status-detail';
import { providerStatusLabel } from '../ui/provider-status-label';
import { ProviderMark } from './ProviderMark';
import { StatusTrack, UsageBar } from './UsageBar';
import styles from './UsageBlock.module.css';
import { UsagePanel } from './UsagePanel';

/** Bars per block; the panel lists every window (C34). */
export const MAX_BARS = 3;

/**
 * One provider in the usage box (C34–C42; M100, C54, C55, C69, C85): its logo, and its usage as bars — what
 * remains of each window and how long until it resets — or a short status when there is none. It never shows who the account
 * belongs to; the rollover panel is the one place in the usage box that does (C42).
 *
 * Activating it opens that provider's section in Settings (C41). The mark is its one focusable
 * part — a button named after the provider — while a pointer can use the whole block. The bars stay
 * outside the button, so each keeps its meter semantics (C60) instead of being flattened into a
 * button's name.
 *
 * Its colour and logo come from the provider's catalog entry (M13, C21), which the strip passes
 * down; there is none only before the first snapshot, and then no logo is drawn.
 *
 * Historical readings have hollow bars, with the reason in words on the
 * line under them — the line the box reserves for an account's label, which keeps the logo's column
 * while they share it.
 *
 * `label` is its account's, given only when its provider has more than one account configured
 * (M14b, C40–C42): one line under the bars, and part of the button's name and the panel's heading.
 * It is the user's own word for the account, never who the account belongs to.
 */
export function UsageBlock({ provider, presentation, label = null }: {
  readonly provider: ProviderSnapshot;
  readonly presentation?: ProviderPresentation | undefined;
  readonly label?: string | null;
}) {
  const block = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // Escape closes the panel until the pointer or the focus comes back (C57).
  const [dismissed, setDismissed] = useState(false);
  const panelOpen = (hovered || focused) && !dismissed;

  useEffect(() => {
    if (!panelOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panelOpen]);

  const windows = (provider.usage?.windows ?? []).slice(0, MAX_BARS);
  const historical = isHistorical(provider);
  // Explain every hollow reading in the block itself. Error messages are already user-facing
  // and free of personal data (the shared status contract); never use a raw CLI error here.
  const statusCaption = provider.status.kind === 'error' ? provider.status.message : providerStatusLabel(provider);
  // The bars' countdowns run on the page's one session clock while a shown window has a reset time (C85).
  const now = useSessionClock(windows.some((window) => window.resetsAt !== null));
  // Each bar's countdown; a bar that would repeat the one above it says nothing, so a model's weekly
  // window under the weekly one adds no words (C85).
  const countdowns = windows.map((window) => (window.resetsAt === null ? '' : compactCountdown(window.resetsAt, now)));
  const shown = countdowns.map((text, index) => (index > 0 && text === countdowns[index - 1] ? '' : text));

  return (
    <div
      ref={block}
      className={styles.block}
      data-usage-block={provider.id}
      data-instance={provider.instanceId}
      data-historical={historical ? '' : undefined}
      style={presentation === undefined ? undefined : ({ '--bar-color': presentation.barColor } as CSSProperties)}
      onPointerEnter={() => {
        setHovered(true);
        setDismissed(false);
      }}
      onPointerLeave={() => setHovered(false)}
      onClick={() => {
        setDismissed(true);
        openSettings({ provider: provider.id, instanceId: provider.instanceId });
      }}
    >
      {/* Named after the provider (C54), whose logo it shows, then the account when one shows (M14b, C41); described by the panel. */}
      <button
        type="button"
        className={styles.markButton}
        aria-label={accountName(provider.displayName, label)}
        aria-describedby={panelId}
        onFocus={() => {
          setFocused(true);
          setDismissed(false);
        }}
        onBlur={() => setFocused(false)}
      >
        {presentation !== undefined && <ProviderLogo name={provider.displayName} presentation={presentation} />}
      </button>
      {windows.length > 0 ? (
        <div className={styles.bars}>
          {windows.map((window, index) => (
            <UsageBar key={window.id} window={window} historical={historical} countdown={shown[index] ?? ''} />
          ))}
          {historical && (
            <span className={styles.statusCaption} data-usage-status="" title={providerStatusDetail(provider) ?? statusCaption}>
              {statusCaption}
            </span>
          )}
        </div>
      ) : (
        <StatusTrack label={providerStatusLabel(provider)} />
      )}
      {label !== null && (
        <span className={styles.accountLabel} data-account-label="">
          {label}
        </span>
      )}
      {panelOpen && <UsagePanel id={panelId} provider={provider} label={label} anchor={block} />}
    </div>
  );
}

/**
 * The provider's logo (M100, C69), as wide as the column and as tall as the bars beside it, kept
 * whole within that box; a provider whose module has none gets its mark on its colour instead.
 * Decorative: the button around it is named after the provider.
 */
function ProviderLogo({ name, presentation }: { readonly name: string; readonly presentation: ProviderPresentation }) {
  if (presentation.logo !== undefined) return <img className={styles.logo} src={presentation.logo} alt="" />;
  return (
    <span className={styles.logoStandIn} data-logo-stand-in="">
      <ProviderMark name={name} presentation={presentation} size={19} fill="var(--color-on-avatar)" decorative />
    </span>
  );
}
