// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// When a session's Sub-agents tab opens by itself (docs/planning/_archive/M106.md, V5; C1, C2; docs/planning/_archive/
// M100.md, round 8; C78): for every listed session whose summary lists a sub-agent, running or finished —
// as a launch lists them from the store — and for the selected session with a live grant; first in the
// row, taking the view from no tab that is shown; and never closed. Read from the tabs store: no pane
// is drawn.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionGrant } from '@shared/contracts/interaction';
import type { AgentView, SessionEntry, SessionSummary } from '@shared/contracts/sessions';
import { sessionEntry, SUMMARIES } from '../../../../../tests/support/sessions';
import { resetGrants, setGrants } from '../../chat/grants-store';
import { installFakeBridge } from '../../test/fake-bridge';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { BUILT_IN_KINDS } from '../kinds';
import { AGENTS_KIND, FILE_KIND } from '../opener';
import { closeTab, openTab, registerKinds, resetTabs, tabId, useTabs } from '../tabs-store';
import { AgentsWatcher } from './AgentsWatcher';

beforeEach(() => {
  installFakeBridge();
  resetTabs();
  resetGrants();
  registerKinds(BUILT_IN_KINDS);
});
afterEach(() => {
  cleanup();
  resetTabs();
});

const A = project('Calamari');
const s = (name: string, summary: SessionSummary): SessionEntry => sessionEntry(name, summary, { projectId: A.id, providerId: 'claude' });
const AGENTS_TAB = tabId(AGENTS_KIND, null);
const held = (entry: SessionEntry) => useTabs.getState().sessions[entry.record.id];
const kinds = (entry: SessionEntry) => held(entry)?.tabs.map((tab) => tab.kind) ?? [];
const worker = (id: string, number: number, state: AgentView['state'] = 'running'): AgentView => ({ id, number, label: `Worker ${number}`, state, action: null, startedAt: 1, finishedAt: state === 'running' ? null : 2, model: null, agentType: null, attention: null });
const withAgents = (entry: SessionEntry, agents: readonly AgentView[]): SessionEntry => ({ ...entry, summary: { ...entry.summary, agents } });
const grant = (itemId: string, live: boolean): SessionGrant => ({ itemId, covers: `Bash(${itemId})`, decidedAt: 5, confirmed: true, live });

describe('the Sub-agents tab’s watcher (M106, V5; M100, C78)', () => {
  it('opens no tab for a session with no sub-agent and no grant', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    showState({ projects: [A], sessions: [entry], selectedId: entry.record.id });
    render(<AgentsWatcher />);
    expect(held(entry)).toBeUndefined();
  });

  it('opens the tab, shown, for a session whose first sub-agent starts, selected or not', () => {
    const selected = s('Create plan', SUMMARIES.runningThinking);
    const other = s('Fix login', SUMMARIES.runningThinking);
    showState({ projects: [A], sessions: [selected, other], selectedId: selected.record.id });
    render(<AgentsWatcher />);
    act(() => void showState({ projects: [A], sessions: [withAgents(selected, [worker('w1', 1)]), withAgents(other, [worker('w2', 1)])], selectedId: selected.record.id }));
    for (const entry of [selected, other]) {
      expect(kinds(entry)).toEqual([AGENTS_KIND]);
      expect(held(entry)?.selected).toBe(AGENTS_TAB);
    }
  });

  it('opens it from the first app state for a session that lists finished ones, as a launch lists them (C1, C26)', () => {
    const entry = s('Create plan', SUMMARIES.idle);
    showState({ projects: [A], sessions: [withAgents(entry, [worker('w1', 1, 'completed'), worker('w2', 2, 'failed')])], selectedId: null });
    render(<AgentsWatcher />);
    expect(kinds(entry)).toEqual([AGENTS_KIND]);
  });

  it('goes first in the row and leaves the tab being read shown', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    showState({ projects: [A], sessions: [entry], selectedId: entry.record.id });
    render(<AgentsWatcher />);
    act(() => void openTab(entry.record.id, FILE_KIND, 'D:\\work\\README.md'));
    const file = held(entry)?.selected;
    act(() => void showState({ projects: [A], sessions: [withAgents(entry, [worker('w1', 1)])], selectedId: entry.record.id }));
    expect(kinds(entry)).toEqual([AGENTS_KIND, FILE_KIND]);
    expect(held(entry)?.selected).toBe(file);
  });

  it('stays when the list empties and cannot be closed; opening it again at each change changes nothing (C2)', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    const show = (agents: readonly AgentView[]) => act(() => void showState({ projects: [A], sessions: [withAgents(entry, agents)], selectedId: entry.record.id }));
    showState({ projects: [A], sessions: [entry], selectedId: entry.record.id });
    render(<AgentsWatcher />);
    show([worker('w1', 1)]);
    show([]);
    expect(kinds(entry)).toEqual([AGENTS_KIND]);
    act(() => closeTab(entry.record.id, AGENTS_TAB));
    expect(kinds(entry)).toEqual([AGENTS_KIND]);
    // The tabs are the same objects after another change that lists a sub-agent.
    const before = useTabs.getState();
    show([worker('w1', 1), worker('w2', 2)]);
    expect(useTabs.getState()).toBe(before);
  });

  it('opens it for the selected session’s live grant, and not for one already ended when read', () => {
    const entry = s('Create plan', SUMMARIES.idle);
    showState({ projects: [A], sessions: [entry], selectedId: entry.record.id });
    render(<AgentsWatcher />);
    // Ended grants, as a read after a restart lists them: listed in the tab, and no call to open it.
    act(() => setGrants(entry.record.id, [grant('old', false)]));
    expect(held(entry)).toBeUndefined();
    act(() => setGrants(entry.record.id, [grant('old', false), grant('new', true)]));
    expect(kinds(entry)).toEqual([AGENTS_KIND]);
  });

  it('opens nothing while the kinds are not registered, and opens once they are, at the next change', () => {
    registerKinds([]);
    const entry = s('Create plan', SUMMARIES.runningThinking);
    showState({ projects: [A], sessions: [withAgents(entry, [worker('w1', 1)])], selectedId: entry.record.id });
    render(<AgentsWatcher />);
    expect(held(entry)).toBeUndefined();
    registerKinds(BUILT_IN_KINDS);
    act(() => void showState({ projects: [A], sessions: [withAgents(entry, [worker('w1', 1)])], selectedId: null }));
    expect(kinds(entry)).toEqual([AGENTS_KIND]);
  });
});
