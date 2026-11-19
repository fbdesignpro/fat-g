// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T7, declined approval (C23): the model is asked to create a file and the request is declined.
// Nothing is made writable; only the asking rules change (Claude: the write tool with no allow
// rule; Codex: an approval policy that asks, the user as reviewer, sandbox still read-only).
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't7',
  name: 't7-declined',
  title: 'A declined approval',
  successCondition: "The approval request, then the turn's end",
  turns: 1,
  claudeTools: ['Read', 'Glob', 'Grep', 'Write'],
  decide(request) {
    if (request.requestKind === 'approval' || request.requestKind === 'permissions') return { decision: 'decline' };
    return null;
  },
  async run(ctx) {
    const from = ctx.driver.nextIndex;
    await ctx.prompt('Create a new file named created-by-trace.txt in the current folder containing the single word hello. If you are not allowed to, say so in one sentence.');
    const end = await turnEnd(ctx, from);
    const events = ctx.driver.events(from);
    const request = events.find((e) => e.kind === 'request' && (e.requestKind === 'approval' || e.requestKind === 'permissions') && e.index < end.index);
    const notes = { endStatus: end.status, requests: events.filter((e) => e.kind === 'request').map((e) => ({ requestKind: e.requestKind, tool: e.tool })), autoReviewFrames: events.filter((e) => e.kind === 'auto-review').length };
    if (!request) return didNotHappen('the turn ended without an approval request', notes);
    return happened(end.index, { ...notes, declinedRequest: request.tool });
  },
};
