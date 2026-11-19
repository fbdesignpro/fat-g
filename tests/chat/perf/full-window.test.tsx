// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V17 in CI (docs/planning/_archive/M19.md, Design 9; C25, C52, C65, C67): the page with a full window — the
// fixture's newest 500 items — while each of the fixture's three streams is written into it, an
// update every 50 ms. Nothing here is timed: fake timers drive the interval, and what is asserted
// is what the page did to the document. An update writes inside the message that is being written
// and nowhere else in the list; inside that message, only in the blocks whose source it changed;
// every element drawn is one of the fixed list; and what stands at a stream's end is what the whole
// text draws. The times themselves are the maintainer's recorded runs (do-run-stream.bat).
//
// V11 in CI (docs/planning/_archive/M20a.md, Design 8; C44): and a full window that holds what its turns did —
// each turn's group of twenty activities — while a turn runs twenty tools into it. A closed group
// draws its summary line alone, an open one its rows, and no row's detail until it is opened; an
// item's start and end write inside its own group and nowhere else in the list.
//
// V17 in CI (docs/planning/_archive/M20b.md, Design 7; C30, C46, C74): and a full window whose session keeps
// two hundred asides. Each answer's blocks are drawn as they are with no aside — a control or a
// marker stands beside a block and never in it — and an aside that is answered beside the session
// writes nothing in the list at all: its pushes are its tab's, and the list takes their revision
// and no more. A change of the session's list of asides is read once, and writes only where a
// marker came.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsideMarker } from '@shared/contracts/aside';
import { CHAT_LINES, type ChatPush, PARTIAL_PUSH_MS } from '@shared/contracts/chat';
import { type ConversationItem, fitWindow, WINDOW_ENTRIES } from '@shared/contracts/conversation';
import { useGroupChoices } from '../../../src/renderer/src/chat/chat-store';
import { type Opener, OpenerContext } from '../../../src/renderer/src/markdown/inert';
import { MarkdownText } from '../../../src/renderer/src/markdown/MarkdownText';
import { parse } from '../../../src/renderer/src/markdown/parse';
import { MARKDOWN_ELEMENTS } from '../../../src/renderer/src/markdown/render';
import { ChatRegion } from '../../../src/renderer/src/shell/ChatRegion';
import { chatActivity, chatItem, chatTurn, type FakeChat, fakeChat } from '../../../src/renderer/src/test/chat';
import { installDialogStandIn } from '../../../src/renderer/src/test/dialog';
import { type FakeBridge, installFakeBridge } from '../../../src/renderer/src/test/fake-bridge';
import { prefsSnapshot } from '../../../src/renderer/src/test/prefs';
import { project } from '../../../src/renderer/src/test/records';
import { showState } from '../../../src/renderer/src/test/sessions';
import { usePrefs } from '../../../src/renderer/src/state/prefs-store';
import { activities as fixtureActivities, items as fixtureItems, type StreamKind, STREAMS, streamText, turn as fixtureTurn, TURNS as FIXTURE_TURNS } from '../../fixtures/conversations/long-conversation.mjs';
import { sampleProvider } from '../../support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../support/catalog';
import { sessionEntry, SUMMARIES } from '../../support/sessions';

/** What a provider writes between two partial pushes, at the rate the recorded runs play: 5,000 units a second. */
const UPDATE_UNITS = 250;
/** The most blocks one update may change: the fence and the table are one block under a line of words. */
const MOST_BLOCKS: Readonly<Record<StreamKind, number>> = { mixed: 4, fence: 2, table: 2 };

const A = project('Calamari', { providers: ['codex'] });
const CATALOG = { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', resolvedId: 'gpt-6-sol', name: 'GPT-6 Sol' })] })] };
const PROVIDERS = [sampleProvider({ id: 'codex', displayName: 'Codex' })];
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: A.id, providerId: 'codex', model: 'gpt-6-sol', effort: 'high' });
const ID = ONE.record.id;

let bridge: FakeBridge;
let main: FakeChat;
let turns = 0;

beforeEach(() => {
  installDialogStandIn();
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  bridge = installFakeBridge();
  main = fakeChat(ID);
  turns = 0;
  bridge.setInvoke((channel, request) => {
    const value = channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0]) : channel === 'chat:page' ? main.page(request as Parameters<FakeChat['page']>[0]) : { status: 'saved' };
    return Promise.resolve({ ok: true, value });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const push = (payload: ChatPush) => act(() => { bridge.push('chat:message', payload); });
const list = () => screen.getByRole('group', { name: 'Messages' });
const articles = () => within(list()).queryAllByRole('article');
/** Where an assistant's message is drawn as Markdown: under its head. */
const bodyOf = (article: Element): Element => article.children[1] as Element;
/** The blocks of a message that draw an element, each under its place in the text: a definition draws none. */
function blocksOf(article: Element): Map<number, Element> {
  const blocks = new Map<number, Element>();
  for (const element of bodyOf(article).firstElementChild?.children ?? []) {
    const place = /(\d+)$/.exec(element.getAttribute('data-md-block') ?? '')?.[1];
    if (place !== undefined) blocks.set(Number(place), element);
  }
  return blocks;
}
/** What is drawn, but for each block's id; its lines (M19b, C41) are compared after the markup, block by block, since they are written after it. */
const drawn = (root: Element): string => {
  const lines = [...root.querySelectorAll('[data-md-block]')].map((block) => block.getAttribute('data-md-lines') ?? 'none');
  return `${root.innerHTML.replace(/ data-md-(?:block|lines)="[^"]*"/g, '')}\nlines: ${lines.join(' ')}`;
};
const outsideTheList = (root: Element): string[] => [...new Set([...root.querySelectorAll('*')].map((element) => element.tagName.toLowerCase()))].filter((tag) => !(MARKDOWN_ELEMENTS as readonly string[]).includes(tag));

/** The fixture's newest 500 items in the store, and the page with all of them shown: a full window. */
async function openFullWindow(): Promise<void> {
  const fixture = fixtureItems(WINDOW_ENTRIES / 2);
  main.items = fixture.map((entry, index) => chatItem(ID, entry.role, entry.text, { id: entry.id, turnId: `turn-${Math.floor(index / 2)}`, order: { turn: Math.floor(index / 2), item: index % 2 }, origin: 'provider' }));
  main.revision = main.items.length;
  turns = main.items.length / 2;
  act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
  render(<ChatRegion />);
  await settle();
  for (let guard = 0; guard < 10; guard += 1) {
    const earlier = within(list()).queryByRole('button', { name: CHAT_LINES.showEarlier });
    if (earlier === null) break;
    fireEvent.click(earlier);
    await settle();
  }
}

/** A prompt and, under the same running turn, the message that answers it, opened empty: as main pushes them. */
function openStream(kind: StreamKind): ConversationItem {
  turns += 1;
  const turnId = `turn-${turns}`;
  main.turns.set(turnId, chatTurn(turnId, { state: 'running', outcome: null, place: turns }));
  const prompt = chatItem(ID, 'user', kind, { turnId, order: { turn: turns, item: 0 } });
  const answer = chatItem(ID, 'assistant', '', { turnId, order: { turn: turns, item: 1 }, state: 'streaming', origin: 'provider' });
  for (const item of [prompt, answer]) {
    main.items.push(item);
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item, turn: main.turnOf(item) });
  }
  return answer;
}

/** One partial push, 50 ms after the last. */
function grow(item: ConversationItem, before: string, append: string): void {
  const at = main.items.findIndex((entry) => entry.id === item.id);
  main.items[at] = { ...(main.items[at] as ConversationItem), blocks: [{ type: 'text', text: before + append, cut: false }] };
  main.revision += 1;
  act(() => { vi.advanceTimersByTime(PARTIAL_PUSH_MS); });
  push({ sessionId: ID, revision: main.revision, partial: { itemId: item.id, before: before.length, append } });
}

/** The whole message, complete, and its turn over: what ends a stream. */
function complete(item: ConversationItem, text: string): void {
  const at = main.items.findIndex((entry) => entry.id === item.id);
  const whole: ConversationItem = { ...(main.items[at] as ConversationItem), state: 'complete', blocks: [{ type: 'text', text, cut: false }] };
  main.items[at] = whole;
  main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'ended', outcome: 'completed', place: whole.order.turn }));
  main.revision += 1;
  push({ sessionId: ID, revision: main.revision, item: whole, turn: main.turnOf(whole) });
}

/** An opener as the chat gives its messages (M19b, C21): a session's references are controls, and so they are in what the whole text draws. */
const opener: Opener = { platform: 'test-os', open: () => Promise.resolve(null), show: () => Promise.resolve(null), copyPath: () => Promise.resolve(null) };

/** A reading of `text` by a component that never saw another, drawn with an opener as a session's message is. */
function fresh(text: string): string {
  const view = render(<OpenerContext value={opener}><MarkdownText text={text} /></OpenerContext>);
  const html = drawn(view.container);
  view.unmount();
  return html;
}

describe('a full window while a message is written into it (V17; C52, C65, C67)', () => {
  it('shows the fixture’s newest 500 items, every assistant’s message as Markdown, of the fixed elements alone', async () => {
    await openFullWindow();
    const shown = articles();
    expect(shown).toHaveLength(WINDOW_ENTRIES);
    expect(within(list()).queryByRole('button', { name: CHAT_LINES.showEarlier })).toBeNull();
    const answers = shown.filter((article) => article.getAttribute('data-role') === 'assistant');
    expect(answers).toHaveLength(WINDOW_ENTRIES / 2);
    for (const article of answers) {
      expect(blocksOf(article).size).toBeGreaterThan(0);
      expect(outsideTheList(bodyOf(article))).toEqual([]);
    }
    // And nothing the texts say is an element of the page's: no link, image, box or frame anywhere in the list.
    expect(articles().flatMap((article) => [...article.querySelectorAll('a, img, input, iframe, script, style, object, embed, form, svg')])).toHaveLength(0);
  }, 120_000);

  it.each([...STREAMS])('writes the %s stream into it, an update every 50 ms, touching only the blocks each update changes', async (kind) => {
    await openFullWindow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const whole = streamText(kind);
    const item = openStream(kind);
    // The window holds its bound and no more: the two oldest items left as the two arrived.
    expect(articles()).toHaveLength(WINDOW_ENTRIES);
    const article = articles().at(-1) as HTMLElement;
    expect(article.getAttribute('data-state')).toBe('streaming');
    expect(article.getAttribute('aria-busy')).toBe('true');
    const others = articles().slice(0, -1);

    const observer = new MutationObserver(() => undefined);
    observer.observe(list(), { subtree: true, childList: true, characterData: true, attributes: true });
    let written = '';
    let before = parse('');
    let updates = 0;
    let mostBlocksTouched = 0;
    for (let at = 0; at < whole.length; at += UPDATE_UNITS) {
      const append = whole.slice(at, at + UPDATE_UNITS);
      const kept = blocksOf(article);
      // A table's rows but its last, which the update may finish: each is drawn for its own text (C67).
      const rows = new Set([...article.querySelectorAll('tr')].slice(0, -1));
      grow(item, written, append);
      written += append;
      updates += 1;
      const after = parse(written);
      const records = observer.takeRecords();

      // Nothing in any other message was written to.
      const elsewhere = records.filter((record) => { const owner = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('article'); return owner !== null && owner !== undefined && owner !== article; });
      expect(elsewhere, `update ${updates}: writes outside the message`).toHaveLength(0);

      // In the message, only where a block's source changed, or a block arrived.
      const blocks = blocksOf(article);
      const unchanged = after.blocks.filter((block, index) => before.blocks[index]?.signature === block.signature).map((block) => block.index);
      for (const index of unchanged) {
        const node = blocks.get(index);
        expect(node, `update ${updates}: block ${index} kept its node`).toBe(kept.get(index));
        const touched = records.some((record) => node !== undefined && node.contains(record.target));
        expect(touched, `update ${updates}: block ${index} was written to though its source did not change`).toBe(false);
      }
      const rewritten = records.filter((record) => { const row = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('tr'); return row !== null && row !== undefined && rows.has(row); });
      expect(rewritten, `update ${updates}: a row that was whole was written to`).toHaveLength(0);
      const changed = after.blocks.length - unchanged.length;
      mostBlocksTouched = Math.max(mostBlocksTouched, changed);
      // The open block changed: something of the message was written.
      expect(records.some((record) => article.contains(record.target)), `update ${updates}: the message grew`).toBe(true);
      before = after;
    }
    observer.disconnect();

    expect(updates).toBe(Math.ceil(whole.length / UPDATE_UNITS));
    // An update changes the blocks its 250 units reach, and one before them that names what they define:
    // a handful at the text's end, however long the text has grown.
    expect(mostBlocksTouched).toBeLessThanOrEqual(MOST_BLOCKS[kind]);
    expect(articles().slice(0, -1).every((other, index) => other === others[index])).toBe(true);
    expect(outsideTheList(bodyOf(article))).toEqual([]);
    if (kind === 'table') expect(article.querySelectorAll('tbody tr')).toHaveLength(whole.split('\n').filter((line) => line.startsWith('|')).length - 2);
    if (kind === 'fence') expect(article.querySelectorAll('pre')).toHaveLength(1);

    // Complete, it is what its whole text draws, in the same nodes.
    const last = blocksOf(article);
    complete(item, whole);
    expect(article.isConnected).toBe(true);
    expect(article.getAttribute('data-state')).toBe('complete');
    expect(article.hasAttribute('aria-busy')).toBe(false);
    expect([...blocksOf(article)].every(([place, node]) => last.get(place) === node)).toBe(true);
    expect(blocksOf(article).size).toBe(last.size);
    expect(drawn(bodyOf(article))).toBe(fresh(whole));
    expect(articles()).toHaveLength(WINDOW_ENTRIES);
  }, 300_000);
});

// ── M20a (V11; C44): a full window that holds what its turns did ──────────────────────────────

describe('a full window that holds what its turns did, while a turn runs its tools into it (M20a: V11; C44)', () => {
  const groups = () => articles().filter((article) => article.getAttribute('data-role') === 'activity');
  const rowsOf = (group: Element | undefined) => [...(group?.querySelectorAll('[data-activity]') ?? [])];

  /** One fixture turn as the store holds it: its prompt, its twenty activities and its answer. */
  function turnItems(n: number, place: number): ConversationItem[] {
    const { prompt, answer } = fixtureTurn(n);
    const turnId = `turn-${place}`;
    const done = fixtureActivities(n);
    return [
      chatItem(ID, 'user', prompt, { id: `u${n}`, turnId, order: { turn: place, item: 0 }, origin: 'provider' }),
      ...done.map((activity, index) => chatActivity(ID, turnId, {
        type: activity.type, name: activity.name, summary: activity.summary, input: activity.input, output: activity.output,
        files: activity.file === null ? [] : [{ path: activity.file, line: null }], exitCode: activity.exitCode,
      }, { id: `${activity.id}-${n}`, order: { turn: place, item: index + 1 }, origin: 'provider' })),
      chatItem(ID, 'assistant', answer, { id: `a${n}`, turnId, order: { turn: place, item: done.length + 1 }, origin: 'provider' }),
    ];
  }

  /** As many of the fixture's newest turns as a window holds, by its entries and its size, all of them shown. */
  async function openFullWindow(): Promise<number> {
    const all = Array.from({ length: 170 }, (_, index) => turnItems(FIXTURE_TURNS - 169 + index, index)).flat();
    const fitted = fitWindow(all, 'newest');
    // The fixture is past a window's bounds: what is held is a window at its bound, and whole turns of it.
    expect(fitted.cut).toBe(true);
    const whole = fitted.items.slice(fitted.items.findIndex((item) => item.role === 'user'));
    main.items = [...whole];
    main.revision = main.items.length;
    turns = 170;
    act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
    render(<ChatRegion />);
    await settle();
    for (let guard = 0; guard < 30; guard += 1) {
      const earlier = within(list()).queryByRole('button', { name: CHAT_LINES.showEarlier });
      if (earlier === null) break;
      fireEvent.click(earlier);
      await settle();
    }
    return whole.filter((item) => item.role === 'user').length;
  }

  beforeEach(() => { useGroupChoices.setState({ choices: {} }); });

  it('draws each turn’s twenty activities as one closed group: its summary line alone, no row and no detail', async () => {
    const held = await openFullWindow();
    // A window at its size's bound: over a hundred turns, each a prompt, a group and an answer.
    expect(held).toBeGreaterThan(90);
    expect(within(list()).queryByRole('button', { name: CHAT_LINES.showEarlier })).toBeNull();
    expect(articles()).toHaveLength(held * 3);
    expect(groups()).toHaveLength(held);
    for (const group of groups()) {
      // One line: the control that opens it, with what was done in fat-g's words.
      expect(group.children).toHaveLength(1);
      expect(group.firstElementChild?.tagName).toBe('BUTTON');
      expect(group.firstElementChild?.getAttribute('aria-expanded')).toBe('false');
      expect(group.textContent).toMatch(/^Read 7 files, searched 7 times, ran 6 commands · /);
    }
    // Two thousand activities are held, and not one is drawn: no row, no input, no output.
    expect(main.items.filter((item) => item.kind === 'activity')).toHaveLength(held * 20);
    expect(list().querySelectorAll('[data-activity]')).toHaveLength(0);
    expect([...list().querySelectorAll('pre')].filter((pre) => pre.closest('[data-role="activity"]') !== null)).toHaveLength(0);
    // Nothing of an output at the bound is in the document.
    const big = main.items.find((item) => item.activity?.output?.length === 20_000)?.activity?.output ?? '';
    expect(big).toHaveLength(20_000);
    expect(list().textContent).not.toContain(big.slice(0, 60));
  }, 300_000);

  // M100 (C83): a group keeps to its line while its actions run, and opens by itself only on a failure.
  it('runs a turn of twenty tools into it: an item’s start and its end write inside its own group alone, and the group is one line throughout, no row and no detail drawn', async () => {
    await openFullWindow();
    turns += 1;
    const turnId = `turn-${turns}`;
    main.turns.set(turnId, chatTurn(turnId, { state: 'running', outcome: null, place: turns }));
    const send = (item: ConversationItem): void => {
      const at = main.items.findIndex((entry) => entry.id === item.id);
      if (at === -1) main.items.push(item); else main.items[at] = item;
      main.revision += 1;
      push({ sessionId: ID, revision: main.revision, item, turn: main.turnOf(item) });
    };
    send(chatItem(ID, 'user', 'tools', { turnId, order: { turn: turns, item: 0 } }));
    const others = articles();
    const observer = new MutationObserver(() => undefined);
    observer.observe(list(), { subtree: true, childList: true, characterData: true, attributes: true });
    const done = fixtureActivities(FIXTURE_TURNS + 1);
    let group: Element | undefined;
    for (const [index, activity] of done.entries()) {
      const running = chatActivity(ID, turnId, { type: activity.type, name: activity.name, summary: activity.summary, input: activity.input, status: 'running', files: activity.file === null ? [] : [{ path: activity.file, line: null }] }, { id: `live-${activity.id}`, order: { turn: turns, item: index + 1 }, time: { receivedAt: Date.now(), providerAt: null } });
      send(running);
      group = groups().at(-1);
      // Closed while one of its items runs (M100, C83): its line alone, busy, no row and no detail.
      expect(group?.firstElementChild?.getAttribute('aria-expanded'), activity.id).toBe('false');
      expect(group?.getAttribute('aria-busy'), activity.id).toBe('true');
      expect(group?.children, activity.id).toHaveLength(1);
      expect(rowsOf(group), activity.id).toHaveLength(0);
      expect(group?.querySelector('pre'), activity.id).toBeNull();
      const started = observer.takeRecords();
      send({ ...running, state: 'complete', activity: { ...(running.activity as NonNullable<ConversationItem['activity']>), status: 'completed', output: activity.output, exitCode: activity.exitCode, duration: { ms: 25, provenance: 'local' } } });
      const ended = observer.takeRecords();
      // Every write of the two pushes is inside the turn's own group: nothing of any other entry of the
      // full window was drawn again. The keyboard's current entry is the newest (C42), so the entry that
      // was current before the group came is told it no longer is: its mark and its controls' stops, and no more.
      for (const record of [...started, ...ended]) {
        const owner = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('article');
        if (owner === null || owner === undefined || owner === group) continue;
        // The window lets go of entries at its head, and the message it then begins with names its
        // speaker (M100, C82): its head gains its label and is no longer bare, and nothing else of it is written.
        const head = owner === articles()[0] ? owner.querySelector('[data-head]') : null;
        const naming = record.type === 'attributes'
          ? record.attributeName === 'data-head'
          : record.removedNodes.length === 0 && [...record.addedNodes].every((node) => node instanceof HTMLParagraphElement && node.textContent === owner.getAttribute('aria-label'));
        if (head !== null && record.target === head && naming) continue;
        expect(record.type, `${activity.id}: a write outside the group`).toBe('attributes');
        expect(['data-current', 'tabindex'], `${activity.id}: a write outside the group`).toContain(record.attributeName);
      }
      // Its end leaves every item of the group ended without failure: the group is still its one line,
      // the same element all along, and nothing of an output was drawn, the two at the bound included.
      expect(groups().at(-1), activity.id).toBe(group);
      expect(group?.firstElementChild?.getAttribute('aria-expanded'), activity.id).toBe('false');
      expect(group?.children, activity.id).toHaveLength(1);
      expect(started.length + ended.length, activity.id).toBeGreaterThan(0);
    }
    observer.disconnect();
    // Every item ended without failure: the group is closed, one line, the reader not having chosen.
    group = groups().at(-1);
    expect(group?.firstElementChild?.getAttribute('aria-expanded')).toBe('false');
    expect(group?.children).toHaveLength(1);
    expect(group?.textContent).toMatch(/^Read 7 files, searched 7 times, ran 6 commands · /);
    // The entries that were there before the turn's tools are the nodes they were, but for those the window let go of at its head.
    const now = new Set(articles());
    const still = others.filter((article) => now.has(article));
    expect(still.length).toBeGreaterThan(others.length - 12);
    expect(articles().slice(-2 - still.length, -2).every((article, index) => article === still[index])).toBe(true);
  }, 300_000);

  it('draws a row’s detail when the reader opens it, and that row’s alone: an output at the bound is one block of text with its Copy button', async () => {
    await openFullWindow();
    const group = groups().at(-1) as HTMLElement;
    fireEvent.click(group.firstElementChild as HTMLElement);
    expect(rowsOf(group)).toHaveLength(20);
    expect(group.querySelector('pre')).toBeNull();
    // The tenth: its output is at the bound.
    const row = rowsOf(group)[9] as HTMLElement;
    fireEvent.click(row.querySelector('button[aria-controls]') as HTMLElement);
    const shown = [...group.querySelectorAll('pre')];
    expect(shown.every((pre) => row.contains(pre))).toBe(true);
    expect(shown.map((pre) => pre.getAttribute('aria-label'))).toEqual(['Input', 'Output']);
    expect(shown[1]?.textContent).toHaveLength(20_000);
    // Text, and nothing else: no element is made of what an output holds.
    expect(shown[1]?.querySelectorAll('*')).toHaveLength(1);
    expect(within(row).getAllByRole('button', { name: /^Copy (input|output)$/ })).toHaveLength(2);
    // No other group of the window opened, and none drew a row.
    expect(list().querySelectorAll('[data-activity]')).toHaveLength(20);
  }, 300_000);
});

// ── M20b (V17; C30, C46, C74): a full window whose session keeps 200 asides ───────────────────

describe('a full window whose session keeps 200 asides, while an aside is answered beside it (M20b: V17; C30)', () => {
  const ASIDES = 200;
  /** An aside about the first block of a message: where it is drawn is not worked out here, so nothing is painted for it and its marker stands. */
  const about = (n: number, itemId: string): AsideMarker => ({
    id: `aside-${n}`, title: `Passage ${n}`, createdAt: n, running: false,
    source: { kind: 'message', itemId, role: 'assistant', part: null, workerId: null, path: null, lines: { first: 1, last: 1 }, range: { start: 0, end: 0 }, digest: '00000000' },
  });
  /** The session's two hundred: two about each of its newest hundred answers. */
  function keep(): string[] {
    const answers = fixtureItems(WINDOW_ENTRIES / 2).filter((entry) => entry.role === 'assistant').slice(-ASIDES / 2).map((entry) => entry.id);
    main.asides = answers.flatMap((itemId, index) => [about(index * 2 + 1, itemId), about(index * 2 + 2, itemId)]);
    main.asking = { followUp: true, streamed: true, tools: 'none' };
    return answers;
  }
  /** A drawing without its controls' places in the tab order: those say which message is current, and nothing of what is drawn. */
  const unordered = (html: string): string => html.replace(/ tabindex="-?\d+"/g, '');
  /** What a message's body draws without what stands beside its blocks. */
  function withoutControls(article: Element): string {
    const copy = bodyOf(article).cloneNode(true) as Element;
    for (const control of copy.querySelectorAll('[data-md-control]')) control.remove();
    return unordered(drawn(copy));
  }
  /** Every write to the list from here on: gathered as they are delivered, since a read's answer comes a turn of the loop later. */
  function watching(): { readonly records: MutationRecord[]; stop(): MutationRecord[] } {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((delivered) => { records.push(...delivered); });
    observer.observe(list(), { subtree: true, childList: true, characterData: true, attributes: true });
    return { records, stop: () => { records.push(...observer.takeRecords()); observer.disconnect(); return records; } };
  }

  it('draws each answer’s blocks as they are with no aside: a control or a marker beside each block, the two hundred as a hundred markers, and nothing of them in a block', async () => {
    const answers = keep();
    await openFullWindow();
    expect(main.asides).toHaveLength(ASIDES);
    const shown = articles().filter((article) => article.getAttribute('data-role') === 'assistant');
    expect(shown).toHaveLength(WINDOW_ENTRIES / 2);
    // A hundred markers, each of the two asides its block has; standalone Explain buttons stay hidden.
    const markers = [...list().querySelectorAll('[data-aside-marker]')];
    expect(markers).toHaveLength(ASIDES / 2);
    expect(markers.every((marker) => marker.getAttribute('aria-label') === '2 side questions about this')).toBe(true);
    const marked = new Set(markers.map((marker) => marker.closest('article')?.querySelector('[data-source-item]')?.getAttribute('data-source-item')));
    expect(marked).toEqual(new Set(answers));
    expect(list().querySelectorAll('[data-explain]')).toHaveLength(0);
    // What is drawn of each text is what the text draws alone, node for node in its markup: nothing stands inside a block.
    const texts = new Map(main.items.map((item) => [item.id, item.blocks[0]?.text ?? '']));
    for (const article of shown) {
      const itemId = article.querySelector('[data-source-item]')?.getAttribute('data-source-item') ?? '';
      expect(withoutControls(article), itemId).toBe(unordered(fresh(texts.get(itemId) ?? '')));
      for (const block of blocksOf(article).values()) expect(block.querySelector('[data-explain], [data-aside-marker]'), itemId).toBeNull();
    }
    // And no element of the list is one a text may not become: a control's glyph is the style sheet's.
    expect(articles().flatMap((article) => [...article.querySelectorAll('a, img, input, iframe, script, style, object, embed, form, svg')])).toHaveLength(0);
  }, 300_000);

  it('writes nothing in the list while an aside is answered beside it — its question, forty updates of its answer and its end — and reads the chat for none of it', async () => {
    keep();
    await openFullWindow();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const before = articles();
    let reads = 0;
    const read = main.read.bind(main);
    main.read = (request) => { reads += 1; return read(request); };
    const watch = watching();
    // The aside's own conversation, as main pushes it: under the session's id and revision, each push naming the aside.
    const turn = chatTurn('aside-turn', { state: 'running', outcome: null, place: 1 });
    const asides = (payload: object): void => { main.revision += 1; push({ sessionId: ID, revision: main.revision, asideId: 'aside-new', ...payload } as ChatPush); };
    asides({ item: chatItem('aside-new', 'user', 'Explain this passage.', { id: 'aside-q', turnId: 'aside-turn' }), turn });
    asides({ item: chatItem('aside-new', 'assistant', '', { id: 'aside-a', turnId: 'aside-turn', state: 'streaming' }), turn });
    const whole = streamText('mixed');
    for (let update = 0; update < 40; update += 1) {
      act(() => { vi.advanceTimersByTime(PARTIAL_PUSH_MS); });
      asides({ partial: { itemId: 'aside-a', before: update * UPDATE_UNITS, append: whole.slice(update * UPDATE_UNITS, (update + 1) * UPDATE_UNITS) } });
    }
    asides({ item: chatItem('aside-new', 'assistant', whole.slice(0, 40 * UPDATE_UNITS), { id: 'aside-a', turnId: 'aside-turn' }), turn: chatTurn('aside-turn', { place: 1 }) });
    await settle();
    // Forty-three pushes, and not one write anywhere in the list.
    expect(watch.stop()).toEqual([]);
    expect(reads).toBe(0);
    expect(articles()).toEqual(before);
    expect(list().textContent).not.toContain('Explain this passage.');

    // The session's next own item is applied as the next revision: the list took each aside's push for its revision alone.
    const next = chatItem(ID, 'user', 'A prompt after the aside', { turnId: 'turn-next', order: { turn: 9_999, item: 0 } });
    main.items.push(next);
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item: next, turn: chatTurn('turn-next', { state: 'running', outcome: null, place: 9_999 }) });
    expect(reads).toBe(0);
    expect(articles().at(-1)?.textContent).toContain('A prompt after the aside');
  }, 300_000);

  it('reads the chat once when the session’s list of asides changes, keeps every entry’s node, and writes only where a marker came', async () => {
    const answers = keep();
    await openFullWindow();
    const before = articles();
    let reads = 0;
    const read = main.read.bind(main);
    main.read = (request) => { reads += 1; return read(request); };
    // An aside about an answer that had none: the oldest answer of the window.
    const unmarked = main.items.find((item) => item.role === 'assistant' && !answers.includes(item.id));
    expect(unmarked).toBeDefined();
    const target = articles().find((article) => article.querySelector(`[data-source-item="${unmarked?.id ?? ''}"]`) !== null) as HTMLElement;
    const watch = watching();
    main.asides = [...main.asides, about(ASIDES + 1, unmarked?.id ?? '')];
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(reads).toBe(1);
    const records = watch.stop();
    expect(records.length).toBeGreaterThan(0);
    // Every entry is the node it was: the window was read again, and nothing of it was drawn anew.
    expect(articles()).toEqual(before);
    const touched = new Set(records.map((record) => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest('article')));
    expect([...touched].filter((article) => article !== null && article !== undefined)).toEqual([target]);
    // In that message, a marker stands where the control stood, and no block of its text was written to.
    expect(target.querySelectorAll('[data-aside-marker]')).toHaveLength(1);
    for (const block of blocksOf(target).values()) expect(records.some((record) => block.contains(record.target))).toBe(false);
    expect(list().querySelectorAll('[data-aside-marker]')).toHaveLength(ASIDES / 2 + 1);
  }, 300_000);
});
