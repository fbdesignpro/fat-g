// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationTurn } from '@shared/contracts/conversation';
import type { SessionWorkflow } from '@shared/contracts/workflow';
import { WORKFLOW_WORDS } from '@shared/contracts/workflow';
import { chatTurn } from '../test/chat';
import { PlanStatusLine } from './PlanWorkflow';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002';
const AT = 2_000;
const note = (patch: Partial<Extract<SessionWorkflow, { kind: 'implemented' }>> = {}): SessionWorkflow => ({ kind: 'implemented', sessionId: ID, chat: 'Implement plan', at: AT, ...patch });
const turn = (id: string, acceptedAt: number | null, endReceivedAt: number | null, patch: Partial<ConversationTurn> = {}): ConversationTurn => chatTurn(id, { state: endReceivedAt === null ? 'running' : 'ended', outcome: endReceivedAt === null ? null : 'completed', time: { ...chatTurn(id).time, acceptedAt, endReceivedAt }, ...patch });
const turnsOf = (...turns: ConversationTurn[]) => new Map(turns.map((turn) => [turn.id, turn]));
const line = (turns: ReadonlyMap<string, ConversationTurn> | undefined, part = note()) => <PlanStatusLine sessionId={ID} part={part} providerName="Codex" turns={turns} />;

afterEach(cleanup);

describe('the implementation notice above the composer', () => {
  it('stays after implementation and during the first follow-up, disappearing once that turn ends', () => {
    const implementation = turn('implementation', 1_000, AT);
    const view = render(line(turnsOf(implementation)));
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();
    view.rerender(line(turnsOf(implementation, turn('follow-up', AT + 1, null))));
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();
    view.rerender(line(turnsOf(implementation, turn('follow-up', AT + 1, AT + 100))));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('counts a queued follow-up accepted in the completion note’s own millisecond', () => {
    render(line(turnsOf(turn('implementation', 1_000, AT), turn('follow-up', AT, AT + 100))));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('stays hidden after reopening the chat and while a subsequent turn runs', () => {
    const history = turnsOf(turn('follow-up', AT + 1, AT + 100), turn('later', AT + 200, null));
    const view = render(line(history));
    expect(screen.queryByRole('note')).toBeNull();
    view.unmount();
    render(line(history));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('does not reappear when browsing an older page without the follow-up turn', () => {
    const view = render(line(turnsOf(turn('follow-up', AT + 1, AT + 100))));
    expect(screen.queryByRole('note')).toBeNull();
    view.rerender(line(turnsOf(turn('older', 100, 200))));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows a newly implemented plan’s notice even after an older one expired', () => {
    const history = turnsOf(turn('follow-up', AT + 1, AT + 100));
    const view = render(line(history));
    expect(screen.queryByRole('note')).toBeNull();
    view.rerender(line(history, note({ at: AT + 1_000 })));
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();
  });

  it.each(['completed', 'failed', 'interrupted'] as const)('clears after a later turn ends as %s', (outcome) => {
    render(line(turnsOf(turn('follow-up', AT + 1, AT + 100, { outcome }))));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('does not count a turn accepted before implementation, unknown times, or an unfinished turn', () => {
    render(line(turnsOf(turn('implementation', AT - 100, AT + 100), turn('imported', null, AT + 200), turn('stopped', AT + 1, AT + 100, { state: 'unfinished' }))));
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();
  });

  it('waits for history to load before expiring the notice', () => {
    const view = render(line(undefined));
    expect(screen.getByText(WORKFLOW_WORDS.implementedHere)).not.toBeNull();
    view.rerender(line(turnsOf(turn('follow-up', AT + 1, AT + 100))));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('keeps the location notice in another participating chat', () => {
    render(line(turnsOf(turn('follow-up', AT + 1, AT + 100)), note({ sessionId: OTHER })));
    expect(screen.getByRole('note').textContent).toContain(WORKFLOW_WORDS.implementedIn);
  });
});
