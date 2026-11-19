// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Read-only installed-protocol inspection. No model prompt and no account/config file read.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSpike } from '../m10/lib/spike.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { runOnce } from '../m10/lib/oneshot.mjs';
import { writeJson, SPIKES_DIR } from '../m10/lib/paths.mjs';
import { methodsOf } from '../m10/schema.mjs';

const out = path.join(SPIKES_DIR, 'output', 'chat');
const cwd = path.join(os.tmpdir(), 'fat-g-chat-protocol-probe');
mkdirSync(cwd, { recursive: true });
mkdirSync(out, { recursive: true });
await runSpike('chat-inspect', async ({ launcher, waits }) => {
  const report = { at: new Date().toISOString(), versions: {}, methods: [] };
  for (const cli of ['codex', 'claude']) {
    const exe = resolveExecutable(cli);
    for (const flag of ['--version', '--help']) {
      const answer = await runOnce(launcher, cli, exe, [flag], { cwd, waits });
      writeJson(path.join(out, `${cli}-${flag.slice(2)}.json`), answer);
      if (flag === '--version') report.versions[cli] = answer.stdout.trim();
    }
    if (cli !== 'codex') continue;
    for (const experimental of [false, true]) {
      const dir = path.join(out, experimental ? 'experimental' : 'plain');
      const answer = await runOnce(launcher, cli, exe, ['app-server', 'generate-json-schema', ...(experimental ? ['--experimental'] : []), '--out', dir], { cwd, waits: { ...waits, request: 60000 } });
      if (answer.code !== 0) throw new Error('schema generation failed');
      const walk = (folder) => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(folder, entry.name)) : entry.name.endsWith('.json') ? [{ file: path.relative(dir, path.join(folder, entry.name)), json: JSON.parse(readFileSync(path.join(folder, entry.name), 'utf8')) }] : []);
      report.methods.push({ experimental, methods: [...methodsOf(walk(dir)).keys()] });
    }
  }
  writeJson(path.join(out, 'inspection.json'), report);
  console.log(JSON.stringify({ versions: report.versions, methods: report.methods.map((m) => ({ experimental: m.experimental, count: m.methods.length })) }));
  return 0;
});
