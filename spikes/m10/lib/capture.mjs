// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The capture format, fat-g.capture/1 (C9, C16, Design 3). One JSON file per run. The raw capture
// under spikes/output/m10/raw/ is unredacted; publish.mjs redacts it into tests/fixtures/.
import { outputPath, writeJson } from './paths.mjs';

export const CAPTURE_FORMAT = 'fat-g.capture/1';

export function buildCapture({ spike, cli, scenario, run, driver, sessionStart, toolPermissions, environment, waits, extra = {} }) {
  const session = driver.session;
  const tree = session.tree;
  return {
    _fixture: {
      source: `M10 spike ${spike}, run against the installed CLI on the maintainer's machine`,
      redacted: [],
      omitted: ['token-level deltas (counted only)', 'usage readings'],
      note: null,
    },
    format: CAPTURE_FORMAT,
    cli: { name: cli.name, version: cli.version, launchKind: cli.kind },
    date: new Date().toISOString(),
    scenario: scenario ? { id: scenario.id, title: scenario.title, successCondition: scenario.successCondition } : null,
    run,
    launch: { args: [...driver.args], cwd: driver.cwd },
    sessionStart,
    toolPermissions,
    environment: { removed: environment.removed, set: environment.set },
    deadlines: { ...waits },
    deltas: { ...session.recorder.deltas, ...(driver.optedOut ? { optedOut: driver.optedOut } : {}) },
    frames: session.frames,
    garbageLines: session.recorder.garbageLines.length,
    stderr: { bytes: tree?.stderrBytes ?? 0, tail: tree?.stderrTail ?? '' },
    requestsAnswered: driver.requestsSeen,
    treeRecordings: tree?.recordings ?? [],
    ...extra,
  };
}

/** Raw (unredacted) captures: spikes/output/m10/raw/<cli>/<name>.json, gitignored. */
export function saveRaw(cli, name, capture) {
  return writeJson(outputPath('raw', cli, `${name}.json`), capture);
}
