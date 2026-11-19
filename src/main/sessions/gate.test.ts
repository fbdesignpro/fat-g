// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12, V38, V45 (docs/planning/_archive/M15.md; C30–C32, C105, C112): the reason a session cannot take a
// prompt, on a table. One word, the first failing check deciding, and no path in it.
import { describe, expect, it } from 'vitest';
import { SEND_BLOCKS, type SendBlock, type SessionHold } from '@shared/contracts/sessions';
import type { ProviderStatus } from '@shared/contracts/status';
import type { SessionRecord } from '../records/format';
import { blocksHistory, createGate, type GateFacts, type GateOptions, sendBlock } from './gate';

const OPEN: GateFacts = { recordsRefused: false, conversationsRefused: false, demo: false, hold: null, notInstalled: false, hasSessions: true, offered: true, signedOut: false, connected: true, folder: { isRoot: true, trust: 'trusted', missing: false } };

describe('the first check that fails (Design 9)', () => {
  it('lets a prompt through when every check passes', () => {
    expect(sendBlock(OPEN)).toBeNull();
  });

  const rows: [SendBlock, Partial<GateFacts>][] = [
    ['records-refused', { recordsRefused: true }],
    // The conversation store is refused (M18, C33): a prompt could not be recorded.
    ['conversations-refused', { conversationsRefused: true }],
    ['demo', { demo: true }],
    ['provider-unavailable', { hold: 'provider-unavailable' }],
    ['provider-unavailable', { notInstalled: true }],
    ['no-sessions', { hasSessions: false }],
    ['instance-unavailable', { hold: 'instance-unavailable' }],
    ['folder-moved', { hold: 'folder-moved' }],
    ['not-offered', { offered: false }],
    ['signed-out', { signedOut: true }],
    ['not-connected', { connected: false }],
    ['folder-not-root', { folder: { isRoot: false, trust: null, missing: false } }],
    ['folder-not-root', { folder: null }],
    ['folder-not-trusted', { folder: { isRoot: true, trust: 'not-trusted', missing: false } }],
    ['folder-not-trusted', { folder: { isRoot: true, trust: null, missing: false } }],
    ['folder-missing', { folder: { isRoot: true, trust: 'trusted', missing: true } }],
    // The exact version the session was made with, no longer in its account's list (decision 0016).
    ['model-not-listed', { modelUnlisted: true }],
    // The chat's mode's own two (M22, C43, C46): the last of the order, read for a prompt alone.
    ['mode-unconfirmed', { mode: 'mode-unconfirmed' }],
    ['mode-unavailable', { mode: 'mode-unavailable' }],
  ];

  it.each(rows)('%s', (reason, change) => {
    expect(sendBlock({ ...OPEN, ...change })).toBe(reason);
  });

  it('covers every reason of the list, each a word with no path in it', () => {
    expect(new Set(rows.map(([reason]) => reason))).toEqual(new Set(SEND_BLOCKS));
    for (const reason of SEND_BLOCKS) expect(reason).toMatch(/^[a-z-]+$/);
  });

  it('answers the first of several that fail, in the list’s order', () => {
    const everything: GateFacts = { recordsRefused: true, conversationsRefused: true, demo: true, hold: 'provider-unavailable', notInstalled: true, hasSessions: false, offered: false, signedOut: true, connected: false, folder: { isRoot: false, trust: null, missing: true }, modelUnlisted: true, mode: 'mode-unconfirmed' };
    // Each check lifted in turn leaves the next one deciding.
    const lifts: Partial<GateFacts>[] = [
      { recordsRefused: false }, { conversationsRefused: false }, { demo: false }, { hold: 'instance-unavailable', notInstalled: false }, { hasSessions: true }, { hold: 'folder-moved' }, { hold: null }, { offered: true },
      { signedOut: false }, { connected: true }, { folder: { isRoot: true, trust: null, missing: true } }, { folder: { isRoot: true, trust: 'trusted', missing: true } }, { folder: { isRoot: true, trust: 'trusted', missing: false } }, { modelUnlisted: false }, { mode: 'mode-unavailable' }, { mode: null },
    ];
    let facts = everything;
    const seen: (SendBlock | null)[] = [sendBlock(facts)];
    for (const lift of lifts) { facts = { ...facts, ...lift }; seen.push(sendBlock(facts)); }
    expect(seen).toEqual([...SEND_BLOCKS, null]);
  });

  it('says which reasons also keep a session’s earlier messages from being read (C57)', () => {
    expect(SEND_BLOCKS.filter((reason) => blocksHistory(reason))).toEqual(['records-refused', 'conversations-refused', 'demo', 'provider-unavailable', 'no-sessions', 'instance-unavailable', 'folder-moved']);
    expect(blocksHistory(null)).toBe(false);
  });
});

describe('the gate, from what main holds', () => {
  const ROOT = 'D:\\Code\\fat-g';
  const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: 's1', projectId: 'p1', providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'm', effort: null, speed: null, name: null, nameSource: null,
    starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: 1, lastActiveAt: 1, lastTurn: null, ...overrides,
  });
  const descriptor = (sessions: boolean) => ({ id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll' as const, sessions, history: true, otherFolders: false, models: true, asides: 'none' as const, questions: 'none' as const, permissions: null } });
  function gate(overrides: Partial<GateOptions> = {}, status: ProviderStatus = { kind: 'ok' }, sessions = true) {
    return createGate({
      recordsRefused: () => false, demo: () => false,
      snapshot: () => ({ status, descriptor: descriptor(sessions) }),
      hasRuntime: () => true,
      project: () => ({ providers: ['codex'], roots: [{ path: ROOT, answer: 'trusted' }, { path: 'D:\\Code\\second', answer: 'not-trusted' }] }),
      isMissing: () => false, kept: () => undefined, platform: 'win32', ...overrides,
    });
  }
  const block = (options: Partial<GateOptions> = {}, session = record(), hold: SessionHold | null = null, status: ProviderStatus = { kind: 'ok' }, sessions = true) => gate(options, status, sessions).block(session, hold);

  it('uses the project’s first root for a session not yet started, and its stored folder for a started one (C30)', () => {
    expect(gate().folder(record())).toBe(ROOT);
    expect(gate().folder(record({ reference: 'r', folder: 'D:\\Code\\second' }))).toBe('D:\\Code\\second');
    expect(block()).toBeNull();
    // The stored folder decides, though the first root is trusted.
    expect(block({}, record({ reference: 'r', folder: 'D:\\Code\\second' }))).toBe('folder-not-trusted');
    expect(block({}, record({ reference: 'r', folder: 'D:\\Elsewhere' }))).toBe('folder-not-root');
    // Compared as roots are: letter case does not make another folder on Windows.
    expect(block({}, record({ reference: 'r', folder: 'd:\\code\\FAT-G' }))).toBeNull();
  });

  it('refuses a first root that is not trusted, unanswered or missing', () => {
    expect(block({ project: () => ({ providers: ['codex'], roots: [{ path: ROOT, answer: 'not-trusted' }] }) })).toBe('folder-not-trusted');
    expect(block({ project: () => ({ providers: ['codex'], roots: [{ path: ROOT, answer: null }] }) })).toBe('folder-not-trusted');
    expect(block({ isMissing: (root) => root === ROOT })).toBe('folder-missing');
    expect(block({ project: () => ({ providers: ['codex'], roots: [] }) })).toBe('folder-not-root');
    expect(block({ project: () => undefined })).toBe('not-offered');
  });

  it('takes a reference the runtime keeps unsaved as a started session’s, with its folder (C108)', () => {
    const kept = { kept: () => ({ folder: 'D:\\Code\\second' }) };
    expect(gate(kept).folder(record())).toBe('D:\\Code\\second');
    expect(block(kept)).toBe('folder-not-trusted');
  });

  it('lists the project’s other folders a session may be handed: registered, trusted and present, and never the working folder (M16, C19, C61)', () => {
    const roots = (answers: readonly (readonly [string, 'trusted' | 'not-trusted' | null])[]) => ({ project: () => ({ providers: ['codex'], roots: answers.map(([path, answer]) => ({ path, answer })) }) });
    const three = roots([[ROOT, 'trusted'], ['D:\\Code\\second', 'trusted'], ['D:\\Code\\third', 'trusted']]);
    expect(gate(three).otherFolders(record())).toEqual(['D:\\Code\\second', 'D:\\Code\\third']);
    // A project with one root has none; one not trusted, or not answered, is left out.
    expect(gate(roots([[ROOT, 'trusted']])).otherFolders(record())).toEqual([]);
    expect(gate().otherFolders(record())).toEqual([]);
    expect(gate(roots([[ROOT, 'trusted'], ['D:\\Code\\second', null], ['D:\\Code\\third', 'trusted']])).otherFolders(record())).toEqual(['D:\\Code\\third']);
    // One that is missing is left out, read anew at each call.
    let missing = 'D:\\Code\\third';
    const watched = gate({ ...three, isMissing: (root) => root === missing });
    expect(watched.otherFolders(record())).toEqual(['D:\\Code\\second']);
    missing = 'D:\\Code\\second';
    expect(watched.otherFolders(record())).toEqual(['D:\\Code\\third']);
    // The working folder of a started session is its stored one, whichever root that is, however it is spelled.
    expect(gate(three).otherFolders(record({ reference: 'r', folder: 'd:\\code\\SECOND' }))).toEqual([ROOT, 'D:\\Code\\third']);
    // A session with no folder to run in, or no project, is handed none.
    expect(gate({ project: () => undefined }).otherFolders(record())).toEqual([]);
    expect(gate(roots([])).otherFolders(record())).toEqual([]);
  });

  it('refuses for the project, the provider, the instance and the records, with the session service’s hold', () => {
    expect(block({ project: () => ({ providers: ['claude'], roots: [{ path: ROOT, answer: 'trusted' }] }) })).toBe('not-offered');
    expect(block({ recordsRefused: () => true })).toBe('records-refused');
    expect(block({ demo: () => true })).toBe('demo');
    expect(block({}, record(), 'provider-unavailable')).toBe('provider-unavailable');
    expect(block({}, record(), 'instance-unavailable')).toBe('instance-unavailable');
    expect(block({}, record({ reference: 'r', folder: ROOT }), 'folder-moved')).toBe('folder-moved');
    expect(block({}, record(), null, { kind: 'not-installed', overrideInvalid: false })).toBe('provider-unavailable');
    expect(block({}, record(), null, { kind: 'ok' }, false)).toBe('no-sessions');
    expect(block({ snapshot: () => undefined })).toBe('no-sessions');
  });

  it('reads the registry’s runtime and the account’s own answer, never the usage status (V45; C112)', () => {
    // A signed-in instance with a runtime takes a prompt whatever became of its usage reads.
    for (const status of [{ kind: 'ok' }, { kind: 'stale' }, { kind: 'error', message: 'The usage read failed.' }, { kind: 'not-applicable', reason: 'usage-unavailable' }] as ProviderStatus[]) {
      expect(block({}, record(), null, status), status.kind).toBeNull();
    }
    expect(block({}, record(), null, { kind: 'not-logged-in' })).toBe('signed-out');
    // No runtime: still detecting, or its CLI could not be started.
    expect(block({ hasRuntime: () => false }, record(), null, { kind: 'detecting' })).toBe('not-connected');
    expect(block({ hasRuntime: () => false }, record(), null, { kind: 'error', message: 'The CLI could not be started.' })).toBe('not-connected');
    // A reading that ages changes nothing: the same answer before and after.
    expect(block({}, record(), null, { kind: 'ok' })).toBe(block({}, record(), null, { kind: 'stale' }));
  });

  it('refuses a session whose account no longer lists its model, a change of mode too, and decides nothing before the list is reported (decision 0016)', () => {
    expect(block({ modelListed: () => false })).toBe('model-not-listed');
    expect(block({ modelListed: () => true })).toBeNull();
    expect(block({ modelListed: () => null })).toBeNull();
    // A change of mode is no remedy for it: asked without the mode's own two, it still refuses.
    expect(gate({ modelListed: () => false, modeBlock: () => 'mode-unavailable' }).block(record(), null, false)).toBe('model-not-listed');
    // It stands after the folder, and before the mode.
    expect(block({ modelListed: () => false, isMissing: () => true })).toBe('folder-missing');
    expect(block({ modelListed: () => false, modeBlock: () => 'mode-unconfirmed' })).toBe('model-not-listed');
    // Its earlier messages are still read.
    expect(blocksHistory('model-not-listed')).toBe(false);
  });

  it('says an instance is still being detected while it is listed so, or while the app state lists none at all (M23, C89)', () => {
    expect(gate({}, { kind: 'detecting' }).detecting(record())).toBe(true);
    expect(gate({}, { kind: 'ok' }).detecting(record())).toBe(false);
    // The launch, before the providers start: nothing listed yet.
    expect(gate({ snapshot: () => undefined, listed: () => false }).detecting(record())).toBe(true);
    // Once the app state lists instances, one it does not list is gone, not coming.
    expect(gate({ snapshot: () => undefined, listed: () => true }).detecting(record())).toBe(false);
    expect(gate({ snapshot: () => undefined }).detecting(record())).toBe(false);
  });
});
