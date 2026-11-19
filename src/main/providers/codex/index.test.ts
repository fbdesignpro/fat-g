// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { ProcessFailure, type ProviderProcesses } from '@shared/provider-kit/process';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { SupervisedConnection } from '@shared/provider-kit/rpc';
import { createCodexDefinition, createCodexProvider } from './index';

function setup() {
  const supervisor: SupervisedConnection = {
    state: 'idle', generation: 0,
    connect: vi.fn(async () => supervisor), restart: vi.fn(async () => supervisor),
    reportUnhealthy: vi.fn(async () => undefined), markResponsive: vi.fn(),
    onState: vi.fn(() => () => undefined),
    request: vi.fn(async () => ({})), notify: vi.fn(async () => undefined),
    onNotification: vi.fn(() => () => undefined), dispose: vi.fn(async () => ({ ok: true })),
  };
  const processes: ProviderProcesses = {
    resolve: vi.fn(async () => ({ status: 'found', executable: { path: 'C:\\bin\\codex.exe', kind: 'native' }, source: 'path' } as const)),
    run: vi.fn(async () => ({ code: 0, signal: null, stdout: 'codex-cli 0.155.1\n' })),
    spawn: vi.fn(), supervise: vi.fn(() => supervisor), dispose: vi.fn(async () => ({ ok: true })),
    open: vi.fn(), openProcess: vi.fn(), recheck: vi.fn(async () => ({ ok: true })),
  };
  const context: ProviderContext = { processes, logger: { record: vi.fn() }, probeDirectory: 'C:\\probe' };
  return { context, processes, supervisor };
}

describe('Codex definition', () => {
  it('declares how a second account runs: the variable, the default folder, and what an added one does not inherit (M14b, C5, C9)', () => {
    const definition = createCodexDefinition({ applicationVersion: '1.2.3' });
    expect(definition.instances).toEqual({
      variable: 'CODEX_HOME',
      defaultFolder: ['.codex'],
      withhold: { names: ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_SQLITE_HOME'], prefixes: ['OPENAI_'] },
    });
    const withheld = (name: string): boolean =>
      definition.instances?.withhold.names.includes(name) === true || definition.instances?.withhold.prefixes.some((prefix) => name.startsWith(prefix)) === true;
    // Every credential and workload identity variable of Codex's environment variables page.
    for (const name of ['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT']) {
      expect(withheld(name), name).toBe(true);
    }
    // The variable itself is never withheld: an added account's scope sets it. Certificates pass.
    for (const name of ['CODEX_HOME', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'HTTPS_PROXY']) expect(withheld(name), name).toBe(false);
    // Codex declares no child policy of its own: the first account inherits as before.
    expect(definition.environment).toBeUndefined();
  });
});

describe('Codex detection', () => {
  it('uses the process resolver, bounded version probe, and sanitized semantic version', async () => {
    const h = setup();
    const provider = createCodexProvider(h.context, { applicationVersion: '1.2.3', argsPrefix: ['fixture.mjs'] });
    const signal = new AbortController().signal;

    await expect(provider.detect({ override: 'C:\\chosen\\codex.exe', knownDirs: ['C:\\known'] }, signal)).resolves.toEqual({
      kind: 'found', installation: { source: 'path', version: '0.155.1' }, executable: { path: 'C:\\bin\\codex.exe', kind: 'native' },
    });
    expect(h.processes.resolve).toHaveBeenCalledWith({
      override: 'C:\\chosen\\codex.exe', names: ['codex'], knownDirs: ['C:\\known'], cwd: 'C:\\probe', every: true,
    });
    expect(h.processes.run).toHaveBeenCalledWith(
      { path: 'C:\\bin\\codex.exe', kind: 'native' },
      ['fixture.mjs', '--version'],
      { cwd: 'C:\\probe', signal, timeoutMs: 5000, stdoutLimit: 16 * 1024 },
    );
    expect(h.processes.supervise).toHaveBeenCalledWith(expect.objectContaining({
      executable: { path: 'C:\\bin\\codex.exe', kind: 'native' }, args: ['fixture.mjs', 'app-server'],
    }));
    await provider.dispose();
  });

  // The Codex app's root copy stayed at 0.130 while its newest build was 0.167.
  it('runs the newest of the CLIs found, its app server included, whatever their order', async () => {
    const h = setup();
    const npm = { path: 'C:\\npm\\codex.cmd', kind: 'cmd-shim' } as const;
    const stale = { path: 'C:\\Local\\OpenAI\\Codex\\bin\\codex.exe', kind: 'native' } as const;
    const build = { path: 'C:\\Local\\OpenAI\\Codex\\bin\\5449c1f0f26f1f98\\codex.exe', kind: 'native' } as const;
    vi.mocked(h.processes.resolve).mockResolvedValue({ status: 'found', executable: npm, source: 'path', others: [{ executable: build, source: 'known-dir' }, { executable: stale, source: 'known-dir' }] });
    const versions = new Map<string, string>([[npm.path, 'codex-cli 0.164.0'], [stale.path, 'codex-cli 0.130.0-alpha.5'], [build.path, 'codex-cli 0.167.0-alpha.3.2']]);
    vi.mocked(h.processes.run).mockImplementation(async (file) => ({ code: 0, signal: null, stdout: `${versions.get(file.path)}\n` }));
    const provider = createCodexProvider(h.context, { applicationVersion: '1.2.3' });
    await expect(provider.detect({ override: null, knownDirs: [] }, new AbortController().signal)).resolves.toEqual({
      kind: 'found', installation: { source: 'known-dir', version: '0.167.0-alpha.3.2' }, executable: build,
    });
    expect(h.processes.supervise).toHaveBeenCalledWith(expect.objectContaining({ executable: build }));
    await provider.dispose();
  });

  it('refuses an invalid override without probing or falling back', async () => {
    const h = setup();
    vi.mocked(h.processes.resolve).mockResolvedValue({ status: 'not-found', reason: 'invalid-override', overrideInvalid: true });
    const provider = createCodexProvider(h.context, { applicationVersion: '1.2.3' });

    await expect(provider.detect({ override: 'C:\\missing.exe', knownDirs: ['C:\\working-fallback'] }, new AbortController().signal))
      .resolves.toEqual({ kind: 'not-installed', overrideInvalid: true });
    expect(h.processes.run).not.toHaveBeenCalled();
    expect(h.processes.supervise).not.toHaveBeenCalled();
    await provider.dispose();
  });

  it('does not forward unrecognized or oversized version output', async () => {
    const h = setup();
    vi.mocked(h.processes.run).mockResolvedValue({ code: 0, signal: null, stdout: `private-path ${'x'.repeat(600)} 9.9.9` });
    const provider = createCodexProvider(h.context, { applicationVersion: '1.2.3' });

    await expect(provider.detect({ override: null, knownDirs: [] }, new AbortController().signal)).resolves.toEqual({
      kind: 'found', installation: { source: 'path', version: null }, executable: { path: 'C:\\bin\\codex.exe', kind: 'native' },
    });
    await provider.dispose();
  });

  it('distinguishes resolver/launch failure from a bounded probe failure', async () => {
    const launch = setup();
    vi.mocked(launch.processes.resolve).mockRejectedValue(new ProcessFailure('spawn-failed'));
    await expect(createCodexProvider(launch.context, { applicationVersion: '1' })
      .detect({ override: null, knownDirs: [] }, new AbortController().signal))
      .resolves.toEqual({ kind: 'error', reason: 'launch-failed' });

    const probe = setup();
    vi.mocked(probe.processes.run).mockRejectedValue(new ProcessFailure('timeout'));
    await expect(createCodexProvider(probe.context, { applicationVersion: '1' })
      .detect({ override: null, knownDirs: [] }, new AbortController().signal))
      .resolves.toEqual({ kind: 'error', reason: 'probe-failed' });
  });
});
