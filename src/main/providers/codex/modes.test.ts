// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V25, V33, V34, the adapter's part (docs/planning/_archive/M22.md, Design 1, 7; C4, C7, C44, C55, C63,
// C65, C70, C85, C93–C96): Codex's five modes — what each names at a start, what a reply must
// report for it and what a turn then names again, on the replies K1, K4 and K6 captured; and which
// of them an account can use, from what Codex answered of its sandbox and what its replies reported.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredTransition, type ModeAvailability, modeOf, readingMode, resolveMode } from '@shared/contracts/permissions';
import { CODEX_DESCRIPTOR } from './descriptor';
import { type AccountPolicy, availability, checkPolicy, CODEX_MODE_IDS, CODEX_MODES, CODEX_PERMISSIONS, type CodexModeId, isCodexMode, MAX_REPORTED_ROOTS, modeOfStart, type ReportedPolicy, reportsNoSandbox, startPolicy, VALIDATED_MODES } from './modes';
import { takeStartReply } from './session-schemas';

interface Frame { readonly index: number; readonly dir: 'send' | 'recv'; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: Record<string, unknown> } }
const frames = (name: string): Frame[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: Frame[] }).frames;
/** Each `thread/start` or `thread/resume` of a capture, with the reply it got: what was named, and what was reported. */
function opens(name: string): { named: Record<string, unknown>; reported: ReportedPolicy; turn: Record<string, unknown> | undefined }[] {
  const all = frames(name);
  return all.flatMap((sent) => {
    if (sent.dir !== 'send' || (sent.frame.method !== 'thread/start' && sent.frame.method !== 'thread/resume')) return [];
    const reply = all.find((f) => f.dir === 'recv' && f.index > sent.index && f.frame.method === undefined && f.frame.id === sent.frame.id);
    const taken = reply?.frame.result === undefined ? null : takeStartReply(reply.frame.result);
    if (taken === null) return [];
    const turn = all.find((f) => f.dir === 'send' && f.index > sent.index && f.frame.method === 'turn/start');
    return [{ named: sent.frame.params ?? {}, reported: taken.policy, turn: turn?.frame.params }];
  });
}
/** The one open of a capture that names exactly this mode's triple. */
function openOf(name: string, id: CodexModeId) {
  const wanted = startPolicy(id);
  const found = opens(name).find(({ named }) => named['sandbox'] === wanted.sandbox && named['approvalPolicy'] === wanted.approvalPolicy && named['approvalsReviewer'] === wanted.approvalsReviewer);
  if (found === undefined) throw new Error(`${name} has no start under ${id}`);
  return found;
}

const READ_ONLY: ReportedPolicy = { sandbox: { type: 'readOnly', networkAccess: false }, sandboxType: 'readOnly', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false, approvalPolicy: 'never', approvalsReviewer: 'user' };
const workspace = (extra: Partial<ReportedPolicy> = {}): ReportedPolicy => ({ sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, sandboxType: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false, approvalPolicy: 'on-request', approvalsReviewer: 'user', ...extra });

describe('the five, as Codex’s descriptor declares them (V2, V15; C39, C44, C63)', () => {
  const { permissions } = CODEX_DESCRIPTOR.capabilities;

  it('declares its five alone, in fat-g’s names, with Read only the one reading mode and Auto reviewed the fallback', () => {
    expect(permissions).toBe(CODEX_PERMISSIONS);
    expect(CODEX_PERMISSIONS.modes.map((mode) => [mode.id, mode.label])).toEqual([['read-only', 'Read only + allowed MCP'], ['ask-first', 'Ask first'], ['sandbox-ok', 'Sandbox ok'], ['auto-reviewed', 'Auto reviewed'], ['berserk', 'Berserk']]);
    expect(CODEX_PERMISSIONS.modes.map((mode) => mode.id)).toEqual([...CODEX_MODE_IDS]);
    expect(readingMode(CODEX_PERMISSIONS)?.id).toBe('read-only');
    expect(CODEX_PERMISSIONS.modes.filter((mode) => mode.reading)).toHaveLength(1);
    expect(CODEX_PERMISSIONS.fallback).toBe('auto-reviewed');
    // Its setup's own lines (C60): what it changes, by the vendor's description, and that the system asks for leave by itself.
    expect(CODEX_PERMISSIONS.setup).toEqual({ changes: expect.stringContaining('sandbox user accounts') as string, approval: expect.stringContaining('administrator') as string, waiting: expect.stringContaining('Windows') as string });
    // The default uses the CLI's own reviewer (decision 0027).
    expect(modeOf(CODEX_PERMISSIONS, CODEX_PERMISSIONS.fallback)).toMatchObject({ asks: true, reading: false });
  });

  it('says which of them send the CLI’s requests to the user: not the reading mode, and not Berserk', () => {
    expect(Object.fromEntries(CODEX_PERMISSIONS.modes.map((mode) => [mode.id, mode.asks]))).toEqual({ 'read-only': false, 'ask-first': true, 'sandbox-ok': true, 'auto-reviewed': true, berserk: false });
  });

  it('words each in one line by the evidence: what asks, where an accepted action lands, who answers, and Codex’s own word for Berserk (C3, C95, C96)', () => {
    const words = Object.fromEntries(CODEX_PERMISSIONS.modes.map((mode) => [mode.id, mode.description]));
    // An MCP tool its server marks as safe runs with no request, under Read only too (spikes/codex-mcp's `annotated`).
    expect(words['read-only']).toBe('Reads files and runs nothing that changes them; every request is refused — an MCP tool its server marks as read-only, or as neither destructive nor reaching outside, still runs, and may act');
    // With a sandbox every file change asks, the folder's included, and an accepted one is written where it names (C95).
    expect(words['ask-first']).toBe('Each command asks before it runs, unless Codex holds it safe or a rule of your own configuration allows it, and so does each file change; an accepted command is held to the project’s folder and the temporary folders, and an accepted file change is written where it names; on Windows, Codex’s sandbox may ask for an administrator’s approval the first time it works in a project’s folder');
    expect(words['sandbox-ok']).toBe('Changes in the project’s folder and the temporary folders run without asking; a file change outside them asks, and is written there once accepted; a command outside them is stopped by the sandbox; on Windows, Codex’s sandbox may ask for an administrator’s approval the first time it works in a project’s folder');
    // It says who answers, and promises no folder (C96).
    expect(words['auto-reviewed']).toBe('As Sandbox ok, with Codex’s own reviewer answering in your place what would ask, a change outside the folder among it, with no card here; on Windows, Codex’s sandbox may ask for an administrator’s approval the first time it works in a project’s folder');
    // The three modes that run in Codex's sandbox say that Windows may ask for leave for it: Codex's own setup helper, seen at the acceptance (C111).
    for (const id of ['ask-first', 'sandbox-ok', 'auto-reviewed']) expect(words[id]).toMatch(/administrator’s approval/);
    expect(words['berserk']).toBe('Everything runs without asking, outside the folder too: Codex’s Full access');
    for (const description of Object.values(words)) expect(description).not.toMatch(/\n/);
    // No description promises a card before every action, or calls anything an account's own (C3): those are the page's lines.
    expect(JSON.stringify(words)).not.toMatch(/always ask|every action|this account/i);
  });

  it('carries the one line on inherited rules, and the one on what Codex lists of them (C3, C23)', () => {
    expect(CODEX_PERMISSIONS.inherited).toBe('Rules of your own Codex configuration act as it lets them, with no card here');
    expect(CODEX_PERMISSIONS.rules).toBe('Codex lists its permission profiles and not its rules');
  });

  it('reaches no mode from another on a live process: every change is a restart (C64)', () => {
    expect(CODEX_PERMISSIONS.modes.every((mode) => mode.transitionsFrom.length === 0)).toBe(true);
    for (const from of CODEX_MODE_IDS) for (const to of CODEX_MODE_IDS) expect(declaredTransition(CODEX_PERMISSIONS, from, to), `${from} → ${to}`).toBe('restart');
  });

  it('resolves a chat’s mode by the shared rule: Auto reviewed with nothing chosen, Read only where the account cannot use it, and no id of another provider', () => {
    const none = { saved: null, project: null, user: null };
    expect(resolveMode(CODEX_PERMISSIONS, none)).toEqual({ id: 'auto-reviewed', source: 'fallback' });
    expect(resolveMode(CODEX_PERMISSIONS, none, () => false)).toEqual({ id: 'read-only', source: 'fallback' });
    expect(resolveMode(CODEX_PERMISSIONS, { saved: 'berserk', project: 'sandbox-ok', user: 'read-only' })).toEqual({ id: 'berserk', source: 'chat' });
    // Claude's own name for its third is none of Codex's.
    expect(resolveMode(CODEX_PERMISSIONS, { saved: 'edits-ok', project: null, user: 'sandbox-ok' })).toEqual({ id: 'sandbox-ok', source: 'user' });
  });
});

describe('each mode in Codex’s own words (V2; C4, C7, C70)', () => {
  it('names a sandbox, an approval policy and a reviewer: none for Read only and Berserk, whose policy asks no one', () => {
    expect(CODEX_MODES).toEqual({
      'read-only': { sandbox: 'read-only', reports: 'readOnly', approvalPolicy: 'never', approvalsReviewer: null },
      'ask-first': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
      'sandbox-ok': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
      'auto-reviewed': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
      berserk: { sandbox: 'danger-full-access', reports: 'dangerFullAccess', approvalPolicy: 'never', approvalsReviewer: null },
    });
    expect(Object.isFrozen(CODEX_MODES)).toBe(true);
  });

  it('gives a start and a resume exactly those fields: the reviewer only where the policy asks someone (C70)', () => {
    expect(startPolicy('read-only')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' });
    expect(startPolicy('ask-first')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
    expect(startPolicy('sandbox-ok')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(startPolicy('auto-reviewed')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    expect(startPolicy('berserk')).toEqual({ sandbox: 'danger-full-access', approvalPolicy: 'never' });
    for (const id of ['read-only', 'berserk'] as const) expect(startPolicy(id)).not.toHaveProperty('approvalsReviewer');
    // Nothing a start names needs the experimental API (K1): no profile, no granular policy, no other root.
    for (const id of CODEX_MODE_IDS) expect(Object.keys(startPolicy(id)).every((key) => ['sandbox', 'approvalPolicy', 'approvalsReviewer'].includes(key))).toBe(true);
  });

  it('runs a start that names no mode, or one that is none of the five, as Read only', () => {
    expect(modeOfStart(null)).toBe('read-only');
    for (const other of ['edits-ok', '', 'Berserk', 'danger-full-access']) expect(modeOfStart(other)).toBe('read-only');
    for (const id of CODEX_MODE_IDS) { expect(modeOfStart(id)).toBe(id); expect(isCodexMode(id)).toBe(true); }
    expect(isCodexMode(null)).toBe(false);
  });
});

describe('a start or resume reply, held to its mode (V2; C4, C7, C46, C64, C65, C70)', () => {
  it.each([
    ['read-only', 'm22-codex-read-only-turn'],
    ['ask-first', 'm22-codex-ask-first-files'],
    ['sandbox-ok', 'm22-codex-reviewer-turn-main'],
    ['auto-reviewed', 'm22-codex-auto-review-main'],
    ['berserk', 'm22-codex-berserk-main'],
  ] as const)('takes %s’s own reply, as %s has it', (id, name) => {
    const { reported } = openOf(name, id);
    expect(checkPolicy(id, reported)).toMatchObject({ ok: true, unconfined: false });
  });

  it.each([
    ['m22-codex-read-only-turn', 'read-only'],
    ['m22-codex-reviewer-turn-main', 'sandbox-ok'],
    ['m22-codex-auto-review-main', 'auto-reviewed'],
    ['m22-codex-berserk-main', 'berserk'],
  ] as const)('names again, on each turn, what the reply reported and never another: %s sent just that (C7, C64)', (name, id) => {
    const { reported, turn } = openOf(name, id);
    const check = checkPolicy(id, reported);
    if (!check.ok || turn === undefined) throw new Error('the capture’s reply was not taken');
    // Frame for frame what K4's turn/start named: the reply's own sandbox object, sent back as it came.
    expect({ approvalPolicy: turn['approvalPolicy'], sandboxPolicy: turn['sandboxPolicy'], ...(turn['approvalsReviewer'] === undefined ? {} : { approvalsReviewer: turn['approvalsReviewer'] }) }).toEqual(check.turn);
    expect(check.turn.sandboxPolicy).toBe(reported.sandbox);
    // Read only and Berserk name no reviewer on a turn either (C70), though the reply reports one.
    expect('approvalsReviewer' in check.turn).toBe(id === 'sandbox-ok' || id === 'auto-reviewed');
    expect(reported.approvalsReviewer).not.toBeNull();
  });

  it('takes read-only for Ask first’s workspace sandbox, as an account with none reports it, and says the session is unconfined (C4)', () => {
    const { named, reported } = openOf('m22-codex-once', 'ask-first');
    expect(named['sandbox']).toBe('workspace-write');
    expect(reported.sandboxType).toBe('readOnly');
    const check = checkPolicy('ask-first', reported);
    expect(check).toMatchObject({ ok: true, unconfined: true, places: null });
    // The turn names the sandbox the thread has, the read-only one, and not the one that was asked for.
    expect(check.ok && check.turn).toEqual({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalsReviewer: 'user' });
    expect(reportsNoSandbox('ask-first', reported)).toBe(true);
  });

  it('refuses that same reply for Sandbox ok and Auto reviewed, which need the sandbox, with what it reported (C4, C46)', () => {
    const none = opens('m22-codex-start');
    const onRequest = none.find(({ named }) => named['sandbox'] === 'workspace-write' && named['approvalPolicy'] === 'on-request' && named['approvalsReviewer'] === 'user');
    const reviewed = none.find(({ named }) => named['approvalsReviewer'] === 'auto_review');
    if (onRequest === undefined || reviewed === undefined) throw new Error('m22-codex-start lacks a start');
    expect(checkPolicy('sandbox-ok', onRequest.reported)).toEqual({ ok: false, reported: 'sandbox: readOnly; approvalPolicy: on-request; approvalsReviewer: user' });
    expect(checkPolicy('auto-reviewed', reviewed.reported)).toEqual({ ok: false, reported: 'sandbox: readOnly; approvalPolicy: on-request; approvalsReviewer: auto_review' });
    expect(reportsNoSandbox('sandbox-ok', onRequest.reported)).toBe(true);
    expect(reportsNoSandbox('read-only', READ_ONLY)).toBe(false);
  });

  it.each([
    ['another policy', 'ask-first', workspace({ approvalPolicy: 'on-request' })],
    ['a policy that is no word', 'sandbox-ok', workspace({ approvalPolicy: { granular: { rules: true } } })],
    ['another reviewer', 'sandbox-ok', workspace({ approvalsReviewer: 'auto_review' })],
    ['the user where Codex’s reviewer was named', 'auto-reviewed', workspace({ approvalsReviewer: 'user' })],
    ['no reviewer at all', 'ask-first', workspace({ approvalPolicy: 'untrusted', approvalsReviewer: null })],
    ['full access for a workspace mode', 'sandbox-ok', workspace({ sandbox: { type: 'dangerFullAccess' }, sandboxType: 'dangerFullAccess', networkAccess: null })],
    ['a workspace sandbox for Berserk', 'berserk', workspace({ approvalPolicy: 'never' })],
    ['read-only for Berserk', 'berserk', READ_ONLY],
    ['a workspace sandbox for Read only', 'read-only', workspace({ approvalPolicy: 'never' })],
    ['network access under Read only', 'read-only', { ...READ_ONLY, networkAccess: true }],
    ['a policy that asks under Read only', 'read-only', { ...READ_ONLY, approvalPolicy: 'on-request' }],
    ['no sandbox at all', 'ask-first', workspace({ sandbox: null, sandboxType: null, approvalPolicy: 'untrusted' })],
  ] as const)('refuses a reply that reports %s (C7, C46, C70)', (_name, id, reported) => {
    const check = checkPolicy(id, reported);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reported.length).toBeLessThanOrEqual(500);
  });

  it('holds Read only and Berserk to no reviewer, since they named none: a configuration’s own default is taken (C70)', () => {
    // K4: with `auto_review` as the configuration's default, a read-only start that names none reports it.
    expect(checkPolicy('read-only', { ...READ_ONLY, approvalsReviewer: 'auto_review' }).ok).toBe(true);
    expect(checkPolicy('berserk', { ...openOf('m22-codex-berserk-main', 'berserk').reported, approvalsReviewer: 'auto_review' }).ok).toBe(true);
  });

  it('says what a refused reply reported in Codex’s own words, bounded, with the network where it has it', () => {
    expect(checkPolicy('read-only', { ...READ_ONLY, networkAccess: true })).toEqual({ ok: false, reported: 'sandbox: readOnly, networkAccess; approvalPolicy: never; approvalsReviewer: user' });
    expect(checkPolicy('ask-first', workspace({ sandbox: null, sandboxType: null, approvalsReviewer: null }))).toEqual({ ok: false, reported: 'sandbox: none; approvalPolicy: on-request; approvalsReviewer: none' });
    const long = checkPolicy('ask-first', workspace({ approvalPolicy: { granular: 'x'.repeat(2_000) } }));
    expect(!long.ok && long.reported.length).toBeLessThanOrEqual(500);
  });

  it('reads where a sandbox mode can write from the reply, never from a constant (C65)', () => {
    const places = (reported: ReportedPolicy) => { const check = checkPolicy('sandbox-ok', reported); return check.ok ? check.places : undefined; };
    // The temporary folders with the folder, as K6's and K4's replies have it.
    expect(places(openOf('m22-codex-reviewer-turn-main', 'sandbox-ok').reported)).toEqual({ temporary: true, roots: [], network: false });
    // The folder alone, where the reply excludes both.
    expect(places(workspace({ excludeTmpdirEnvVar: true, excludeSlashTmp: true }))).toEqual({ temporary: false, roots: [], network: false });
    expect(places(workspace({ excludeTmpdirEnvVar: true }))).toEqual({ temporary: true, roots: [], network: false });
    // Another root, and the network, where the user's own configuration adds them: told, and not refused.
    expect(places(workspace({ writableRoots: ['D:\\shared', '/var/build'], networkAccess: true }))).toEqual({ temporary: true, roots: ['D:\\shared', '/var/build'], network: true });
    // More roots than are told, or one too long to be a path, are left out of what is told.
    expect(places(workspace({ writableRoots: [...Array.from({ length: 40 }, (_, n) => `root-${String(n)}`), '', 'x'.repeat(3_000)] }))?.roots).toHaveLength(MAX_REPORTED_ROOTS);
    // A mode with no workspace sandbox has no such places.
    for (const [id, name] of [['read-only', 'm22-codex-read-only-turn'], ['berserk', 'm22-codex-berserk-main']] as const) expect(checkPolicy(id, openOf(name, id).reported)).toMatchObject({ ok: true, places: null });
  });
});

describe('which modes an account can use (V2, V25, V33, V34; C43, C55, C60, C62, C85, C93, C94)', () => {
  const account = (extra: Partial<AccountPolicy> = {}): AccountPolicy => ({ windows: true, readiness: 'ready', sandboxSeen: null, checked: new Map(), ...extra });
  const of = (modes: readonly ModeAvailability[], id: CodexModeId): ModeAvailability => modes.find((mode) => mode.id === id) as ModeAvailability;
  const usable = (modes: readonly ModeAvailability[]) => modes.filter((mode) => mode.available).map((mode) => mode.id);

  it('lists the five as validated (C94): each has a capture of a turn under it', () => {
    expect([...VALIDATED_MODES]).toEqual([...CODEX_MODE_IDS]);
    // Berserk's and Auto reviewed's are K4's: a turn, and not a start alone (C93).
    for (const name of ['m22-codex-berserk-main', 'm22-codex-auto-review-main']) expect(frames(name).some((f) => f.dir === 'recv' && f.frame.method === 'turn/completed')).toBe(true);
  });

  it('lists every mode available on an account whose sandbox is ready, one entry a mode, in the descriptor’s order', () => {
    const modes = availability(account());
    expect(modes.map((mode) => mode.id)).toEqual([...CODEX_MODE_IDS]);
    expect(usable(modes)).toEqual([...CODEX_MODE_IDS]);
    expect(modes.every((mode) => mode.reason === null && !mode.setup && !mode.unconfined && mode.places === null)).toBe(true);
  });

  it('lists a mode left out of the validated ones unavailable, as unvalidated, and no other differently (C85, C93)', () => {
    const modes = availability(account({ validated: ['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed'] }));
    expect(of(modes, 'berserk')).toEqual({ id: 'berserk', available: false, reason: 'unvalidated', setup: false, records: false, unconfined: false, places: null });
    expect(usable(modes)).toEqual(['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed']);
    // Whatever the account's sandbox: a start under it is never offered.
    expect(of(availability(account({ validated: ['read-only'], readiness: 'not-configured' })), 'sandbox-ok')).toMatchObject({ available: false, reason: 'unvalidated', setup: false });
  });

  it('where Codex answers that the sandbox is not set up: Sandbox ok and Auto reviewed need it, with the Set up control, and Ask first says it is unconfined (C4, C60)', () => {
    for (const readiness of ['not-configured', 'update-required'] as const) {
      const modes = availability(account({ readiness }));
      for (const id of ['sandbox-ok', 'auto-reviewed'] as const) expect(of(modes, id)).toEqual({ id, available: false, reason: 'needs-setup', setup: true, records: false, unconfined: false, places: null });
      expect(of(modes, 'ask-first')).toEqual({ id: 'ask-first', available: true, reason: null, setup: false, records: false, unconfined: true, places: null });
      expect(usable(modes)).toEqual(['read-only', 'ask-first', 'berserk']);
    }
  });

  it('before Codex has answered, on Windows, the two stand unavailable with no control: a setup is offered only once Codex has said none is set up (C60)', () => {
    const modes = availability(account({ readiness: null }));
    for (const id of ['sandbox-ok', 'auto-reviewed'] as const) expect(of(modes, id)).toMatchObject({ available: false, reason: 'needs-setup', setup: false });
    // Nothing is claimed of Ask first's sandbox before anything is known of it.
    expect(of(modes, 'ask-first')).toMatchObject({ available: true, unconfined: false, records: false });
  });

  it('on another system nothing is asked: the two stand available, and the start reply decides (C62)', () => {
    const modes = availability(account({ windows: false, readiness: null }));
    expect(usable(modes)).toEqual([...CODEX_MODE_IDS]);
    expect(modes.every((mode) => !mode.setup)).toBe(true);
    // A reply that reported read-only for a workspace start is that decision: no sandbox, and no control to set one up.
    const seen = availability(account({ windows: false, readiness: null, sandboxSeen: false }));
    for (const id of ['sandbox-ok', 'auto-reviewed'] as const) expect(of(seen, id)).toMatchObject({ available: false, reason: 'needs-setup', setup: false });
    expect(of(seen, 'ask-first')).toMatchObject({ available: true, unconfined: true });
  });

  it('takes a reply’s word over readiness, since the reply is what the thread has (C4)', () => {
    // Ready, and yet a workspace start came back read-only: the two are unavailable, and Codex does not say a setup is missing.
    const disagrees = availability(account({ readiness: 'ready', sandboxSeen: false }));
    expect(of(disagrees, 'sandbox-ok')).toMatchObject({ available: false, reason: 'needs-setup', setup: false });
    expect(of(disagrees, 'ask-first').unconfined).toBe(true);
    // Readiness not read, and a workspace start taken: the account has its sandbox.
    const taken = availability(account({ readiness: null, sandboxSeen: true }));
    expect(usable(taken)).toEqual([...CODEX_MODE_IDS]);
  });

  it('says which modes make Codex record the folder as trusted: Berserk always, a workspace mode on an account with a sandbox, and never Read only (C55)', () => {
    const records = (modes: readonly ModeAvailability[]) => Object.fromEntries(modes.map((mode) => [mode.id, mode.records]));
    expect(records(availability(account()))).toEqual({ 'read-only': false, 'ask-first': true, 'sandbox-ok': true, 'auto-reviewed': true, berserk: true });
    // With no sandbox a workspace start is answered read-only and writes nothing (K1).
    expect(records(availability(account({ readiness: 'not-configured' })))).toEqual({ 'read-only': false, 'ask-first': false, 'sandbox-ok': false, 'auto-reviewed': false, berserk: true });
  });

  it('tells each sandbox mode’s places from that mode’s own last checked reply, and none for an unconfined Ask first', () => {
    const places = { temporary: true, roots: ['D:\\shared'], network: false };
    const modes = availability(account({ sandboxSeen: true, checked: new Map([['sandbox-ok', { unconfined: false, places }], ['ask-first', { unconfined: false, places: { temporary: false, roots: [], network: true } }]]) }));
    expect(of(modes, 'sandbox-ok').places).toEqual(places);
    expect(of(modes, 'ask-first').places).toEqual({ temporary: false, roots: [], network: true });
    expect(of(modes, 'auto-reviewed').places).toBeNull();
    expect(of(modes, 'berserk').places).toBeNull();
    const none = availability(account({ sandboxSeen: false, checked: new Map([['ask-first', { unconfined: true, places: null }]]) }));
    expect(of(none, 'ask-first')).toMatchObject({ unconfined: true, places: null });
  });
});
