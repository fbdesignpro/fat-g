// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { PetSession, PetSize, PetView } from '@shared/contracts/pet';
import type { SessionSummary } from '@shared/contracts/sessions';
import { SAMPLE_EMAIL, SAMPLE_ORGANIZATION, sampleSnapshot } from '../../../tests/support/app-state';
import { SAMPLE_PRESENTATION } from '../../../tests/support/catalog';
import { sessionView, SUMMARIES } from '../../../tests/support/sessions';
import { PetApp } from './PetApp';
import { useAppState } from './state/store';
import { type FakeBridge, installFakeBridge } from './test/fake-bridge';

let bridge: FakeBridge;
let requests: unknown[];

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: null });
  });
  useAppState.setState({ snapshot: null, error: null });
});
afterEach(cleanup);

/** A session as main's view holds it: the record's six fields and the summary's, of the action its kind alone. */
function petSession(name: string, summary: SessionSummary): PetSession {
  const { id, providerId, nameSource, createdAt, speed } = sessionView(name);
  return {
    record: { id, providerId, name, nameSource, createdAt, speed },
    summary: { status: summary.status, turnStartedAt: summary.turnStartedAt, activeWorkers: summary.activeWorkers, attention: summary.attention, action: summary.action === null ? null : { kind: summary.action.kind }, effort: summary.effort },
    avatar: null,
  };
}

/** The Pet's copy of the state: no catalog, the theme, the providers and its own view. */
function petSnapshot(view: Partial<PetView> = {}, seq = 2): AppStateSnapshot {
  const { catalog: _catalog, ...rest } = sampleSnapshot(seq);
  return { ...rest, pet: { size: 'capsule', projects: [], presentation: { claude: SAMPLE_PRESENTATION }, ...view } };
}

const LISTED: PetView['projects'] = [
  { id: 'aaaaaaaa-0000-4000-8000-00000000000a', name: 'Alpha', sessions: [petSession('Writes the parser', SUMMARIES.questions), petSession('Fixes the build', SUMMARIES.runningWorkers)] },
  { id: 'bbbbbbbb-0000-4000-8000-00000000000b', name: 'Beta', sessions: [petSession('Ships it', SUMMARIES.error)] },
];

const show = (size: PetSize = 'capsule'): void => useAppState.setState({ snapshot: petSnapshot({ size, projects: LISTED }) });

describe('PetApp', () => {
  it('waits for the first snapshot', () => {
    render(<PetApp />);
    expect(screen.getByText('Waiting for the main process…')).toBeTruthy();
  });

  it('says so when nothing runs or waits on the user', () => {
    useAppState.setState({ snapshot: petSnapshot() });
    render(<PetApp />);
    expect(screen.getByText('Nothing running or waiting on you')).toBeTruthy();
    expect(document.querySelectorAll('[data-pet-session]')).toHaveLength(0);
  });

  it('opens Main from the empty area without requesting a session', () => {
    useAppState.setState({ snapshot: petSnapshot() });
    render(<PetApp />);
    const empty = screen.getByRole('button', { name: 'Open the main window' });
    expect(empty.textContent).toBe('Nothing running or waiting on you');
    fireEvent.click(empty);
    expect(requests).toEqual([['pet:showMain', null]]);
  });

  it('lists the sessions under their projects’ names, each named with its state', () => {
    show();
    render(<PetApp />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Alpha', 'Beta']);
    const alpha = within(screen.getByRole('list', { name: 'Alpha' }));
    expect(alpha.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Writes the parser, 3 Questions', 'Fixes the build, Reading, +2 active subagents']);
    expect(within(screen.getByRole('list', { name: 'Beta' })).getByRole('button').getAttribute('aria-label')).toBe('Ships it, Error');
    expect(document.querySelector('[data-pet-session] [data-capsule-status]')?.getAttribute('data-attention')).toBe('question');
  });

  it.each([['capsule', 'capsule', 'false'], ['compact', 'compact', 'true']] as const)('draws the %s size: its avatars and the toggle’s state', (size, avatar, pressed) => {
    show(size);
    render(<PetApp />);
    expect(document.querySelector('[data-pet-size]')?.getAttribute('data-pet-size')).toBe(size);
    expect([...document.querySelectorAll('[data-pet-session] [data-size]')].map((element) => element.getAttribute('data-size'))).toEqual([avatar, avatar, avatar]);
    expect(screen.getByRole('button', { name: 'Small capsules' }).getAttribute('aria-pressed')).toBe(pressed);
    expect(screen.getByRole('button', { name: 'Large capsules' }).getAttribute('aria-pressed')).toBe(pressed === 'true' ? 'false' : 'true');
  });

  it('offers both sizes in one group, and asks main for the one pressed — nothing for the one in use', () => {
    show('capsule');
    const { rerender } = render(<PetApp />);
    expect(within(screen.getByRole('group', { name: 'Capsule size' })).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Large capsules', 'Small capsules']);
    fireEvent.click(screen.getByRole('button', { name: 'Large capsules' }));
    fireEvent.click(screen.getByRole('button', { name: 'Small capsules' }));
    show('compact');
    rerender(<PetApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Small capsules' }));
    fireEvent.click(screen.getByRole('button', { name: 'Large capsules' }));
    expect(requests).toEqual([['pet:setSize', { size: 'compact' }], ['pet:setSize', { size: 'capsule' }]]);
  });

  it('asks main to open a session pressed', () => {
    show();
    render(<PetApp />);
    fireEvent.click(screen.getByRole('button', { name: /^Ships it/ }));
    expect(requests).toEqual([['pet:open', { id: LISTED[1]?.sessions[0]?.record.id }]]);
  });

  it('never renders account identity, even if a snapshot carrying it slipped through', () => {
    // Main's projection strips these before they reach the Pet window; this is the second line of defence.
    useAppState.setState({ snapshot: { ...sampleSnapshot(1), pet: petSnapshot({ projects: LISTED }).pet } });
    const { container } = render(<PetApp />);
    expect(container.textContent).not.toContain(SAMPLE_EMAIL);
    expect(container.textContent).not.toContain(SAMPLE_ORGANIZATION);
    expect(container.textContent).not.toContain('@');
  });

  it('names a bar button at once under the pointer, with no title to wait for', () => {
    show();
    render(<PetApp />);
    const small = screen.getByRole('button', { name: 'Small capsules' });
    expect(small.hasAttribute('title')).toBe(false);
    expect(document.querySelector('[data-name-tip]')).toBeNull();
    fireEvent.pointerEnter(small);
    expect(document.querySelector('[data-name-tip]')?.textContent).toBe('Small capsules');
    fireEvent.pointerLeave(small);
    expect(document.querySelector('[data-name-tip]')).toBeNull();
  });

  it('asks main to hide it when its × is pressed', () => {
    render(<PetApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the mini window' }));
    expect(requests).toEqual([['pet:hide', null]]);
  });

  it('marks itself as the pet page for smoke mode', () => {
    const { container } = render(<PetApp />);
    expect(container.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-page')).toBe('pet');
  });
});
