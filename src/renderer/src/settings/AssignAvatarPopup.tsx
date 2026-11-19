// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type SyntheticEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { type Assignments, AVATAR_WORDS, type AvatarListing, avatarProblemWords, type AvatarRef, familySupports, type FamilyView, type ResolvedAvatar, sameRef } from '@shared/contracts/avatars';
import { CloseIcon } from '../control-bar/icons';
import { Avatar } from '../sessions/Avatar';
import dialogStyles from '../ui/Dialog.module.css';
import { avatarsForDisplay, resolvedOf } from './avatar-listing';
import styles from './Settings.module.css';

/** The model an avatar is chosen for: its provider, its key and the name its row shows. */
export interface AssignTarget {
  readonly providerId: string;
  readonly key: string;
  readonly name: string;
}

/** The popup's words (C25, C26). */
export const ASSIGN_POPUP_WORDS = {
  title: (model: string): string => `Avatar for ${model}`,
  close: 'Close',
  current: 'Current',
} as const;

export interface AssignAvatarPopupProps {
  /** The listing the tab last read: a Rescan while the popup is open redraws it (C25). */
  readonly listing: AvatarListing | null;
  /** Null while the popup is closed. */
  readonly target: AssignTarget | null;
  /** The overrides, so that a row says it is the model's own (C26). */
  readonly assignments: Assignments;
  /** A press: one patch of one entry (C6). */
  readonly onAssign: (target: AssignTarget, ref: AvatarRef) => void;
  readonly onClose: () => void;
}

/** An avatar of the listing as a row of the popup. */
interface Choice {
  readonly ref: AvatarRef;
  readonly resolved: ResolvedAvatar | null;
  /** Whose starting family its family is, for the placeholder's colour; empty for none. */
  readonly providerId: string;
  readonly words: readonly string[];
  readonly current: boolean;
  /** No usable portrait: listed, never assigned (C26). */
  readonly disabled: boolean;
}

const refKey = (ref: AvatarRef): string => `${ref.origin}\u0000${ref.family}\u0000${ref.avatar}`;

/**
 * Assign avatar (docs/planning/_archive/M103.md, Design 6; C25–C29): every avatar of the listing, the built-in
 * families first, then the user's, each family a group and each avatar a row that says what a press
 * does before it — "Current", or listed disabled with its problem. A press
 * assigns it and closes; the close button and Escape close with nothing sent. A modal `<dialog>` over
 * Settings, as Preview is: Settings stays open. It asks main for nothing; its thumbnails load by the
 * listing's ids, the placeholder under each, and it shows no path and no account label.
 */
export function AssignAvatarPopup({ listing, target, assignments, onAssign, onClose }: AssignAvatarPopupProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const baseId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const open = target !== null;

  const choiceOf = (family: FamilyView, view: FamilyView['avatars'][number]): Choice => {
    const ref: AvatarRef = { origin: family.origin, family: family.folder, avatar: view.folder };
    const resolved = resolvedOf(family, view);
    // Several models may share an avatar (decision 0031): only this model's own override is named.
    const own = target === null ? undefined : assignments[target.providerId]?.[target.key];
    const current = own !== undefined && sameRef(own, ref);
    const words: string[] = [];
    if (view.fallback) words.push(AVATAR_WORDS.fallback);
    if (resolved === null) {
      const problem = view.problems.find((candidate) => candidate.kind === 'no-portrait');
      words.push(avatarProblemWords(problem ?? { kind: 'no-portrait', path: `${family.folder}/${view.folder}` }));
    } else if (current) words.push(ASSIGN_POPUP_WORDS.current);
    return { ref, resolved, providerId: family.defaultFor[0] ?? '', words, current, disabled: resolved === null };
  };

  const groups = (listing?.roots ?? []).flatMap((root) => root.families.filter((family) => family.avatars.length > 0 && target !== null && familySupports(family, target.providerId)).map((family) => ({ family, choices: avatarsForDisplay(family).map((view) => choiceOf(family, view)) })));
  const choices = groups.flatMap((group) => group.choices);
  // The row the keys start from: the one last moved to, else this model's own, else the first (C27).
  const active = choices.find((choice) => refKey(choice.ref) === selected) ?? choices.find((choice) => choice.current) ?? choices[0];
  const optionId = (choice: Choice): string => `${baseId}-${choices.indexOf(choice)}`;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      element.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // React passes `close` up its own tree: stopped here, so Settings does not close with it.
  const onDialogClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    const previous = opener.current;
    opener.current = null;
    setSelected(null);
    if (previous?.isConnected === true) previous.focus();
    if (open) onClose();
  };

  const press = (choice: Choice): void => {
    if (target === null || choice.disabled) return;
    onAssign(target, choice.ref);
    dialog.current?.close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (active === undefined) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      press(active);
      return;
    }
    const at = choices.indexOf(active);
    const index = event.key === 'ArrowDown' ? Math.min(choices.length - 1, at + 1) : event.key === 'ArrowUp' ? Math.max(0, at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : -1;
    const next = choices[index];
    if (next === undefined) return;
    event.preventDefault();
    setSelected(refKey(next.ref));
    document.getElementById(optionId(next))?.focus();
  };

  return (
    <dialog ref={dialog} className={`${dialogStyles.dialog} ${dialogStyles.narrow}`} aria-labelledby={titleId} onClose={onDialogClose} data-assign-avatar="">
      {target !== null && (
        <>
          <header className={dialogStyles.header}>
            <h2 id={titleId} className={dialogStyles.title}>{ASSIGN_POPUP_WORDS.title(target.name)}</h2>
            <button type="button" className={dialogStyles.closeButton} aria-label={ASSIGN_POPUP_WORDS.close} onClick={() => dialog.current?.close()}>
              <CloseIcon />
            </button>
          </header>
          <div className={dialogStyles.body}>
            <p className={styles.statusLine}>Assign to: <code>{target.key}</code></p>
            {choices.length === 0 ? (
              <p className={styles.muted}>{AVATAR_WORDS.noneYet}</p>
            ) : (
              <div className={styles.assignChoices} role="listbox" aria-labelledby={titleId} onKeyDown={onKeyDown}>
                {groups.map(({ family, choices: rows }, index) => (
                  <div key={`${family.origin}:${family.folder}`} className={styles.assignGroup} role="group" aria-labelledby={`${baseId}-group-${index}`} data-assign-family={family.folder} data-origin={family.origin}>
                    <p id={`${baseId}-group-${index}`} className={styles.assignGroupTitle}>
                      {family.folder} · {family.origin === 'built-in' ? AVATAR_WORDS.builtIn : AVATAR_WORDS.user}
                    </p>
                    {rows.map((choice) => (
                      <div
                        key={choice.ref.avatar}
                        id={optionId(choice)}
                        role="option"
                        aria-selected={choice === active}
                        aria-disabled={choice.disabled ? true : undefined}
                        aria-label={[choice.ref.avatar, ...choice.words].join(', ')}
                        tabIndex={choice === active ? 0 : -1}
                        className={styles.assignmentRow}
                        data-assign-choice={choice.ref.avatar}
                        onClick={() => { setSelected(refKey(choice.ref)); press(choice); }}
                      >
                        <Avatar providerId={choice.providerId} avatar={choice.resolved} size="thin" />
                        <span className={styles.assignmentName}>{choice.ref.avatar}</span>
                        {choice.words.length > 0 && <span className={styles.assignmentWords}>{choice.words.join(' · ')}</span>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
