// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary on Claude end to end (docs/planning/_archive/M26.md, Design 2; Verification): the production
// adapter's facet, the real process layer and the deterministic CLI, which replays M26's K1 capture.
// No installed CLI, account or credential is involved.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessServices } from '../../src/main/process';
import { pidAlive } from '../../src/main/process/tree-kill';
import { createClaudeDefinition } from '../../src/main/providers/claude';
import { TITLE_TASK } from '../../src/main/sessions/secretary/title';
import { claudeHarness } from './chat/harness';

const fixture = path.resolve('tests/fixtures/fake-claude-cli.mjs');
process.env['CLAUDE_CONFIG_DIR'] = path.join(os.tmpdir(), `fatg-claude-config-${process.pid}`);
const PROMPT = 'The login form lets me press Submit before both fields are filled in. Make the button stay disabled until both are there, and add a test.';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fatg-claude-secretary-'));
  const fixtureDir = path.join(dir, 'fixture');
  await mkdir(fixtureDir);
  const services = createProcessServices(path.join(dir, 'user-data'));
  const definition = createClaudeDefinition({ argsPrefix: [fixture, '--fixture-dir', fixtureDir], executableNames: [path.basename(process.execPath)], startupTimeoutMs: 1500, usageTimeoutMs: 1500 });
  const context = services.createContext(definition.environment);
  const provider = definition.factory(context);
  const logged: string[] = [];
  const spies = (['log', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); }));
  cleanups.push(async () => {
    for (const spy of spies) spy.mockRestore();
    await provider.dispose().catch(() => undefined);
    await services.killAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await provider.detect({ override: process.execPath, knownDirs: [] }, new AbortController().signal);
  const secretary = provider.sessions?.secretary;
  if (secretary === undefined) throw new Error('the Claude facet has no secretary');
  const files = async (prefix: string) => (await readdir(fixtureDir)).filter((name) => name.startsWith(prefix));
  const json = async (name: string) => JSON.parse(await readFile(path.join(fixtureDir, name), 'utf8')) as Record<string, unknown>;
  const pids = async () => (await readFile(path.join(fixtureDir, 'pids'), 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean).map((line) => Number(line.split(' ')[0]));
  return { secretary, fixtureDir, files, json, pids, logged, control: (values: Record<string, number>) => writeFile(path.join(fixtureDir, 'control.json'), JSON.stringify(values)) };
}

const ask = (h: Awaited<ReturnType<typeof harness>>, extra: { effort?: string | null; signal?: AbortSignal } = {}) =>
  h.secretary({ instructions: TITLE_TASK.instructions, text: TITLE_TASK.input(PROMPT), model: 'haiku', effort: extra.effort ?? null }, extra.signal ?? new AbortController().signal);

describe('the secretary on Claude, through the real process layer (M26)', () => {
  it('answers K1’s title with one process in the probe folder, initialize carrying one system prompt and one prompt sent, then ends it', async () => {
    const h = await harness();
    const answer = await ask(h);
    expect(answer).toEqual({ kind: 'answered', text: 'Login form validation test' });
    expect(TITLE_TASK.parse(answer.kind === 'answered' ? answer.text : '')).toBe('Login form validation test');
    const [launched] = await h.files('secretary-');
    const record = await h.json(launched ?? '');
    expect(record).toMatchObject({ model: 'haiku', effort: null });
    expect(path.basename(String(record['cwd']))).toBe('probe-cwd');
    const [initialized] = await h.files('secretary-initialize-');
    expect(await h.json(initialized ?? '')).toEqual({ fields: ['subtype', 'systemPrompt'], oneSystemPrompt: true });
    expect((await readFile(path.join(h.fixtureDir, 'secretary-prompts'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect((await h.pids()).every((pid) => !pidAlive(pid))).toBe(true);
    // Nothing of the prompt reaches a log.
    expect(h.logged.join('\n')).not.toContain('Submit');
  });

  it('names the level on the command line where one is given', async () => {
    const h = await harness();
    expect((await ask(h, { effort: 'low' })).kind).toBe('answered');
    const [launched] = (await h.files('secretary-')).filter((name) => !name.startsWith('secretary-initialize') && !name.startsWith('secretary-prompts'));
    expect(await h.json(launched ?? '')).toMatchObject({ model: 'haiku', effort: 'low' });
  });

  it('refuses what the CLI asks, and answers no title for a reply with no text', async () => {
    const h = await harness();
    await h.control({ secretaryRequest: 1, secretaryEmpty: 1 });
    expect(await ask(h)).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(await h.files('secretary-request-refused-')).toHaveLength(1);
    expect(await h.files('secretary-request-accepted-')).toEqual([]);
  });

  // The empty `--tools ""` and `--setting-sources=` through cmd's own parsing of a `.cmd` file (M16, C20).
  it.runIf(process.platform === 'win32')('carries its arguments through a `.cmd` shim, the empty one included', async () => {
    const h = await claudeHarness({ shim: true });
    cleanups.push(() => h.dispose());
    const secretary = h.facet.secretary;
    if (secretary === undefined) throw new Error('the Claude facet has no secretary');
    const answer = await secretary({ instructions: TITLE_TASK.instructions, text: TITLE_TASK.input(PROMPT), model: 'haiku', effort: 'low' }, new AbortController().signal);
    expect(answer).toEqual({ kind: 'answered', text: 'Login form validation test' });
    const launched = readdirSync(h.fixture).filter((name) => /^secretary-\d+\.json$/.test(name));
    expect(launched).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(h.fixture, launched[0] ?? ''), 'utf8'))).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(readdirSync(h.fixture)).not.toContain('unexpected-args');
  });

  it('ends a process that never answers when the request is let go of', async () => {
    const h = await harness();
    await h.control({ secretaryHang: 1 });
    const controller = new AbortController();
    const answer = ask(h, { signal: controller.signal });
    for (let tries = 0; tries < 100 && (await h.files('hung-')).length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    expect(await answer).toEqual({ kind: 'failed', reason: 'aborted' });
    expect((await h.pids()).every((pid) => !pidAlive(pid))).toBe(true);
  });
});
