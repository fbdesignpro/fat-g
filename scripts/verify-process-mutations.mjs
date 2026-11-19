// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Focused M5 fault injection. Runs sequentially; each mutation's file is put back to its exact original
// bytes and read back, and the run cannot end with one left changed without saying so and failing
// (scripts/lib/mutation-files.mjs). Run with Node from the repo root. Windows needs permission to
// terminate fixture trees.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createMutationFiles, guardTree, leftMutated, turn } from './lib/mutation-files.mjs';
const mutations = [
  ['invalid override fallback', 'resolve-executable.ts', 'if (request.override !== null)', 'if (false)', 'src/main/process/resolve-executable.test.ts', 'never falls back'],
  ['pending timeout leak', 'rpc-client.ts', 'if (!pending.delete(id)) return;', 'if (!pending.has(id)) return;', 'src/main/process/rpc-client.test.ts', 'timeout removes'],
  ['reject sent work at exit', 'rpc-client.ts', 'if (!entry.sent) entry.finish', 'if (true) entry.finish', 'src/main/process/rpc-client.test.ts', 'drains final response'],
  ['missing drain deadline', 'rpc-client.ts', 'setTimeout(() => finish(), options.drainMs', 'setTimeout(() => {}, options.drainMs', 'src/main/process/rpc-client.test.ts', 'fixed drain deadline'],
  ['missing stderr drain', 'spawn.ts', "child.stderr.on('data'", "child.stderr.on('unused-data'", 'tests/process/integration.test.ts', 'one-shot preserves'],
  ['missing line cap', '../../shared/provider-kit/ndjson.ts', 'if (this.length + bytes.length > this.limit)', 'if (false)', 'src/shared/provider-kit/ndjson.test.ts', 'exact byte cap'],
  ['restart timer survives disposal', 'supervisor.ts', "change('disposed'); clearTimer(timer);", "change('disposed');", 'src/main/process/supervisor.test.ts', 'cancels scheduled retry'],
  ['parent-only termination', 'tree-kill.ts', "['/PID', String(pid), '/T', '/F']", "['/PID', String(pid), '/F']", 'src/main/process/tree-kill.test.ts', 'includes descendants'],
  ['macOS zombie-only group treated as a failed cleanup', 'tree-kill.ts', "code === 'EPERM' ? 'unconfirmed' : 'failed'", "code === 'EPERM' ? 'failed' : 'failed'", 'src/main/process/tree-kill.test.ts', 'zombie-only group'],
  // M15: the dropped line, the CLI's requests, and an opened connection's own latch.
  ['oversized line kept after the drop', '../../shared/provider-kit/ndjson.ts', 'this.parts = []; this.length = 0; this.skipping = true; this.first = false;', 'this.parts = []; this.length = 0; this.first = false;', 'src/shared/provider-kit/ndjson.test.ts', 'drops a line over the cap'],
  ['request handlers ignored', 'rpc-client.ts', "const handler = handlers.get(value['method']);", 'const handler = [].find((entry) => entry);', 'src/main/process/rpc-client.test.ts', 'answers a request from the CLI'],
  ['an opened connection latches its scope', 'index.ts', 'else held.add(tree); },', 'else unconfirmed.add(tree); },', 'tests/process/managed-cleanup.test.ts', 'holds itself alone'],
  ['a scope forgets an opened connection at disposal', 'index.ts', 'return { ok: unconfirmed.size === 0 && held.size === 0 };\n      },\n    };', 'return { ok: unconfirmed.size === 0 };\n      },\n    };', 'tests/process/managed-cleanup.test.ts', 'answers not clean at disposal'],
  // M16: a process opened once is on the same ownership (C71), with the child handed over raw.
  ['an opened process latches its scope', 'index.ts', 'else held.add(tree); },', 'else unconfirmed.add(tree); },', 'tests/process/managed-cleanup.test.ts', 'an opened process whose end cannot be confirmed'],
  ['a scope forgets an opened process at disposal', 'index.ts', 'return { ok: unconfirmed.size === 0 && held.size === 0 };\n      },\n    };', 'return { ok: unconfirmed.size === 0 };\n      },\n    };', 'tests/process/managed-cleanup.test.ts', 'while an opened process'],
  ['quit does not wait', '../app/shutdown.ts', 'const cleanup = start();', 'deps.resumeQuit(); const cleanup = start();', 'src/main/app/shutdown.test.ts', 'waits for cleanup'],
];
const files = createMutationFiles();
guardTree(files);
let survived = 0;
for (const [name, file, before, after, test, title] of mutations) {
  if (name === 'parent-only termination' && process.platform !== 'win32') continue;
  const target = path.resolve('src/main/process', file);
  const source = files.read(target)?.toString('utf8') ?? '';
  if (!source.includes(before)) throw new Error(`missing mutation anchor: ${name}`);
  let failed;
  try {
    files.write(target, source.replace(before, after));
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', test, '-t', title], { encoding: 'utf8', windowsHide: true, timeout: 25000, env: process.env });
    const detected = result.status !== 0 && (result.stdout + result.stderr).includes('FAIL');
    console.log(`${detected ? 'DETECTED' : 'SURVIVED/INVALID'}: ${name}`);
    if (!detected) { survived++; console.log(result.stdout, result.stderr); }
  } finally { failed = files.restore(); }
  // A file that could not be put back stops the run: nothing more is mutated on a tree that is not as it was.
  if (failed.length > 0) throw leftMutated(failed);
  await turn();
}
process.exitCode = survived ? 1 : 0;
