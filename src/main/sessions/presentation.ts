// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M105: a safe display deadline alongside immediate semantic state. No content or timer.
import { ACTION_GRACE_MS, type ActionHold, type SessionAction } from '@shared/contracts/sessions';

export interface ActionPresentation {
  readonly action: SessionAction | null;
  readonly displayHold?: ActionHold;
}

export function actionHold(previous: ActionPresentation, current: ActionPresentation, eligible: boolean, now: number): ActionHold | undefined {
  if (!eligible || current.action?.kind !== 'thinking') return undefined;
  const before = previous.action;
  if (before?.kind === 'thinking') return previous.displayHold !== undefined && previous.displayHold.until > now ? previous.displayHold : undefined;
  if (before === null || !(['reading', 'running', 'tool', 'waiting'].includes(before.kind) || before.kind === 'writing' && before.tool === true)) return undefined;
  return { kind: before.kind, ...(before.wait === undefined ? {} : { wait: before.wait }), until: now + ACTION_GRACE_MS };
}
