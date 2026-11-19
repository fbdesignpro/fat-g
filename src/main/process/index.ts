// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { LifecycleTrace } from '@shared/provider-kit/lifecycle-trace';
import { ProcessFailure, type EnvironmentConstraints, type Executable, type InstanceEnvironment, type ManagedProcess, type ProviderProcesses, type RunOptions, type VariableSet } from '@shared/provider-kit/process';
import type { SupervisedConnection } from '@shared/provider-kit/rpc';
import { createOpenConnection } from './connection';
import { createOpenedProcess } from './opened-process';
import { createDiagnostics } from './diagnostics';
import { constrainEnvironment, createEnvironment, instanceEnvironment, sanitizeEnv, withheldPresent } from './env';
import { createProcessRegistry } from './process-registry';
import { discoverExecutable, resolveExecutable } from './resolve-executable';
import { readInstallChildren } from './install-children';
import type { ResolveRequest } from '@shared/provider-kit/process';
import { collectRun, spawnManaged, type OwnedTree, type TreeOwnership } from './spawn';
import { createSupervisor } from './supervisor';
import { openTerminal as startTerminal, terminalLaunches } from './terminal';

export interface ProcessServicesOptions {
  readonly trace?: LifecycleTrace | undefined;
  /**
   * The variables no per-run override may set, in any scope (M14b, C8): each one a provider
   * declares as its configuration folder. Main gathers them from the definitions.
   */
  readonly protectedVariables?: readonly string[];
}

/** A name a child's environment can carry on every platform. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createProcessServices(userData: string, { protectedVariables = [], trace }: ProcessServicesOptions = {}) {
  if (!path.isAbsolute(userData)) throw new ProcessFailure('spawn-failed');
  const registry = createProcessRegistry();
  const diagnostics = createDiagnostics(undefined, undefined, trace);
  const probeDirectory = path.join(userData, 'probe-cwd');
  const inherited = sanitizeEnv(process.env, process.platform);
  let directory: Promise<void> | undefined;
  const prepareDirectory = () => directory ??= mkdir(probeDirectory, { recursive: true }).then(() => {}, () => { throw new ProcessFailure('spawn-failed'); });
  const environment = createEnvironment({
    env: inherited, platform: process.platform, homedir: os.homedir(),
    isDirectory: async (dir) => { try { return (await stat(dir)).isDirectory(); } catch { return false; } },
    async probe(shell, args, env) {
      await prepareDirectory();
      const options = { cwd: probeDirectory, timeoutMs: 2000, stdoutLimit: 65536 };
      const result = await collectRun(spawnManaged({ path: shell, kind: 'native' }, args, options, env, registry, diagnostics, protectedVariables), options);
      if (result.code !== 0) throw new ProcessFailure('spawn-failed');
      return result.stdout;
    },
  });
  /**
   * One generation's processes. `constraints` is the provider's reviewed environment policy.
   * `instance` makes the scope an added instance's (M14b, C8, C9): every child of it — the version
   * probe, an account read, a session, a connection — gets the declared variable set to the
   * instance's folder and none of the withheld variables. The first instance's scope passes none,
   * so its children inherit exactly what the provider's do.
   */
  function createContext(constraints?: EnvironmentConstraints, instance?: InstanceEnvironment): ProviderContext {
    registry.assertOpen();
    // Refused before anything could be launched with it: the folder is handed to a CLI as it is.
    if (instance !== undefined && (!VARIABLE_NAME.test(instance.variable) || !path.isAbsolute(instance.folder) || instance.folder.includes('\0'))) throw new ProcessFailure('spawn-failed');
    const trees = new Set<OwnedTree>();
    // Trees whose cleanup could not be confirmed. Any entry latches the scope closed to launches.
    const unconfirmed = new Set<OwnedTree>();
    // The same for an opened connection's tree (M15, C116) and an opened process's (M16, C71),
    // which latch nothing: their scope has many such trees, and the one overlap to prevent, a second
    // process for the same session, is that session's own to refuse. Both sets count when the scope
    // is disposed or rechecked.
    const held = new Set<OwnedTree>();
    const supervisors = new Set<SupervisedConnection>();
    let closed = false;
    let stopping: Promise<void> | undefined;
    const assertOpen = () => {
      registry.assertOpen();
      if (closed) throw new ProcessFailure('disposed');
      if (unconfirmed.size > 0) throw new ProcessFailure('cleanup-failed');
    };
    const ownership: TreeOwnership = {
      track: (tree) => { trees.add(tree); },
      settled(tree, result) {
        if (result.ok) { trees.delete(tree); unconfirmed.delete(tree); } else unconfirmed.add(tree);
      },
    };
    const scopedEnvironment = async () => {
      const constrained = constrainEnvironment(await environment(), constraints, process.platform);
      return instance === undefined ? constrained : instanceEnvironment(constrained, instance, process.platform);
    };
    /**
     * One child on the ownership a session's process has: an end that cannot be confirmed puts its
     * tree in `held`, never in `unconfirmed`. `recheck` is that tree's own look, and releases it.
     */
    const launchHeld = (executable: Executable, args: readonly string[], options: RunOptions, env: Record<string, string>): { readonly child: ManagedProcess; recheck(): boolean } => {
      let owned: OwnedTree | undefined;
      const child = spawnManaged(executable, args, options, env, registry, diagnostics, protectedVariables, {
        track: (tree) => { owned = tree; trees.add(tree); },
        settled(tree, result) { if (result.ok) { trees.delete(tree); held.delete(tree); } else held.add(tree); },
      });
      return {
        child,
        recheck() {
          if (owned === undefined || !owned.recheck()) return false;
          held.delete(owned); trees.delete(owned);
          return true;
        },
      };
    };
    const scope: ProviderProcesses = {
      async resolve(request) {
        assertOpen();
        const env = await scopedEnvironment(); assertOpen();
        return resolveExecutable(request, {
          env, platform: process.platform, readInstallChildren,
          async isExecutableFile(file) {
            if (!(await stat(file)).isFile()) return false;
            await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
            return true;
          },
        });
      },
      async spawn(executable, args, options) {
        assertOpen(); await prepareDirectory();
        const env = await scopedEnvironment(); assertOpen();
        return spawnManaged(executable, args, options, env, registry, diagnostics, protectedVariables, ownership);
      },
      async run(executable, args, options) { return collectRun(await scope.spawn(executable, args, options), options); },
      supervise(options) {
        assertOpen();
        const supervisor = createSupervisor(options, { logger: diagnostics, spawn: () => scope.spawn(options.executable, options.args, options.options) });
        supervisors.add(supervisor); return supervisor;
      },
      async open(options) {
        assertOpen(); await prepareDirectory();
        const env = await scopedEnvironment(); assertOpen();
        const launched = launchHeld(options.executable, options.args, options.options, env);
        return createOpenConnection(options, { child: launched.child, logger: diagnostics, recheck: () => launched.recheck() });
      },
      async openProcess(executable, args, options) {
        assertOpen(); await prepareDirectory();
        const env = await scopedEnvironment(); assertOpen();
        // The same ownership as `open`, with the child handed over raw: nothing here reads its output.
        return createOpenedProcess(launchHeld(executable, args, options, env));
      },
      recheck() {
        for (const set of [unconfirmed, held]) {
          for (const tree of [...set]) {
            if (tree.recheck()) { set.delete(tree); trees.delete(tree); }
          }
        }
        return Promise.resolve({ ok: unconfirmed.size === 0 && held.size === 0 });
      },
      async dispose() {
        closed = true;
        stopping ??= (async () => {
          await Promise.all([...supervisors].map((s) => s.dispose()));
          await Promise.all([...trees].map((tree) => tree.stop()));
          unhook();
        })();
        await stopping;
        // Recomputed on every call: a later successful recheck makes the same scope report clean.
        return { ok: unconfirmed.size === 0 && held.size === 0 };
      },
    };
    const unhook = registry.onStop(() => scope.dispose());
    return { processes: scope, logger: diagnostics, probeDirectory };
  }
  /**
   * The names in fat-g's own environment that an added instance of a provider does not inherit
   * (C64): the withheld names found in what its provider's children get. Names only, never a value.
   */
  const startedWithout = (constraints: EnvironmentConstraints | undefined, withhold: VariableSet): string[] =>
    withheldPresent(constrainEnvironment(inherited, constraints, process.platform), withhold, process.platform);
  /**
   * Opens the user's terminal with one command in it (M14b, C80; ./terminal.ts), in the environment
   * a provider's first account's children get: the repaired search path and the provider's policy,
   * so the command finds the CLI as fat-g does. The window is the user's: nothing is read from it, it
   * is not recorded, and it is not ended at quit. Answers whether a terminal was started.
   */
  async function openTerminal(constraints: EnvironmentConstraints | undefined, command: string, note: string): Promise<boolean> {
    try {
      registry.assertOpen();
      const env = constrainEnvironment(await environment(), constraints, process.platform);
      return await startTerminal(terminalLaunches(process.platform, command, note, env), { env, cwd: os.homedir() });
    } catch {
      return false;
    }
  }
  /** No provider instance or CLI is started. Environment preparation is cached for the run. */
  const discover = async (request: ResolveRequest) => discoverExecutable(request, {
    env: await environment(), platform: process.platform, readInstallChildren,
    async isExecutableFile(file) {
      if (!(await stat(file)).isFile()) return false;
      await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    },
  });
  return { createContext, discover, startedWithout, openTerminal, diagnostics, killAll: () => registry.killAll(), emergency: () => registry.emergency(), closeAdmission: registry.closeAdmission };
}
export type ProcessServices = ReturnType<typeof createProcessServices>;
