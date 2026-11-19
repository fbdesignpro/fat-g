// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A connection that is opened once (docs/planning/_archive/M15.md, Design 4; C84, C116): a session's
// process. It is the supervisor's client around one child, with none of the supervisor: no restart,
// no backoff, no circuit. When the process ends the connection is over, and fat-g starts no turn
// again (C17).
//
// Its tree belongs to its scope, which spawned it and ends it when it is disposed. What differs is
// what an unconfirmed end closes: this connection alone (index.ts), not the scope.
import type { DiagnosticLogger } from '@shared/provider-kit/logger';
import type { CleanupResult, ManagedProcess } from '@shared/provider-kit/process';
import type { ConnectionTuning, OpenConnection } from '@shared/provider-kit/rpc';
import { createRpcClient, type RpcOptions } from './rpc-client';

export interface ConnectionDependencies {
  readonly child: ManagedProcess;
  readonly logger: DiagnosticLogger;
  /** The tree's read-only recheck: true once its recorded root has exited and its pipes have closed. */
  recheck(): boolean;
  readonly rpc?: RpcOptions;
}

export function createOpenConnection(tuning: ConnectionTuning, deps: ConnectionDependencies): OpenConnection {
  const { child } = deps;
  const rpc = createRpcClient(child, deps.logger, { ...deps.rpc, oversizedLines: tuning.oversizedLines, onDropped: tuning.onDropped, unhandled: tuning.unhandled, ...(tuning.lineBytes === undefined ? {} : { lineBytes: tuning.lineBytes }), ...(tuning.largeReplyBytes === undefined ? {} : { largeReplyBytes: tuning.largeReplyBytes }), ...(tuning.tracePolicy === undefined ? {} : { tracePolicy: tuning.tracePolicy }) });
  let confirmed = false;
  const settle = (result: CleanupResult): CleanupResult => { if (result.ok) confirmed = true; return result; };
  // The child's own stop is idempotent and shared: a natural end, a close, an abort and the scope's
  // disposal all resolve to the one cleanup of this tree.
  const done = rpc.done.then(() => child.stop()).then(settle);
  return {
    request: (method, params, options) => rpc.request(method, params, options),
    notify: (method, params) => rpc.notify(method, params),
    onNotification: (method, callback) => rpc.onNotification(method, callback),
    onRequest: (method, handler) => rpc.onRequest(method, handler),
    reply: (id, reply) => rpc.reply(id, reply),
    done,
    async close() {
      rpc.dispose();
      settle(await child.stop());
      return done;
    },
    recheck() {
      if (!confirmed && deps.recheck()) confirmed = true;
      return Promise.resolve({ ok: confirmed });
    },
  };
}
