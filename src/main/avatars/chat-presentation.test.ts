// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EFFORT_LOOK } from '@shared/contracts/avatar-overlay';
import type { Assignments, AvatarRef, AvatarSource, ResolvedAvatar } from '@shared/contracts/avatars';
import type { ChatPresentation, ChatPush } from '@shared/contracts/chat';
import type { NewItem } from '../conversations/store';
import { scratch, type Scratch } from '../conversations/test-support';
import { createChatService } from '../sessions/chat-service';
import { startChatPush } from '../state/chat-push';
import { createAvatarResolver } from './assignments';
import { createChatPresentation } from './chat-presentation';

const ID = '5e551000-0000-4000-8000-000000000001';
const ref = (avatar: string): AvatarRef => ({ origin: 'user', family: 'Faces', avatar });
const face = (avatar: string, portrait = `portrait-${avatar}`): ResolvedAvatar => ({ ref: ref(avatar), portrait, small: null });
/** A model's resolution: the avatar, why, and fat-g's marks alone, the test's provider reading no version. */
const drawn = (avatar: string, source: AvatarSource): ResolvedAvatar => ({ ...face(avatar), source, overlay: { text: null, effort: DEFAULT_EFFORT_LOOK, fast: DEFAULT_EFFORT_LOOK } });
let area: Scratch | undefined;
afterEach(() => { area?.dispose(); area = undefined; });

function setup() {
  let selected: string | null = ID;
  let assignments: Assignments = { claude: { 'unlisted-model': ref('Assigned') } };
  const files = new Map([['Assigned', face('Assigned')], ['Replacement', face('Replacement')]]);
  let fallback: ResolvedAvatar | null = face('Default');
  const resolver = createAvatarResolver({
    avatars: { assigned: (value) => files.get(value.avatar) ?? null, defaultFace: () => fallback, family: () => undefined, defaultFamily: () => null, layers: () => [] },
    preferences: () => ({ assignments, active: {} }),
  });
  const presentation = createChatPresentation({ selected: () => selected, session: (id) => id === ID ? { providerId: 'claude', instanceId: 'default', model: 'parent-model' } : null, catalog: () => undefined, resolver });
  area = scratch();
  const chat = createChatService({ store: area.open(), presentation });
  chat.ensure(ID, 'checked');
  chat.accept(ID, { turnId: 't1', itemId: 'prompt', text: 'a prompt', at: 1, started: false });
  const add = (model = 'unlisted-model'): void => {
    const item: NewItem = { id: `answer-${model}`, kind: 'message', origin: 'local', providerItemId: null, role: 'assistant', phase: 'final', text: 'an answer', cut: false, questions: [], notice: null, detail: null, receivedAt: 2, providerAt: null, model };
    chat.add(ID, 't1', item);
  };
  return { presentation, chat, add, files, assign: (value: Assignments) => { assignments = value; }, fallback: (value: ResolvedAvatar | null) => { fallback = value; }, select: (id: string | null) => { selected = id; presentation.select(); } };
}

describe('main-resolved conversation avatars', () => {
  it('projects an unlisted reply model on reads, pages and item pushes without storing its avatar', () => {
    const { chat, add } = setup();
    const pushes: ChatPush[] = [];
    chat.subscribe((push) => pushes.push(push));
    add();
    const read = chat.read(ID, null, false);
    expect(read?.presentation?.models['unlisted-model']).toEqual(drawn('Assigned', 'override'));
    expect(pushes.at(-1)?.presentation?.models['unlisted-model']).toEqual(drawn('Assigned', 'override'));
    const page = chat.page(ID, 'answer-unlisted-model');
    expect(page?.status === 'page' && page.presentation?.models['parent-model']).toEqual(drawn('Default', 'built-in-face'));
    expect(area?.holding('portrait-Assigned')).toEqual([]);
  });

  it('resolves a stored worker absent from the session list, and retains it for future refreshes', () => {
    const { chat, presentation } = setup();
    chat.activityStarted(ID, 't1', { itemId: 'work', workerId: null, start: { type: 'worker', name: 'Agent', workerId: 'retired-worker', summary: 'old worker', model: 'unlisted-model' }, providerAt: null });
    const read = chat.readWorker(ID, 'retired-worker');
    expect(read?.status === 'read' && read.presentation?.workers['retired-worker']).toEqual({ model: 'unlisted-model', assumed: false });
    expect(read?.status === 'read' && read.presentation?.models['unlisted-model']).toEqual(drawn('Assigned', 'override'));
    const update = vi.fn<(id: string, value: ChatPresentation) => void>(); presentation.subscribe(update); presentation.changed();
    expect(update.mock.calls[0]?.[1].models['unlisted-model']).toEqual(drawn('Assigned', 'override'));
  });

  it('refreshes loaded identities after reassignment, missing art, a rescan and a missing default', () => {
    const { chat, add, presentation, files, assign, fallback } = setup();
    add(); chat.read(ID, null, false);
    const revision = chat.read(ID, null, false)?.revision;
    const updates: ChatPush[] = [];
    chat.subscribe((push) => updates.push(push));
    assign({ claude: { 'unlisted-model': ref('Replacement') } }); presentation.changed();
    expect(updates.at(-1)?.presentation?.models['unlisted-model']).toEqual(drawn('Replacement', 'override'));
    files.delete('Replacement'); presentation.changed();
    expect(updates.at(-1)?.presentation?.models['unlisted-model']).toEqual(drawn('Default', 'built-in-face'));
    files.set('Replacement', face('Replacement', 'rescanned-image')); presentation.changed();
    expect(updates.at(-1)?.presentation?.models['unlisted-model']?.portrait).toBe('rescanned-image');
    assign({}); fallback(null); presentation.changed();
    expect(updates.at(-1)?.presentation?.models['unlisted-model']).toBeNull();
    expect(updates.every((push) => 'presentationOnly' in push && push.revision === revision)).toBe(true);
    expect(updates.map((push) => push.presentation?.revision)).toEqual([1, 2, 3, 4]);
  });

  it('clears projected identities on selection changes and sends presentation only to Main', () => {
    const { chat, add, presentation, select } = setup();
    add(); chat.read(ID, null, false);
    const send = vi.fn(); const pet = vi.fn();
    startChatPush({ chat, selected: () => ID, targets: () => [{ kind: 'main', isAlive: () => true, send }, { kind: 'pet', isAlive: () => true, send: pet }] });
    presentation.changed();
    expect(send).toHaveBeenCalledOnce(); expect(pet).not.toHaveBeenCalled();
    select(null); select(ID); presentation.changed();
    expect((send.mock.calls.at(-1)?.[1] as ChatPush).presentation?.models['unlisted-model']).toBeUndefined();
    chat.dispose();
  });
});
