// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { facts, projectFrames } from './k1.mjs';

test('public projections discard text, paths, identity, unknown tools and input keys', () => {
  const secret = 'PRIVATE_MARKER_7319';
  const frames = [{ dir: 'recv', index: 1, ms: 1, frame: {
    type: 'assistant', email: secret, session_id: secret, parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: secret }, { type: 'tool_use', id: secret, name: secret, input: { [secret]: secret, file_path: secret, command: secret } }] },
  } }];
  const projected = projectFrames('claude', frames);
  assert.equal(JSON.stringify(projected).includes(secret), false);
  assert.equal(projected[0].blocks[1].name, 'other');
  const codex = projectFrames('codex', [{ dir: 'recv', index: 1, ms: 1, frame: { method: 'item/started', params: { threadId: secret, turnId: secret, item: { id: secret, type: 'collabAgentToolCall', tool: secret, prompt: secret, arguments: { private: secret }, receiverThreadIds: [secret] } } } }]);
  assert.equal(JSON.stringify(codex).includes(secret), false);
});

test('same-millisecond items pair by id and next text is scoped to its thread', () => {
  const rows = [
    { index: 1, ms: 10, type: 'item/started', thread: 'parent', item: { id: 'one', type: 'commandExecution' } },
    { index: 2, ms: 10, type: 'item/started', thread: 'parent', item: { id: 'two', type: 'commandExecution' } },
    { index: 3, ms: 20, type: 'item/completed', thread: 'parent', item: { id: 'two', type: 'commandExecution' } },
    { index: 4, ms: 20, type: 'item/completed', thread: 'parent', item: { id: 'one', type: 'commandExecution' } },
    { index: 5, ms: 21, type: 'item/agentMessage/delta', thread: 'child' },
    { index: 6, ms: 30, type: 'item/agentMessage/delta', thread: 'parent' },
  ];
  const result = facts('codex', rows);
  assert.deepEqual(result.tools.map((tool) => [tool.id, tool.nextTextGapMs]), [['two', 10], ['one', 10]]);
});

test('an instantaneous sub-agent announcement is not an executing tool', () => {
  const rows = ['item/started', 'item/completed'].map((type, index) => ({ type, index, ms: 1, thread: 'parent', item: { type: 'subAgentActivity', id: 'notice', kind: 'started', agentThread: 'child' } }));
  assert.equal(facts('codex', rows).tools.length, 0);
  assert.equal(facts('codex', rows).coordination.length, 2);
});

test('four captured runs completed, have unique ordered frames, and confirmed cleanup', () => {
  for (const cli of ['claude', 'codex']) for (const scenario of ['tools', 'workers']) {
    const capture = JSON.parse(readFileSync(new URL(`../../tests/fixtures/m105/${cli}-${scenario}.json`, import.meta.url), 'utf8'));
    assert.equal(capture.outcome, 'happened');
    assert.equal(capture.cleanupConfirmed, true);
    assert.equal(capture.promptsSpent, 1);
    assert.equal(capture.scratchUnchanged, true);
    assert.ok(capture.frames.every((row, index) => index === 0 || row.index > capture.frames[index - 1].index));
    if (scenario === 'tools') assert.ok(capture.facts.tools.length >= 3);
    else if (cli === 'claude') assert.equal(capture.facts.tasksStarted.length, 2);
    else assert.equal(capture.facts.coordination.filter((row) => row.type === 'item/started' && row.item.kind === 'started').length, 2);
  }
});
