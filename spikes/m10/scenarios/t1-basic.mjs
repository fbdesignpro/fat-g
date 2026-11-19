// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T1, basic turn (C18): read a sample file and answer in one sentence.
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't1',
  name: 't1-basic',
  title: 'Basic turn',
  successCondition: 'A read of sample.txt, then the end of the turn',
  turns: 1,
  claudeTools: ['Read', 'Glob', 'Grep'],
  async run(ctx) {
    const from = ctx.driver.nextIndex;
    await ctx.prompt('Read the file sample.txt in the current folder, then tell me in one sentence what the cat is called.');
    const end = await turnEnd(ctx, from);
    const reads = ctx.driver.events(from).filter((e) => e.kind === 'tool-call' && e.index < end.index);
    if (reads.length === 0) return didNotHappen('the turn ended without a tool call', { endStatus: end.status });
    return happened(end.index, { endStatus: end.status, toolCalls: reads.map((e) => e.name) });
  },
};
