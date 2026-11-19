// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6 (docs/planning/_archive/M23.md; C8, C26, C27): a user's message's images — under its text, by their
// ownership, each drawn through the media route with its name or its size, a press opening its tab,
// and an image fat-g no longer holds said in words with what is kept of it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_WORDS, type AttachmentView, attachmentAddress } from '@shared/contracts/attachments';
import { IMAGE_KIND } from '../artifacts/opener';
import { BUILT_IN_KINDS } from '../artifacts/kinds';
import { registerKinds, resetTabs, useTabs } from '../artifacts/tabs-store';
import { chatItem } from '../test/chat';
import { AsideSourceContext } from './ExplainControl';
import { Message } from './Message';

const S = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);
const image = (id: string, patch: Partial<AttachmentView> = {}): AttachmentView => ({ id, hash: HASH, mediaType: 'image/png', bytes: 10, width: 1200, height: 800, name: null, available: true, ...patch } as AttachmentView);

beforeEach(() => { resetTabs(); registerKinds(BUILT_IN_KINDS); });
afterEach(cleanup);

const show = (images: readonly AttachmentView[], text = 'Look at these') =>
  render(
    <AsideSourceContext value={{ sessionId: S, workerId: null }}>
      <Message item={chatItem(S, 'user', text, { attachments: images })} modelName="GPT-6 Sol" providerName="Codex" current />
    </AsideSourceContext>,
  );

describe('a message’s images (V6; C26)', () => {
  it('shows returned images on an assistant message through the same media route', () => {
    render(<AsideSourceContext value={{ sessionId: S, workerId: null }}><Message item={chatItem(S, 'assistant', '', { attachments: [image('generated', { name: 'Generated image' })] })} modelName="GPT-6 Sol" providerName="Codex" current /></AsideSourceContext>);
    expect(screen.getByRole('img', { name: 'Generated image' }).getAttribute('src')).toBe(attachmentAddress(HASH));
    fireEvent.click(screen.getByRole('button', { name: 'Generated image' }));
    expect(useTabs.getState().sessions[S]?.tabs.some((tab) => tab.kind === IMAGE_KIND)).toBe(true);
  });

  it('numbers nameless images and keeps their dimensions in compact captions', () => {
    show([image('u1', { width: 256, height: 49 }), image('u2', { width: 320, height: 100 })]);
    expect(screen.getByText('Image 1, 256x49')).toBeTruthy();
    expect(screen.getByText('Image 2, 320x100')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Image 1, 256x49' })).toBeTruthy();
  });

  it('draws each under the text, through the media route, labelled by its name or its size', () => {
    show([image('u1', { name: 'cat.png' }), image('u2', { hash: 'b'.repeat(64) })]);
    const list = screen.getByRole('list', { name: 'Images' });
    const images = within(list).getAllByRole('img');
    expect(images.map((element) => element.getAttribute('alt'))).toEqual(['cat.png', 'Image 2, 1200x800']);
    expect(images[1]?.getAttribute('src')).toBe(attachmentAddress('b'.repeat(64)));
    expect(within(list).getByText('cat.png, 1200x800')).toBeTruthy();
    // After the text, in the message.
    const article = screen.getByRole('article');
    expect(article.textContent?.indexOf('Look at these')).toBeLessThan(article.textContent?.indexOf('cat.png') ?? 0);
  });

  it('uses a paste’s saved session label in its caption and image tab', () => {
    show([image('u1', { name: 'Pasted image 7' })]);
    expect(screen.getByText('Pasted image 7, 1200x800')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pasted image 7' }));
    const tab = useTabs.getState().sessions[S]?.tabs[0];
    expect(tab?.viewState).toMatchObject({ display: { name: 'Pasted image 7' } });
  });

  it('opens a pressed image in its tab by its hash, titled by its name or its place', () => {
    show([image('u1', { name: 'cat.png' }), image('u2', { hash: 'b'.repeat(64) })]);
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Image 2, 1200x800' })); });
    const tabs = useTabs.getState().sessions[S]?.tabs ?? [];
    expect(tabs.map((tab) => [tab.kind, tab.reference])).toEqual([[IMAGE_KIND, 'b'.repeat(64)]]);
    expect(tabs[0]?.viewState).toMatchObject({ display: { name: null, width: 1200, height: 800, available: true, ordinal: 2 } });
    const first = (tabs[0]?.viewState as { serial: number }).serial;
    fireEvent.click(screen.getByRole('button', { name: 'Image 2, 1200x800' }));
    const reopened = useTabs.getState().sessions[S]?.tabs ?? [];
    expect(reopened).toHaveLength(1);
    expect((reopened[0]?.viewState as { serial: number }).serial).toBeGreaterThan(first);
  });

  it('says an image fat-g no longer holds is not available, keeping its name and size, and the text stands (C8)', () => {
    show([image('u1', { name: 'gone.png', available: false }), { id: 'u2', hash: null, available: false, name: null }]);
    const missing = screen.getAllByRole('img');
    expect(missing.map((element) => element.getAttribute('aria-label'))).toEqual([`gone.png, 1200x800: ${ATTACHMENT_WORDS.unavailable}`, ATTACHMENT_WORDS.unavailable]);
    expect(screen.queryAllByRole('button', { name: /gone/ })).toEqual([]);
    expect(screen.getByText('Look at these')).toBeTruthy();
  });

  it('draws one that fails to load as not available too', () => {
    show([image('u1', { name: 'broken.png' })]);
    act(() => { fireEvent.error(screen.getByRole('img', { name: 'broken.png' })); });
    expect(screen.getByRole('img', { name: `broken.png, 1200x800: ${ATTACHMENT_WORDS.unavailable}` })).toBeTruthy();
  });

  it('draws no image row for a message with none', () => {
    show([]);
    expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  });
});
