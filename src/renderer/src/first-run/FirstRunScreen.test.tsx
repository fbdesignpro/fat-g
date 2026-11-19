// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredProvider, ProviderDiscoveryState } from '@shared/contracts/provider-discovery';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { sessionEntry, sessionsState, SUMMARIES } from '../../../../tests/support/sessions';
import { closeSettings, useSettings } from '../settings/settings-store';
import { Shell } from '../shell/Shell';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { project, recordsState } from '../test/records';

const provider = (overrides: Partial<DiscoveredProvider> = {}): DiscoveredProvider =>
  ({ id: 'claude', displayName: 'Claude', presence: 'missing', enabled: false, overrideInvalid: false, checkFailed: false, ...overrides });
const discovery = (providers: readonly DiscoveredProvider[], checking = false): ProviderDiscoveryState => ({ checking, providers, notice: null, historyIssue: null });
const MISSING = [provider(), provider({ id: 'codex', displayName: 'Codex' })];
const USABLE = [provider({ presence: 'present', enabled: true })];
const show = (providers: readonly DiscoveredProvider[], projects = recordsState([]), checking = false): void =>
  useAppState.setState({ snapshot: { ...sampleSnapshot(), providerDiscovery: discovery(providers, checking), records: projects } });

let invoke = vi.fn(async (_channel: string, _request: unknown): Promise<unknown> => ({ ok: true, value: null }));
beforeEach(() => {
  invoke = vi.fn(async () => ({ ok: true, value: null }));
  installFakeBridge().setInvoke(invoke);
  closeSettings();
  usePrefs.setState({ snapshot: null, error: null, saving: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const guide = () => screen.queryByRole('main', { name: 'Getting started' });

describe('no provider detected', () => {
  it('replaces the empty chat window with the guide, each provider with its finding and installation guide', () => {
    show(MISSING);
    render(<Shell />);
    expect(screen.queryByRole('main', { name: 'Chat' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'No AI coding CLI found' })).toBeTruthy();
    expect(guide()?.textContent).toContain('CLI not found.');
    expect(screen.getAllByRole('button', { name: 'Installation guide' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Installation guide' })[1]!);
    expect(invoke).toHaveBeenCalledWith('shell:openLink', { providerId: 'codex' });
  });

  it('checks at once at the press, and while a check runs says so with the button held', async () => {
    show(MISSING);
    const { rerender } = render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(invoke).toHaveBeenCalledWith('providers:discover', null);
    show(MISSING, recordsState([]), true);
    rerender(<Shell />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Checking…' })).toHaveProperty('disabled', true));
  });

  it('says a detected provider is switched off, offers no guide for it, and opens Accounts settings', () => {
    show([provider({ presence: 'present', enabled: false })]);
    render(<Shell />);
    expect(screen.getByRole('heading', { level: 1, name: 'No LLM provider enabled' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Installation guide' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accounts settings' }));
    expect(useSettings.getState()).toMatchObject({ open: true, tab: 'accounts' });
  });

  it('leaves a shown session where it is', () => {
    // The chat's own reads stay unanswered, as from a busy main.
    installFakeBridge();
    const calamari = project('Calamari');
    const entry = sessionEntry('Create plan', SUMMARIES.runningThinking, { projectId: calamari.id });
    useAppState.setState({ snapshot: { ...sampleSnapshot(), providerDiscovery: discovery(MISSING), records: recordsState([calamari]), sessions: sessionsState([entry], entry.record.id) } });
    render(<Shell />);
    expect(guide()).toBeNull();
    expect(screen.getByRole('main', { name: 'Chat' })).toBeTruthy();
  });
});

describe('no project yet', () => {
  /** Add project at the top of the column, and the line's first row, where the test lays them out. */
  const layOut = (): void => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-add-project')) return DOMRect.fromRect({ x: 40, y: 20, width: 100, height: 24 });
      if (this.textContent === 'Start by adding a project from a folder') return DOMRect.fromRect({ x: 400, y: 100, width: 500, height: 40 });
      return DOMRect.fromRect();
    });
  };

  it('points from the line to the foot of Add project, the column on the left', () => {
    layOut();
    show(USABLE);
    const { container } = render(<Shell />);
    expect(screen.getByRole('heading', { level: 1, name: 'Start by adding a project from a folder' })).toBeTruthy();
    const paths = [...container.querySelectorAll('[data-first-run] svg path')].map((path) => path.getAttribute('d'));
    expect(paths).toEqual(['M 388 120 Q 90 120 90 80 L 90 58', 'M 85 66 L 90 56 L 95 66']);
  });

  it('leaves from the line’s other end with the column on the right', () => {
    layOut();
    show(USABLE);
    usePrefs.setState({ snapshot: prefsSnapshot({ layout: { projectColumn: 'right' } }), error: null, saving: false });
    const { container } = render(<Shell />);
    expect(container.querySelector('[data-first-run="add-project"]')?.getAttribute('data-side')).toBe('right');
    expect(container.querySelector('[data-first-run] svg path')?.getAttribute('d')).toBe('M 912 120 Q 90 120 90 80 L 90 58');
  });

  it('is gone once a project exists', () => {
    show(USABLE, recordsState([project('Calamari')]));
    render(<Shell />);
    expect(guide()).toBeNull();
    expect(screen.getByRole('main', { name: 'Chat' })).toBeTruthy();
  });
});
