// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, expect, it } from 'vitest';
import { createLifecycleTrace } from '../../src/main/process/lifecycle-trace';
import { codexHarness, watch, PROMPTS, type Harness } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });

it('traces a fake turn and its process cleanup without conversation content or references', async () => {
  const lines: string[] = [];
  const trace = createLifecycleTrace(true, process.pid, line => lines.push(line));
  const h = harness = await codexHarness({ trace });
  const session = watch(h.facet.start({ folder: h.project, model: 'gpt-6-astra', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }));
  session.send(PROMPTS.t1);
  await session.ended('turn-1');
  await session.session.close();
  const text = lines.join('\n');
  for (const phase of ['spawn', 'request', 'reply', 'turn-started', 'turn-completed', 'stop', 'exit', 'close', 'cleanup']) expect(text).toContain(`"phase":"${phase}"`);
  expect(text).toContain('"operation":"send"');
  expect(text).toContain('"ok":true');
  for (const secret of [PROMPTS.t1, h.project, h.dir, 'Biscuit', ...Object.keys(h.threads())]) expect(text).not.toContain(secret);
});
