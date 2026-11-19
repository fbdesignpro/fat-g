// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1 (docs/planning/_archive/M18-spec-sheet.md): which SQLite driver loads, commits and reopens — in plain
// Node, under the test runner, in the development build's main process and in a packaged one?
//
//   node spikes/m18/k1.mjs            every leg
//   node spikes/m18/k1.mjs --no-package   all but the packaged leg
//
// One driver is run: `node:sqlite`, the module of Node itself and of Electron's Node. It launches
// no CLI, reads no account and makes no network call. The packaged leg builds a scratch app — the
// spike's own main process, never fat-g's — with electron-builder, the repository's Electron and
// the fuses of the repository's electron-builder.yml, runs it once and deletes the package.
// Reports go to spikes/output/m18/, which is ignored.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeCheck } from './lib/store-check.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'spikes', 'output', 'm18');
const SCRATCH = path.join(OUT, 'k1');
const APP = path.join(OUT, 'app');
const LAUNCH_MS = 90_000;

/** No inherited variable tells Electron or Node how to run. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(ELECTRON_|NODE_OPTIONS$)/i.test(name)) delete env[name];
  return { ...env, ...extra };
}

function run(label, command, args, env, timeout = 300_000) {
  console.log(`[k1] ${label}`);
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout });
  return { code: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ? String(result.error) : null };
}

const readReport = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
const tail = (text, lines = 12) => text.trim().split(/\r?\n/).slice(-lines).join('\n');

/** One leg's outcome, with what its process printed when it did not report. */
function leg(name, launched, reportFile) {
  const report = readReport(reportFile);
  const experimental = /ExperimentalWarning/.test(launched.stderr) || (report?.warnings ?? []).some((line) => /Experimental/.test(line));
  return { name, exit: launched.code, signal: launched.signal, launchError: launched.error, experimentalWarning: experimental, report, ...(report === null ? { stderrTail: tail(launched.stderr), stdoutTail: tail(launched.stdout) } : {}) };
}

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const legs = [];

// ── 1. Plain Node ────────────────────────────────────────────────────────────────────────────
console.log('[k1] plain Node');
legs.push({ name: 'node', exit: 0, report: await storeCheck(path.join(SCRATCH, 'node')) });

// ── 2. The test runner ───────────────────────────────────────────────────────────────────────
{
  const out = path.join(SCRATCH, 'vitest.json');
  const launched = run('the test runner (vitest)', process.execPath, [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', path.join('spikes', 'm18', 'vitest.config.ts')],
    cleanEnv({ FATG_SPIKE_OUT: out, FATG_SPIKE_DIR: path.join(SCRATCH, 'vitest') }));
  legs.push(leg('vitest', launched, out));
}

// ── 3. The development build: electron-vite's bundle, run by the repository's Electron ───────
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
const build = run('building the spike main with electron-vite', process.execPath, [path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--config', path.join('spikes', 'm18', 'app', 'electron.vite.config.mjs')], cleanEnv());
const bundle = path.join(APP, 'out', 'main', 'index.js');
const built = build.code === 0 && existsSync(bundle);
const bundleText = built ? readFileSync(bundle, 'utf8') : '';
const buildFacts = {
  built,
  // The driver stays an import of Node's own module: nothing of it is bundled in.
  keepsImport: /import\(\s*["']node:sqlite["']\s*\)|from\s*["']node:sqlite["']/.test(bundleText),
  bundleBytes: bundleText.length,
  ...(built ? {} : { stderrTail: tail(build.stderr), stdoutTail: tail(build.stdout) }),
};
writeFileSync(path.join(APP, 'package.json'), `${JSON.stringify({ name: 'fat-g-spike-m18', version: '0.0.0', description: 'fat-g M18 spike K1: not the app', author: 'fat-g contributors', private: true, type: 'module', main: './out/main/index.js' }, null, 2)}\n`);

const electronVersion = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
if (built) {
  const out = path.join(SCRATCH, 'electron-dev.json');
  const launched = run('the development build (Electron main process)', require('electron'), [APP], cleanEnv({ FATG_SPIKE_OUT: out, FATG_SPIKE_DIR: path.join(SCRATCH, 'electron-dev') }), LAUNCH_MS);
  legs.push(leg('electron-dev', launched, out));
}

// ── 4. A packaged build, with the repository's fuses ─────────────────────────────────────────
let packaged = { ran: false };
if (built && !process.argv.includes('--no-package')) {
  // The fuses are read from the repository's own packaging file, so the scratch package is hardened as fat-g's is.
  const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const block = /^electronFuses:\r?\n((?:[ \t]+\S.*\r?\n)+)/m.exec(yml)?.[1] ?? '';
  const electronFuses = Object.fromEntries([...block.matchAll(/^\s+(\w+):\s*(true|false)\s*$/gm)].map(([, name, value]) => [name, value === 'true']));
  const config = {
    appId: 'io.github.fbdesignpro.fatg.spike.m18',
    productName: 'fat-g-spike-m18',
    directories: { output: 'dist' },
    files: ['package.json', 'out/main/**'],
    asar: true,
    npmRebuild: false,
    publish: null,
    electronVersion,
    // The repository's own Electron: nothing is downloaded.
    electronDist: path.join(ROOT, 'node_modules', 'electron', 'dist'),
    electronFuses,
  };
  const configFile = path.join(APP, 'builder.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const builderEnv = cleanEnv({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  for (const name of Object.keys(builderEnv)) if (/^(CSC_(?!IDENTITY_AUTO_DISCOVERY$)|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|EP_)/.test(name)) delete builderEnv[name];
  const builder = run('packaging the scratch app (electron-builder --dir)', process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--dir', '--publish', 'never', '--projectDir', APP, '--config', configFile], builderEnv, 600_000);
  const dist = path.join(APP, 'dist');
  const unpacked = existsSync(dist) ? readdirSync(dist).map((name) => path.join(dist, name)).find((entry) => /unpacked$|^mac/.test(path.basename(entry))) : undefined;
  const executable = unpacked === undefined ? undefined
    : process.platform === 'win32' ? path.join(unpacked, 'fat-g-spike-m18.exe')
      : process.platform === 'darwin' ? path.join(unpacked, 'fat-g-spike-m18.app', 'Contents', 'MacOS', 'fat-g-spike-m18')
        : path.join(unpacked, 'fat-g-spike-m18');
  packaged = { ran: true, builderExit: builder.code, fusesAsked: electronFuses, executableFound: executable !== undefined && existsSync(executable) };
  if (packaged.executableFound) {
    // What the package holds, and its fuses as the binary has them.
    const asar = require('@electron/asar');
    const resources = process.platform === 'darwin' ? path.join(unpacked, 'fat-g-spike-m18.app', 'Contents', 'Resources') : path.join(unpacked, 'resources');
    packaged.archive = asar.listPackage(path.join(resources, 'app.asar')).map((entry) => entry.replaceAll('\\', '/')).sort();
    packaged.unpackedFolder = existsSync(path.join(resources, 'app.asar.unpacked'));
    const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');
    const { fuseMismatches } = await import('../../scripts/lib/package-audit.mjs');
    packaged.fuseProblems = fuseMismatches(await getCurrentFuseWire(executable), FuseV1Options);
    const out = path.join(SCRATCH, 'electron-packaged.json');
    const launched = run('the packaged build (its own executable)', executable, [], cleanEnv({ FATG_SPIKE_OUT: out, FATG_SPIKE_DIR: path.join(SCRATCH, 'electron-packaged') }), LAUNCH_MS);
    legs.push(leg('electron-packaged', launched, out));
  } else {
    packaged.stderrTail = tail(builder.stderr);
    packaged.stdoutTail = tail(builder.stdout);
  }
  // The package is some hundreds of megabytes and proves nothing more once it has run.
  rmSync(dist, { recursive: true, force: true });
}

const summary = {
  at: new Date().toISOString(),
  driver: 'node:sqlite',
  platform: `${process.platform}-${process.arch}`,
  versions: { node: process.versions.node, electron: electronVersion, vitest: JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8')).version },
  build: buildFacts,
  packaged,
  legs,
  nativeModule: 'not run: it would be installed from the network and built once for Node and once for Electron',
};
writeFileSync(path.join(OUT, 'k1.json'), `${JSON.stringify(summary, null, 2)}\n`);

for (const entry of legs) {
  const report = entry.report;
  console.log(`[k1] ${entry.name.padEnd(18)} ${report?.ok === true ? 'ok ' : 'NOT OK'} exit ${entry.exit}  node ${report?.node ?? '?'}  electron ${report?.electron ?? '-'}  sqlite ${report?.sqlite ?? '?'}  commit ${report?.steps?.commitReturns ?? '?'}  full ${report?.steps?.commitTiming?.full?.medianMs ?? '?'} ms  normal ${report?.steps?.commitTiming?.normal?.medianMs ?? '?'} ms  warning ${entry.experimentalWarning === true || (report?.warnings ?? []).length > 0 ? 'yes' : 'no'}`);
}
console.log(`[k1] bundle keeps the import: ${buildFacts.keepsImport}; packaged: ${JSON.stringify({ ran: packaged.ran, archive: packaged.archive, unpackedFolder: packaged.unpackedFolder, fuseProblems: packaged.fuseProblems })}`);
console.log(`[k1] report: ${path.relative(ROOT, path.join(OUT, 'k1.json'))}`);
const expected = packaged.ran ? 4 : 3;
process.exit(legs.length === expected && legs.every((entry) => entry.report?.ok === true) ? 0 : 10);
