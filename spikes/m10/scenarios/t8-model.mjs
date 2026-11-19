// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T8, model switch (C52): the same session continues on a different model, to see whether and when
// the change applies. Claude: set_model between the turns. Codex: `model` on the second turn/start.
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't8',
  name: 't8-model',
  title: 'Model switch between two turns',
  successCondition: "The second turn's end, naming the new model",
  turns: 2,
  claudeTools: ['Read', 'Glob', 'Grep'],
  async run(ctx) {
    const next = ctx.params.modelB;
    if (!next) throw new Error('T8 needs a second model from discovery (--model-b)');
    const first = ctx.driver.nextIndex;
    await ctx.prompt('Read notes-1.txt and reply with its first word only.');
    const end1 = await turnEnd(ctx, first);
    const change = await ctx.driver.setModel(next);
    const second = ctx.driver.nextIndex;
    await ctx.prompt('Read notes-2.txt and reply with its first word only.');
    const end2 = await turnEnd(ctx, second);
    await ctx.reportSettings();
    const reports = ctx.driver.events(end1.index).filter((e) => e.kind === 'model');
    const matching = reports.filter((e) => typeof e.value === 'string' && (e.value === next || e.value.includes(next) || next.includes(e.value)));
    const notes = { next, changeAccepted: change.ok, changeError: change.ok ? null : change.error, firstEnd: end1.status, secondEnd: end2.status, modelReports: reports.map((e) => ({ value: e.value, source: e.source, index: e.index })) };
    if (matching.length === 0) return didNotHappen('the second turn ended, but no frame named the new model', notes);
    return happened(Math.max(end2.index, matching.at(-1).index), notes);
  },
};
