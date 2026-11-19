// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Targeted local checks. Full pre-push checks remain `npm run check`.
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_AREAS, checkPlan, repoPath } from './lib/check-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function parseArgs(args) {
  const mode = ['focused', 'lint', 'test'].includes(args[0]) ? args.shift() : 'focused';
  const options = { mode, list: false, areas: [], files: [], since: null, explicit: false };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--list') options.list = true;
    else if (arg === '--areas') options.showAreas = true;
    else if (arg === '--area' || arg === '--since') {
      const value = args.shift();
      if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value`);
      if (arg === '--area') options.areas.push(value);
      else options.since = value;
    } else if (arg === '--files') {
      options.explicit = true;
      while (args.length && !args[0].startsWith('--')) options.files.push(repoPath(args.shift()));
      if (options.files.length === 0) throw new Error('--files needs repository-relative paths');
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.explicit && options.since !== null) throw new Error('--files and --since select different scopes; choose one');
  return options;
}

export function changedFiles(git, since = 'HEAD') {
  return [...new Set([
    ...git(['diff', '--name-only', '--no-renames', '-z', since, '--']).split('\0'),
    ...git(['diff', '--cached', '--name-only', '--no-renames', '-z', since, '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
}

function inventory(directory = '') {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return (entry.name.startsWith('.') && entry.name !== '.github') || ['node_modules', 'out', 'release', 'dist', 'coverage', 'spikes', 'raw_assets'].includes(entry.name) ? [] : inventory(file);
    return entry.isFile() ? [file] : [];
  });
}

function run(tool, args) {
  const result = spawnSync(process.execPath, [path.join(root, tool), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(tool)} failed (${result.status ?? result.signal})`);
}

export function main(args = process.argv.slice(2)) {
  if (args[0] === 'smoke') {
    if (args.length !== 2) throw new Error('Choose exactly one smoke scenario: new-chat, session-search, avatar-family or data-reset; or all of them');
    run('scripts/smoke-scenario.mjs', args.slice(1)); return;
  }
  if (args[0] === 'list') args = ['--list', ...args.slice(1)];
  if (args.includes('--help')) {
    console.log('do-check.bat [focused|list|lint|test] [--area NAME] [--files PATH ...] [--since REF]\ndo-check.bat full\ndo-check.bat smoke new-chat|session-search|avatar-family|data-reset|all\n--areas lists available areas. No arguments checks uncommitted changes.');
    return;
  }
  const options = parseArgs([...args]);
  if (options.showAreas) { console.log(Object.keys(CHECK_AREAS).join('\n')); return; }
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const files = options.explicit ? options.files : changedFiles(git, options.since ?? 'HEAD');
  const plan = checkPlan({ files, available: inventory(), areas: options.areas });
  console.log(`[check] ${plan.files.length} changed paths; areas: ${plan.areas.join(', ') || 'adjacent tests only'}`);
  console.log(`[check] lint: ${plan.lint.join(', ') || 'none'}; typecheck: ${plan.typecheck ? 'yes' : 'no'}; tests: ${plan.tests.length} files`);
  if (options.mode !== 'lint' && plan.tests.length === 0 && (plan.typecheck || files.some((file) => file.startsWith('tests/fixtures/')))) throw new Error('No tests selected for code or fixture changes. Add --area or --files with the relevant test paths; this will never fall back to the full suite.');
  for (const note of plan.notes) console.log(`[check] ${note}`);
  if (plan.smoke.length) console.log(`[check] Smoke, when the behavior needs Electron: do-check.bat smoke ${plan.smoke.join(' | ')} (separate, never started automatically)`);
  if (options.list) {
    for (const { file, why } of plan.tests) console.log(`  ${file} — ${why.join('; ')}`);
    return;
  }
  if (options.mode !== 'test' && plan.lint.length) run('node_modules/eslint/bin/eslint.js', ['--', ...plan.lint]);
  if (options.mode === 'focused' && plan.typecheck) run('node_modules/typescript/bin/tsc', ['-b']);
  if (options.mode !== 'lint') {
    const node = plan.tests.filter(({ file }) => /\.[cm]?js$/.test(file)).map(({ file }) => `./${file}`);
    const vitest = plan.tests.filter(({ file }) => !/\.[cm]?js$/.test(file)).map(({ file }) => `./${file}`);
    if (node.length) runNodeTests(node);
    if (vitest.length) run('node_modules/vitest/vitest.mjs', ['run', ...vitest]);
  }
}

function runNodeTests(files) {
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Tooling tests failed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`[check] ${error.message}`); process.exitCode = 1; }
}
