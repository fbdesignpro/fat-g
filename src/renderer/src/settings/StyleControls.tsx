// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type ReactNode, useId } from 'react';
import {
  EFFORT_EFFECTS,
  EFFORT_SIZE,
  EFFORT_SPACING,
  GLOW_STRENGTH,
  type EffortPosition,
  type EffortStyle,
  mergeEffortStyles,
  mergeVersionStyles,
  OVERLAY_BACKDROPS,
  OVERLAY_EFFECTS,
  OVERLAY_PRESETS,
  OVERLAY_SIZE,
  OVERLAY_STRENGTH,
  type OverlayLayer,
  type OverlayPosition,
  type VersionStyle,
} from '@shared/contracts/avatar-overlay';
import styles from './Settings.module.css';

/** The style controls' words (decision 0032). */
export const STYLE_WORDS = {
  version: 'Version',
  effort: 'Effort dots',
  preset: 'Preset',
  presetKept: 'Custom',
  presets: { badge: 'Badge', glow: 'Glow', band: 'Band', chip: 'Chip' },
  effect: 'Effect',
  effects: { plain: 'Plain', outline: 'Outline', glow: 'Glow', chip: 'Chip' },
  size: 'Size',
  textColor: 'Text colour',
  effectColor: 'Outline, glow or chip colour',
  effectOpacity: 'Effect opacity',
  glowStrength: 'Glow strength',
  backdrop: 'Shade',
  backdrops: { none: 'None', shade: 'Darken behind' },
  backdropColor: 'Shade colour',
  strength: 'Shade strength',
  position: 'Position',
  positions: {
    'top-left': 'Top left', top: 'Top', 'top-right': 'Top right', left: 'Left', right: 'Right', 'bottom-left': 'Bottom left', bottom: 'Bottom', 'bottom-right': 'Bottom right',
  },
  name: 'Name',
  versionPart: 'Version',
  partsOnDefault: 'Family default shows both',
  showEffort: 'Show the effort',
  fastPosition: '“Fast” marker position',
  markSize: 'Mark size',
  spacing: 'Spacing',
  markColor: 'Mark colour',
  markEffectColor: 'Outline or glow colour',
  familyDefault: 'Use family default',
} as const;

/** The eight places, row by row, with the centre empty. */
const GRID: readonly (OverlayPosition | null)[] = ['top-left', 'top', 'top-right', 'left', null, 'right', 'bottom-left', 'bottom', 'bottom-right'];
/** The marks' four edges as a cross on the same grid. */
const EDGES: readonly (EffortPosition | null)[] = [null, 'top', null, 'left', null, 'right', null, 'bottom', null];
const SIZES = Array.from({ length: (OVERLAY_SIZE.max - OVERLAY_SIZE.min) / 2 + 1 }, (_, index) => OVERLAY_SIZE.min + index * 2);
const MARK_SIZES = Array.from({ length: EFFORT_SIZE.max - EFFORT_SIZE.min + 1 }, (_, index) => EFFORT_SIZE.min + index);
const SPACINGS = Array.from({ length: EFFORT_SPACING.max - EFFORT_SPACING.min + 1 }, (_, index) => EFFORT_SPACING.min + index);
const GLOWS = Array.from({ length: (GLOW_STRENGTH.max - GLOW_STRENGTH.min) / GLOW_STRENGTH.step + 1 }, (_, index) => GLOW_STRENGTH.min + index * GLOW_STRENGTH.step);
const STRENGTHS = Array.from({ length: (OVERLAY_STRENGTH.max - OVERLAY_STRENGTH.min) / 10 + 1 }, (_, index) => OVERLAY_STRENGTH.min + index * 10);
const ARROWS: Readonly<Record<string, EffortPosition>> = { ArrowUp: 'top', ArrowDown: 'bottom', ArrowLeft: 'left', ArrowRight: 'right' };

/** A hex colour as a colour input holds one: six digits. */
const sixDigits = (colour: string): string => (colour.length === 4 ? `#${[...colour.slice(1)].map((digit) => digit + digit).join('')}` : colour).toLowerCase();

/** The next place an arrow moves to on the grid, the centre passed over; the same place at an edge. */
function moved(from: OverlayPosition, key: string): OverlayPosition {
  const at = GRID.indexOf(from);
  const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : key === 'ArrowDown' ? 3 : key === 'ArrowUp' ? -3 : 0;
  if (step === 0) return from;
  let next = at + step;
  // Left and right stay on the row.
  if (Math.abs(step) === 1 && Math.floor(next / 3) !== Math.floor(at / 3)) return from;
  if (GRID[next] === null) next += step;
  return GRID[next] ?? from;
}

/** A layer's part with one field gone; undefined when none is left. */
function without<T extends object>(part: T | undefined, field: keyof T): T | undefined {
  if (part === undefined) return undefined;
  const rest: Record<string, unknown> = { ...(part as Record<string, unknown>) };
  delete rest[field as string];
  return Object.keys(rest).length > 0 ? (rest as T) : undefined;
}

export interface StyleControlsProps {
  /** The layer edited: the family's, or an avatar's own. */
  readonly layer: OverlayLayer;
  /** The layers under it: none for the family's, the family's for an avatar's. */
  readonly below: readonly (OverlayLayer | undefined)[];
  /** An avatar's overrides: each field it sets is highlighted, and may go back to the default. */
  readonly overriding: boolean;
  readonly disabled: boolean;
  readonly onChange: (layer: OverlayLayer) => void;
}

/**
 * The overlay's style controls (decision 0032): the version's preset above its group, which sets its
 * look whole — and the version's own: which texts, the effect, the size, the colours,
 * a glow's strength, the shade, one of eight places — and the effort marks' — whether they show,
 * one of four edges, the fast bolt's own one of eight places, their size, spacing, colours, effect and shade. Each control shows the look as
 * merged over the layers under this one and sets one field of this layer; a preset replaces the look
 * this layer gathered. Among an avatar's overrides, each field it sets is highlighted whole, with a
 * button that gives it the default again.
 */
export function StyleControls({ layer, below, overriding, disabled, onChange }: StyleControlsProps) {
  const baseId = useId();
  const version = mergeVersionStyles([...below.map((under) => under?.version), layer.version]);
  const effort = mergeEffortStyles([...below.map((under) => under?.effort), layer.effort]);
  const own = { version: layer.version ?? {}, effort: layer.effort ?? {} };

  const setVersion = (change: VersionStyle): void => onChange({ ...layer, version: { ...layer.version, ...change } });
  const setEffort = (change: EffortStyle): void => onChange({ ...layer, effort: { ...layer.effort, ...change } });
  const resetVersion = (field: keyof VersionStyle): void => onChange({ ...layer, version: without(layer.version, field) });
  const resetEffort = (field: keyof EffortStyle): void => onChange({ ...layer, effort: without(layer.effort, field) });
  const choosePreset = (value: string): void => {
    const preset = OVERLAY_PRESETS.find((candidate) => candidate === value);
    const before = layer.version ?? {};
    // A preset replaces the look this layer set, and keeps which texts it shows.
    const next: VersionStyle = { ...(before.parts === undefined ? {} : { parts: before.parts }), ...(preset === undefined ? {} : { preset }) };
    onChange({ ...layer, version: Object.keys(next).length > 0 ? next : undefined });
  };
  const onPositionKey = (event: KeyboardEvent<HTMLElement>): void => {
    const next = moved(version.look.position, event.key);
    if (next === version.look.position) return;
    event.preventDefault();
    setVersion({ position: next });
    document.getElementById(`${baseId}-${next}`)?.focus();
  };
  const onEdgeKey = (event: KeyboardEvent<HTMLElement>): void => {
    const next = ARROWS[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setEffort({ position: next });
    document.getElementById(`${baseId}-edge-${next}`)?.focus();
  };
  const onFastKey = (event: KeyboardEvent<HTMLElement>): void => {
    const next = moved(effort.look.fastPosition, event.key);
    if (next === effort.look.fastPosition) return;
    event.preventDefault();
    setEffort({ fastPosition: next });
    document.getElementById(`${baseId}-fast-${next}`)?.focus();
  };

  /** One control's row: its label, the control, and where an avatar overrides it, the way back to the default. */
  const row = (part: 'version' | 'effort', field: string, label: string, control: (id: string) => ReactNode): ReactNode => {
    const id = `${baseId}-${part}-${field}`;
    const set = field in own[part];
    return (
      <div className={styles.styleControl} data-style-field={`${part}.${field}`} data-style-own={overriding && set ? '' : undefined}>
        <label htmlFor={id}>{label}</label>
        {control(id)}
        {overriding && set && (
          <button
            type="button"
            className={styles.styleDefault}
            disabled={disabled}
            aria-label={`${label}: ${STYLE_WORDS.familyDefault}`}
            title={STYLE_WORDS.familyDefault}
            onClick={() => {
              // The button goes with the override: the focus goes first to the row's own control.
              const control = document.getElementById(id);
              (control?.matches('input, select') === true ? control : control?.querySelector<HTMLElement>('input, select, [tabindex="0"]'))?.focus();
              if (part === 'version') resetVersion(field as keyof VersionStyle);
              else resetEffort(field as keyof EffortStyle);
            }}
          >
            ↺
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={styles.styleControls}>
      <div className={`${styles.styleRows} ${styles.presetRows}`} data-style-group="preset">
        {row('version', 'preset', STYLE_WORDS.preset, (id) => (
          <select id={id} disabled={disabled} value={own.version.preset ?? ''} onChange={(event) => choosePreset(event.target.value)} data-style-preset="">
            <option value="">{STYLE_WORDS.presetKept}</option>
            {OVERLAY_PRESETS.map((preset) => <option key={preset} value={preset}>{STYLE_WORDS.presets[preset]}</option>)}
          </select>
        ))}
      </div>
      <fieldset className={`${styles.styleGroup} ${styles.styleRows}`} data-style-group="version">
        <legend>{STYLE_WORDS.version}</legend>
        {row('version', 'parts', `${STYLE_WORDS.name} / ${STYLE_WORDS.versionPart}`, (id) => (
          <span className={styles.styleStack}>
            <span className={styles.inlineActions} id={id}>
              <label className={styles.checkbox}>
                <input type="checkbox" disabled={disabled} checked={version.parts.name} onChange={(event) => setVersion({ parts: { ...version.parts, name: event.target.checked } })} data-style-part="name" />
                {STYLE_WORDS.name}
              </label>
              <label className={styles.checkbox}>
                <input type="checkbox" disabled={disabled} checked={version.parts.version} onChange={(event) => setVersion({ parts: { ...version.parts, version: event.target.checked } })} data-style-part="version" />
                {STYLE_WORDS.versionPart}
              </label>
            </span>
            {/* The Family default always says both (FAMILY_DEFAULT_LAYER): in the Default style they set the
                other avatars'. Under the boxes, in their column, so the panel is no wider for it; an avatar's
                Overrides keep its line's room, so the editor keeps its height between them. */}
            {overriding
              ? <span className={`${styles.styleHint} ${styles.reservedRoom}`} aria-hidden="true">{'\u00a0'}</span>
              : <span className={styles.styleHint}>{STYLE_WORDS.partsOnDefault}</span>}
          </span>
        ))}
        {row('version', 'effect', STYLE_WORDS.effect, (id) => (
          <select id={id} disabled={disabled} value={version.look.effect} onChange={(event) => setVersion({ effect: OVERLAY_EFFECTS.find((effect) => effect === event.target.value) ?? version.look.effect })} data-style-effect="">
            {OVERLAY_EFFECTS.map((effect) => <option key={effect} value={effect}>{STYLE_WORDS.effects[effect]}</option>)}
          </select>
        ))}
        {row('version', 'size', STYLE_WORDS.size, (id) => (
          <select id={id} disabled={disabled} value={version.look.size - (version.look.size % 2)} onChange={(event) => setVersion({ size: Number(event.target.value) })} data-style-size="">
            {SIZES.map((size) => <option key={size} value={size}>{size} %</option>)}
          </select>
        ))}
        {row('version', 'textColor', STYLE_WORDS.textColor, (id) => (
          <input id={id} type="color" disabled={disabled} value={sixDigits(version.look.textColor)} onChange={(event) => setVersion({ textColor: event.target.value })} data-style-text-color="" />
        ))}
        {row('version', 'effectColor', STYLE_WORDS.effectColor, (id) => (
          <input id={id} type="color" disabled={disabled || version.look.effect === 'plain'} value={sixDigits(version.look.effectColor)} onChange={(event) => setVersion({ effectColor: event.target.value })} data-style-effect-color="" />
        ))}
        {row('version', 'effectOpacity', STYLE_WORDS.effectOpacity, (id) => (
          <select id={id} disabled={disabled || version.look.effect === 'plain'} value={version.look.effectOpacity - (version.look.effectOpacity % 10)} onChange={(event) => setVersion({ effectOpacity: Number(event.target.value) })} data-style-opacity="">
            {STRENGTHS.map((opacity) => <option key={opacity} value={opacity}>{opacity} %</option>)}
          </select>
        ))}
        {version.look.effect === 'glow' && row('version', 'glowStrength', STYLE_WORDS.glowStrength, (id) => (
          <select id={id} disabled={disabled} value={version.look.glowStrength - (version.look.glowStrength % GLOW_STRENGTH.step)} onChange={(event) => setVersion({ glowStrength: Number(event.target.value) })} data-style-glow="">
            {GLOWS.map((glow) => <option key={glow} value={glow}>{glow} %</option>)}
          </select>
        ))}
        {row('version', 'backdrop', STYLE_WORDS.backdrop, (id) => (
          <select id={id} disabled={disabled} value={version.look.backdrop} onChange={(event) => setVersion({ backdrop: OVERLAY_BACKDROPS.find((backdrop) => backdrop === event.target.value) ?? version.look.backdrop })} data-style-backdrop="">
            {OVERLAY_BACKDROPS.map((backdrop) => <option key={backdrop} value={backdrop}>{STYLE_WORDS.backdrops[backdrop]}</option>)}
          </select>
        ))}
        {version.look.backdrop === 'shade' && (
          <>
            {row('version', 'backdropColor', STYLE_WORDS.backdropColor, (id) => (
              <input id={id} type="color" disabled={disabled} value={sixDigits(version.look.backdropColor)} onChange={(event) => setVersion({ backdropColor: event.target.value })} />
            ))}
            {row('version', 'backdropStrength', STYLE_WORDS.strength, (id) => (
              <select id={id} disabled={disabled} value={version.look.backdropStrength - (version.look.backdropStrength % 10)} onChange={(event) => setVersion({ backdropStrength: Number(event.target.value) })}>
                {STRENGTHS.map((strength) => <option key={strength} value={strength}>{strength} %</option>)}
              </select>
            ))}
          </>
        )}
        {row('version', 'position', STYLE_WORDS.position, (id) => (
          <div id={id} className={styles.positionGrid} role="radiogroup" aria-label={STYLE_WORDS.position} onKeyDown={onPositionKey}>
            {GRID.map((position, index) => position === null ? (
              <span key={`centre-${index}`} aria-hidden="true" />
            ) : (
              <button
                key={position}
                id={`${baseId}-${position}`}
                type="button"
                role="radio"
                aria-checked={version.look.position === position}
                aria-label={STYLE_WORDS.positions[position]}
                title={STYLE_WORDS.positions[position]}
                tabIndex={version.look.position === position ? 0 : -1}
                disabled={disabled}
                className={styles.positionCell}
                data-style-position={position}
                onClick={() => setVersion({ position })}
              />
            ))}
          </div>
        ))}
      </fieldset>
      <fieldset className={`${styles.styleGroup} ${styles.styleRows}`} data-style-group="effort">
        <legend>{STYLE_WORDS.effort}</legend>
        {row('effort', 'show', STYLE_WORDS.showEffort, (id) => (
          <input id={id} type="checkbox" disabled={disabled} checked={effort.show} onChange={(event) => setEffort({ show: event.target.checked })} data-effort-show="" />
        ))}
        {row('effort', 'position', STYLE_WORDS.position, (id) => (
          <div id={id} className={styles.positionGrid} role="radiogroup" aria-label={`${STYLE_WORDS.effort}: ${STYLE_WORDS.position}`} onKeyDown={onEdgeKey}>
            {EDGES.map((edge, index) => edge === null ? (
              <span key={`none-${index}`} aria-hidden="true" />
            ) : (
              <button
                key={edge}
                id={`${baseId}-edge-${edge}`}
                type="button"
                role="radio"
                aria-checked={effort.look.position === edge}
                aria-label={STYLE_WORDS.positions[edge]}
                title={STYLE_WORDS.positions[edge]}
                tabIndex={effort.look.position === edge ? 0 : -1}
                disabled={disabled}
                className={styles.positionCell}
                data-effort-position={edge}
                onClick={() => setEffort({ position: edge })}
              />
            ))}
          </div>
        ))}
        {/* The fast session's bolt: the marks' look in one of the version's eight places, wherever the
            author puts it, and drawn whether or not the marks are. */}
        {row('effort', 'fastPosition', STYLE_WORDS.fastPosition, (id) => (
          <div id={id} className={styles.positionGrid} role="radiogroup" aria-label={STYLE_WORDS.fastPosition} onKeyDown={onFastKey}>
            {GRID.map((position, index) => position === null ? (
              <span key={`centre-${index}`} aria-hidden="true" />
            ) : (
              <button
                key={position}
                id={`${baseId}-fast-${position}`}
                type="button"
                role="radio"
                aria-checked={effort.look.fastPosition === position}
                aria-label={STYLE_WORDS.positions[position]}
                title={STYLE_WORDS.positions[position]}
                tabIndex={effort.look.fastPosition === position ? 0 : -1}
                disabled={disabled}
                className={styles.positionCell}
                data-fast-position={position}
                onClick={() => setEffort({ fastPosition: position })}
              />
            ))}
          </div>
        ))}
        {row('effort', 'size', STYLE_WORDS.markSize, (id) => (
          <select id={id} disabled={disabled} value={effort.look.size} onChange={(event) => setEffort({ size: Number(event.target.value) })} data-effort-size="">
            {MARK_SIZES.map((size) => <option key={size} value={size}>{size} %</option>)}
          </select>
        ))}
        {row('effort', 'spacing', STYLE_WORDS.spacing, (id) => (
          <select id={id} disabled={disabled} value={effort.look.spacing} onChange={(event) => setEffort({ spacing: Number(event.target.value) })} data-effort-spacing="">
            {SPACINGS.map((spacing) => <option key={spacing} value={spacing}>{spacing} %</option>)}
          </select>
        ))}
        {row('effort', 'color', STYLE_WORDS.markColor, (id) => (
          <input id={id} type="color" disabled={disabled} value={sixDigits(effort.look.color)} onChange={(event) => setEffort({ color: event.target.value })} data-effort-color="" />
        ))}
        {row('effort', 'effect', STYLE_WORDS.effect, (id) => (
          <select id={id} disabled={disabled} value={effort.look.effect} onChange={(event) => setEffort({ effect: EFFORT_EFFECTS.find((effect) => effect === event.target.value) ?? effort.look.effect })} data-effort-effect="">
            {EFFORT_EFFECTS.map((effect) => <option key={effect} value={effect}>{STYLE_WORDS.effects[effect]}</option>)}
          </select>
        ))}
        {row('effort', 'effectColor', STYLE_WORDS.markEffectColor, (id) => (
          <input id={id} type="color" disabled={disabled || effort.look.effect === 'plain'} value={sixDigits(effort.look.effectColor)} onChange={(event) => setEffort({ effectColor: event.target.value })} />
        ))}
        {row('effort', 'effectOpacity', STYLE_WORDS.effectOpacity, (id) => (
          <select id={id} disabled={disabled || effort.look.effect === 'plain'} value={effort.look.effectOpacity - (effort.look.effectOpacity % 10)} onChange={(event) => setEffort({ effectOpacity: Number(event.target.value) })} data-effort-opacity="">
            {STRENGTHS.map((opacity) => <option key={opacity} value={opacity}>{opacity} %</option>)}
          </select>
        ))}
        {effort.look.effect === 'glow' && row('effort', 'glowStrength', STYLE_WORDS.glowStrength, (id) => (
          <select id={id} disabled={disabled} value={effort.look.glowStrength - (effort.look.glowStrength % GLOW_STRENGTH.step)} onChange={(event) => setEffort({ glowStrength: Number(event.target.value) })} data-effort-glow="">
            {GLOWS.map((glow) => <option key={glow} value={glow}>{glow} %</option>)}
          </select>
        ))}
        {row('effort', 'backdrop', STYLE_WORDS.backdrop, (id) => (
          <select id={id} disabled={disabled} value={effort.look.backdrop} onChange={(event) => setEffort({ backdrop: OVERLAY_BACKDROPS.find((backdrop) => backdrop === event.target.value) ?? effort.look.backdrop })} data-effort-backdrop="">
            {OVERLAY_BACKDROPS.map((backdrop) => <option key={backdrop} value={backdrop}>{STYLE_WORDS.backdrops[backdrop]}</option>)}
          </select>
        ))}
        {effort.look.backdrop === 'shade' && (
          <>
            {row('effort', 'backdropColor', STYLE_WORDS.backdropColor, (id) => (
              <input id={id} type="color" disabled={disabled} value={sixDigits(effort.look.backdropColor)} onChange={(event) => setEffort({ backdropColor: event.target.value })} />
            ))}
            {row('effort', 'backdropStrength', STYLE_WORDS.strength, (id) => (
              <select id={id} disabled={disabled} value={effort.look.backdropStrength - (effort.look.backdropStrength % 10)} onChange={(event) => setEffort({ backdropStrength: Number(event.target.value) })}>
                {STRENGTHS.map((strength) => <option key={strength} value={strength}>{strength} %</option>)}
              </select>
            ))}
          </>
        )}
      </fieldset>
    </div>
  );
}
