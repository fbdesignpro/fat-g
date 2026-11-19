// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ProcessFailure, type Executable, type Resolution } from '@shared/provider-kit/process';
import type { AgentProvider, DetectionOptions, ProviderDefinition } from '@shared/provider-kit/provider';
import type { ProviderContext } from '@shared/provider-kit/context';
import { candidatesOf, newestCandidate } from '@shared/provider-kit/newest';
import type { SupervisorPolicy } from '@shared/provider-kit/rpc';
import { createCodexAppServer, type CodexAppServer } from './app-server';
import catalogDefaults from './catalog-defaults.json';
// The usage box's logo: the mark and the word in white on the bar colour. It was recoloured from the
// teal fat-g shipped before, per channel, by v' = n + (v - o) / (255 - o) * (255 - n), from the old
// field o to the new n — which keeps the white and every antialiased edge between the two. That inverse
// exists only because no channel of the old field was 255; Claude's #ff9933 has R = 255, so the same
// recipe cannot recolour its logo, and a new one would have to be drawn.
import logo from './logo.png?inline';
import streamImage from './stream-glow.png?inline';
import { CODEX_DESCRIPTOR, CODEX_EXECUTABLE_NAMES, CODEX_INSTALL_HINTS, CODEX_INSTALLATION_GUIDE, CODEX_INSTANCES } from './descriptor';
import { createCodexFacet } from './facet';
import { codexModelLabel, codexSmallModelVersion } from './models';
import type { SandboxTimings } from './sandbox';
import type { SessionTimings } from './session-process';

const VERSION = /(?:^|\s)(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/i;

export interface CodexDefinitionOptions {
  readonly applicationVersion: string;
  /** Test/smoke launch prefix, e.g. `[fake-cli.mjs]` when the executable is Node. */
  readonly argsPrefix?: readonly string[];
  readonly executableNames?: readonly string[];
  readonly installDirectoryHints?: ProviderDefinition['installDirectoryHints'];
  /** Explicit fixture timing overrides; production composition leaves these undefined. */
  readonly minimumPollIntervalSec?: number;
  readonly requestTimeoutMs?: number;
  readonly emptyRetryMs?: number;
  readonly supervisorPolicy?: SupervisorPolicy;
  /** A session's deadlines (M15, C15), for fixtures; production leaves them as they are. */
  readonly sessionTimings?: Partial<SessionTimings>;
  /** The system Codex's sandbox setup is offered for (M22, C62), and its connection's deadlines, for fixtures; production leaves both out, and the system is this process's own. */
  readonly platform?: NodeJS.Platform;
  readonly sandboxTimings?: Partial<SandboxTimings>;
}

export function createCodexDefinition(options: CodexDefinitionOptions): ProviderDefinition {
  const descriptor = options.minimumPollIntervalSec === undefined
    ? CODEX_DESCRIPTOR
    : { ...CODEX_DESCRIPTOR, minPollIntervalSec: options.minimumPollIntervalSec };
  return {
    descriptor,
    catalogDefaults,
    logo,
    streamImage,
    installationGuide: CODEX_INSTALLATION_GUIDE,
    executableNames: options.executableNames ?? CODEX_EXECUTABLE_NAMES,
    installDirectoryHints: options.installDirectoryHints ?? CODEX_INSTALL_HINTS,
    instances: CODEX_INSTANCES,
    modelLabel: codexModelLabel,
    smallModelVersion: codexSmallModelVersion,
    factory: (context) => createCodexProvider(context, options),
  };
}

export function createCodexProvider(context: ProviderContext, options: CodexDefinitionOptions): AgentProvider {
  const descriptor = options.minimumPollIntervalSec === undefined
    ? CODEX_DESCRIPTOR
    : { ...CODEX_DESCRIPTOR, minPollIntervalSec: options.minimumPollIntervalSec };
  let executable: Executable | undefined;
  let server: CodexAppServer | undefined;
  let disposed = false;
  const listeners = new Set<Parameters<NonNullable<AgentProvider['subscribe']>>[0]>();
  let detach: (() => void) | undefined;
  // Sessions (M15, C7, C12): each on a process of its own, in this instance's scope. The existing
  // connection runs no thread; it reads a session's earlier messages (C57).
  const facet = createCodexFacet({
    context,
    executable: () => (disposed ? undefined : executable),
    argsPrefix: options.argsPrefix ?? [],
    applicationVersion: options.applicationVersion,
    ...(options.sessionTimings === undefined ? {} : { timings: options.sessionTimings }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.sandboxTimings === undefined ? {} : { sandboxTimings: options.sandboxTimings }),
    readHistory: (reference, page, signal) => (disposed ? undefined : server?.readHistory(reference, page, signal)),
    listSkills: (folder, signal) => (disposed ? undefined : server?.listSkills(folder, signal)),
  });

  return {
    descriptor,
    async detect(detection: DetectionOptions, signal: AbortSignal) {
      if (disposed) return { kind: 'error', reason: 'launch-failed' };
      let resolution: Resolution;
      try {
        resolution = await context.processes.resolve({
          override: detection.override,
          names: options.executableNames ?? CODEX_EXECUTABLE_NAMES,
          knownDirs: detection.knownDirs,
          cwd: context.probeDirectory,
          every: true,
        });
      } catch {
        return { kind: 'error', reason: 'launch-failed' };
      }
      if (resolution.status === 'not-found') return { kind: 'not-installed', overrideInvalid: resolution.overrideInvalid };
      // The newest of the CLIs found: the Codex app leaves an older copy where the resolver looks first.
      const newest = await newestCandidate(candidatesOf(resolution), (found) => context.processes.run(
        found,
        [...(options.argsPrefix ?? []), '--version'],
        { cwd: context.probeDirectory, signal, timeoutMs: 5000, stdoutLimit: 16 * 1024 },
      ), (stdout) => (stdout.length <= 512 ? VERSION.exec(stdout)?.[1] ?? null : null), signal);
      if (newest.kind === 'error') return newest;
      try {
        executable = newest.candidate.executable;
        const token = newest.version;
        server = createCodexAppServer(context, executable, options.applicationVersion, {
          argsPrefix: options.argsPrefix,
          requestTimeoutMs: options.requestTimeoutMs,
          emptyRetryMs: options.emptyRetryMs,
          supervisorPolicy: options.supervisorPolicy,
        });
        detach = server.subscribe((event) => {
          for (const listener of listeners) listener(event);
          // The connection that reads history became ready (C121): and a read of the sandbox's readiness that failed may be made again (M22, C73).
          if (event.type === 'connection' && event.state === 'ready') facet.historyAvailable();
        });
        return { kind: 'found', installation: { source: newest.candidate.source, version: token }, executable };
      } catch (error) {
        return {
          kind: 'error',
          reason: error instanceof ProcessFailure && (error.code === 'spawn-failed' || error.code === 'disposed')
            ? 'launch-failed'
            : 'probe-failed',
        };
      }
    },
    getAccount: (signal) => server?.getAccount(signal) ?? Promise.resolve({ kind: 'error', reason: 'temporarily-unavailable' }),
    getUsage: (signal) => server?.getUsage(signal) ?? Promise.resolve({ kind: 'error', reason: 'temporarily-unavailable' }),
    // Codex's connection can stay up for days, so the catalog asks again now and then (M13, C69).
    reportModels: (signal) => (signal.aborted || disposed ? Promise.resolve() : server?.reportModels() ?? Promise.resolve()),
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessions: facet,
    async dispose() {
      if (disposed) return;
      disposed = true;
      detach?.();
      listeners.clear();
      await facet.dispose();
      await server?.dispose();
    },
  };
}
