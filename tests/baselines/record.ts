// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The stored formats' baselines (decision 0014, item 4). Each format fat-g keeps in its own format
// has one synthetic document in tests/fixtures/baselines/ at the version this build writes, made
// by the build's own writer under a fixed clock and fixed ids, so that the same build records the
// same bytes. `recordBaselines` writes the whole set into a folder: the baseline test records into
// a scratch folder and holds the committed files to it, and do-record-baselines.bat
// (tests/baselines/record.test.ts) writes a missing one into the fixtures folder.
//
// Nothing here is personal: the paths, the names and the ids are invented. No test library is
// imported, so that the recorder runs under the test and under the wrapper alike.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AsideSource } from '@shared/contracts/aside';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { CATALOG_VERSION } from '@shared/contracts/catalog';
import { NO_INTENT } from '@shared/contracts/composer';
import { type ApprovalRequest, type InteractionQuestion, raisedPlan } from '@shared/contracts/interaction';
import { PREFERENCES_VERSION } from '@shared/contracts/prefs';
import { createBlobFiles, sha256 } from '../../src/main/attachments/files';
import { readAttachmentHeader } from '../../src/main/attachments/headers';
import { manifestAdding, seededManifest } from '../../src/main/avatars/authoring';
import { parseManifest } from '../../src/main/avatars/manifest';
import { CONVERSATIONS_VERSION, STORE_FILE } from '../../src/main/conversations/format';
import { type ConversationStore, createConversationStore, type NewItem } from '../../src/main/conversations/store';
import { pngBytes } from '../../src/main/images/test-support';
import { PLAN_SCHEMA_VERSION, type PlanFileRecord, planDocument } from '../../src/main/plans/format';
import { REVIEW_SCHEMA_VERSION, type ReviewRecord, reviewDocument } from '../../src/main/plans/review-format';
import { createPreferencesStore, PREFERENCES_FILE } from '../../src/main/prefs/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../../src/main/records/format';
import { createRecordsStore } from '../../src/main/records/store';
import { serializeJson } from '../../src/main/storage/json-file';
import { createDiscoveryHistory, PROVIDER_DISCOVERY_FILE } from '../../src/main/storage/provider-discovery-history';

/** Where the committed baselines are. */
export const BASELINES_DIR = path.resolve(import.meta.dirname, '../fixtures/baselines');

export type FormatId = 'preferences' | 'records' | 'conversations' | 'plan' | 'review' | 'family' | 'catalog' | 'provider-detection' | 'reset-on-next-start';

export interface Format {
  readonly id: FormatId;
  /** The version this build writes. */
  readonly version: number;
  /** `<id>-v<version>.<json|sql>`: a baseline's file name, in the fixtures folder. */
  readonly file: string;
}

const format = (id: FormatId, version: number, extension: 'json' | 'sql'): Format => ({ id, version, file: `${id}-v${version}.${extension}` });

/**
 * Every format, with the version its module writes. The two markers' version is a literal in their
 * modules (src/main/storage/provider-discovery-history.ts, src/main/app/data-reset.ts): the
 * recording holds the number here to what they write.
 */
export const FORMATS: readonly Format[] = [
  format('preferences', PREFERENCES_VERSION, 'json'),
  format('records', RECORDS_VERSION, 'json'),
  format('conversations', CONVERSATIONS_VERSION, 'sql'),
  format('plan', PLAN_SCHEMA_VERSION, 'json'),
  format('review', REVIEW_SCHEMA_VERSION, 'json'),
  format('family', MANIFEST_VERSION, 'json'),
  format('catalog', CATALOG_VERSION, 'json'),
  format('provider-detection', 1, 'json'),
  format('reset-on-next-start', 1, 'json'),
];

/** A baseline's file name, taken apart: its format and its version. */
export const BASELINE_FILE = /^([a-z-]+)-v(\d+)\.(json|sql)$/;

// ── The fixed world the baselines are written in ──────────────────────────────────────────────

/** The clock's start: 2020-03-04 12:00 UTC. */
export const AT = Date.UTC(2020, 2, 4, 12, 0, 0);
const at = (seconds: number): number => AT + seconds * 1000;
/** A clock that moves a second at each reading. */
const clock = (): (() => number) => { let n = 0; return () => at((n += 1)); };
/** The n-th invented id, a UUID in form. */
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = (): (() => string) => { let n = 0; return () => uuid((n += 1)); };
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };
const PROVIDERS = ['claude', 'codex'] as const;
/** The account the preferences add for Codex: the first id the preferences store asks for. */
const WORK_INSTANCE = uuid(1);
/** The invented project folders, Windows paths: every reader is told `win32`. */
const HARBOUR = 'D:\\Projects\\harbour-tools';
const HARBOUR_DOCS = 'D:\\Projects\\harbour-docs';
const WORK_FOLDER = 'D:\\Accounts\\codex-work';
/** The conversations: a chat, an aside on it, and a second chat of the same plan. */
const CHAT = '11111111-1111-4111-8111-111111111111';
const ASIDE = '33333333-3333-4333-8333-333333333333';
const SECOND = '22222222-2222-4222-8222-222222222222';
const REVIEWER = '55555555-5555-4555-8555-555555555555';
const PROJECT = uuid(1);
const PLAN = uuid(7);
const REVIEW = uuid(8);
const INTEGRATION = uuid(9);

async function inScratch<T>(name: string, work: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), `fatg-baseline-${name}-`));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const fileOf = (id: FormatId): string => {
  const found = FORMATS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no format ${id}`);
  return found.file;
};

// ── preferences.json ──────────────────────────────────────────────────────────────────────────

async function recordPreferences(into: string): Promise<void> {
  await inScratch('preferences', (dir) => {
    const store = createPreferencesStore({ dir, providerIds: [...PROVIDERS], platform: 'win32', now: () => AT, newId: ids(), writeDelayMs: 60_000, log: QUIET });
    // Every section, away from its default.
    store.patch({
      windows: {
        main: { bounds: { x: 120, y: 80, width: 1600, height: 900 }, maximized: false },
        pet: { visible: true, autoHideOnMainFocus: false, bounds: { x: 1740, y: 80, width: 180, height: 420 }, size: 'capsule' },
      },
      providers: {
        claude: { enabled: true, executablePath: 'D:\\Tools\\claude\\claude.cmd', permissionMode: 'ask-first', label: 'Personal' },
        codex: { enabled: false, executablePath: null, permissionMode: 'read-only' },
      },
      usage: { pollIntervalSec: 600 },
      privacy: { maskEmail: false },
      audio: { muted: false, volume: 0.25, sounds: { rollover: 'button.wav', click: null, question: 'question.wav' } },
      appearance: { theme: 'light', doneAnimation: 'animation-only', creationAnimation: 'none', flash: { enabled: true, speed: 'slow', seconds: 5 } },
      layout: { projectColumn: 'right' },
      chat: { messageTimes: true, hoverMessageTimes: false, answerTimes: false, username: 'Harbour master' },
      titles: { generated: false, models: { claude: 'haiku', codex: '$session' } },
      composer: { busyEnter: 'queue' },
      presets: { [uuid(4)]: { name: 'Quick notes', providerId: 'codex', instanceId: 'default', model: 'gpt-5.5', effort: 'low', speed: 'fast' } },
      usePreset: uuid(4),
      avatars: {
        assignments: { claude: { sonnet: { origin: 'built-in', family: 'Claude Lightning', avatar: 'Sonnet' }, opus: { origin: 'user', family: 'Harbour', avatar: 'Navigator' } } },
        active: { codex: { origin: 'built-in', family: 'Codex Lightning' } },
      },
    });
    const added = store.addInstance('codex', { label: 'Work', folder: WORK_FOLDER });
    if (added.status !== 'saved' || added.id !== WORK_INSTANCE) throw new Error(`the added account is not ${WORK_INSTANCE}: ${JSON.stringify(added)}`);
    store.noteModelUse({ providerId: 'claude', instanceId: 'default', model: 'opus', effort: 'high', speed: null });
    store.noteModelUse({ providerId: 'codex', instanceId: WORK_INSTANCE, model: 'gpt-5.5', effort: 'low', speed: 'fast' });
    store.flushSync();
    store.dispose();
    copyFileSync(path.join(dir, PREFERENCES_FILE), path.join(into, fileOf('preferences')));
  });
}

// ── records.json ──────────────────────────────────────────────────────────────────────────────

async function recordRecords(into: string): Promise<void> {
  await inScratch('records', async (dir) => {
    const store = createRecordsStore({ dir, providerIds: [...PROVIDERS], platform: 'win32', now: clock(), newId: ids(), log: QUIET });
    const picked = (): boolean => true;
    const harbour = await store.add({ name: 'Harbour tools', color: 'teal', roots: [{ path: HARBOUR, trust: 'trusted' }, { path: HARBOUR_DOCS, trust: 'not-trusted' }], providers: [...PROVIDERS], permissionModes: { claude: 'ask-first' } }, picked);
    const archive = await store.add({ name: 'Archive', color: 'grey', roots: [{ path: 'E:\\Archive', trust: 'trusted' }], providers: ['codex'] }, picked);
    if (harbour.status !== 'saved' || archive.status !== 'saved') throw new Error('a project was not saved');
    if (harbour.id !== PROJECT) throw new Error(`the first project is not ${PROJECT}: ${harbour.id}`);
    await store.setHidden(archive.id, true);
    // A started, named and starred Claude session, to verify.
    const tides = await store.createSession({ projectId: harbour.id, providerId: 'claude', instanceId: 'default', model: 'sonnet', effort: 'high', speed: null });
    // A completed Codex session on the added account, at a speed, named after its first prompt, to do.
    const docs = await store.createSession({ projectId: harbour.id, providerId: 'codex', instanceId: WORK_INSTANCE, model: 'gpt-5.5', effort: 'low', speed: 'fast' });
    // A session never started, named by the user and shelved.
    const ideas = await store.createSession({ projectId: archive.id, providerId: 'claude', instanceId: 'default', model: 'haiku', effort: null, speed: null });
    if (tides.status !== 'saved' || docs.status !== 'saved' || ideas.status !== 'saved') throw new Error('a session was not saved');
    await store.changeSession(tides.id, () => ({
      reference: 'claude-session-ref-1', folder: HARBOUR, configFolder: null, name: 'Tide tables', nameSource: 'generated', starred: true, toVerify: true,
      lastActiveAt: at(40), lastTurn: { turnId: 'turn-5', startedAt: at(24), endedAt: at(26), outcome: 'completed' },
    }));
    await store.changeSession(docs.id, () => ({
      reference: 'thread-codex-2', folder: HARBOUR_DOCS, configFolder: WORK_FOLDER, name: 'Which files mention the tide tables?', nameSource: 'first-message', toDo: true,
      completedAt: at(50), lastActiveAt: at(50), lastTurn: { turnId: 'turn-1', startedAt: at(45), endedAt: at(49), outcome: 'interrupted' },
    }));
    await store.changeSession(ideas.id, () => ({ name: 'Scratch ideas', nameSource: 'user', shelvedAt: at(60), lastActiveAt: at(60) }));
    // Last: creating a session unfolds its project.
    await store.setCollapsed(harbour.id, true);
    copyFileSync(path.join(dir, RECORDS_FILE), path.join(into, fileOf('records')));
  });
}

// ── conversations.sqlite ──────────────────────────────────────────────────────────────────────

const QUESTION: InteractionQuestion = { text: 'Which file should I read first?', header: 'File', options: [{ label: 'src/tides.js', description: 'The tide functions' }, { label: 'README.md', description: null }], multiple: false, freeText: true, secret: false };
const REQUEST: ApprovalRequest = {
  kind: 'command', tool: 'Bash', summary: 'rg -n tide src', folder: HARBOUR, targets: [], outside: false, reason: 'To find every mention of the tides', authority: [{ kind: 'mode', mode: 'ask-first' }],
  detail: { kind: 'command', command: 'rg -n tide src' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(rg:*)' }, modeThatWouldStop: null, cut: false,
};
const SOURCE: AsideSource = { kind: 'message', itemId: 'answer-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 1, last: 1 }, range: { start: 0, end: 45 }, digest: '0badc0de', excerpt: 'Two files mention them: `src/tides.js` and', cut: false };

function message(id: string, role: 'user' | 'assistant', text: string, patch: Partial<NewItem> = {}): NewItem {
  return { id, kind: 'message', origin: 'provider', providerItemId: null, role, phase: role === 'assistant' ? 'final' : null, text, cut: false, questions: [], notice: null, detail: null, receivedAt: at(0), providerAt: null, ...patch };
}

/** The chat's turns, as the runtime writes them: each kind of item and each kind of end. */
async function fillStore(store: ConversationStore, dir: string): Promise<void> {
  // The chat, made with its session, its mode from the project's default.
  store.createConversation(CHAT, at(0), { id: 'ask-first', source: 'project' });
  // Turn 1: a prompt at a speed, a command, a sub-agent and its message, a question, an approval with its grant, and the answer.
  store.acceptPrompt({ conversationId: CHAT, turnId: 'turn-1', itemId: 'prompt-1', text: 'Which files mention the tide tables?', at: at(1), started: false, speed: { id: 'fast', name: 'Fast' } });
  store.providerTook(CHAT, 'turn-1', 'provider-turn-1');
  store.addActivity(CHAT, 'turn-1', { id: 'activity-1', origin: 'provider', providerItemId: 'call-1', workerId: null, start: { type: 'command', name: 'commandExecution', summary: 'rg -n tide src', input: 'rg -n tide src', files: [{ path: 'src/tides.js', line: 12 }] }, receivedAt: at(2), providerAt: at(2) });
  store.endActivity(CHAT, 'turn-1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'src/tides.js:12:function nextHighTide(now) {\n', exitCode: 0, duration: { ms: 180, provenance: 'provider' } });
  store.addActivity(CHAT, 'turn-1', { id: 'activity-2', origin: 'provider', providerItemId: 'agent-1', workerId: null, start: { type: 'worker', name: 'Agent', summary: 'Reads the harbour notes', workerId: 'worker-1', model: 'haiku', agentType: 'general-purpose' }, receivedAt: at(3), providerAt: at(3) });
  store.addItem(CHAT, 'turn-1', message('worker-answer-1', 'assistant', 'The notes mention the tide tables twice.', { providerItemId: 'msg-w1', workerId: 'worker-1', receivedAt: at(4), providerAt: at(4) }));
  store.endActivity(CHAT, 'turn-1', { providerItemId: 'agent-1', workerId: null }, { status: 'completed', duration: { ms: 2400, provenance: 'provider' } });
  store.addInteraction(CHAT, 'turn-1', { id: 'card-1', origin: 'provider', providerItemId: 'tool-ask-1', workerId: null, mode: 'blocking', questions: [QUESTION], cut: false, receivedAt: at(5), providerAt: null });
  store.setInteraction(CHAT, 'card-1', 'pending', { outcome: 'answered', answers: [{ options: [0], text: null, secret: false }], settledAt: at(6) });
  store.setInteraction(CHAT, 'card-1', 'answered', { confirmedAt: at(6) + 200 });
  store.addInteraction(CHAT, 'turn-1', { id: 'approval-1', origin: 'provider', providerItemId: 'tool-bash-2', workerId: null, request: REQUEST, receivedAt: at(7), providerAt: null });
  store.setInteraction(CHAT, 'approval-1', 'pending', { outcome: 'approved-session', decidedAt: at(8), grant: { covers: 'Bash(rg:*)', processKey: 'process-1' } });
  store.setInteraction(CHAT, 'approval-1', ['approved-session'], { delivered: true });
  store.setInteraction(CHAT, 'approval-1', ['approved-session'], { confirmedAt: at(8) + 300 });
  store.addItem(CHAT, 'turn-1', message('answer-1', 'assistant', 'Two files mention them: `src/tides.js` and `README.md`.', { providerItemId: 'msg-1', model: 'sonnet', receivedAt: at(9), providerAt: at(9) }));
  store.providerEnded(CHAT, 'turn-1', 'completed', at(10), 'msg-1', 9000);
  store.sessionEnded(CHAT, 'turn-1', at(10), 'completed');
  // Turn 2: a plan turn, whose plan came in a request.
  store.acceptPrompt({ conversationId: CHAT, turnId: 'turn-2', itemId: 'prompt-2', text: 'Plan a refactor of the tide functions', at: at(11), started: true, plan: true });
  store.providerTook(CHAT, 'turn-2', 'provider-turn-2');
  store.addPlan(CHAT, 'turn-2', { id: 'line-1', providerItemId: 'tool-plan-1', body: raisedPlan({ planId: PLAN, version: 1, came: 'made', request: true }), receivedAt: at(12) });
  store.providerEnded(CHAT, 'turn-2', 'completed', at(13), null, 2000);
  store.sessionEnded(CHAT, 'turn-2', at(13), 'completed');
  // Turn 3: the decision, a prompt fat-g composed for the plan, and a notice of fat-g's own.
  store.acceptPrompt({ conversationId: CHAT, turnId: 'turn-3', itemId: 'prompt-3', text: 'Implement the plan as written.', at: at(14), started: true, fields: { planId: PLAN, version: 1, intent: 'execute' }, deciding: { itemId: 'line-1', outcome: 'executed' } });
  store.providerTook(CHAT, 'turn-3', 'provider-turn-3');
  store.addItem(CHAT, 'turn-3', message('answer-3', 'assistant', 'Done: the tide functions are in one module now.', { providerItemId: 'msg-3', model: 'sonnet', receivedAt: at(15), providerAt: at(15) }));
  store.addItem(CHAT, 'turn-3', { id: 'notice-1', kind: 'notice', origin: 'local', providerItemId: null, role: null, phase: null, text: 'Plan mode left.', cut: false, questions: [], notice: 'plan-mode-left', detail: null, receivedAt: at(16), providerAt: null });
  store.providerEnded(CHAT, 'turn-3', 'completed', at(16), 'msg-3', 1800);
  store.sessionEnded(CHAT, 'turn-3', at(16), 'completed');
  // Turn 4: a message sent into the running turn, an answer never finished, a gap, and an interruption.
  store.acceptPrompt({ conversationId: CHAT, turnId: 'turn-4', itemId: 'prompt-4', text: 'Now update the docs', at: at(17), started: true });
  store.providerTook(CHAT, 'turn-4', 'provider-turn-4');
  store.saveDraft(CHAT, 1, { text: 'Also check the README', intent: NO_INTENT }, at(18), true);
  store.acceptSteer({ conversationId: CHAT, turnId: 'turn-4', itemId: 'steer-1', text: 'Also check the README', at: at(19), from: { draft: { revision: 2, text: 'Also check the README', intent: NO_INTENT, attachmentIds: [] } } });
  store.setDelivery(CHAT, 'steer-1', { state: 'taken', detail: null });
  store.addItem(CHAT, 'turn-4', message('answer-4', 'assistant', 'Updating the README', { providerItemId: 'msg-4', phase: null, complete: false, receivedAt: at(20), providerAt: at(20) }));
  store.markGap(CHAT, 'turn-4');
  store.providerEnded(CHAT, 'turn-4', 'interrupted', at(21), null, 3500);
  store.sessionEnded(CHAT, 'turn-4', at(21), 'interrupted');
  // Turn 5: a prompt with an image from the draft. The same image is staged again for the queue below: one blob, two uses.
  const bytes = pngBytes(3, 2);
  const header = readAttachmentHeader(bytes);
  if (header.kind !== 'image') throw new Error('the fixture image is no image');
  const hash = sha256(bytes);
  await createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER)).write(hash, header.mediaType, bytes);
  const blob = { hash, mediaType: header.mediaType, bytes: bytes.byteLength, width: header.width, height: header.height, stagedAt: at(22) };
  store.stageDraft(CHAT, blob, { id: 'use-1', name: 'harbour.png' }, at(22), true);
  store.saveDraft(CHAT, 3, { text: 'What is in this screenshot?', intent: NO_INTENT }, at(23), true);
  store.acceptPrompt({ conversationId: CHAT, turnId: 'turn-5', itemId: 'prompt-5', text: 'What is in this screenshot?', at: at(24), started: true, from: { draft: { revision: 4, text: 'What is in this screenshot?', intent: NO_INTENT, attachmentIds: ['use-1'] } } });
  store.providerTook(CHAT, 'turn-5', 'provider-turn-5');
  store.addItem(CHAT, 'turn-5', message('answer-5', 'assistant', 'A harbour at low tide.', { providerItemId: 'msg-5', model: 'sonnet', receivedAt: at(25), providerAt: at(25) }));
  store.providerEnded(CHAT, 'turn-5', 'completed', at(26), 'msg-5', 1200);
  store.sessionEnded(CHAT, 'turn-5', at(26), 'completed');
  // What is not sent yet: a queued message with the image's second use, and a draft with a skill, for a plan turn.
  store.stageDraft(CHAT, { ...blob, stagedAt: at(27) }, { id: 'use-2', name: null }, at(27), true);
  store.enqueue(CHAT, 'queued-1', { revision: 5, text: 'Then list the moorings', intent: NO_INTENT, attachmentIds: ['use-2'] }, at(28), true);
  store.saveDraft(CHAT, 6, { text: 'Summarize the harbour notes', intent: { plan: true, skill: { name: 'summarize', selector: '0123456789abcdef' } } }, at(29), true);
  // An aside on the first answer.
  store.acceptPrompt({ conversationId: ASIDE, turnId: 'aside-turn-1', itemId: 'aside-q-1', text: 'What does nextHighTide return?', at: at(30), started: false, aside: { parentId: CHAT, source: SOURCE, title: 'What nextHighTide returns' } });
  store.providerTook(ASIDE, 'aside-turn-1', 'provider-aside-1');
  store.addItem(ASIDE, 'aside-turn-1', message('aside-answer-1', 'assistant', 'The next high tide after `now`, as a Date.', { providerItemId: 'msg-a1', model: 'sonnet', receivedAt: at(31), providerAt: at(31) }));
  store.providerEnded(ASIDE, 'aside-turn-1', 'completed', at(32), 'msg-a1', 900);
  store.sessionEnded(ASIDE, 'aside-turn-1', at(32), 'completed');
  // A second chat of the plan, its mode chosen in the chat, and where the plan was implemented.
  store.createConversation(SECOND, at(33), { id: 'edits-ok', source: 'user' });
  store.setMode(SECOND, 'read-only', at(34), false);
  store.setPlanNote(SECOND, { sessionId: CHAT, at: at(35) });
  // The first chat's reference, and the history check that reached its start.
  store.setReference(CHAT, 'claude-session-ref-1', HARBOUR, null);
  store.markReached(CHAT, ['provider-turn-1', 'provider-turn-2', 'provider-turn-3', 'provider-turn-5'], true);
}

async function recordConversations(into: string): Promise<void> {
  await inScratch('conversations', async (dir) => {
    const store = createConversationStore({ dir, now: clock(), newId: ids(), log: QUIET, blobs: createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER)) });
    try {
      await fillStore(store, dir);
    } finally {
      store.close();
    }
    writeFileSync(path.join(into, fileOf('conversations')), dumpStore(path.join(dir, STORE_FILE)));
  });
}

const AUTO_VACUUM = ['NONE', 'FULL', 'INCREMENTAL'] as const;
const quoteName = (name: string): string => `"${name.replaceAll('"', '""')}"`;
function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  throw new Error(`a value of no SQL literal: ${typeof value}`);
}

/**
 * The store as SQL text: its file's settings that are part of the format, its schema as SQLite
 * holds it, and every row, each table in creation order and its rows in insertion order. What the
 * baseline of a database is, since its bytes are SQLite's to arrange.
 */
export function dumpStore(file: string): string {
  const db = new DatabaseSync(file);
  try {
    const pragma = (name: string): unknown => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0];
    const meta = db.prepare('SELECT schemaVersion, minReaderVersion FROM meta WHERE id = 1').get() as { schemaVersion: number; minReaderVersion: number };
    const lines = [
      `-- fat-g conversation store, format version ${meta.schemaVersion} (reader ${meta.minReaderVersion}): a synthetic store's settings, schema and rows, as tests/baselines/record.ts dumps them.`,
      // In the store's own order: auto_vacuum is settable only while the file is empty.
      `PRAGMA auto_vacuum = ${AUTO_VACUUM[Number(pragma('auto_vacuum'))] ?? 'NONE'};`,
      `PRAGMA journal_mode = ${String(pragma('journal_mode')).toUpperCase()};`,
      `PRAGMA application_id = ${String(pragma('application_id'))};`,
    ];
    const objects = db.prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all() as { type: string; name: string; sql: string }[];
    for (const object of objects) lines.push(`${object.sql};`);
    for (const table of objects.filter((object) => object.type === 'table')) {
      const rows = db.prepare(`SELECT * FROM ${quoteName(table.name)} ORDER BY rowid`).all() as Record<string, unknown>[];
      for (const row of rows) lines.push(`INSERT INTO ${quoteName(table.name)} (${Object.keys(row).map(quoteName).join(', ')}) VALUES (${Object.values(row).map(literal).join(', ')});`);
    }
    return `${lines.join('\n')}\n`;
  } finally {
    db.close();
  }
}

/** A store made from a dump: the file a baseline test opens as the app would. */
export function loadStore(sql: string, file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

// ── plans/<id>/plan.json and plans/<id>/reviews/<id>.json ─────────────────────────────────────

const HASHES = { v1: digest('plan v1'), v2: digest('plan v2'), v3: digest('plan v3') };

function samplePlan(): PlanFileRecord {
  const version = (number: number, turnId: string, seconds: number, length: number, hash: string, rest: Partial<PlanFileRecord['versions'][number]>): PlanFileRecord['versions'][number] => ({
    version: number, state: 'complete', sessionId: CHAT, turnId, providerId: 'claude', instanceId: 'default', model: 'sonnet', at: at(seconds), length, hash, cause: 'plan-turn', revises: null, integration: null, unknown: {}, ...rest,
  });
  return {
    id: PLAN, projectId: PROJECT, title: 'Tide table refactor', createdAt: at(12),
    versions: [
      version(1, 'turn-2', 13, 1200, HASHES.v1, {}),
      version(2, 'turn-6', 40, 1350, HASHES.v2, { cause: 'feedback', revises: 1 }),
      version(3, 'turn-7', 50, 1500, HASHES.v3, { cause: 'integration', revises: 2, integration: { reviewId: REVIEW, integrationId: INTEGRATION, findings: ['T1.1', 'T2.1'] } }),
      version(4, 'turn-8', 55, 300, digest('plan v4 so far'), { state: 'unfinished', cause: 'feedback', revises: 3, sessionId: SECOND }),
    ],
    workflow: {
      state: 'implementing', revision: 6, version: 3, participants: [CHAT, SECOND],
      operation: { id: uuid(10), kind: 'implementation', sessionId: SECOND, version: 3, hash: HASHES.v3, turns: ['turn-9'], reviewId: null, at: at(60), unknown: {} },
      unknown: {},
    },
    unknown: {},
  };
}

function sampleReview(): ReviewRecord {
  const finding = (id: string, tier: number, title: string): ReviewRecord['rounds'][number]['findings'][number] => ({ id, tier, category: 'PROD', title, example: 'An example.', description: 'A description.', correction: 'A correction.', anchor: { heading: 'Steps', quote: 'add it' } });
  return {
    id: REVIEW, planId: PLAN, version: 2, hash: HASHES.v2, startedFrom: CHAT, instruction: 2,
    reviewer: { sessionId: REVIEWER, providerId: 'codex', instanceId: WORK_INSTANCE, model: 'gpt-5.5', effort: 'high' },
    startedAt: at(41), endedAt: at(49), state: 'closed', failure: null, staleBy: 3, closed: 'handed',
    turns: [
      { turnId: 'review-turn-1', promptId: 'review-prompt-1', kind: 'review', at: at(41), answerId: 'review-answer-1', outcome: 'round', reason: null, continues: null, card: null, notes: null, unknown: {} },
      { turnId: 'review-turn-2', promptId: 'review-prompt-2', kind: 'notes', at: at(44), answerId: 'review-answer-2', outcome: 'round', reason: null, continues: null, card: null, notes: { 'T2.1': 'Is the second file in scope?' }, unknown: {} },
    ],
    rounds: [
      { turnId: 'review-turn-1', answerId: 'review-answer-1', appraisal: 'Sound, with two gaps.', findings: [finding('T1.1', 1, 'The module boundary'), finding('T2.1', 2, 'The second file')], revised: [], marks: { 'T1.1': 'accepted', 'T2.1': 'open' }, notes: { 'T2.1': 'Is the second file in scope?' }, unknown: {} },
      { turnId: 'review-turn-2', answerId: 'review-answer-2', appraisal: 'The second gap stands; one more.', findings: [finding('T1.1', 1, 'The module boundary'), finding('T2.1', 2, 'The second file, in scope'), finding('T3.1', 3, 'A naming nit')], revised: ['T2.1'], marks: null, notes: null, unknown: {} },
    ],
    marks: { 'T1.1': { mark: 'accepted', note: '', revised: false }, 'T2.1': { mark: 'accepted', note: 'Agreed.', revised: true }, 'T3.1': { mark: 'rejected', note: 'Out of scope.', revised: false } },
    integrations: [{ id: INTEGRATION, version: 2, hash: HASHES.v2, round: 'review-turn-2', accepted: ['T1.1', 'T2.1'], notes: { 'T2.1': 'Agreed.' }, instruction: 2, sessionId: CHAT, route: 'plan-turn', planItem: null, turns: ['turn-7'], card: null, state: 'integrated', reason: null, produced: 3, at: at(48), settledAt: at(50), unknown: {} }],
    unknown: {},
  };
}

function recordPlans(into: string): void {
  // As the plan store writes them (src/main/plans/store.ts): the document, serialized as every JSON file is.
  writeFileSync(path.join(into, fileOf('plan')), serializeJson(planDocument(samplePlan())));
  writeFileSync(path.join(into, fileOf('review')), serializeJson(reviewDocument(sampleReview())));
}

// ── avatars/<family>/family.json ──────────────────────────────────────────────────────────────

function recordFamily(into: string): void {
  // The file fat-g seeds for a family of three folders, as the user then edited it by hand; then
  // the file Add avatar makes of it, with an avatar whose entry has matches and a look of its own.
  const folders = ['Default', 'Scout', 'Harbourmaster'];
  const edited = { ...(JSON.parse(seededManifest(folders)) as Record<string, unknown>), author: 'The harbour', licence: 'CC0-1.0', defaultFor: ['codex'] };
  const bytes = new TextEncoder().encode(`${JSON.stringify(edited, null, 2)}\n`);
  const current = { bytes, reading: parseManifest(bytes), raw: edited, link: false };
  const added = manifestAdding(current, folders, { folder: 'Navigator', matches: ['gpt-5.5*', { provider: 'claude', key: 'sonnet' }], overlay: { version: { size: 14, textColor: '#ffeeaa' }, effort: { show: false } } });
  writeFileSync(path.join(into, fileOf('family')), added);
}

// ── catalog.json ──────────────────────────────────────────────────────────────────────────────

function recordCatalog(into: string): void {
  // The user's to write (docs/catalog-override.md): fat-g has no writer, so the sample is written here, every field of the format in it.
  const document = {
    schemaVersion: CATALOG_VERSION,
    minReaderVersion: CATALOG_VERSION,
    providers: {
      codex: {
        efforts: { xhigh: { label: 'Very high', caution: true } },
        models: {
          'gpt-5.5': { name: 'GPT-5.5', description: 'The everyday model.', efforts: ['low', 'medium', 'high', 'xhigh'], listedDefaultEffort: 'medium', speedTiers: ['fast', { id: 'priority', name: 'Priority', description: 'Served first.' }], hidden: false },
          'gpt-5.5-mini': { hidden: true },
          'gpt-6-astra': { name: 'Astra', resolvedId: 'gpt-6-astra-2020-03' },
        },
      },
      claude: { models: { sonnet: { description: 'Described by hand.' } } },
      gemini: { models: { 'gemini-9': {} } },
    },
  };
  writeFileSync(path.join(into, fileOf('catalog')), serializeJson(document));
}

// ── provider-detection.json and reset-on-next-start.json ──────────────────────────────────────

async function recordMarkers(into: string): Promise<void> {
  await inScratch('markers', async (dir) => {
    const history = createDiscoveryHistory(path.join(dir, PROVIDER_DISCOVERY_FILE));
    if (!await history.save({ claude: true, codex: false })) throw new Error('the discovery history was not saved');
    copyFileSync(path.join(dir, PROVIDER_DISCOVERY_FILE), path.join(into, fileOf('provider-detection')));
  });
  // The reset request as src/main/app/data-reset.ts writes it, its id fixed here: the writer draws a random one.
  writeFileSync(path.join(into, fileOf('reset-on-next-start')), `${JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, scope: 'all', id: uuid(11) })}\n`);
}

/** Writes every format's baseline into `into`, which is made if missing. Answers the files written. */
export async function recordBaselines(into: string): Promise<readonly string[]> {
  mkdirSync(into, { recursive: true });
  await recordPreferences(into);
  await recordRecords(into);
  await recordConversations(into);
  recordPlans(into);
  recordFamily(into);
  recordCatalog(into);
  await recordMarkers(into);
  return FORMATS.map((entry) => entry.file);
}

/** The committed baselines, by format: each file's version and text. */
export function committedBaselines(dir: string = BASELINES_DIR): readonly { readonly id: FormatId; readonly version: number; readonly file: string; readonly text: string }[] {
  return readdirSync(dir)
    .map((file) => ({ file, match: BASELINE_FILE.exec(file) }))
    .filter((entry): entry is { file: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ file, match }) => ({ id: match[1] as FormatId, version: Number(match[2]), file, text: readFileSync(path.join(dir, file), 'utf8') }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}
