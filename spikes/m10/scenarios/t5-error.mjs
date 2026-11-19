// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// T5, error (C22): a session started with an unknown model id, to see the shape of an error. If the
// launch or the session start fails, that is the capture and no prompt is sent.
import { didNotHappen, happened } from './common.mjs';

export const UNKNOWN_MODEL = 'm10-no-such-model';

export default {
  id: 't5',
  name: 't5-error',
  title: 'Unknown model id',
  successCondition: 'The error frame',
  turns: 1,
  claudeTools: ['Read', 'Glob', 'Grep'],
  launchModel: UNKNOWN_MODEL,
  /** Called by trace.mjs when opening the session already failed: that failure is the capture. */
  fromStartFailure(failure) {
    return failure.index !== null && failure.index !== undefined
      ? happened(failure.index, { failedAt: failure.stage, promptSent: false })
      : didNotHappen(`the session failed at ${failure.stage} without an error frame`, { failedAt: failure.stage, promptSent: false });
  },
  async run(ctx) {
    const from = ctx.driver.nextIndex;
    const sent = await ctx.prompt('Say hello in one word.');
    if (sent?.ok === false) return happened(sent.index, { failedAt: 'turn start', promptSent: true });
    const hit = await ctx.wait((e) => e.kind === 'error' || e.kind === 'turn-end', from);
    const error = hit.kind === 'error' ? hit : hit.isError || hit.status === 'failed' ? hit : null;
    if (!error) return didNotHappen('the turn ended normally on an unknown model', { endStatus: hit.status });
    return happened(error.index, { failedAt: 'turn', promptSent: true, via: hit.kind, source: hit.source ?? null, endStatus: hit.status ?? null });
  },
};
