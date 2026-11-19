// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2 (docs/planning/_archive/M15.md; C7, C8, C81): Codex's session facet passes the tests every facet passes,
// here against its replay fake through the real adapter and process layer. The example provider's
// facet passes the same set in tests/sessions/facet-contract.test.ts. With its history (docs/planning/_archive/
// M18.md; C6, C25): Codex's descriptor says it reads a conversation back, and its facet has the member.
//
// And it answers a question asked beside a session (docs/planning/_archive/M20b.md, V14; C24, C26): as it is
// written, on a side thread that may read, as its descriptor declares — an ask that completes on
// K3's capture, one stopped and one refused, each through the fake's control file.
//
// And it asks the user a question as a request its turn waits on (docs/planning/_archive/M21.md, V12; C30):
// K2's `item/tool/requestUserInput`, answered, refused by main and left to a Stop. The fake chooses
// its capture by the prompt alone, so the app's ordinary turn raises it: no plan turn is sent (C24).
//
// And its sessions run under a mode and ask leave to act (docs/planning/_archive/M22.md, V11; C35, C39): the
// five its descriptor declares, a start confirmed and one refused, and K1's requests approved,
// denied, granted for the session, left to a Stop, refused by main and lost with the process. Every
// other test of the contract starts under Read only, which is what a session always was; the ones
// that ask start under Ask first, on the fake's account with no sandbox, as K1's was.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeFacetContract } from '../sessions/facet-contract';
import { codexHarness, PROMPTS, promptOf } from './harness';

/** K3's question to a side thread forked from an idle session: what the fake answers from its capture. */
function sideQuestion(): string {
  interface Frame { readonly dir: string; readonly frame: { id?: number; method?: string; params?: { threadId?: string; input?: { text: string }[] }; result?: { thread?: { id?: string } } } }
  const { frames } = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m20b-fork-followup.json'), 'utf8')) as { frames: Frame[] };
  const forks = frames.filter((entry) => entry.dir === 'send' && entry.frame.method === 'thread/fork').map((entry) => entry.frame.id);
  const children = new Set(frames.flatMap((entry) => (entry.dir === 'recv' && forks.includes(entry.frame.id) && typeof entry.frame.result?.thread?.id === 'string' ? [entry.frame.result.thread.id] : [])));
  const question = frames.find((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start' && children.has(entry.frame.params?.threadId ?? ''))?.frame.params?.input?.[0]?.text;
  if (typeof question !== 'string') throw new Error('m20b-fork-followup has no side thread turn');
  return question;
}

describeFacetContract('Codex, against the replay fake', async () => {
  const harness = await codexHarness();
  const capability = harness.provider.descriptor.capabilities.asides;
  if (capability === 'none') throw new Error('Codex’s descriptor declares its asides');
  const { permissions, plans } = harness.provider.descriptor.capabilities;
  if (permissions === null) throw new Error('Codex’s descriptor declares its modes');
  if (plans == null) throw new Error('Codex’s descriptor declares its plans');
  return {
    facet: harness.facet, history: true, folder: harness.project, model: 'gpt-6-astra', effort: 'low', prompt: PROMPTS.saved,
    asides: {
      capability, question: sideQuestion(),
      // A fork Codex refuses, once; a side thread whose turn is sent and never named.
      refuseNext: () => harness.control({ forkRefused: 1 }),
      holdNext: () => harness.control({ hang: 'childSend' }),
      release: () => harness.control({}),
    },
    // K2's prompt whose turn asks through a request, and goes on to its plan once it is answered.
    questions: { capability: 'both', prompt: PROMPTS.plan },
    permissions: {
      capability: permissions, mode: 'read-only', asking: 'ask-first',
      // K1's command (`m22-codex-once`, its first turn): one request, and the turn ends once it is decided.
      prompt: PROMPTS.command,
      // K1's file change, which offers the session's grant, and the change K1 made to the same file next,
      // which the grant covered (`m22-codex-file-session-same-main`, its two turns).
      session: { prompt: PROMPTS.file, again: PROMPTS.fileAgain },
      // Every change of a Codex thread's mode is its process closed: no `idle`.
      // The next start's reply reports another approval policy than the one it was asked for.
      mismatchNext: () => harness.control({ startOtherPolicy: 1 }),
    },
    // K2's plan turn under Sandbox ok (`m22b-codex-modes`, its first): a plan item, written and completed (M22b, C14).
    plans: { capability: plans, kind: 'item', prompt: promptOf('m22b-codex-modes'), mode: 'sandbox-ok', arm: () => harness.control({ sandboxState: 'ready' }) },
    dispose: () => harness.dispose(),
  };
}, { asides: true, questions: true, declines: true, permissions: true, plans: true });

describe('the Codex adapter', () => {
  it('has the facet its descriptor says it has, with its history, before and after its CLI is found (C6)', async () => {
    const harness = await codexHarness();
    try {
      expect(harness.provider.descriptor.capabilities.sessions).toBe(true);
      expect(harness.provider.sessions).toBeDefined();
      expect(harness.provider.descriptor.capabilities.history).toBe(true);
      expect(harness.provider.sessions?.history).toBeDefined();
    } finally { await harness.dispose(); }
  });
});
