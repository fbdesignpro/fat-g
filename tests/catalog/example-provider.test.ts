// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V19 (docs/planning/_archive/M13.md; C20, C25, C62): a third provider, defined only in
// tests/support/example-provider.ts, reaches the catalog, the snapshot and its installation guide
// through the same code the app runs — with no edit to src/ beyond the list of built-ins, which a
// test passes by hand here.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogProvider } from '@shared/contracts/catalog';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import type { ProviderContext } from '@shared/provider-kit/context';
import { resolveTrustedOrigins } from '../../src/main/app/origins';
import { dispatchInvoke } from '../../src/main/ipc/dispatch';
import { createKindCounts } from '../../src/main/ipc/handlers/counts';
import { installationGuides, shellHandlers } from '../../src/main/ipc/handlers/shell';
import { createPreferencesStore } from '../../src/main/prefs/store';
import { builtInProviders } from '../../src/main/providers';
import { createCatalogService } from '../../src/main/services/catalog-service';
import { createProviderRegistry } from '../../src/main/services/provider-registry';
import { createUsageService } from '../../src/main/services/usage-service';
import { createAppStateStore } from '../../src/main/state/app-state-store';
import { EXAMPLE_ENTRY, EXAMPLE_GUIDE, EXAMPLE_ID, EXAMPLE_INSTANCES, exampleDefinition, exampleDefinitionWithoutInstances } from '../support/example-provider';

const ROOT = path.resolve(import.meta.dirname, '../..');
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const definitions = [...builtInProviders('0.0.0'), exampleDefinition()];

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-example-provider-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a third provider, defined outside src/ (V19)', () => {
  it('has an entry in the catalog, after the built-ins, exactly as the Models section’s sample says', () => {
    const store = createAppStateStore();
    const catalog = createCatalogService({ definitions, store, dir, log: silent });
    expect(store.getSnapshot().catalog?.providers.map((entry) => entry.id)).toEqual(['claude', 'codex', EXAMPLE_ID]);
    expect(store.getSnapshot().catalog?.providers[2]).toEqual(EXAMPLE_ENTRY);
    catalog.stop();
  });

  it('appears in the snapshot through the registry, and launches nothing', async () => {
    const store = createAppStateStore();
    const prefs = createPreferencesStore({ dir, providerIds: definitions.map((definition) => definition.descriptor.id), log: silent });
    const catalog = createCatalogService({ definitions, store, dir, log: silent });
    const usage = createUsageService({ store, pollIntervalSec: () => 3600, onReadEnd: (id, end) => catalog.readEnded(id, end) });
    const spawn = vi.fn();
    const context: ProviderContext = {
      processes: { resolve: vi.fn(), run: vi.fn(), spawn, supervise: vi.fn(), open: vi.fn(), openProcess: vi.fn(), recheck: vi.fn(), dispose: () => Promise.resolve({ ok: true }) },
      logger: { record: vi.fn() },
      probeDirectory: dir,
    };
    // Only the example: the built-ins would look for installed CLIs.
    const registry = createProviderRegistry({ definitions: [exampleDefinition()], store, prefs, usage, catalog, createContext: () => context, knownDirectories: () => [] });
    registry.start();
    await vi.waitFor(() => expect(store.getSnapshot().providers.find((provider) => provider.id === EXAMPLE_ID)?.status.kind).toBe('not-installed'));
    expect(store.getSnapshot().providers.map((provider) => provider.displayName)).toEqual(['Example']);
    expect(spawn).not.toHaveBeenCalled();
    registry.stop();
    prefs.dispose();
  });

  it('declares how a second account runs, or does not: with no account added, both read the same (M14b, C5)', async () => {
    expect(exampleDefinition().instances).toEqual(EXAMPLE_INSTANCES);
    expect(exampleDefinitionWithoutInstances().instances).toBeUndefined();
    // A name of its own: nothing the built-ins declare.
    const builtIn = builtInProviders('0.0.0').flatMap((definition) => (definition.instances ? [definition.instances] : []));
    expect(builtIn.map((support) => support.variable)).not.toContain(EXAMPLE_INSTANCES.variable);

    const snapshots: { providers: readonly ProviderSnapshot[]; entries: readonly CatalogProvider[] | undefined }[] = [];
    for (const [index, definition] of [exampleDefinition(), exampleDefinitionWithoutInstances()].entries()) {
      const folder = path.join(dir, String(index));
      mkdirSync(folder);
      const store = createAppStateStore();
      const prefs = createPreferencesStore({ dir: folder, providerIds: [EXAMPLE_ID], log: silent });
      const catalog = createCatalogService({ definitions: [definition], store, dir: folder, log: silent });
      const usage = createUsageService({ store, pollIntervalSec: () => 3600, onReadEnd: (id, end) => catalog.readEnded(id, end) });
      const context: ProviderContext = {
        processes: { resolve: vi.fn(), run: vi.fn(), spawn: vi.fn(), supervise: vi.fn(), open: vi.fn(), openProcess: vi.fn(), recheck: vi.fn(), dispose: () => Promise.resolve({ ok: true }) },
        logger: { record: vi.fn() },
        probeDirectory: folder,
      };
      const registry = createProviderRegistry({ definitions: [definition], store, prefs, usage, catalog, createContext: () => context, knownDirectories: () => [] });
      registry.start();
      await vi.waitFor(() => expect(store.getSnapshot().providers[0]?.status.kind).toBe('not-installed'));
      const { providers, catalog: entries } = store.getSnapshot();
      snapshots.push({ providers, entries: entries?.providers });
      registry.stop();
      prefs.dispose();
      catalog.stop();
    }
    expect(snapshots[0]?.providers).toHaveLength(1);
    // The one difference: the declaring module's snapshot names its variable, which is what lets an
    // account be added, and the other's names none.
    expect(snapshots.map((snapshot) => snapshot.providers[0]?.instanceVariable)).toEqual([EXAMPLE_INSTANCES.variable, null]);
    const withoutVariable = (snapshot: (typeof snapshots)[number]) => ({ ...snapshot, providers: snapshot.providers.map((provider) => ({ ...provider, instanceVariable: null })) });
    expect(snapshots[0] && withoutVariable(snapshots[0])).toEqual(snapshots[1] && withoutVariable(snapshots[1]));
    expect(snapshots[0]?.providers[0]).toMatchObject({ instanceId: 'default', label: 'Default', startedWithout: [] });
  });

  it('opens its own installation guide, and a provider that is not registered opens nothing', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const handler = shellHandlers({ guides: installationGuides(definitions), openExternal, showDataFolder: () => Promise.resolve(''), createAvatarsFolder: () => Promise.resolve(), addresses: createKindCounts() })['shell:openLink'];
    const deps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: { warn: vi.fn(), error: vi.fn() }, detail: 'kinds' as const };
    const call = (providerId: string) => dispatchInvoke('shell:openLink', INVOKE_SPECS['shell:openLink'], handler, {
      windowKind: 'main', sender: { frameUrl: 'app://fatg/index.html', isTopFrame: true }, request: { providerId },
    }, deps);
    await expect(call(EXAMPLE_ID)).resolves.toEqual({ ok: true, value: null });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(EXAMPLE_GUIDE);
    await expect(call('gemini')).resolves.toEqual({ ok: false, error: 'bad-request' });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it('needs no fixed list of links: neither the old ids nor the old addresses are anywhere in src/', () => {
    const sources = (directory: string): string[] => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sources(relative);
      // What ships: tests name the old ids on purpose, to see them refused.
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
    });
    const offenders = sources('src').filter((file) => /PROVIDER_LINK_IDS|PROVIDER_LINKS|ProviderLinkId|documentationLinkId|claude-installation|codex-installation/.test(readFileSync(path.join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
