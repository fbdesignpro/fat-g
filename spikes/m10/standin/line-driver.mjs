// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Drives the stand-in's line protocol through the same helpers a real driver uses: handshake under
// the startup wait, one request under the request wait, a "scenario" under the scenario wait, then
// the common teardown. Used only by the self-test.
import { Cancelled, DeadlineExpired } from '../lib/deadlines.mjs';
import { cleanEnvironment } from '../lib/env.mjs';
import { CliExited, WireSession } from '../lib/wire.mjs';

export async function runStandIn({ launcher, executable, args, cwd, waits, signal, onStarted }) {
  const session = new WireSession({ launcher, executable, args, cwd, env: cleanEnvironment('standin').env, waits, signal, typeOf: (f) => f?.op ?? '?' });
  const result = { outcome: null, expiredWait: null, error: null, cleanup: null, rootExitedBeforeTeardown: null };
  let turnActive = false;
  try {
    await session.start();
    if (session.ended) throw new CliExited(session.ended);
    onStarted?.(session);
    await session.send({ op: 'hello' });
    await session.waitFor((f) => f.op === 'hello-ok', { wait: 'startup' });
    await session.tree.tryRecord('after-handshake');
    await session.send({ op: 'ping', id: 1 });
    await session.waitFor((f) => f.op === 'pong' && f.id === 1, { wait: 'request' });
    await session.tree.tryRecord('before-prompt');
    turnActive = true;
    await session.send({ op: 'go' });
    await session.waitFor((f) => f.op === 'done', { wait: 'scenario' });
    turnActive = false;
    await session.tree.tryRecord('after-success');
    result.outcome = 'happened';
  } catch (error) {
    if (error instanceof DeadlineExpired) { result.outcome = 'timed-out'; result.expiredWait = error.wait; }
    else if (error instanceof Cancelled) result.outcome = 'cancelled';
    else if (error instanceof CliExited) result.outcome = 'cli-exited';
    else { result.outcome = 'error'; result.error = String(error?.stack ?? error); }
  }
  result.rootExitedBeforeTeardown = session.tree?.rootExited ?? null;
  result.cleanup = await session.teardown({ turnActive, interrupt: () => session.send({ op: 'stop' }).catch(() => {}) });
  result.session = session;
  return result;
}
