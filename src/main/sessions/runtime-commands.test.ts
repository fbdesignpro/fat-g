// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V18 (docs/planning/_archive/M23.md; C58–C64, C86, C87): the menu's rows through the session runtime — fat-g's
// own first and the CLI's of their names left out, the CLI's commands from its process, kept for the
// run once it ends, or from its instance for the session's folder, its skills last; the note before a
// process has run; and a chosen skill checked against the CLI's current list before anything is
// consumed, sent with the prompt where it is listed, and refused, with nothing sent, where it is not.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { MENU_WORDS } from '@shared/contracts/composer';
import type { ProviderStatus } from '@shared/contracts/status';
import type { ProviderCommand } from '@shared/provider-kit/sessions';
import { createBlobFiles } from '../attachments/files';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { createChatService } from './chat-service';
import { createGate } from './gate';
import { createRemoval } from './removal';
import { createSessionRuntime, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S1 = '5e551000-0000-4000-8000-000000000001';
const AT = Date.parse('2020-02-11T09:00:00.000Z');
const status: ProviderStatus = { kind: 'ok' };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let dir: string;
let records: RecordsStore;
let service: SessionService;
let runtime: SessionRuntime;
let conversations: ConversationStore;
let fake: FakeFacet;
let ids: number;

const row = (name: string, group: ProviderCommand['group'] = 'commands', selector: string | null = null): ProviderCommand => ({ name, description: `${name} words`, hint: null, group, selector });
const modelUsed = vi.fn();

function open(facet: Parameters<typeof fakeFacet>[0]): void {
  const session = { id: S1, projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: 'A session', nameSource: 'user', starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null };
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [{ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: ROOT, trust: { answer: 'trusted', answeredAt: '2020-01-23T00:00:00.000Z' } }] }], sessions: [session] }));
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => AT, log });
  fake = fakeFacet({ history: false, ...facet });
  const blobs = createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER));
  conversations = createConversationStore({ dir, log, blobs });
  const chat = createChatService({ store: conversations, log });
  let ready = false;
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null } } }),
    hasRuntime: () => true, project: (id) => records.getProject(id), isMissing: () => false, kept: (id) => (ready ? runtime.kept(id) : undefined), platform: 'win32',
  });
  service = createSessionService({ records, store: createAppStateStore(), now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome) });
  runtime = createSessionRuntime({
    modelUsed,
    sessions: service, records, chat, gate, log, now: () => AT, newId: () => `5e551000-0000-4000-9000-${String(++ids).padStart(12, '0')}`,
    facet: () => fake.facet, providerName: () => 'Claude', hasHistory: () => false, store: conversations, removal: createRemoval({ store: conversations, log }),
    composer: { store: conversations, blobs },
  });
  ready = true;
}

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-runtime-commands-')); ids = 0; modelUsed.mockReset(); });
afterEach(async () => {
  runtime?.dispose();
  // A record write still under way would make the folder again once it is removed.
  await service?.settled();
  service?.stop();
  conversations?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const OWN = [{ name: '/clear', kind: 'command-clear' as const }, { name: '/model', kind: 'command-model' as const }];

describe('the menu’s rows (V10; C58–C63, C86)', () => {
  it('does not count a command answered locally as a model use', async () => {
    open({ intercepts: () => 'command-model' });
    expect(await runtime.send(S1, '/model')).toEqual({ status: 'accepted' });
    expect(fake.made).toEqual([]);
    expect(modelUsed).not.toHaveBeenCalled();
  });
  it('says the CLI’s own come once the session has started, with fat-g’s two first, before any process ran', async () => {
    open({ commands: 'process', interceptedCommands: OWN, commandsOnceStarted: true });
    expect(await runtime.commands(S1)).toEqual({
      status: 'read',
      rows: [
        { name: 'clear', description: MENU_WORDS.own['command-clear'], hint: null, group: 'fat-g', selector: null },
        { name: 'model', description: MENU_WORDS.own['command-model'], hint: null, group: 'fat-g', selector: null },
      ],
      note: MENU_WORDS.notStarted('Claude'),
    });
  });

  it('lists its process’s commands and skills after fat-g’s, leaving out the CLI’s rows of fat-g’s names, and keeps them once that process ended', async () => {
    open({ commands: 'process', interceptedCommands: OWN, commandsOnceStarted: true });
    expect(await runtime.send(S1, 'Hello')).toEqual({ status: 'accepted' });
    fake.latest().listed = [row('marker', 'skills'), row('clear'), row('compact')];
    const answer = await runtime.commands(S1);
    if (answer.status !== 'read') throw new Error('not read');
    expect(answer.rows.map((entry) => [entry.name, entry.group])).toEqual([['clear', 'fat-g'], ['model', 'fat-g'], ['compact', 'commands'], ['marker', 'skills']]);
    expect(answer.note).toBeNull();
    fake.latest().end();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const after = await runtime.commands(S1);
    if (after.status !== 'read') throw new Error('not read');
    expect(after.rows.map((entry) => entry.name)).toContain('compact');
  });

  it('asks the instance for the session’s folder where its CLI lists skills with no process', async () => {
    const asked: string[] = [];
    open({ commands: (folder) => { asked.push(folder); return [row('m23-marker', 'skills', 'a'.repeat(32))]; } });
    const answer = await runtime.commands(S1);
    expect(asked).toEqual([ROOT]);
    expect(answer).toEqual({ status: 'read', rows: [row('m23-marker', 'skills', 'a'.repeat(32))], note: null });
  });

  it('refuses an unknown session', async () => {
    open({});
    expect(await runtime.commands('5e551000-0000-4000-8000-000000000099')).toEqual({ status: 'refused', reason: 'unknown-session' });
  });
});

describe('a chosen skill (V18; C64, C87)', () => {
  const skill = { name: 'm23-marker', selector: 'a'.repeat(32) };
  const intent = { plan: false, skill };

  it('goes with the prompt where its CLI lists it now', async () => {
    open({ commands: () => [row('m23-marker', 'skills', skill.selector)] });
    conversations.saveDraft(S1, 1, { text: '/m23-marker go', intent }, AT, false);
    expect(await runtime.send(S1, '/m23-marker go', { input: { revision: 2, attachmentIds: [], intent } })).toEqual({ status: 'accepted' });
    expect(fake.latest().sent[0]?.skill).toEqual(skill);
  });

  it('sends nothing, and consumes nothing, where its CLI no longer lists it', async () => {
    open({ commands: () => [row('another', 'skills', 'b'.repeat(32))] });
    conversations.saveDraft(S1, 1, { text: '/m23-marker go', intent }, AT, false);
    expect(await runtime.send(S1, '/m23-marker go', { input: { revision: 2, attachmentIds: [], intent } })).toEqual({ status: 'refused', reason: 'skill-unavailable' });
    expect(fake.made).toEqual([]);
    expect(conversations.draft(S1)?.text).toBe('/m23-marker go');
  });
});
