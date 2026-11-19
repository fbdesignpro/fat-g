// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T6, question (C23): the model asks one multiple-choice question, answered with its first option.
// Codex runs in default mode only; plan mode is out of scope (S4).
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't6',
  name: 't6-question',
  title: 'A question answered with its first option',
  successCondition: "The question request, then the turn's end",
  turns: 1,
  claudeTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
  decide(request) {
    if (request.requestKind === 'question') return { decision: 'answer-first' };
    return null;
  },
  async run(ctx) {
    const from = ctx.driver.nextIndex;
    const tool = ctx.cli === 'claude' ? 'AskUserQuestion tool' : 'request_user_input tool';
    await ctx.prompt(`Before doing anything else, use your ${tool} to ask me one multiple-choice question: should you read notes-1.txt or notes-2.txt? Offer those two options. Then read the file I pick and tell me its first word.`);
    const end = await turnEnd(ctx, from);
    const question = ctx.driver.events(from).find((e) => e.kind === 'request' && e.requestKind === 'question' && e.index < end.index);
    const notes = { endStatus: end.status, requests: ctx.driver.events(from).filter((e) => e.kind === 'request').map((e) => ({ requestKind: e.requestKind, tool: e.tool })) };
    if (!question) return didNotHappen('the turn ended without a question request', notes);
    return happened(end.index, notes);
  },
};
