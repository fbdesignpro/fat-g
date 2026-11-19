// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One real Electron UI/IPC workflow on fixtures; the full smoke runner is unchanged.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCENARIOS = ['new-chat', 'session-search', 'avatar-family', 'data-reset'];

export function scenarioEnvironment(scenario, directory, inherited = process.env) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Choose a smoke scenario: ${SCENARIOS.join(', ')}`);
  const fixture = (name) => fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url));
  const env = { ...inherited };
  // No inherited full-smoke/replay controls or Electron-as-Node switch may alter this run.
  for (const key of Object.keys(env)) if (key.startsWith('FATG_SMOKE') || key === 'FATG_DEMO_SESSIONS' || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  return { ...env, ...(inherited.FATG_SMOKE_VISUAL_DIR === undefined ? {} : { FATG_SMOKE_VISUAL_DIR: inherited.FATG_SMOKE_VISUAL_DIR }), FATG_SMOKE: '1', FATG_SMOKE_SCENARIO: scenario, FATG_SMOKE_NODE: process.execPath,
    FATG_SMOKE_FIXTURE: fixture('fake-app-server.mjs'), FATG_SMOKE_CODEX_FIXTURE: fixture('fake-codex-cli.mjs'),
    FATG_SMOKE_PIDS: path.join(directory, 'pids'), FATG_SMOKE_CODEX_ACCOUNT_STATE: path.join(directory, 'account'), FATG_SMOKE_CODEX_CONTROL: path.join(directory, 'control.json'),
    FATG_SMOKE_CLAUDE_FIXTURE: fixture('fake-claude-cli.mjs'), FATG_SMOKE_CLAUDE_DIR: path.join(directory, 'claude'),
    FATG_SMOKE_PICK_FOLDER: path.join(os.tmpdir(), `fatg-smoke-${scenario}-project`), FATG_DEMO_SESSIONS: scenario === 'data-reset' ? 'off' : 'seed' };
}

export async function main(scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Choose a smoke scenario: ${SCENARIOS.join(', ')}`);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fatg-smoke-scenario-'));
  for (const name of ['project', 'claude']) mkdirSync(path.join(directory, name));
  writeFileSync(path.join(directory, 'account'), 'subscription');
  writeFileSync(path.join(directory, 'control.json'), '{}');
  writeFileSync(path.join(directory, 'claude/control.json'), '{}');
  const env = scenarioEnvironment(scenario, directory);
  mkdirSync(env.FATG_SMOKE_PICK_FOLDER, { recursive: true });
  const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url));
  let output = '';
  let allOutput = '';
  console.log(`[smoke-scenario] ${scenario}; fixture files: ${directory}`);
  for (const stage of scenario === 'data-reset' ? ['first', 'next'] : ['only']) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'preview'], { env: { ...env, FATG_SMOKE_RESET_STAGE: stage }, cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const record = (chunk) => { output += chunk.toString('utf8'); allOutput += chunk.toString('utf8'); process.stdout.write(chunk); };
      child.stdout.on('data', record); child.stderr.on('data', record);
      child.on('error', reject); child.on('close', (code) => resolve(code ?? 1));
    });
    if (result !== 0 || !output.includes(`"scenario":"${scenario}","ok":true`)) throw new Error(`${scenario} did not pass (${stage})`);
    output = '';
  }

  const constants = JSON.parse(readFileSync(fileURLToPath(new URL('../tests/fixtures/claude/fake-cli-constants.json', import.meta.url)), 'utf8'));
  if (allOutput.includes(constants.sentinel)) throw new Error('fixture private text reached output');
}

/** The scenarios a run names: one, or `all` of them in turn, as the pre-push full suite runs them. */
export function chosenScenarios(args) {
  if (args.length === 1 && args[0] === 'all') return SCENARIOS;
  if (args.length === 1 && SCENARIOS.includes(args[0])) return args;
  throw new Error(`Choose exactly one smoke scenario, or all: ${SCENARIOS.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = (async () => { for (const scenario of chosenScenarios(process.argv.slice(2))) await main(scenario); })();
  run.catch((error) => { console.error(`[smoke-scenario] ${error.message}`); process.exitCode = 1; });
}
