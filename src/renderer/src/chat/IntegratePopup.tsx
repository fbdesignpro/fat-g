// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useId, useRef, useState } from 'react';
import { shownLabel } from '@shared/contracts/instances';
import type { ModelPreset } from '@shared/contracts/presets';
import { type IntegrationOffer, REVIEW_BOUNDS, type ReviewView } from '@shared/contracts/review';
import type { SessionEntry } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { ModelDialog } from '../model-chooser/ModelDialog';
import dialogStyles from '../model-chooser/ModelDialog.module.css';
import { selectSession } from '../sessions/select';
import { useAppState } from '../state/store';
import { Popup } from '../ui/Popup';
import { REVIEW_WORDS, reviewRefusalText } from './review-words';
import styles from './Chat.module.css';

export interface IntegratePopupProps {
  readonly entry: SessionEntry;
  readonly review: ReviewView;
  readonly providerName: string;
  readonly title: string;
  readonly accepted: number;
}

const targetKey = (offer: IntegrationOffer): string => (offer.target === 'new' ? 'new' : offer.target.sessionId);
/** A listed chat takes the integration by its route; a new session is offered whatever its model, which is chosen next. */
const usableOffer = (offer: IntegrationOffer): boolean => offer.target === 'new' || offer.route !== null;

/**
 * The rows the popup offers (the maintainer): the chat that created the plan and a new
 * chat, each where main offers it, in that order. The chat the popup stands in, the reviewer's, is not
 * offered: under its reading mode it can write no plan. Nor are the other chats main lists — the one
 * the review started from, a chat the plan was brought into.
 */
function rowsOf(offers: readonly IntegrationOffer[], here: string): { readonly offer: IntegrationOffer; readonly label: string }[] {
  const own = offers.find((offer) => offer.target !== 'new' && offer.roles.includes('own') && offer.target.sessionId !== here);
  const fresh = offers.find((offer) => offer.target === 'new');
  return [
    ...(own === undefined ? [] : [{ offer: own, label: REVIEW_WORDS.usingOwn }]),
    ...(fresh === undefined ? [] : [{ offer: fresh, label: REVIEW_WORDS.usingNew }]),
  ];
}

/**
 * Integrate N findings, and its target popup (docs/planning/_archive/M22e.md, Design 7; C9, C10, C24, C50),
 * simplified at the maintainer's word: "Integrate using…" the chat that created the plan
 * or a new chat, as radio rows; the plan's chat with no route now is dimmed, why said on hover and to
 * assistive technology; how far over its bound the findings and notes are, where they are; then
 * Integrate and Cancel. Main works the route out again at the press, and nothing goes before it.
 *
 * A new session is one way (decision 0016): choosing it closes the popup and opens the model dialog
 * on the reviewer's preset — Recents and Presets above the model chooser — whose Integrate sends to a
 * new session on the selection and closes the decision; its Cancel sends nothing.
 */
export function IntegratePopup({ entry, review, providerName, title, accepted }: IntegratePopupProps) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The model dialog for a new session, which has taken the popup's place. */
  const [choosing, setChoosing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const name = useId();
  const rows = rowsOf(review.offers, entry.record.id);
  const usable = rows.map((row) => row.offer).filter(usableOffer);
  const picked = usable.find((offer) => targetKey(offer) === chosen) ?? usable[0];
  const providers = useAppState((state) => state.snapshot?.providers);
  const excess = review.integrationUnits - REVIEW_BOUNDS.integration;
  const notes = Object.values(review.rounds.at(-1)?.notes ?? {}).filter((note) => note !== '').length;

  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>('input:checked, input:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); button.current?.focus(); } };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null;
      if (target !== null && !dialog.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  /** The popup gives way to the model dialog, the focus on Integrate N, where the dialog's Cancel brings it back. */
  const chooseNew = (): void => {
    setOpen(false);
    setProblem(null);
    button.current?.focus();
    setChoosing(true);
  };

  /** Sends to the target; null once sent, else why not in words. */
  const send = async (target: { readonly sessionId: string } | { readonly preset: ModelPreset }): Promise<string | null> => {
    const answer = await invoke('reviews:integrate', { reviewId: review.reviewId, target });
    if (answer.status === 'sent') {
      // Into another chat (the maintainer's V6 review): that chat is selected at once, where the next
      // version is written, and the reviewer's is marked Done, as its Done does. Its next turn — a
      // Send notes once an integration ended without a version — reopens it, as any turn does.
      if (answer.sessionId !== entry.record.id) {
        void selectSession(answer.sessionId).catch(() => undefined);
        void invoke('sessions:complete', { id: entry.record.id }).catch(() => undefined);
      }
      return null;
    }
    const provider = 'preset' in target ? providers?.find((one) => one.id === target.preset.providerId)?.displayName ?? target.preset.providerId : providerName;
    return answer.reason === 'too-long' && answer.excess !== undefined ? REVIEW_WORDS.over(answer.excess) : answer.reason === 'unavailable' && answer.words !== undefined ? answer.words : reviewRefusalText(answer.reason, provider);
  };

  const integrate = (): void => {
    if (busy || picked === undefined || excess > 0) return;
    if (picked.target === 'new') { chooseNew(); return; }
    setBusy(true);
    setProblem(null);
    send({ sessionId: picked.target.sessionId }).then(
      (said) => { if (said === null) setOpen(false); else setProblem(said); },
      () => { setProblem(REVIEW_WORDS.integrateFailed); },
    ).finally(() => { setBusy(false); });
  };

  const integrateNew = async (preset: ModelPreset): Promise<string | null> => {
    try { return await send({ preset }); } catch { return REVIEW_WORDS.integrateFailed; }
  };

  return (
    <>
      <button ref={button} type="button" className={styles.button} data-primary="" data-review-integrate="" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        {REVIEW_WORDS.integrate(accepted)}
      </button>
      {open && (
        <Popup anchor={button} align="start">
          <div ref={dialog} role="dialog" aria-labelledby={labelId} className={styles.reviewPopup} data-integrate-popup="">
            <p id={labelId} className={styles.reviewPopupTitle}>{REVIEW_WORDS.targets}</p>
            <div role="radiogroup" aria-labelledby={labelId} className={styles.targetRows}>
              {rows.map(({ offer, label }) => {
                const key = targetKey(offer);
                const why = usableOffer(offer) ? undefined : offer.reason ?? undefined;
                return (
                  <label key={key} className={styles.targetRow} data-target={key} data-route={offer.route ?? 'none'} title={why}>
                    <input type="radio" name={name} value={key} disabled={!usableOffer(offer)} aria-description={why} checked={picked !== undefined && targetKey(picked) === key} onChange={() => { setChosen(key); if (offer.target === 'new') chooseNew(); }} />
                    <span className={styles.targetName}>{label}</span>
                  </label>
                );
              })}
            </div>
            {excess > 0 && <p className={styles.problem} data-integrate-over="">{REVIEW_WORDS.over(excess)}</p>}
            <div className={styles.reviewPopupActions}>
              <button type="button" className={styles.button} data-primary="" data-integrate-confirm="" aria-disabled={busy || picked === undefined || excess > 0 || undefined} onClick={integrate}>{REVIEW_WORDS.integrateAction}</button>
              <button type="button" className={styles.button} onClick={() => { setOpen(false); button.current?.focus(); }}>{REVIEW_WORDS.cancel}</button>
            </div>
            {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
          </div>
        </Popup>
      )}
      {choosing && (
        <ModelDialog
          projectId={entry.record.projectId}
          title={REVIEW_WORDS.integrateNew}
          initial={{ providerId: review.reviewer.providerId, instanceId: review.reviewer.instanceId, model: review.reviewer.model, effort: review.reviewer.effort, speed: entry.record.id === review.reviewer.sessionId ? entry.record.speed : null }}
          confirmLabel={REVIEW_WORDS.integrateAction}
          details={(preset) => (
            <>
              <p data-integrate-sends="">{REVIEW_WORDS.sends(title, review.version, accepted, notes, preset === null ? null : shownLabel(providers ?? [], preset))}</p>
              {excess > 0 && <p className={dialogStyles.problem} data-integrate-over="">{REVIEW_WORDS.over(excess)}</p>}
            </>
          )}
          check={() => (excess > 0 ? REVIEW_WORDS.over(excess) : null)}
          onConfirm={integrateNew}
          onClose={() => setChoosing(false)}
        />
      )}
    </>
  );
}
