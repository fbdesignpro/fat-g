// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22, beside K1 (docs/planning/_archive/M22-spec-sheet.md; C4): whether Codex's Windows sandbox is set up in
// the maintainer's OWN Codex configuration — the one question K1 could not answer from its scratch
// configuration folder, and asked here only at the maintainer's word.
//
//   node spikes/m22/readiness.mjs
//
// One app-server, production's first two frames and one request, `windowsSandbox/readiness`: no
// thread is started, no prompt is sent, and nothing is written. It prints the status alone —
// `ready`, `notConfigured` or `updateRequired` — and keeps nothing else of the reply.
import { CodexDriver } from '../m10/codex/driver.mjs';
import { EXIT } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { buildScratch } from '../m10/lib/scratch.mjs';
import { log, runSpike } from '../m10/lib/spike.mjs';

if (isMain(import.meta.url)) {
  await runSpike('m22-readiness', async ({ args, launcher, signal, waits }) => {
    const executable = resolveExecutable('codex', args.path);
    const { env } = cleanEnvironment('codex');
    // The maintainer's own configuration: no variable of the spike's names another folder.
    const inherited = Object.keys(env).some((name) => name.toUpperCase() === 'CODEX_HOME');
    const driver = new CodexDriver({ launcher, executable, cwd: buildScratch('probe').dir, env, waits, signal });
    let status = null;
    let error = null;
    try {
      await driver.open();
      const reply = await driver.request('windowsSandbox/readiness');
      if (reply.ok) status = reply.value?.status ?? null; else error = reply.error?.code ?? null;
    } finally {
      const cleanup = await driver.close();
      log(`cleanup: ${cleanup.confirmed ? 'confirmed' : 'NOT confirmed'}`);
    }
    log(`configuration: ${inherited ? 'the folder an inherited CODEX_HOME names' : "the maintainer's own, at its default place"}`);
    log(`windowsSandbox/readiness: ${status ?? `refused (code ${error})`}`);
    return status ? EXIT.happened : EXIT.didNotHappen;
  });
}
