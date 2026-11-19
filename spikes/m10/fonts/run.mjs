// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B8: the font comparison page (Design 9). Builds the sheets, starts the repository's Electron with
// ELECTRON_RUN_AS_NODE removed and its user data in a scratch folder, and writes screenshots and a
// coverage table under spikes/output/fonts/. Spends no turn and launches no CLI.
//
//   node spikes/m10/fonts/run.mjs
//
// Font files are fetched by the maintainer, or by an agent with the maintainer's go-ahead per file
// (C42), into spikes/output/fonts/files/<candidate id>/, after the candidate's licence was read
// from its official source (C41). A candidate without files shows as "not fetched yet".
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { settlesWithin } from '../lib/deadlines.mjs';
import { cleanEnvironment } from '../lib/env.mjs';
import { FONTS_OUTPUT_DIR, M10_DIR, REPO_ROOT, isMain, writeJson } from '../lib/paths.mjs';
import { log, runSpike, warn } from '../lib/spike.mjs';
import { PAGE_DIR, buildPages } from './build-page.mjs';

const RENDER_WAIT_MS = 180_000;

function electronExecutable() {
  const dir = path.join(REPO_ROOT, 'node_modules', 'electron');
  const relative = readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
  return { path: path.join(dir, 'dist', relative), kind: 'native' };
}

/** Per candidate and script: which system fonts drew any glyph, from coverage.json. */
export function summarize(rows) {
  const out = {};
  for (const row of rows) {
    if (!row.candidate) continue;
    const key = row.script ?? `sheet ${row.sheet}`;
    const entry = (out[row.candidate] ??= {});
    const system = (row.fonts ?? []).filter((f) => !f.custom).map((f) => f.family);
    const previous = entry[key] ?? [];
    entry[key] = [...new Set([...previous, ...system])];
  }
  return out;
}

async function fonts({ launcher, waits }) {
  const { candidates, files } = buildPages();
  const shotsDir = path.join(FONTS_OUTPUT_DIR, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  const sheetsFile = writeJson(path.join(PAGE_DIR, 'sheets.json'), files);
  const userData = path.join(tmpdir(), 'fat-g-spike-fonts');
  if (existsSync(userData)) rmSync(userData, { recursive: true, force: true });
  mkdirSync(userData, { recursive: true });
  const { env } = cleanEnvironment('electron');
  const executable = electronExecutable();
  const tree = await launcher.launch({ executable, args: [path.join(M10_DIR, 'fonts', 'main.cjs'), '--sheets', sheetsFile, '--out', shotsDir, '--user-data', userData], cwd: userData, env });
  tree.stdin?.end();
  const finished = await settlesWithin(tree.closed, RENDER_WAIT_MS);
  const code = tree.exitInfo?.code ?? null;
  const cleanup = await tree.teardown();
  if (!finished || code !== 0) { warn(`Electron ${finished ? `exited with ${code}` : 'did not finish in time'}: ${tree.stderrTail.slice(-600)}`); return 1; }
  const rows = JSON.parse(readFileSync(path.join(shotsDir, 'coverage.json'), 'utf8'));
  const summary = summarize(rows);
  writeJson(path.join(FONTS_OUTPUT_DIR, 'coverage-summary.json'), { date: new Date().toISOString(), candidates: candidates.map(({ id, name, version, licence, verdict, excluded, present, weights }) => ({ id, name, version, licence, verdict, excluded: Boolean(excluded), present, weights })), systemFontsPerScript: summary });
  for (const c of candidates) log(`${c.name}: ${c.excluded ? `left off (${c.verdict})` : c.present ? `weights ${c.weights.join(', ')}` : 'no file yet'}`);
  for (const [candidate, scripts] of Object.entries(summary)) {
    const fallbacks = Object.entries(scripts).filter(([, fams]) => fams.length).map(([script, fams]) => `${script} → ${fams.join(', ')}`);
    log(`${candidate}: ${fallbacks.length ? `system fonts drew: ${fallbacks.join('; ')}` : 'no system font drew any glyph'}`);
  }
  log(`screenshots: ${path.relative(REPO_ROOT, shotsDir)}; cleanup ${cleanup.confirmed ? 'confirmed' : 'NOT confirmed'}`);
  return 0;
}

if (isMain(import.meta.url)) await runSpike('fonts', fonts, { budgetMs: 300_000 });
