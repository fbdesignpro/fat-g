// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15 (docs/planning/_archive/M14b.md; C54): the fake CLIs honour the variable that names a configuration
// folder. Each is started here as a plain child, with the variable set, and answers with the account
// its accounts file holds for that folder: its identity, its usage, its models and their levels. A
// folder with no entry reads as not signed in, and the fake opens nothing in any folder.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Json = Record<string, unknown>;
const CLAUDE = path.resolve('tests/fixtures/fake-claude-cli.mjs');
const CODEX = path.resolve('tests/fixtures/fake-codex-cli.mjs');
const fixtureJson = (name: string): Json => JSON.parse(readFileSync(path.resolve('tests/fixtures', name), 'utf8')) as Json;
const constants = fixtureJson('claude/fake-cli-constants.json') as { email: string; organization: string };
const CONTROL_ARGS = (fixtureJson('claude/sdk-0.3.278-wire.json')['spawn'] as { args: string[] }).args;
const CLAUDE_MODELS = fixtureJson('claude/models.json')['models'] as (Json & { value: string; supportedEffortLevels?: string[] })[];
const CODEX_MODELS = fixtureJson('codex/model-list.json')['data'] as (Json & { id: string; supportedReasoningEfforts: { reasoningEffort: string }[] })[];

/** A value by its path, so a reply is read without trusting its shape. */
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);

/** This process's environment without anything that names a folder or steers a fake. */
function environment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^(CLAUDE_CONFIG_DIR|CODEX_HOME|FATG_SMOKE_)/i.test(name)) env[name] = value;
  return { ...env, ...extra };
}

interface Session {
  readonly pid: number;
  send(value: Json): void;
  /** The first line that matches, of those received so far or to come. */
  next(match: (line: Json) => boolean): Promise<Json>;
  close(): Promise<number | null>;
}
const open: ChildProcessWithoutNullStreams[] = [];
function start(args: string[], env: NodeJS.ProcessEnv): Session {
  const child = spawn(process.execPath, args, { env, windowsHide: true });
  open.push(child);
  const lines: Json[] = [];
  let wake: (() => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    try { lines.push(JSON.parse(line) as Json); } catch { return; }
    for (const resolve of wake.splice(0)) resolve();
  });
  child.on('close', () => { for (const resolve of wake.splice(0)) resolve(); wake = []; });
  return {
    pid: child.pid ?? -1,
    send: (value) => { child.stdin.write(`${JSON.stringify(value)}\n`); },
    async next(match) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = lines.find(match);
        if (found !== undefined) return found;
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no matching line (exit code ${String(child.exitCode)})`);
        await new Promise<void>((resolve) => { wake.push(resolve); setTimeout(resolve, 100); });
      }
    },
    close: () => new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(child.exitCode); return; }
      child.on('close', (code) => resolve(code));
      child.stdin.end();
    }),
  };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-fake-accounts-')); });
afterEach(async () => {
  await Promise.all(open.splice(0).map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.on('close', () => resolve());
    child.kill();
  })));
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Folders that are only ever names: none of them is made unless a test makes it. */
const folder = (name: string): string => path.join(dir, 'accounts', name);

describe('the Claude fake, by configuration folder', () => {
  let fixtureDir: string;
  const accounts = (): Json => ({
    [folder('work')]: { email: 'work@example.test', organization: 'Work Org', plan: 'pro', usage: { session: 7, weekly: 8, scoped: 9 }, models: ['sonnet', 'haiku'], efforts: { sonnet: ['low', 'medium'] } },
    [folder('side')]: { email: 'side@example.test', usage: { session: 70 } },
    [folder('out')]: { state: 'logged-out', email: 'never-shown@example.test' },
  });
  beforeEach(() => {
    fixtureDir = path.join(dir, 'fixture');
    mkdirSync(fixtureDir);
  });
  const place = (value: Json = accounts()): void => writeFileSync(path.join(fixtureDir, 'accounts.json'), JSON.stringify(value));
  const env = (configFolder?: string): NodeJS.ProcessEnv => environment(configFolder === undefined ? {} : { CLAUDE_CONFIG_DIR: configFolder });
  const authStatus = (configFolder?: string): { code: number | null; status: Json; text: string } => {
    const result = spawnSync(process.execPath, [CLAUDE, '--fixture-dir', fixtureDir, 'auth', 'status'], { env: env(configFolder), encoding: 'utf8', windowsHide: true });
    return { code: result.status, status: JSON.parse(result.stdout) as Json, text: result.stdout };
  };
  const session = (configFolder?: string): Session => start([CLAUDE, '--fixture-dir', fixtureDir, ...CONTROL_ARGS], env(configFolder));
  const ask = async (opened: Session, subtype: string, extra: Json = {}): Promise<Json> => {
    opened.send({ type: 'control_request', request_id: subtype, request: { subtype, ...extra } });
    return (await opened.next((line) => line['type'] === 'control_response' && at(line, 'response', 'request_id') === subtype))['response'] as Json;
  };
  /** One session's `initialize` and `get_usage` replies. */
  const read = async (configFolder?: string): Promise<{ init: Json; usage: Json }> => {
    const opened = session(configFolder);
    const init = await ask(opened, 'initialize');
    const usage = await ask(opened, 'get_usage', { skip_behaviors: true });
    expect(await opened.close()).toBe(0);
    return { init, usage };
  };
  const listed = (init: Json): string[] => (at(init, 'response', 'models') as { value: string }[]).map((model) => model.value);
  const percents = (usage: Json): unknown[] => (at(usage, 'response', 'rate_limits', 'limits') as Json[]).slice(0, 3).map((limit) => limit['percent']);

  it('answers two folders each with its own account, usage, models and levels', async () => {
    place();
    const work = authStatus(folder('work'));
    expect(work.code).toBe(0);
    expect(work.status).toMatchObject({ loggedIn: true, authMethod: 'claude.ai', email: 'work@example.test', orgName: 'Work Org', subscriptionType: 'pro' });
    const side = authStatus(folder('side'));
    expect(side.status).toMatchObject({ loggedIn: true, email: 'side@example.test', orgName: constants.organization, subscriptionType: 'max' });

    const first = await read(folder('work'));
    expect(at(first.init, 'response', 'account')).toEqual({ email: 'work@example.test', organization: 'Work Org', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' });
    expect(listed(first.init)).toEqual(['sonnet', 'haiku']);
    expect(percents(first.usage)).toEqual([7, 8, 9]);
    const second = await read(folder('side'));
    expect(at(second.init, 'response', 'account', 'email')).toBe('side@example.test');
    expect(listed(second.init)).toEqual(CLAUDE_MODELS.map((model) => model.value));
    // What an entry does not give stays the fixture's.
    expect(percents(second.usage)).toEqual([70, 81, 44]);
  });

  it('leaves rows and levels out by name, and changes nothing else of the captured reply', async () => {
    place();
    const { init } = await read(folder('work'));
    const models = at(init, 'response', 'models') as (Json & { value: string })[];
    const captured = (value: string) => CLAUDE_MODELS.find((model) => model.value === value);
    expect(models.find((model) => model.value === 'haiku')).toEqual(captured('haiku'));
    expect(models.find((model) => model.value === 'sonnet')).toEqual({ ...captured('sonnet'), supportedEffortLevels: ['low', 'medium'] });
    expect(at(init, 'response', 'fast_mode_state')).toEqual(fixtureJson('claude/models.json')['fast_mode_state']);
    // The other account's reply is the capture as it is.
    expect(at((await read(folder('side'))).init, 'response', 'models')).toEqual(CLAUDE_MODELS);
  });

  it.each([
    ['a folder with no entry', 'empty'],
    ['a folder whose entry is signed out', 'out'],
  ])('reads %s as not signed in', async (_name, name) => {
    place();
    const auth = authStatus(folder(name));
    expect(auth.code).toBe(1);
    expect(auth.status).toEqual({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
    const { init, usage } = await read(folder(name));
    expect(init['subtype']).toBe('success');
    // As M14b's spike saw of a signed-out folder: an account with no email.
    expect(Object.keys(at(init, 'response', 'account') as Json).sort()).toEqual(['apiProvider', 'tokenSource']);
    expect(usage['subtype']).toBe('error');
    expect(`${auth.text}${JSON.stringify(init)}${JSON.stringify(usage)}`).not.toMatch(/@example\.test/);
  });

  it('answers as it always did with no accounts file, whatever folder the variable names', async () => {
    expect(authStatus(folder('work')).status).toMatchObject({ loggedIn: true, email: constants.email, orgName: constants.organization });
    const { init, usage } = await read(folder('anything'));
    expect(at(init, 'response', 'account', 'email')).toBe(constants.email);
    expect(listed(init)).toEqual(CLAUDE_MODELS.map((model) => model.value));
    expect(percents(usage)).toEqual([12, 81, 44]);
  });

  it('with the variable unset, is the first account: the one under "default", or the fixture’s own', async () => {
    place();
    expect(authStatus().status).toMatchObject({ loggedIn: true, email: constants.email });
    place({ ...accounts(), default: { email: 'first@example.test', models: ['haiku'] } });
    expect(authStatus().status).toMatchObject({ loggedIn: true, email: 'first@example.test' });
    expect(listed((await read()).init)).toEqual(['haiku']);
    // The other folders are still their own.
    expect(authStatus(folder('work')).status).toMatchObject({ email: 'work@example.test' });
  });

  it('knows one folder under its other spellings', () => {
    place();
    expect(authStatus(`${folder('work')}${path.sep}`).status).toMatchObject({ email: 'work@example.test' });
    if (process.platform === 'win32') {
      expect(authStatus(folder('work').toUpperCase()).status).toMatchObject({ email: 'work@example.test' });
      expect(authStatus(folder('work').replaceAll('\\', '/')).status).toMatchObject({ email: 'work@example.test' });
    } else {
      expect(authStatus(folder('work').toUpperCase()).status).toMatchObject({ loggedIn: false });
    }
  });

  it('uses the folder as a key only: it opens, makes and changes nothing there', async () => {
    const real = folder('work');
    mkdirSync(real, { recursive: true });
    const login = path.join(real, '.credentials.json');
    writeFileSync(login, 'the account’s own');
    const before = statSync(login);
    place();
    expect(authStatus(real).status).toMatchObject({ email: 'work@example.test' });
    await read(real);
    expect(readdirSync(real)).toEqual(['.credentials.json']);
    expect(readFileSync(login, 'utf8')).toBe('the account’s own');
    expect(statSync(login).mtimeMs).toBe(before.mtimeMs);
    // And a folder that is not there is answered for all the same, and still is not there.
    expect(authStatus(folder('side')).status).toMatchObject({ email: 'side@example.test' });
    await read(folder('side'));
    expect(existsSync(folder('side'))).toBe(false);
  });

  it('lets two accounts each run a session at once, and still records two sessions of one account', async () => {
    place();
    const overlaps = (): string => (existsSync(path.join(fixtureDir, 'overlaps')) ? readFileSync(path.join(fixtureDir, 'overlaps'), 'utf8') : '');
    const work = session(folder('work'));
    await ask(work, 'initialize');
    const side = session(folder('side'));
    await ask(side, 'initialize');
    // Both are open, each in its own folder: no overlap.
    expect(overlaps()).toBe('');
    // A second session of the first account, while its first is open: the overlap fat-g must never create.
    const again = session(folder('work'));
    await ask(again, 'initialize');
    expect(overlaps()).toBe(`${work.pid} ${again.pid}\n`);
    await Promise.all([work.close(), side.close(), again.close()]);
    // Once they have ended, the account is free again.
    await read(folder('work'));
    expect(overlaps()).toBe(`${work.pid} ${again.pid}\n`);
  });

  it('stops at an accounts file that is not a map, and guesses no account', () => {
    writeFileSync(path.join(fixtureDir, 'accounts.json'), '[]');
    const result = spawnSync(process.execPath, [CLAUDE, '--fixture-dir', fixtureDir, 'auth', 'status'], { env: env(folder('work')), encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(65);
    expect(result.stdout).toBe('');
  });
});

describe('the Codex fake, by home', () => {
  let accountsFile: string;
  const accounts = (): Json => ({
    [folder('work')]: { email: 'work@example.test', plan: 'plus', usage: { primary: 5, secondary: 6 }, models: ['gpt-6-sol', 'gpt-5.5'], efforts: { 'gpt-6-sol': ['low', 'high'] } },
    [folder('side')]: { email: 'side@example.test' },
    [folder('out')]: { state: 'logged-out', email: 'never-shown@example.test' },
  });
  beforeEach(() => { accountsFile = path.join(dir, 'codex-accounts.json'); });
  const place = (value: Json = accounts()): void => writeFileSync(accountsFile, JSON.stringify(value));
  /** One app-server's replies to `account/read`, `model/list` and `account/rateLimits/read`, and its first push. */
  const read = async (home?: string, withAccounts = true): Promise<{ account: Json; models: Json; limits: Json; pushed: Json | null }> => {
    const opened = start([CODEX, 'app-server'], environment({ ...(home === undefined ? {} : { CODEX_HOME: home }), ...(withAccounts ? { FATG_SMOKE_CODEX_ACCOUNTS: accountsFile } : {}) }));
    const reply = async (id: number, method: string, params?: Json): Promise<Json> => {
      opened.send({ id, method, ...(params === undefined ? {} : { params }) });
      return opened.next((line) => line['id'] === id);
    };
    await reply(1, 'initialize', { clientInfo: { name: 'test', title: 'test', version: '0' } });
    opened.send({ method: 'initialized' });
    const account = await reply(2, 'account/read', { refreshToken: false });
    const models = await reply(3, 'model/list', {});
    const limits = await reply(4, 'account/rateLimits/read');
    const pushed = 'result' in limits ? await opened.next((line) => line['method'] === 'account/rateLimits/updated') : null;
    expect(await opened.close()).toBe(0);
    return { account, models, limits, pushed };
  };
  const listed = (models: Json): string[] => (at(models, 'result', 'data') as { id: string }[]).map((model) => model.id);
  const used = (limits: Json): unknown[] => ['primary', 'secondary'].map((window) => at(limits, 'result', 'rateLimitsByLimitId', 'codex', window, 'usedPercent'));

  it('answers two homes each with its own account, usage, models and levels', async () => {
    place();
    const work = await read(folder('work'));
    expect(at(work.account, 'result')).toEqual({ account: { type: 'chatgpt', email: 'work@example.test', planType: 'plus' }, requiresOpenaiAuth: true });
    expect(listed(work.models)).toEqual(['gpt-6-sol', 'gpt-5.5']);
    expect(used(work.limits)).toEqual([5, 6]);
    expect(at(work.pushed, 'params', 'rateLimits', 'primary', 'usedPercent')).toBe(6);
    const side = await read(folder('side'));
    expect(at(side.account, 'result', 'account')).toEqual({ type: 'chatgpt', email: 'side@example.test', planType: 'pro' });
    expect(listed(side.models)).toEqual(CODEX_MODELS.map((model) => model.id));
    expect(used(side.limits)).toEqual([41, 19]);
  });

  it('leaves rows and levels out by name, and changes nothing else of the captured reply', async () => {
    place();
    const { models } = await read(folder('work'));
    const data = at(models, 'result', 'data') as (Json & { id: string })[];
    const captured = (id: string) => CODEX_MODELS.find((model) => model.id === id);
    expect(data.find((model) => model.id === 'gpt-5.5')).toEqual(captured('gpt-5.5'));
    const sol = captured('gpt-6-sol');
    expect(data.find((model) => model.id === 'gpt-6-sol')).toEqual({ ...sol, supportedReasoningEfforts: sol?.supportedReasoningEfforts.filter((effort) => ['low', 'high'].includes(effort.reasoningEffort)) });
    expect(at((await read(folder('side'))).models, 'result')).toEqual(fixtureJson('codex/model-list.json'));
  });

  it.each([
    ['a home with no entry', 'empty'],
    ['a home whose entry is signed out', 'out'],
  ])('reads %s as not signed in, and refuses its readings as the CLI does', async (_name, name) => {
    place();
    const { account, limits } = await read(folder(name));
    expect(at(account, 'result')).toEqual({ account: null, requiresOpenaiAuth: true });
    expect(limits['error']).toEqual({ code: -32600, message: 'codex account authentication required to read rate limits' });
    expect(`${JSON.stringify(account)}${JSON.stringify(limits)}`).not.toMatch(/@example\.test/);
  });

  it('answers as it always did with no accounts file, and for the first account with the variable unset', async () => {
    const before = await read(folder('work'), false);
    expect(at(before.account, 'result', 'account')).toEqual({ type: 'chatgpt', email: 'smoke@example.test', planType: 'pro' });
    expect(used(before.limits)).toEqual([41, 19]);
    place();
    expect(at((await read()).account, 'result', 'account', 'email')).toBe('smoke@example.test');
    place({ ...accounts(), default: { email: 'first@example.test', plan: 'pro' } });
    expect(at((await read()).account, 'result', 'account', 'email')).toBe('first@example.test');
  });

  it('uses the home as a key only: it opens, makes and changes nothing there', async () => {
    const real = folder('work');
    mkdirSync(real, { recursive: true });
    const login = path.join(real, 'auth.json');
    writeFileSync(login, 'the account’s own');
    const before = statSync(login);
    place();
    expect(at((await read(`${real}${path.sep}`)).account, 'result', 'account', 'email')).toBe('work@example.test');
    expect(readdirSync(real)).toEqual(['auth.json']);
    expect(readFileSync(login, 'utf8')).toBe('the account’s own');
    expect(statSync(login).mtimeMs).toBe(before.mtimeMs);
    await read(folder('side'));
    expect(existsSync(folder('side'))).toBe(false);
  });
});
