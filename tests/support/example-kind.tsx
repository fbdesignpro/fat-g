// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A kind of tab defined outside the pane's folder (docs/planning/_archive/M19b.md, V8; C4, C5;
// docs/adding-a-tab-kind.md): what a later milestone adds. It is no file: its reference is an
// object, its title follows the session's other tabs of its kind, and its body changes its title and
// what it shows while it is shown, and holds an input — as an aside's will. Browser-safe, like the
// rest of tests/support.
import { useState } from 'react';
import { type TabBodyProps, tabKind } from '../../src/renderer/src/artifacts/tab-kind';

export const EXAMPLE_KIND = 'example-note';

export interface NoteReference {
  readonly note: string;
  readonly topic?: string;
}

export interface NoteViewState {
  readonly draft: string;
}

/** How many times a note's body was mounted, by note: what shows that only the selected tab's body is drawn. */
export const noteMounts = new Map<string, number>();

function NoteBody({ sessionId, reference, viewState, setViewState, setTitle }: TabBodyProps<NoteReference, NoteViewState>) {
  const [lines, setLines] = useState<readonly string[]>(() => {
    noteMounts.set(reference.note, (noteMounts.get(reference.note) ?? 0) + 1);
    return [];
  });
  return (
    <div data-example-note={reference.note} data-note-session={sessionId}>
      <p>Note {reference.note}</p>
      <label>
        Follow-up
        <input value={viewState?.draft ?? ''} onChange={(event) => setViewState({ draft: event.target.value })} />
      </label>
      <button type="button" onClick={() => setLines([...lines, `line ${lines.length + 1}`])}>Add a line</button>
      <button type="button" onClick={() => setTitle(`Renamed ${reference.note}`)}>Rename</button>
      <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}

export const exampleKind = tabKind<NoteReference, NoteViewState>({
  id: EXAMPLE_KIND,
  title: (reference, others) => (others.some((other) => other.topic === reference.topic && other.note !== reference.note) && reference.topic !== undefined ? `Note ${reference.note} (${reference.topic})` : `Note ${reference.note}`),
  Body: NoteBody,
});

/** A kind whose tabs the user cannot close (docs/planning/_archive/M106.md, V6; C2): it goes with its session alone. */
export const PINNED_KIND = 'example-pinned';

export const pinnedKind = tabKind<string, never>({
  id: PINNED_KIND,
  title: (reference) => `Pinned ${reference}`,
  Body: ({ reference }: TabBodyProps<string, never>) => <p data-example-pinned={reference}>Pinned {reference}</p>,
  closable: false,
});
