// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K3 (docs/planning/_archive/M19-spec-sheet.md; C25, C28, C29, C47, C51, C52, C61): `react-markdown` with
// `remark-gfm` beside `marked` with a renderer of the spike's own, in a page under fat-g's
// Content-Security-Policy, on the long-conversation fixture.
//
//   npm install --prefix spikes/m19/k3        once: the three packages, into the spike's own folder
//   node spikes/m19/k3.mjs --sizes            what each parser adds to a page's bundle; the fixture's hash
//   node spikes/m19/k3.mjs --leg dev          the page from a development server, under the development policy
//   node spikes/m19/k3.mjs --leg packaged     the page in a packaged scratch app, from app://, under the packaged policy
//   node spikes/m19/k3.mjs --leg preview      the production bundle, not packaged: a check of the spike itself
//   node spikes/m19/k3.mjs --summary          the reports there are, as tables
//
//   --quick              streams ten times as fast: a check of the spike, not a measurement
//   --libs rm,marked     which parsers; --modes whole,blocks  which ways of drawing
//
// It launches no CLI, reads no account and makes no network call of its own: the scratch app's
// session cancels every request that is not its own page's, as fat-g's does. A leg shows a window
// for some minutes, without taking the focus: a hidden window is not painted. The scratch app is
// never fat-g: its name, its id and Electron's data folder are its own. Reports go to
// spikes/output/m19/, which is ignored.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import * as fixture from './k3/fixture.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const K3 = path.join(HERE, 'k3');
const OUT = path.join(ROOT, 'spikes', 'output', 'm19');
const SCRATCH = path.join(OUT, 'k3');
const APP = path.join(SCRATCH, 'app');
const PACKAGES = ['react-markdown', 'remark-gfm', 'marked'];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const at = args.indexOf(`--${name}`); return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null; };

/** No inherited variable tells Electron or Node how to run. */
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(ELECTRON_|NODE_OPTIONS$|FATG_)/i.test(name)) delete env[name];
  return { ...env, ...extra };
}
const tail = (text, lines = 15) => String(text ?? '').trim().split(/\r?\n/).slice(-lines).join('\n');
const versionOf = (dir, name) => JSON.parse(readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version;

function requireInstalled() {
  const missing = PACKAGES.filter((name) => !existsSync(path.join(K3, 'node_modules', name, 'package.json')));
  if (missing.length === 0) return;
  console.error(`[k3] not installed: ${missing.join(', ')}. Run: npm install --prefix spikes/m19/k3`);
  process.exit(2);
}

function versions() {
  return {
    node: process.versions.node,
    electron: versionOf(ROOT, 'electron'), react: versionOf(ROOT, 'react'), vite: versionOf(ROOT, 'vite'),
    ...Object.fromEntries(PACKAGES.map((name) => [name, versionOf(K3, name)])),
    installed: readdirSync(path.join(K3, 'node_modules')).filter((name) => !name.startsWith('.')).flatMap((name) => (name.startsWith('@') ? readdirSync(path.join(K3, 'node_modules', name)).map((inner) => `${name}/${inner}`) : [name])).length,
  };
}

/** The fixture is the same every time (C52): its sizes, and a hash of all of it. */
function fixtureFacts() {
  const hash = createHash('sha256');
  let units = 0;
  let largest = 0;
  for (let n = 1; n <= fixture.TURNS; n += 1) {
    const { prompt, answer } = fixture.turn(n);
    hash.update(prompt).update('\u0000').update(answer).update('\u0000');
    units += prompt.length + answer.length;
    largest = Math.max(largest, answer.length);
  }
  const texts = { large: fixture.largeMessage(), nested: fixture.nestedMessage(), ...Object.fromEntries(fixture.STREAMS.map((kind) => [kind, fixture.streamText(kind)])) };
  for (const text of Object.values(texts)) hash.update(text).update('\u0000');
  return { turns: fixture.TURNS, units, largestAnswerUnits: largest, texts: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, { units: text.length, lines: text.split('\n').length }])), sha256: hash.digest('hex') };
}

// ── Sizes ──────────────────────────────────────────────────────────────────────────────────────
async function sizes() {
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const dir = path.join(K3, 'sizes');
  const entries = ['base', 'rm-component', 'rm-pipeline', 'rm-both', 'marked'];
  const measured = {};
  for (const name of entries) {
    const result = await build({ configFile: false, root: dir, logLevel: 'error', plugins: [react()], build: { write: false, rollupOptions: { input: path.join(dir, `${name}.jsx`) } } });
    const output = (Array.isArray(result) ? result[0] : result).output.filter((chunk) => chunk.type === 'chunk');
    const code = output.map((chunk) => chunk.code).join('\n');
    const packages = new Set();
    for (const chunk of output) {
      for (const id of Object.keys(chunk.modules)) {
        const normalized = id.replaceAll('\\', '/');
        const at = normalized.lastIndexOf('/node_modules/');
        if (at === -1) continue;
        const [first, second] = normalized.slice(at + '/node_modules/'.length).split('/');
        packages.add(first.startsWith('@') ? `${first}/${second}` : first);
      }
    }
    measured[name] = { bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, packages: [...packages].sort() };
  }
  const base = measured.base;
  const added = Object.fromEntries(entries.filter((name) => name !== 'base').map((name) => [name, {
    bytes: measured[name].bytes - base.bytes, gzipBytes: measured[name].gzipBytes - base.gzipBytes,
    packages: measured[name].packages.filter((entry) => !base.packages.includes(entry)),
  }]));
  const report = { at: new Date().toISOString(), versions: versions(), fixture: fixtureFacts(), base: { bytes: base.bytes, gzipBytes: base.gzipBytes, packages: base.packages }, added };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'k3-sizes.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[k3] versions: ${JSON.stringify(report.versions)}`);
  console.log(`[k3] fixture: ${report.fixture.turns} turns, ${report.fixture.units} units, sha256 ${report.fixture.sha256.slice(0, 16)}…; ${JSON.stringify(report.fixture.texts)}`);
  console.log(`[k3] base page (React alone): ${base.bytes} bytes, ${base.gzipBytes} gzipped`);
  for (const [name, entry] of Object.entries(added)) console.log(`[k3] ${name.padEnd(13)} adds ${String(entry.bytes).padStart(7)} bytes, ${String(entry.gzipBytes).padStart(6)} gzipped, ${entry.packages.length} package(s)`);
  return 0;
}

// ── The scratch app ────────────────────────────────────────────────────────────────────────────
function buildApp() {
  console.log('[k3] building the scratch app with electron-vite');
  const built = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--config', path.join('spikes', 'm19', 'k3', 'electron.vite.config.mjs')], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (built.status !== 0 || !existsSync(path.join(APP, 'out', 'main', 'index.js')) || !existsSync(path.join(APP, 'out', 'renderer', 'index.html'))) {
    console.error(`[k3] the build failed:\n${tail(built.stdout)}\n${tail(built.stderr)}`);
    process.exit(1);
  }
  writeFileSync(path.join(APP, 'package.json'), `${JSON.stringify({ name: 'fat-g-spike-m19-k3', version: '0.0.0', description: 'fat-g M19 spike K3: not the app', author: 'fat-g contributors', private: true, type: 'module', main: './out/main/index.js' }, null, 2)}\n`);
}

/** Runs the app to its exit, without blocking this process: the development server answers from it. */
function launch(label, command, commandArgs, env, timeoutMs) {
  console.log(`[k3] ${label}`);
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 200_000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    const timer = setTimeout(() => {
      console.error(`[k3] ${label}: no exit within ${timeoutMs} ms; ending it`);
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, error: String(error), stdout, stderr }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, error: null, stdout, stderr }); });
  });
}

function spikeEnv(leg, extra = {}) {
  const libs = value('libs') ?? 'rm,marked';
  const query = [flag('quick') ? 'quick=1' : null, value('modes') ? `modes=${value('modes')}` : null].filter(Boolean).join('&');
  return { libs, env: cleanEnv({ FATG_SPIKE_OUT: path.join(SCRATCH, `${leg}-app.json`), FATG_SPIKE_DIR: path.join(SCRATCH, `${leg}-data`), FATG_SPIKE_LIBS: libs, FATG_SPIKE_QUERY: query, ...extra }), timeoutMs: libs.split(',').length * 560_000 + 60_000 };
}

function finish(leg, launched, facts = {}) {
  const file = path.join(SCRATCH, `${leg}-app.json`);
  const app = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const report = { leg, quick: flag('quick'), versions: versions(), exit: launched.code, launchError: launched.error, ...facts, app, ...(app === null ? { stdoutTail: tail(launched.stdout), stderrTail: tail(launched.stderr) } : {}) };
  const outFile = path.join(OUT, `k3-${leg}${flag('quick') ? '-quick' : ''}${value('modes') ? `-${value('modes').replaceAll(',', '+')}` : ''}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[k3] report: ${path.relative(ROOT, outFile)}`);
  print(report);
  return app === null ? 10 : 0;
}

async function legPreview() {
  buildApp();
  const { env, timeoutMs } = spikeEnv('preview');
  rmSync(path.join(SCRATCH, 'preview-app.json'), { force: true });
  return finish('preview', await launch('the production bundle, not packaged (app://)', require('electron'), [APP], env, timeoutMs));
}

async function legDev() {
  buildApp();
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  // As `electron-vite dev` serves fat-g's page: unbundled modules, React's development build, the refresh preamble.
  const server = await createServer({
    configFile: false, root: path.join(K3, 'page'), logLevel: 'warn', plugins: [react()], cacheDir: path.join(SCRATCH, 'vite-cache'),
    server: { host: '127.0.0.1', port: 5193, strictPort: false, fs: { allow: [ROOT] } },
    // Named, so that none is found late and the page loaded again in the middle of a measurement.
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-markdown', 'remark-gfm', 'marked', 'hast-util-to-jsx-runtime', 'mdast-util-from-markdown', 'mdast-util-gfm', 'mdast-util-to-hast', 'micromark-extension-gfm'] },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.config.server.port}`;
  const { env, timeoutMs } = spikeEnv('dev', { ELECTRON_RENDERER_URL: origin });
  rmSync(path.join(SCRATCH, 'dev-app.json'), { force: true });
  let launched;
  try {
    launched = await launch(`the development page (${origin})`, require('electron'), [APP], env, timeoutMs);
  } finally {
    await server.close();
  }
  return finish('dev', launched);
}

async function legPackaged() {
  buildApp();
  // The fuses are read from the repository's own packaging file, so the scratch package is hardened as fat-g's is.
  const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const block = /^electronFuses:\r?\n((?:[ \t]+\S.*\r?\n)+)/m.exec(yml)?.[1] ?? '';
  const electronFuses = Object.fromEntries([...block.matchAll(/^\s+(\w+):\s*(true|false)\s*$/gm)].map(([, name, fuse]) => [name, fuse === 'true']));
  const config = {
    appId: 'io.github.fbdesignpro.fatg.spike.m19', productName: 'fat-g-spike-m19', directories: { output: 'dist' },
    files: ['package.json', 'out/**'], asar: true, npmRebuild: false, publish: null,
    electronVersion: versionOf(ROOT, 'electron'),
    // The repository's own Electron: nothing is downloaded.
    electronDist: path.join(ROOT, 'node_modules', 'electron', 'dist'),
    electronFuses,
  };
  const configFile = path.join(APP, 'builder.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const builderEnv = cleanEnv({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  for (const name of Object.keys(builderEnv)) if (/^(CSC_(?!IDENTITY_AUTO_DISCOVERY$)|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|EP_)/.test(name)) delete builderEnv[name];
  console.log('[k3] packaging the scratch app (electron-builder --dir)');
  const builder = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--dir', '--publish', 'never', '--projectDir', APP, '--config', configFile], { cwd: ROOT, env: builderEnv, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  const dist = path.join(APP, 'dist');
  const unpacked = existsSync(dist) ? readdirSync(dist).map((name) => path.join(dist, name)).find((entry) => /unpacked$|^mac/.test(path.basename(entry))) : undefined;
  const executable = unpacked === undefined ? undefined
    : process.platform === 'win32' ? path.join(unpacked, 'fat-g-spike-m19.exe')
      : process.platform === 'darwin' ? path.join(unpacked, 'fat-g-spike-m19.app', 'Contents', 'MacOS', 'fat-g-spike-m19')
        : path.join(unpacked, 'fat-g-spike-m19');
  if (executable === undefined || !existsSync(executable)) {
    console.error(`[k3] the package was not made:\n${tail(builder.stdout)}\n${tail(builder.stderr)}`);
    return 1;
  }
  const { env, timeoutMs } = spikeEnv('packaged');
  rmSync(path.join(SCRATCH, 'packaged-app.json'), { force: true });
  const launched = await launch('the packaged page (app://, its own executable)', executable, [], env, timeoutMs);
  // The package is some hundreds of megabytes and proves nothing more once it has run.
  rmSync(dist, { recursive: true, force: true });
  return finish('packaged', launched, { fusesAsked: electronFuses });
}

// ── Reading a report ───────────────────────────────────────────────────────────────────────────
function print(report) {
  const app = report.app;
  if (!app) { console.log(`[k3] ${report.leg}: no report from the app (exit ${report.exit})`); return; }
  console.log(`[k3] ${report.leg}${report.quick ? ' (quick: not a measurement)' : ''}: ${app.page}, packaged ${app.packaged}, Electron ${app.electron}, Chromium ${app.chrome}`);
  console.log(`[k3]   policy: ${app.csp}`);
  for (const [lib, page] of Object.entries(app.pages)) {
    const r = page.report;
    if (!r || r.failed || r.unfinished) { console.log(`[k3]   ${lib}: ${r?.failed ? `FAILED ${r.failed}` : `unfinished at ${r?.at}`} (${page.seconds} s); console: ${JSON.stringify(page.consoleLines)}`); continue; }
    console.log(`[k3]   ${lib}: ${page.seconds} s; development build ${r.development}; violations ${r.violations.length}; errors ${r.errors.length}; console lines ${page.consoleLines.length}${page.consoleLines.length ? ` ${JSON.stringify(page.consoleLines.slice(0, 3))}` : ''}; window ${r.window.items} items, ${r.window.units} units`);
    for (const [mode, m] of Object.entries(r.modes)) {
      const ms = (entry) => `script ${entry.script.median}/${entry.script.max}, frame ${entry.frame.median}/${entry.frame.max}, both ${entry.work.median}/${entry.work.max}`;
      console.log(`[k3]     ${lib}/${mode}`);
      console.log(`[k3]       static 100,000 units: parse ${m.static.large.parse.median} ms; display (median/max ms) ${ms(m.static.large.display)}`);
      console.log(`[k3]       static nested:        parse ${m.static.nested.parse.median} ms; display ${ms(m.static.nested.display)}`);
      console.log(`[k3]       newest page (${r.page.items} items): ${ms(m.display.newestPage)}`);
      console.log(`[k3]       full window (${r.window.items} items): ${ms(m.display.fullWindow)}`);
      for (const [kind, byInterval] of Object.entries(m.streams)) {
        for (const [interval, s] of Object.entries(byInterval)) {
          console.log(`[k3]       stream ${kind.padEnd(5)} @${String(interval).padStart(3)} ms: ${String(s.updates).padStart(4)} updates in ${s.seconds} s; script med ${s.script.median} p95 ${s.script.p95} max ${s.script.max}; frame med ${s.frame.median} p95 ${s.frame.p95} max ${s.frame.max}; over 50 ms: script ${s.scriptOver50}, both ${s.workOver50}; long tasks ${s.longTasks.count} (max ${s.longTasks.maxMs}); long frames ${s.longFrames.count} (max ${s.longFrames.maxMs}); elements ${s.drawnElements}`);
        }
      }
      console.log(`[k3]       scroll: ${m.scroll.frames} frames over ${m.scroll.heightPx} px; gap median ${m.scroll.gap?.median} p95 ${m.scroll.gap?.p95} max ${m.scroll.gap?.max}; over 33 ms ${m.scroll.over33}, over 50 ms ${m.scroll.over50}`);
      const p = m.probes;
      const facts = (name) => (p[name]?.threw ? `threw ${p[name].threw}` : `${p[name].elements.join(',')}; a ${p[name].anchors}, img ${p[name].images}, script ${p[name].scripts}, input ${p[name].inputs}, handlers ${p[name].handlers}, href/src ${p[name].withAddress}`);
      for (const name of Object.keys(p).filter((key) => key !== 'lateDefinition')) console.log(`[k3]       draws ${name}: ${facts(name)}`);
      console.log(`[k3]       late definition: changed ${p.lateDefinition?.changed}; paragraph nodes kept ${JSON.stringify(p.lateDefinition?.paragraphNodesKept)}`);
    }
  }
}

function summary() {
  if (!existsSync(OUT)) { console.log('[k3] no report yet'); return 0; }
  for (const name of readdirSync(OUT).filter((file) => /^k3-(dev|packaged|preview)(-quick)?(-[a-z+]+)?\.json$/.test(file)).sort()) print(JSON.parse(readFileSync(path.join(OUT, name), 'utf8')));
  return 0;
}

requireInstalled();
mkdirSync(SCRATCH, { recursive: true });
const leg = value('leg');
const code = flag('summary') ? summary()
  : flag('sizes') ? await sizes()
    : leg === 'preview' ? await legPreview()
      : leg === 'dev' ? await legDev()
        : leg === 'packaged' ? await legPackaged()
          : (console.error('usage: node spikes/m19/k3.mjs --sizes | --leg dev|packaged|preview [--quick] [--libs rm,marked] [--modes whole,blocks] | --summary'), 1);
process.exit(code);
