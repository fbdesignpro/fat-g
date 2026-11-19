// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a tab is (docs/planning/_archive/M19b.md, Design 1; C4, C5; docs/adding-a-tab-kind.md): a kind, a
// reference and a title. The pane names no kind. A kind is a folder of its own under this one and
// one line in kinds.ts, and gives two things: what titles a reference, and what draws its body.
//
// A reference is a value its kind alone reads, which the pane can compare and write as JSON: a
// file's real path, later a plan's id or an aside's. One tab of a session holds one kind and one
// reference (C8).
import type { ComponentType } from 'react';

/** What the pane hands the body of the one tab that is selected. */
export interface TabBodyProps<R, V> {
  readonly sessionId: string;
  readonly reference: R;
  /**
   * The small state the pane keeps for the tab between showings (C5), such as a file's line and
   * place: only the selected tab's body is drawn, so whatever else a kind needs between two showings
   * it keeps elsewhere, or reads again. Null until the kind sets one.
   */
  readonly viewState: V | null;
  readonly setViewState: (next: V) => void;
  /** A kind may change its tab's title while it is shown (C5): an aside's, once it has a subject. */
  readonly setTitle: (title: string) => void;
}

export interface TabKind<R = unknown, V = unknown> {
  /** What a tab is opened by, and the name of the kind's folder: `file`. */
  readonly id: string;
  /** A reference's title, given the session's other tabs of this kind: two of one name tell themselves apart. */
  title(reference: R, others: readonly R[]): string;
  /**
   * What draws the tab's whole body. The pane assumes no still view (C5): a body may change what it
   * shows while it is shown, and may hold an input of its own.
   */
  readonly Body: ComponentType<TabBodyProps<R, V>>;
  /** Whether the pane supplies a border and background behind the body. True unless given. */
  readonly framed?: boolean;
  /**
   * What opens the kind's tabs by itself, for a kind whose tabs are not all opened at a press
   * (docs/planning/_archive/M100.md, round 8; C78): drawn once while the page runs, whatever the pane shows,
   * it draws nothing and opens a tab from what it reads of the app state. Most kinds have none.
   */
  readonly Watcher?: ComponentType;
  /**
   * Whether the user may close its tabs (docs/planning/_archive/M106.md, Design 6; C2): true unless given. A
   * kind whose tab stands for as long as its session is listed says false: no ×, and neither Delete,
   * the middle click nor `closeTab` takes it; it goes with its session alone.
   */
  readonly closable?: boolean;
  /** Run before an explicit close. False keeps the tab open when its cleanup could not finish. */
  readonly beforeClose?: (sessionId: string, reference: R) => Promise<boolean>;
}

/**
 * A kind as the pane holds it. The pane reads no reference and no view state, so a kind's own types
 * end here: this is the one place they are put aside.
 */
export function tabKind<R, V>(kind: TabKind<R, V>): TabKind {
  return kind as unknown as TabKind;
}
