// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V32 (docs/planning/_archive/M22.md, Design 10; C9, C13, C14, C36, C48, C56, C57, C92): an approval's
// card, by itself — who asks and for what, the action's parts, the detail drawn only once opened,
// the choices its request lists and what each sends, and every settled state in words. On a fake
// bridge that answers the two channels as main does; the card in a list, with its announcement and
// the mode's line, is MessageList.test.tsx, and a worker's is WorkerBody.test.tsx.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDecideResult, ChatStopResult } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type ApprovalBody, type ApprovalRequest, APPROVAL_OUTCOMES, APPROVAL_WORDS, MAX_APPROVAL_CHANGE_UNITS, MAX_APPROVAL_DETAIL, OUTCOME_WORDS } from '@shared/contracts/interaction';
import type { InvokeChannel } from '@shared/ipc/channels';
import { type Opener, OpenerContext } from '../markdown/inert';
import { approvalWith, chatApproval, chatTurn } from '../test/chat';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { MODES } from '../test/permissions';
import { ApprovalCard } from './ApprovalCard';
import { APPROVAL_LABELS, DECIDE_FAILED_TEXT, STOP_FAILED_TEXT } from './approval-words';
import { CardContext, type CardScope } from './InteractionCard';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const SCOPE: CardScope = { sessionId: SESSION, providerName: 'Claude', asker: null, running: true, workerRunning: null, account: null, permissions: MODES };

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answers: { decide: ChatDecideResult | Error; stop: ChatStopResult | Error };
/** What the list's opener was handed, in order. */
let opened: [string, string, number | undefined][];
const OPENER: Opener = { platform: 'win32', open: (address, kind, line) => { opened.push([address, kind, line]); return Promise.resolve(null); }, show: () => Promise.resolve(null), copyPath: () => Promise.resolve(null) };

beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  opened = [];
  answers = { decide: { status: 'decided' }, stop: { status: 'stopping' } };
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    const answer = channel === 'chat:decide' ? answers.decide : answers.stop;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ ok: true, value: answer });
  });
});
afterEach(cleanup);

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
type Body = Parameters<typeof chatApproval>[2];
const card = (body: Body = {}, overrides: Partial<ConversationItem> = {}): ConversationItem => chatApproval(SESSION, 't1', body, overrides);
interface Shown { readonly scope?: CardScope | null; readonly current?: boolean; readonly carrier?: ReturnType<typeof chatTurn>; readonly opener?: Opener | null }
function drawn(item: ConversationItem, options: Shown = {}) {
  const element = <ApprovalCard item={item} providerName="Claude" current={options.current ?? true} {...(options.carrier === undefined ? {} : { carrier: options.carrier })} />;
  const scoped = options.scope === null ? element : <CardContext value={options.scope ?? SCOPE}>{element}</CardContext>;
  return <OpenerContext value={options.opener ?? null}>{scoped}</OpenerContext>;
}
const show = (item: ConversationItem, options: Shown = {}) => render(drawn(item, options));
const article = (): HTMLElement => screen.getByRole('article');
const buttons = (): string[] => [...article().querySelectorAll('button')].map((button) => button.textContent ?? '');
const choice = (name: string): HTMLButtonElement => within(article()).getByRole('button', { name });
const disclosure = (): HTMLButtonElement => article().querySelector('[data-approval-detail]') as HTMLButtonElement;
const sent = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
const outcome = (): string | null => article().querySelector('[data-card-outcome]')?.textContent ?? null;
const problem = (): string | null => article().querySelector('p[role="status"]')?.textContent ?? null;
const blocks = (): [string | null, string][] => [...article().querySelectorAll('pre')].map((pre) => [pre.getAttribute('aria-label'), pre.textContent ?? '']);

describe('a card that waits (V9; C13, C14, C36, C56)', () => {
  it('says who asks and for what, in its head and as its name, with the one line that names the action', () => {
    show(card());
    expect(article().getAttribute('aria-label')).toBe('Claude asks to run a command');
    expect(article()).toMatchObject({ dataset: { interaction: '', kind: 'approval', approval: 'command', outcome: 'pending' } });
    expect(article().querySelector('[data-approval-summary]')?.textContent).toBe('touch notes.txt');
    // No form anywhere: nothing submits by itself, and every control is a plain button.
    expect(article().querySelector('form')).toBeNull();
    expect([...article().querySelectorAll('button')].every((button) => button.type === 'button')).toBe(true);
  });

  it.each([['command', 'Claude asks to run a command'], ['file-change', 'Claude asks to change a file'], ['tool', 'Claude asks to use a tool']] as const)('names a %s request by what it asks leave for', (kind, head) => {
    show(card({ request: { kind } }));
    expect(article().getAttribute('aria-label')).toBe(head);
    expect(article().dataset['approval']).toBe(kind);
  });

  it('says the account it belongs to where its provider runs more than one, and the sub-agent in a worker’s tab (C14)', () => {
    show(card(), { scope: { ...SCOPE, account: 'Work', asker: 'Sub-agent Explore' } });
    expect(article().getAttribute('aria-label')).toBe('Sub-agent Explore asks to run a command');
    expect(article().querySelector('[data-approval-account]')?.textContent).toBe('Account: Work');
    cleanup();
    show(card());
    expect(article().querySelector('[data-approval-account]')).toBeNull();
  });

  it('holds the choices its request lists and Stop, none of them active at arrival, and takes no focus (C13, C36, C56)', () => {
    const before = document.activeElement;
    show(card());
    expect(buttons()).toEqual([APPROVAL_WORDS.detail, APPROVAL_WORDS.approve, APPROVAL_WORDS.deny, APPROVAL_WORDS.stop]);
    expect(document.activeElement).toBe(before);
    // No choice is the one to press: none is marked, and none asks for the focus.
    expect(article().querySelectorAll('[data-primary], [autofocus]')).toHaveLength(0);
    expect(requests).toEqual([]);
  });

  it('offers the session grant only where the request is eligible, in the grant’s own words, and never as the active choice (C56)', () => {
    show(card({ request: { choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' } } }));
    expect(buttons()).toEqual([APPROVAL_WORDS.detail, APPROVAL_WORDS.approve, 'Approve for this session: Bash(touch notes.txt)', APPROVAL_WORDS.deny, APPROVAL_WORDS.stop]);
    expect(article().querySelectorAll('[data-primary], [autofocus]')).toHaveLength(0);
    cleanup();
    // A file's grant names the file.
    show(card({ request: { kind: 'file-change', choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'notes.txt' } } }));
    expect(choice('Approve for this session: notes.txt')).toBeTruthy();
    cleanup();
    // A choice the view does not list is not drawn: the page invents none (C88).
    show(card({ request: { choices: ['approve'] } }));
    expect(buttons()).toEqual([APPROVAL_WORDS.detail, APPROVAL_WORDS.approve, APPROVAL_WORDS.stop]);
  });

  it.each([['approve', APPROVAL_WORDS.approve], ['approve-session', 'Approve for this session: Bash(touch notes.txt)'], ['deny', APPROVAL_WORDS.deny]] as const)('sends %s by the card’s item, and nothing before the press (C13, C88)', async (name, words) => {
    const item = card({ request: { choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' } } });
    show(item);
    await settle();
    expect(requests).toEqual([]);
    fireEvent.click(choice(words));
    await settle();
    // The session, the item and the choice: no request id, no tool's input and no rule.
    expect(requests).toEqual([['chat:decide', { sessionId: SESSION, itemId: item.id, choice: name }]]);
    // Nothing redraws by itself: the item's push brings the card's state.
    expect(article().dataset['outcome']).toBe('pending');
  });

  it('stops the session from Stop, which is the session’s own and no choice of the request (C13)', async () => {
    show(card());
    fireEvent.click(choice(APPROVAL_WORDS.stop));
    await settle();
    expect(requests).toEqual([['chat:stop', { sessionId: SESSION }]]);
    expect(problem()).toBeNull();
    // A session that no longer runs has nothing to stop, and nothing is said of it.
    answers.stop = { status: 'refused', reason: 'not-running' };
    fireEvent.click(choice(APPROVAL_WORDS.stop));
    await settle();
    expect(problem()).toBeNull();
    answers.stop = new Error('gone');
    fireEvent.click(choice(APPROVAL_WORDS.stop));
    await settle();
    expect(problem()).toBe(STOP_FAILED_TEXT);
  });

  it('says a refusal under its actions, and nothing for a stale press', async () => {
    show(card());
    answers.decide = { status: 'refused', reason: 'storage-failed' };
    fireEvent.click(choice(APPROVAL_WORDS.approve));
    await settle();
    expect(problem()).toMatch(/could not save your decision, so nothing was sent/);
    // The card still waits, with its choices.
    expect(choice(APPROVAL_WORDS.deny).disabled).toBe(false);
    // Decided, withdrawn or dropped meanwhile: the push says so, and the press says nothing (M21, C71).
    answers.decide = { status: 'refused', reason: 'not-pending' };
    fireEvent.click(choice(APPROVAL_WORDS.deny));
    await settle();
    expect(problem()).toBeNull();
    answers.decide = { status: 'refused', reason: 'changing-mode' };
    fireEvent.click(choice(APPROVAL_WORDS.deny));
    await settle();
    expect(problem()).toMatch(/mode is being changed/);
    answers.decide = { status: 'refused', reason: 'setting-up' };
    fireEvent.click(choice(APPROVAL_WORDS.deny));
    await settle();
    expect(problem()).toMatch(/Claude’s sandbox is being set up/);
    answers.decide = new Error('gone');
    fireEvent.click(choice(APPROVAL_WORDS.deny));
    await settle();
    expect(problem()).toBe(DECIDE_FAILED_TEXT);
  });

  it('makes its controls stops only while it is the list’s current entry', () => {
    const item = card({ request: { targets: ['notes.txt'] } });
    const { rerender } = show(item, { current: false, opener: OPENER });
    expect([...article().querySelectorAll('button')].map((button) => button.tabIndex)).toEqual([-1, -1, -1, -1, -1]);
    rerender(drawn(item, { current: true, opener: OPENER }));
    expect([...article().querySelectorAll('button')].map((button) => button.tabIndex)).toEqual([0, 0, 0, 0, 0]);
  });

  it('keeps the focus on the pressed choice while its decision is on its way: said unavailable, never disabled, and pressed once', async () => {
    show(card());
    const approve = choice(APPROVAL_WORDS.approve);
    approve.focus();
    fireEvent.click(approve);
    // A disabled button cannot hold the focus: the page's body would take it before the card settles.
    expect([approve.disabled, approve.getAttribute('aria-disabled')]).toEqual([false, 'true']);
    expect([choice(APPROVAL_WORDS.deny).disabled, choice(APPROVAL_WORDS.deny).getAttribute('aria-disabled')]).toEqual([false, 'true']);
    expect(document.activeElement).toBe(approve);
    // A second press while the first is on its way sends nothing.
    fireEvent.click(choice(APPROVAL_WORDS.deny));
    await settle();
    expect(sent('chat:decide')).toHaveLength(1);
    expect(choice(APPROVAL_WORDS.approve).hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(approve);
  });

  it('hands the focus to its list when it settles under a press, and never to the page', async () => {
    const item = card();
    const list = (entry: ConversationItem) => <div tabIndex={0} data-list="">{drawn(entry)}</div>;
    const { rerender } = render(list(item));
    choice(APPROVAL_WORDS.approve).focus();
    fireEvent.click(choice(APPROVAL_WORDS.approve));
    await settle();
    rerender(list(approvalWith(item, { outcome: 'approved', decidedAt: 5, delivered: true })));
    expect(document.activeElement).toBe(document.querySelector('[data-list]'));
  });
});

describe('what a card shows of the action (V9; C8, C9, C14, C56)', () => {
  it('lists the paths the action names, each opened through the session’s opener, and says where the CLI said one is outside the project’s folders', async () => {
    show(card({ request: { kind: 'file-change', tool: 'Write', summary: 'notes.txt', targets: ['notes.txt', 'D:\\Elsewhere\\other.txt'], outside: true } }), { opener: OPENER });
    const paths = within(article()).getByRole('list', { name: APPROVAL_LABELS.targets });
    expect(within(paths).getAllByRole('listitem').map((row) => row.querySelector('button')?.textContent)).toEqual(['notes.txt', 'D:\\Elsewhere\\other.txt']);
    expect(article().querySelector('[data-approval-outside]')?.textContent).toBe('Reaches outside the project’s folders');
    // A press hands the path to the opener, which main answers for a file outside as it does any other.
    fireEvent.click(within(paths).getByRole('button', { name: 'D:\\Elsewhere\\other.txt' }));
    await settle();
    expect(opened).toEqual([['D:\\Elsewhere\\other.txt', 'local', undefined]]);
    // The card itself asked main for nothing.
    expect(requests).toEqual([]);
  });

  it('draws a path as text where the list has no opener, and no line about the folders where the CLI said nothing', () => {
    show(card({ request: { targets: ['notes.txt'] } }));
    const paths = within(article()).getByRole('list', { name: APPROVAL_LABELS.targets });
    expect(paths.textContent).toBe('notes.txt');
    expect(paths.querySelector('button')).toBeNull();
    expect(article().querySelector('[data-approval-outside]')).toBeNull();
  });

  it('names the working folder a request gives, and none where it gives none', () => {
    show(card({ request: { folder: 'D:\\Code\\Calamari' } }));
    expect(article().querySelector('[data-approval-folder]')?.textContent).toBe('In folder: D:\\Code\\Calamari');
    cleanup();
    show(card());
    expect(article().querySelector('[data-approval-folder]')).toBeNull();
  });

  it('labels the reason as the model’s, and draws it as text whatever it holds (C8)', () => {
    show(card({ request: { reason: 'I need **notes.txt** <b>now</b> [x](https://example.com)' } }));
    const reason = article().querySelector('[data-approval-reason]') as HTMLElement;
    expect([...reason.querySelectorAll('p')].map((line) => line.textContent)).toEqual([APPROVAL_WORDS.reason, 'I need **notes.txt** <b>now</b> [x](https://example.com)']);
    // Text, and nothing made from it: no element, no link, no control.
    expect(reason.querySelectorAll('b, strong, a, button')).toHaveLength(0);
    cleanup();
    show(card());
    expect(article().querySelector('[data-approval-reason]')).toBeNull();
  });

  it('says what the CLI’s own offers would grant beyond this action, a mode by its provider’s label (C8, C56)', () => {
    show(card({ request: { authority: [{ kind: 'folder', mode: null }, { kind: 'mode', mode: 'edits-ok' }, { kind: 'mode', mode: 'a-later-mode' }, { kind: 'saved-rule', mode: null }, { kind: 'network', mode: null }, { kind: 'other', mode: null }] } }));
    expect(article().querySelector('[data-approval-authority]')?.textContent).toBe('The CLI would also grant: a folder, a mode: Edits ok, a change of mode, a rule saved beyond this session, network access, more than this action');
    // Said, and never offered: the card has no choice for any of them.
    expect(buttons()).toEqual([APPROVAL_WORDS.detail, APPROVAL_WORDS.approve, APPROVAL_WORDS.deny, APPROVAL_WORDS.stop]);
    cleanup();
    show(card());
    expect(article().querySelector('[data-approval-authority]')).toBeNull();
  });

  it('names a suggested mode once: where it is the mode that would stop the question, it is not said again among what the CLI would also grant (C56)', () => {
    show(card({ request: { modeThatWouldStop: 'edits-ok', authority: [{ kind: 'mode', mode: 'edits-ok' }] } }));
    expect(article().querySelector('[data-approval-would-stop]')?.textContent).toBe('Edits ok would stop this question');
    expect(article().querySelector('[data-approval-authority]')).toBeNull();
    cleanup();
    // What else it would grant is still said, and another mode with it.
    show(card({ request: { modeThatWouldStop: 'edits-ok', authority: [{ kind: 'mode', mode: 'edits-ok' }, { kind: 'folder', mode: null }, { kind: 'mode', mode: 'a-later-mode' }] } }));
    expect(article().querySelector('[data-approval-authority]')?.textContent).toBe('The CLI would also grant: a folder, a change of mode');
  });

  it('names the mode that would stop the question where a mode is the CLI’s only offer, and changes none (C56)', async () => {
    show(card({ request: { modeThatWouldStop: 'edits-ok' } }));
    expect(article().querySelector('[data-approval-would-stop]')?.textContent).toBe('Edits ok would stop this question');
    // A line, and no control: the mode is changed from the session's header alone.
    expect(buttons()).toEqual([APPROVAL_WORDS.detail, APPROVAL_WORDS.approve, APPROVAL_WORDS.deny, APPROVAL_WORDS.stop]);
    await settle();
    expect(sent('chat:setMode')).toEqual([]);
    cleanup();
    // A list that knows no label for it names none.
    show(card({ request: { modeThatWouldStop: 'edits-ok' } }), { scope: { ...SCOPE, permissions: null } });
    expect(article().querySelector('[data-approval-would-stop]')).toBeNull();
  });
});

describe('the whole action, behind its disclosure (V9; C9, C48)', () => {
  it('draws nothing of the detail until it is opened, then a command whole up to its bound, with a Copy button of its own', () => {
    const command = `echo ${'x'.repeat(MAX_APPROVAL_DETAIL - 9)} END`;
    expect(command).toHaveLength(MAX_APPROVAL_DETAIL);
    show(card({ request: { summary: 'echo', detail: { kind: 'command', command } } }));
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
    expect(disclosure().getAttribute('aria-label')).toBe(APPROVAL_LABELS.show);
    expect(article().querySelector('pre')).toBeNull();
    expect(article().textContent).not.toContain('END');
    fireEvent.click(disclosure());
    expect(disclosure().getAttribute('aria-expanded')).toBe('true');
    expect(disclosure().getAttribute('aria-label')).toBe(APPROVAL_LABELS.hide);
    // Whole: every unit of it, and no line that says it was shortened.
    expect(blocks()).toEqual([[APPROVAL_LABELS.command, command]]);
    expect(article().querySelector('[data-item-line="cut"]')).toBeNull();
    expect(within(article()).getByRole('button', { name: APPROVAL_LABELS.copyCommand })).toBeTruthy();
    fireEvent.click(disclosure());
    expect(article().querySelector('pre')).toBeNull();
  });

  it('draws each file of a change with its path and its kind, a file change whole up to a million units', () => {
    const content = `${'y'.repeat(MAX_APPROVAL_CHANGE_UNITS - 3)}END`;
    const detail: ApprovalRequest['detail'] = { kind: 'changes', changes: [
      { path: 'notes.txt', kind: 'write', text: content, replace: null, all: null },
      { path: 'src/new.ts', kind: 'add', text: 'export {};\n', replace: null, all: null },
      { path: 'src/old.ts', kind: 'delete', text: null, replace: null, all: null },
    ] };
    show(card({ request: { kind: 'file-change', tool: 'fileChange', summary: 'notes.txt', detail } }));
    expect(article().textContent).not.toContain('END');
    fireEvent.click(disclosure());
    expect(blocks().map(([title, text]) => [title, text.length])).toEqual([['notes.txt — written', MAX_APPROVAL_CHANGE_UNITS], ['src/new.ts — added', 11]]);
    expect(blocks()[0]?.[1].endsWith('END')).toBe(true);
    // A change that carries no text is said in a line, and never filled from the file.
    expect(article().textContent).toContain(`src/old.ts — deleted. ${APPROVAL_LABELS.noText}`);
    expect(within(article()).getAllByRole('button', { name: APPROVAL_LABELS.copyChange })).toHaveLength(2);
  });

  it('draws an edit by match as the text it replaces and then the text it puts, and tells two edits of opposite scope apart before the detail is opened (C9)', () => {
    const edit = (all: boolean): ConversationItem => card({ request: { kind: 'file-change', tool: 'Edit', summary: 'notes.txt', detail: { kind: 'changes', changes: [{ path: 'notes.txt', kind: 'update', text: 'new words', replace: 'old words', all }] } } });
    show(edit(true));
    const every = article().textContent;
    expect(article().querySelector('[data-approval-scope]')).toMatchObject({ textContent: 'Replaces every matching passage', dataset: { approvalScope: 'every' } });
    fireEvent.click(disclosure());
    expect(blocks()).toEqual([['notes.txt — changed: replaces every matching passage', 'old words'], ['notes.txt — changed: with', 'new words']]);
    cleanup();
    show(edit(false));
    // Closed, the two cards already read differently.
    expect(article().textContent).not.toBe(every);
    expect(article().querySelector('[data-approval-scope]')).toMatchObject({ textContent: 'Replaces the first match', dataset: { approvalScope: 'first' } });
    fireEvent.click(disclosure());
    expect(blocks()).toEqual([['notes.txt — changed: replaces the first match', 'old words'], ['notes.txt — changed: with', 'new words']]);
  });

  it('names the file of each edit’s scope where a change holds several, and says no scope for a change that is no edit by match', () => {
    show(card({ request: { kind: 'file-change', detail: { kind: 'changes', changes: [
      { path: 'src/a.ts', kind: 'update', text: 'b', replace: 'a', all: true },
      { path: 'src/b.ts', kind: 'update', text: '@@ a diff', replace: null, all: null },
      { path: 'D:\\Code\\c.ts', kind: 'update', text: 'd', replace: 'c', all: false },
    ] } } }));
    expect([...article().querySelectorAll('[data-approval-scope]')].map((line) => line.textContent)).toEqual(['a.ts: Replaces every matching passage', 'c.ts: Replaces the first match']);
  });

  it('draws a tool’s input as the text it is', () => {
    const text = '{\n  "query": "<img src=x onerror=alert(1)>"\n}';
    show(card({ request: { kind: 'tool', tool: 'mcp__notes__search', summary: 'mcp__notes__search', detail: { kind: 'input', text } } }));
    fireEvent.click(disclosure());
    expect(blocks()).toEqual([[APPROVAL_LABELS.input, text]]);
    expect(article().querySelector('img')).toBeNull();
    expect(within(article()).getByRole('button', { name: APPROVAL_LABELS.copyInput })).toBeTruthy();
  });

  it('reads no file and asks main for nothing to fill a detail (C9)', async () => {
    show(card({ request: { kind: 'file-change', targets: ['notes.txt'], detail: { kind: 'changes', changes: [{ path: 'notes.txt', kind: 'update', text: null, replace: null, all: null }] } } }), { opener: OPENER });
    fireEvent.click(disclosure());
    await settle();
    expect(requests).toEqual([]);
    expect(opened).toEqual([]);
  });
});

describe('a settled card (V9, V32; C12, C48, C57, C92)', () => {
  const decided = (patch: Partial<Omit<ApprovalBody, 'request' | 'kind'>> = {}, request: Partial<ApprovalRequest> = {}, overrides: Partial<ConversationItem> = {}) => card({ decidedAt: 5, delivered: true, confirmedAt: 6, request, ...patch }, overrides);
  const GRANTED = { choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' } } satisfies Partial<ApprovalRequest>;

  it.each<[ApprovalBody['outcome'], Partial<Omit<ApprovalBody, 'request' | 'kind'>>, string]>([
    ['approved', {}, 'Approved once'],
    ['denied', {}, 'Denied'],
    ['withdrawn', { withdrawnBy: 'request', decidedAt: null, delivered: null, confirmedAt: null }, OUTCOME_WORDS.withdrawnByRequest],
    ['withdrawn', { withdrawnBy: 'turn', decidedAt: null, delivered: null, confirmedAt: null }, OUTCOME_WORDS.withdrawnByTurn],
    ['withdrawn', { withdrawnBy: 'changed', decidedAt: null, delivered: null, confirmedAt: null }, 'Withdrawn: the request changed under its id and was refused'],
    ['dropped', { decidedAt: null, delivered: null, confirmedAt: null }, OUTCOME_WORDS.dropped],
  ])('%s: its outcome in words, in the past, and no choice at all', (name, patch, words) => {
    show(decided({ outcome: name, ...patch }));
    expect(outcome()).toBe(words);
    expect(article().dataset['outcome']).toBe(name);
    expect(article().getAttribute('aria-label')).toBe('Claude asked to run a command');
    // Inert: the disclosure alone is left, and the detail is still to be opened.
    expect(buttons()).toEqual([APPROVAL_WORDS.detail]);
    fireEvent.click(disclosure());
    expect(blocks()).toEqual([[APPROVAL_LABELS.command, 'touch notes.txt']]);
  });

  it('has words for every outcome a decision or an end can leave', () => {
    for (const name of APPROVAL_OUTCOMES.filter((each) => each !== 'pending')) {
      show(decided({ outcome: name, grant: name === 'approved-session' ? { covers: 'x', processKey: 'k', live: true } : null }));
      expect(outcome(), name).not.toBeNull();
      cleanup();
    }
    show(card());
    expect(outcome()).toBeNull();
  });

  it('says what a session grant covers, and that it ended once its process has (C57)', () => {
    show(decided({ outcome: 'approved-session', grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: true } }, GRANTED));
    expect(outcome()).toBe('Approved for this session: covers Bash(touch notes.txt)');
    expect(buttons()).toEqual([APPROVAL_WORDS.detail]);
    cleanup();
    show(decided({ outcome: 'approved-session', grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } }, GRANTED));
    expect(outcome()).toBe('Approved for this session: covers Bash(touch notes.txt); ended with the process');
  });

  it('says so in place of a send where the process did not take the decision, and claims no grant (V32; C92)', () => {
    show(decided({ outcome: 'approved-session', delivered: false, confirmedAt: null, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } }, GRANTED));
    expect(outcome()).toBe('Approved for this session; the process did not take it');
    expect(outcome()).not.toContain('covers');
    cleanup();
    show(decided({ outcome: 'approved', delivered: false, confirmedAt: null }));
    expect(outcome()).toBe('Approved; the process did not take it');
    cleanup();
    show(decided({ outcome: 'denied', delivered: false, confirmedAt: null }));
    expect(outcome()).toBe('Denied; the process did not take it');
  });

  it('reads a decision with no mark as taken while its turn runs, and as unconfirmed once the turn is over (M21, C68)', () => {
    const item = decided({ outcome: 'approved', confirmedAt: null });
    show(item, { carrier: chatTurn('t1', { state: 'running', outcome: null }) });
    expect(outcome()).toBe('Approved once');
    cleanup();
    // Where the list does not hold the turn, nothing is called unconfirmed.
    show(item);
    expect(outcome()).toBe('Approved once');
    cleanup();
    show(item, { carrier: chatTurn('t1') });
    expect(outcome()).toBe('Approved; the CLI did not confirm it');
    cleanup();
    show(decided({ outcome: 'denied', confirmedAt: null }), { carrier: chatTurn('t1') });
    expect(outcome()).toBe('Denied; the CLI did not confirm it');
    cleanup();
    // A grant whose delivery is not known, once what carries it is over (C92): on its card alone, and no grant is claimed.
    show(decided({ outcome: 'approved-session', delivered: null, confirmedAt: null, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } }, GRANTED), { carrier: chatTurn('t1') });
    expect(outcome()).toBe('Approved for this session; the CLI did not confirm it');
    cleanup();
    // Confirmed: said as it is, whatever became of the turn.
    show(decided({ outcome: 'approved' }), { carrier: chatTurn('t1') });
    expect(outcome()).toBe('Approved once');
  });

  it('asks a worker’s card’s worker, not its parent’s turn, whether what carries the decision is over (M21, C79)', () => {
    const item = decided({ outcome: 'approved', confirmedAt: null }, {}, { workerId: 'worker-1' });
    show(item, { scope: { ...SCOPE, asker: 'Sub-agent', workerRunning: true }, carrier: chatTurn('t1') });
    expect(outcome()).toBe('Approved once');
    cleanup();
    show(item, { scope: { ...SCOPE, asker: 'Sub-agent', workerRunning: false }, carrier: chatTurn('t1', { state: 'running', outcome: null }) });
    expect(outcome()).toBe('Approved; the CLI did not confirm it');
  });

  it('says that the detail was shortened on a card restored from the store, and never on a live one (C48)', () => {
    show(decided({ outcome: 'approved' }, { cut: true, detail: { kind: 'command', command: 'echo first-part' } }));
    expect(article().querySelector('[data-item-line="cut"]')).toBeNull();
    fireEvent.click(disclosure());
    expect(blocks()).toEqual([[APPROVAL_LABELS.command, 'echo first-part']]);
    expect(article().querySelector('[data-item-line="cut"]')?.textContent).toBe(APPROVAL_WORDS.cut);
    cleanup();
    show(decided({ outcome: 'approved' }));
    fireEvent.click(disclosure());
    expect(article().querySelector('[data-item-line="cut"]')).toBeNull();
  });

  it('draws a card of a list with no session inert, whatever it reads: its request as text, and no choice (C36)', async () => {
    show(card({ request: GRANTED }), { scope: null });
    expect(article().getAttribute('aria-label')).toBe('Claude asks to run a command');
    expect(buttons()).toEqual([APPROVAL_WORDS.detail]);
    await settle();
    expect(requests).toEqual([]);
  });
});
