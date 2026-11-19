// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useRef, useState } from 'react';
import announcer from '../ui/Announcer.module.css';
import { TRASH_PATH } from '../ui/icons';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import styles from './ArtifactBar.module.css';

export const ARTIFACT_WORDS = {
  copy: 'Copy entire text', imageCopy: 'Copy image', copied: 'Copied.', copyFailed: 'Could not copy.',
  folder: 'Show in folder', folderFailed: 'Could not show in folder.', reloadFailed: 'Could not reload.',
} as const;

/** Shared presentation only: each kind supplies its own label and actions. */
export function ArtifactBar({ label, metadata, children }: { readonly label: string; readonly metadata?: ReactNode; readonly children?: ReactNode }) {
  return <div className={styles.bar} role="group" aria-label={`${label} controls`} data-artifact-bar=""><div className={styles.heading}><span className={styles.label}>{label}</span>{metadata !== undefined && <div className={styles.detail}>{metadata}</div>}</div><div className={styles.actions}>{children}</div></div>;
}

export function ArtifactIcon({ kind }: { readonly kind: 'copy' | 'folder' | 'reload' | 'info' | 'done' | 'trash' }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === 'copy' && <><rect x="8" y="8" width="13" height="13" rx="1" /><path d="M16 5V3H3v13h2" /></>}
    {kind === 'folder' && <path d="M3 7V4h6l3 3h9v13H3V7Z" />}
    {kind === 'reload' && <><path d="M20 7V3m0 4h-4M20 7a9 9 0 1 0 1 9" /></>}
    {kind === 'info' && <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>}
    {kind === 'done' && <path d="m5 12 4 4L19 6" />}
    {kind === 'trash' && <path d={TRASH_PATH} />}
  </svg>;
}

/** Transient feedback belongs to this showing and never survives leaving the tab. */
export function ArtifactAction({ kind, label, disabled = false, action, tooltip }: {
  readonly kind: 'copy' | 'folder' | 'reload'; readonly label: string; readonly disabled?: boolean; readonly action: () => void | Promise<void>; readonly tooltip?: ReactNode;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useTooltip();
  const [said, setSaid] = useState<'idle' | 'done' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  const message = said === 'failed' ? (kind === 'folder' ? ARTIFACT_WORDS.folderFailed : kind === 'reload' ? ARTIFACT_WORDS.reloadFailed : ARTIFACT_WORDS.copyFailed) : said === 'done' && kind === 'copy' ? ARTIFACT_WORDS.copied : '';
  const press = async (): Promise<void> => {
    setBusy(true);
    let outcome: 'done' | 'failed' = 'done';
    try { await action(); } catch { outcome = 'failed'; }
    if (!alive.current) return;
    setBusy(false);
    setSaid(outcome);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid('idle'), 2_000);
  };
  return <span className={styles.action}>
    <button {...(tooltip === undefined ? {} : tip.targetProps)} ref={anchor} type="button" className={styles.button} aria-label={label} title={tooltip === undefined ? message || label : undefined} disabled={disabled || (busy && kind !== 'reload')} onClick={() => void press()}><ArtifactIcon kind={said === 'done' && kind === 'copy' ? 'done' : kind} /></button>
    {tooltip !== undefined && <Tooltip id={tip.id} open={tip.open} anchor={anchor}>{message || tooltip}</Tooltip>}
    <span className={announcer.announcer} role="status">{message}</span>
  </span>;
}

export function ArtifactInformation({ label, children, disabled = false }: { readonly label: string; readonly children: ReactNode; readonly disabled?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useTooltip();
  return <><button {...tip.targetProps} ref={anchor} type="button" className={styles.button} aria-label={label} disabled={disabled}><ArtifactIcon kind="info" /></button><Tooltip id={tip.id} open={!disabled && tip.open} anchor={anchor}>{children}</Tooltip></>;
}
