// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef } from 'react';
import { useAppState } from '../state/store';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { openNewSession } from './new-session-store';

export const NO_PROVIDER_REASON = 'No provider of this project is switched on. Switch one on in Settings to start a session.';

export interface NewSessionButtonProps {
  readonly project: { readonly id: string; readonly name: string; readonly providers: readonly string[] };
  readonly className?: string | undefined;
}

/**
 * The `+` on a project header: it opens the initial new-chat screen for the project's providers
 * that are switched on in Settings. With none it stays in place, dimmed, and a tooltip gives the
 * reason on hover and on keyboard focus: it keeps the focus (`aria-disabled`, not `disabled`), and
 * the tooltip is its description.
 */
export function NewSessionButton({ project, className }: NewSessionButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  const enabled = useAppState((state) => project.providers.some((id) => state.snapshot?.providers.find((provider) => provider.id === id)?.status.kind !== 'disabled'));
  const tooltip = useTooltip();

  const toggle = (): void => {
    if (!enabled) return;
    openNewSession(project.id);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={`New session in ${project.name}`}
        aria-disabled={!enabled || undefined}
        data-new-session-for={project.id}
        onClick={toggle}
        {...(enabled ? {} : tooltip.targetProps)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2.5" fill="none" />
        </svg>
      </button>
      {!enabled && (
        <Tooltip id={tooltip.id} open={tooltip.open} anchor={button}>
          {NO_PROVIDER_REASON}
        </Tooltip>
      )}
    </>
  );
}
