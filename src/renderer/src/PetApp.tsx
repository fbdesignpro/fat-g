// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, type ReactNode, useRef } from 'react';
import { DEFAULT_PET_SIZE, PET_LAYOUT, PET_SIZES, type PetSize, type PetView } from '@shared/contracts/pet';
import { SmokeProbe } from './diagnostics/SmokeProbe';
import { invoke } from './ipc/client';
import { PetCapsule } from './pet/PetCapsule';
import petStyles from './pet/Pet.module.css';
import styles from './PetApp.module.css';
import { useAppState } from './state/store';
import { NameTip, useNameTip } from './ui/Tooltip';


/**
 * The Pet window's content — the "mini window" in everything the user sees; the code, its
 * files, channels and stored keys keep `pet` (decision 0010): the sessions running or waiting on the user, each under
 * its project's name, in the Main window's order — or a line saying there are none. Main builds the
 * view by an allowlist and sizes the window to it (src/main/state/pet-view.ts, src/main/windows/pet-fit.ts),
 * from the same geometry this page lays its rows out by. It never renders account fields: main's
 * projection strips them (src/main/state/projection.ts), and this is the second line of defence.
 */
export function PetApp() {
  const snapshot = useAppState((state) => state.snapshot);
  const view = snapshot?.pet;
  const size = view?.size ?? DEFAULT_PET_SIZE;

  return (
    <div className={styles.frame} style={layout(size)}>
      {/* The Pet has no OS frame: this strip is what moves it. Only the strip — everything below it
          stays ordinary DOM. */}
      <header className={styles.handle}>
        <span className={styles.brand}>
          <span aria-hidden="true">⠿</span> fat-g
        </span>
        <span className={styles.controls}>
          {/* One button per size, each drawing its size; the one in use pressed, and drawn inverted. */}
          <span className={styles.sizes} role="group" aria-label="Capsule size">
            {PET_SIZES.map((option) => (
              <BarButton
                key={option}
                name={SIZE_NAMES[option]}
                className={styles.sizeButton}
                pressed={size === option}
                disabled={view === undefined}
                onClick={() => { if (option !== size) setSize(option); }}
              >
                <SizeIcon size={option} />
              </BarButton>
            ))}
          </span>
          <BarButton name="Hide the mini window" className={styles.barButton} onClick={hidePet}>
            ×
          </BarButton>
        </span>
      </header>

      <main className={styles.pet}>
        {snapshot === null ? (
          <p className={styles.muted}>Waiting for the main process…</p>
        ) : view === undefined || view.projects.length === 0 ? (
          <button type="button" className={styles.emptyButton} aria-label="Open the main window" onClick={showMain}>
            Nothing running or waiting on you
          </button>
        ) : (
          <PetList view={view} />
        )}
      </main>
      <SmokeProbe page="pet" />
    </div>
  );
}

function PetList({ view }: { readonly view: PetView }) {
  return (
    <ul className={petStyles.projects} data-pet-size={view.size}>
      {view.projects.map((project) => (
        <li key={project.id}>
          <h2 className={petStyles.project}>{project.name}</h2>
          <ul className={petStyles.sessions} aria-label={project.name}>
            {project.sessions.map((session) => (
              <PetCapsule key={session.record.id} session={session} size={view.size} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** The rows' heights, from the geometry main sizes the window by. */
function layout(size: PetSize): CSSProperties {
  return {
    '--pet-bar': `${PET_LAYOUT.bar}px`,
    '--pet-project': `${PET_LAYOUT.project}px`,
    '--pet-row': `${PET_LAYOUT.row[size]}px`,
    // The avatar stands at the capsule's full height: the Main window's capsule's, or the Pet's smaller one (Avatar.tsx).
    '--pet-avatar': `${PET_LAYOUT.row[size]}px`,
    '--pet-empty': `${PET_LAYOUT.empty}px`,
  } as CSSProperties;
}

/** Main keeps it, for this run and in the preferences, and the next view comes at that size (`pet:setSize`). */
function setSize(size: PetSize): void {
  invoke('pet:setSize', { size }).catch(() => undefined);
}

/** Main hides the window and remembers it (the `pet:hide` channel); the Main window's Pet button shows it again. */
function hidePet(): void {
  // Nothing useful to show if it fails: the window is on its way out, or main is.
  invoke('pet:hide', null).catch(() => undefined);
}

/** An empty list still offers a way back to Main, without selecting any session. */
function showMain(): void {
  invoke('pet:showMain', null).catch(() => undefined);
}

const SIZE_NAMES: Readonly<Record<PetSize, string>> = { capsule: 'Large capsules', compact: 'Small capsules' };

/**
 * A button of the bar, its name shown at once under the pointer or with the keyboard's focus (NameTip),
 * as the Main window's controls show theirs — never a `title`, whose tooltip waits. Short names alone:
 * the tip stands inside the Pet's small window, under the bar.
 */
function BarButton({ name, className, pressed, disabled = false, onClick, children }: {
  readonly name: string;
  readonly className: string | undefined;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const tip = useNameTip();
  return (
    <>
      <button ref={button} type="button" className={className} aria-label={name} aria-pressed={pressed} disabled={disabled} onClick={onClick} {...tip.targetProps}>
        {children}
      </button>
      <NameTip open={tip.open} anchor={button}>{name}</NameTip>
    </>
  );
}

/** A size drawn as its rows: two tall ones, or four short ones in the same height. Decorative: the button carries the name. */
function SizeIcon({ size }: { readonly size: PetSize }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={size === 'capsule' ? 'M2 2H14V7H2ZM2 9H14V14H2Z' : 'M2 2H14V4H2ZM2 5.33H14V7.33H2ZM2 8.67H14V10.67H2ZM2 12H14V14H2Z'} fill="currentColor" />
    </svg>
  );
}
