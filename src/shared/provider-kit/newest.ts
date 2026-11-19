// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which of the CLIs a resolution found is used (decision 0003): the newest version. A
// desktop app can leave an older copy where the resolver looks first — the Codex app's root
// `codex.exe` stayed at 0.130 while its newest build was 0.167 — so the order of places says
// nothing of which is newer. Each candidate's own version check decides, at detection alone;
// discovery stays metadata-only (decision 0037).
import { type Executable, ProcessFailure, type Resolution } from './process';

export interface Candidate {
  readonly executable: Executable;
  readonly source: 'override' | 'path' | 'known-dir';
}

/** Every CLI a found resolution names, in the resolver's order. */
export function candidatesOf(resolution: Extract<Resolution, { status: 'found' }>): Candidate[] {
  return [{ executable: resolution.executable, source: resolution.source }, ...(resolution.others ?? [])];
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Digit strings of any length, by value. */
function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

/**
 * Semantic version precedence: `0.167.0-alpha.3.2` is above `0.165.0`, which is above `0.130.0-alpha.5`;
 * a release is above its own prereleases. A version that is not one sorts below every one that is.
 */
export function compareCliVersions(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (left === null || right === null) return left !== null ? 1 : right !== null ? -1 : 0;
  for (let part = 1; part <= 3; part += 1) {
    const difference = compareDigits(left[part]!, right[part]!);
    if (difference !== 0) return difference;
  }
  const [preLeft, preRight] = [left[4], right[4]];
  if (preLeft === undefined || preRight === undefined) return preLeft === preRight ? 0 : preLeft === undefined ? 1 : -1;
  const [idsLeft, idsRight] = [preLeft.split('.'), preRight.split('.')];
  for (let index = 0; index < Math.max(idsLeft.length, idsRight.length); index += 1) {
    const [x, y] = [idsLeft[index], idsRight[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [numericX, numericY] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    const difference = numericX && numericY ? compareDigits(x, y) : numericX ? -1 : numericY ? 1 : x < y ? -1 : x > y ? 1 : 0;
    if (difference !== 0) return difference;
  }
  return 0;
}

export type NewestCandidate =
  | { readonly kind: 'found'; readonly candidate: Candidate; readonly version: string | null }
  | { readonly kind: 'error'; readonly reason: 'launch-failed' | 'probe-failed' };

/**
 * Runs each candidate's version check in turn and keeps the newest: a check that fails passes over
 * its candidate, a version that cannot be read sorts below every one that can, and of two equal the
 * earlier is kept. With none that answers, the first failure is the result.
 */
export async function newestCandidate(
  candidates: readonly Candidate[],
  check: (executable: Executable) => Promise<{ readonly code: number | null; readonly stdout: string }>,
  parse: (stdout: string) => string | null,
  signal: AbortSignal,
): Promise<NewestCandidate> {
  let best: { candidate: Candidate; version: string | null } | undefined;
  let failure: 'launch-failed' | 'probe-failed' | undefined;
  for (const candidate of candidates) {
    if (signal.aborted) break;
    try {
      const result = await check(candidate.executable);
      if (result.code !== 0) { failure ??= 'probe-failed'; continue; }
      const version = parse(result.stdout);
      const newer = best === undefined || (version !== null && (best.version === null || compareCliVersions(version, best.version) > 0));
      if (newer) best = { candidate, version };
    } catch (error) {
      failure ??= error instanceof ProcessFailure && (error.code === 'spawn-failed' || error.code === 'disposed') ? 'launch-failed' : 'probe-failed';
    }
  }
  return best !== undefined ? { kind: 'found', ...best } : { kind: 'error', reason: failure ?? 'probe-failed' };
}
