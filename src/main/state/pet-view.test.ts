// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import { PET_LAYOUT, petContentSize } from '@shared/contracts/pet';
import type { ProjectEntryView } from '@shared/contracts/projects';
import type { SessionEntry } from '@shared/contracts/sessions';
import { sampleSnapshot } from '../../../tests/support/app-state';
import { PROJECT_A, PROJECT_B, sessionEntry, sessionsState, SUMMARIES } from '../../../tests/support/sessions';
import { petView } from './pet-view';
import { projectForWindow } from './projection';

type Project = Extract<ProjectEntryView, { kind: 'project' }>;

const project = (id: string, name: string, overrides: Partial<Project> = {}): Project => ({
  kind: 'project',
  key: id,
  id,
  name,
  color: 'teal',
  hidden: false,
  collapsed: false,
  providers: ['claude'],
  roots: [{ path: 'D:\\Users\\someone\\Secret', trust: 'trusted', missing: false }],
  sessions: 0,
  permissionModes: {},
  ...overrides,
});

const PROJECT_C = 'cccccccc-0000-4000-8000-00000000000c';

function snapshot(sessions: readonly SessionEntry[], projects: readonly ProjectEntryView[] = [project(PROJECT_A, 'Alpha'), project(PROJECT_B, 'Beta')]): AppStateSnapshot {
  return { ...sampleSnapshot(3), records: { status: { kind: 'ok', keptAs: null }, projects }, sessions: sessionsState(sessions, null, 0) };
}

const names = (view: ReturnType<typeof petView>): string[][] => view.projects.map((entry) => [entry.name, ...entry.sessions.map((session) => session.record.name ?? '')]);

describe('petView — which sessions (decision 0010)', () => {
  it('lists the active sessions running or waiting on the user, and no other', () => {
    const view = petView(snapshot([
      sessionEntry('Thinking', SUMMARIES.runningThinking),
      sessionEntry('Waiting on workers', SUMMARIES.waitingOnWorkers),
      sessionEntry('Questions', SUMMARIES.questions),
      sessionEntry('Approval', SUMMARIES.approval),
      sessionEntry('Ready, unseen', SUMMARIES.ready),
      sessionEntry('Error', SUMMARIES.error),
      sessionEntry('Stopped', SUMMARIES.stopped),
      sessionEntry('Ready, seen', SUMMARIES.readyAcknowledged),
      sessionEntry('Idle', SUMMARIES.idle),
      sessionEntry('Not started', SUMMARIES.notStarted),
      sessionEntry('Shelved', SUMMARIES.questions, { shelvedAt: 5 }),
      sessionEntry('Completed', SUMMARIES.runningThinking, { completedAt: 5 }),
    ]));
    expect(names(view)).toEqual([['Alpha', 'Thinking', 'Waiting on workers', 'Questions', 'Approval', 'Ready, unseen', 'Error', 'Stopped']]);
  });

  it('keeps a pending decision listed, and drops a plan’s wait held in another chat', () => {
    const plan = { ...SUMMARIES.idle, attention: { kind: 'plan' as const, count: 1, acknowledged: false, flash: false as const } };
    const waiting = { ...SUMMARIES.readyAcknowledged, planWait: 'review' as const };
    expect(names(petView(snapshot([sessionEntry('Plan ready', plan), sessionEntry('Waits on a review', waiting)])))).toEqual([['Alpha', 'Plan ready']]);
    expect(petView(snapshot([sessionEntry('Plan ready', plan)])).projects[0]?.sessions[0]?.summary.attention).toEqual(plan.attention);
  });

  it('groups by project in the Main window’s order — visible, then hidden — starred first within one', () => {
    const view = petView(snapshot(
      [
        sessionEntry('B one', SUMMARIES.runningThinking, { projectId: PROJECT_B }),
        sessionEntry('A one', SUMMARIES.questions),
        sessionEntry('C one', SUMMARIES.error, { projectId: PROJECT_C }),
        sessionEntry('A starred', SUMMARIES.ready, { starred: true }),
        sessionEntry('Orphan', SUMMARIES.runningThinking, { projectId: 'dddddddd-0000-4000-8000-00000000000d' }),
      ],
      [project(PROJECT_C, 'Hidden one', { hidden: true }), project(PROJECT_A, 'Alpha'), { kind: 'unreadable', key: 'x', sessions: 1 }, project(PROJECT_B, 'Beta')],
    ));
    expect(names(view)).toEqual([['Alpha', 'A starred', 'A one'], ['Beta', 'B one'], ['Hidden one', 'C one']]);
  });

  it('lists nothing with no records or no sessions', () => {
    expect(petView(sampleSnapshot(3)).projects).toEqual([]);
    expect(petView(snapshot([])).projects).toEqual([]);
  });

  it('carries the size main holds, compact until one is set', () => {
    expect(petView(snapshot([])).size).toBe('compact');
    expect(petView({ ...snapshot([]), petSize: 'capsule' }).size).toBe('capsule');
  });
});

describe('petView — an allowlist of what a capsule draws', () => {
  const face = { ref: { origin: 'user' as const, family: 'Private family', avatar: 'Private avatar' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32), source: 'match' as const };
  const agent = { id: 'worker-private', number: 1, label: 'Reads the private notes', state: 'running' as const, action: null, startedAt: 5, finishedAt: null, model: 'claude-haiku-private', agentType: 'Explore', attention: null };
  const running = {
    ...SUMMARIES.runningWorkers,
    action: { kind: 'reading' as const, label: 'Reading private-notes.md', detail: 'private-notes.md' },
    agents: [agent],
    mode: 'ask-first',
    context: { used: 1, window: 2, parts: [] },
  };
  const entry: SessionEntry = { ...sessionEntry('A session', running), avatar: face, agentAvatars: { [agent.id]: face } };
  const view = petView(snapshot([entry]));
  const session = view.projects[0]?.sessions[0];

  it('copies a session’s record, summary and avatar field by field', () => {
    expect(Object.keys(view.projects[0] ?? {}).sort()).toEqual(['id', 'name', 'sessions']);
    expect(Object.keys(session ?? {}).sort()).toEqual(['avatar', 'record', 'summary']);
    expect(Object.keys(session?.record ?? {}).sort()).toEqual(['createdAt', 'id', 'name', 'nameSource', 'providerId', 'speed']);
    expect(Object.keys(session?.summary ?? {}).sort()).toEqual(['action', 'activeWorkers', 'attention', 'effort', 'status', 'turnStartedAt']);
    expect(session?.summary.action).toEqual({ kind: 'reading' });
    expect(session?.avatar).toEqual({ portrait: 'a'.repeat(32), small: 'b'.repeat(32) });
  });

  it('holds no label, detail, sub-agent, model, mode, context, avatar name, root, logo or model list', () => {
    expect(JSON.stringify(view)).not.toMatch(/private-notes|Reading|worker-private|haiku-private|Explore|ask-first|"context"|"model"|Private family|Private avatar|"ref"|"source"|someone|Secret|"logo"|"models"/);
  });

  it('copies only a closed waiting reason, count and original display deadline', () => {
    const wait = { reason: 'subagents' as const, count: 2, label: 'private task', targets: ['private-worker'] };
    const displayHold = { kind: 'waiting' as const, wait, until: 1400, detail: 'private-file' };
    const summary = { ...running, action: { kind: 'waiting' as const, wait, label: 'private prompt' }, displayHold };
    const safe = petView(snapshot([sessionEntry('Waiting', summary)])).projects[0]?.sessions[0]?.summary;
    expect(safe?.action).toEqual({ kind: 'waiting', wait: { reason: 'subagents', count: 2 } });
    expect(safe?.displayHold).toEqual({ kind: 'waiting', wait: { reason: 'subagents', count: 2 }, until: 1400 });
    expect(JSON.stringify(safe)).not.toContain('private');
  });

  it('carries the presentation of the listed sessions’ providers alone: colour, mark and stream', () => {
    expect(Object.keys(view.presentation)).toEqual(['claude']);
    expect(Object.keys(view.presentation['claude'] ?? {}).sort()).toEqual(expect.arrayContaining(['barColor', 'icon']));
    expect(Object.keys(view.presentation['claude'] ?? {})).not.toContain('logo');
  });

  it('includes the listed provider’s logo for avatar placeholders', () => {
    const state = snapshot([entry]);
    if (state.catalog === undefined) throw new Error('no catalog');
    const logo = 'data:image/png;base64,aW1hZ2U=';
    const catalog = { ...state.catalog, providers: state.catalog.providers.map((provider) => ({ ...provider, presentation: { ...provider.presentation, logo } })) };
    expect(petView({ ...state, catalog }).presentation['claude']?.logo).toBe(logo);
  });

  it('reaches the Pet in its projection, beside the theme and the providers', () => {
    const pet = projectForWindow('pet', { ...snapshot([entry]), quitQuestion: true, zoom: 125 });
    expect(Object.keys(pet).sort()).toEqual(['appearance', 'pet', 'providers', 'seq']);
    expect(pet.pet).toEqual(view);
  });
});

describe('petContentSize', () => {
  it('is the frame, the bar and the empty line with nothing listed', () => {
    expect(petContentSize({ size: 'capsule', projects: [] })).toEqual({ width: PET_LAYOUT.width.capsule, height: 56 });
  });

  it('counts a row per project and one per capsule, 1 px apart within a project, the last meeting the frame', () => {
    const view = petView(snapshot([sessionEntry('One', SUMMARIES.questions), sessionEntry('Two', SUMMARIES.error), sessionEntry('Three', SUMMARIES.ready, { projectId: PROJECT_B })]));
    expect(petContentSize({ ...view, size: 'capsule' })).toEqual({ width: 300, height: 2 + 24 + (16 + 2 * 60 + 1) + (16 + 60) });
    expect(petContentSize({ ...view, size: 'compact' })).toEqual({ width: 240, height: 2 + 24 + (16 + 2 * 36 + 1) + (16 + 36) });
  });
});
