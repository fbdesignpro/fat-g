// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlan, repoPath } from './lib/check-plan.mjs';
import { changedFiles, parseArgs } from './check.mjs';
import { chosenScenarios, scenarioEnvironment, SCENARIOS } from './smoke-scenario.mjs';

const available = ['src/renderer/src/sessions/SessionList.test.tsx', 'src/renderer/src/sessions/Capsule.tsx', 'src/renderer/src/sessions/Sessions.module.css', 'tests/architecture/styles.test.ts', 'tests/architecture/page-source.test.ts', 'src/main/ipc/handlers/sessions.test.ts', 'src/shared/ipc/contract.test.ts', 'src/main/audio/store.test.ts', 'scripts/check.test.mjs', 'src/renderer/src/settings/AvatarsSection.test.tsx', 'src/main/ipc/handlers/avatars.test.ts'];
const plan = (files, areas = []) => checkPlan({ files, available, areas });

test('a capsule edit selects its area without unrelated audio or process tests', () => {
  const result = plan(['src/renderer/src/sessions/Capsule.tsx']);
  assert.deepEqual(result.lint, ['src/renderer/src/sessions/Capsule.tsx']);
  assert.ok(result.tests.some(({ file }) => file.endsWith('SessionList.test.tsx')));
  assert.ok(result.tests.every(({ file }) => !file.includes('/audio/') && !file.includes('tests/process/')));
});
test('CSS brings direct stylesheet readers, while documents do not start checks', () => {
  assert.ok(plan(['src/renderer/src/sessions/Sessions.module.css']).tests.some(({ file }) => file.endsWith('styles.test.ts')));
  const docs = plan(['docs/testing.md', 'AGENTS.md']);
  assert.deepEqual([docs.lint, docs.tests, docs.typecheck], [[], [], false]);
});
test('deleted source still selects its tests, without being passed to ESLint', () => {
  const result = plan(['src/renderer/src/sessions/Removed.tsx']);
  assert.equal(result.lint.length, 0);
  assert.ok(result.tests.some(({ file }) => file.endsWith('SessionList.test.tsx')));
});
test('explicit consumer areas supplement shared contracts, and unknown areas fail', () => {
  assert.ok(plan(['src/shared/ipc/contract.ts'], ['drafts']).tests.some(({ file }) => file.endsWith('SessionList.test.tsx')));
  assert.throws(() => plan([], ['typo']), /Unknown area/);
  assert.throws(() => plan([], ['__proto__']), /Unknown area/);
});
test('Git selection includes staged, unstaged, deleted, renamed and untracked names without shell parsing', () => {
  const calls = [];
  const files = changedFiles((args) => { calls.push(args); return args[0] === 'diff' ? 'old name.ts\0new name.ts\0deleted.ts\0' : 'untracked.ts\0'; }, 'main');
  assert.deepEqual(files, ['old name.ts', 'new name.ts', 'deleted.ts', 'untracked.ts']);
  assert.ok(calls[0].includes('--no-renames'));
  assert.ok(calls[0].includes('main'));
  assert.ok(calls.some((args) => args.includes('--cached')));
});
test('CLI requires explicit values, accepts Windows paths, and rejects escaping paths', () => {
  assert.deepEqual(parseArgs(['test', '--list', '--files', 'src\\file.ts']).files, ['src/file.ts']);
  for (const args of [['--area'], ['--since'], ['--files'], ['--wat'], ['--since', 'HEAD', '--files', 'x.ts']]) assert.throws(() => parseArgs(args));
  for (const file of ['../secret', 'C:\\secret', '/secret', '--run']) assert.throws(() => repoPath(file));
});
test('an explicit test file stays narrow unless an area is also requested', () => {
  assert.deepEqual(plan(['src/renderer/src/sessions/SessionList.test.tsx']).tests.map(({ file }) => file), ['src/renderer/src/sessions/SessionList.test.tsx']);
});
test('scoped smoke refuses unknown scenarios and strips inherited replay controls', () => {
  assert.throws(() => scenarioEnvironment('typo', '/tmp/fixture'), /Choose a smoke scenario/);
  const env = scenarioEnvironment('new-chat', '/tmp/fixture', { FATG_SMOKE_LIVE: '1', FATG_SMOKE_FIXTURE: '/wrong', ELECTRON_RUN_AS_NODE: '1', FATG_DEMO_SESSIONS: 'stream' });
  assert.equal(env.FATG_SMOKE_LIVE, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.FATG_SMOKE_SCENARIO, 'new-chat');
  assert.equal(env.FATG_DEMO_SESSIONS, 'seed');
  assert.ok(env.FATG_SMOKE_FIXTURE.endsWith('fake-app-server.mjs'));
});
test('scoped smoke runs one named scenario, or every one for all', () => {
  assert.deepEqual(chosenScenarios(['data-reset']), ['data-reset']);
  assert.deepEqual(chosenScenarios(['all']), SCENARIOS);
  for (const args of [[], ['typo'], ['new-chat', 'all']]) assert.throws(() => chosenScenarios(args), /Choose exactly one smoke scenario, or all/);
});
test('tooling and lint configuration changes select tooling tests and widen lint only', () => {
  const result = plan(['eslint.config.js']);
  assert.deepEqual(result.lint, ['.']);
  assert.ok(result.tests.some(({ file }) => file === 'scripts/check.test.mjs'));
  assert.ok(!result.tests.some(({ file }) => file.includes('/audio/')));
});


test('family creation selects avatar consumers and its Electron scenario', () => {
  const result = plan(['src/renderer/src/settings/CreateFamilyFromImage.tsx']);
  assert.ok(result.areas.includes('avatars'));
  assert.ok(result.smoke.includes('avatar-family'));
  assert.ok(result.tests.some(({ file }) => file.endsWith('AvatarsSection.test.tsx')));
  assert.ok(result.tests.some(({ file }) => file.endsWith('handlers/avatars.test.ts')));
  const env = scenarioEnvironment('avatar-family', '/tmp/fixture', { FATG_SMOKE_VISUAL_DIR: '/tmp/pictures' });
  assert.equal(env.FATG_SMOKE_SCENARIO, 'avatar-family');
  assert.equal(env.FATG_SMOKE_VISUAL_DIR, '/tmp/pictures');
});

test('full reset selects its safety tests and the isolated two-launch scenario', () => {
  const result = checkPlan({ files: ['src/main/app/data-reset.ts'], available: ['src/main/app/data-reset.test.ts', 'src/main/app/quit-gate.test.ts', 'src/renderer/src/settings/ResetDataSection.test.tsx', 'src/shared/ipc/contract.test.ts'] });
  assert.ok(result.areas.includes('data-reset'));
  assert.ok(result.smoke.includes('data-reset'));
  assert.equal(result.tests.length, 4);
  const env = scenarioEnvironment('data-reset', '/tmp/fixture', { FATG_SMOKE_RESET_STAGE: 'next' });
  assert.equal(env.FATG_SMOKE_RESET_STAGE, undefined);
  assert.equal(env.FATG_SMOKE_SCENARIO, 'data-reset');
  assert.equal(env.FATG_DEMO_SESSIONS, 'off');
});
