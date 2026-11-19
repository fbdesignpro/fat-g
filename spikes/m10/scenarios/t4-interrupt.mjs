// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T4, interrupt (C21): a turn asked to read several files is stopped when its first tool call
// arrives, to see the interrupted end state.
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't4',
  name: 't4-interrupt',
  title: 'Interrupt at the first tool call',
  successCondition: "The turn's end in its interrupted state",
  turns: 1,
  claudeTools: ['Read', 'Glob', 'Grep'],
  async run(ctx) {
    const from = ctx.driver.nextIndex;
    await ctx.prompt('Read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and then summarise all four in one sentence.');
    const first = await ctx.wait((e) => e.kind === 'tool-call' || e.kind === 'turn-end', from);
    if (first.kind === 'turn-end') return didNotHappen('the turn ended before any tool call', { endStatus: first.status });
    const reply = await ctx.driver.interrupt();
    const end = await turnEnd(ctx, first.index);
    return happened(end.index, { interruptAccepted: reply.ok, interruptError: reply.ok ? null : reply.error, firstTool: first.name, endStatus: end.status, terminalReason: end.terminalReason ?? null, isError: end.isError ?? null });
  },
};
