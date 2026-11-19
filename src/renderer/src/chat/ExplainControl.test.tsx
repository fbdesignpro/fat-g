// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10 (docs/planning/_archive/M20b.md; C40, C41, C46–C48, C72, C74): the Explain this control beside each
// block of an assistant's message, the marker that stands in its place where the block has an
// aside, a prompt's and an activity's marker in their head rows, and a press on a painted passage —
// in the chat area as the app draws it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AsideMarker, type AsideSource, drawnDigest } from '@shared/contracts/aside';
import type { ChatAskRequest } from '@shared/contracts/chat';
import { ASIDE_KIND } from '../artifacts/opener';
import { type AsideStage, asideStage, CODEX_ASIDES, marker, session } from '../test/asides';
import { chatActivity, chatItem } from '../test/chat';
import { ActivityDetail } from './ActivityDetail';
import { paintedIn } from './aside-highlights';
import { setAsides } from './asides-store';
import { textNodes } from './drawn-text';
import { AsideSourceContext, EXPLAIN_WORDS } from './ExplainControl';
import { Message } from './Message';

const ONE = session('Create plan');
const ID = ONE.record.id;
const ANSWER = ['# Tides', '', 'The tide table lists **high** and low water.', 'It is read each morning.', '', '- one item', '- another item', '', 'A last paragraph.'].join('\n');

class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
}

let stage: AsideStage;
beforeEach(() => {
  stage = asideStage();
  Object.assign(globalThis, { CSS: { ...(globalThis as { CSS?: object }).CSS, highlights: new Map() }, Highlight: FakeHighlight });
});
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  cleanup();
  delete (globalThis as { Highlight?: unknown }).Highlight;
  delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
});

interface Given { readonly asking?: typeof CODEX_ASIDES | 'none'; readonly asides?: AsideMarker[] }
/** A chat with a prompt, an earlier answer, a notice and the answer under test, which is the newest and so the keyboard's current message. */
async function open({ asking = CODEX_ASIDES, asides = [] }: Given = {}) {
  const chat = stage.chat(ONE);
  chat.items = [
    chatItem(ID, 'user', 'What does the table list?', { id: 'prompt-1' }),
    chatItem(ID, 'assistant', 'An earlier answer.\n\nIn two paragraphs.', { id: 'answer-0' }),
    chatItem(ID, 'notice', 'The turn failed.', { id: 'notice-1', notice: 'turn-failed' }),
    chatItem(ID, 'assistant', ANSWER, { id: 'answer-1' }),
  ];
  chat.revision = 4;
  chat.asking = asking;
  chat.asides = asides;
  await stage.open([ONE]);
}
const article = (id: string) => document.querySelector(`[data-source-item="${id}"]`)?.closest('article') as HTMLElement;
const controls = (id: string) => [...article(id).querySelectorAll<HTMLButtonElement>('[data-explain]')];
const markers = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('[data-aside-marker]')];
const asks = () => stage.sent('chat:ask') as (ChatAskRequest & { source: AsideSource })[];
/** The names shown beside controls (ui/Tooltip.tsx, NameTip): in the page only while one shows. */
const nameTips = () => [...document.querySelectorAll('[data-name-tip]')].map((tip) => tip.textContent);
/** The block a control stands beside: the element after the one that holds it. */
const blockOf = (control: Element) => control.closest('[data-md-control]')?.nextElementSibling as HTMLElement;
/** A marker of an aside about the passage `words` of answer-1's paragraph, at its real place in the drawing. */
function passage(id: string, words: string, lines = { first: 3, last: 5 }): AsideMarker {
  const body = document.querySelector('[data-source-item="answer-1"]') as Element;
  const whole = textNodes(body).map((node) => node.data).join('');
  const start = whole.indexOf(words);
  return marker(id, words, { itemId: 'answer-1', lines, range: { start, end: start + words.length }, digest: drawnDigest(words) });
}

describe('the control beside a block (C46)', () => {
  it('hides standalone Explain buttons while keeping the text available to the selection menu', async () => {
    await open();
    expect(controls('answer-1')).toEqual([]);
    expect(controls('answer-0')).toEqual([]);
    expect(document.querySelectorAll('[data-md-control]')).toHaveLength(0);
    expect(article('answer-1').querySelector('[data-source-kind]')).not.toBeNull();
    expect(asks()).toEqual([]);
  });

  it('is on no prompt, no notice and no activity’s detail', async () => {
    await open();
    expect(article('prompt-1').querySelectorAll('[data-explain]')).toHaveLength(0);
    const notice = [...document.querySelectorAll('article')].find((entry) => entry.getAttribute('data-role') === 'notice') as HTMLElement;
    expect(notice.querySelectorAll('[data-explain], [data-aside-marker], [data-source-kind]')).toHaveLength(0);
    cleanup();
    const item = chatActivity(ID, 't1', { type: 'command', name: 'commandExecution', summary: 'rg', input: 'rg --files', output: 'README.md\nsample.txt' }, { id: 'activity-1' });
    const view = render(<AsideSourceContext value={{ sessionId: ID, workerId: null }}><ActivityDetail item={item} body={item.activity as NonNullable<typeof item.activity>} /></AsideSourceContext>);
    expect(view.container.querySelectorAll('[data-explain]')).toHaveLength(0);
    // Its two texts are sources all the same: the menu's Explain this is theirs (C47).
    expect([...view.container.querySelectorAll('[data-source-kind]')].map((element) => [element.tagName, element.getAttribute('data-source-item'), element.getAttribute('data-source-part')])).toEqual([['PRE', 'activity-1', 'input'], ['PRE', 'activity-1', 'output']]);
  });

});

describe('the marker of a block that has an aside (C74)', () => {
  it('stands in the control’s place, filled, and reopens the aside without asking again', async () => {
    await open({ asides: [marker('aside-1', 'tide table', { itemId: 'answer-1', lines: { first: 3, last: 5 } })] });
    const found = markers(article('answer-1'));
    expect(found).toHaveLength(1);
    expect(blockOf(found[0] as Element).tagName).toBe('P');
    expect(found[0]?.getAttribute('aria-label')).toBe(EXPLAIN_WORDS.open('tide table'));
    // Marked as a marker, which the style sheet fills; it holds no element and no text, as the control it stands for.
    expect([found[0]?.hasAttribute('data-aside-marker'), found[0]?.hasAttribute('data-explain'), found[0]?.childNodes.length]).toEqual([true, false, 0]);
    // Standalone Explain buttons stay hidden beside the other blocks.
    expect(controls('answer-1')).toHaveLength(0);
    fireEvent.click(found[0] as Element);
    expect(stage.tabs(ONE).map((tab) => [tab.kind, tab.reference, tab.handed])).toEqual([[ASIDE_KIND, 'aside-1', 'tide table']]);
    expect(asks()).toEqual([]);
  });

  it('lists a block’s asides by title where it has several, and opens the one chosen', async () => {
    const paragraph = { itemId: 'answer-1', lines: { first: 3, last: 5 } };
    await open({ asides: [marker('aside-1', 'tide table', paragraph), marker('aside-2', 'each morning', paragraph), marker('aside-3', 'one item', { itemId: 'answer-1', lines: { first: 6, last: 8 } })] });
    const [several, single] = markers(article('answer-1')) as [HTMLButtonElement, HTMLButtonElement];
    expect(several.getAttribute('aria-label')).toBe(EXPLAIN_WORDS.several(2));
    expect(single.getAttribute('aria-label')).toBe(EXPLAIN_WORDS.open('one item'));
    fireEvent.click(several);
    const menu = screen.getByRole('menu', { name: EXPLAIN_WORDS.list });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['tide table', 'each morning']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'each morning' }));
    expect(stage.tabs(ONE).map((tab) => tab.reference)).toEqual(['aside-2']);
    expect(screen.queryByRole('menu', { name: EXPLAIN_WORDS.list })).toBeNull();
  });

  it('keeps markers reachable by keyboard while Explain buttons are hidden', async () => {
    const paragraph = { itemId: 'answer-1', lines: { first: 3, last: 5 } };
    await open({ asides: [marker('aside-1', 'tide table', paragraph), marker('aside-2', 'each morning', paragraph), marker('aside-3', 'one item', { itemId: 'answer-1', lines: { first: 6, last: 8 } })] });
    const beside = [...article('answer-1').querySelectorAll<HTMLElement>('[data-md-control] > button')];
    expect(beside.map((control) => [control.hasAttribute('data-aside-marker'), control.tabIndex])).toEqual([[true, 0], [true, -1]]);
    const [several, items] = beside as [HTMLElement, HTMLElement];
    several.focus();
    fireEvent.keyDown(several, { key: 'ArrowDown' });
    expect(screen.queryByRole('menu', { name: EXPLAIN_WORDS.list })).toBeNull();
    expect(document.activeElement).toBe(items);
    fireEvent.keyDown(items, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(several);
    fireEvent.click(several);
    expect(within(screen.getByRole('menu', { name: EXPLAIN_WORDS.list })).getAllByRole('menuitem')).toHaveLength(2);
  });

  it('is its message’s one stop where the first block is the one that has an aside', async () => {
    await open({ asides: [marker('aside-1', 'Tides', { itemId: 'answer-1', lines: { first: 1, last: 2 } })] });
    const beside = [...article('answer-1').querySelectorAll<HTMLElement>('[data-md-control] > button')];
    expect(beside.map((control) => [control.hasAttribute('data-aside-marker'), control.tabIndex])).toEqual([[true, 0]]);
  });

  it('puts a selection across blocks at the block it begins in', async () => {
    await open({ asides: [marker('aside-1', 'from the heading on', { itemId: 'answer-1', lines: { first: 1, last: 8 } })] });
    const [only] = markers(article('answer-1')) as [HTMLButtonElement];
    expect(markers(article('answer-1'))).toHaveLength(1);
    expect(blockOf(only).tagName).toBe('H1');
  });

  it('stays where an aside is kept though the session can no longer be asked beside: it is still reopened', async () => {
    await open({ asking: 'none', asides: [marker('aside-1', 'tide table', { itemId: 'answer-1', lines: { first: 3, last: 5 } })] });
    expect(document.querySelectorAll('[data-explain]')).toHaveLength(0);
    expect(markers(article('answer-1'))).toHaveLength(1);
    // The message with no aside has nothing beside its blocks.
    expect(article('answer-0').querySelectorAll('[data-md-control]')).toHaveLength(0);
  });

  it('sits in a prompt’s head row beside Copy, and in an activity’s text’s head row', async () => {
    await open({ asides: [marker('aside-p', 'table list', { itemId: 'prompt-1', role: 'user' })] });
    const head = article('prompt-1').firstElementChild as HTMLElement;
    expect(within(head).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Copy message', EXPLAIN_WORDS.open('table list')]);
    // Its aside's title shows at once beside it, in place of a `title`.
    expect(markers(head)[0]?.hasAttribute('title')).toBe(false);
    fireEvent.pointerEnter(markers(head)[0] as Element);
    expect(nameTips()).toEqual([EXPLAIN_WORDS.open('table list')]);
    fireEvent.click(markers(head)[0] as Element);
    expect(stage.tabs(ONE).map((tab) => tab.reference)).toEqual(['aside-p']);
    cleanup();

    const item = chatActivity(ID, 't1', { type: 'command', name: 'commandExecution', summary: 'rg', input: 'rg --files', output: 'README.md\nsample.txt' }, { id: 'activity-1' });
    act(() => { setAsides(ID, [marker('aside-o', 'README.md', { kind: 'activity', itemId: 'activity-1', role: null, part: 'output' })], CODEX_ASIDES); });
    const view = render(<AsideSourceContext value={{ sessionId: ID, workerId: null }}><ActivityDetail item={item} body={item.activity as NonNullable<typeof item.activity>} /></AsideSourceContext>);
    const output = view.container.querySelector('[data-source-part="output"]')?.parentElement as HTMLElement;
    const input = view.container.querySelector('[data-source-part="input"]')?.parentElement as HTMLElement;
    expect(markers(output).map((button) => button.getAttribute('aria-label'))).toEqual([EXPLAIN_WORDS.open('README.md')]);
    // In its head row, beside Copy, and not in the text.
    expect(markers(output)[0]?.closest('pre')).toBeNull();
    expect(markers(input)).toEqual([]);
  });

  it('follows the session’s list: a new aside’s marker comes with the read its push asks for, and goes with its removal', async () => {
    await open();
    expect(markers(document.body)).toEqual([]);
    stage.chat(ONE).asides = [marker('aside-1', 'tide table', { itemId: 'answer-1', lines: { first: 3, last: 5 } })];
    stage.changed(ONE);
    await stage.settle();
    expect(markers(article('answer-1'))).toHaveLength(1);
    stage.chat(ONE).asides = [];
    stage.changed(ONE);
    await stage.settle();
    expect(markers(document.body)).toEqual([]);
    expect(controls('answer-1')).toHaveLength(0);
  });
});

describe('what is drawn as no source (C40, C72)', () => {
  it('draws no control and no marker for a message outside a session’s scope: an aside’s own answers, and a chat without a session', () => {
    act(() => { setAsides(ID, [marker('aside-1', 'answer', { itemId: 'answer-9' })], CODEX_ASIDES); });
    const view = render(<Message item={chatItem(ID, 'assistant', 'An answer.\n\nOf two blocks.', { id: 'answer-9' })} modelName="GPT-6 Sol" providerName="Codex" current />);
    expect(view.container.querySelectorAll('[data-explain], [data-aside-marker], [data-md-control], [data-source-kind]')).toHaveLength(0);
  });

  it('marks worker messages as sources while hiding Explain buttons (C47)', () => {
    act(() => { setAsides(ID, [], CODEX_ASIDES); });
    const view = render(
      <AsideSourceContext value={{ sessionId: ID, workerId: 'worker-1' }}>
        <Message item={chatItem(ID, 'assistant', 'A worker’s answer.', { id: 'w-item', workerId: 'worker-1' })} modelName="GPT-6 Sol" providerName="Codex" current />
      </AsideSourceContext>,
    );
    expect(view.container.querySelectorAll('[data-explain]')).toHaveLength(0);
    expect(view.container.querySelector('[data-source-kind]')?.getAttribute('data-source-worker')).toBe('worker-1');
  });
});

describe('a painted passage (C74, C75)', () => {
  const caretIn = (words: string, offset = 1): void => {
    const body = document.querySelector('[data-source-item="answer-1"]') as Element;
    const node = textNodes(body).find((text) => text.data.includes(words)) as Text;
    (document as unknown as { caretPositionFromPoint: () => { offsetNode: Node; offset: number } }).caretPositionFromPoint = () => ({ offsetNode: node, offset: node.data.indexOf(words) + offset });
  };
  const body = () => document.querySelector('[data-source-item="answer-1"]') as HTMLElement;

  it('is painted from its marker’s offsets after the message is drawn, and a press inside it opens its aside', async () => {
    await open();
    stage.chat(ONE).asides = [passage('aside-1', 'tide table lists')];
    stage.changed(ONE);
    await stage.settle();
    expect(paintedIn(body()).map((entry) => [entry.asideId, entry.range.toString()])).toEqual([['aside-1', 'tide table lists']]);
    // Nothing of the drawing changed for it: no element marks the passage.
    expect(body().querySelector('mark, [data-aside]')).toBeNull();

    caretIn('table');
    fireEvent.click(body().querySelector('p') as Element, { clientX: 30, clientY: 30 });
    expect(stage.tabs(ONE).map((tab) => [tab.reference, tab.handed])).toEqual([['aside-1', 'tide table lists']]);
    expect(asks()).toEqual([]);
  });

  it('opens nothing for a press outside it, for one that ends a selection, or for one on a control inside the source', async () => {
    await open();
    stage.chat(ONE).asides = [passage('aside-1', 'tide table lists')];
    stage.changed(ONE);
    await stage.settle();
    caretIn('each morning');
    fireEvent.click(body().querySelector('p') as Element);
    expect(stage.tabs(ONE)).toEqual([]);
    // A drag that ends inside the passage is a selection, and not a press on it.
    caretIn('table');
    const range = document.createRange();
    range.selectNodeContents(body().querySelector('h1') as Element);
    // A real drag replaces the caret selection left by the automatically focused prompt.
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    fireEvent.click(body().querySelector('p') as Element);
    expect(stage.tabs(ONE)).toEqual([]);
    document.getSelection()?.removeAllRanges();
    // The marker beside the block is a control of its own: its press is its own, once.
    fireEvent.click(markers(article('answer-1'))[0] as Element);
    expect(stage.tabs(ONE)).toHaveLength(1);
  });

  it('shows the pointer it can be pressed while over it, and no longer once off it or out of the message', async () => {
    await open();
    stage.chat(ONE).asides = [passage('aside-1', 'tide table lists')];
    stage.changed(ONE);
    await stage.settle();
    caretIn('table');
    fireEvent.pointerMove(body());
    expect(body().hasAttribute('data-aside-over')).toBe(true);
    caretIn('each morning');
    fireEvent.pointerMove(body());
    expect(body().hasAttribute('data-aside-over')).toBe(false);
    caretIn('table');
    fireEvent.pointerMove(body());
    fireEvent.pointerLeave(body());
    expect(body().hasAttribute('data-aside-over')).toBe(false);
  });

  it('is not painted where the text at its offsets is no longer what was selected, and its marker stands', async () => {
    await open();
    const stale = { ...passage('aside-1', 'tide table lists') };
    stage.chat(ONE).asides = [{ ...stale, source: { ...(stale.source as NonNullable<AsideMarker['source']>), digest: drawnDigest('what it used to say') } }];
    stage.changed(ONE);
    await stage.settle();
    expect(paintedIn(body())).toEqual([]);
    expect(markers(article('answer-1'))).toHaveLength(1);
  });

  it('is let go of when its message is no longer drawn', async () => {
    await open();
    stage.chat(ONE).asides = [passage('aside-1', 'tide table lists')];
    stage.changed(ONE);
    await stage.settle();
    const drawn = body();
    expect(paintedIn(drawn)).toHaveLength(1);
    cleanup();
    expect(paintedIn(drawn)).toEqual([]);
  });
});
