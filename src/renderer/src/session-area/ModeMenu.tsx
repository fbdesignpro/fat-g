// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { Fragment, type MouseEvent, useId, useState } from 'react';
import { availabilityOf, declaredTransition, type ModeAvailability, modeOf, modeReasonWords, modeTitle, MODE_WORDS, type PermissionMode, setupHolds } from '@shared/contracts/permissions';
import type { SessionEntry } from '@shared/contracts/sessions';
import { useAsides } from '../chat/asides-store';
import { useGrants } from '../chat/grants-store';
import { useWorkflows } from '../chat/workflow-store';
import { invoke } from '../ipc/client';
import { openSandboxSetup } from '../settings/sandbox-setup-store';
import { useAppState } from '../state/store';
import announcer from '../ui/Announcer.module.css';
import { menuStyles, Popup } from '../ui/Popup';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { useMenu } from '../ui/useMenu';
import { useModeMenuAsked } from './mode-menu-store';
import { MODE_LABELS, SET_MODE_FAILED_TEXT, setModeRefusalText } from './mode-words';
import { sessionAccount, usePermissions } from './selected';
import styles from './SessionArea.module.css';

/** What is said of a mode beside its description (C3, C55, C65, C87): why its account cannot use it, where it can write, what choosing it records, and what the change does to the session. */
function notesOf(mode: PermissionMode, availability: ModeAvailability, provider: string, restarts: boolean, liveGrants: number, retry: boolean): string[] {
  const places = availability.places;
  return [
    ...(availability.available ? [] : [availability.reason === null ? MODE_LABELS.cannotUse(mode.label) : modeReasonWords(availability.reason, mode.label, provider)]),
    ...(retry && availability.available ? [MODE_WORDS.tryAgain] : []),
    ...(availability.unconfined ? [MODE_WORDS.unconfined] : []),
    ...(places?.temporary === true ? [MODE_WORDS.temporary] : []),
    ...(places !== null && places.roots.length > 0 ? [MODE_WORDS.otherRoots(provider, places.roots.length)] : []),
    ...(places?.network === true ? [MODE_WORDS.network(provider)] : []),
    ...(availability.records ? [MODE_WORDS.records(provider)] : []),
    ...(restarts ? [MODE_WORDS.restarts] : []),
    // Only a change that restarts the process ends a grant (C86).
    ...(restarts && liveGrants > 0 ? [MODE_WORDS.endsGrants(liveGrants)] : []),
  ];
}

/**
 * The mode control (docs/planning/_archive/M22.md, Design 3, 10; C2, C3, C46, C60, C82, C86, C87, C89,
 * C90), above the thick rule at the chat column's right (docs/planning/_archive/M100.md; the layout reference):
 * a menu button that shows the chat's saved mode — "Ask first" — with no arrow (M100, C75); its
 * accessible name says where the mode came from — "Ask first · project default" — and, until a
 * process of the session has confirmed that mode, that it applies at the next prompt. No line on
 * screen says either (the maintainer's review of M100). It is the one place a session's mode is changed, and it changes this chat's alone: no
 * default is saved from here.
 *
 * Its menu lists the provider's modes in the provider's own words, the saved one marked: each with
 * its description, and what else is known of it for this account — why it cannot be used, where it
 * can write, what choosing it makes the CLI record — and, before the press, what the change does:
 * that it restarts the session's process, and how many of the session's grants end with that. A
 * mode its account cannot use is listed and cannot be chosen, with a Set up item where the CLI's own
 * setup would make it usable. Under the list stands the provider's one line on the user's own
 * configuration. Every one of those words is the provider's declaration or the contract's: the page
 * holds no mode table and no provider word.
 *
 * While the session runs, an aside of it does, a change is under way or the account's sandbox is
 * being set up, nothing can be chosen: the menu still opens, to be read, with the reason at its
 * head. A plan the chat takes part in that is ready takes a change all the same (decision 0029):
 * main closes the request the chat holds on it first, whose turn is what runs, and the plan's
 * decision stands on the same version. It is as it always is under the two mode blocks, since a change is their remedy (C89).
 * Main decides every change; a refusal is said under the button.
 *
 * A session whose provider declares no mode, or whose chat has none, draws no control.
 */
export function ModeMenu({ entry }: { readonly entry: SessionEntry }) {
  const { open, setOpen, close, button, buttonProps, menuProps } = useMenu();
  const tooltip = useTooltip();
  const { record, summary } = entry;
  const providers = useAppState((state) => state.snapshot?.providers);
  const capability = usePermissions(record.providerId);
  const grants = useGrants(record.id);
  const asideRuns = useAsides((state) => state.sessionId === record.id && state.markers.some((marker) => marker.running));
  // As the chat's read holds it: the menu asks main nothing of its own.
  const part = useWorkflows((state) => state.bySession[record.id]);
  const planReady = part?.kind === 'plan' && part.role === 'participant' && part.workflow.state === 'ready' && part.workflow.busy === null;
  // What main refused, and for which saved mode: it is said until the chat's mode changes, or the menu is opened again.
  const [problem, setProblem] = useState<{ readonly text: string; readonly saved: string } | null>(null);
  // Change mode, pressed in the chat (C89): the menu opens when the count of those requests changes.
  const asked = useModeMenuAsked(record.id);
  const [seen, setSeen] = useState(asked);
  const heldId = useId();
  const noteId = useId();
  const headingId = useId();

  // Its account's snapshot says what the account can use; the provider's declaration is the same for every account of it.
  const { account, name } = sessionAccount(providers, record);
  const saved = entry.mode;
  if (capability === null || saved === null) return null;
  if (asked !== seen) {
    setSeen(asked);
    setOpen(true);
  }

  const label = modeOf(capability, saved.id)?.label ?? saved.id;
  const title = modeTitle(label, saved.source);
  // No process of the session has confirmed the saved mode yet (C75).
  const pending = saved.id !== summary.mode;
  // And while a plan's decision waits (M22b, C58): Execute names the mode it runs under.
  const held = (summary.status === 'running' && !planReady) || asideRuns || entry.changingMode ? MODE_WORDS.busy : entry.planPending === true && !planReady ? MODE_WORDS.planPending : setupHolds(account?.sandboxSetup) ? MODE_WORDS.settingUp(name) : null;
  const liveGrants = grants.filter((grant) => grant.live).length;
  // The chat's mode stands unconfirmed (C46): Send waits for a mode to be taken, the same one included.
  const unconfirmed = entry.block === 'mode-unconfirmed';

  const choose = (mode: PermissionMode, availability: ModeAvailability): void => {
    // Listed, and not to be chosen: the press does nothing, and the menu stays to be read.
    if (held !== null || !availability.available) return;
    close(true);
    // The saved mode is no change — but for one its last start did not confirm, which choosing again tries anew (C46, C104).
    if (mode.id === saved.id && !unconfirmed) return;
    setProblem(null);
    invoke('chat:setMode', { sessionId: record.id, mode: mode.id }).then(
      // Taken: the session's entry brings the mode. Refused: the chat's mode is as it was.
      (answer) => {
        if (answer.status !== 'refused') return;
        const text = setModeRefusalText(answer.reason, name, { label: mode.label, availability }, answer.detail ?? null);
        if (text !== null) setProblem({ text, saved: saved.id });
      },
      () => { setProblem({ text: SET_MODE_FAILED_TEXT, saved: saved.id }); },
    );
  };

  const setUp = (): void => {
    close(true);
    openSandboxSetup({ providerId: record.providerId, instanceId: record.instanceId });
  };

  return (
    <div className={styles.mode} data-session-mode={saved.id} data-mode-source={saved.source} data-mode-pending={pending ? '' : undefined}>
      <button
        {...buttonProps}
        {...tooltip.targetProps}
        type="button"
        className={styles.modeButton}
        aria-label={MODE_LABELS.button(pending ? `${title}, ${MODE_WORDS.atNextPrompt}` : title)}
        aria-describedby={held === null ? tooltip.id : `${tooltip.id} ${heldId}`}
        data-held={held !== null || undefined}
        onClick={(event: MouseEvent<HTMLButtonElement>) => { setProblem(null); buttonProps.onClick(event); }}
      >
        <span className={styles.menuText}>{label}</span>
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open && !open} anchor={button} side="above">
        {MODE_LABELS.tooltip}
      </Tooltip>
      {/* Why nothing can be chosen now, for whoever reaches the button without opening it. */}
      {held !== null && <span id={heldId} className={announcer.announcer}>{held}</span>}
      {open && (
        <Popup anchor={button} align="end">
          <div {...menuProps} aria-labelledby={headingId} aria-describedby={noteId} className={`${menuStyles.menu} ${styles.modeMenu}`} data-mode-menu="">
            <h2 id={headingId} className={styles.modeMenuTitle}>{MODE_LABELS.menu}</h2>
            {held !== null && <p className={styles.modeMenuNote} role="note" data-mode-held="">{held}</p>}
            {capability.modes.map((mode) => {
              const availability = availabilityOf(account?.modes, mode.id);
              const chosen = mode.id === saved.id;
              // Only a live process is restarted, and from the mode it confirmed (C2, C75): with none, the choice is saved and the next prompt starts under it.
              const restarts = !chosen && summary.mode !== null && declaredTransition(capability, summary.mode, mode.id) === 'restart';
              const notes = notesOf(mode, availability, name, restarts, liveGrants, chosen && unconfirmed);
              return (
                <Fragment key={mode.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={chosen}
                    aria-disabled={held !== null || !availability.available || undefined}
                    tabIndex={-1}
                    className={`${menuStyles.item} ${styles.modeItem}`}
                    data-mode={mode.id}
                    data-unavailable={availability.available ? undefined : availability.reason ?? ''}
                    onClick={() => choose(mode, availability)}
                  >
                    <span className={styles.modeItemName}>{mode.label}</span>
                    <span className={styles.modeItemBody}>
                      <span className={styles.modeItemText}>{mode.description}</span>
                      {/* One paragraph, each thing said of it set apart by a dot: five modes stand under the header at the minimum window size. */}
                      {notes.length > 0 && (
                        <span className={styles.modeItemNotes}>
                          {notes.map((note, index) => (
                            <Fragment key={index}>
                              {index > 0 && ' · '}
                              <span>{note}</span>
                            </Fragment>
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                  {/* The CLI's own setup would make it usable (C60): its dialog opens, and nothing is sent before its own press. */}
                  {!availability.available && availability.setup && (
                    <button type="button" role="menuitem" tabIndex={-1} className={`${menuStyles.item} ${styles.modeItem}`} aria-label={MODE_LABELS.setUpFor(mode.label)} data-mode-setup={mode.id} onClick={setUp}>
                      <span className={styles.modeItemBody}>{MODE_LABELS.setUp}</span>
                    </button>
                  )}
                </Fragment>
              );
            })}
            {/* Once, under the list, and not per mode (C3): the user's own configuration acts as it lets it. */}
            <p id={noteId} className={styles.modeMenuNote} data-mode-inherited="">{capability.inherited}</p>
          </div>
        </Popup>
      )}
      {problem !== null && problem.saved === saved.id && <p className={styles.modeProblem} role="status">{problem.text}</p>}
    </div>
  );
}
