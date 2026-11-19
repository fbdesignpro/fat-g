// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which systems a CI run tests, builds and packages on: the tiers of .github/workflows/ci.yml.
// Lint and typecheck run once, on Linux, whatever this chooses: they read the same files on every
// system, and Linux's case-sensitive paths are the strictest.
//   - A push runs on Windows and Linux, unless its last commit's message names some: `[ci macos]`,
//     `[ci linux, windows]`. A push of documents alone never starts (the workflow's paths-ignore).
//   - A run started by hand (`gh workflow run ci.yml`, or Run workflow in the Actions tab) takes
//     its `systems` input: Windows and Linux by default, or a list as in a tag.
//   - Any other run, such as a pull request's, is on Windows and Linux.
// macOS runs only when a push's tag or a manual input explicitly names `macos` or `all`.
// A name it does not know is an error, so a misspelt tag fails the run instead of narrowing it.

/** Each system's name in a tag, and the runner it runs on. */
export const RUNNERS = Object.freeze({ windows: 'windows-latest', macos: 'macos-latest', linux: 'ubuntu-latest' });

const DEFAULT_RUNNERS = Object.freeze([RUNNERS.windows, RUNNERS.linux]);
const TAG = /\[ci ([^\]]*)\]/gi;

/**
 * The runners a run is on.
 * @param {{ event: string, message?: string, requested?: string }} run
 * @returns {string[]}
 */
export function chooseRunners({ event, message = '', requested = '' }) {
  if (event === 'workflow_dispatch') return requested.trim() === '' ? [...DEFAULT_RUNNERS] : named(requested, 'The systems input');
  if (event !== 'push') return [...DEFAULT_RUNNERS];
  const tags = [...message.matchAll(TAG)];
  if (tags.length === 0) return [...DEFAULT_RUNNERS];
  if (tags.length > 1) throw new Error(`The commit message has ${tags.length} [ci …] tags: name every system in one.`);
  return named(tags[0][1], `The tag ${tags[0][0]}`);
}

function named(list, where) {
  const names = list.toLowerCase().split(/[\s,]+/).filter((name) => name !== '');
  const known = `${Object.keys(RUNNERS).join(', ')} or all`;
  if (names.length === 0) throw new Error(`${where} names no system: use ${known}.`);
  const unknown = names.filter((name) => name !== 'all' && !Object.hasOwn(RUNNERS, name));
  if (unknown.length > 0) throw new Error(`${where} names ${unknown.map((name) => `"${name}"`).join(', ')}, not a system: use ${known}.`);
  if (names.includes('all')) return Object.values(RUNNERS);
  return Object.entries(RUNNERS).filter(([name]) => names.includes(name)).map(([, runner]) => runner);
}
