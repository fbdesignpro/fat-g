// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T3, sub-agent (C20): the prompt asks outright for a small read to be handed to a sub-agent, to see
// how workers start, report and end. Never Codex's `ultra` effort (C20).
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't3',
  name: 't3-subagent',
  title: 'Sub-agent ("worker")',
  successCondition: "A worker's start and end, then the turn's end",
  turns: 1,
  claudeTools: ['Read', 'Glob', 'Grep', 'Agent'],
  async run(ctx) {
    const from = ctx.driver.nextIndex;
    const text = ctx.cli === 'claude'
      ? 'Use the Agent tool to hand this small task to a sub-agent: read notes-3.txt and report its contents. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.'
      : 'Spawn a sub-agent and give it this small task: read notes-3.txt and report its contents. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.';
    await ctx.prompt(text);
    const end = await turnEnd(ctx, from);
    const events = ctx.driver.events(from).filter((e) => e.index <= end.index);
    const start = events.find((e) => e.kind === 'worker-start');
    const stop = events.find((e) => e.kind === 'worker-end' && (!start || e.index > start.index));
    const notes = { endStatus: end.status, workerEvents: events.filter((e) => e.kind.startsWith('worker')).map((e) => ({ kind: e.kind, source: e.source ?? null, status: e.status ?? null })), toolCalls: events.filter((e) => e.kind === 'tool-call').map((e) => ({ name: e.name, worker: e.worker })) };
    if (!start || !stop) return didNotHappen(start ? 'a worker started but no end was seen before the turn ended' : 'no worker started', notes);
    return happened(end.index, notes);
  },
};
