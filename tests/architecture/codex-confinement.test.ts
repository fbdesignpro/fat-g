// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4 (docs/planning/_archive/M15.md; C13, C14, C36; decision 0018), V5 (M19.md; S7, C7, C8), V5 (M20b.md;
// S5, C19, C27; decision 0025) and V7, V19, V33 (M22.md; C7, C22, C60, C64, C69, C70, C72, C73, C84,
// C93; decision 0027) and V6 (M22b.md; C13, C14, C55): source
// invariants of the Codex module that the linter cannot express. One file holds the three method sets and is the only sender; the
// session's handshake alone names the experimental API, which a plan turn's `collaborationMode` needs, and one file names that
// field; and the module never names Codex's configuration file or a method that would log in, write configuration, or list or
// delete the user's threads.
//
// What a session may do adds its own (M22): Codex's words for a sandbox, a policy and a reviewer are
// in the mode table's one file; a turn names a policy only by what its thread's start reply
// reported; the setup's request is sent from one place, in one mode, at a press; a reply to a
// request for leave is one of three decisions, written in one file; and nothing can write the rule
// Codex would save for every project.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELTA_METHODS, existingHandshake, mayBeSent, OPTED_OUT_DELTAS, sandboxHandshake, secretaryHandshake, sessionHandshake } from '../../src/main/providers/codex/methods';
import { CODEX_MODE_IDS, CODEX_MODES, startPolicy, VALIDATED_MODES } from '../../src/main/providers/codex/modes';
import { SECRETARY_CONFIG } from '../../src/main/providers/codex/secretary';
import { MAPPED_METHODS, REVIEW_METHODS } from '../../src/main/providers/codex/turn-mapper';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CODEX = 'src/main/providers/codex';

const files = readdirSync(path.join(ROOT, CODEX)).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
const sources = files.map((file) => ({ file, text: readFileSync(path.join(ROOT, CODEX, file), 'utf8') }));
/** Comments say what is not sent; only code can send it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

describe('Codex confinement (decision 0018)', () => {
  it('scans the real module', () => {
    expect(files).toEqual(expect.arrayContaining(['methods.ts', 'app-server.ts', 'session-process.ts', 'index.ts']));
  });

  it('has one sender: no file but methods.ts calls request or notify on a connection', () => {
    const senders = sources.filter(({ file, text }) => file !== 'methods.ts' && /\.(request|notify)\(/.test(code(text))).map(({ file }) => file);
    expect(senders).toEqual([]);
    const own = code(sources.find(({ file }) => file === 'methods.ts')?.text ?? '');
    expect(own.match(/\.request\(/g)).toHaveLength(1);
    expect(own.match(/\.notify\(/g)).toHaveLength(1);
  });

  it('names every method it sends as a literal that one of the three sets holds, and names the connection it sends on as one of the three', () => {
    const methods = code(sources.find(({ file }) => file === 'methods.ts')?.text ?? '');
    const sent = sources.flatMap(({ text }) => [...code(text).matchAll(/send(?:Request|Notification)\(\s*'(?:existing|session|sandbox|secretary)',\s*[\w.]+,\s*([^,]+),/g)].map((match) => String(match[1]).trim()));
    expect(sent.length).toBeGreaterThanOrEqual(9);
    // Every call names its connection by a literal: none is sent on a kind worked out elsewhere.
    const calls = sources.filter(({ file }) => file !== 'methods.ts').flatMap(({ text }) => [...code(text).matchAll(/send(?:Request|Notification)\(\s*([^,]+),/g)].map((match) => String(match[1]).trim()));
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const kind of calls) expect(["'existing'", "'session'", "'sandbox'", "'secretary'"], kind).toContain(kind);
    for (const argument of sent) {
      // A literal the sets hold, or the request helper's own `method` parameter, or the history or skills constant.
      if (argument === 'method' || argument === 'HISTORY_METHOD' || argument === 'SKILLS_METHOD') continue;
      expect(argument, argument).toMatch(/^'[a-zA-Z/]+'$/);
      expect(methods, argument).toContain(argument);
    }
  });

  it('holds exactly the four sets the decisions name', () => {
    const methods = sources.find(({ file }) => file === 'methods.ts')?.text ?? '';
    // M23 (C63, C76): the existing set gains `skills/list`, a folder's skills, and nothing else.
    expect(methods).toContain("existing: Object.freeze(new Set(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'model/list', HISTORY_METHOD, SKILLS_METHOD])),");
    expect(methods).toContain("export const SKILLS_METHOD = 'skills/list';");
    for (const kind of ['session', 'sandbox', 'secretary'] as const) expect(mayBeSent(kind, 'skills/list'), kind).toBe(false);
    // M20b (C19, C27): the session set gains `thread/fork`, and nothing else; the existing set is as it was.
    // M23 (C36, C76): and `turn/steer`, a message into the session's own running turn.
    expect(methods).toContain("session: Object.freeze(new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt', 'turn/steer'])),");
    for (const kind of ['existing', 'sandbox', 'secretary'] as const) expect(mayBeSent(kind, 'turn/steer'), kind).toBe(false);
    // M22 (C73): the third, an account's sandbox connection, with its four; the other two are as they were.
    expect(methods).toContain("sandbox: Object.freeze(new Set(['initialize', 'initialized', 'windowsSandbox/readiness', 'windowsSandbox/setupStart'])),");
    expect(methods).toContain("export const HISTORY_METHOD = 'thread/turns/list';");
    // M26 (decision 0028): the fourth, the secretary's, with one thread's start and one turn.
    expect(methods).toContain("secretary: Object.freeze(new Set(['initialize', 'initialized', 'thread/start', 'turn/start'])),");
    expect(code(methods).match(/Object\.freeze\(new Set\(/g)).toHaveLength(4);
    for (const method of ['thread/resume', 'thread/fork', 'turn/interrupt', 'account/read', 'model/list', 'thread/turns/list', 'windowsSandbox/readiness', 'windowsSandbox/setupStart']) expect(mayBeSent('secretary', method), method).toBe(false);
    expect(mayBeSent('session', 'thread/fork')).toBe(true);
    expect(mayBeSent('existing', 'thread/fork')).toBe(false);
    // Neither readiness nor the setup can be sent on the instance's connection or a session's, and the sandbox connection can start no thread.
    for (const method of ['windowsSandbox/readiness', 'windowsSandbox/setupStart']) expect([mayBeSent('existing', method), mayBeSent('session', method), mayBeSent('sandbox', method)], method).toEqual([false, false, true]);
    for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt', 'account/read', 'model/list', 'thread/turns/list', 'windowsSandbox/setupCompleted']) expect(mayBeSent('sandbox', method), method).toBe(false);
  });

  // M20b (C19, C27): an aside's side thread is the one fork — ephemeral, read-only, asked for no
  // approval, told to act on nothing — and its fields are these, written in one place.
  it('forks a side thread from one place, with exactly the fields the decision names: never `config`, never `baseInstructions`', () => {
    const forking = sources.filter(({ text }) => code(text).includes("'thread/fork'")).map(({ file }) => file).sort();
    expect(forking).toEqual(['methods.ts', 'session.ts']);
    const session = code(sources.find(({ file }) => file === 'session.ts')?.text ?? '');
    const calls = [...session.matchAll(/sendRequest\('session', rpc, 'thread\/fork', \{([\s\S]*?)\n\s*\}, \{ timeoutMs: timings\.openMs \}\)/g)].map((match) => match[1] ?? '');
    expect(calls).toHaveLength(1);
    const fields = [...(calls[0] ?? '').matchAll(/^\s*(?:\.\.\.\([^?]*\? \{\} : \{ (\w+): [^}]*\}\)|(\w+):\s*([^\n]*?)),?$/gm)].map((match) => (match[1] !== undefined ? [match[1], 'optional'] : [match[2], match[3]]));
    expect(fields).toEqual([
      ['threadId', 'mapper.threadId'],
      ['lastTurnId', 'optional'],
      ['ephemeral', 'true'],
      ['excludeTurns', 'true'],
      ['cwd', 'options.start.folder'],
      ['sandbox', "'read-only'"],
      ['approvalPolicy', "'never'"],
      ['developerInstructions', 'ASIDE_INSTRUCTIONS'],
      ['model', 'options.start.model'],
      // The chat's speed tier, as its turns ask, standard speed said by name (decision 0018).
      ['serviceTier', 'serviceTierOf(request.speed)'],
    ]);
    // Nothing of a permission profile is named anywhere in the module's code, and a configuration and
    // the base instructions only in the secretary's own thread (M26; decision 0028, item 3).
    expect(sources.filter(({ text }) => code(text).includes('permissionProfile')).map(({ file }) => file)).toEqual([]);
    for (const own of ['config:', 'baseInstructions']) expect(sources.filter(({ text }) => code(text).includes(own)).map(({ file }) => file), own).toEqual(['secretary.ts']);
    // M22 (C84): a side thread is read-only whatever the session's mode — the fork is never given the mode's sandbox,
    // and its reply is held to Read only.
    expect(calls[0]).not.toMatch(/startPolicy|\.\.\.policy|\bmode\b/);
    expect(session).toContain("if (!checkPolicy('read-only', taken.policy).ok) { fail(new StartFailure('open', 'not-read-only')); return; }");
    // And Codex's facet holds no list of commands (C59): what its CLI would do with one is not fat-g's to intercept.
    expect(sources.filter(({ text }) => code(text).includes('intercepts')).map(({ file }) => file)).toEqual([]);
  });

  // M26 (decision 0028): the secretary's one thread, from one file, with exactly these fields.
  it('starts the secretary’s thread from one place, ephemeral and read-only by the mode table, checked against Read only before its one turn', () => {
    const secretary = code(sources.find(({ file }) => file === 'secretary.ts')?.text ?? '');
    expect(sources.filter(({ text }) => /send(?:Request|Notification)\('secretary'/.test(code(text))).map(({ file }) => file)).toEqual(['secretary.ts']);
    const starts = [...secretary.matchAll(/sendRequest\('secretary', connection, 'thread\/start', \{([\s\S]*?)\n\s*\}, \{ timeoutMs: timings\.requestMs, signal \}\)/g)].map((match) => match[1] ?? '');
    expect(starts).toHaveLength(1);
    expect((starts[0] ?? '').split('\n').map((line) => line.trim()).filter(Boolean)).toEqual([
      'cwd: context.probeDirectory,', "...startPolicy('read-only'),", 'ephemeral: true,', 'baseInstructions: request.instructions,', 'model: request.model,', "serviceTier: 'default',", '...(overridden ? { config: SECRETARY_CONFIG } : {}),',
    ]);
    // Its overrides, whole: each switches something off (decision 0028, item 3). No other file sends one.
    expect(SECRETARY_CONFIG).toEqual({
      'features.enable_fanout': false, 'features.hooks': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
      'features.plugins': false, 'features.shell_snapshot': false, 'features.tool_suggest': false, 'features.apps': false,
      apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
      web_search: 'disabled',
    });
    expect(Object.isFrozen(SECRETARY_CONFIG)).toBe(true);
    // A refusal with them is asked once more without them, and nothing else is.
    expect(secretary.match(/\bstart\((true|false)\)/g)).toEqual(['start(true)', 'start(false)']);
    expect(secretary).toContain("if (started === null || !checkPolicy('read-only', started.policy).ok) return { kind: 'failed', reason: 'unavailable' };");
    expect(secretary.indexOf("checkPolicy('read-only'")).toBeLessThan(secretary.indexOf("'turn/start'"));
    expect(secretary.match(/'turn\/start'/g)).toHaveLength(1);
    // Its handshake opts out of every delta, and asks for nothing experimental.
    expect(secretaryHandshake('0.0.0')).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...DELTA_METHODS] } });
  });

  // M19 (S7, C7, C8): streaming adds no method to either set. The handshake asks for a delta kind
  // by not opting out of it: an agent message's, and a plan's (M22b, C14). It asks for the
  // experimental API (M22b, C13), and its plain form, for a CLI that refused it (C80), does not.
  it('opts a session out of exactly the nine other deltas, and takes the two that are left as notifications alone', () => {
    const handshake = sessionHandshake('0.0.0') as { capabilities: { optOutNotificationMethods: string[]; experimentalApi?: unknown } };
    expect(handshake.capabilities.optOutNotificationMethods).toEqual([...OPTED_OUT_DELTAS]);
    expect(OPTED_OUT_DELTAS).toHaveLength(9);
    const kept = DELTA_METHODS.filter((method) => !OPTED_OUT_DELTAS.includes(method));
    expect(kept).toEqual(['item/agentMessage/delta', 'item/plan/delta']);
    expect(Object.keys(handshake.capabilities)).toEqual(['experimentalApi', 'optOutNotificationMethods']);
    expect(handshake.capabilities.experimentalApi).toBe(true);
    expect(sessionHandshake('0.0.0', true)).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0' }, capabilities: { optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    expect(JSON.stringify([existingHandshake('0.0.0'), sandboxHandshake('0.0.0'), secretaryHandshake('0.0.0')])).not.toMatch(/experimental/i);
    // Mapped, and never sent: neither set holds them, or any other delta.
    expect(MAPPED_METHODS).toContain('item/agentMessage/delta');
    for (const method of DELTA_METHODS) expect(mayBeSent('session', method) || mayBeSent('existing', method), method).toBe(false);
    // The only deltas the mapper subscribes to are those two.
    expect(MAPPED_METHODS.filter((method) => /delta/i.test(method))).toEqual(['item/agentMessage/delta', 'item/plan/delta']);
  });

  // M22b (C13, C55): the experimental API, and the field it brings, each in one place.
  it('names the experimental API in the session’s handshake alone, and a collaboration mode in the session alone, on its `turn/start`', () => {
    const filesNaming = (needle: string): string[] => sources.filter(({ text }) => code(text).includes(needle)).map(({ file }) => file);
    expect(filesNaming('experimentalApi')).toEqual(['methods.ts']);
    const methods = code(sources.find(({ file }) => file === 'methods.ts')?.text ?? '');
    expect(methods.match(/experimentalApi/g)).toHaveLength(1);
    expect(methods.slice(methods.indexOf('export function sessionHandshake'), methods.indexOf('export function sessionHandshake') + 400)).toContain('experimentalApi: true');
    expect(filesNaming('collaborationMode')).toEqual(['session.ts']);
    const session = code(sources.find(({ file }) => file === 'session.ts')?.text ?? '');
    expect(session.match(/collaborationMode/g)).toHaveLength(1);
    // The built-in instructions: none of fat-g's own (C13), and the mode list is never asked for.
    expect(session).toContain('developer_instructions: null');
    expect(sources.filter(({ text }) => code(text).includes('collaborationMode/list')).map(({ file }) => file)).toEqual([]);
    // On the session's own turn: the aside's fork and its turns name none (M20b).
    const turnStart = session.indexOf("'turn/start'");
    expect(session.indexOf('collaborationMode')).toBeGreaterThan(turnStart);
    expect(session.indexOf('collaborationMode') - turnStart).toBeLessThan(1500);
  });

  it('never names a login, a configuration write, or a method that lists or deletes threads, in code', () => {
    // `thread/fork` is no longer among them (M20b, C19): the test above holds its one use.
    // M22: nor a granular policy, a named profile or another workspace root, each of which needs the experimental API (K1).
    // `turn/steer` is no longer among them (M23, C36): the session set holds it, and the test below its one use.
    for (const forbidden of ['account/login', 'config/', 'thread/delete', 'thread/list', 'thread/read', 'thread/archive', 'thread/name', 'thread/rollback', 'thread/compact', 'runtimeWorkspaceRoots', 'granular', 'permissionProfile', 'configRequirements']) {
      expect(sources.filter(({ text }) => code(text).includes(forbidden)).map(({ file }) => file), forbidden).toEqual([]);
    }
  });

  it('sends turn/steer from the session alone, on its own connection, once (M23, C36)', () => {
    const uses = sources.flatMap(({ file, text }) => (code(text).match(/'turn\/steer'/g) ?? []).map(() => file));
    expect(uses.sort()).toEqual(['methods.ts', 'session.ts']);
    const session = code(sources.find(({ file }) => file === 'session.ts')?.text ?? '');
    expect(session).toContain("sendRequest('session', rpc, 'turn/steer'");
  });

  it('never names Codex’s configuration file or its home folder’s files', () => {
    // M22: Codex writes a folder's trust and its sandbox setup into its own configuration; fat-g neither reads nor names the file.
    for (const forbidden of ['config.toml', 'auth.json', 'rollout', 'default.rules', 'trust_level']) {
      expect(sources.filter(({ text }) => text.includes(forbidden)).map(({ file }) => file), forbidden).toEqual([]);
    }
  });
});

// M22 (decision 0027): what a session may do.
describe('Codex confinement: modes, approvals and the setup (M22; decision 0027)', () => {
  const source = (name: string): string => sources.find(({ file }) => file === name)?.text ?? '';
  const filesWith = (needle: string | RegExp): string[] => sources.filter(({ text }) => (typeof needle === 'string' ? code(text).includes(needle) : needle.test(code(text)))).map(({ file }) => file).sort();

  it('scans the files the milestone added', () => {
    expect(files).toEqual(expect.arrayContaining(['modes.ts', 'sandbox.ts', 'approvals.ts']));
  });

  it('holds the mode table’s five triples in modes.ts, byte for byte: Read only and Berserk name no reviewer (C4, C70)', () => {
    const modes = source('modes.ts');
    for (const line of [
      "  'read-only': { sandbox: 'read-only', reports: 'readOnly', approvalPolicy: 'never', approvalsReviewer: null },",
      "  'ask-first': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },",
      "  'sandbox-ok': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user' },",
      "  'auto-reviewed': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },",
      "  berserk: { sandbox: 'danger-full-access', reports: 'dangerFullAccess', approvalPolicy: 'never', approvalsReviewer: null },",
    ]) expect(modes, line).toContain(line);
    expect([...CODEX_MODE_IDS]).toEqual(['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk']);
    expect(Object.keys(CODEX_MODES)).toEqual([...CODEX_MODE_IDS]);
    // An asking mode's start names the reviewer; the two that ask no one name none.
    for (const id of CODEX_MODE_IDS) expect('approvalsReviewer' in startPolicy(id), id).toBe(id === 'ask-first' || id === 'sandbox-ok' || id === 'auto-reviewed');
  });

  it('names Codex’s own words for a sandbox, a policy and a reviewer in modes.ts alone', () => {
    for (const word of ["'workspace-write'", "'danger-full-access'", "'untrusted'", "'on-request'", "'auto_review'", "'readOnly'", "'workspaceWrite'", "'dangerFullAccess'", 'guardian_subagent']) {
      expect(filesWith(word).filter((file) => file !== 'modes.ts'), word).toEqual([]);
    }
    // `'user'` is a message's role and who declined an action too: as a reviewer it is the table's alone.
    expect(filesWith(/approvalsReviewer: '/)).toEqual(['modes.ts']);
    // The read-only pair is named by the fork, as before, and by the table: nowhere else.
    expect(filesWith("sandbox: 'read-only'")).toEqual(['modes.ts', 'session.ts']);
    expect(filesWith("approvalPolicy: 'never'")).toEqual(['modes.ts', 'session.ts']);
    expect(code(source('session.ts')).match(/sandbox: 'read-only'/g)).toHaveLength(1);
  });

  it('names a policy on a start, a resume and a turn only from the mode and from what the thread’s own reply reported (C7, C64)', () => {
    const session = code(source('session.ts'));
    // The start and the resume: the mode's own, and beside it nothing but the record's speed tier (decision 0018).
    expect(session).toContain("const base = { cwd: options.start.folder, ...startPolicy(mode), serviceTier: serviceTierOf(options.start.speed) };");
    expect(session).toContain("export const serviceTierOf = (speed: string | null): string => speed ?? 'default';");
    expect(session.match(/startPolicy\(/g)).toHaveLength(1);
    // The one mode of the process, from its start: never set again.
    expect(session).toContain('const mode = modeOfStart(options.start.mode);');
    expect(session.match(/\bmode = /g)).toHaveLength(1);
    // What a turn names again is assigned in one place: from the reply, once it was held to the mode.
    expect(session.match(/\bpolicy = /g)).toHaveLength(1);
    expect(session).toContain('let policy: TurnPolicy | null = null;');
    expect(session).toContain('policy = check.turn;');
    // Spread into the session's own `turn/start`, and into no other request.
    expect(session.match(/\.\.\.policy,/g)).toHaveLength(1);
    const turns = [...session.matchAll(/sendRequest\('session', rpc, 'turn\/start', \{([\s\S]*?)\n\s*\}, \{ timeoutMs: timings\.sendMs \}\)/g)].map((match) => match[1] ?? '');
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => /\.\.\.policy,/.test(turn))).toEqual([true, false]);
    // No turn spells a policy field itself.
    for (const field of ['sandboxPolicy', 'approvalsReviewer', 'approvalPolicy:']) expect(filesWith(field).filter((file) => file !== 'modes.ts' && file !== 'session-schemas.ts' && !(field === 'approvalPolicy:' && file === 'session.ts')), field).toEqual([]);
    // And the session never checks a reply against anything but its mode, or Read only for a fork.
    expect(session.match(/checkPolicy\(/g)).toHaveLength(2);
  });

  it('has no way to change a live thread’s mode: no session member sets one, and the facet answers a restart for every change (C64)', () => {
    expect(filesWith(/setMode/)).toEqual([]);
    expect(code(source('facet.ts'))).toContain("transition: () => 'restart',");
    expect(filesWith("'idle'").filter((file) => file !== 'sandbox.ts')).toEqual([]);
  });

  it('names readiness, the setup and its completion in methods.ts and sandbox.ts alone, and sends on the sandbox connection from sandbox.ts alone (C73)', () => {
    expect(filesWith('windowsSandbox/')).toEqual(['methods.ts', 'sandbox.ts']);
    expect(filesWith(/send(?:Request|Notification)\('sandbox'/)).toEqual(['sandbox.ts']);
    expect(filesWith('SETUP_COMPLETED_METHOD')).toEqual(['methods.ts', 'sandbox.ts']);
    // A session never sees the setup's completion: it is none of the methods it maps.
    expect((MAPPED_METHODS as readonly string[]).some((method) => method.startsWith('windowsSandbox'))).toBe(false);
    expect(JSON.stringify(sandboxHandshake('0.0.0'))).not.toMatch(/experimental/i);
  });

  it('sends the setup from one place, in the elevated mode, with fat-g’s probe folder, and reaches that place from the user’s press alone (C60, C62, C72)', () => {
    const sandbox = code(source('sandbox.ts'));
    expect(sandbox.match(/'windowsSandbox\/setupStart'/g)).toHaveLength(1);
    expect(sandbox).toContain("reply = await sendRequest('sandbox', connection, 'windowsSandbox/setupStart', { mode: 'elevated', cwd: context.probeDirectory }, { timeoutMs: timings.setupMs });");
    expect(filesWith("'elevated'")).toEqual(['sandbox.ts']);
    expect(sources.filter(({ text }) => text.includes('unelevated')).map(({ file }) => file)).toEqual([]);
    // The request is in `run`, and `run` is called once: by `act`, at a `start`. Nothing of a timer or a retry calls it.
    expect(sandbox.match(/\brun\(mine\)/g)).toHaveLength(1);
    expect(sandbox).toContain('void run(mine);');
    expect(sandbox.match(/setTimeout|setInterval/g)).toBeNull();
    // Readiness is asked on a connection of its own, never on a setup's.
    expect(sandbox.match(/'windowsSandbox\/readiness'/g)).toHaveLength(1);
    // Only the facet reaches the setup, and the facet makes it on Windows alone.
    expect(filesWith('createCodexSandbox')).toEqual(['facet.ts', 'sandbox.ts']);
    expect(code(source('facet.ts'))).toContain("const sandbox: CodexSandbox | undefined = !windows ? undefined : createCodexSandbox({");
  });

  it('writes a reply to a request for leave as one of three decisions, in approvals.ts, and the immediate decline of Read only; never the rule Codex would save (C13, C22, C69)', () => {
    expect(code(source('approvals.ts'))).toContain("return { decision: choice === 'approve' ? 'accept' : choice === 'approve-session' ? 'acceptForSession' : 'decline' };");
    expect(filesWith(/decision: '/)).toEqual(['approvals.ts', 'session.ts']);
    expect(code(source('session.ts')).match(/decision: '[^']*'/g)).toEqual(["decision: 'decline'"]);
    // The session's grant is written from that one function: read in the schemas, and written nowhere else.
    expect(filesWith("'acceptForSession'")).toEqual(['approvals.ts', 'session-schemas.ts']);
    expect(code(source('session.ts'))).toContain("return write(requestId, hold, { result: hold.answer === 'elicitation' ? elicitationOf(choice) : decisionOf(choice) });");
    expect(code(source('session.ts')).match(/decisionOf\(/g)).toHaveLength(1);
    // An MCP tool's leave (decision 0018) is answered from approvals.ts's one function too: at a
    // decision, and as Read only's immediate decline. Its session persistence is written there alone,
    // and `always`, a rule Codex would keep, is only ever read.
    expect(code(source('session.ts')).match(/elicitationOf\([^)]*\)/g)?.sort()).toEqual(["elicitationOf('deny')", 'elicitationOf(choice)']);
    expect(filesWith(/action: '/)).toEqual(['approvals.ts']);
    expect(filesWith(/persist: 'session'/)).toEqual(['approvals.ts']);
    expect(filesWith("'always'")).toEqual(['session-schemas.ts']);
    // Codex's amendment, a root and a cancel are in no code, even in a comment: it is told by its name's pattern alone.
    for (const forbidden of ['acceptWithExecpolicyAmendment', 'execpolicy_amendment', 'applyNetworkPolicyAmendment']) {
      expect(sources.filter(({ text }) => text.includes(forbidden)).map(({ file }) => file), forbidden).toEqual([]);
    }
    expect(filesWith(/grantRoot:/).filter((file) => file !== 'session-schemas.ts')).toEqual([]);
    expect(filesWith("'cancel'")).toEqual(['session-schemas.ts']);
  });

  it('compares a repeated delivery with its hold before it is counted, in the one place both kinds of request are taken (C91)', () => {
    const session = code(source('session.ts'));
    const taken = session.slice(session.indexOf('function take(method: string'), session.indexOf('function asked(method: string'));
    expect(taken).toContain('if (existing.method === method && sameValue(existing.params, params))');
    expect(taken.indexOf('sameValue(')).toBeLessThan(taken.indexOf('.repeated += 1'));
    expect(session.match(/\.repeated \+= 1/g)).toHaveLength(1);
    expect(taken).toContain("reason: 'changed'");
  });

  it('counts Codex’s own reviewer’s frames and maps none of them (C96)', () => {
    expect([...REVIEW_METHODS]).toEqual(['item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'guardianWarning']);
    for (const method of REVIEW_METHODS) expect((MAPPED_METHODS as readonly string[]).includes(method), method).toBe(false);
    expect(code(source('session.ts'))).toContain('for (const method of REVIEW_METHODS) opened.onNotification(method, () => { counts.reviews += 1; });');
  });

  it('keeps nothing of a line over the limit but its kind, its id and its size: the bytes stop at session-process.ts (C67)', () => {
    expect(filesWith('peekLine')).toEqual(['session-process.ts']);
    expect(filesWith(/\.peek\b/)).toEqual(['session-process.ts']);
    expect(filesWith('OversizedLine').filter((file) => file !== 'session-test-support.ts')).toEqual(['session-process.ts']);
    expect(code(source('session.ts'))).toContain('function onOversized(line: PeekedLine): void {');
  });

  it('lists a mode as validated only where a capture shows a turn under it, started with that mode’s own triple (C85, C93, C94)', () => {
    const captures = path.join(ROOT, 'tests/fixtures/codex/captures');
    interface Frame { readonly dir: string; readonly frame: { readonly method?: string; readonly params?: Record<string, unknown> } }
    const all = readdirSync(captures).filter((name) => name.endsWith('.json')).map((name) => (JSON.parse(readFileSync(path.join(captures, name), 'utf8')) as { frames: Frame[] }).frames);
    for (const id of VALIDATED_MODES) {
      const wanted = startPolicy(id);
      const shown = all.some((frames) => {
        const start = frames.find((f) => f.dir === 'send' && f.frame.method === 'thread/start');
        const named = start?.frame.params ?? {};
        return named['sandbox'] === wanted.sandbox && named['approvalPolicy'] === wanted.approvalPolicy && named['approvalsReviewer'] === wanted.approvalsReviewer
          && frames.some((f) => f.dir === 'recv' && f.frame.method === 'turn/completed');
      });
      expect(shown, id).toBe(true);
    }
    expect(VALIDATED_MODES.every((id) => (CODEX_MODE_IDS as readonly string[]).includes(id))).toBe(true);
  });
});
