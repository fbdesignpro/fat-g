// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T2, effort change (C19): the same session continues at a lower effort, to see whether and when
// the change applies. Claude: apply_flag_settings between the turns. Codex: `effort` on the second
// turn/start.
import { didNotHappen, happened, turnEnd } from './common.mjs';

export default {
  id: 't2',
  name: 't2-effort',
  title: 'Effort change between two turns',
  successCondition: "The second turn's end, and the frame that reports the effort in force",
  turns: 2,
  claudeTools: ['Read', 'Glob', 'Grep'],
  async run(ctx) {
    const lower = ctx.params.lowerEffort;
    if (!lower) throw new Error('T2 needs a lower effort level from discovery (--effort-b)');
    const first = ctx.driver.nextIndex;
    await ctx.prompt('Read notes-1.txt and reply with its first word only.');
    const end1 = await turnEnd(ctx, first);
    const change = await ctx.driver.setEffort(lower);
    const afterChange = await ctx.reportSettings();
    const second = ctx.driver.nextIndex;
    await ctx.prompt('Read notes-2.txt and reply with its first word only.');
    const end2 = await turnEnd(ctx, second);
    const afterTurn = await ctx.reportSettings();
    const reports = ctx.driver.events(end1.index).filter((e) => e.kind === 'effort');
    const matching = reports.filter((e) => e.value === lower);
    const notes = { lower, changeAccepted: change.ok, changeError: change.ok ? null : change.error, firstEnd: end1.status, secondEnd: end2.status, effortReports: reports.map((e) => ({ value: e.value, source: e.source, index: e.index })), settingsQueried: Boolean(afterChange || afterTurn) };
    if (matching.length === 0) return didNotHappen('the second turn ended, but no frame reported the new effort', notes);
    return happened(Math.max(end2.index, matching.at(-1).index), notes);
  },
};
