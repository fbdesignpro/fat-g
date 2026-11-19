// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the Pet window shows (decision 0010): the sessions running or waiting on the user, each under
// its project's name, at one of two sizes. Main builds it from the app state by an allowlist
// (src/main/state/pet-view.ts) and hands it to the Pet alone. Each type holds only what a Pet capsule
// draws, so nothing else of a session travels by accident: no action's label (it can name a file or a
// command), no sub-agent, model, mode or context reading, no avatar's folder names, no provider logo.
//
// Naming: the user sees the Pet as the "mini window" — Settings, the title strip, tooltips,
// its window title. The code, files, channels (`pet:*`), window kind and stored keys keep "pet".
import { z } from 'zod';
import type { ResolvedAvatar } from './avatars';
import type { ProviderPresentation } from './catalog';
import type { SessionAction, SessionSummary, SessionView } from './sessions';

/** `capsule`: a Main window capsule's size. `compact`: a smaller row, the name on one line over the status bar. */
export const PET_SIZES = ['capsule', 'compact'] as const;
export type PetSize = (typeof PET_SIZES)[number];
export const DEFAULT_PET_SIZE: PetSize = 'compact';

export type PetRecord = Pick<SessionView, 'id' | 'providerId' | 'name' | 'nameSource' | 'createdAt' | 'speed'>;

/** The status bar's fields, including only closed waiting metadata and a transient display deadline. */
export type PetSummary = Pick<SessionSummary, 'status' | 'turnStartedAt' | 'turnWait' | 'activeWorkers' | 'attention' | 'planWait' | 'effort' | 'displayHold'> & {
  readonly action: Pick<SessionAction, 'kind' | 'wait'> | null;
};

/** The files to draw and the overlay's look: never the avatar's reference, which names its folders. */
export type PetAvatar = Pick<ResolvedAvatar, 'portrait' | 'small' | 'overlay'>;

export interface PetSession {
  readonly record: PetRecord;
  readonly summary: PetSummary;
  readonly avatar: PetAvatar | null;
}

export interface PetProject {
  readonly id: string;
  readonly name: string;
  /** Never empty: a project with nothing to show is left out. */
  readonly sessions: readonly PetSession[];
}

/** A provider's colour, mark and stream: what an avatar's placeholder and a status bar are drawn with. */
export type PetPresentation = Pick<ProviderPresentation, 'barColor' | 'icon' | 'logo' | 'stream'>;

export interface PetView {
  readonly size: PetSize;
  /** In the Main window's order. */
  readonly projects: readonly PetProject[];
  /** By provider id, for the providers of the sessions listed alone. */
  readonly presentation: Readonly<Record<string, PetPresentation>>;
}

/**
 * The Pet's geometry in CSS pixels, which are DIPs there (its zoom stays at 100%): main sizes the
 * window from it (src/main/windows/pet-fit.ts) and the page lays its rows out by it, so the window
 * holds its list exactly. A project's capsules stand 1 px apart, the divider drawn in the gap, and
 * the last one meets the frame's border.
 */
export const PET_LAYOUT = {
  width: { capsule: 300, compact: 240 },
  border: 1,
  bar: 24,
  project: 16,
  row: { capsule: 60, compact: 36 },
  divider: 1,
  // Frame + bar + empty line must meet Windows' 56px native minimum at 100% scale.
  empty: 30,
} as const;

/**
 * The window's size for a view: the frame, the bar, then each project's row and its capsules — or the
 * empty line. Main rounds it up to whole device pixels where the window stands (pet-fit.ts), and the
 * bar takes up what that adds.
 */
export function petContentSize(view: Pick<PetView, 'size' | 'projects'>): { readonly width: number; readonly height: number } {
  const project = (count: number): number => PET_LAYOUT.project + count * PET_LAYOUT.row[view.size] + (count - 1) * PET_LAYOUT.divider;
  const body = view.projects.length === 0 ? PET_LAYOUT.empty : view.projects.reduce((sum, entry) => sum + project(entry.sessions.length), 0);
  return { width: PET_LAYOUT.width[view.size], height: 2 * PET_LAYOUT.border + PET_LAYOUT.bar + body };
}

/** The Pet's size toggle (`pet:setSize`). */
export const PetSizeRequestSchema = z.strictObject({ size: z.enum(PET_SIZES) });
export type PetSizeRequest = z.infer<typeof PetSizeRequestSchema>;

/** Main asks the Main window's page to open a session a press on the Pet named (`sessions:reveal`), as a press on its capsule there would. */
export interface SessionRevealPush {
  readonly id: string;
}
