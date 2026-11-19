// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CSSProperties, RefObject } from 'react';
import { catalogEntry, resolveTileKey, type ModelPreset } from '@shared/contracts/presets';
import { shownLabel } from '@shared/contracts/instances';
import { Avatar } from '../sessions/Avatar';
import { tierOf, withSpeed } from '../ui/speed-text';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { useAppState } from '../state/store';
import modelStyles from '../session-area/SessionArea.module.css';
import styles from './NewChat.module.css';

/** One keyboard target for the avatar, model and effort; the existing picker anchors here. */
export function DraftModelButton({ preset, anchor, busy, expanded, onOpen }: {
  readonly preset: ModelPreset | null;
  readonly anchor: RefObject<HTMLButtonElement | null>;
  readonly busy: boolean;
  readonly expanded: boolean;
  readonly onOpen: () => void;
}) {
  const tooltip = useTooltip();
  const app = useAppState((state) => state.snapshot);
  const provider = preset === null ? undefined : catalogEntry(app?.catalog, preset);
  const model = preset === null ? null : resolveTileKey(provider, preset.model);
  const level = preset?.effort === null ? 'No effort' : model?.efforts.find((one) => one.id === preset?.effort)?.label ?? preset?.effort ?? '';
  // The speed tier after the level, as a chat's effort bar says them (decision 0016).
  const effort = level === '' ? level : withSpeed(level, tierOf(model?.speedTiers, preset?.speed ?? null));
  const account = preset === null ? null : shownLabel(app?.providers ?? [], preset);
  return <><button ref={anchor} type="button" className={styles.modelButton} disabled={busy}
    aria-label={`Choose model${model === null ? '' : `: ${model.name}, ${effort}`}${account === null ? '' : ` (${account})`}`}
    aria-haspopup="dialog" aria-expanded={expanded} onClick={onOpen} {...tooltip.targetProps}>
    {preset !== null && <Avatar providerId={preset.providerId} avatar={model?.avatar ?? null} size="column" effort={preset.effort} fast={preset.speed !== null} />}
    <span className={modelStyles.modelId} style={provider === undefined ? undefined : { '--bar-color': provider.presentation.barColor } as CSSProperties}>
      <span className={modelStyles.menuText}>{model?.name ?? preset?.model ?? 'Choose model'}</span>
    </span>
    <span className={modelStyles.effort}><span className={modelStyles.menuText}>{effort || 'Model selection'}</span></span>
  </button>
    <Tooltip id={tooltip.id} open={tooltip.open && !expanded} anchor={anchor} side="above">Customize model, effort and speed</Tooltip>
  </>;
}
