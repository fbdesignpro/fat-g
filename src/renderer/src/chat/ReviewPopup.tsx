// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef, useState } from 'react';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import { sameInstance } from '@shared/contracts/instances';
import { availabilityOf, readingMode } from '@shared/contracts/permissions';
import type { ModelPreset } from '@shared/contracts/presets';
import type { SessionEntry } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { ModelDialog } from '../model-chooser/ModelDialog';
import { useAppState } from '../state/store';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { MISSING, usePlanInfo } from './plans-store';
import { REVIEW_WORDS, reviewRefusalText } from './review-words';
import styles from './Chat.module.css';
import dialogStyles from '../model-chooser/ModelDialog.module.css';

export interface ReviewPopupProps {
  readonly entry: SessionEntry;
  readonly planId: string;
  /** The version the panel decides: complete, since a line waits only on a complete version. */
  readonly version: number;
  /** The workflow's revision the panel was drawn from (decision 0029): a start from an older state starts nothing. */
  readonly revision: number;
  readonly title: string;
  readonly providerName: string;
}

/** A provider's name as the app state gives it. */
const providerNameOf = (snapshot: AppStateSnapshot | null | undefined, providerId: string): string => snapshot?.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;

/**
 * Why a reviewer cannot run on the preset (C1): its provider lists no reading mode, or the account
 * cannot use it. What else a start would refuse, main says at the press.
 */
export function reviewerBlock(preset: ModelPreset, snapshot: AppStateSnapshot | null): string | null {
  const name = providerNameOf(snapshot, preset.providerId);
  const permissions = snapshot?.providers.find((provider) => provider.id === preset.providerId)?.descriptor.capabilities.permissions ?? null;
  const reading = permissions === null ? undefined : readingMode(permissions);
  if (reading === undefined) return REVIEW_WORDS.noReadingMode(name);
  const account = snapshot?.providers.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, preset));
  return availabilityOf(account?.modes, reading.id).available ? null : REVIEW_WORDS.readingUnavailable(name);
}

/**
 * Review by model (docs/planning/_archive/M22e.md, Design 3; C1, C2, C14, C39, C52): the panel's
 * button, and the model dialog it opens — the plan and its version, Presets and Recents in columns,
 * Custom opening the regular chooser on the selected preset, any account the project is offered to,
 * and a note that the review is a session of its own; then Start review and Cancel.
 *
 * The button says why where a review cannot start, and stays reachable: the plan has a newer complete
 * version than the one decided, or a start is under way. Start review makes the reviewer, which main
 * selects; nothing else takes the focus.
 */
export function ReviewPopup({ entry, planId, version, revision, title }: ReviewPopupProps) {
  const { record } = entry;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  const info = usePlanInfo(planId);
  const snapshot = useAppState((state) => state.snapshot);
  const newer = info === undefined || info === MISSING ? undefined : [...info.versions].reverse().find((one) => one.state === 'complete' && one.version > version);
  const blocked = newer !== undefined ? REVIEW_WORDS.stale(newer.version) : busy ? REVIEW_WORDS.inFlight : null;

  const start = async (preset: ModelPreset): Promise<string | null> => {
    setBusy(true);
    try {
      const answer = await invoke('reviews:start', { sessionId: record.id, planId, version, revision, preset });
      return answer.status === 'started' ? null : reviewRefusalText(answer.reason, providerNameOf(snapshot, preset.providerId));
    } catch {
      return REVIEW_WORDS.writeFailed;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${styles.button} ${styles.planReview}`}
        data-review-by-model=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={blocked !== null || undefined}
        {...(blocked === null ? {} : tooltip.targetProps)}
        onClick={() => { if (blocked === null) setOpen(true); }}
      >
        {REVIEW_WORDS.review}
      </button>
      {blocked !== null && <Tooltip id={tooltip.id} open={tooltip.open} anchor={button}>{blocked}</Tooltip>}
      {open && (
        <ModelDialog
          projectId={record.projectId}
          title={REVIEW_WORDS.popup}
          initial={{ providerId: record.providerId, instanceId: record.instanceId, model: record.model, effort: record.effort, speed: record.speed }}
          confirmLabel={REVIEW_WORDS.start}
          lead={<p className={dialogStyles.lead}>{REVIEW_WORDS.plan(title, version)}</p>}
          showSelection={false}
          details={() => <p>{REVIEW_WORDS.cost}</p>}
          check={reviewerBlock}
          onConfirm={start}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
