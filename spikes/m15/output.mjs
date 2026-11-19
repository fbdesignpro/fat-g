// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M15 spike (C97, C19; Design 1): a turn whose command prints more than 1 MiB, to learn whether
// `aggregatedOutput` is capped and how large the frames get. One turn.
//
//   node spikes/m15/output.mjs [--confirm-turns 1] [--again]
//
// The frames' sizes are measured as they arrive; a string over 32 KiB is cut before anything keeps
// it, the raw capture included, with its length noted.
import { isMain } from '../m10/lib/paths.mjs';
import { runSpike } from '../m10/lib/spike.mjs';
import { didNotHappen, happened, notRun, outline, runScenario } from './lib/common.mjs';

const MIB = 1024 * 1024;
const LINE = 'The quick brown fox jumps over the lazy dog while the tide table is pinned by the door. ';
/** About 1.5 MiB of numbered lines, so the output is past the app's 1 MiB line limit. */
const BIG = Array.from({ length: 15_000 }, (_, i) => `${String(i + 1).padStart(5, '0')} ${LINE}`).join('\n') + '\nlast line: the lamp is lit\n';

const OUTPUT = {
  id: 'm15-output', name: 'm15-large-output', turns: 1,
  title: 'A command that prints more than 1 MiB',
  successCondition: "A command that printed the whole of big.txt, then the turn's end",
  files: { 'big.txt': BIG },
  async run(ctx) {
    const driver = await ctx.open();
    const started = await ctx.startThread(driver);
    if (!started.ok) return didNotHappen('thread/start was refused');
    if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (C21)', { rows: driver.sessionStart.check.rows });
    const from = driver.nextIndex;
    await ctx.prompt(driver, 'Run exactly this one command and nothing else: Get-Content big.txt — it prints the whole file to the terminal. Do not pipe, filter or shorten its output. Then tell me in one sentence what the last line says.');
    const end = await ctx.turnEnd(driver, from);
    const frames = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
    const commands = frames.filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'commandExecution').map((f) => f.frame.params.item);
    const cut = driver.longStrings.filter((s) => s.key === 'aggregatedOutput');
    const largest = driver.largest(5);
    const notes = {
      endStatus: end.status, fileBytes: Buffer.byteLength(BIG), commands: commands.map((c) => ({ status: c.status ?? null, exitCode: c.exitCode ?? null, keys: Object.keys(c).sort() })),
      aggregatedOutput: cut.map((s) => ({ chars: s.chars, bytes: s.bytes, on: s.method })),
      largestFrames: largest, overOneMiB: driver.frameBytes.filter((f) => f.bytes > MIB).map((f) => ({ method: f.method, item: f.item, bytes: f.bytes })),
      outputCapped: cut.length > 0 ? Math.max(...cut.map((s) => s.bytes)) < Buffer.byteLength(BIG) * 0.9 : null,
      otherLongStrings: driver.longStrings.filter((s) => s.key !== 'aggregatedOutput').map((s) => ({ key: s.key, on: s.method, item: s.item, bytes: s.bytes })),
      outline: outline(driver, from),
    };
    if (commands.length === 0) return didNotHappen('the turn ended without a command', notes);
    if (cut.length === 0 && !largest.some((f) => f.bytes > 64 * 1024)) return didNotHappen('no command printed the file whole', notes);
    return happened(notes, end.index);
  },
};

if (isMain(import.meta.url)) await runSpike('m15-output', (frame) => runScenario('m15-output', OUTPUT, frame));
