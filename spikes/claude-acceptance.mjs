// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M7b installed acceptance: the PRODUCTION Claude adapter — fat-g's control client, the real process
// layer, production options and timings — against the user's installed, logged-in CLI. Read-only:
// no prompt, no login, nothing that affects quota. Re-run after a CLI update breaks Claude usage.
//
// It runs in a normal-launch environment: every inherited CLAUDE*/ANTHROPIC*/DEBUG* variable (a parent
// Claude session's, when run from one) is removed before fat-g's process layer snapshots the
// environment, as for a Start-menu launch. Output is versions, kinds, counts, booleans and timings —
// never identity, plan, usage values, paths or response bodies.
//
//   node spikes/claude-acceptance.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, stop } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const removed = Object.keys(process.env).filter((name) => /^(CLAUDE|ANTHROPIC|DEBUG)/i.test(name));
for (const name of removed) delete process.env[name];

// Bundled into the repo's node_modules/.cache so its npm imports (zod, cross-spawn) resolve exactly
// as the app's do.
const outfile = path.join(ROOT, 'node_modules', '.cache', 'fatg-claude-acceptance.mjs');
await build({
  stdin: {
    contents: [
      "export { createProcessServices } from './src/main/process';",
      "export { createClaudeDefinition } from './src/main/providers/claude';",
      "export { CLAUDE_INSTALL_HINTS } from './src/main/providers/claude/descriptor';",
      "export { expandInstallDirectories } from './src/main/services/provider-installation';",
    ].join('\n'),
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', packages: 'external',
  alias: { '@shared': path.join(ROOT, 'src', 'shared') },
});
// esbuild's API keeps a helper process alive; stop it so every child listed below is fat-g's.
await stop();
const { createProcessServices, createClaudeDefinition, CLAUDE_INSTALL_HINTS, expandInstallDirectories } = await import(pathToFileURL(outfile).href);

/** Windows: image names of this process's live direct children, excluding the query itself. */
function liveChildren() {
  if (process.platform !== 'win32') return null;
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.Name }) -join ','`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim().split(',').filter(Boolean) : null;
}

const describeUsage = (usage) => {
  if (usage.kind !== 'usage') return { kind: usage.kind, reason: usage.reason ?? null };
  const windows = usage.usage.windows;
  return {
    kind: 'usage', windows: windows.map((window) => window.kind),
    uniqueIds: new Set(windows.map((window) => window.id)).size === windows.length,
    binding: windows.filter((window) => window.isBinding).length,
  };
};

const userData = mkdtempSync(path.join(os.tmpdir(), 'fatg-acceptance-'));
const services = createProcessServices(userData);
const definition = createClaudeDefinition();
const knownDirs = expandInstallDirectories(CLAUDE_INSTALL_HINTS, { platform: process.platform, home: os.homedir(), appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA });
const generations = [];
try {
  for (const generation of ['initial', 'disable/re-enable', 'redetect']) {
    const context = services.createContext(definition.environment);
    const provider = definition.factory(context);
    const signal = () => new AbortController().signal;
    const detection = await provider.detect({ override: null, knownDirs }, signal());
    const reads = [];
    for (const read of ['scheduled', 'manual refresh']) {
      const started = Date.now();
      const account = await provider.getAccount(signal());
      const usage = account.kind === 'account' ? await provider.getUsage(signal()) : { kind: 'skipped' };
      reads.push({
        read, ms: Date.now() - started, childrenAfter: liveChildren(),
        account: account.kind === 'account' ? { kind: 'account', authKind: account.account.authKind, hasPlan: Boolean(account.account.plan), hasEmail: Boolean(account.account.email) } : { kind: account.kind },
        usage: describeUsage(usage),
      });
    }
    await provider.dispose();
    const cleanup = await context.processes.dispose();
    generations.push({ generation, detection: detection.kind === 'found' ? { kind: 'found', source: detection.installation.source, version: detection.installation.version } : { kind: detection.kind }, reads, disposed: cleanup.ok, childrenAfterDispose: liveChildren() });
  }
} finally {
  await services.killAll();
  rmSync(userData, { recursive: true, force: true });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, removedVariables: removed.length, generations, childrenAtEnd: liveChildren() }, null, 2));
