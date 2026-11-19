// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The stored formats' baselines (decision 0014, item 4): one committed document of each format at
// the version this build writes, in tests/fixtures/baselines/, and the proof that this build reads
// every committed one.
//
// Three things are held. A baseline is there for each format at its current version, and nothing
// else is in the folder. The current ones are what this build writes: recording again, into a
// scratch folder, gives the committed bytes. And every committed baseline, of this version or an
// earlier one, is read by the current reader as compatible, with its content — so a format raised
// without a migration fails here, as decision 0014 means it to once the first release is out;
// before it, the baseline is recorded again instead (do-record-baselines.bat).
import { readdirSync, readFileSync, rmSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDataReset, DATA_RESET_FILE } from '../../src/main/app/data-reset';
import { parseManifest } from '../../src/main/avatars/manifest';
import { readOverride } from '../../src/main/catalog/override';
import { STORE_FILE } from '../../src/main/conversations/format';
import { openStore } from '../../src/main/conversations/open';
import { createConversationStore, turnView } from '../../src/main/conversations/store';
import { planDocument, readPlanFile } from '../../src/main/plans/format';
import { readReviewFile, reviewDocument } from '../../src/main/plans/review-format';
import { createPreferencesStore, PREFERENCES_FILE } from '../../src/main/prefs/store';
import { RECORDS_FILE } from '../../src/main/records/format';
import { createRecordsStore } from '../../src/main/records/store';
import { serializeJson } from '../../src/main/storage/json-file';
import { createDiscoveryHistory, PROVIDER_DISCOVERY_FILE } from '../../src/main/storage/provider-discovery-history';
import { AT, BASELINE_FILE, BASELINES_DIR, committedBaselines, dumpStore, FORMATS, type FormatId, loadStore, recordBaselines } from './record';

const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };
const PROVIDERS = ['claude', 'codex'];
const at = (seconds: number): number => AT + seconds * 1000;
// The invented world of tests/baselines/record.ts, as its files hold it.
const PROJECT = '00000000-0000-4000-8000-000000000001';
const ARCHIVE = '00000000-0000-4000-8000-000000000002';
const WORK = '00000000-0000-4000-8000-000000000001';
const PRESET = '00000000-0000-4000-8000-000000000004';
const PLAN = '00000000-0000-4000-8000-000000000007';
const REVIEW = '00000000-0000-4000-8000-000000000008';
const INTEGRATION = '00000000-0000-4000-8000-000000000009';
const CHAT = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const ASIDE = '33333333-3333-4333-8333-333333333333';
const HARBOUR = 'D:\\Projects\\harbour-tools';
const IMAGE = '73fc6f735437d5fcbfe7c2bc54221238efb5a1efb01bad237ca61f37bae9e725';

const scratches: string[] = [];
const scratch = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), `fatg-baselines-${name}-`));
  scratches.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const committed = committedBaselines();
/** The committed baselines of one format, each as its version and its text: what `it.each` runs over. */
const of = (id: FormatId): (readonly [number, string])[] => committed.filter((entry) => entry.id === id).map((entry) => [entry.version, entry.text] as const);
const current = (id: FormatId): number => FORMATS.find((entry) => entry.id === id)?.version ?? NaN;

describe('the set of baselines (decision 0014)', () => {
  it('holds one file of each format at the version this build writes, and nothing else', () => {
    const files = readdirSync(BASELINES_DIR).filter((file) => file !== 'README.md');
    for (const format of FORMATS) expect(files, `${format.id} at version ${format.version} has no baseline: record it with do-record-baselines.bat`).toContain(format.file);
    for (const file of files) {
      const match = BASELINE_FILE.exec(file);
      expect(match, `${file} is no baseline's name`).not.toBeNull();
      const format = FORMATS.find((entry) => entry.id === match?.[1]);
      expect(format, `${file} is of no format this build has`).toBeDefined();
      expect(Number(match?.[2]), `${file} is newer than this build writes`).toBeLessThanOrEqual(format?.version ?? 0);
    }
  });

  it('is what this build writes: recording again gives the committed bytes of each current version', async () => {
    const dir = scratch('recorded');
    await recordBaselines(dir);
    for (const format of FORMATS) expect(readFileSync(path.join(dir, format.file), 'utf8'), format.file).toBe(readFileSync(path.join(BASELINES_DIR, format.file), 'utf8'));
  });
});

describe('preferences.json', () => {
  it.each(of('preferences'))('version %i is read as compatible, its settings as saved, and left as it is', (version, text) => {
    const dir = scratch('preferences');
    writeFileSync(path.join(dir, PREFERENCES_FILE), text);
    const store = createPreferencesStore({ dir, providerIds: PROVIDERS, platform: 'win32', log: QUIET, writeDelayMs: 60_000 });
    try {
      const snapshot = store.getSnapshot();
      expect(snapshot.status).toEqual({ kind: 'ok' });
      expect(store.isWritable()).toBe(true);
      expect(snapshot.providerIssues).toEqual({});
      expect(snapshot.values).toMatchObject({
        windows: { main: { bounds: { x: 120, y: 80, width: 1600, height: 900 }, maximized: false }, pet: { visible: true, autoHideOnMainFocus: false, bounds: { x: 1740, y: 80, width: 180, height: 420 }, size: 'capsule' } },
        usage: { pollIntervalSec: 600 },
        privacy: { maskEmail: false },
        audio: { muted: false, volume: 0.25, sounds: { rollover: 'button.wav', click: null, question: 'question.wav', turnStart: 'Launch-1.mp3' } },
        appearance: { theme: 'light', doneAnimation: 'animation-only', creationAnimation: 'none', flash: { enabled: true, speed: 'slow', seconds: 5 } },
        layout: { projectColumn: 'right' },
        chat: { messageTimes: true, hoverMessageTimes: false, answerTimes: false, username: 'Harbour master' },
        titles: { generated: false, models: { claude: 'haiku', codex: '$session' } },
        composer: { busyEnter: 'queue' },
        presets: { [PRESET]: { name: 'Quick notes', providerId: 'codex', instanceId: 'default', model: 'gpt-5.5', effort: 'low', speed: 'fast' } },
        presetRecency: [PRESET],
        recentModels: [{ providerId: 'codex', instanceId: WORK, model: 'gpt-5.5', effort: 'low', speed: 'fast' }, { providerId: 'claude', instanceId: 'default', model: 'opus', effort: 'high', speed: null }],
        avatars: {
          assignments: { claude: { sonnet: { origin: 'built-in', family: 'Claude Lightning', avatar: 'Sonnet' }, opus: { origin: 'user', family: 'Harbour', avatar: 'Navigator' } } },
          active: { codex: { origin: 'built-in', family: 'Codex Lightning' } },
        },
      });
      expect(store.getProviderAdmission('claude')).toMatchObject({ kind: 'enabled', preferences: { enabled: true, executablePath: 'D:\\Tools\\claude\\claude.cmd', permissionMode: 'ask-first' } });
      expect(store.getProviderAdmission('codex')).toMatchObject({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: 'read-only' } });
      expect(snapshot.instances).toMatchObject({ claude: { firstLabel: 'Personal', added: [] }, codex: { firstLabel: null, added: [{ id: WORK, label: 'Work', folder: 'D:\\Accounts\\codex-work' }] } });
    } finally {
      store.dispose();
    }
    // Reading a file of this build's version writes nothing back.
    if (version === current('preferences')) expect(readFileSync(path.join(dir, PREFERENCES_FILE), 'utf8')).toBe(text);
  });
});

describe('records.json', () => {
  it.each(of('records'))('version %i is read whole: its projects, their folders and modes, and its sessions', (version, text) => {
    const dir = scratch('records');
    writeFileSync(path.join(dir, RECORDS_FILE), text);
    const store = createRecordsStore({ dir, providerIds: PROVIDERS, platform: 'win32', log: QUIET });
    const view = store.getView();
    expect(view.status).toEqual({ kind: 'ok', keptAs: null });
    expect(view.orphans).toBe(0);
    expect(view.projects).toEqual([
      { kind: 'project', key: PROJECT, id: PROJECT, name: 'Harbour tools', color: 'teal', hidden: false, collapsed: true, providers: ['claude', 'codex'], roots: [{ path: HARBOUR, trust: 'trusted' }, { path: 'D:\\Projects\\harbour-docs', trust: 'not-trusted' }], sessions: 2, permissionModes: { claude: 'ask-first' } },
      { kind: 'project', key: ARCHIVE, id: ARCHIVE, name: 'Archive', color: 'grey', hidden: true, collapsed: false, providers: ['codex'], roots: [{ path: 'E:\\Archive', trust: 'trusted' }], sessions: 1, permissionModes: {} },
    ]);
    expect(view.sessions.map((session) => session.name)).toEqual(['Which files mention the tide tables?', 'Tide tables', 'Scratch ideas']);
    expect(view.sessions[0]).toMatchObject({
      projectId: PROJECT, providerId: 'codex', instanceId: WORK, model: 'gpt-5.5', effort: 'low', speed: 'fast', reference: 'thread-codex-2', folder: 'D:\\Projects\\harbour-docs', configFolder: 'D:\\Accounts\\codex-work',
      nameSource: 'first-message', starred: false, toDo: true, toVerify: false, shelvedAt: null, completedAt: at(50), lastTurn: { turnId: 'turn-1', startedAt: at(45), endedAt: at(49), outcome: 'interrupted' },
    });
    expect(view.sessions[1]).toMatchObject({
      projectId: PROJECT, providerId: 'claude', instanceId: 'default', model: 'sonnet', effort: 'high', speed: null, reference: 'claude-session-ref-1', folder: HARBOUR, configFolder: null,
      nameSource: 'generated', starred: true, toDo: false, toVerify: true, shelvedAt: null, completedAt: null, lastTurn: { turnId: 'turn-5', startedAt: at(24), endedAt: at(26), outcome: 'completed' },
    });
    expect(view.sessions[2]).toMatchObject({ projectId: ARCHIVE, providerId: 'claude', model: 'haiku', effort: null, speed: null, reference: null, folder: null, nameSource: 'user', shelvedAt: at(60), completedAt: null, lastTurn: null });
    if (version === current('records')) expect(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')).toBe(text);
  });
});

describe('conversations.sqlite', () => {
  it.each(of('conversations'))('version %i is opened by the store and read whole: chats, turns, items, asides, grants, draft, queue and images', (_version, text) => {
    const dir = scratch('conversations');
    const file = path.join(dir, STORE_FILE);
    loadStore(text, file);
    // The dump is canonical: the store made from it dumps the same.
    expect(dumpStore(file)).toBe(text);
    const opened = openStore(file, statSync(file).size);
    expect(opened.kind).toBe('open');
    if (opened.kind !== 'open') return;
    expect(opened.created).toBe(false);
    opened.db.close();

    const store = createConversationStore({ dir, log: QUIET });
    try {
      expect(store.status()).toEqual({ kind: 'ok' });
      expect(store.conversations().map(({ id, parentId }) => ({ id, parentId }))).toEqual([{ id: CHAT, parentId: null }, { id: ASIDE, parentId: CHAT }, { id: SECOND, parentId: null }]);
      expect(store.conversation(CHAT)).toMatchObject({ reference: 'claude-session-ref-1', folder: HARBOUR, configFolder: null, startHeld: true, reachedStart: true, removing: false, createdAt: at(0), parentId: null });
      expect(store.firstPrompt(CHAT)).toBe('Which files mention the tide tables?');
      expect(store.lastReportedTurn(CHAT)).toBe('provider-turn-5');

      const page = store.newestPage(CHAT);
      expect(page.turns.map((turn) => turn.id)).toEqual(['turn-1', 'turn-2', 'turn-3', 'turn-4', 'turn-5']);
      expect(page.items.map((item) => item.id)).toEqual(['prompt-1', 'activity-1', 'activity-2', 'card-1', 'approval-1', 'answer-1', 'prompt-2', 'line-1', 'prompt-3', 'answer-3', 'notice-1', 'prompt-4', 'steer-1', 'answer-4', 'prompt-5', 'answer-5']);
      expect(page.turns.map((turn) => turnView(turn, false).speed ?? null)).toEqual([{ id: 'fast', name: 'Fast' }, null, null, null, null]);
      expect(page.turns.map((turn) => [turn.providerOutcome, turn.sessionOutcome, turn.plan, turn.gap])).toEqual([
        ['completed', 'completed', false, false], ['completed', 'completed', true, false], ['completed', 'completed', false, false], ['interrupted', 'interrupted', false, true], ['completed', 'completed', false, false],
      ]);
      expect(page.turns[0]).toMatchObject({ providerTurnId: 'provider-turn-1', providerTook: true, acceptedAt: at(1), endReceivedAt: at(10), elapsedMs: 9000, mode: 'ask-first', reached: true });
      const item = (id: string) => page.items.find((entry) => entry.id === id);
      expect(item('activity-1')?.activity).toMatchObject({ type: 'command', summary: 'rg -n tide src', input: 'rg -n tide src', status: 'completed', exitCode: 0, output: 'src/tides.js:12:function nextHighTide(now) {\n', files: [{ path: 'src/tides.js', line: 12 }], duration: { ms: 180, provenance: 'provider' } });
      expect(item('activity-2')?.activity).toMatchObject({ type: 'worker', workerId: 'worker-1', model: 'haiku', agentType: 'general-purpose', status: 'completed' });
      expect(item('card-1')?.interaction).toMatchObject({ kind: 'question', outcome: 'answered', answers: [{ options: [0], text: null, secret: false }], settledAt: at(6), confirmedAt: at(6) + 200 });
      expect(item('approval-1')?.interaction).toMatchObject({ kind: 'approval', outcome: 'approved-session', decidedAt: at(8), delivered: true });
      expect(item('answer-1')).toMatchObject({ model: 'sonnet', state: 'complete', blocks: [{ type: 'text', text: 'Two files mention them: `src/tides.js` and `README.md`.' }] });
      expect(item('line-1')?.interaction).toMatchObject({ kind: 'plan', planId: PLAN, version: 1, came: 'made', request: true, outcome: 'executed', decidedAt: at(14) });
      expect(item('notice-1')).toMatchObject({ kind: 'notice', blocks: [{ type: 'text', text: 'Plan mode left.' }] });
      expect(item('steer-1')).toMatchObject({ kind: 'message', delivery: { state: 'taken', detail: null } });
      expect(item('answer-4')?.state).toBe('partial');
      expect(item('prompt-5')?.attachments?.map((entry) => [entry.id, entry.hash, entry.name])).toEqual([['use-1', IMAGE, 'harbour.png']]);
      expect(store.grants(CHAT)).toEqual([{ itemId: 'approval-1', covers: 'Bash(rg:*)', processKey: 'process-1', decidedAt: at(8), confirmedAt: at(8) + 300 }]);
      expect(store.turnPlan(CHAT, 'turn-2')).toMatchObject({ plan: true, fields: null, newest: { itemId: 'line-1', planId: PLAN, version: 1, outcome: 'executed' } });
      expect(store.turnPlan(CHAT, 'turn-3')).toMatchObject({ plan: false, fields: { planId: PLAN, version: 1, intent: 'execute' } });
      expect(store.workers(CHAT, 10)).toMatchObject([{ workerId: 'worker-1', model: 'haiku', agentType: 'general-purpose', status: 'completed' }]);
      expect(store.workerItems(CHAT, 'worker-1')?.items.map((entry) => entry.id)).toEqual(['worker-answer-1']);

      expect(store.asides(CHAT)).toMatchObject([{ id: ASIDE, title: 'What nextHighTide returns', source: { kind: 'message', itemId: 'answer-1' }, createdAt: at(30) }]);
      expect(store.aside(ASIDE)).toMatchObject({ parentId: CHAT, title: 'What nextHighTide returns', source: { excerpt: 'Two files mention them: `src/tides.js` and', cut: false } });
      expect(store.newestPage(ASIDE).items.map((entry) => entry.id)).toEqual(['aside-q-1', 'aside-answer-1']);

      expect(store.draft(CHAT)).toMatchObject({ text: 'Summarize the harbour notes', revision: 6, changedAt: at(29), intent: { plan: true, skill: { name: 'summarize', selector: '0123456789abcdef' } }, attachments: [] });
      expect(store.queue(CHAT)).toMatchObject([{ id: 'queued-1', place: 1, text: 'Then list the moorings', queuedAt: at(28), intent: { plan: false, skill: null }, attachments: [{ id: 'use-2', hash: IMAGE, name: 'Pasted image 1', mediaType: 'image/png', bytes: 75, width: 3, height: 2 }] }]);
      expect(store.blob(IMAGE)).toMatchObject({ hash: IMAGE, mediaType: 'image/png', bytes: 75, width: 3, height: 2, stagedAt: at(22) });
      expect(store.planNote(SECOND)).toEqual({ sessionId: CHAT, at: at(35) });
      expect(store.planNote(CHAT)).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('plans/<id>/plan.json', () => {
  it.each(of('plan'))('version %i is read whole, and written back as it is', (version, text) => {
    const reading = readPlanFile(JSON.parse(text));
    expect(reading.kind).toBe('ok');
    if (reading.kind !== 'ok') return;
    expect(reading.plan).toMatchObject({ id: PLAN, projectId: PROJECT, title: 'Tide table refactor', createdAt: at(12), unknown: {} });
    expect(reading.plan.versions.map((entry) => [entry.version, entry.state, entry.cause, entry.revises, entry.sessionId])).toEqual([
      [1, 'complete', 'plan-turn', null, CHAT], [2, 'complete', 'feedback', 1, CHAT], [3, 'complete', 'integration', 2, CHAT], [4, 'unfinished', 'feedback', 3, SECOND],
    ]);
    expect(reading.plan.versions[0]).toMatchObject({ turnId: 'turn-2', providerId: 'claude', instanceId: 'default', model: 'sonnet', at: at(13), length: 1200, integration: null });
    expect(reading.plan.versions[2]?.integration).toEqual({ reviewId: REVIEW, integrationId: INTEGRATION, findings: ['T1.1', 'T2.1'] });
    expect(reading.plan.workflow).toMatchObject({ state: 'implementing', revision: 6, version: 3, participants: [CHAT, SECOND], operation: { kind: 'implementation', sessionId: SECOND, version: 3, turns: ['turn-9'], reviewId: null, at: at(60) } });
    if (version === current('plan')) expect(serializeJson(planDocument(reading.plan))).toBe(text);
  });
});

describe('plans/<id>/reviews/<id>.json', () => {
  it.each(of('review'))('version %i is read whole, and written back as it is', (version, text) => {
    const reading = readReviewFile(JSON.parse(text));
    expect(reading.kind).toBe('ok');
    if (reading.kind !== 'ok') return;
    expect(reading.review).toMatchObject({
      id: REVIEW, planId: PLAN, version: 2, startedFrom: CHAT, instruction: 2, reviewer: { providerId: 'codex', instanceId: WORK, model: 'gpt-5.5', effort: 'high' },
      startedAt: at(41), endedAt: at(49), state: 'closed', failure: null, staleBy: 3, closed: 'handed',
    });
    expect(reading.review.turns.map((turn) => [turn.kind, turn.outcome, turn.notes])).toEqual([['review', 'round', null], ['notes', 'round', { 'T2.1': 'Is the second file in scope?' }]]);
    expect(reading.review.rounds.map((round) => [round.findings.map((finding) => finding.id), round.revised, round.marks])).toEqual([
      [['T1.1', 'T2.1'], [], { 'T1.1': 'accepted', 'T2.1': 'open' }], [['T1.1', 'T2.1', 'T3.1'], ['T2.1'], null],
    ]);
    expect(reading.review.marks).toEqual({ 'T1.1': { mark: 'accepted', note: '', revised: false }, 'T2.1': { mark: 'accepted', note: 'Agreed.', revised: true }, 'T3.1': { mark: 'rejected', note: 'Out of scope.', revised: false } });
    expect(reading.review.integrations).toMatchObject([{ id: INTEGRATION, version: 2, round: 'review-turn-2', accepted: ['T1.1', 'T2.1'], notes: { 'T2.1': 'Agreed.' }, sessionId: CHAT, route: 'plan-turn', turns: ['turn-7'], state: 'integrated', reason: null, produced: 3 }]);
    if (version === current('review')) expect(serializeJson(reviewDocument(reading.review))).toBe(text);
  });
});

describe('avatars/<family>/family.json', () => {
  it.each(of('family'))('version %i is applied: its provider scope, its look, its avatars and their matches', (_version, text) => {
    const reading = parseManifest(new TextEncoder().encode(text));
    expect(reading.kind).toBe('applied');
    if (reading.kind !== 'applied') return;
    expect(reading.manifest).toMatchObject({ provider: 'any', author: 'The harbour', licence: 'CC0-1.0', defaultFor: ['codex'] });
    expect(reading.manifest.overlay).toMatchObject({ version: { size: 22, position: 'top-right', parts: { version: true, name: false } }, effort: { show: true, position: 'bottom', size: 7 } });
    expect(reading.manifest.avatars?.map((entry) => entry.folder)).toEqual(['Scout', 'Harbourmaster', 'Navigator']);
    expect(reading.manifest.avatars?.[2]).toMatchObject({ matches: ['gpt-5.5*', { provider: 'claude', key: 'sonnet' }], overlay: { version: { size: 14, textColor: '#ffeeaa' }, effort: { show: false } } });
  });
});

describe('catalog.json', () => {
  it.each(of('catalog'))('version %i is applied for the providers this build has, the others named', (_version, text) => {
    const dir = scratch('catalog');
    const file = path.join(dir, 'catalog.json');
    writeFileSync(file, text);
    const reading = readOverride(file, new Set(PROVIDERS));
    expect(reading.kind).toBe('applied');
    if (reading.kind !== 'applied') return;
    expect(reading.unknownProviders).toEqual(['gemini']);
    const codex = reading.providers.get('codex');
    expect([...(codex?.efforts.entries() ?? [])]).toEqual([['xhigh', { label: 'Very high', caution: true }]]);
    expect(codex?.models).toEqual([
      ['gpt-5.5', { name: 'GPT-5.5', description: 'The everyday model.', efforts: ['low', 'medium', 'high', 'xhigh'], listedDefaultEffort: 'medium', speedTiers: [{ id: 'fast' }, { id: 'priority', name: 'Priority', description: 'Served first.' }], hidden: false }],
      ['gpt-5.5-mini', { hidden: true }],
      ['gpt-6-astra', { name: 'Astra', resolvedId: 'gpt-6-astra-2020-03' }],
    ]);
    expect(reading.providers.get('claude')?.models).toEqual([['sonnet', { description: 'Described by hand.' }]]);
  });
});

describe('provider-detection.json', () => {
  it.each(of('provider-detection'))('version %i is read: the acknowledgement and each provider’s last result', (_version, text) => {
    const dir = scratch('detection');
    const file = path.join(dir, PROVIDER_DISCOVERY_FILE);
    writeFileSync(file, text);
    expect(createDiscoveryHistory(file)).toMatchObject({ acknowledged: true, unavailable: false, providers: { claude: true, codex: false } });
  });
});

describe('reset-on-next-start.json', () => {
  it.each(of('reset-on-next-start'))('version %i is taken as the request to clear the folder at the next start', async (_version, text) => {
    const dir = scratch('reset');
    writeFileSync(path.join(dir, DATA_RESET_FILE), text);
    writeFileSync(path.join(dir, PREFERENCES_FILE), '{}');
    expect(await createDataReset(dir).info()).toEqual({ folder: dir, available: true });
    expect(createDataReset(dir).consume()).toBe('reset');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('is what this build writes, but for the id the writer draws', async () => {
    const dir = scratch('reset-writer');
    expect(await createDataReset(dir).schedule()).toEqual({ status: 'scheduled' });
    const written = readFileSync(path.join(dir, DATA_RESET_FILE), 'utf8');
    const baseline = of('reset-on-next-start').find(([version]) => version === current('reset-on-next-start'))?.[1] ?? '';
    const parsed = JSON.parse(written) as Record<string, unknown>;
    const recorded = JSON.parse(baseline) as Record<string, unknown>;
    expect(written).toBe(`${JSON.stringify(parsed)}\n`);
    expect(baseline).toBe(`${JSON.stringify(recorded)}\n`);
    expect({ ...parsed, id: null }).toEqual({ ...recorded, id: null });
    expect(parsed['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
