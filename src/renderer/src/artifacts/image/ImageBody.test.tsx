// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6 (docs/planning/_archive/M23.md; C8, C27): an image's tab — drawn through the media route by its hash,
// fitted to the pane and toggled to its actual size by a press or a key, titled by its name or its
// place, and said not available, with what is kept of it, where fat-g no longer holds its file.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_WORDS, attachmentAddress } from '@shared/contracts/attachments';
import { imageFileAddress } from '@shared/contracts/files';
import { invoke } from '../../ipc/client';
import { ImageBody, type ImageDisplay, type ImageReference, type ImageViewState } from './ImageBody';
import { IMAGE_WORDS } from './words';
import { IMAGE_FILE_STORAGE_NOTE } from '../../images/file-failure';

const HASH = 'c'.repeat(64);
vi.mock('../../ipc/client', () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockClear(); });

function show(display: ImageDisplay, actual = false, reference: ImageReference = HASH) {
  let state: ImageViewState = { display, actual };
  const setTitle = vi.fn();
  const setViewState = vi.fn((next: ImageViewState) => { state = next; view.rerender(body()); });
  const body = () => <ImageBody sessionId="s" reference={reference} viewState={state} setViewState={setViewState} setTitle={setTitle} />;
  const view = render(body());
  return { setTitle, setViewState, state: () => state };
}

describe('an image’s tab (V6; C27)', () => {
  it('draws the image by its hash, fitted, and toggles to its actual size and back at a press', () => {
    const tab = show({ name: 'cat.png', width: 1200, height: 800, available: true, ordinal: 1 });
    const image = screen.getByRole('img', { name: 'cat.png' });
    const controls = screen.getByRole('group', { name: 'Image controls' });
    expect([...controls.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Show in folder', 'Copy image']);
    expect(image.getAttribute('src')).toBe(attachmentAddress(HASH));
    const toggle = screen.getByRole('button', { name: IMAGE_WORDS.actual });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    act(() => { fireEvent.click(toggle); });
    expect(tab.state().actual).toBe(true);
    // A toggle keeps its name: pressed, it says so, and its tooltip says what a press does now.
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('title')).toBe(IMAGE_WORDS.fit);
    act(() => { fireEvent.click(toggle); });
    expect(tab.state().actual).toBe(false);
  });

  it('is titled by the image’s name, else by its place', () => {
    expect(show({ name: 'cat.png', width: 1, height: 1, available: true, ordinal: 3 }).setTitle).toHaveBeenCalledWith('cat.png');
    cleanup();
    expect(show({ name: null, width: 1, height: 1, available: true, ordinal: 3 }).setTitle).toHaveBeenCalledWith('Image 3');
  });

  it('says an image fat-g no longer holds is not available, with its name and size kept (C8)', () => {
    show({ name: 'gone.png', width: 640, height: 480, available: false, ordinal: 1 });
    expect(screen.getByText(IMAGE_WORDS.unavailable)).toBeTruthy();
    expect(screen.getByText(ATTACHMENT_WORDS.tooltip('gone.png', 640, 480))).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('says so too where the image fails to load', () => {
    show({ name: null, width: 10, height: 20, available: true, ordinal: 2 });
    act(() => { fireEvent.error(screen.getByRole('img')); });
    expect(screen.getByText(IMAGE_WORDS.unavailable)).toBeTruthy();
  });
});

describe('an image file’s tab (decision 0022, item 15)', () => {
  const PATH = 'C:\\Users\\someone\\AppData\\Local\\Temp\\fable-crop-a.png';
  const ID = 'a'.repeat(32);
  const FILE: ImageDisplay = { name: 'fable-crop-a.png', width: 640, height: 480, available: true, ordinal: 1, file: ID };

  it('draws the file by the id main gave it, never by its path, and asks main by its path to show it in its folder', async () => {
    show(FILE, false, { path: PATH });
    expect(screen.getByRole('img', { name: 'fable-crop-a.png' }).getAttribute('src')).toBe(imageFileAddress(ID));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show in folder' })); await Promise.resolve(); });
    expect(vi.mocked(invoke).mock.calls).toEqual([['files:showInFolder', { sessionId: 's', path: PATH }]]);
  });

  it('says it is not available where its id no longer draws, and tries a new id again', () => {
    let state: ImageViewState = { display: FILE };
    const body = () => <ImageBody sessionId="s" reference={{ path: PATH }} viewState={state} setViewState={vi.fn()} setTitle={vi.fn()} />;
    const view = render(body());
    act(() => { fireEvent.error(screen.getByRole('img')); });
    expect(screen.getByText('Image preview could not be loaded')).toBeTruthy();
    state = { display: { ...FILE, file: 'b'.repeat(32) } };
    view.rerender(body());
    expect(screen.getByRole('img').getAttribute('src')).toBe(imageFileAddress('b'.repeat(32)));
  });

  it('explains when the original file disappeared after opening its tab', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ outcome: 'refused', why: 'not-found' });
    show(FILE, false, { path: PATH });
    await act(async () => { fireEvent.error(screen.getByRole('img')); await Promise.resolve(); });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('files:read', { sessionId: 's', target: PATH });
    expect(screen.getByText('Image file no longer found')).toBeTruthy();
    expect(screen.getByText(IMAGE_FILE_STORAGE_NOTE)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Copy image' }).disabled).toBe(true);
  });

  it('retries a failed preview at the next explicit opening even when its id is unchanged', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ outcome: 'refused', why: 'not-found' });
    let state: ImageViewState = { display: FILE, serial: 1, actual: true };
    const body = () => <ImageBody sessionId="s" reference={{ path: PATH }} viewState={state} setViewState={vi.fn()} setTitle={vi.fn()} />;
    const view = render(body());
    const first = screen.getByRole('img');
    await act(async () => { fireEvent.error(first); await Promise.resolve(); });
    expect(screen.getByText('Image file no longer found')).toBeTruthy();
    state = { ...state, serial: 2 };
    view.rerender(body());
    const retried = screen.getByRole('img');
    expect(retried).not.toBe(first);
    expect(retried.getAttribute('src')).toBe(imageFileAddress(ID));
    expect(screen.getByRole('button', { name: IMAGE_WORDS.actual }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Image file no longer found')).toBeNull();
  });
});
