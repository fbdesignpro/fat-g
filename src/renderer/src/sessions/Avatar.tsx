// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useEffect, useState } from 'react';
import { type EffortLook, type EffortMarks, effortMarks, type ResolvedOverlay } from '@shared/contracts/avatar-overlay';
import { avatarAddress, type ResolvedAvatar } from '@shared/contracts/avatars';
import { providerPresentation } from '../state/presentation';
import { useAppState } from '../state/store';
import styles from './Sessions.module.css';

/**
 * Where an avatar is drawn (docs/planning/_archive/M100.md, Design 5; C28): `tile` in the agent list
 * and the New session popup, 16 px; `thin` at a completed capsule's height and in the session
 * switcher, 30 px; `compact` at the Pet's smaller capsules' height, 36 px (decision 0010); `capsule`
 * at an active capsule's height, 60 px; and `column` as wide as the model column, 176 px.
 */
export type AvatarSize = 'tile' | 'capsule' | 'thin' | 'compact' | 'column';

/** What an avatar is drawn from: its files and its overlay. The Pet holds no more of one (decision 0010). */
export type DrawnAvatar = Pick<ResolvedAvatar, 'portrait' | 'small' | 'overlay'>;

/** A provider's bar colour, from the catalog's presentation; undefined for one this build does not have. */
export function useBarColor(providerId: string): string | undefined {
  return useAppState((state) => providerPresentation(state.snapshot, providerId)?.barColor);
}

/** Drawn at 36 px or less, an avatar takes its small where it has one (M102, C4); the shipped smalls are 64 px. */
const SMALL_SIZES: ReadonlySet<AvatarSize> = new Set(['tile', 'thin', 'compact']);

/** The files to try at a size, in order (M102, C4, C32): the small where it is wanted and there, then the portrait. */
export function avatarChain(avatar: DrawnAvatar | null, size: AvatarSize): readonly string[] {
  if (avatar === null) return [];
  return SMALL_SIZES.has(size) && avatar.small !== null ? [avatar.small, avatar.portrait] : [avatar.portrait];
}

export interface AvatarProps {
  readonly providerId: string;
  /** What main resolved (M102, C29): null for none, and the placeholder alone is drawn. */
  readonly avatar: DrawnAvatar | null;
  readonly size: AvatarSize;
  /** Told whether every file of the chain failed to draw (M102, C9): the Avatars tab marks the row. */
  readonly onFailed?: (failed: boolean) => void;
  /**
   * The effort its marks count (decision 0032): a live session's in force, a draft's or a preset's
   * chosen; none, or one with no marks, draws none.
   */
  readonly effort?: string | null;
  /**
   * Whether its session runs at the fast speed tier (decision 0032): a lightning bolt at the marks'
   * look's `fastPosition`, where the overlay is drawn, whether or not the marks show.
   */
  readonly fast?: boolean;
}

/**
 * An avatar (M102, Design 7; C4, C9, C31–C34): the model's art over its provider's placeholder (M14,
 * C59) — a square in the provider's bar colour carrying the provider's mark. The placeholder stands
 * from the first render, under an image still loading and in place of one that failed, so a bad file
 * is never the reason nothing is drawn (C32). The image is the file for the size (C4); its `error`
 * moves to the next step of the chain — a failed small to the portrait, a failed portrait to the
 * placeholder — remembered by the file's id, so a Rescan's new id is tried again (C9). Main is not told.
 *
 * A provider this build does not have has no presentation: a neutral square with no mark (M14, C108).
 * Decorative everywhere (C34): hidden from assistive technology, with an empty `alt`, and neither
 * selectable nor dragged, taking no pointer event, so a press on it is its capsule's.
 */
export function Avatar({ providerId, avatar, size, onFailed, effort = null, fast = false }: AvatarProps) {
  const presentation = useAppState((state) => providerPresentation(state.snapshot, providerId));
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const chain = avatarChain(avatar, size);
  const current = chain.find((id) => !failed.has(id));
  const exhausted = chain.length > 0 && current === undefined;
  // A caller passes a stable function, such as a state's setter: it is told again only when this changes.
  useEffect(() => { onFailed?.(exhausted); }, [exhausted, onFailed]);

  const image = current === undefined ? null : (
    <img
      className={styles.avatarImage}
      src={avatarAddress(current)}
      alt=""
      draggable={false}
      data-avatar-file={current === avatar?.small ? 'small' : 'portrait'}
      onError={() => setFailed((before) => new Set(before).add(current))}
    />
  );
  const overlay = OVERLAY_SIZES.has(size) && avatar?.overlay != null ? <Overlay overlay={avatar.overlay} marks={effortMarks(effort)} fast={fast} /> : null;
  if (presentation === undefined) {
    return (
      <span className={styles.avatar} data-size={size} data-neutral="" data-avatar={providerId} aria-hidden="true">
        {image}
        {overlay}
      </span>
    );
  }
  return (
    <span className={styles.avatar} data-size={size} data-avatar={providerId} style={{ '--bar-color': presentation.barColor } as CSSProperties} aria-hidden="true">
      {presentation.logo !== undefined ? <img className={styles.providerLogo} src={presentation.logo} alt="" draggable={false} /> : <svg viewBox={presentation.icon.viewBox} focusable="false">
        <path d={presentation.icon.path} fill="currentColor" fillRule="evenodd" />
      </svg>}
      {image}
      {overlay}
    </span>
  );
}

/** The sizes the version overlay is drawn at (decision 0032): below them it could not be read. */
const OVERLAY_SIZES: ReadonlySet<AvatarSize> = new Set(['capsule', 'column']);

/** How much larger than a dot a starburst is drawn: its points are lost at a dot's size (`.effortStar` in Sessions.module.css). */
const STAR_SCALE = 2;

/** The effort marks' room on their edge, as a percentage of the square: a mark, a starburst's larger, and its margin. */
const markRoom = (look: EffortLook, marks: EffortMarks): number => Math.round(look.size * (marks.shape === 'star' ? STAR_SCALE : 1)) + 3;

/** The fast bolt's room in its place, as a percentage of the square: a starburst's size, and its margin. */
const boltRoom = (look: EffortLook): number => Math.round(look.size * STAR_SCALE) + 3;

/**
 * The overlay (decision 0032): the model's short name and version as text over the art, the
 * session's effort as marks on one edge, and a fast session's lightning bolt in one of eight places, in
 * the look main resolved — every value of a closed set, a bounded number or a hex colour, so only the
 * custom properties carry it. Where the marks stand on the text's edge, the text moves inward by their
 * room, and where the bolt stands in the text's own place, aside by its. Decorative as the art is: its
 * avatar is hidden from assistive technology.
 */
function Overlay({ overlay, marks, fast }: { readonly overlay: ResolvedOverlay; readonly marks: EffortMarks | null; readonly fast: boolean }) {
  const { text, effort } = overlay;
  const drawn = effort !== null && marks !== null ? { look: effort, marks } : null;
  const bolt = fast ? overlay.fast : null;
  return (
    <>
      {text !== null && (
        <span
          className={styles.avatarOverlay}
          data-overlay=""
          data-position={text.look.position}
          data-effect={text.look.effect}
          data-backdrop={text.look.backdrop}
          data-effort-edge={drawn?.look.position}
          data-fast-at={bolt?.fastPosition}
          style={{
            '--overlay-size': String(text.look.size),
            '--overlay-text': text.look.textColor,
            '--overlay-effect': text.look.effectColor,
            '--overlay-effect-opacity': `${text.look.effectOpacity}%`,
            '--overlay-glow': String(text.look.glowStrength / 100),
            '--overlay-backdrop': text.look.backdropColor,
            '--overlay-strength': `${text.look.backdropStrength}%`,
            ...(drawn === null ? {} : { '--effort-room': String(markRoom(drawn.look, drawn.marks)) }),
            ...(bolt === null ? {} : { '--fast-room': String(boltRoom(bolt)) }),
          } as CSSProperties}
        >
          <span className={styles.overlayText}>
            {text.name !== null && <span data-overlay-name="">{text.name}</span>}
            {text.version !== null && <span data-overlay-version="">{text.version}</span>}
          </span>
        </span>
      )}
      {drawn !== null && <Marks look={drawn.look} marks={drawn.marks} />}
      {bolt !== null && <FastBolt look={bolt} />}
    </>
  );
}

/** The marks' look as custom properties: the marks' and the fast bolt's alike. */
const markProperties = (look: EffortLook): CSSProperties => ({
  '--effort-size': String(look.size),
  '--effort-gap': String(look.spacing),
  '--effort-color': look.color,
  '--effort-effect': look.effectColor,
  '--effort-effect-opacity': `${look.effectOpacity}%`,
  '--effort-glow': String(look.glowStrength / 100),
  '--effort-backdrop': look.backdropColor,
  '--effort-strength': `${look.backdropStrength}%`,
}) as CSSProperties;

/** An eight-pointed starburst, Ultra's mark: one fixed shape, so every system draws it alike. */
const STARBURST = 'M12 0.5L13.76 7.75L20.13 3.87L16.25 10.24L23.5 12L16.25 13.76L20.13 20.13L13.76 16.25L12 23.5L10.24 16.25L3.87 20.13L7.75 13.76L0.5 12L7.75 10.24L3.87 3.87L10.24 7.75Z';

/**
 * The effort marks (decision 0032): one to five dots for Low to Max, five starbursts for Ultra, in a
 * row along the top or the bottom or a column along a side, sized in the square's own width.
 */
function Marks({ look, marks }: { readonly look: EffortLook; readonly marks: EffortMarks }) {
  return (
    <span className={styles.effortMarks} data-effort-marks={marks.count} data-position={look.position} data-effect={look.effect} data-backdrop={look.backdrop} style={markProperties(look)}>
      <span className={styles.effortRow}>
        {Array.from({ length: marks.count }, (_, index) => marks.shape === 'dot' ? (
          <span key={index} className={styles.effortDot} data-effort-mark="dot" />
        ) : (
          <svg key={index} className={styles.effortStar} viewBox="0 0 24 24" focusable="false" data-effort-mark="star">
            <path d={STARBURST} fill="currentColor" />
          </svg>
        ))}
      </span>
    </span>
  );
}

/** A lightning bolt, the fast speed tier's mark: one fixed shape, as the starburst is. */
const BOLT = 'M14 1.5L4 13.5H11L9.5 22.5L20 10H13Z';

/**
 * The fast bolt (decision 0032): one lightning bolt in one of the eight places the version may take,
 * in the marks' look at a starburst's size, whether or not the marks show.
 */
function FastBolt({ look }: { readonly look: EffortLook }) {
  return (
    <span className={styles.fastMark} data-fast-mark="" data-position={look.fastPosition} data-effect={look.effect} data-backdrop={look.backdrop} style={markProperties(look)}>
      <svg className={styles.fastBolt} viewBox="0 0 24 24" focusable="false">
        <path d={BOLT} fill="currentColor" />
      </svg>
    </span>
  );
}
