// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The selected session's parts outside its chat's reads (docs/planning/_archive/M100.md, Design 6, 7, round 8),
// for tests that read them without the chat's own reads: the model block at the left of the prompt
// area, the status bar that stands over the input, and the mode control above the thick rule. Each
// follows the selected session as the page's do.
import { ModeMenu } from '../session-area/ModeMenu';
import { ModelBlock } from '../session-area/ModelBlock';
import { useSelectedSession } from '../session-area/selected';
import { StatusBar } from '../session-area/StatusBar';

/** The model block of the selected session, keyed by it as the chat keys its parts; nothing with none selected. */
export function SelectedModel() {
  const selected = useSelectedSession();
  return selected === null ? null : <ModelBlock key={selected.entry.record.id} entry={selected.entry} />;
}

/** The mode control of the selected session, in a row of its own as the chat draws it; nothing with none selected. */
export function SelectedMode() {
  const selected = useSelectedSession();
  return selected === null ? null : <div data-mode-row=""><ModeMenu key={selected.entry.record.id} entry={selected.entry} /></div>;
}

/** The status bar of the selected session, as its prompt area draws it; nothing with none selected. */
export function SelectedStatus() {
  const selected = useSelectedSession();
  return selected === null ? null : <StatusBar key={selected.entry.record.id} entry={selected.entry} />;
}
