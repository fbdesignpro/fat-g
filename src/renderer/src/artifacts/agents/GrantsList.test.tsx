// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V32 (docs/planning/_archive/M22.md, Design 5, 10; C23, C57, C86, C92) and V5 (docs/planning/_archive/M106.md;
// C31, C32): the grants fat-g sent, in the session's Sub-agents tab, folded under one line after its
// sub-agents — each by what it covers, confirmed or not, live or ended, the live ones first; the line
// that says what the list is, and the provider's own line on its CLI's rules. What is listed is what
// the session's read lists, which holds delivered grants alone: the chat's hook puts it in the page's
// store, and useChat.test.tsx covers that an undelivered one never gets there.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionGrant } from '@shared/contracts/interaction';
import { noteGrant, resetGrants, setGrants, useGrantsStore } from '../../chat/grants-store';
import { GRANT_WORDS } from '../../session-area/mode-words';
import { approvalWith, chatApproval } from '../../test/chat';
import { installFakeBridge } from '../../test/fake-bridge';
import { PaneWithKinds } from '../../test/pane';
import { modedEntry, modedProvider, MODES } from '../../test/permissions';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { BUILT_IN_KINDS } from '../kinds';
import { AGENTS_KIND } from '../opener';
import { openTab, resetTabs } from '../tabs-store';

beforeEach(() => {
  installFakeBridge();
  resetGrants();
  resetTabs();
});
afterEach(() => {
  cleanup();
  resetTabs();
});

const A = project('Calamari');
const ENTRY = modedEntry('Create plan', { id: 'ask-first', source: 'chat' }, { confirmed: 'ask-first', record: { projectId: A.id } });
const ID = ENTRY.record.id;
const grant = (itemId: string, patch: Partial<SessionGrant> = {}): SessionGrant => ({ itemId, covers: `Bash(${itemId})`, decidedAt: 5, confirmed: true, live: true, ...patch });
/** The selected session's Sub-agents tab, opened at the test's word, its grants those given. */
function open(grants: readonly SessionGrant[], capability: Parameters<typeof modedProvider>[1] = MODES) {
  act(() => {
    showState({ projects: [A], sessions: [ENTRY], selectedId: ID, providers: [modedProvider({}, capability)] });
    setGrants(ID, grants);
  });
  render(<PaneWithKinds kinds={BUILT_IN_KINDS} />);
  act(() => void openTab(ID, AGENTS_KIND, null));
}
const line = () => document.querySelector<HTMLButtonElement>('[data-agents-tab] [data-grants-fold]');
/** The grants, unfolded by their line. */
function unfold(): HTMLElement {
  if (line()?.getAttribute('aria-expanded') === 'false') fireEvent.click(line() as HTMLElement);
  return screen.getByRole('region', { name: GRANT_WORDS.title });
}
const list = () => screen.queryByRole('region', { name: GRANT_WORDS.title });
const rows = () => within(list() as HTMLElement).getAllByRole('listitem').map((row) => [...row.querySelectorAll('span')].map((part) => part.textContent));

describe('the grants list (V9, V32; C57, C86, C92; M106, C31)', () => {
  it('draws no line and no list for a session with no grant', () => {
    open([]);
    expect([line(), list()]).toEqual([null, null]);
  });

  it('folds under one line after the sub-agents, closed by default, which counts them and unfolds each by what it covers, confirmed or not by the CLI’s word', () => {
    open([grant('touch notes.txt'), grant('notes.txt', { covers: 'notes.txt', confirmed: false })]);
    expect([line()?.textContent, line()?.getAttribute('aria-expanded'), list()]).toEqual(['2 grants', 'false', null]);
    const shown = unfold();
    expect(line()?.getAttribute('aria-expanded')).toBe('true');
    // No heading of its own: the line names it.
    expect(shown.querySelector('h3')).toBeNull();
    expect(rows()).toEqual([['Bash(touch notes.txt)', 'confirmed · live'], ['notes.txt', 'not confirmed · live']]);
    const agents = document.querySelector('[data-agents-tab] [data-agent-list]') as HTMLElement;
    expect(agents.compareDocumentPosition(shown) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(line() as HTMLElement);
    expect(list()).toBeNull();
  });

  it('lists the live ones first, then the ended ones, each said ended, with no fold of its own', () => {
    open([grant('one', { live: false }), grant('two'), grant('three', { live: false, confirmed: false })]);
    expect(line()?.textContent).toBe('3 grants');
    unfold();
    expect(rows()).toEqual([['Bash(two)', 'confirmed · live'], ['Bash(one)', 'confirmed · ended'], ['Bash(three)', 'not confirmed · ended']]);
    expect((list() as HTMLElement).querySelector('[data-grants-ended]')).toBeNull();
  });

  it('says it is fat-g’s record of what it sent and no reading of the CLI, with the provider’s one line on its CLI’s rules (C23)', () => {
    open([grant('one')]);
    const shown = unfold();
    expect(shown.querySelector('[data-grants-record]')?.textContent).toBe('fat-g’s record of what it sent, and no reading of the CLI.');
    // The provider's declaration, drawn as it is: the page holds no word of a provider's.
    expect(shown.querySelector('[data-grants-rules]')?.textContent?.trim()).toBe(MODES.rules);
  });

  it('has no control that ends a grant (C86)', () => {
    open([grant('one'), grant('two', { live: false })]);
    expect(unfold().querySelectorAll('button, input, a')).toHaveLength(0);
  });

  it('shows a grant ended as soon as main says its process is gone, and all of them after a restart', () => {
    open([grant('one'), grant('two')]);
    unfold();
    expect(rows().map((row) => row[1])).toEqual(['confirmed · live', 'confirmed · live']);
    // A change of mode that restarted the process, the idle close, a loss: the read lists them ended.
    act(() => { setGrants(ID, [grant('one', { live: false }), grant('two', { live: false })]); });
    expect(rows().map((row) => row[1])).toEqual(['confirmed · ended', 'confirmed · ended']);
  });

  it('lists the grants of the selected session alone', () => {
    open([grant('one')]);
    act(() => { setGrants('5e55ffff-0000-4000-8000-00000000ffff', [grant('another')]); });
    expect([line(), list()]).toEqual([null, null]);
  });
});

describe('the page’s record of a session’s grants (V32; C92)', () => {
  const GRANTED = { choices: ['approve', 'approve-session', 'deny'] as const, grant: { covers: 'Bash(touch notes.txt)' } };
  const held = () => useGrantsStore.getState().grants;

  it('lists a grant from its card’s push only once its reply was delivered, confirmed once the CLI’s word comes and not before', () => {
    setGrants(ID, []);
    const card = chatApproval(ID, 't1', { request: { ...GRANTED, choices: [...GRANTED.choices] } });
    noteGrant(ID, card);
    expect(held()).toEqual([]);
    // Written, and not yet sent: neither the decision's write nor the process key stands for delivery.
    const decided = approvalWith(card, { outcome: 'approved-session', decidedAt: 7, delivered: null, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: true } });
    noteGrant(ID, decided);
    expect(held()).toEqual([]);
    noteGrant(ID, approvalWith(decided, { delivered: true }));
    expect(held()).toEqual([{ itemId: card.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: false, live: true }]);
    noteGrant(ID, approvalWith(decided, { delivered: true, confirmedAt: 9 }));
    expect(held()).toEqual([{ itemId: card.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: true, live: true }]);
    // Its process ended: main lays that over the push, and the page says what main says.
    noteGrant(ID, approvalWith(decided, { delivered: true, confirmedAt: 9, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } }));
    expect(held()).toEqual([{ itemId: card.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: true, live: false }]);
  });

  it('never lists a grant whose reply the process refused, and takes one off that turns out not to have been sent', () => {
    setGrants(ID, []);
    const card = chatApproval(ID, 't1', { request: { ...GRANTED, choices: [...GRANTED.choices] } });
    const refused = approvalWith(card, { outcome: 'approved-session', decidedAt: 7, delivered: false, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } });
    noteGrant(ID, refused);
    expect(held()).toEqual([]);
    setGrants(ID, [{ itemId: card.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: false, live: true }]);
    noteGrant(ID, refused);
    expect(held()).toEqual([]);
  });

  it('takes nothing from an approval that granted nothing, nor from an item that is no approval', () => {
    setGrants(ID, [grant('one')]);
    const before = held();
    noteGrant(ID, approvalWith(chatApproval(ID, 't1'), { outcome: 'approved', decidedAt: 7, delivered: true }));
    noteGrant(ID, { id: 'm-other', interaction: null });
    expect(held()).toBe(before);
  });
});
