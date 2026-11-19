// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The first job of .github/workflows/ci.yml: chooses the systems the run tests, builds and packages
// on (scripts/lib/ci-systems.mjs, unit-tested) and hands them to the jobs after it as `runners`.
// Reads EVENT, MESSAGE and REQUESTED from its environment, never from its command line, where the
// shell would read a commit message. Run by hand, without GITHUB_OUTPUT, it only prints its choice.
import { appendFileSync } from 'node:fs';
import { chooseRunners } from './lib/ci-systems.mjs';

const { EVENT = '', MESSAGE = '', REQUESTED = '', GITHUB_OUTPUT } = process.env;
try {
  const runners = chooseRunners({ event: EVENT, message: MESSAGE, requested: REQUESTED });
  if (GITHUB_OUTPUT !== undefined) appendFileSync(GITHUB_OUTPUT, `runners=${JSON.stringify(runners)}\n`);
  console.log(`::notice title=Systems::Tests, build and packaging on ${runners.join(', ')}`);
} catch (error) {
  console.log(`::error title=Systems::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
