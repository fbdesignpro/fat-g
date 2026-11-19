// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The project dialog (docs/planning/_archive/M12.md, Verification V10 and V27; C12, C16, C17, C20, C26, C28–C33,
// C36, C38, C39).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvokeChannel } from '@shared/ipc/channels';
import type { ProjectEntryView } from '@shared/contracts/projects';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { modedProvider, MODES } from '../test/permissions';
import { prefsSnapshot } from '../test/prefs';
import { project, recordsState, uuidFor as uuidOf, withRecords } from '../test/records';
import { closeProjectDialog, openProjectDialog, useProjectDialog } from './project-dialog-store';
import { ProjectDialog } from './ProjectDialog';
import { TRUST_EXPLANATION } from './RootRow';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
/** What the folder picker answers next, in order. */
let picks: unknown[];
let saveAnswer: unknown;

beforeAll(installDialogStandIn);
beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  picks = [];
  saveAnswer = { status: 'saved', id: 'aaaaaaaa-0000-4000-8000-000000000001' };
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    if (channel === 'projects:pickFolder') return { ok: true, value: picks.shift() ?? { status: 'cancelled' } };
    if (channel === 'projects:checkRoots') return { ok: true, value: null };
    if (saveAnswer === 'fail') return { ok: false, error: 'internal' };
    return { ok: true, value: saveAnswer };
  });
  usePrefs.setState({ snapshot: null });
  closeProjectDialog();
  useProjectDialog.setState({ added: null });
});
afterEach(cleanup);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const show = (projects: readonly ProjectEntryView[]) => useAppState.setState({ snapshot: withRecords(recordsState(projects)), error: null });
const openDialog = (projectId: string | null = null) => {
  const view = render(<ProjectDialog />);
  act(() => openProjectDialog(projectId));
  return view;
};
const dialog = () => screen.getByRole<HTMLDialogElement>('dialog');
const saves = () => requests.filter(([channel]) => channel === 'projects:add' || channel === 'projects:update');
const picked = (path: string, folderName: string | null, conflict: unknown = null) => ({ status: 'picked', path, folderName, conflict });
const addFolder = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
    await flush();
  });
};
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
};
const trust = (path: string, answer: 'Trust' | 'Don’t trust') =>
  fireEvent.click(within(screen.getByRole('group', { name: `Trust this folder? ${path}` })).getByRole('radio', { name: answer }));

const A = project('fat-g', { color: 'red' });

describe('adding (V10)', () => {
  it('opens as a modal dialog with every field (C36)', () => {
    show([]);
    openDialog();
    expect(dialog().getAttribute('open')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Add project' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Colour' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Folders' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Providers' })).getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual(['Claude', 'Codex']);
  });

  it('proposes the first colour no project uses (C20), and every registered provider', () => {
    show([A, project('b', { color: 'orange' })]);
    openDialog();
    expect(screen.queryByRole('group', { name: 'Colour' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Providers' })).getAllByRole<HTMLInputElement>('checkbox').every((box) => box.checked)).toBe(true);
  });

  it('proposes the first folder’s name until the user types one (C17)', async () => {
    show([]);
    openDialog();
    picks = [picked('D:\\Code\\fat-g', 'fat-g'), picked('D:\\Code\\docs', 'docs')];
    await addFolder();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('fat-g');
    await addFolder();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('fat-g');
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove D:\\Code\\fat-g' }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('Mine');
  });

  it('proposes no name for a drive', async () => {
    show([]);
    openDialog();
    picks = [picked('E:\\', null)];
    await addFolder();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('');
  });

  it('asks about trust once per root, with its text and both answers, starting unanswered (C30, C31, C33)', async () => {
    show([]);
    openDialog();
    picks = [picked('D:\\a', 'a'), picked('D:\\b', 'b')];
    await addFolder();
    await addFolder();
    const questions = screen.getAllByRole('group', { name: /^Trust this folder\?/ });
    expect(questions.map((group) => group.getAttribute('aria-label'))).toEqual(['Trust this folder? D:\\a', 'Trust this folder? D:\\b']);
    for (const group of questions) {
      expect(group.textContent).toContain(TRUST_EXPLANATION);
      expect(within(group).getAllByRole<HTMLInputElement>('radio').map((radio) => [radio.parentElement?.textContent, radio.checked])).toEqual([['Trust', false], ['Don’t trust', false]]);
    }
    expect(TRUST_EXPLANATION).toBe('Trusting it lets the CLIs load the settings committed in it. Those settings can run commands, such as hooks and MCP servers, as soon as a session starts, before any prompt.');
  });

  it('keeps a root answered "Don’t trust", marked not trusted (C32)', async () => {
    show([]);
    openDialog();
    picks = [picked('D:\\a', 'a')];
    await addFolder();
    trust('D:\\a', 'Don’t trust');
    expect(screen.getByText('Not trusted')).toBeTruthy();
    await save();
    expect(saves()).toEqual([['projects:add', { name: 'a', color: 'red', roots: [{ path: 'D:\\a', trust: 'not-trusted' }], providers: ['claude', 'codex'] }]]);
  });

  it('saves, closes, and has the list bring the new project into view (C49)', async () => {
    show([]);
    openDialog();
    picks = [picked('D:\\Code\\fat-g', 'fat-g')];
    await addFolder();
    trust('D:\\Code\\fat-g', 'Trust');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
    await save();
    expect(saves()).toEqual([['projects:add', { name: 'fat-g', color: 'red', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['claude'] }]]);
    expect(useProjectDialog.getState()).toMatchObject({ open: false, added: 'aaaaaaaa-0000-4000-8000-000000000001' });
  });

  it('shows why a folder overlaps as soon as it is picked (C26)', async () => {
    show([]);
    openDialog();
    picks = [picked('D:\\Code', 'Code'), picked('D:\\Code\\fat-g', 'fat-g', { index: 0, relation: 'inside' }), picked('D:\\Code', 'Code', { index: 0, relation: 'same' })];
    await addFolder();
    await addFolder();
    await addFolder();
    expect(screen.getByText('Inside D:\\Code.')).toBeTruthy();
    expect(screen.getByText('Same folder as D:\\Code.')).toBeTruthy();
  });

  // M14b (C58): a folder that is an added account's, or lies inside or around one.
  it.each([
    ['same', 'This is the folder of the Codex account “Work”, where its CLI keeps that account’s login. Choose another folder.'],
    ['inside', 'This folder is inside the folder of the Codex account “Work”, where its CLI keeps that account’s login. Choose another folder.'],
    ['around', 'This folder contains the folder of the Codex account “Work”, where its CLI keeps that account’s login. Choose another folder.'],
  ])('says as soon as it is picked that a folder %s an account’s is refused, naming the account by its label', async (relation, text) => {
    const key = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
    usePrefs.setState({ snapshot: { ...prefsSnapshot(), instances: { codex: { firstLabel: null, added: [{ key, id: key, label: 'Work', folder: 'D:\\accounts\\work', enabled: true, issue: null }] } } } });
    show([]);
    openDialog();
    picks = [{ ...picked('D:\\accounts\\work', 'work'), account: { providerId: 'codex', key, relation } }];
    await addFolder();
    expect(screen.getByText(text)).toBeTruthy();
    // The label and the provider's name, never the account's folder.
    expect(screen.queryByText(/D:\\accounts\\work.*account/)).toBeNull();
  });

  it('names an account it has no label for by its provider alone', async () => {
    show([]);
    openDialog();
    picks = [{ ...picked('D:\\accounts\\work', 'work'), account: { providerId: 'codex', key: '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19', relation: 'same' } }];
    await addFolder();
    expect(screen.getByText(/This is the folder of a Codex account,/)).toBeTruthy();
  });

  it('says why when the picker is refused', async () => {
    show([]);
    openDialog();
    picks = [{ status: 'refused', reason: 'busy' }];
    await addFolder();
    expect(screen.getByText('A folder picker is already open.')).toBeTruthy();
  });
});

describe('Save refused (C39)', () => {
  it.each([
    ['an empty name', async () => {
      picks = [picked('E:\\', null)];
      await addFolder();
      trust('E:\\', 'Trust');
    }, 'Enter a name.', 'Name'],
    ['no root', async () => {
      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'x' } });
    }, 'Add at least one folder.', 'Add folder…'],
    ['a root with no answer', async () => {
      picks = [picked('D:\\a', 'a')];
      await addFolder();
    }, 'Answer whether to trust this folder.', 'Trust'],
    ['no provider', async () => {
      picks = [picked('D:\\a', 'a')];
      await addFolder();
      trust('D:\\a', 'Trust');
      fireEvent.click(screen.getByRole('checkbox', { name: 'Claude' }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'Codex' }));
    }, 'Choose at least one provider.', 'Claude'],
    ['an overlapping root', async () => {
      picks = [picked('D:\\a', 'a'), picked('D:\\a\\b', 'b', { index: 0, relation: 'inside' })];
      await addFolder();
      await addFolder();
      trust('D:\\a', 'Trust');
      trust('D:\\a\\b', 'Trust');
    }, 'Inside D:\\a.', 'Trust'],
  ])('with %s: nothing is sent, the reason shows beside the field, and the focus goes to it', async (_name, prepare, reason, focused) => {
    show([]);
    openDialog();
    await prepare();
    await save();
    expect(saves()).toEqual([]);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    if (focused === 'Name') expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Name' }));
    else expect(document.activeElement?.closest('label, button')?.textContent).toContain(focused);
  });

  it.each([
    [{ status: 'refused', reason: 'root-overlap', first: 0, second: 1, relation: 'around' }, 'Contains D:\\a.'],
    [{ status: 'refused', reason: 'root-not-allowed', index: 1 }, 'fat-g cannot use this folder here. Remove it and add it again.'],
    [{ status: 'refused', reason: 'unknown-project' }, 'This project is no longer in the list, so nothing was saved.'],
    ['fail', 'fat-g could not save the change, and nothing was changed.'],
  ])('shows what main refused: %j', async (answer, text) => {
    show([]);
    openDialog();
    picks = [picked('D:\\a', 'a'), picked('D:\\b', 'b')];
    await addFolder();
    await addFolder();
    trust('D:\\a', 'Trust');
    trust('D:\\b', 'Trust');
    saveAnswer = answer;
    await save();
    expect(screen.getByText(text)).toBeTruthy();
    expect(dialog().hasAttribute('open')).toBe(true);
  });
});

describe('editing (V10, V27)', () => {
  const edited = project('fat-g', {
    color: null,
    roots: [
      { path: 'D:\\Code\\fat-g', trust: 'trusted', missing: false },
      { path: 'E:\\share', trust: null, missing: true },
    ],
    providers: ['codex'],
  });

  it('opens on the saved project and asks main to check its folders (C29)', () => {
    show([edited]);
    openDialog(edited.id);
    expect(screen.getByRole('heading', { name: 'Edit fat-g' })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('fat-g');
    expect(requests).toEqual([['projects:checkRoots', { id: edited.id }]]);
    expect(screen.getByText('Folder not found')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Codex' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Claude' }).checked).toBe(false);
  });

  it('selects no colour for one this build does not know, and leaves it on Save (C12)', async () => {
    show([edited]);
    openDialog(edited.id);
    expect(screen.queryByRole('group', { name: 'Colour' })).toBeNull();
    trust('E:\\share', 'Trust');
    saveAnswer = { status: 'saved' };
    await save();
    expect(saves()).toEqual([['projects:update', { id: edited.id, name: 'fat-g', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }, { path: 'E:\\share', trust: 'trusted' }], providers: ['codex'] }]]);
  });

  it('asks again about a root with no answer, or one this build does not know (V27, C83)', async () => {
    show([edited]);
    openDialog(edited.id);
    const group = screen.getByRole('group', { name: 'Trust this folder? E:\\share' });
    expect(within(group).getAllByRole<HTMLInputElement>('radio').map((radio) => radio.checked)).toEqual([false, false]);
    await save();
    expect(saves()).toEqual([]);
    expect(screen.getByText('Answer whether to trust this folder.')).toBeTruthy();
  });
});

describe('leaving without saving (C38)', () => {
  it.each([
    ['Cancel', () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); }],
    ['the close button', () => { fireEvent.click(screen.getByRole('button', { name: 'Close without saving' })); }],
    // Escape closes a modal dialog natively; the stand-in closes it the same way.
    ['Escape', () => { dialog().close(); }],
  ])('drops the draft on %s and sends nothing', async (_name, leave) => {
    show([]);
    openDialog();
    picks = [picked('D:\\a', 'a')];
    await addFolder();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'draft' } });
    act(leave);
    expect(useProjectDialog.getState().open).toBe(false);
    expect(saves()).toEqual([]);
    act(() => openProjectDialog(null));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('');
    expect(screen.queryByText('D:\\a')).toBeNull();
  });

  it('hands the focus back to whatever opened it (C37)', () => {
    show([]);
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

// M22, V15, V25 (docs/planning/_archive/M22.md, Design 10; C40, C43, C87): a project's default mode, per provider.
describe('a project’s default modes (M22: V15, V25; C40, C87)', () => {
  /** Claude declares modes; Codex, here, declares none. */
  const showWith = (projects: readonly ProjectEntryView[]) =>
    useAppState.setState({ snapshot: { ...sampleSnapshot(1, [modedProvider(), sampleProvider({ id: 'codex', displayName: 'Codex' })]), records: recordsState(projects) }, error: null });
  const choice = (provider: string) => screen.queryByRole('group', { name: `${provider}: default mode for this project` });
  const radios = (provider: string) => within(choice(provider) as HTMLElement).getAllByRole<HTMLInputElement>('radio');
  const checked = (provider: string) => radios(provider).filter((each) => each.checked).map((each) => each.value);
  const B = project('notes', { providers: ['claude', 'codex'], permissionModes: { claude: 'edits-ok' } });

  it('offers, under each provider the project lists that declares modes, Use my default and that provider’s own list, with the one line under it', () => {
    showWith([]);
    openDialog();
    expect(within(screen.getByRole('group', { name: 'Providers' })).getByRole('group', { name: 'Claude: default mode for this project' })).toBeTruthy();
    expect(radios('Claude').map((each) => (each.closest('label') as HTMLElement).textContent)).toEqual(['Use my default', ...MODES.modes.map((mode) => `${mode.label} ${mode.description}`)]);
    expect((choice('Claude') as HTMLElement).querySelector('[data-mode-inherited]')?.textContent).toBe(MODES.inherited);
    // A new project has none: the user's own default stands.
    expect(checked('Claude')).toEqual(['']);
    // A provider that declares no mode has no choice, and nothing is said of an account (C43).
    expect(choice('Codex')).toBeNull();
    expect((choice('Claude') as HTMLElement).textContent).not.toMatch(/Set up|sandbox is|not been shown/);
  });

  it('saves the mode chosen with a new project, and sends nothing before Save (C40)', async () => {
    showWith([]);
    openDialog();
    picks = [picked('D:\\Code\\notes', 'notes')];
    await addFolder();
    trust('D:\\Code\\notes', 'Trust');
    fireEvent.click(radios('Claude')[3] as HTMLElement);
    expect(checked('Claude')).toEqual(['edits-ok']);
    expect(saves()).toEqual([]);
    await save();
    expect(saves()).toEqual([['projects:add', { name: 'notes', color: 'red', roots: [{ path: 'D:\\Code\\notes', trust: 'trusted' }], providers: ['claude', 'codex'], permissionModes: { claude: 'edits-ok' } }]]);
  });

  it('opens on a project’s saved default, and saves Use my default as the provider left out (C40)', async () => {
    showWith([B]);
    openDialog(B.id);
    expect(checked('Claude')).toEqual(['edits-ok']);
    fireEvent.click(radios('Claude')[0] as HTMLElement);
    expect(checked('Claude')).toEqual(['']);
    saveAnswer = { status: 'saved' };
    await save();
    expect(saves().map(([, request]) => (request as { permissionModes?: unknown }).permissionModes)).toEqual([{}]);
  });

  it('keeps a default for the providers the project is offered to alone, and one its provider lists', async () => {
    showWith([project('notes', { providers: ['claude', 'codex'], permissionModes: { claude: 'a-retired-mode', codex: 'careful' } })]);
    openDialog(uuidOf('notes'));
    // A stored id the provider no longer lists reads as Use my default, and is not sent back.
    expect(checked('Claude')).toEqual(['']);
    saveAnswer = { status: 'saved' };
    await save();
    expect(saves().map(([, request]) => (request as { permissionModes?: unknown }).permissionModes)).toEqual([{}]);
    cleanup();
    requests = [];
    showWith([B]);
    openDialog(B.id);
    // No longer offered to the provider: its choice goes, and so does its default.
    fireEvent.click(within(screen.getByRole('group', { name: 'Providers' })).getByRole('checkbox', { name: 'Claude' }));
    expect(choice('Claude')).toBeNull();
    await save();
    expect(saves().map(([, request]) => request)).toMatchObject([{ providers: ['codex'], permissionModes: {} }]);
  });

  it('says nothing of defaults where no provider declares a mode: what is stored stays as it is', async () => {
    show([A]);
    openDialog(A.id);
    expect(screen.queryByRole('group', { name: /default mode/ })).toBeNull();
    saveAnswer = { status: 'saved' };
    await save();
    expect(saves()).toHaveLength(1);
    expect(saves()[0]?.[1]).not.toHaveProperty('permissionModes');
  });
});


describe('Open folder beside Remove', () => {
  it('opens the selected saved root, without saving draft changes or changing trust', async () => {
    const root = { path: 'D:/Code', trust: 'not-trusted' as const, missing: false };
    const work = project('Work', { roots: [root] });
    show([work]);
    openDialog(work.id);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Unsaved name' } });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Open folder D:/Code' });
    expect(button.nextElementSibling?.textContent?.trim()).toBe('Remove');
    await act(async () => { fireEvent.click(button); await flush(); });
    expect(requests.filter(([channel]) => channel === 'projects:openFolder')).toEqual([['projects:openFolder', { projectId: work.id, path: 'D:/Code' }]]);
    expect(saves()).toEqual([]);
    expect(dialog().open).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('Unsaved name');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Don\u2019t trust' }).checked).toBe(true);
  });

  it('opens a newly picked folder before saving, and lets the user retry a failed open', async () => {
    show([]);
    openDialog();
    picks = [picked('D:/Code', 'Code')];
    await addFolder();
    saveAnswer = 'fail';
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Open folder D:/Code' });
    await act(async () => { fireEvent.click(button); await flush(); });
    expect(screen.getByRole('status').textContent).toBe('fat-g could not open this folder.');
    expect(button.disabled).toBe(false);
    expect(saves()).toEqual([]);
    saveAnswer = null;
    await act(async () => { fireEvent.click(button); await flush(); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(requests.filter(([channel]) => channel === 'projects:openFolder')).toEqual([
      ['projects:openFolder', { projectId: null, path: 'D:/Code' }],
      ['projects:openFolder', { projectId: null, path: 'D:/Code' }],
    ]);
  });
});
