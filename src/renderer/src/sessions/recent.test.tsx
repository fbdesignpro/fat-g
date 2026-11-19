// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The recent sessions (docs/planning/_archive/M100.md, Design 5; C93): the order the switcher lists them in,
// and the visits it is made from.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '@shared/contracts/sessions';
import { CREATED_AT, SUMMARIES, sessionEntry } from '../../../../tests/support/sessions';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { recentSessions, useRecentTracking, useVisitedSessions, visitSession } from './recent';

const A = project('Calamari');
const B = project('website');
const HIDDEN = project('Archive', { hidden: true });

const at = (minutes: number): number => CREATED_AT + minutes * 60_000;
const session = (name: string | null, minutes: number, overrides: Partial<SessionEntry['record']> = {}, summary = SUMMARIES.idle) =>
  sessionEntry(name, summary, { projectId: A.id, lastActiveAt: at(minutes), ...overrides });

const names = (entries: readonly SessionEntry[]): (string | null)[] => entries.map((entry) => entry.record.name);
const ids = (...entries: readonly SessionEntry[]): string[] => entries.map((entry) => entry.record.id);

beforeEach(() => useVisitedSessions.setState({ ids: [] }));
afterEach(cleanup);

describe('recentSessions (C93)', () => {
  const old = session('Old', 1);
  const mid = session('Mid', 5, { projectId: B.id });
  const late = session('Late', 9);
  const done = session('Done', 20, { completedAt: at(21) });
  const archived = session('Archived', 30, { projectId: HIDDEN.id });
  const all = [old, mid, late, done, archived];
  const projects = [A, B, HIDDEN];

  it('lists the active sessions of the visible projects by their last activity, the latest first, with nothing visited', () => {
    expect(names(recentSessions([], all, projects, {}))).toEqual(['Late', 'Mid', 'Old']);
  });

  it('puts the visited ones first, the latest visit first, then the rest by activity', () => {
    expect(names(recentSessions(ids(old, mid), all, projects, {}))).toEqual(['Old', 'Mid', 'Late']);
  });

  // The maintainer: Done takes a session out of the list, visited or not.
  it('leaves a completed session out, visited or not, and keeps one of a hidden project once visited', () => {
    expect(names(recentSessions(ids(done, archived), all, projects, {}))).toEqual(['Archived', 'Late', 'Mid', 'Old']);
    expect(names(recentSessions(ids(done), all, projects, {}))).toEqual(['Late', 'Mid', 'Old']);
  });

  it('drops a visited session that is no longer listed', () => {
    expect(names(recentSessions([...ids(late), 'gone-gone-gone', ...ids(old)], all, projects, {}))).toEqual(['Late', 'Old', 'Mid']);
  });

  it('leaves out a session that draws no capsule, and takes it once it has something typed or a name', () => {
    const fresh = session(null, 40, { createdAt: at(39) }, SUMMARIES.notStarted);
    const withList = [...all, fresh];
    expect(names(recentSessions(ids(fresh), withList, projects, {}))).toEqual(['Late', 'Mid', 'Old']);
    expect(recentSessions(ids(fresh), withList, projects, { [fresh.record.id]: 'Fix the login' })[0]?.record.id).toBe(fresh.record.id);
    const named = session('Login form', 40, { nameSource: 'generated' }, SUMMARIES.notStarted);
    expect(names(recentSessions([], [...all, named], projects, {}))).toEqual(['Login form', 'Late', 'Mid', 'Old']);
  });
});

describe('the visits', () => {
  it('put the selected session first, once, whoever selected it', async () => {
    const one = session('One', 1);
    const two = session('Two', 2);
    function Watcher() {
      useRecentTracking();
      return null;
    }
    showState({ projects: [A], sessions: [one, two], selectedId: one.record.id });
    render(<Watcher />);
    expect(useVisitedSessions.getState().ids).toEqual(ids(one));
    await act(async () => {
      showState({ projects: [A], sessions: [one, two], selectedId: two.record.id });
      await Promise.resolve();
    });
    expect(useVisitedSessions.getState().ids).toEqual(ids(two, one));
    await act(async () => {
      showState({ projects: [A], sessions: [one, two], selectedId: one.record.id });
      await Promise.resolve();
    });
    expect(useVisitedSessions.getState().ids).toEqual(ids(one, two));
    // Nothing selected leaves the visits as they were.
    await act(async () => {
      showState({ projects: [A], sessions: [one, two], selectedId: null });
      await Promise.resolve();
    });
    expect(useVisitedSessions.getState().ids).toEqual(ids(one, two));
  });

  it('keep the same list when the first is visited again', () => {
    visitSession('a');
    const before = useVisitedSessions.getState();
    visitSession('a');
    expect(useVisitedSessions.getState()).toBe(before);
  });
});
