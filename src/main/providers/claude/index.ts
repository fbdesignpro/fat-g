// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ProcessFailure, type Executable, type Resolution } from '@shared/provider-kit/process';
import type { ProviderContext } from '@shared/provider-kit/context';
import { candidatesOf, newestCandidate } from '@shared/provider-kit/newest';
import type { AgentProvider, DetectionOptions, ProviderDefinition, ProviderErrorReason, ProviderEvent, UsageResult } from '@shared/provider-kit/provider';
import type { ChatTimings } from './chat-launch';
import { CLI_LIMITS, parseVersion, readAuthStatus } from './cli';
import catalogDefaults from './catalog-defaults.json';
import logo from './logo.png?inline';
import streamImage from './stream-glow.png?inline';
import { CLAUDE_DESCRIPTOR, CLAUDE_EXECUTABLE_NAMES, CLAUDE_INSTALL_HINTS, CLAUDE_INSTALLATION_GUIDE, CLAUDE_INSTANCES } from './descriptor';
import { CLAUDE_CHILD_ENVIRONMENT } from './environment';
import { createClaudeFacet } from './facet';
import { claudeModelLabel, claudeSmallModelVersion, mapClaudeModels } from './models';
import { checkSessionAccount, normalizeUsage } from './normalize';
import { runClaudeSession, type ClaudeSessionResult } from './session';

export interface ClaudeDefinitionOptions {
  /** Test/smoke launch prefix, e.g. `[fake-claude-cli.mjs, …]` when the executable is Node. */
  readonly argsPrefix?: readonly string[];
  readonly executableNames?: readonly string[];
  readonly installDirectoryHints?: ProviderDefinition['installDirectoryHints'];
  /** Explicit fixture timing; production composition leaves these undefined. */
  readonly minimumPollIntervalSec?: number;
  readonly startupTimeoutMs?: number;
  readonly usageTimeoutMs?: number;
  /** A chat session's deadlines (M16, C88, C89), for fixtures; production leaves them as they are. */
  readonly chatTimings?: Partial<ChatTimings>;
}

export function createClaudeDefinition(options: ClaudeDefinitionOptions = {}): ProviderDefinition {
  return {
    descriptor: describe(options),
    catalogDefaults,
    logo,
    streamImage,
    installationGuide: CLAUDE_INSTALLATION_GUIDE,
    executableNames: options.executableNames ?? CLAUDE_EXECUTABLE_NAMES,
    installDirectoryHints: options.installDirectoryHints ?? CLAUDE_INSTALL_HINTS,
    environment: CLAUDE_CHILD_ENVIRONMENT,
    instances: CLAUDE_INSTANCES,
    modelLabel: claudeModelLabel,
    smallModelVersion: claudeSmallModelVersion,
    factory: (context) => createClaudeProvider(context, options),
  };
}

type ProviderError = { readonly kind: 'error'; readonly reason: ProviderErrorReason };

export function createClaudeProvider(context: ProviderContext, options: ClaudeDefinitionOptions = {}): AgentProvider {
  const prefix = options.argsPrefix ?? [];
  const lifetime = new AbortController();
  let executable: Executable | undefined;
  // An unconfirmed child cleanup: this generation launches nothing more, and disposal says so.
  let latched = false;
  // Every launch — including the previous session's teardown — completes before the next begins,
  // so repeated refreshes or a rapid suspend/resume can never overlap two children.
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(event: ProviderEvent) => void>();
  // Chat sessions (M16, C10, C71): each on a process of its own, in this instance's scope, at the
  // executable detection found. They go around the queue and the latch below: a session runs beside
  // a usage read, and an end of one that cannot be confirmed holds that session alone.
  const facet = createClaudeFacet({
    context,
    executable: () => (lifetime.signal.aborted ? undefined : executable),
    argsPrefix: prefix,
    ...(options.chatTimings === undefined ? {} : { timings: options.chatTimings }),
  });

  function exclusive<T>(signal: AbortSignal, work: (signal: AbortSignal, executable: Executable) => Promise<T>): Promise<T | ProviderError> {
    const run = tail.then(async (): Promise<T | ProviderError> => {
      if (latched) return { kind: 'error', reason: 'cleanup-failed' };
      if (executable === undefined || lifetime.signal.aborted || signal.aborted) return { kind: 'error', reason: 'temporarily-unavailable' };
      const linked = link(signal, lifetime.signal);
      try { return await work(linked.signal, executable); } finally { linked.release(); }
    });
    tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Every session sends the models its `initialize` reply lists (M13, C27, C90): a usage session's,
   * whatever the account turned out to be, and a models-only session's. A failed session sends nothing.
   */
  function sendModels(session: ClaudeSessionResult): void {
    if (session.kind !== 'read' && session.kind !== 'account-only') return;
    const report = mapClaudeModels(session.models);
    if (report === null) return;
    for (const listener of listeners) {
      try { listener({ type: 'models', report }); } catch { /* isolate consumers from the session */ }
    }
  }

  function usageResult(session: ClaudeSessionResult): UsageResult {
    switch (session.kind) {
      case 'cleanup-failed':
        latched = true;
        return { kind: 'error', reason: 'cleanup-failed' };
      case 'failed':
        return { kind: 'error', reason: 'temporarily-unavailable' };
      case 'account-only': {
        const check = checkSessionAccount(session.account);
        return check.kind === 'not-applicable' ? { kind: 'not-applicable', reason: check.reason } : { kind: 'error', reason: 'unsupported-data' };
      }
      case 'read': {
        const usage = session.usage;
        if (usage.kind === 'missing') return { kind: 'not-applicable', reason: 'unsupported-cli-version' };
        if (usage.kind === 'failed') return { kind: 'error', reason: 'temporarily-unavailable' };
        const normalized = normalizeUsage(usage.value);
        if (normalized.kind === 'usage') return { kind: 'usage', usage: normalized.usage };
        return normalized.kind === 'usage-unavailable' ? { kind: 'not-applicable', reason: 'usage-unavailable' } : { kind: 'error', reason: 'unsupported-data' };
      }
    }
  }

  /** The session's options: the usage session's and the models-only session's are the same launch. */
  function sessionOptions(resolved: Executable) {
    return {
      processes: context.processes,
      executable: resolved,
      probeDirectory: context.probeDirectory,
      argsPrefix: prefix,
      ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options.usageTimeoutMs === undefined ? {} : { usageTimeoutMs: options.usageTimeoutMs }),
    };
  }

  return {
    descriptor: describe(options),
    async detect(detection: DetectionOptions, signal: AbortSignal) {
      if (lifetime.signal.aborted) return { kind: 'error', reason: 'launch-failed' };
      let resolution: Resolution;
      try {
        resolution = await context.processes.resolve({
          override: detection.override,
          names: options.executableNames ?? CLAUDE_EXECUTABLE_NAMES,
          knownDirs: detection.knownDirs,
          cwd: context.probeDirectory,
          every: true,
        });
      } catch {
        return { kind: 'error', reason: 'launch-failed' };
      }
      if (resolution.status === 'not-found') return { kind: 'not-installed', overrideInvalid: resolution.overrideInvalid };
      // Detection only identifies the install, the newest of those found: no authentication, no control session.
      const newest = await newestCandidate(candidatesOf(resolution), (found) => context.processes.run(found, [...prefix, '--version'], {
        cwd: context.probeDirectory, signal, timeoutMs: CLI_LIMITS.versionTimeoutMs, stdoutLimit: CLI_LIMITS.versionStdoutBytes,
      }), parseVersion, signal);
      if (newest.kind === 'error') return newest;
      executable = newest.candidate.executable;
      return { kind: 'found', installation: { source: newest.candidate.source, version: newest.version }, executable: newest.candidate.executable };
    },
    getAccount(signal) {
      return exclusive(signal, async (linked, resolved) => {
        const result = await readAuthStatus({ processes: context.processes, executable: resolved, cwd: context.probeDirectory, argsPrefix: prefix }, linked);
        if (result.kind === 'error' && result.reason === 'cleanup-failed') latched = true;
        return result;
      });
    },
    getUsage(signal) {
      return exclusive(signal, async (linked, resolved) => {
        const session = await runClaudeSession(sessionOptions(resolved), linked, (account) => checkSessionAccount(account).kind === 'eligible');
        sendModels(session);
        return usageResult(session);
      });
    },
    /**
     * The models alone (M13, C90), for an account whose usage read runs no session — signed out, an
     * API key, a cloud provider — or that has not reported for an hour. The same launch as a usage
     * session, sending `initialize` and nothing else: the guard declines every account, so no
     * `get_usage` follows. Never overlaps a usage session, and latches as one would.
     */
    async reportModels(signal) {
      await exclusive(signal, async (linked, resolved) => {
        const session = await runClaudeSession(sessionOptions(resolved), linked, () => false);
        if (session.kind === 'cleanup-failed') latched = true;
        sendModels(session);
        return null;
      });
    },
    subscribe(listener) {
      if (lifetime.signal.aborted) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessions: facet,
    async dispose() {
      lifetime.abort();
      listeners.clear();
      // Each session's process is ended, and says how: its end is its own, never this latch's.
      await facet.dispose();
      await tail;
      // Propagated so the registry keeps replacement, disable/re-enable and overrides blocked too.
      if (latched) throw new ProcessFailure('cleanup-failed');
    },
  };
}

function describe(options: ClaudeDefinitionOptions) {
  return options.minimumPollIntervalSec === undefined ? CLAUDE_DESCRIPTOR : { ...CLAUDE_DESCRIPTOR, minPollIntervalSec: options.minimumPollIntervalSec };
}

/** Aborts when either signal does; `release` detaches from both, so nothing outlives one read. */
function link(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', abort, { once: true });
  b.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, release: () => { a.removeEventListener('abort', abort); b.removeEventListener('abort', abort); } };
}
