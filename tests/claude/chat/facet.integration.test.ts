// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V14, V36 (docs/planning/_archive/M16.md; C42, C49, C84): Claude's session facet passes the tests every facet
// passes, here against its replay fake through the real adapter and process layer. The example
// provider's facet passes the same set in tests/sessions/facet-contract.test.ts, and Codex's in
// tests/codex/. Claude labels no phase: it names its answer on the turn's completed end, which the
// contract takes either way. And it has no history: its descriptor says so, and its facet has no member.
//
// And it answers a question asked beside a session (docs/planning/_archive/M20b.md, V14; C24, C26): whole,
// from the conversation alone, as its descriptor declares — an ask that completes on K1's capture,
// one stopped and one refused, each through the fake's control file.
//
// And it asks the user a question as a request its turn waits on (docs/planning/_archive/M21.md, V12; C30):
// K1's question through the question tool, answered, refused by main and left to a Stop.
//
// And its sessions run under a mode and ask leave to act (docs/planning/_archive/M22.md, V11, V15; C35, C39):
// K2's command, approved, denied, granted for the session, stopped, refused by main and lost — and
// the change from Ask first to Edits ok on the live process, which the fake answers as K2 saw it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFacetContract } from '../../sessions/facet-contract';
import { claudeHarness, promptOf } from './harness';

/** K1's side question, asked of an idle session: what the fake answers from its capture. */
function sideQuestion(folder: string): string {
  const capture = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures/m20b-idle.json'), 'utf8')) as { frames: { dir: string; frame: { request?: { subtype?: string; question?: string } } }[] };
  const question = capture.frames.find((entry) => entry.dir === 'send' && entry.frame.request?.subtype === 'side_question')?.frame.request?.question;
  if (typeof question !== 'string') throw new Error('m20b-idle has no side question');
  return question.replaceAll('<scratch>', folder);
}

describeFacetContract('Claude, against the replay fake', async () => {
  const harness = await claudeHarness();
  const capability = harness.provider.descriptor.capabilities.asides;
  if (capability === 'none') throw new Error('Claude’s descriptor declares its asides');
  const permissions = harness.provider.descriptor.capabilities.permissions;
  if (permissions === null) throw new Error('Claude’s descriptor declares its modes');
  const plans = harness.provider.descriptor.capabilities.plans;
  if (plans == null) throw new Error('Claude’s descriptor declares its plans');
  return {
    facet: harness.facet, history: false, folder: harness.project, model: 'sonnet', effort: 'low', prompt: harness.prompts.t1,
    asides: {
      capability, question: sideQuestion(harness.project),
      // The CLI's own refusal of the request, once; a side question that gets its progress frame and no reply.
      refuseNext: () => harness.control({ sideRefused: 1 }),
      holdNext: () => harness.control({ hang: 'side' }),
      release: () => harness.control({}),
    },
    // K1's prompt whose turn asks through `AskUserQuestion`, and goes on once it is answered.
    questions: { capability: 'blocking', prompt: harness.prompts.question },
    permissions: {
      capability: permissions,
      // The reading mode is the launch M16–M21's turns were captured under; Ask first is the one K2's requests were.
      mode: 'read-only', asking: 'ask-first',
      // K2's command, asked leave for; and the one whose rule the CLI offered, with the prompt that asks for it again.
      prompt: harness.prompts.approve,
      session: { prompt: harness.prompts.grant, again: harness.prompts.grantAgain },
      // One of the three changes the CLI makes on a live process (C5).
      idle: { from: 'ask-first', to: 'edits-ok' },
      // The launch's reply names another permission mode than the launch asked for.
      mismatchNext: () => harness.control({ otherMode: 'reply' }),
    },
    // K1's plan turn under Ask first (`m22b-plan-ask-first`): its request, which Execute takes on (M22b, C10, C11).
    plans: { capability: plans, kind: 'request', prompt: promptOf('m22b-plan-ask-first', harness.project), mode: 'ask-first' },
    dispose: () => harness.dispose(),
  };
}, { asides: true, questions: true, declines: true, permissions: true, plans: true });

describe('the Claude adapter', () => {
  it('has the facet its descriptor says it has, with no history, before and after its CLI is found (C42, C49)', async () => {
    const harness = await claudeHarness();
    try {
      expect(harness.provider.descriptor.capabilities).toMatchObject({ sessions: true, history: false, otherFolders: true });
      expect(harness.provider.sessions).toBeDefined();
      expect(harness.provider.sessions !== undefined && 'history' in harness.provider.sessions).toBe(false);
    } finally { await harness.dispose(); }
  });
});
