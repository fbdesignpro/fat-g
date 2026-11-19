// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The frame every launching script runs in: the launch-record check first, one launcher, one
// cancellation path (Ctrl+C and the invocation budget), and one mapping from failures to exit codes.
import { Cancelled, DeadlineExpired, EXIT, deadlines } from './deadlines.mjs';
import { createCancellation } from './cancel.mjs';
import { ExecutableMissing } from './executable.mjs';
import { LaunchRecord, RecordedProcessRunning, checkLaunchRecord, describe, LAUNCH_RECORD } from './launch-record.mjs';
import { LaunchRefused, Launcher } from './launcher.mjs';
import { RunCapReached } from './ledger.mjs';
import { parseArgs } from './paths.mjs';
import { ListingFailed } from './proctree.mjs';

export const log = (...parts) => console.log(...parts);
export const warn = (...parts) => console.error(...parts);

/**
 * `main({ args, launcher, signal, waits })` returns an exit code. Everything it launched must be
 * torn down before it returns; the frame checks that the last tree was confirmed gone.
 */
export async function runSpike(name, main, { budgetMs } = {}) {
  const args = parseArgs();
  const recordFile = typeof args['record-file'] === 'string' ? args['record-file'] : LAUNCH_RECORD;
  const cancellation = createCancellation({ budgetMs: budgetMs ?? undefined, onSignalAgain: () => warn('still cleaning up; the shutdown wait bounds it') });
  const launcher = new Launcher({ spike: name, record: new LaunchRecord(name, recordFile), waits: deadlines() });
  let code = EXIT.error;
  try {
    const check = await checkLaunchRecord({ file: recordFile });
    if (check.status === 'stale-cleared') log(`launch record: a stale record${check.spike ? ` from ${check.spike}` : ''} was cleared; nothing it named is running`);
    code = await main({ args, launcher, signal: cancellation.signal, waits: launcher.waits });
    if (cancellation.signal.aborted) code = EXIT.cancelled;
  } catch (error) {
    code = exitFor(error, cancellation.signal);
    warn(`${name}: ${messageFor(error)}`);
  } finally {
    cancellation.dispose();
  }
  const last = launcher.previous;
  if (last && !last.cleanup?.confirmed) {
    warn(`${name}: cleanup NOT confirmed. Still recorded: ${(last.cleanup?.remaining ?? []).map(describe).join(', ') || 'unknown'}. The launch record is kept.`);
    if (code !== EXIT.recordedRunning) code = EXIT.cleanupUnconfirmed;
  }
  process.exitCode = code;
  return code;
}

export function exitFor(error, signal) {
  if (Number.isInteger(error?.exitCode)) return error.exitCode;
  if (error instanceof ExecutableMissing) return EXIT.cliMissing;
  if (error instanceof RecordedProcessRunning) return EXIT.recordedRunning;
  if (error instanceof ListingFailed || error instanceof LaunchRefused) return EXIT.cleanupUnconfirmed;
  if (error instanceof RunCapReached) return EXIT.runCap;
  if (error instanceof Cancelled || signal?.aborted) return EXIT.cancelled;
  if (error instanceof DeadlineExpired) return EXIT.timedOut;
  return EXIT.error;
}

function messageFor(error) {
  if (error instanceof RecordedProcessRunning) return `${error.message}. Nothing was ended; check it yourself, then run again.`;
  return error?.message ?? String(error);
}

/** Tears a driver down and reports the cleanup in one line. Never throws. */
export async function closeDriver(driver, label) {
  if (!driver) return null;
  const cleanup = await driver.close();
  log(`${label}: cleanup ${cleanup.confirmed ? 'confirmed' : 'NOT confirmed'} (${cleanup.graceful ? 'exited by itself' : 'forced'}, ${cleanup.ms} ms)`);
  return cleanup;
}
