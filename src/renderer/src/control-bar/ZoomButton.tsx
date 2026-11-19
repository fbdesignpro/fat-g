// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { Fragment, type RefObject, useRef } from 'react';
import { DEFAULT_ZOOM } from '@shared/contracts/zoom';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { focusQuietly } from '../ui/focus';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { ZOOM_WORDS, zoomKeys } from '../ui/zoom-text';
import styles from './ControlBar.module.css';
import { ZoomFrameIcon } from './icons';

/**
 * The Main window's zoom, after the gear, while it is not 100%: its percent in a frame of four
 * corners. A press goes back to 100%, and the button is gone with it, so the focus it held goes to
 * the gear; its tooltip gives the keys that zoom. Main keeps the zoom (src/main/windows/zoom.ts).
 */
export function ZoomButton({ settings }: { readonly settings: RefObject<HTMLButtonElement | null> }) {
  const zoom = useAppState((state) => state.snapshot?.zoom);
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  if (zoom === undefined || zoom === DEFAULT_ZOOM) return null;

  const reset = (): void => {
    if (document.activeElement === button.current) focusQuietly(settings.current);
    // The app state brings the new zoom back; a call that fails leaves the zoom as it was, shown.
    invoke('zoom:change', { to: 'reset' }).catch(() => undefined);
  };

  return (
    <>
      <button ref={button} type="button" className={styles.zoomButton} aria-label={ZOOM_WORDS.indicator(zoom)} onClick={reset} {...tooltip.targetProps}>
        <ZoomFrameIcon />
        <span className={styles.zoomPercent} aria-hidden="true">{zoom}%</span>
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={button}>
        <span className={styles.zoomTip}>
          <span className={styles.zoomTipHead}>{ZOOM_WORDS.click}</span>
          {zoomKeys(window.fatg.platform).map(({ keys, what }) => (
            <Fragment key={keys}>
              <kbd className={styles.zoomKey}>{keys}</kbd>
              <span>{what}</span>
            </Fragment>
          ))}
        </span>
      </Tooltip>
    </>
  );
}
