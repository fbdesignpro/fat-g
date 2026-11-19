// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V12 (docs/planning/_archive/M18.md; C9, C25): Codex, on the real adapter and process layer against the
// replay fake, passes the conversation store's contract — the same set the example provider passes
// in both its forms (tests/sessions/store-contract.test.ts). And what only a real adapter can show:
// that nothing of a frame the store has no place for reaches it.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentProvider } from '@shared/provider-kit/provider';
import { storeFiles } from '../../src/main/conversations/format';
import { launchApp, placeRecords, S, sessionEntry, until } from '../sessions/app';
import { describeStoreContract } from '../sessions/store-contract';
import { codexHarness, type Harness, PROMPTS } from './harness';

describeStoreContract('Codex, against the replay fake', async () => {
  const h = await codexHarness();
  let adapter: AgentProvider | undefined;
  return {
    descriptor: h.provider.descriptor,
    dir: path.join(h.dir, 'records'),
    folder: h.project,
    model: 'gpt-6-astra',
    effort: 'low',
    prompt: PROMPTS.saved,
    // An adapter of its own for each run, ended with it as the app's quit ends it: the next run's
    // sessions start in new processes.
    async facet() {
      await adapter?.dispose();
      const made = await h.adapter();
      adapter = made.provider;
      return made.facet;
    },
    dispose: () => h.dispose(),
  };
});

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

describe('what the store takes of Codex’s frames (V4; C9, C10; M20a, C30)', () => {
  it('keeps the messages, the turn and what the session did between them, and no account field or frame', async () => {
    const h = harness = await codexHarness();
    const dir = path.join(h.dir, 'records');
    placeRecords(dir, h.project, 'codex', [sessionEntry(1, 'codex', { model: 'gpt-6-astra' })]);
    // As the app does at start: the account is read, with its email, before any session.
    const account = await h.provider.getAccount(new AbortController().signal);
    const email = account.kind === 'account' ? account.account.email : undefined;
    expect(typeof email).toBe('string');
    const app = launchApp({ dir, descriptor: h.provider.descriptor, facet: () => h.facet, userDefault: () => 'ask-first' });
    // The saved thread's turn runs a command and reads a file: its frames hold a command line.
    expect(await app.runtime.send(S(1), PROMPTS.saved)).toEqual({ status: 'accepted' });
    await until(() => !app.service.isRunning(S(1)), 'the turn ending', 20_000);
    const stored = (): string => storeFiles().filter((file) => existsSync(path.join(dir, file))).map((file) => readFileSync(path.join(dir, file), 'latin1')).join('\n');
    const text = stored();
    // What was said is there…
    expect(text).toContain(PROMPTS.saved.slice(0, 40));
    // …and what it did (M20a, C30): the command it ran is conversation content now, kept as an activity of its turn.
    expect(text).toContain('Get-Content -LiteralPath sample.txt');
    expect(app.read(1).items.filter((item) => item.kind === 'activity')).toMatchObject([{ state: 'complete', workerId: null, activity: { type: 'read', status: 'completed', name: 'commandExecution', exitCode: 0 } }]);
    // Nothing the events' schemas do not let through: no field of the item the adapter does not read,
    // no process id, no account, no method name.
    for (const absent of ['aggregatedOutput', 'commandActions', 'unifiedExecStartup', 'scriptPath', 'processId', '97630', 'thread/start', 'turn/completed', 'approvalPolicy', String(email)]) expect(text, absent).not.toContain(absent);
    // The reference and the folder it started in are kept, as the record keeps them (C28).
    expect(app.conversations.conversation(S(1))).toMatchObject({ folder: h.project });
    expect(typeof app.conversations.conversation(S(1))?.reference).toBe('string');
    await app.quit();
  });
});
