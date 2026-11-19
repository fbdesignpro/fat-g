// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { asideStage, session } from '../test/asides';
import { PlanPanel } from './PlanPanel';
import { Toolbar } from './Toolbar';
import { PLAN_PAGE_WORDS } from './plan-words';
import { REVIEW_WORDS } from './review-words';

afterEach(cleanup);

it('hides review entry points in the chat and on a ready plan', () => {
  asideStage();
  const entry = session('A chat');
  render(<>
    <Toolbar sessionId={entry.record.id} entry={entry} />
    <PlanPanel entry={entry} providerName="Codex" holdsRequest={false} workflow={{ planId: 'plan-1', state: 'ready', revision: 1, version: 1, participants: [entry.record.id], holder: null, operation: null, reviewId: null, busy: null }} />
  </>);
  expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  const panel = screen.getByRole('group', { name: PLAN_PAGE_WORDS.panel });
  expect(within(panel).queryByRole('button', { name: REVIEW_WORDS.review })).toBeNull();
  expect(within(panel).getByRole('button', { name: PLAN_PAGE_WORDS.execute })).toBeTruthy();
});
