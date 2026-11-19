// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0022, item 15: the images the chat draws from files — under an activity group's line, open or
// closed, the images its agent read; under a finished answer, the images its text names — each asked
// of main when mounted and at a press, drawn by its revision id, and opened in the pane's image tab. A text's
// address main draws nothing of is left out; an image the agent read says it is not available.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityBody } from '@shared/contracts/activity';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type FileReadAnswer, imageFileAddress } from '@shared/contracts/files';
import { BUILT_IN_KINDS } from '../artifacts/kinds';
import { createOpener, IMAGE_KIND } from '../artifacts/opener';
import { IMAGE_FILE_STORAGE_NOTE } from '../images/file-failure';
import { registerKinds, resetTabs, useTabs } from '../artifacts/tabs-store';
import { OpenerContext } from '../markdown/inert';
import { chatActivity, chatItem } from '../test/chat';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { ActivityGroup } from './ActivityGroup';
import { useGroupChoices } from './chat-store';
import { AsideSourceContext } from './ExplainControl';
import { imageRead } from './image-files';
import { Message } from './Message';

const S = '11111111-1111-4111-8111-111111111111';
const SHOT = 'C:\\Users\\someone\\AppData\\Local\\Temp\\fable-crop-a.png';
const ID = 'a'.repeat(32);
let bridge: FakeBridge;
let reads: string[];
/** What main answers a read of each target: an image, else refused. */
let answers: Record<string, FileReadAnswer>;

beforeEach(() => {
  bridge = installFakeBridge('win32');
  reads = [];
  answers = { [SHOT]: { outcome: 'image', path: SHOT, id: ID, width: 640, height: 480 } };
  bridge.setInvoke((channel, request) => {
    if (channel !== 'files:read') return Promise.resolve({ ok: true, value: null });
    const { target } = request as { target: string };
    reads.push(target);
    return Promise.resolve({ ok: true, value: answers[target] ?? { outcome: 'refused', why: 'not-found' } });
  });
  registerKinds(BUILT_IN_KINDS);
  resetTabs();
  useGroupChoices.setState({ choices: {} });
});
afterEach(cleanup);

const flush = () => act(async () => { for (let n = 0; n < 5; n += 1) await Promise.resolve(); });
type Given = Partial<ActivityBody> & Pick<ActivityBody, 'type'>;
const read = (path: string, more: Partial<ActivityBody> = {}): Given => ({ type: 'read', name: 'imageView', summary: path, files: [{ path, line: null }], ...more });

function inChat(node: React.ReactNode) {
  return render(
    <OpenerContext value={createOpener(S)}>
      <AsideSourceContext value={{ sessionId: S, workerId: null }}>{node}</AsideSourceContext>
    </OpenerContext>,
  );
}
const strip = () => screen.queryByRole('list', { name: 'Images' });
const imageTabs = () => (useTabs.getState().sessions[S]?.tabs ?? []).filter((tab) => tab.kind === IMAGE_KIND);

describe('the image an activity read', () => {
  it('is a finished read of one file by an image’s name, in any letter case', () => {
    const body = (given: Given): ActivityBody => chatActivity(S, 't1', given).activity as ActivityBody;
    expect(imageRead(body(read(SHOT)))).toBe(SHOT);
    expect(imageRead(body(read('C:\\a\\B.JPEG')))).toBe('C:\\a\\B.JPEG');
    expect(imageRead(body(read(SHOT, { status: 'running' })))).toBeNull();
    expect(imageRead(body(read(SHOT, { status: 'failed' })))).toBeNull();
    expect(imageRead(body(read('C:\\a\\notes.txt')))).toBeNull();
    expect(imageRead(body(read('C:\\a\\icon.svg')))).toBeNull();
    expect(imageRead(body({ ...read(SHOT), files: [{ path: SHOT, line: null }, { path: 'C:\\a\\b.png', line: null }] }))).toBeNull();
    expect(imageRead(body({ ...read(SHOT), type: 'edit' }))).toBeNull();
  });
});

describe('under an activity group’s line', () => {
  const group = (items: readonly ConversationItem[]) => inChat(<ActivityGroup items={items} id="g1" current />);

  it('draws the images its agent read while the group stays closed, by the id main gave each, and opens one in the pane at a press', async () => {
    group([chatActivity(S, 't1', read(SHOT)), chatActivity(S, 't1', { type: 'command', name: 'commandExecution', summary: 'magick' })]);
    await flush();
    const article = screen.getByRole('article');
    expect(within(article).getAllByRole('button')[0]?.getAttribute('aria-expanded')).toBe('false');
    const image = within(strip() as HTMLElement).getByRole('img', { name: 'fable-crop-a.png' });
    expect(image.getAttribute('src')).toBe(imageFileAddress(ID));
    expect(screen.getByText('fable-crop-a.png')).toBeTruthy();
    expect(reads).toEqual([SHOT]);
    // Arrival opens no tab.
    expect(imageTabs()).toEqual([]);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'fable-crop-a.png' })); });
    await flush();
    expect(imageTabs().map((tab) => [tab.reference, (tab.viewState as { display: { file: string } }).display.file])).toEqual([[{ path: SHOT }, ID]]);
  });

  it('says an image its agent read is not available where main draws none of it, and asks again at its next drawing', async () => {
    answers = {};
    const items = [chatActivity(S, 't1', read(SHOT))];
    group(items);
    await flush();
    expect(within(strip() as HTMLElement).getByRole('img', { name: 'fable-crop-a.png: Image file no longer found' })).toBeTruthy();
    expect(screen.getByText(IMAGE_FILE_STORAGE_NOTE)).toBeTruthy();
    cleanup();
    group(items);
    await flush();
    expect(reads).toEqual([SHOT, SHOT]);
  });

  it.each([
    [{ outcome: 'refused', why: 'outside' }, 'Image location is not allowed'],
    [{ outcome: 'refused', why: 'no-answer' }, 'Image file could not be read'],
    [{ outcome: 'refused', why: 'not-image' }, 'Unsupported image or preview limit exceeded'],
    [{ outcome: 'refused', why: 'several' }, 'More than one image file matches this name'],
    [{ outcome: 'unshown', why: 'too-large', path: SHOT, root: 'C:\\work', line: null, column: null }, 'Image exceeds preview limits'],
  ] as const)('preserves the reader’s reason for %j', async (reply, reason) => {
    answers[SHOT] = reply;
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    expect(within(strip() as HTMLElement).getByRole('img', { name: `fable-crop-a.png: ${reason}` })).toBeTruthy();
    expect(screen.queryByText(IMAGE_FILE_STORAGE_NOTE)).toBeNull();
  });

  it('checks again when a previously admitted image fails to load, and explains a file that has gone', async () => {
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    answers = {};
    fireEvent.error(within(strip() as HTMLElement).getByRole('img'));
    await flush();
    expect(screen.getByText('Image file no longer found')).toBeTruthy();
    expect(reads).toEqual([SHOT, SHOT]);
    expect(screen.getByTitle(SHOT).textContent).toBe('fable-crop-a.png');
  });

  it('does not invent a missing-file reason or retry in a loop when its header still passes', async () => {
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    fireEvent.error(within(strip() as HTMLElement).getByRole('img'));
    await flush();
    expect(screen.getByText('Image preview could not be loaded')).toBeTruthy();
    expect(screen.queryByText(IMAGE_FILE_STORAGE_NOTE)).toBeNull();
    expect(reads).toEqual([SHOT, SHOT]);
    // Leaving the chat permits a fresh attempt, rather than permanently caching the failed draw.
    cleanup();
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    expect(within(strip() as HTMLElement).getByRole('img').getAttribute('src')).toBe(imageFileAddress(ID));
  });

  it('distinguishes a failed check from a missing file', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'unavailable' }));
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    expect(screen.getByText('Could not check the image file')).toBeTruthy();
    expect(screen.queryByText(IMAGE_FILE_STORAGE_NOTE)).toBeNull();
  });

  it('asks nothing for a read that is not finished, nor for another kind of file, and draws no row for them', async () => {
    group([chatActivity(S, 't1', read(SHOT, { status: 'running' })), chatActivity(S, 't1', read('C:\\work\\notes.txt'))]);
    await flush();
    expect(reads).toEqual([]);
    expect(strip()).toBeNull();
  });

  it('rereads a thumbnail at each press and updates its existing tab after the file is edited', async () => {
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'fable-crop-a.png' }));
    await flush();
    const nextId = 'b'.repeat(32);
    answers[SHOT] = { outcome: 'image', path: SHOT, id: nextId, width: 640, height: 480 };
    fireEvent.click(screen.getByRole('button', { name: 'fable-crop-a.png' }));
    await flush();
    expect(reads).toEqual([SHOT, SHOT, SHOT]);
    expect(imageTabs()).toHaveLength(1);
    expect(imageTabs()[0]?.viewState).toMatchObject({ display: { file: nextId } });
    expect(within(strip() as HTMLElement).getByRole('img').getAttribute('src')).toBe(imageFileAddress(nextId));
  });

  it('reports a file removed after its thumbnail loaded instead of opening its stale preview', async () => {
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    answers = {};
    fireEvent.click(screen.getByRole('button', { name: 'fable-crop-a.png' }));
    await flush();
    expect(screen.getByText('Image file no longer found')).toBeTruthy();
    expect(imageTabs()).toEqual([]);
  });

  it('does not open a tab when the user leaves before a thumbnail click finishes reading', async () => {
    group([chatActivity(S, 't1', read(SHOT))]);
    await flush();
    let finish!: (value: unknown) => void;
    bridge.setInvoke(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'fable-crop-a.png' }));
    cleanup();
    finish({ ok: true, value: answers[SHOT] });
    await flush();
    expect(imageTabs()).toEqual([]);
  });

  it('draws nothing where the chat has no session', async () => {
    render(<ActivityGroup items={[chatActivity(S, 't1', read(SHOT))]} id="g1" current />);
    await flush();
    expect(reads).toEqual([]);
    expect(strip()).toBeNull();
  });
});

describe('under a finished answer', () => {
  const answer = (text: string, overrides: Partial<ConversationItem> = {}) => chatItem(S, 'assistant', text, overrides);
  const message = (item: ConversationItem) => inChat(<Message item={item} modelName="Model" providerName="Provider" current />);

  it('draws the images its text names, each once, by the id main gave each; an address main draws nothing of is left out', async () => {
    answers[`C:\\tmp\\second.webp`] = { outcome: 'image', path: 'C:\\tmp\\second.webp', id: 'b'.repeat(32), width: 10, height: 10 };
    message(answer(`The capture is at \`${SHOT}\`, again \`${SHOT}\`, then \`C:\\tmp\\second.webp\`, \`C:\\tmp\\missing.png\` and \`notes.md\`.`));
    await flush();
    expect(reads.sort()).toEqual(['C:\\tmp\\missing.png', 'C:\\tmp\\second.webp', SHOT].sort());
    const images = within(strip() as HTMLElement).getAllByRole('img');
    expect(images.map((image) => image.getAttribute('src'))).toEqual([imageFileAddress(ID), imageFileAddress('b'.repeat(32))]);
  });

  it('asks nothing while the answer is being written, and draws its images once it is finished', async () => {
    const text = `The capture is at \`${SHOT}\`.`;
    const view = message(answer(text, { state: 'streaming' }));
    await flush();
    expect(reads).toEqual([]);
    expect(strip()).toBeNull();
    const done = answer(text);
    view.rerender(
      <OpenerContext value={createOpener(S)}>
        <AsideSourceContext value={{ sessionId: S, workerId: null }}><Message item={done} modelName="Model" providerName="Provider" current /></AsideSourceContext>
      </OpenerContext>,
    );
    await flush();
    expect(reads).toEqual([SHOT]);
    expect(within(strip() as HTMLElement).getByRole('img', { name: 'fable-crop-a.png' })).toBeTruthy();
  });

  it('opens a reference to an image in the image tab, wherever main read it', async () => {
    message(answer(`See \`${SHOT}\`.`));
    await flush();
    act(() => { fireEvent.click(screen.getByRole('button', { name: SHOT })); });
    await flush();
    expect(imageTabs().map((tab) => tab.reference)).toEqual([{ path: SHOT }]);
  });

  it('rereads an image named by a later answer instead of keeping the first answer’s lookup', async () => {
    message(answer(`See \`${SHOT}\`.`));
    await flush();
    const nextId = 'b'.repeat(32);
    answers[SHOT] = { outcome: 'image', path: SHOT, id: nextId, width: 640, height: 480 };
    cleanup();
    message(answer(`[Open the updated image](<${SHOT}>)`));
    await flush();
    expect(reads).toEqual([SHOT, SHOT]);
    expect(within(strip() as HTMLElement).getByRole('img').getAttribute('src')).toBe(imageFileAddress(nextId));
    fireEvent.click(screen.getByRole('button', { name: 'Open the updated image' }));
    await flush();
    expect(imageTabs()[0]?.viewState).toMatchObject({ display: { file: nextId } });
  });
});
