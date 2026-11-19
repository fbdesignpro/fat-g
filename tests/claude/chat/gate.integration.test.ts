// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6 (docs/planning/_archive/M16.md; C17, C18, C23): the gate stands before every launch of a Claude session's
// process. Each failing row of its table that a run of the app's session side can show, on the real
// adapter and process layer against the replay fake: no process is started, and no frame is written.
// The rows that are the session service's holds — an instance switched off, a configuration folder
// that moved — name no provider, and are src/main/sessions/'s own tests'.
//
// Claude loads a folder's configuration when its process starts, before any prompt: a launch the
// gate let through in a folder it should not have would already have run that folder's hooks.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import { STORE_FILE } from '../../../src/main/conversations/format';
import { type App, type AppOptions, launchApp, placeRecords, S, sessionEntry } from '../../sessions/app';
import { claudeHarness, type Harness } from './harness';

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
});

const dataDir = (h: Harness): string => path.join(h.dir, 'records');

interface Row {
  readonly reason: string;
  /** How the records are placed for it. */
  readonly place?: (h: Harness) => void;
  readonly app?: (h: Harness) => Partial<AppOptions>;
}

const session = (overrides: Record<string, unknown> = {}) => sessionEntry(1, 'claude', { model: 'sonnet', ...overrides });
const without = (descriptor: ProviderDescriptor): ProviderDescriptor => ({ ...descriptor, capabilities: { ...descriptor.capabilities, sessions: false } });

const ROWS: readonly Row[] = [
  { reason: 'conversations-refused', place: (h) => { placeRecords(dataDir(h), h.project, 'claude', [session()]); writeFileSync(path.join(dataDir(h), STORE_FILE), Buffer.alloc(8192, 3)); } },
  { reason: 'demo', app: () => ({ demo: () => true }) },
  { reason: 'provider-unavailable', app: () => ({ status: () => ({ kind: 'not-installed', overrideInvalid: false }) }) },
  { reason: 'no-sessions', app: (h) => ({ descriptor: without(h.provider.descriptor) }) },
  { reason: 'not-offered', place: (h) => placeRecords(dataDir(h), h.project, 'claude', [session()], { providers: ['codex'] }) },
  { reason: 'signed-out', app: () => ({ status: () => ({ kind: 'not-logged-in' }) }) },
  { reason: 'not-connected', app: () => ({ facet: () => undefined }) },
  { reason: 'folder-not-root', place: (h) => placeRecords(dataDir(h), h.project, 'claude', [session({ reference: '33333333-3333-4333-8333-333333333333', folder: path.join(h.dir, 'elsewhere') })]) },
  { reason: 'folder-not-trusted', place: (h) => placeRecords(dataDir(h), h.project, 'claude', [session()], { answer: 'not-trusted' }) },
  { reason: 'folder-missing', app: (h) => ({ isMissing: (root) => root === h.project }) },
];

describe('the gate, before every launch of a Claude session (V6; C18)', () => {
  it.each(ROWS.map((row) => [row.reason, row] as const))('%s: the prompt is refused with that reason, no process starts and no frame is written', async (reason, row) => {
    const h = harness = await claudeHarness();
    if (row.place === undefined) placeRecords(dataDir(h), h.project, 'claude', [session()]); else row.place(h);
    const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet, ...row.app?.(h) });
    apps.push(app);
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'refused', reason });
    // Selecting it, and reading its chat, start nothing either.
    await app.select(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.pids('chat')).toEqual([]);
    expect(h.sessions()).toEqual({});
    expect(app.service.isRunning(S(1))).toBe(false);
    expect(h.markers()).toEqual([]);
  });

  it('covers a resume as a first prompt: a started session in a folder that is no longer trusted launches nothing', async () => {
    const h = harness = await claudeHarness();
    placeRecords(dataDir(h), h.project, 'claude', [session()]);
    const first = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    apps.push(first);
    expect(await first.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const look = (): void => { if (!first.service.isRunning(S(1))) resolve(); else if (Date.now() > deadline) reject(new Error('the turn did not end')); else setTimeout(look, 20); };
      look();
    });
    await first.service.settled();
    apps = [];
    await first.quit();
    await h.provider.dispose();
    const launches = h.only().entry.launches.length;

    // The trust answer is withdrawn between the two runs.
    const records = path.join(dataDir(h), 'records.json');
    const stored = JSON.parse(readFileSync(records, 'utf8')) as { projects: { roots: { trust: { answer: string } }[] }[] };
    (stored.projects[0]?.roots[0] as { trust: { answer: string } }).trust.answer = 'not-trusted';
    writeFileSync(records, JSON.stringify(stored));
    const adapter = await h.adapter();
    const second = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => adapter.facet });
    apps.push(second);
    expect(await second.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'refused', reason: 'folder-not-trusted' });
    expect(h.only().entry.launches).toHaveLength(launches);
    expect(h.running('chat')).toEqual([]);
    // The chat fat-g saved is still read: the gate stands before a launch, not before the store.
    expect(second.read(1).items.length).toBeGreaterThan(0);
  });
});

describe('the configuration a Claude session runs under (V6; C17, C23)', () => {
  it('is the user’s own, through the CLI: the launch names the three setting sources and no other setting flag', async () => {
    const h = harness = await claudeHarness();
    placeRecords(dataDir(h), h.project, 'claude', [session()]);
    const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet });
    apps.push(app);
    expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
    const { args } = await new Promise<{ args: readonly string[] }>((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const look = (): void => {
        const launch = Object.values(h.sessions())[0]?.launches[0];
        if (launch !== undefined) resolve(launch); else if (Date.now() > deadline) reject(new Error('no launch')); else setTimeout(look, 20);
      };
      look();
    });
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    for (const flag of ['--settings', '--strict-mcp-config', '--mcp-config', '--setting-sources=', '--append-system-prompt', '--system-prompt', '--agents', '--plugin-dir']) expect(args, flag).not.toContain(flag);
  });

  it('names no settings file and no trust record of Claude’s anywhere in the module', () => {
    const folder = path.resolve('src/main/providers/claude');
    for (const file of ['chat-wire.ts', 'chat-launch.ts', 'chat-frames.ts', 'chat-mapper.ts', 'chat-session.ts', 'facet.ts', 'index.ts']) {
      const text = readFileSync(path.join(folder, file), 'utf8');
      expect(text, file).not.toMatch(/settings(\.local)?\.json|\.claude\.json|hasTrustDialogAccepted|projects\[/);
    }
  });
});
