// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A process opened once (docs/planning/_archive/M16.md, Design 2; C16, C71): a session's process that speaks
// no JSON-RPC. It is an opened connection (./connection.ts) without the client: the child is handed
// over raw, to the one consumer that reads it, and nothing here reads a byte of its output. There
// is no restart, no backoff and no circuit: when the process ends, what ran on it is over.
//
// Its tree belongs to its scope, which spawned it and ends it when it is disposed. What an
// unconfirmed end closes is this process alone (index.ts), not the scope.
//
// No total limit on its output: the layer bounds a child's output only until a consumer attaches,
// and the owner attaches as it opens the process. A line's limit is the reader's own.
import type { CleanupResult, ManagedProcess, OpenedProcess } from '@shared/provider-kit/process';

export interface OpenedProcessDependencies {
  readonly child: ManagedProcess;
  /** The tree's read-only recheck: true once its recorded root has exited and its pipes have closed. */
  recheck(): boolean;
  /** How long a root that has exited is given for its pipes to close by themselves. */
  readonly drainMs?: number;
}

export function createOpenedProcess(deps: OpenedProcessDependencies): OpenedProcess {
  const { child } = deps;
  let confirmed = false;
  const settle = (result: CleanupResult): CleanupResult => { if (result.ok) confirmed = true; return result; };
  // The process has ended once its pipes have closed; or, where a descendant holds them open, a
  // moment after its root exited. Nothing is read here, so the end is told from the child's own
  // promises, which settle whoever consumes its output.
  let drain: ReturnType<typeof setTimeout> | undefined;
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
    void child.closed.then(() => resolve(), () => resolve());
    void child.exited.then(() => { drain = setTimeout(resolve, deps.drainMs ?? 1000); }, () => resolve());
  });
  // The child's own stop is idempotent and shared: a natural end, a close and the scope's disposal
  // all resolve to the one cleanup of this tree.
  const done = ended.then(() => { clearTimeout(drain); return child.stop(); }).then(settle);
  return {
    process: child,
    done,
    async close() {
      // Closed is ended, whatever became of the tree: a cleanup that could not be confirmed leaves
      // the process running, and `done` says so rather than wait for an end that may never come.
      end();
      settle(await child.stop());
      return done;
    },
    recheck() {
      if (!confirmed && deps.recheck()) confirmed = true;
      return Promise.resolve({ ok: confirmed });
    },
  };
}
