// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { StrictMode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { project } from '../test/records';
import { finishNewSession, useNewSession } from './new-session-store';
import { useFirstSendReveal } from './useFirstSendReveal';
import type { NewChatView } from './useNewChatLifecycle';

const draft: NewChatView = { project: project('fat-g'), draftId: 'draft', key: 'visit-1' };

function Harness({ starting, shownId }: { readonly starting: NewChatView | null; readonly shownId: string | null }) {
  const reveal = useFirstSendReveal(starting, shownId);
  return <output data-testid="reveal">{String(reveal)}</output>;
}

const showing = (starting: NewChatView | null, shownId: string | null = draft.draftId) => <StrictMode><Harness starting={starting} shownId={shownId} /></StrictMode>;
const revealed = () => screen.getByTestId('reveal').textContent;

beforeEach(() => useNewSession.setState({ projectId: null, sessionId: null, sent: new Set() }));
afterEach(cleanup);

describe('the first-send reveal', () => {
  it('reveals the screen draft after an accepted Send, including a draft created during the visit', () => {
    const view = render(showing({ ...draft, draftId: null }));
    view.rerender(showing(draft));
    expect(revealed()).toBe('false');
    act(() => finishNewSession('draft'));
    view.rerender(showing(null));
    expect(revealed()).toBe('true');
  });

  it('reveals nothing when selecting another session closes the screen', () => {
    const view = render(showing(draft));
    view.rerender(showing(null, 'other'));
    expect(revealed()).toBe('false');
  });

  it('stays revealed across re-renders and further accepted sends while the session stays shown', () => {
    const view = render(showing(draft));
    act(() => finishNewSession('draft'));
    view.rerender(showing(null));
    expect(revealed()).toBe('true');
    act(() => finishNewSession('draft'));
    view.rerender(showing(null));
    expect(revealed()).toBe('true');
  });

  it.each(['other', null])('clears when showing %s and never replays on return', (away) => {
    const view = render(showing(draft));
    act(() => finishNewSession('draft'));
    view.rerender(showing(null));
    expect(revealed()).toBe('true');
    view.rerender(showing(null, away));
    expect(revealed()).toBe('false');
    view.rerender(showing(null));
    expect(revealed()).toBe('false');
  });

  it.each(['unsent', null])('clears a reveal when a screen with draft %s opens then closes without sending', (draftId) => {
    const view = render(showing(draft));
    act(() => finishNewSession('draft'));
    view.rerender(showing(null));
    expect(revealed()).toBe('true');
    view.rerender(showing({ ...draft, draftId, key: 'visit-2' }));
    expect(revealed()).toBe('false');
    view.rerender(showing(null));
    expect(revealed()).toBe('false');
  });
});
