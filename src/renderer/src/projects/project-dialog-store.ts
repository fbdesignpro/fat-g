// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether the project dialog is open, and which project it edits. In memory only, never saved: it is
// where you happen to be, like Settings' own store. The draft itself lives in the dialog (C38).
import { create } from 'zustand';

export interface ProjectDialogView {
  readonly open: boolean;
  /** The project being edited, or null when adding one. */
  readonly projectId: string | null;
  /** A project just added: the list scrolls it into view once the state holds it (C49). */
  readonly added: string | null;
}

export const useProjectDialog = create<ProjectDialogView>()(() => ({ open: false, projectId: null, added: null }));

export function openProjectDialog(projectId: string | null): void {
  useProjectDialog.setState({ open: true, projectId });
}

export function closeProjectDialog(added: string | null = null): void {
  useProjectDialog.setState((current) => ({ open: false, projectId: null, added: added ?? current.added }));
}

export function clearAdded(): void {
  useProjectDialog.setState({ added: null });
}
