// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';

/** Cross-file behavior that adjacent tests alone would miss. Test selectors are path prefixes. */
export const CHECK_AREAS = {
  'data-reset': {
    paths: ['src/main/app/data-reset', 'src/main/ipc/handlers/data-reset', 'src/shared/contracts/data-reset.ts', 'src/renderer/src/settings/ResetDataSection'],
    tests: ['src/main/app/data-reset.test.', 'src/main/app/quit-gate.test.', 'src/main/app/identity.test.', 'src/main/ipc/handlers/data-reset.test.', 'src/shared/ipc/contract.test.', 'src/renderer/src/settings/ResetDataSection.test.', 'src/renderer/src/settings/SettingsDialog.test.', 'src/renderer/src/settings/ProviderModels.test.', 'tests/architecture/smoke-gating.test.'],
    smoke: ['data-reset'],
  },
  'provider-discovery': {
    paths: ['src/main/services/provider-discovery', 'src/shared/contracts/provider-discovery.ts', 'src/renderer/src/provider-discovery/'],
    tests: ['src/main/services/provider-discovery', 'src/main/services/provider-registry', 'src/main/process/resolve-executable.test.', 'src/main/ipc/handlers/providers.test.', 'src/main/sessions/gate.test.', 'src/shared/contracts/availability.test.', 'src/shared/ipc/contract.test.', 'src/main/state/projection.test.', 'src/renderer/src/control-bar/UsageStrip.test.', 'src/renderer/src/provider-discovery/', 'src/renderer/src/first-run/', 'src/renderer/src/settings/SettingsDialog.test.'],
    smoke: [],
  },
  drafts: {
    paths: ['src/renderer/src/new-session/', 'src/renderer/src/chat/Composer.tsx', 'src/renderer/src/chat/composer/', 'src/renderer/src/sessions/unstarted.ts', 'src/renderer/src/sessions/cancel-new-session.ts', 'src/main/sessions/composer.ts', 'src/main/sessions/draft-preset.ts'],
    tests: ['src/renderer/src/new-session/', 'src/renderer/src/chat/Composer.test.', 'src/renderer/src/chat/composer/', 'src/renderer/src/sessions/unstarted.test.', 'src/renderer/src/sessions/SessionList.test.', 'src/main/sessions/composer.test.', 'src/main/sessions/draft-preset.test.', 'src/main/sessions/runtime-composer.test.', 'src/main/ipc/handlers/sessions.test.', 'src/shared/ipc/contract.test.'],
    smoke: ['new-chat'],
  },
  sessions: {
    paths: ['src/renderer/src/sessions/', 'src/shared/contracts/sessions.ts', 'src/main/ipc/handlers/sessions.ts'],
    tests: ['src/renderer/src/sessions/', 'src/main/ipc/handlers/sessions.test.', 'src/shared/contracts/sessions.test.'],
    smoke: ['new-chat'],
  },
  avatars: {
    paths: ['src/main/avatars/', 'assets/avatars/', 'src/shared/contracts/avatar', 'src/renderer/src/sessions/Avatar', 'src/renderer/src/settings/Avatar', 'src/renderer/src/settings/Family', 'src/renderer/src/settings/CreateFamily', 'src/renderer/src/settings/PreparedAvatar', 'src/renderer/src/settings/Style'],
    tests: ['src/main/avatars/', 'src/shared/contracts/avatar', 'src/renderer/src/sessions/Avatar.test.', 'src/renderer/src/settings/AvatarsSection.test.', 'tests/packaging/avatar-art.test.', 'src/main/ipc/handlers/avatars.test.'],
    smoke: ['avatar-family'],
  },
  files: {
    paths: ['src/main/files/', 'src/renderer/src/artifacts/', 'src/shared/contracts/files.ts'],
    tests: ['src/main/files/', 'src/renderer/src/artifacts/', 'src/main/ipc/handlers/files.test.', 'tests/architecture/files-reach.test.'],
    smoke: [],
  },
  search: {
    paths: ['src/main/sessions/search/', 'src/shared/contracts/session-search.ts', 'src/renderer/src/session-search/'],
    tests: ['src/main/sessions/search/', 'src/shared/contracts/session-search.test.', 'src/renderer/src/session-search/'],
    smoke: ['session-search'],
  },
  tooling: {
    paths: ['scripts/', 'do/do-check.bat', 'package.json', 'package-lock.json', 'vitest.config.ts', 'eslint', 'tsconfig', '.github/workflows/'],
    tests: ['scripts/', 'tests/ci/', 'tests/architecture/boundaries.test.', 'tests/architecture/runtime-dependencies.test.', 'tests/architecture/smoke-gating.test.'],
    smoke: [],
  },
  shell: {
    paths: ['src/main/index.ts', 'src/main/app/', 'src/main/windows/', 'src/preload/'],
    tests: ['src/main/app/', 'src/main/windows/', 'src/preload/', 'src/main/ipc/dispatch.test.', 'tests/architecture/smoke-gating.test.'],
    smoke: ['new-chat'],
  },
  permissions: {
    paths: ['src/shared/contracts/permissions.ts', 'src/renderer/src/session-area/ModeMenu', 'src/renderer/src/chat/ApprovalCard', 'src/main/sessions/runtime-permissions'],
    tests: ['src/shared/contracts/permissions.test.', 'src/renderer/src/session-area/ModeMenu.test.', 'src/renderer/src/chat/ApprovalCard.test.', 'src/main/sessions/runtime-permissions.test.', 'src/main/sessions/requests.test.'],
    smoke: [],
  },
  // The stored formats' baselines (decision 0014): a change to a format's module, its writer or a baseline runs the check that this build still reads every baseline.
  baselines: {
    paths: [
      'tests/baselines/', 'tests/fixtures/baselines/', 'do/do-record-baselines.bat', 'src/main/storage/envelope.ts', 'src/main/storage/json-file.ts', 'src/main/storage/provider-discovery-history.ts', 'src/main/app/data-reset.ts',
      'src/main/prefs/', 'src/shared/contracts/prefs.ts', 'src/main/records/', 'src/main/conversations/format.ts', 'src/main/conversations/open.ts', 'src/main/conversations/store.ts', 'src/main/conversations/composer-rows.ts',
      'src/main/plans/format.ts', 'src/main/plans/review-format.ts', 'src/main/catalog/override.ts', 'src/shared/contracts/catalog.ts', 'src/main/avatars/authoring.ts', 'src/main/avatars/manifest.ts', 'src/shared/contracts/avatars.ts',
    ],
    tests: ['tests/baselines/'],
    smoke: [],
  },
};

export const isTest = (file) => /\.test\.(?:[cm]?js|tsx?)$/.test(file);
const code = (file) => /\.(?:[cm]?js|tsx?|css)$/.test(file);
const lintable = (file) => /\.(?:[cm]?js|tsx?)$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.d.mts');

/** Normalize CLI/Git paths, rejecting paths outside the checkout and option-shaped paths. */
export function repoPath(value) {
  const file = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!file || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split('/').some((part) => part === '..') || file.startsWith('-')) throw new Error(`Expected a repository-relative path: ${value}`);
  return file;
}

/** Pure selection: no import-graph traversal, and no empty Vitest invocation that runs everything. */
export function checkPlan({ files, available, areas = [] }) {
  const changed = [...new Set(files.map(repoPath))].sort();
  const inventory = [...new Set(available.map(repoPath))].sort();
  const tests = inventory.filter(isTest);
  const selected = new Map();
  const notes = new Set();
  const smoke = new Set();
  const matched = new Set();
  const add = (selectors, why) => {
    for (const file of tests) if (selectors.some((selector) => file.startsWith(selector))) {
      if (!selected.has(file)) selected.set(file, new Set());
      selected.get(file).add(why);
    }
  };
  const area = (name) => {
    if (!Object.hasOwn(CHECK_AREAS, name)) throw new Error(`Unknown area: ${name}. Areas: ${Object.keys(CHECK_AREAS).join(', ')}`);
    if (matched.has(name)) return;
    matched.add(name);
    add(CHECK_AREAS[name].tests, `area: ${name}`);
    for (const scenario of CHECK_AREAS[name].smoke) smoke.add(scenario);
  };
  for (const name of areas) area(name);
  for (const file of changed) {
    if (isTest(file)) { if (inventory.includes(file)) add([file], `changed test: ${file}`); continue; }
    for (const [name, entry] of Object.entries(CHECK_AREAS)) if (entry.paths.some((prefix) => file.startsWith(prefix))) area(name);
    if (code(file)) {
      const directory = path.posix.dirname(file);
      const stem = path.posix.basename(file).replace(/\.(?:module\.css|css|tsx?|[cm]?js)$/, '');
      const adjacent = tests.filter((test) => path.posix.dirname(test) === directory && path.posix.basename(test).startsWith(`${stem}.`));
      if (adjacent.length > 0) add(adjacent, `beside: ${file}`);
      else if (directory !== '.') add(tests.filter((test) => path.posix.dirname(test) === directory), `module: ${directory}`);
      if (file.startsWith('src/renderer/')) add(['tests/architecture/page-source.test.'], 'renderer source rules');
      if (file.endsWith('.css')) add(['tests/architecture/styles.test.'], 'styles read directly from disk');
      if (file.startsWith('src/main/') || file.startsWith('src/shared/')) add(['tests/architecture/runtime-dependencies.test.'], 'runtime imports');
      if (file.includes('/smoke') || file.includes('/app/flavor')) add(['tests/architecture/smoke-gating.test.'], 'smoke release gate');
    }
    if (file.startsWith('src/shared/')) notes.add('Shared code changed: add affected consumer areas with --area; typecheck covers both layers.');
    const provider = /^src\/main\/providers\/([^/]+)\//.exec(file)?.[1];
    if (provider) add([`tests/${provider}/`, `tests/architecture/${provider}-confinement.test.`], `provider: ${provider}`);
    if (file.startsWith('src/main/process/')) add(['tests/process/'], 'process behavior');
    if (file.startsWith('src/main/conversations/')) add(['tests/conversations/'], 'store crash behavior');
    if (file.startsWith('tests/fixtures/')) notes.add('Fixture changed: explicitly include its consumers with --area or --files.');
  }
  const fullLint = changed.some((file) => /^(?:eslint[^/]*\.(?:js|mjs)|tsconfig[^/]*\.json)$/.test(file));
  return {
    files: changed,
    areas: [...matched].sort(),
    lint: fullLint ? ['.'] : changed.filter((file) => lintable(file) && inventory.includes(file)),
    typecheck: changed.some(code) || fullLint || matched.size > 0,
    tests: [...selected].map(([file, why]) => ({ file, why: [...why] })).sort((a, b) => a.file.localeCompare(b.file)),
    smoke: [...smoke].sort(),
    notes: [...notes],
  };
}
