// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1 (docs/planning/_archive/M19b-spec-sheet.md; C1, C29, C38): what a file costs to show in the pane — a
// Markdown file of 100,000 to 1,000,000 units drawn by fat-g's own component, and a plain text of 1
// and 2 MiB with long lines — in a page under fat-g's Content-Security-Policy, on M19's K3 harness.
//
//   node spikes/m19b/k1.mjs --sizes           the texts: their sizes, lines and a hash of all of them
//   node spikes/m19b/k1.mjs --leg dev         the page from a development server, under the development policy
//   node spikes/m19b/k1.mjs --leg packaged    the page in a packaged scratch app, from app://, under the packaged policy
//   node spikes/m19b/k1.mjs --leg preview     the production bundle, not packaged: a check of the spike itself
//   node spikes/m19b/k1.mjs --summary         the reports there are, as tables
//
//   --quick               one mount and a short scroll a case: a check of the spike, not a measurement
//   --cases md-100000,plain-1mib    which cases (the sheet's, when left out); --name <word> names the report
//   --cases line-50000,line-100000,line-250000,line-500000,line-1048576,line-2097152 --name one-line
//                                   beyond the sheet: a text that is one line, unwrapped and wrapped
//   --page-ms 120000                how long one case may take before it is given up
//
// It launches no CLI, reads no account, spends nothing and makes no network call of its own: the
// scratch app's session cancels every request that is not its own page's, as fat-g's does. A leg
// shows a window for a few minutes, without taking the focus: a hidden window is not painted. The
// scratch app is never fat-g: its name, its id and Electron's data folder are its own. It installs
// nothing: React and `marked` are the repository's. Reports go to spikes/output/m19b/, which is ignored.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CASES, CASES } from './k1/fixture.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const K1 = path.join(HERE, 'k1');
const OUT = path.join(ROOT, 'spikes', 'output', 'm19b');
const SCRATCH = path.join(OUT, 'k1');
const APP = path.join(SCRATCH, 'app');
const ALIAS = { '@shared': path.join(ROOT, 'src', 'shared') };

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
const versionOf = (name) => JSON.parse(readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
const versions = () => ({ node: process.versions.node, electron: versionOf('electron'), react: versionOf('react'), vite: versionOf('vite'), marked: versionOf('marked') });

/** The texts are the same every time: their sizes, and a hash of all of them. */
function sizes() {
  const hash = createHash('sha256');
  const texts = {};
  for (const [name, entry] of Object.entries(ALL_CASES)) {
    const text = entry.text();
    hash.update(name).update('\u0000').update(text).update('\u0000');
    const lines = text.split('\n');
    texts[name] = { kind: entry.kind, units: text.length, bytes: Buffer.byteLength(text), lines: lines.length, longestLine: lines.reduce((most, line) => Math.max(most, line.length), 0) };
  }
  const report = { at: new Date().toISOString(), versions: versions(), sha256: hash.digest('hex'), texts };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'k1-sizes.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[k1] versions: ${JSON.stringify(report.versions)}`);
  console.log(`[k1] texts, sha256 ${report.sha256.slice(0, 16)}…`);
  for (const [name, text] of Object.entries(texts)) console.log(`[k1]   ${name.padEnd(20)} ${text.kind.padEnd(8)} ${String(text.units).padStart(9)} units, ${String(text.lines).padStart(6)} lines, longest ${text.longestLine}`);
  return 0;
}

// ── The scratch app ────────────────────────────────────────────────────────────────────────────
function buildApp() {
  console.log('[k1] building the scratch app with electron-vite');
  const built = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--config', path.join('spikes', 'm19b', 'k1', 'electron.vite.config.mjs')], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (built.status !== 0 || !existsSync(path.join(APP, 'out', 'main', 'index.js')) || !existsSync(path.join(APP, 'out', 'renderer', 'index.html'))) {
    console.error(`[k1] the build failed:\n${tail(built.stdout)}\n${tail(built.stderr)}`);
    process.exit(1);
  }
  writeFileSync(path.join(APP, 'package.json'), `${JSON.stringify({ name: 'fat-g-spike-m19b-k1', version: '0.0.0', description: 'fat-g M19b spike K1: not the app', author: 'fat-g contributors', private: true, type: 'module', main: './out/main/index.js' }, null, 2)}\n`);
}

/** Runs the app to its exit, without blocking this process: the development server answers from it. */
function launch(label, command, commandArgs, env, timeoutMs) {
  console.log(`[k1] ${label}`);
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 200_000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 200_000) stderr += chunk; });
    const timer = setTimeout(() => {
      console.error(`[k1] ${label}: no exit within ${timeoutMs} ms; ending it`);
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, error: String(error), stdout, stderr }); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, error: null, stdout, stderr }); });
  });
}

function chosenCases() {
  const names = (value('cases') ?? Object.keys(CASES).join(',')).split(',');
  const unknown = names.filter((name) => !(name in ALL_CASES));
  if (unknown.length) { console.error(`[k1] unknown case(s): ${unknown.join(', ')}. Known: ${Object.keys(ALL_CASES).join(', ')}`); process.exit(1); }
  return names;
}

function spikeEnv(leg, extra = {}) {
  const cases = chosenCases();
  const pageMs = Number(value('page-ms') ?? 300_000);
  return { env: cleanEnv({ FATG_SPIKE_OUT: path.join(SCRATCH, `${leg}-app.json`), FATG_SPIKE_DIR: path.join(SCRATCH, `${leg}-data`), FATG_SPIKE_CASES: cases.join(','), FATG_SPIKE_QUERY: flag('quick') ? 'quick=1' : '', FATG_SPIKE_PAGE_MS: String(pageMs), ...extra }), timeoutMs: cases.length * (pageMs + 10_000) + 60_000 };
}

function finish(leg, launched, facts = {}) {
  const file = path.join(SCRATCH, `${leg}-app.json`);
  const app = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const report = { leg, quick: flag('quick'), versions: versions(), exit: launched.code, launchError: launched.error, ...facts, app, ...(app === null ? { stdoutTail: tail(launched.stdout), stderrTail: tail(launched.stderr) } : {}) };
  const outFile = path.join(OUT, `k1-${leg}${flag('quick') ? '-quick' : ''}${value('name') ? `-${value('name').replace(/[^a-z0-9-]/gi, '')}` : value('cases') ? '-part' : ''}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[k1] report: ${path.relative(ROOT, outFile)}`);
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
    configFile: false, root: path.join(K1, 'page'), publicDir: path.join(ROOT, 'src', 'renderer', 'public'), logLevel: 'warn', plugins: [react()], cacheDir: path.join(SCRATCH, 'vite-cache'),
    resolve: { alias: ALIAS },
    server: { host: '127.0.0.1', port: 5194, strictPort: false, fs: { allow: [ROOT] } },
    // Named, so that none is found late and the page loaded again in the middle of a measurement.
    optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'marked'] },
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
    appId: 'io.github.fbdesignpro.fatg.spike.m19b', productName: 'fat-g-spike-m19b', directories: { output: 'dist' },
    files: ['package.json', 'out/**'], asar: true, npmRebuild: false, publish: null,
    electronVersion: versionOf('electron'),
    // The repository's own Electron: nothing is downloaded.
    electronDist: path.join(ROOT, 'node_modules', 'electron', 'dist'),
    electronFuses,
  };
  const configFile = path.join(APP, 'builder.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const builderEnv = cleanEnv({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  for (const name of Object.keys(builderEnv)) if (/^(CSC_(?!IDENTITY_AUTO_DISCOVERY$)|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|EP_)/.test(name)) delete builderEnv[name];
  console.log('[k1] packaging the scratch app (electron-builder --dir)');
  const builder = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), '--dir', '--publish', 'never', '--projectDir', APP, '--config', configFile], { cwd: ROOT, env: builderEnv, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  const dist = path.join(APP, 'dist');
  const unpacked = existsSync(dist) ? readdirSync(dist).map((name) => path.join(dist, name)).find((entry) => /unpacked$|^mac/.test(path.basename(entry))) : undefined;
  const executable = unpacked === undefined ? undefined
    : process.platform === 'win32' ? path.join(unpacked, 'fat-g-spike-m19b.exe')
      : process.platform === 'darwin' ? path.join(unpacked, 'fat-g-spike-m19b.app', 'Contents', 'MacOS', 'fat-g-spike-m19b')
        : path.join(unpacked, 'fat-g-spike-m19b');
  if (executable === undefined || !existsSync(executable)) {
    console.error(`[k1] the package was not made:\n${tail(builder.stdout)}\n${tail(builder.stderr)}`);
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
  if (!app) { console.log(`[k1] ${report.leg}: no report from the app (exit ${report.exit})`); return; }
  console.log(`[k1] ${report.leg}${report.quick ? ' (quick: not a measurement)' : ''}: ${app.page}, packaged ${app.packaged}, Electron ${app.electron}, Chromium ${app.chrome}`);
  console.log(`[k1]   policy: ${app.csp}`);
  for (const [name, page] of Object.entries(app.pages)) {
    let r = page.report;
    if (!r || r.failed || r.unfinished) {
      console.log(`[k1]   ${name}: ${r?.failed ? `FAILED ${r.failed}` : `unfinished${r?.hung ? ', the page in one task' : ''}`} at ${r?.at} (${page.seconds} s); console: ${JSON.stringify(page.consoleLines)}`);
      if (!r?.partial?.ways) continue;
      r = { ...r.partial, violations: [], errors: [] };
      console.log('[k1]   what it had measured before that:');
    }
    console.log(`[k1]   ${name}: ${r.text.units} units, ${r.text.lines} lines, longest ${r.text.longestLine}; pane ${r.pane.widthPx}×${r.pane.heightPx} px, ${r.pane.font}; ${page.seconds} s; development build ${r.development}; violations ${r.violations.length}; errors ${r.errors.length}; console lines ${page.consoleLines.length}${page.consoleLines.length ? ` ${JSON.stringify(page.consoleLines.slice(0, 3))}` : ''}`);
    for (const [way, w] of Object.entries(r.ways)) {
      const scroll = (s) => `${s.frames} frames over ${s.px} px; gap median ${s.gap?.median} p95 ${s.gap?.p95} max ${s.gap?.max}; over 33 ms ${s.over33}, over 50 ms ${s.over50}, over 100 ms ${s.over100}; long tasks ${s.longTasks.count} (max ${s.longTasks.maxMs})`;
      console.log(`[k1]     ${way}${w.parse ? `: parse ${w.parse.median} ms (max ${w.parse.max}), ${w.parse.blocks} blocks` : ''}`);
      if (w.show) console.log(`[k1]       shown in (ms, each run): ${w.show.each.map((s) => `${s.shownMs} [script ${s.scriptMs}, frame ${s.frameMs}]`).join('; ')}`);
      if (w.show) console.log(`[k1]       while showing: long tasks ${w.show.longTasks.count} (max ${w.show.longTasks.maxMs} ms), long frames ${w.show.longFrames.count} (max ${w.show.longFrames.maxMs} ms)`);
      if (w.drawn) console.log(`[k1]       drawn: ${w.drawn.elements} elements, ${w.drawn.heightPx} px high, ${w.drawn.widthPx} px wide; heap ${w.drawn.heapMb} MB`);
      if (w.scrollDown) console.log(`[k1]       scroll down: ${scroll(w.scrollDown)}`);
      if (w.scrollSideways) console.log(`[k1]       scroll sideways: ${scroll(w.scrollSideways)}`);
      if (w.jump) console.log(`[k1]       coming to a line: ${w.jump.shownMs} ms [script ${w.jump.scriptMs}, frame ${w.jump.frameMs}]`);
    }
  }
}

function summary() {
  if (!existsSync(OUT)) { console.log('[k1] no report yet'); return 0; }
  for (const name of readdirSync(OUT).filter((file) => /^k1-(dev|packaged|preview)(-[a-z0-9-]+)?\.json$/.test(file)).sort()) print(JSON.parse(readFileSync(path.join(OUT, name), 'utf8')));
  return 0;
}

mkdirSync(SCRATCH, { recursive: true });
const leg = value('leg');
const code = flag('summary') ? summary()
  : flag('sizes') ? sizes()
    : leg === 'preview' ? await legPreview()
      : leg === 'dev' ? await legDev()
        : leg === 'packaged' ? await legPackaged()
          : (console.error('usage: node spikes/m19b/k1.mjs --sizes | --leg dev|packaged|preview [--quick] [--cases <names>] | --summary'), 1);
process.exit(code);
